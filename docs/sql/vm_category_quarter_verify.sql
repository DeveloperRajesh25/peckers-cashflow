-- ============================================================================
-- Verification queries for the Product Performance "Quarterly" column
-- (vm_category_quarterly.sql). Ad-hoc, read-only, safe to re-run.
--
-- Both queries read vm_v_product_category_net — the same NET revenue view the
-- app uses (getCategoryItemsNet / vm_mv_category_quarter_net are both built on
-- it), so a manual sum here should match what the dashboard shows.
--
-- Edit the values inside the `params` CTE at the top of each query, then run.
-- week_start / week_end are inclusive and must be Mondays (the grain is
-- Mon-Sun weeks); category / item_name match case-insensitively.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Query 1: weekly revenue for ONE CATEGORY over an adjustable date range
-- (e.g. last 12 weeks), summed across all stores. Swap `category` to check
-- any category name (Wings, Tenders, Burgers, Wraps, Milkshakes, ...).
-- The last row (week_start = NULL) is the range TOTAL — compare that number
-- against the dashboard's Quarterly figure for the same category.
-- ----------------------------------------------------------------------------
with params as (
  select
    'Wings'::text      as category,
    date '2026-05-25'  as week_start,   -- inclusive
    date '2026-08-17'  as week_end      -- inclusive
)
select
  p.week_start,
  p.category,
  sum(p.net_sales)  as net_sales,
  sum(p.units_sold) as units_sold
from vm_v_product_category_net p
join params pr
  on p.category ilike pr.category
 and p.week_start between pr.week_start and pr.week_end
group by grouping sets ((p.week_start, p.category), (p.category))
order by p.week_start nulls last;


-- ----------------------------------------------------------------------------
-- Query 2: weekly revenue for ONE ITEM within ONE CATEGORY, adjustable range.
-- e.g. category = 'Wings', item_name = 'Mango Pineapple Glazed Wings'.
-- Also shows per-store breakdown so a store-level mismatch is easy to spot.
-- Last two rows (week_start = NULL) are per-store and grand TOTAL.
-- ----------------------------------------------------------------------------
with params as (
  select
    'Wings'::text                        as category,
    'Mango Pineapple Glazed Wings'::text as item_name,
    date '2026-05-25'                    as week_start,   -- inclusive
    date '2026-08-17'                    as week_end      -- inclusive
)
select
  p.week_start,
  p.store,
  p.category,
  p.item_name,
  sum(p.net_sales)  as net_sales,
  sum(p.units_sold) as units_sold
from vm_v_product_category_net p
join params pr
  on p.category ilike pr.category
 and p.item_name ilike pr.item_name
 and p.week_start between pr.week_start and pr.week_end
group by grouping sets (
  (p.week_start, p.store, p.category, p.item_name),
  (p.store, p.category, p.item_name),
  (p.category, p.item_name)
)
order by p.week_start nulls last, p.store nulls last;
