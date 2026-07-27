-- ============================================================================
-- Daypart heat map feasibility — verification queries
--
-- Run before implementing the Net Sales / AOV heat maps (see
-- docs/DAYPART_HEATMAP_FEASIBILITY.md). All four passed for w/c 2026-07-20;
-- re-run them for any week that looks wrong, and re-run Q4 after every
-- vm_net_sales_by_hour ingest.
--
-- Set the week once:
--   \set week '2026-07-20'
-- or just replace the literal in each query.
-- ============================================================================


-- ── Q1: is the net hourly feed stored per weekday? ─────────────────────────
-- ANSWER (2026-07-27): NO. Columns are id, store, week_start, week_end,
-- source_file, ingested_at, hour, net_sales. week_start/week_end are week
-- bounds, not per-day. Hence the weekday split must be derived, not read.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'vm_net_sales_by_hour'
ORDER BY ordinal_position;


-- ── Q2: is avg_daily_orders an average, or an actual count? ────────────────
-- Sum the hourly grid per weekday and compare to vm_v_daypart_weekday.orders.
-- ANSWER (2026-07-27): ACTUAL COUNTS. Matched exactly on Mon 95 / Tue 90 /
-- Wed 84 for Stevenage. The column name is misleading — it is not an average.
-- This is what makes an exact AOV denominator possible.
WITH grid AS (
  SELECT store, weekday, SUM(avg_daily_orders) AS grid_orders
  FROM vm_hourly_order_activity
  WHERE week_start = '2026-07-20'
  GROUP BY store, weekday
)
SELECT w.store,
       w.weekday,
       g.grid_orders,
       w.orders                          AS daypart_weekday_orders,
       g.grid_orders - w.orders          AS diff
FROM vm_v_daypart_weekday w
JOIN grid g ON g.store = w.store AND g.weekday = w.weekday
WHERE w.week_start = '2026-07-20'
ORDER BY w.store, w.weekday_id;
-- Expect diff = 0 on every row.


-- ── Q3: is vm_v_daypart_weekday.revenue net or gross? ──────────────────────
-- ANSWER (2026-07-27): GROSS.
--   Hitchin    12748.19 vs net 11125.00  → ratio 1.1459
--   Stevenage  19122.24 vs net 16647.63  → ratio 1.1486
-- Matches the ~14.5% gross-to-net markup recorded in Update 28. Therefore the
-- weekday (column) margin is NOT an exact net constraint — see the feasibility
-- doc for why that rules out iterative proportional fitting.
SELECT w.store,
       SUM(w.revenue)                                        AS daypart_weekday_total,
       MAX(e.net_sales::numeric)                             AS exec_net_sales,
       ROUND(SUM(w.revenue) / MAX(e.net_sales::numeric), 4)  AS gross_to_net_ratio
FROM vm_v_daypart_weekday w
JOIN vm_v_exec_dashboard_with_wow e
  ON e.store = w.store AND e.week_start = w.week_start
WHERE w.week_start = '2026-07-20'
GROUP BY w.store;


-- ── Q4: is the vm_net_sales_by_hour backfill complete for this week? ───────
-- This table is the ROW MARGIN of the derived heat map, so a gap here silently
-- under-reports an hour rather than raising an error. Update 28 shipped while
-- the backfill was still running, so always check a new week before trusting it.
-- ANSWER (2026-07-27, w/c 2026-07-20): COMPLETE.
--   Hitchin   11125.0016… vs exec 11125.00   (float noise from the text cast)
--   Stevenage 16647.6349… vs exec 16647.63
SELECT h.store,
       SUM(NULLIF(BTRIM(h.net_sales), '')::numeric)          AS hourly_net_total,
       MAX(e.net_sales::numeric)                             AS exec_net_sales,
       ROUND(
         SUM(NULLIF(BTRIM(h.net_sales), '')::numeric) - MAX(e.net_sales::numeric),
         2
       )                                                     AS diff_rounded
FROM vm_net_sales_by_hour h
JOIN vm_v_exec_dashboard_with_wow e
  ON e.store = h.store AND e.week_start = h.week_start
WHERE h.week_start = '2026-07-20'
GROUP BY h.store;
-- Expect diff_rounded = 0.00. Sub-penny drift is expected (net_sales is TEXT
-- and rounded per hour at source); round at the display boundary.


-- ── Q5: which weeks are missing hourly net data entirely? ──────────────────
-- Quick sweep to find weeks where the heat map would render £0 rows.
SELECT e.week_start,
       e.store,
       COUNT(h.id)               AS hourly_rows,
       MAX(e.net_sales::numeric) AS exec_net_sales
FROM vm_v_exec_dashboard_with_wow e
LEFT JOIN vm_net_sales_by_hour h
  ON h.store = e.store AND h.week_start = e.week_start
GROUP BY e.week_start, e.store
HAVING COUNT(h.id) = 0
ORDER BY e.week_start DESC;
