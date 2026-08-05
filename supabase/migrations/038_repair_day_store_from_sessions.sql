-- =============================================================
-- Migration 038 — Repair days whose HEADER store disagrees with their shifts
--
-- Run AFTER 037. IDEMPOTENT and safe to re-run: it only ever copies a store
-- that is already recorded on a shift up onto that shift's day.
--
-- THE FAULT
-- clock_events is the day HEADER over clock_sessions, and each shift carries
-- the store it was actually worked at — GPS-verified at clock-in. But the
-- header's store was frozen at whatever store the day STARTED at:
--
--   app/actions/clock.ts (before this fix)
--     store_id: existing.clock_in_at ? existing.store_id : workedStoreId
--
-- So a day that began with one shift at store A and continued with a second at
-- store B kept reading "A" on the header. Two things read the header and got it
-- wrong:
--
--   * the Live board (todayStoreOf → clock_events.store_id) put the person
--     under store A while they stood in store B;
--   * the Tuesday payout (resolveWorkingDays → DayWork.store_id) billed the
--     whole day to store A's till, and applied the NI/cash split for the wrong
--     store — hours at the employee's HOME store carry the weekly bank-hours
--     allowance, hours at a visited store are 100% cash.
--
-- The same applied to a manager-entered shift, which is stamped with the store
-- the MANAGER was running rather than one GPS ever verified: the person's own
-- clock-in at their real store landed on the session, and the header kept the
-- manager's guess.
--
-- THE REPAIR
-- The day takes the store of the shift currently OPEN, else of its LATEST shift
-- — by clock time, never by insertion order, because a forgotten morning can be
-- entered after the evening it precedes. This is exactly what deriveDayHeader
-- now computes, so a repaired row and a freshly recomputed one agree.
--
-- Days whose shifts carry no store, and days already correct, are untouched.
-- =============================================================

-- ---------- Employees ----------
with latest as (
  select distinct on (s.clock_event_id)
    s.clock_event_id,
    s.store_id
  from public.clock_sessions s
  where s.store_id is not null
  order by
    s.clock_event_id,
    -- An open shift is where they are NOW, so it wins outright.
    (s.clock_out_at is null) desc,
    s.clock_in_at desc,
    s.seq desc
)
update public.clock_events ce
set store_id = latest.store_id
from latest
where ce.id = latest.clock_event_id
  and ce.store_id is distinct from latest.store_id;

-- ---------- Managers ----------
-- deliveries_only rows (migration 037) are a carrier for drops, not attendance:
-- the manager was never on shift, so such a row must not decide the day's store.
with latest as (
  select distinct on (s.clock_event_id)
    s.clock_event_id,
    s.store_id
  from public.manager_clock_sessions s
  where s.store_id is not null
    and coalesce(s.deliveries_only, false) = false
  order by
    s.clock_event_id,
    (s.clock_out_at is null) desc,
    s.clock_in_at desc,
    s.seq desc
)
update public.manager_clock_events mce
set store_id = latest.store_id
from latest
where mce.id = latest.clock_event_id
  and mce.store_id is distinct from latest.store_id;
