-- =============================================================
-- Migration 031 — Multiple shifts in a single day (MANAGERS)
--
-- Run AFTER 030. ADDITIVE ONLY, so it is safe to run BEFORE the new code is
-- deployed (the rule migration 027 nearly broke — see Update 65). Nothing here
-- drops or narrows anything the currently deployed build depends on.
--
-- THE PROBLEM
-- Migration 029 gave employees several shifts a day. Managers were left out:
-- manager_clock_events is one row per (manager, day) with a single in/out pair,
-- and performManagerClockIn refused with "You've already clocked in today" once
-- the day had a clock-in on it. A manager who opened the store, went home, and
-- came back for the evening had nowhere to record the second shift.
--
-- THE SHAPE OF THE FIX — identical to 029, so the two halves cannot drift:
-- manager_clock_events STAYS one row per day and keeps its meaning as the day's
-- header. Each in/out pair becomes a manager_clock_sessions row underneath it:
--
--   manager_clock_events.clock_in_at  = the FIRST session's clock-in
--   manager_clock_events.clock_out_at = the LAST session's clock-out, and NULL
--                                       again whenever a session is open
--   manager_clock_events.worked_hours = the SUM of completed sessions
--
-- Keeping clock_out_at null while a session is open is what lets every
-- "is this manager on shift" check keep working untouched: managerStatusOf on
-- the Live board, the ✓in/out marks on the Rota, the shift-reminder cron's
-- clockedIn/clockedOut pair, and the auto clock-out sweep's
-- `.is("clock_out_at", null)` scan.
--
-- A manager's pay is a FIXED DAILY WAGE that turns on merely having clocked in
-- (see LiveDashboard managerExpectedTotal), so unlike the employee change this
-- one moves no money. worked_hours exists so the monitoring figures — hours on
-- the Live board and the Rota — stop spanning the gap between two shifts.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- TABLE: manager_clock_sessions — one row per clock-in/clock-out pair
-- =============================================================
create table if not exists public.manager_clock_sessions (
  id                    uuid primary key default gen_random_uuid(),
  clock_event_id        uuid not null references public.manager_clock_events(id) on delete cascade,
  -- Denormalised from the parent so RLS and the "is this manager still clocked
  -- in" lookup don't need a join on every clock action.
  manager_id            uuid not null references public.allowed_users(id) on delete cascade,
  store_id              uuid references public.stores(id) on delete set null,
  -- The date the session STARTED. A session that runs past midnight stays on
  -- the day it began, so it settles with the rest of that day's work.
  event_date            date not null,
  -- 1, 2, 3… INSERTION order within the day. A stable handle, not a
  -- chronological one — always derive day bounds from clock_in_at.
  seq                   integer not null,
  clock_in_at           timestamptz not null,
  clock_out_at          timestamptz,
  clock_in_lat          numeric(10,7),
  clock_in_lng          numeric(10,7),
  clock_out_lat         numeric(10,7),
  clock_out_lng         numeric(10,7),
  auto_clocked_out      boolean not null default false,
  auto_clock_out_source text,
  auto_clock_out_at     timestamptz,
  created_at            timestamptz not null default now()
);

comment on table public.manager_clock_sessions is
  'One manager clock-in/clock-out pair. A day can hold several; manager_clock_events is the per-day header that sums them.';
comment on column public.manager_clock_sessions.event_date is
  'The date the session STARTED — a session crossing midnight stays on its opening day.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'manager_clock_sessions_auto_source_check'
  ) then
    alter table public.manager_clock_sessions
      add constraint manager_clock_sessions_auto_source_check
      check (
        auto_clock_out_source is null
        or auto_clock_out_source in ('rota','schedule','store_close','fallback')
      );
  end if;
  -- A closed session must end after it started. Guards against a badly resolved
  -- auto clock-out writing negative hours onto a monitoring figure.
  if not exists (
    select 1 from pg_constraint where conname = 'manager_clock_sessions_order_check'
  ) then
    alter table public.manager_clock_sessions
      add constraint manager_clock_sessions_order_check
      check (clock_out_at is null or clock_out_at > clock_in_at);
  end if;
end $$;

create unique index if not exists manager_clock_sessions_event_seq
  on public.manager_clock_sessions (clock_event_id, seq);

-- THE invariant that replaces "one in/out pair per day": a manager can have at
-- most one session open at a time, across every date. Stronger than what
-- existed before — only an application check stopped a double clock-in.
create unique index if not exists manager_clock_sessions_one_open
  on public.manager_clock_sessions (manager_id)
  where clock_out_at is null;

