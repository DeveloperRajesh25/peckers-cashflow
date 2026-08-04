-- =============================================================
-- Migration 035 — Approval GATES pay, and is tracked PER SHIFT
--
-- Run AFTER 034. ADDITIVE ONLY — no column is dropped and no existing payable
-- value changes, so it is safe to run BEFORE the new code ships (the rule
-- migration 027 nearly broke; see Update 65).
--
-- WHAT CHANGES, IN ONE LINE
-- Until now an employee's hours and deliveries were paid whether or not anyone
-- signed them off ("approval refines pay; it does not gate it"). From here,
-- NOTHING reaches the Tuesday payout until a manager approves it — employees
-- and managers now behave the way cover drivers always have.
--
-- WHY PER SHIFT AND NOT PER DAY
-- A day can hold several shifts (029 for hours, 033 for deliveries). The
-- required behaviour is:
--
--   approve shift A (3 drops)            → payout shows 3
--   shift B added later, approve it (1)  → payout shows 4
--   undo shift B's approval              → payout shows 3 again
--
-- A single per-day flag cannot express "B is withdrawn but A still stands" —
-- unapproving would drop the whole day to 0. So the approval flag moves down
-- onto the session, exactly where the hours and the delivery counts already
-- live, and the day header carries the APPROVED SUM alongside the raw one.
--
-- This is also what unblocks adding a manually entered shift to a day that has
-- already been approved: the new shift simply arrives unapproved.
--
-- THE HEADER STAYS THE READ MODEL
-- Every module keeps reading one row per person per day. It just gains a second
-- set of columns — approved_* — which are the ones that pay. Raw totals are
-- untouched and still drive the Live board, the Rota and what the employee sees
-- of their own day, because those must show what was actually worked.
--
-- BACKFILL
-- Every session that already exists is marked approved, so no payout sheet
-- changes value the moment this runs. The gate applies to shifts recorded from
-- here on. This is done with the add-column-default trick rather than an UPDATE
-- so that re-running the migration can never re-approve a shift a manager has
-- since withdrawn:
--
--   add column ... default true   → backfills existing rows only
--   alter column ... set default false → every new row starts unapproved
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- 1. clock_sessions — a shift carries its own approval
-- =============================================================
alter table public.clock_sessions
  add column if not exists hours_approved    boolean not null default true,
  add column if not exists approved_hours    numeric(6,2),
  add column if not exists hours_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists hours_approved_at timestamptz;

-- Existing shifts are now approved; every shift created from here starts
-- unapproved and must be signed off before it is worth anything.
alter table public.clock_sessions
  alter column hours_approved set default false;

comment on column public.clock_sessions.hours_approved is
  'Has a manager signed off THIS shift? Nothing on an unapproved shift reaches the Tuesday payout — neither its hours nor its deliveries.';
comment on column public.clock_sessions.approved_hours is
  'Manager-corrected hours for this shift. Null means "the clocked duration was right". clock_events.approved_hours is the day''s SUM across approved shifts, written only by recomputeDayHeader.';

-- A corrected shift can't be negative or longer than a day.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clock_sessions_approved_hours_sane'
  ) then
    alter table public.clock_sessions
      add constraint clock_sessions_approved_hours_sane
      check (approved_hours is null or (approved_hours > 0 and approved_hours <= 24));
  end if;
end $$;

-- Daily Approval pulls the outstanding shifts for a date; without this it is a
-- sequential scan of every shift ever recorded.
create index if not exists clock_sessions_pending_idx
  on public.clock_sessions (event_date)
  where hours_approved = false;

-- =============================================================
-- 2. clock_events — the day's APPROVED totals, derived
--
-- These sit beside the raw columns, never replacing them:
--   short_deliveries_count           what was actually recorded  (Live, Rota)
--   approved_short_deliveries_count  what is actually paid       (payout)
--
-- All written solely by recomputeDayHeader (lib/clock-sessions.ts), which is
-- already the single writer of the raw ones.
-- =============================================================
alter table public.clock_events
  add column if not exists approved_short_deliveries_count integer,
  add column if not exists approved_long_deliveries_count  integer,
  add column if not exists approved_extra_short_deliveries integer not null default 0,
  add column if not exists approved_extra_long_deliveries  integer not null default 0,
  -- How many of the day's shifts are signed off. Lets a screen say "1 of 2
  -- approved" without fetching the sessions.
  add column if not exists approved_session_count integer not null default 0;

comment on column public.clock_events.approved_short_deliveries_count is
  'Short drops on APPROVED shifts only — the figure the Tuesday payout pays. The unprefixed column stays the raw recorded total.';
comment on column public.clock_events.hours_approved is
  'True only when EVERY completed shift of the day is signed off. A day with one of two shifts approved reads false — there is still work outstanding on it.';
comment on column public.clock_events.approved_hours is
  'SUM of the approved shifts’ hours for the day (each shift''s correction, or its clocked duration). Null when no shift is approved. This is what payroll pays.';

-- =============================================================
-- 3. manager_clock_sessions — same shape, deliveries only
--
-- A manager's hours pay nothing (fixed salary), so only their drops are gated.
-- =============================================================
alter table public.manager_clock_sessions
  add column if not exists deliveries_approved    boolean not null default true,
  add column if not exists deliveries_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists deliveries_approved_at timestamptz;

alter table public.manager_clock_sessions
  alter column deliveries_approved set default false;

