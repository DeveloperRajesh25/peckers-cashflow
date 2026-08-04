-- =============================================================
-- Migration 037 — A manager's missed deliveries can be recorded by hand
--
-- Run AFTER 036. ADDITIVE ONLY: every column is new, the one constraint that is
-- replaced is WIDENED, and both RLS changes ADD alternatives to an existing
-- rule rather than removing one. Safe to run BEFORE the code ships (the rule
-- migration 027 nearly broke — see Update 65).
--
-- THE PROBLEM (known gap 3c, opened by Update 90)
-- A manager who covers deliveries records them at CLOCK-OUT. A manager who
-- forgot to clock in has no clock-out to answer, so their drops had nowhere to
-- go — the money was simply lost. Employees and cover drivers already have a
-- manual entry path (migration 026); managers had none.
--
-- THE SHAPE OF THE FIX
-- Deliberately NOT "a manual clock-in for managers". A manager's fixed daily
-- wage turns on merely having clocked in (LiveDashboard managerExpectedTotal),
-- so fabricating times to hang drops off would overstate the store's wage bill
-- on the Live board and mark them present on the Rota for a day they weren't.
--
-- Instead a DELIVERIES-ONLY session: a manager_clock_sessions row carrying the
-- counts, flagged `deliveries_only`, with clock_in_at = clock_out_at so it has
-- no duration to contribute. recomputeManagerDayHeader excludes it from the
-- day's bounds, hours and shift count, so a day holding only one of these keeps
-- a NULL clock_in_at and reads everywhere as a day the manager never clocked.
--
-- Putting the counts on a SESSION rather than straight onto the day header is
-- the whole point: the header's delivery columns are derived, and Update 94
-- showed what happens to counts that live only on a header — the next recompute
-- erases them and the drops silently stop being paid.
--
-- Approval and payment are unchanged: the session is signed off on Daily
-- Approval like any other shift (migration 035), the day's approved_* columns
-- sum it, and buildManagerWageLines pays it on the Tuesday sheet.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- 1. manager_clock_sessions — the deliveries-only shift, and its audit trail
--
-- The manual_entry_* columns mirror clock_events' (migration 026) in name and
-- meaning: a row written by hand was never geofence-verified, carries a reason,
-- and says who recorded it.
-- =============================================================
alter table public.manager_clock_sessions
  add column if not exists deliveries_only     boolean not null default false,
  add column if not exists manual_entry        boolean not null default false,
  add column if not exists manual_entry_by     uuid references auth.users(id) on delete set null,
  add column if not exists manual_entry_at     timestamptz,
  add column if not exists manual_entry_reason text;

comment on column public.manager_clock_sessions.deliveries_only is
  'This row records DROPS ONLY for a day the manager never clocked. It has no duration and is excluded from the day''s bounds, worked hours and shift count by recomputeManagerDayHeader — only its delivery counts are read.';
comment on column public.manager_clock_sessions.manual_entry is
  'True when a manager or admin recorded this row by hand. Such a row was NOT geofence-verified (lat/lng are null).';

-- The order check is WIDENED so a deliveries-only row may be zero-length. Every
-- row that satisfied the old rule satisfies this one.
alter table public.manager_clock_sessions
  drop constraint if exists manager_clock_sessions_order_check;
alter table public.manager_clock_sessions
  add constraint manager_clock_sessions_order_check
  check (
    clock_out_at is null
    or clock_out_at > clock_in_at
    or (deliveries_only and clock_out_at = clock_in_at)
  );

-- A deliveries-only row must be closed and zero-length. Closed is load-bearing:
-- an open one would occupy the manager_clock_sessions_one_open slot and block
-- them from ever clocking in again.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'manager_clock_sessions_deliveries_only_closed'
  ) then
    alter table public.manager_clock_sessions
      add constraint manager_clock_sessions_deliveries_only_closed
      check (
        not deliveries_only
        or (clock_out_at is not null and clock_out_at = clock_in_at)
      );
  end if;
end $$;

-- At most ONE deliveries-only row per day, so re-recording a day corrects it
-- rather than paying the same drops twice.
create unique index if not exists manager_clock_sessions_one_deliveries_only
  on public.manager_clock_sessions (clock_event_id)
  where deliveries_only;

-- =============================================================
-- 2. manager_clock_events — the day is flagged as manager-entered
--
-- Same columns clock_events has carried since migration 026, so the "Manual"
-- badge on Daily Approval is driven by one field name across all three tables.
-- No manual_entry_fields here: a manager entry supplies no times at all, so
-- there is no 'in' | 'out' | 'both' to record.
-- =============================================================
alter table public.manager_clock_events
  add column if not exists manual_entry        boolean not null default false,
  add column if not exists manual_entry_by     uuid references auth.users(id) on delete set null,
  add column if not exists manual_entry_at     timestamptz,
  add column if not exists manual_entry_reason text;

comment on column public.manager_clock_events.manual_entry is
  'True when this day''s deliveries were recorded by hand because the manager never clocked in. The day has no clock times and no location check.';

create index if not exists manager_clock_events_manual_idx
  on public.manager_clock_events (manual_entry, event_date desc) where manual_entry;

-- =============================================================
-- 3. RLS — recording a PEER's missed deliveries
--
-- 012 and 031 scoped INSERT on both tables to `manager_id =
-- current_allowed_user_id()`: a row could only ever be written by the person it
-- belonged to. 034 widened SELECT and UPDATE to can_access_store(store_id) but
-- deliberately left INSERT alone, on the grounds that recording someone else's
-- clock-in is the manual entry path's job. This IS that path, so INSERT gains
-- the same alternatives — and admins, who own no manager row at all and could
-- not otherwise write one.
--
-- Widening only: the own-row clause is kept, so nothing that worked stops.
-- =============================================================
drop policy if exists "manager_clock_insert" on public.manager_clock_events;
create policy "manager_clock_insert" on public.manager_clock_events
  for insert to authenticated
  with check (
    manager_id = public.current_allowed_user_id()
    or public.is_admin(auth.jwt() ->> 'email')
    or public.can_access_store(store_id)
  );

drop policy if exists "manager_clock_sessions_insert" on public.manager_clock_sessions;
create policy "manager_clock_sessions_insert" on public.manager_clock_sessions
  for insert to authenticated
  with check (
    manager_id = public.current_allowed_user_id()
    or public.is_admin(auth.jwt() ->> 'email')
    or public.can_access_store(store_id)
  );

-- =============================================================
-- Backfill: none. Every manager day on record either has real clock times or
-- has no drops to carry, so nothing here moves an existing figure by a penny.
-- =============================================================
