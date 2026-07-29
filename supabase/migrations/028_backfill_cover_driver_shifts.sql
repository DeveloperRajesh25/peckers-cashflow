-- =============================================================
-- Migration 028 — Backfill cover driver rota cells from clocked days
--
-- Run AFTER 025_cover_driver_shifts.sql.
--
-- The Rota's "Total hrs" and "Wages" columns sum `scheduled_hours` from booked
-- cover_driver_shifts cells. Until now a cover driver's clock-in never created
-- one, so a day they actually worked showed the in/out times in the cell but
-- 0.0h and £0.00 on the row. (Employees never hit this: their clock-in creates
-- a rota_shifts row.)
--
-- Code now creates the cell on clock-in and stamps its hours at clock-out. This
-- backfills days that were clocked BEFORE that change, so existing rows stop
-- reading as zero.
--
-- Safe to re-run: only inserts where no cell exists for that driver + date.
-- =============================================================

insert into public.cover_driver_shifts (
  cover_driver_id,
  store_id,
  shift_date,
  start_time,
  end_time,
  is_day_off,
  scheduled_hours,
  notes
)
select
  ce.cover_driver_id,
  ce.store_id,
  ce.event_date,
  -- Times are stored as timestamptz; the rota holds plain UK wall-clock time.
  (ce.clock_in_at  at time zone 'Europe/London')::time,
  (ce.clock_out_at at time zone 'Europe/London')::time,
  false,
  round(
    (extract(epoch from (ce.clock_out_at - ce.clock_in_at)) / 3600.0)::numeric,
    2
  ),
  'Auto-created from clock-in'
from public.cover_driver_clock_events ce
where ce.clock_in_at is not null
  and ce.clock_out_at is not null
  and ce.clock_out_at > ce.clock_in_at
  and not exists (
    select 1 from public.cover_driver_shifts s
    where s.cover_driver_id = ce.cover_driver_id
      and s.shift_date = ce.event_date
  );
