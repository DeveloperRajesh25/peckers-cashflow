-- =============================================================
-- Migration 050 — Weekly Report labour: no flat-amount column
--
-- RUN THIS **AFTER** DEPLOYING THE CODE THAT STOPS SELECTING `fixed_pay`.
-- It drops a column the previously deployed build reads in LABOUR_COLUMNS, and
-- a dropped column breaks that build the moment this runs — the exact ordering
-- trap migration 027 nearly fell into (see Update 65).
--
-- WHY
-- The workbook's Labour Cost sheet has an "Hours worked" column and NO fixed-pay
-- column: K20 is NI total + cash total + delivery pay. `fixed_pay` was added in
-- 048 to carry a manager's fixed daily wage, which no hour x rate pair could
-- express — but it does not have to be expressed that way. A manager's wage is
-- now carried as their EFFECTIVE hourly rate over the hours they clocked:
--
--   ni_hours = hours worked      ni_rate = (days x fixed_daily_wage) / hours
--
-- Identical money, and the Hours worked column reads true instead of showing
-- blank for every manager.
--
-- The rate columns widen to 4dp because that rate is a DIVISION. At 2dp a
-- 43.25-hour week against a £500 wage lands ~30p off the wage it came from,
-- every week, in the P&L's labour line.
--
-- The backfill moves any fixed_pay already recorded into the NI pair before the
-- column goes, so no draft report silently loses a manager's wage. Locked
-- reports are untouched: their figures live in `weekly_reports.snapshot` as
-- JSON, frozen, and are never recomputed from these rows.
--
-- Idempotent: the whole body is guarded on the column still existing.
-- =============================================================

alter table public.weekly_report_labour_lines
  alter column ni_rate   type numeric(10,4),
  alter column cash_rate type numeric(10,4);

comment on column public.weekly_report_labour_lines.ni_rate is
  'Hourly rate on the NI/bank half. 4dp: a manager''s is their fixed daily wage divided by the hours they clocked, and 2dp of that drifts against the wage it came from.';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'weekly_report_labour_lines'
      and column_name = 'fixed_pay'
  ) then
    -- A manager's week: the wage becomes an effective rate over hours clocked.
    update public.weekly_report_labour_lines
       set ni_hours = hours,
           ni_rate  = round(fixed_pay / hours, 4)
     where coalesce(fixed_pay, 0) <> 0
       and coalesce(hours, 0) > 0
       and coalesce(ni_hours, 0) = 0
       and coalesce(cash_hours, 0) = 0;

    -- The legacy single-figure import, which never had hours behind it.
    update public.weekly_report_labour_lines
       set hours    = 1,
           ni_hours = 1,
           ni_rate  = fixed_pay
     where coalesce(fixed_pay, 0) <> 0
       and coalesce(hours, 0) = 0
       and coalesce(ni_hours, 0) = 0
       and coalesce(cash_hours, 0) = 0;

    alter table public.weekly_report_labour_lines drop column fixed_pay;
  end if;
end $$;
