-- =============================================================
-- Migration 046 — Backfill total_hours_worked at full precision
--
-- Migration 045 widened the column so future rollups don't lose
-- fractional-minute precision, but existing 'clocked' rows already had
-- that precision rounded away when they were written under the old
-- numeric(5,2) column. This re-sums each clocked week's approved daily
-- hours straight from clock_events (the same source and rounding
-- lib/employee-hours-rollup.ts uses: nearest 1/60 hour), so stored weeks
-- match what a fresh rollup would produce today.
--
-- Only 'source = clocked' rows are touched — manual admin corrections
-- ('manual') are left exactly as entered.
-- =============================================================

update public.employee_hours eh
set total_hours_worked = round(
  coalesce((
    select sum(ce.approved_hours)
    from public.clock_events ce
    where ce.employee_id = eh.employee_id
      and ce.approved_hours is not null
      and ce.event_date >= eh.week_start_date
      and ce.event_date <= eh.week_start_date + 6
  ), 0) * 60
) / 60
where eh.source = 'clocked';
