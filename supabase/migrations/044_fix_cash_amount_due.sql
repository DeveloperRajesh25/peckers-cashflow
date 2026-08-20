-- =============================================================
-- Migration 044 — Fix cash_amount_due in employee_hours_computed
--
-- Bug: cash_amount_due was computed as
--   (total_hours_worked - 20) * hourly_rate_snapshot
-- where hourly_rate_snapshot is the employee's NI/PAYE rate — not their
-- cash rate. This made the Weekly Hours Log's "Cash £" column disagree
-- with the Tuesday payout, which correctly pays cash hours at the
-- employee's hourly_cash_rate (see lib/cash-flow.ts).
--
-- Fix: use the employee's own bank_weekly_hours_limit (not a hard-coded
-- 20) and hourly_cash_rate, matching the same "works for cash" rule used
-- by lib/cash-flow.ts's worksForCash(): if the employee has no positive
-- hourly_cash_rate, all their hours are bank hours and cash is 0.
-- =============================================================

drop view if exists public.employee_hours_computed;
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
