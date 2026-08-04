-- =============================================================
-- Migration 036 — Repair days whose deliveries live on the HEADER only
--
-- Run AFTER 035. ADDITIVE AND IDEMPOTENT — it only ever moves counts that are
-- already recorded down onto the shift they belong to, and can never invent,
-- lower or double a drop.
--
-- THE FAULT
-- Update 88 moved delivery counts from the clock_events header onto
-- clock_sessions, and migration 033 backfilled the days that existed when it
-- ran. Some days recorded afterwards still had their counts written to the
-- header alone, leaving the session at NULL.
--
-- That was invisible until migration 035, which derives the APPROVED columns —
-- the only ones the Tuesday payout pays — as a SUM OVER THE SESSIONS:
--
--   clock_events.short_deliveries_count           10   ← what the driver did
--   clock_sessions.short_deliveries_count       NULL   ← where the sum looks
--   clock_events.approved_short_deliveries_count   0   ← what gets paid
--
-- Confirmed on 2026-08-03 for three Hitchin/Stevenage drivers. Because every
-- one of them was under the 20h NI limit at their home store, deliveries were
-- their ONLY payable item — so a zero there did not shrink their line, it
-- removed them from the payout sheet entirely (buildWageLinesForStore drops any
-- line totalling <= 0). They were silently unpaid.
--
-- WHY THE UI COULD NOT FIX IT
-- 035's backfill marked every existing shift approved, so these days already
-- read hours_approved = true. approveDailyHoursForDate skips such a day
-- outright, and approveDaySessions finds nothing pending and returns 0, so
-- recomputeDayHeader never ran. The row showed "approved" with an Undo button
-- and no way back.
--
-- WHY IT HAD TO BE FIXED BEFORE ANYONE PRESSED UNDO
-- recomputeDayHeader rewrites the RAW columns from the sessions too. On these
-- days the sessions are empty, so an Undo would have overwritten the header
-- with NULL and destroyed the only surviving record of those rounds. The code
-- guard that stops that ships alongside this migration.
--
-- THE REPAIR
-- Settle the gap on the day's EARLIEST session — the same rule migration 033
-- used, so a day repaired here and a day backfilled there end up identical.
-- Adding the DIFFERENCE rather than assigning the total is what makes this
-- idempotent: once the sums agree the gap is zero and re-running is a no-op.
-- greatest(..., 0) means a header that somehow reads LOWER than its sessions is
-- left alone rather than clawing a drop back off a driver's pay.
-- =============================================================

-- =============================================================
-- 1. Move the missing counts onto the earliest shift of each affected day
-- =============================================================
with gaps as (
  select
    ce.id                                                                     as event_id,
    greatest(coalesce(ce.short_deliveries_count, 0)
             - coalesce(sum(s.short_deliveries_count), 0), 0)                 as sd_gap,
    greatest(coalesce(ce.long_deliveries_count, 0)
             - coalesce(sum(s.long_deliveries_count), 0), 0)                  as ld_gap,
    greatest(coalesce(ce.extra_short_deliveries, 0)
             - coalesce(sum(s.extra_short_deliveries), 0), 0)                 as ms_gap,
    greatest(coalesce(ce.extra_long_deliveries, 0)
             - coalesce(sum(s.extra_long_deliveries), 0), 0)                  as ml_gap,
    ce.extra_short_reason,
    ce.extra_long_reason
  from public.clock_events ce
  join public.clock_sessions s on s.clock_event_id = ce.id
  group by ce.id, ce.short_deliveries_count, ce.long_deliveries_count,
           ce.extra_short_deliveries, ce.extra_long_deliveries,
           ce.extra_short_reason, ce.extra_long_reason
),
targets as (
  select
    g.*,
    (
      -- Chronological, never by seq: a manager can record a forgotten morning
      -- after the evening, and seq is insertion order (Update 72).
      select s.id
      from public.clock_sessions s
      where s.clock_event_id = g.event_id
      order by s.clock_in_at asc, s.seq asc
      limit 1
    ) as session_id
  from gaps g
  where g.sd_gap > 0 or g.ld_gap > 0 or g.ms_gap > 0 or g.ml_gap > 0
)
update public.clock_sessions s
set
  short_deliveries_count = coalesce(s.short_deliveries_count, 0) + t.sd_gap,
  long_deliveries_count  = coalesce(s.long_deliveries_count, 0)  + t.ld_gap,
  extra_short_deliveries = coalesce(s.extra_short_deliveries, 0) + t.ms_gap,
  extra_long_deliveries  = coalesce(s.extra_long_deliveries, 0)  + t.ml_gap,
  -- An extra drop must always keep the reason that justifies paying it. The
  -- session's own text wins where it has one; otherwise the day's carries over.
  extra_short_reason = case
                         when t.ms_gap > 0
                         then coalesce(s.extra_short_reason, t.extra_short_reason)
                         else s.extra_short_reason
                       end,
  extra_long_reason  = case
                         when t.ml_gap > 0
                         then coalesce(s.extra_long_reason, t.extra_long_reason)
                         else s.extra_long_reason
                       end
from targets t
where s.id = t.session_id;

-- =============================================================
-- 2. Re-derive the approved columns from the repaired sessions
--
-- Byte-for-byte the recompute from migration 035 §4, deliberately: the header
-- has exactly ONE definition and re-running it can only ever restate the same
-- answer from the current session flags. Days nobody touched come out
-- unchanged; the three repaired above pick up the drops they were missing.
-- =============================================================
with rolled as (
  select
    s.clock_event_id                                                  as id,
    sum(case when s.hours_approved then coalesce(s.short_deliveries_count, 0) else 0 end) as short,
    sum(case when s.hours_approved then coalesce(s.long_deliveries_count, 0)  else 0 end) as long,
    sum(case when s.hours_approved then coalesce(s.extra_short_deliveries, 0) else 0 end) as ex_short,
    sum(case when s.hours_approved then coalesce(s.extra_long_deliveries, 0)  else 0 end) as ex_long,
    count(*) filter (where s.hours_approved and s.clock_out_at is not null) as approved_count,
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

-- =============================================================
-- 3. Verification — every day with sessions must now agree with them
--
-- Expected: zero rows. Anything returned is a header still out of step with
-- its shifts and must be looked at before the next Tuesday payout is confirmed.
-- =============================================================
-- select ce.event_date, ce.employee_id,
--        ce.short_deliveries_count, sum(s.short_deliveries_count) as sess_sd,
--        ce.approved_short_deliveries_count
-- from public.clock_events ce
-- join public.clock_sessions s on s.clock_event_id = ce.id
-- group by ce.id, ce.event_date, ce.employee_id,
--          ce.short_deliveries_count, ce.approved_short_deliveries_count
-- having coalesce(ce.short_deliveries_count, 0) <> coalesce(sum(s.short_deliveries_count), 0);