comment on column public.manager_clock_sessions.deliveries_approved is
  'Has this shift''s delivery count been signed off? Unapproved drops are not paid. A manager may approve their own shift or a peer''s — the client trusts managers to confirm what they saw.';

alter table public.manager_clock_events
  add column if not exists approved_short_deliveries_count integer,
  add column if not exists approved_long_deliveries_count  integer,
  add column if not exists approved_extra_short_deliveries integer not null default 0,
  add column if not exists approved_extra_long_deliveries  integer not null default 0,
  add column if not exists approved_session_count integer not null default 0;

-- =============================================================
-- 4. Seed the derived columns from what is already there
--
-- A recompute, not a one-way backfill: it reads the session flags set above and
-- writes the sums they imply, so re-running it is always safe — it can only
-- restate the same answer.
-- =============================================================

-- Days that HAVE sessions: sum the approved ones.
with rolled as (
  select
    s.clock_event_id                                                  as id,
    sum(case when s.hours_approved then coalesce(s.short_deliveries_count, 0) else 0 end) as short,
    sum(case when s.hours_approved then coalesce(s.long_deliveries_count, 0)  else 0 end) as long,
    sum(case when s.hours_approved then coalesce(s.extra_short_deliveries, 0) else 0 end) as ex_short,
    sum(case when s.hours_approved then coalesce(s.extra_long_deliveries, 0)  else 0 end) as ex_long,
    -- Completed only, matching deriveDayHeader: an open shift can't be signed
    -- off, so counting it would leave the header disagreeing with the next
    -- recompute.
    count(*) filter (where s.hours_approved and s.clock_out_at is not null) as approved_count,
    -- Only completed shifts can be approved, so an open one must not make the
    -- day read as fully signed off.
    count(*) filter (where s.clock_out_at is not null and not s.hours_approved) as outstanding,
    sum(
      case
        when s.hours_approved and s.clock_out_at is not null
        then coalesce(
               s.approved_hours,
               extract(epoch from (s.clock_out_at - s.clock_in_at)) / 3600.0
             )
        else 0
      end
    )                                                                 as approved_hrs
  from public.clock_sessions s
  group by s.clock_event_id
)
update public.clock_events ce
set
  approved_short_deliveries_count = rolled.short,
  approved_long_deliveries_count  = rolled.long,
  approved_extra_short_deliveries = rolled.ex_short,
  approved_extra_long_deliveries  = rolled.ex_long,
  approved_session_count          = rolled.approved_count,
  hours_approved                  = (rolled.approved_count > 0 and rolled.outstanding = 0),
  approved_hours                  = case
                                      when rolled.approved_count > 0
                                      then round(rolled.approved_hrs::numeric, 2)
                                      else null
                                    end
from rolled
where ce.id = rolled.id;

-- Pre-029 days that have NO sessions at all: their header IS the record, so
-- treat it as approved in line with the backfill rule above.
update public.clock_events ce
set
  approved_short_deliveries_count = ce.short_deliveries_count,
  approved_long_deliveries_count  = ce.long_deliveries_count,
  approved_extra_short_deliveries = coalesce(ce.extra_short_deliveries, 0),
  approved_extra_long_deliveries  = coalesce(ce.extra_long_deliveries, 0),
  approved_session_count          = 1,
  hours_approved                  = true,
  approved_hours                  = coalesce(
                                      ce.approved_hours,
                                      round(
                                        (extract(epoch from (ce.clock_out_at - ce.clock_in_at)) / 3600.0)::numeric,
                                        2
                                      )
                                    )
where ce.clock_in_at is not null
  and ce.clock_out_at is not null
  and not exists (select 1 from public.clock_sessions s where s.clock_event_id = ce.id);

-- Managers: the same roll-up, deliveries only.
with rolled as (
  select
    s.clock_event_id                                                  as id,
    sum(case when s.deliveries_approved then coalesce(s.short_deliveries_count, 0) else 0 end) as short,
    sum(case when s.deliveries_approved then coalesce(s.long_deliveries_count, 0)  else 0 end) as long,
    sum(case when s.deliveries_approved then coalesce(s.extra_short_deliveries, 0) else 0 end) as ex_short,
    sum(case when s.deliveries_approved then coalesce(s.extra_long_deliveries, 0)  else 0 end) as ex_long,
    count(*) filter (where s.deliveries_approved and s.clock_out_at is not null) as approved_count,
    count(*) filter (where s.clock_out_at is not null and not s.deliveries_approved) as outstanding
  from public.manager_clock_sessions s
  group by s.clock_event_id
)
update public.manager_clock_events mce
set
  approved_short_deliveries_count = rolled.short,
  approved_long_deliveries_count  = rolled.long,
  approved_extra_short_deliveries = rolled.ex_short,
  approved_extra_long_deliveries  = rolled.ex_long,
  approved_session_count          = rolled.approved_count,
  deliveries_approved             = (rolled.approved_count > 0 and rolled.outstanding = 0)
from rolled
where mce.id = rolled.id;

update public.manager_clock_events mce
set
  approved_short_deliveries_count = mce.short_deliveries_count,
  approved_long_deliveries_count  = mce.long_deliveries_count,
  approved_extra_short_deliveries = coalesce(mce.extra_short_deliveries, 0),
  approved_extra_long_deliveries  = coalesce(mce.extra_long_deliveries, 0),
  approved_session_count          = 1,
  deliveries_approved             = true
where mce.clock_in_at is not null
  and mce.clock_out_at is not null
  and not exists (select 1 from public.manager_clock_sessions s where s.clock_event_id = mce.id);