create index if not exists manager_clock_sessions_manager_date_idx
  on public.manager_clock_sessions (manager_id, event_date);
create index if not exists manager_clock_sessions_date_idx
  on public.manager_clock_sessions (event_date);

-- =============================================================
-- manager_clock_events — the day header gains its summed hours
-- =============================================================
alter table public.manager_clock_events
  -- Sum of the day's COMPLETED sessions. Null means no sessions exist for the
  -- row (legacy data, or a row written by the pre-031 build) — readers fall
  -- back to clock_out_at - clock_in_at, which is correct for a single shift.
  add column if not exists worked_hours  numeric(6,2),
  add column if not exists session_count integer not null default 0;

comment on column public.manager_clock_events.worked_hours is
  'Sum of the day''s completed manager_clock_sessions. NOT clock_out_at - clock_in_at, which would include the gap between shifts. Null = no sessions; fall back to the raw delta.';

-- =============================================================
-- Backfill — one session per existing completed day
--
-- Only rows with BOTH timestamps are backfilled. An open legacy row (clocked
-- in, never clocked out) is deliberately skipped: several per manager would
-- collide on the manager_clock_sessions_one_open index. They keep working
-- through the raw-delta fallback, the auto clock-out sweep closes them as it
-- always has, and the clock-out path adopts one into a session if the manager
-- returns to it.
-- =============================================================
insert into public.manager_clock_sessions (
  clock_event_id, manager_id, store_id, event_date, seq,
  clock_in_at, clock_out_at,
  clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng,
  auto_clocked_out, auto_clock_out_source, auto_clock_out_at
)
select
  mce.id, mce.manager_id, mce.store_id, mce.event_date, 1,
  mce.clock_in_at, mce.clock_out_at,
  mce.clock_in_lat, mce.clock_in_lng, mce.clock_out_lat, mce.clock_out_lng,
  coalesce(mce.auto_clocked_out, false), mce.auto_clock_out_source, mce.auto_clock_out_at
from public.manager_clock_events mce
where mce.clock_in_at is not null
  and mce.clock_out_at is not null
  and mce.clock_out_at > mce.clock_in_at
  and not exists (
    select 1 from public.manager_clock_sessions mcs where mcs.clock_event_id = mce.id
  );

update public.manager_clock_events mce
set
  worked_hours  = agg.hours,
  session_count = agg.n
from (
  select
    mcs.clock_event_id,
    round(sum(extract(epoch from (mcs.clock_out_at - mcs.clock_in_at)) / 3600.0)::numeric, 2) as hours,
    count(*) as n
  from public.manager_clock_sessions mcs
  where mcs.clock_out_at is not null
  group by mcs.clock_event_id
) agg
where agg.clock_event_id = mce.id
  and (
    mce.worked_hours  is distinct from agg.hours
    or mce.session_count is distinct from agg.n
  );

-- =============================================================
-- RLS — mirrors manager_clock_events exactly: an admin sees everything, a
-- manager sees and writes only their own rows. Deliberately NOT is_staff():
-- manager attendance is private between the manager and the admin, and the
-- header table has drawn that line since migration 012.
-- =============================================================
alter table public.manager_clock_sessions enable row level security;

drop policy if exists "manager_clock_sessions_select" on public.manager_clock_sessions;
drop policy if exists "manager_clock_sessions_insert" on public.manager_clock_sessions;
drop policy if exists "manager_clock_sessions_update" on public.manager_clock_sessions;
drop policy if exists "manager_clock_sessions_delete" on public.manager_clock_sessions;

create policy "manager_clock_sessions_select" on public.manager_clock_sessions
  for select to authenticated
  using (
    public.is_admin(auth.jwt() ->> 'email')
    or manager_id = public.current_allowed_user_id()
  );

create policy "manager_clock_sessions_insert" on public.manager_clock_sessions
  for insert to authenticated
  with check (manager_id = public.current_allowed_user_id());

create policy "manager_clock_sessions_update" on public.manager_clock_sessions
  for update to authenticated
  using (manager_id = public.current_allowed_user_id())
  with check (manager_id = public.current_allowed_user_id());

create policy "manager_clock_sessions_delete" on public.manager_clock_sessions
  for delete to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'));

grant all on public.manager_clock_sessions to anon, authenticated, service_role;
