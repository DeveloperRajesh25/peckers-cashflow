-- =============================================================
-- 042 — hours are a whole number of MINUTES
--
-- Every screen shows hours as h/m, but hours were stored as numeric(6,2):
-- 0.01h is 36 SECONDS, so a whole minute (0.0166…h) is not representable. Each
-- day therefore carried up to ±18s of buried error. Per day that is invisible —
-- the display rounds back to the nearest minute and hides it — but a WEEK sums
-- seven of those hidden fractions, which is why Daily Approval, the Weekly Log
-- and the Tuesday payout disagreed by a minute or two on the same week.
--
-- numeric(8,4) holds 0.36s, so a minute survives storage intact and a week's
-- accumulated error is ~0.02s. Paired with roundHoursToMinute() in the app,
-- which quantises every hours value to a whole minute before it is written,
-- the three screens now agree exactly rather than approximately.
--
-- Idempotent: the widen is skipped where the scale is already 4, and the views
-- are recreated unconditionally.
--
-- THE VIEW CHAIN. Postgres refuses to alter a column a view depends on, and
-- clock_events.worked_hours carries two levels of them:
--
--     labor_cost_performance  →  employee_weekly_summary  →  clock_events
--
-- Both are dropped in dependency order and recreated VERBATIM from their
-- existing sources — employee_weekly_summary from migration 029 (its latest
-- definition) and labor_cost_performance from labor_cost_performance.sql.
-- Column lists, types, security_invoker settings and grants are unchanged;
-- this migration alters no view's behaviour. Migration 029 avoided the drop by
-- using CREATE OR REPLACE for exactly this reason, but a column TYPE change
-- leaves no such option.
-- =============================================================

-- Dependent first, base second.
drop view if exists public.labor_cost_performance;
drop view if exists public.employee_weekly_summary;

do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('clock_events',           'approved_hours'),
      ('clock_events',           'worked_hours'),
      ('clock_sessions',         'approved_hours'),
      ('manager_clock_events',   'worked_hours'),
      ('manager_clock_sessions', 'approved_hours')
    ) as v(tbl, col)
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name   = c.tbl
        and column_name  = c.col
        and numeric_scale is distinct from 4
    ) then
      execute format(
        'alter table public.%I alter column %I type numeric(8,4)', c.tbl, c.col
      );
    end if;
  end loop;
end $$;

-- ---- employee_weekly_summary, verbatim from migration 029 ----
create or replace view public.employee_weekly_summary with (security_invoker = true) as
with weekly_rota as (
  select
    rs.employee_id,
    date_trunc('week', rs.shift_date)::date as week_start_date,
    sum(case when rs.is_day_off then 0 else rs.scheduled_hours end) as scheduled_hours
  from public.rota_shifts rs
  group by rs.employee_id, date_trunc('week', rs.shift_date)
),
weekly_actual as (
  select
    ce.employee_id,
    date_trunc('week', ce.event_date)::date as week_start_date,
    sum(
      -- Summed sessions when we have them; the raw delta otherwise. On a
      -- single-shift day the two are identical, so history is unaffected.
      coalesce(
        ce.worked_hours,
        case
          when ce.clock_in_at is not null and ce.clock_out_at is not null
          then (extract(epoch from (ce.clock_out_at - ce.clock_in_at)) / 3600.0)::numeric
          else 0
        end
      )
    ) as actual_hours,
    sum(coalesce(ce.short_deliveries_count, 0) + coalesce(ce.long_deliveries_count, 0)) as deliveries_total
  from public.clock_events ce
  group by ce.employee_id, date_trunc('week', ce.event_date)
)
select
  e.id as employee_id,
  e.name as employee_name,
  e.position,
  e.store_id,
  coalesce(wr.week_start_date, wa.week_start_date) as week_start_date,
  coalesce(wr.scheduled_hours, 0) as scheduled_hours,
  coalesce(wa.actual_hours, 0) as actual_hours,
  coalesce(wa.deliveries_total, 0) as deliveries_total,
  e.hourly_ni_rate,
  e.hourly_cash_rate,
  -- Wage split: first 20h = NI (bank), remainder = cash if cash rate set
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0) as scheduled_ni_wages,
  greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0) as scheduled_cash_wages,
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0)
    + greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0)
    as scheduled_total_wages
from public.employees e
left join weekly_rota wr on wr.employee_id = e.id
left join weekly_actual wa on wa.employee_id = e.id
  and wa.week_start_date = wr.week_start_date;

grant select on public.employee_weekly_summary to anon, authenticated, service_role;

-- ---- labor_cost_performance, verbatim from labor_cost_performance.sql ----
CREATE OR REPLACE VIEW public.labor_cost_performance AS
WITH labour_by_week AS (
  -- Aggregate scheduled wages per store per week (sum across all employees)
  SELECT
    ews.store_id,
    ews.week_start_date,
    SUM(ews.scheduled_total_wages) AS labour_cost
  FROM employee_weekly_summary ews
  WHERE ews.week_start_date IS NOT NULL
  GROUP BY ews.store_id, ews.week_start_date
),
revenue_by_week AS (
  -- Aggregate POS sales per store per week (sum across all days)
  SELECT
    dce.store_id,
    DATE_TRUNC('week', dce.entry_date)::date AS week_start_date,
    SUM(dce.vita_mojo_sales) AS revenue
  FROM daily_cash_entries dce
  GROUP BY dce.store_id, DATE_TRUNC('week', dce.entry_date)
)
SELECT
  s.id,
  s.name AS store,
  COALESCE(lbw.week_start_date, rbw.week_start_date) AS week_start_date,
  COALESCE(lbw.labour_cost, 0) AS labour_cost,
  COALESCE(rbw.revenue, 0) AS revenue,
  CASE
    WHEN COALESCE(rbw.revenue, 0) > 0
    THEN ROUND(100 * COALESCE(lbw.labour_cost, 0) / rbw.revenue, 1)
    ELSE 0
  END AS labour_pct
FROM stores s
LEFT JOIN labour_by_week lbw ON lbw.store_id = s.id
LEFT JOIN revenue_by_week rbw
  ON rbw.store_id = s.id
  AND rbw.week_start_date = lbw.week_start_date
WHERE lbw.week_start_date IS NOT NULL
ORDER BY s.name, COALESCE(lbw.week_start_date, rbw.week_start_date) DESC;

GRANT SELECT ON public.labor_cost_performance TO anon, authenticated;
