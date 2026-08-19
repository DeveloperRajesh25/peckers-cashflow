-- ============================================================================
-- Category Performance — QUARTERLY (trailing N-week) net revenue
-- Run in the VM Supabase project, AFTER vm_product_net.sql.
--
--   vm_quarter_weeks()             : the window length, in weeks. ONE place.
--   vm_mv_category_quarter_net     : anchor_week x store x category x item, with
--                                    the trailing N-week NET revenue and the N
--                                    weeks immediately before it.
--   vm_refresh_category_quarter_net() : refresh helper, run after each weekly sync.
--
-- Windows, for an anchor week starting Monday A (weeks are Mon-Sun throughout):
--   current  N weeks : week_start in [A - (N-1)*7, A]
--   previous N weeks : week_start in [A - (2N-1)*7, A - N*7]
-- A - N*7 and A - (N-1)*7 are consecutive Mondays, so the two windows are
-- adjacent with no overlap and no gap.
--
-- MATERIALIZED, not a plain view. The plain-view version timed out: PostgREST's
-- anchor_week filter cannot be pushed through the aggregation, so every request
-- rebuilt the whole vm_v_product_net chain (~1.5s) across all anchor weeks and
-- blew the 3s statement timeout. Precomputing moves that cost to refresh time.
--
-- Grain is per ITEM (not per category) so the app can apply the same hidden-
-- product filtering and Churros->Desserts folding it already applies to the
-- weekly figures — the quarterly column must be built from the same population
-- as the Revenue column beside it, or the two would disagree.
--
-- Items that sold during a window but not in the anchor week still get a row.
-- They have no drill-down line in the UI, but their revenue belongs in the
-- category's N-week total: a category's quarterly revenue is what the category
-- took over N weeks, not what this week's surviving items took.
--
-- Re-runnable: drops and recreates.
-- ============================================================================

-- The ONLY place the window length is defined. Change the number here and run
-- `select vm_refresh_category_quarter_net();` — nothing in the app needs editing,
-- because the window bounds and week counts are carried on the rows themselves.
--
-- 12, matching the Executive dashboard's 12-week mode so both dashboards mean the
-- same thing by "quarter". It is also the longest window with a like-for-like
-- prior period today: product history starts 2026-03-02, and 12 + 12 = the 24
-- weeks available. A 16-week quarter would leave the prior window 8/16 loaded,
-- and the app would withhold the % until roughly 2026-10-05.
create or replace function vm_quarter_weeks()
returns int
language sql
immutable
as $$ select 12 $$;

-- The plain view this replaces (superseded — see the MATERIALIZED note above).
drop view if exists vm_v_category_quarter_net;
drop materialized view if exists vm_mv_category_quarter_net;

create materialized view vm_mv_category_quarter_net as
with base as materialized (
  select store,
         week_start::date as w,
         item_name,
         category,
         coalesce(net_sales, 0) as net_sales
  from vm_v_product_category_net
),
anchors as (
  select distinct w as anchor_week from base
),
bounds as (
  select a.anchor_week,
         a.anchor_week - (vm_quarter_weeks() - 1) * 7 as q_from,
         a.anchor_week                                as q_to,
         a.anchor_week - (vm_quarter_weeks() * 2 - 1) * 7 as prev_from,
         a.anchor_week - vm_quarter_weeks() * 7           as prev_to
  from anchors a
),
-- How many weeks of data each window actually holds, per store. The app gates
-- the % on these: a full window measured against a part-loaded one reports a
-- collapse that never happened.
coverage as (
  select d.anchor_week, b.store,
         count(distinct b.w) filter (where b.w >= d.q_from)                      as q_weeks,
         count(distinct b.w) filter (where b.w between d.prev_from and d.prev_to) as prev_weeks
  from bounds d
  join base b on b.w between d.prev_from and d.q_to
  group by d.anchor_week, b.store
)
select d.anchor_week,
       b.store,
       b.category,
       b.item_name,
       d.q_from,
       d.q_to,
       d.prev_from,
       d.prev_to,
       c.q_weeks,
       c.prev_weeks,
       coalesce(sum(b.net_sales) filter (where b.w >= d.q_from), 0) as q_net_sales,
       coalesce(sum(b.net_sales) filter (where b.w <= d.prev_to), 0) as prev_q_net_sales
from bounds d
join base b on b.w between d.prev_from and d.q_to
join coverage c on c.anchor_week = d.anchor_week and c.store = b.store
group by d.anchor_week, b.store, b.category, b.item_name,
         d.q_from, d.q_to, d.prev_from, d.prev_to, c.q_weeks, c.prev_weeks;

-- Unique index is required for REFRESH ... CONCURRENTLY; the anchor_week index
-- serves the app's only access pattern.
create unique index if not exists vm_mv_category_quarter_net_pk
  on vm_mv_category_quarter_net (anchor_week, store, category, item_name);
create index if not exists vm_mv_category_quarter_net_anchor
  on vm_mv_category_quarter_net (anchor_week);

grant select on vm_mv_category_quarter_net to anon, authenticated;

-- Run after each weekly product sync. Until it runs, the newest week simply has
-- no rows here and the app hides the Quarterly column for that week — a missing
-- column is visible; silently stale figures would not be.
create or replace function vm_refresh_category_quarter_net()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently vm_mv_category_quarter_net;
end;
$$;
