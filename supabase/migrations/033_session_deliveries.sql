-- =============================================================
-- Migration 033 — Deliveries recorded PER SHIFT, not per day
--
-- Run AFTER 032. ADDITIVE ONLY — no column is dropped and no existing value is
-- changed, so it is safe to run BEFORE the new code ships (the rule migration
-- 027 nearly broke; see Update 65).
--
-- THE PROBLEM
-- Delivery counts lived only as four columns on the clock_events day header,
-- and EVERY clock-out overwrote them. The design intended the driver to re-type
-- the day's running total each time, but the clock-out form never said so — it
-- just asked for "Short deliveries". A driver who worked 10 short in the
-- morning and 3 in the evening typed 3 at the second clock-out, and the 10 was
-- silently gone. Nothing warned, because a lower number is a legitimate
-- correction as far as the old code knew. Rota, the Employee page and the
-- Tuesday payout then all faithfully showed 3 — they weren't miscalculating,
-- 3 was the only number left.
--
-- Multi-shift days (migration 029 for attendance, 032 for scheduling) made this
-- a routine trap rather than a rare one.
--
-- THE SHAPE OF THE FIX
-- Exactly the pattern migration 029 used for HOURS: each shift records its own
-- counts on clock_sessions, and the clock_events header becomes a derived SUM
-- maintained solely by recomputeDayHeader (lib/clock-sessions.ts).
--
-- This is what keeps the change small everywhere else: the header columns stay
-- where they are and keep meaning "the day's total", so Rota, the Tuesday
-- payout, Payout History, the Live board, Daily Approval, Crew Analytics and
-- the Vita Mojo cross-check all keep reading exactly what they read before —
-- the number is simply correct now on a split day.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- clock_sessions — each shift carries its own delivery counts
-- =============================================================
alter table public.clock_sessions
  -- Null (not 0) means "this shift recorded nothing", which is different from
  -- a driver explicitly entering 0. The header sum treats null as 0.
  add column if not exists short_deliveries_count integer,
  add column if not exists long_deliveries_count  integer,
  -- Extras (drops beyond the normal round) always carry a reason, so they
  -- default to 0 rather than null — same shape as clock_events.
  add column if not exists extra_short_deliveries integer not null default 0,
  add column if not exists extra_long_deliveries  integer not null default 0,
  add column if not exists extra_short_reason     text,
  add column if not exists extra_long_reason      text;

comment on column public.clock_sessions.short_deliveries_count is
  'Short drops for THIS shift only. clock_events.short_deliveries_count is the day''s SUM of these, written only by recomputeDayHeader.';
comment on column public.clock_sessions.extra_short_deliveries is
  'Extra short drops beyond the round, for THIS shift. Requires extra_short_reason when above zero.';

-- Counts are never negative — guards a bad manual correction from crediting a
-- negative drop against the day's total (and so against the driver's pay).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clock_sessions_deliveries_non_negative'
  ) then
    alter table public.clock_sessions
      add constraint clock_sessions_deliveries_non_negative
      check (
        coalesce(short_deliveries_count, 0) >= 0
        and coalesce(long_deliveries_count, 0) >= 0
        and extra_short_deliveries >= 0
        and extra_long_deliveries >= 0
      );
  end if;
end $$;

-- =============================================================
-- Backfill — put each day's EXISTING header total on its earliest session
--
-- The header total is the only per-day figure that exists, and there is no way
-- to know retrospectively how it split across a day's shifts. Assigning the
-- whole of it to the day's first shift is the one choice that guarantees the
-- SUM equals the total that is on the header right now — so no historical day,
-- no confirmed payout, and no already-approved week changes value by a single
-- drop when the new code starts summing.
--
-- Guarded on the session having no counts yet, so re-running cannot double up.
-- =============================================================
with first_session as (
  select distinct on (cs.clock_event_id)
    cs.id,
    cs.clock_event_id
  from public.clock_sessions cs
  order by cs.clock_event_id, cs.clock_in_at, cs.seq
)
update public.clock_sessions cs
set
  short_deliveries_count = ce.short_deliveries_count,
  long_deliveries_count  = ce.long_deliveries_count,
  extra_short_deliveries = coalesce(ce.extra_short_deliveries, 0),
  extra_long_deliveries  = coalesce(ce.extra_long_deliveries, 0),
  extra_short_reason     = ce.extra_short_reason,
  extra_long_reason      = ce.extra_long_reason
from first_session fs
join public.clock_events ce on ce.id = fs.clock_event_id
where cs.id = fs.id
  and cs.short_deliveries_count is null
  and cs.long_deliveries_count is null
  and cs.extra_short_deliveries = 0
  and cs.extra_long_deliveries = 0
  and (
    ce.short_deliveries_count is not null
    or ce.long_deliveries_count is not null
    or coalesce(ce.extra_short_deliveries, 0) <> 0
    or coalesce(ce.extra_long_deliveries, 0) <> 0
  );

-- Deliberately NOT recomputing clock_events here. The header already holds the
-- correct day totals, the backfill above makes the sessions sum to exactly
-- that, and leaving the header untouched means this migration cannot alter a
-- single historical figure — including on days that have no sessions at all
-- (pre-029 rows, which migration 029 deliberately skipped and which keep
-- working through the same header-value fallback they always have).
