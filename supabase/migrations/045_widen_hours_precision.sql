-- =============================================================
-- Migration 045 — Widen employee_hours.total_hours_worked precision
--
-- Bug: total_hours_worked is numeric(5,2) — only 2 decimal places. The
-- weekly rollup (lib/employee-hours-rollup.ts) computes hours rounded to
-- the nearest MINUTE (i.e. a multiple of 1/60 hour, e.g. 43.26667), but
-- writing that into a numeric(5,2) column forces it to round again to the
-- nearest HUNDREDTH (43.27). That second rounding is lossy: 0.27 hours is
-- not the same as 16 minutes (16/60 = 0.26667), so the Weekly Hours Log's
-- Cash £ (driven by this column, via employee_hours_computed) could differ
-- from the Tuesday payout by a few pence — the payout computes cash hours
-- straight from clock events at full 1/60 precision, with no such column
-- to round-trip through.
--
-- Fix: widen the column so a minute-precision value round-trips without
-- further rounding. numeric(7,4) keeps 4 decimal places, far finer than
-- 1/60 (~0.0167), so no future rounding loss for hour figures at this
-- scale. This only INCREASES precision — no existing data can be lost,
-- only a small number of rows gain back the fractional-minute precision
-- they already had in memory before being written.
-- =============================================================

-- employee_hours_computed's SELECT reads total_hours_worked, so Postgres
-- won't widen the column while the view depends on it. Drop and recreate
-- the view (same definition migration 044 left it in) around the alter.
drop view if exists public.employee_hours_computed;

alter table public.employee_hours
  alter column total_hours_worked type numeric(7,4);

-- Re-round any already-stored 2dp values isn't needed/possible retroactively
-- (the sub-hundredth precision was already lost on write) — this only
-- prevents the loss from happening again on future rollups/edits.

create view public.employee_hours_computed with (security_invoker = true) as
select
  eh.id,
  eh.employee_id,
  e.name                                         as employee_name,
  e.phone                                        as employee_phone,
  eh.week_start_date,
  eh.total_hours_worked,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then least(eh.total_hours_worked, coalesce(e.bank_weekly_hours_limit, 20))
    else eh.total_hours_worked
  end                                             as bank_hours,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then greatest(eh.total_hours_worked - coalesce(e.bank_weekly_hours_limit, 20), 0)
    else 0
  end                                             as cash_hours,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then greatest(eh.total_hours_worked - coalesce(e.bank_weekly_hours_limit, 20), 0)
        * e.hourly_cash_rate
    else 0
  end                                             as cash_amount_due,
  eh.hourly_rate_snapshot,
  eh.notes,
  eh.logged_by,
  eh.approved,
  eh.approved_at,
  eh.source,
  eh.created_at
from public.employee_hours eh
join public.employees e on e.id = eh.employee_id;

grant select on public.employee_hours_computed to authenticated;
