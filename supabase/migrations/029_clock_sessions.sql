-- =============================================================
-- Migration 029 — Multiple shifts in a single day
--
-- Run AFTER 028. ADDITIVE ONLY, so it is safe to run BEFORE the new code is
-- deployed (the rule migration 027 nearly broke — see Update 65). Nothing here
-- drops or narrows anything the currently deployed build depends on.
--
-- THE PROBLEM
-- clock_events holds exactly one row per (employee, day), enforced by
-- clock_events_unique. An employee who works a morning shift, clocks out, and
-- comes back in the evening had nowhere to put the second shift: clock-in
-- refused with "You've already clocked in today."
--
-- THE SHAPE OF THE FIX
-- clock_events STAYS one row per day and keeps its meaning as the day's header.
-- Each in/out pair becomes a clock_sessions row underneath it:
--
--   clock_events.clock_in_at   = the FIRST session's clock-in
--   clock_events.clock_out_at  = the LAST session's clock-out, and NULL again
--                                whenever a session is open
--   clock_events.worked_hours  = the SUM of completed sessions
--
-- Keeping clock_out_at null while a session is open is what lets every
-- "is this person on shift" check in the app — the Live board, computeStatus,
-- the crew screen, the auto clock-out sweep's `.is("clock_out_at", null)` —
-- keep working untouched.
--
-- worked_hours is the column that matters for money. Every hours calculation
-- previously derived `clock_out_at - clock_in_at`, which on a split day spans
-- the GAP BETWEEN SHIFTS: a 09:00–13:00 + 17:00–21:00 day would read 12h
-- instead of 8h. Readers now use `coalesce(worked_hours, clock_out_at - clock_in_at)`.
-- The fallback is permanent, not transitional: it covers rows written by the
-- old build during the deploy window, and any row fixed by hand in SQL.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- TABLE: clock_sessions — one row per clock-in/clock-out pair
-- =============================================================
create table if not exists public.clock_sessions (
  id                  uuid primary key default gen_random_uuid(),
  clock_event_id      uuid not null references public.clock_events(id) on delete cascade,
  -- Denormalised from the parent so RLS and the "is anyone still clocked in"
  -- lookup don't need a join on every clock action.
  employee_id         uuid not null references public.employees(id) on delete cascade,
  store_id            uuid references public.stores(id) on delete set null,
  -- The date the session STARTED. A session that runs past midnight stays on
  -- the day it began, so it settles with the rest of that day's work.
  event_date          date not null,
  -- 1, 2, 3… order within the day. Display order and a stable handle for edits.
  seq                 integer not null,
  clock_in_at         timestamptz not null,
  clock_out_at        timestamptz,
  clock_in_lat        numeric(10,7),
  clock_in_lng        numeric(10,7),
  clock_out_lat       numeric(10,7),
  clock_out_lng       numeric(10,7),
  -- Same flags as clock_events, per session: a manager may hand-enter the
  -- second shift of a day whose first shift was properly geofenced, and the two
  -- must stay individually distinguishable.
  manual_entry        boolean not null default false,
  manual_entry_by     uuid references auth.users(id) on delete set null,
  manual_entry_at     timestamptz,
  manual_entry_reason text,
  auto_clocked_out    boolean not null default false,
  auto_clock_out_source text,
  auto_clock_out_at   timestamptz,
  created_at          timestamptz not null default now()
);

comment on table public.clock_sessions is
  'One clock-in/clock-out pair. A day can hold several; clock_events is the per-day header that sums them.';
comment on column public.clock_sessions.event_date is
  'The date the session STARTED — a session crossing midnight stays on its opening day.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clock_sessions_auto_source_check'
  ) then
    alter table public.clock_sessions
      add constraint clock_sessions_auto_source_check
      check (
        auto_clock_out_source is null
        or auto_clock_out_source in ('rota','schedule','store_close','fallback')
      );
  end if;
  -- A closed session must end after it started. Guards against a manual entry
  -- or a badly resolved auto clock-out writing negative hours into payroll.
  if not exists (
    select 1 from pg_constraint where conname = 'clock_sessions_order_check'
  ) then
    alter table public.clock_sessions
      add constraint clock_sessions_order_check
      check (clock_out_at is null or clock_out_at > clock_in_at);
  end if;
end $$;

create unique index if not exists clock_sessions_event_seq
  on public.clock_sessions (clock_event_id, seq);

-- THE invariant that replaces "one row per day": a person can have at most one
-- session open at a time, across every date. This is stronger than what existed
-- before — nothing at the database level previously stopped a double clock-in,
-- only an application check did.
create unique index if not exists clock_sessions_one_open
  on public.clock_sessions (employee_id)
  where clock_out_at is null;

create index if not exists clock_sessions_employee_date_idx
  on public.clock_sessions (employee_id, event_date);
create index if not exists clock_sessions_date_idx
  on public.clock_sessions (event_date);

-- =============================================================
-- clock_events — the day header gains its summed hours
-- =============================================================
alter table public.clock_events
  -- Sum of the day's COMPLETED sessions. Null means no sessions exist for the
  -- row (legacy data, or a row written by the pre-029 build) — readers fall
  -- back to clock_out_at - clock_in_at, which is correct for a single shift.
  add column if not exists worked_hours  numeric(6,2),
  add column if not exists session_count integer not null default 0;

comment on column public.clock_events.worked_hours is
  'Sum of the day''s completed clock_sessions. NOT clock_out_at - clock_in_at, which would include the gap between shifts. Null = no sessions; fall back to the raw delta.';

-- =============================================================
-- Backfill — one session per existing completed day
--
-- Only rows with BOTH timestamps are backfilled. An open legacy row (clocked
-- in, never clocked out) is deliberately skipped: there are historically many
-- of them, several per employee, and they would collide on the
-- clock_sessions_one_open index. They keep working through the raw-delta
-- fallback, the auto clock-out sweep closes them as it always has, and the
-- clock-out path adopts one into a session if the employee returns to it.
-- =============================================================
insert into public.clock_sessions (
  clock_event_id, employee_id, store_id, event_date, seq,
  clock_in_at, clock_out_at,
  clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng,
  manual_entry, manual_entry_by, manual_entry_at, manual_entry_reason,
  auto_clocked_out, auto_clock_out_source, auto_clock_out_at
)
select
  ce.id, ce.employee_id, ce.store_id, ce.event_date, 1,
  ce.clock_in_at, ce.clock_out_at,
  ce.clock_in_lat, ce.clock_in_lng, ce.clock_out_lat, ce.clock_out_lng,
  coalesce(ce.manual_entry, false), ce.manual_entry_by, ce.manual_entry_at, ce.manual_entry_reason,
  coalesce(ce.auto_clocked_out, false), ce.auto_clock_out_source, ce.auto_clock_out_at
from public.clock_events ce
where ce.clock_in_at is not null
  and ce.clock_out_at is not null
  and ce.clock_out_at > ce.clock_in_at
  and not exists (
    select 1 from public.clock_sessions cs where cs.clock_event_id = ce.id
  );

update public.clock_events ce
set
  worked_hours  = agg.hours,
  session_count = agg.n
from (
  select
    cs.clock_event_id,
    round(sum(extract(epoch from (cs.clock_out_at - cs.clock_in_at)) / 3600.0)::numeric, 2) as hours,
    count(*) as n
  from public.clock_sessions cs
  where cs.clock_out_at is not null
  group by cs.clock_event_id
) agg
where agg.clock_event_id = ce.id
  and ce.worked_hours is distinct from agg.hours;

-- =============================================================
-- RLS — mirrors clock_events exactly: staff see everything, an employee sees
-- and writes only their own rows.
-- =============================================================
alter table public.clock_sessions enable row level security;

drop policy if exists "clock_sessions_select" on public.clock_sessions;
drop policy if exists "clock_sessions_insert" on public.clock_sessions;
drop policy if exists "clock_sessions_update" on public.clock_sessions;
drop policy if exists "clock_sessions_delete" on public.clock_sessions;

create policy "clock_sessions_select" on public.clock_sessions
  for select to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_sessions_insert" on public.clock_sessions
  for insert to authenticated
  with check (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_sessions_update" on public.clock_sessions
  for update to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id())
  with check (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_sessions_delete" on public.clock_sessions
  for delete to authenticated
  using (public.is_staff());

grant all on public.clock_sessions to anon, authenticated, service_role;

-- =============================================================
-- employee_weekly_summary — actual_hours must stop spanning the gap
--
-- CREATE OR REPLACE, not drop/create: labor_cost_performance is built on this
-- view and a drop would cascade into it. The column list and types are
-- unchanged, so a replace is accepted.
-- =============================================================
create or replace view public.employee_weekly_summary with (security_invoker = true) as
with weekly_rota as (
  select
    rs.employee_id,
    date_trunc('week', rs.shift_date)::date as week_start_date,
    sum(case when rs.is_day_off then 0 else rs.scheduled_hours end) as scheduled_hours
  from public.rota_shifts rs
  group by rs.employee_id, date_trunc('week', rs.shift_date)
),
weekly_actual as (
  select
    ce.employee_id,
    date_trunc('week', ce.event_date)::date as week_start_date,
    sum(
      -- Summed sessions when we have them; the raw delta otherwise. On a
      -- single-shift day the two are identical, so history is unaffected.
      coalesce(
        ce.worked_hours,
        case
          when ce.clock_in_at is not null and ce.clock_out_at is not null
          then (extract(epoch from (ce.clock_out_at - ce.clock_in_at)) / 3600.0)::numeric
          else 0
        end
      )
    ) as actual_hours,
    sum(coalesce(ce.short_deliveries_count, 0) + coalesce(ce.long_deliveries_count, 0)) as deliveries_total
  from public.clock_events ce
  group by ce.employee_id, date_trunc('week', ce.event_date)
)
select
  e.id as employee_id,
  e.name as employee_name,
  e.position,
  e.store_id,
  coalesce(wr.week_start_date, wa.week_start_date) as week_start_date,
  coalesce(wr.scheduled_hours, 0) as scheduled_hours,
  coalesce(wa.actual_hours, 0) as actual_hours,
  coalesce(wa.deliveries_total, 0) as deliveries_total,
  e.hourly_ni_rate,
  e.hourly_cash_rate,
  -- Wage split: first 20h = NI (bank), remainder = cash if cash rate set
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0) as scheduled_ni_wages,
  greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0) as scheduled_cash_wages,
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0)
    + greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0)
    as scheduled_total_wages
from public.employees e
left join weekly_rota wr on wr.employee_id = e.id
left join weekly_actual wa on wa.employee_id = e.id
  and wa.week_start_date = wr.week_start_date;
