import {
  getProductsNet,
  getWeeks,
  getCategoryItemsNet,
  getCategoryQuarterNet,
  getNewLaunches,
  getExec,
} from "@/lib/vm-analytics/queries";
import { n, weekRange } from "@/lib/vm-analytics/format";
import { resolveStore, shortStore, isExcludedProduct, isHiddenProduct, normalizeItem } from "@/lib/vm-analytics/constants";
import { Section, ChartCard } from "@/components/vm-analytics/Section";
import {
  CategoryPerformanceTable,
  type CategoryPerf,
  type CategoryItem,
} from "@/components/vm-analytics/CategoryPerformanceTable";
import {
  NewLaunchesTable,
  type NewLaunchDisplayRow,
} from "@/components/vm-analytics/NewLaunchesTable";
import { Commentary } from "@/components/vm-analytics/Commentary";
import { BarChartCard, PieChartCard } from "@/components/vm-analytics/charts/Charts";
import { EmptyWeek, ErrorState, PageTitle } from "@/components/vm-analytics/PageState";
import { buildInsights, type ProductInput } from "@/lib/vm-analytics/insights";
import type {
  ProductRow,
  ProductCategoryRow,
  CategoryQuarterRow,
  NewLaunchRow,
  ExecRow,
} from "@/lib/vm-analytics/types";

export const dynamic = "force-dynamic";

interface AggItem {
  item: string;
  units: number;
  revenue: number;
  revWow: number | null;
  prevRevenue: number;
  prevUnits: number;
}

// Compute WoW from raw gross_sales across both stores so combined-view WoW is
// (totalCurRevenue - totalPrevRevenue) / totalPrevRevenue — never an average of
// two store percentages, which would give a different (and wrong) result.
function aggregate(rows: ProductRow[], prevRows: ProductRow[]): AggItem[] {
  const prevMap = new Map<string, { revenue: number; units: number }>();
  for (const r of prevRows) {
    const key = `${r.store}::${r.item_name}`;
    const cur = prevMap.get(key) ?? { revenue: 0, units: 0 };
    cur.revenue += n(r.gross_sales);
    cur.units += n(r.units_sold);
    prevMap.set(key, cur);
  }

  const map = new Map<string, { item: string; units: number; revenue: number; prevRevenue: number; prevUnits: number }>();
  for (const r of rows) {
    const key = r.item_name;
    const cur = map.get(key) ?? { item: key, units: 0, revenue: 0, prevRevenue: 0, prevUnits: 0 };
    cur.units += n(r.units_sold);
    cur.revenue += n(r.gross_sales);
    const prev = prevMap.get(`${r.store}::${r.item_name}`);
    if (prev) {
      cur.prevRevenue += prev.revenue;
      cur.prevUnits += prev.units;
    }
    map.set(key, cur);
  }

  return Array.from(map.values())
    .filter((c) => !isExcludedProduct(c.item) && !isHiddenProduct(c.item))
    .map((c) => ({
      item: c.item,
      units: c.units,
      revenue: c.revenue,
      prevRevenue: c.prevRevenue,
      prevUnits: c.prevUnits,
      revWow: c.prevRevenue > 0 ? (c.revenue - c.prevRevenue) / c.prevRevenue * 100 : null,
    }))
    // Rank by UNITS sold (volume). Prices change week to week, so units are the
    // more stable measure of what's actually popular.
    .sort((a, b) => b.units - a.units);
}

// New Launches: one row per curated launch (display_name), rolling up every raw
// item_name variant that maps to it. Matching is by normalizeItem so casing /
// spacing / punctuation variants collapse automatically. WoW is summed cur-vs-
// prev across the scoped rows (never averaged), same principle as aggregate().
// Only launches with at least one unit sold in the selected week are returned.
// Rows arrive already scoped to the active store.
function aggregateNewLaunches(
  rows: ProductRow[],
  prevRows: ProductRow[],
  launches: NewLaunchRow[],
): NewLaunchDisplayRow[] {
  const byNorm = new Map<string, string>();
  for (const l of launches) byNorm.set(normalizeItem(l.item_name), l.display_name);

  const cur = new Map<string, { units: number; revenue: number }>();
  const prev = new Map<string, { revenue: number }>();
  for (const r of rows) {
    const display = byNorm.get(normalizeItem(r.item_name));
    if (!display) continue;
    const c = cur.get(display) ?? { units: 0, revenue: 0 };
    c.units += n(r.units_sold);
    c.revenue += n(r.gross_sales);
    cur.set(display, c);
  }
  for (const r of prevRows) {
    const display = byNorm.get(normalizeItem(r.item_name));
    if (!display) continue;
    const p = prev.get(display) ?? { revenue: 0 };
    p.revenue += n(r.gross_sales);
    prev.set(display, p);
  }

  return Array.from(cur.entries())
    .filter(([, c]) => c.units > 0)
    .map(([display, c]) => {
      const prevRevenue = prev.get(display)?.revenue ?? 0;
      return {
        item: display,
        units: c.units,
        revenue: c.revenue,
        revWow: prevRevenue > 0 ? ((c.revenue - prevRevenue) / prevRevenue) * 100 : null,
      };
    })
    .sort((a, b) => b.units - a.units);
}

// The quarter length is defined in SQL (vm_quarter_weeks()), never here — the
// rows carry their own window bounds and week counts. The % is shown only when
// the prior window holds as many weeks of data as the current one, for every
// store in scope: a full quarter measured against a part-loaded one reports a
// collapse that never happened.
function quarterComparableFrom(rows: CategoryQuarterRow[]): boolean {
  return rows.length > 0 && rows.every((r) => n(r.q_weeks) > 0 && n(r.prev_weeks) === n(r.q_weeks));
}

// Fold "Churros" into "Desserts" so the two aggregate into one row. Applied to
// every map key in aggregateCategories; all other categories pass through.
const canonicalCategory = (name: string): string =>
  name.toLowerCase() === "churros" ? "Desserts" : name;

// Category-level totals with an item drill-down for the selected scope. WoW is
// recomputed from summed totals (never averaged across stores) so the combined
// view is correct — same principle as aggregate() above. Totals are summed from
// the item rows so category totals always equal the sum of the visible items.
// EXCLUDED_PRODUCTS (drinks, sides) deliberately stay in; only HIDDEN_PRODUCTS
// are dropped, so they leave both the totals and the drill-down together.
// quarterRows carry the trailing 16-week totals; they are folded and filtered by
// the same rules as the weekly figures so the two columns can be read together.
function aggregateCategories(
  itemRows: ProductCategoryRow[],
  itemPrevRows: ProductCategoryRow[],
  allItemRows: ProductCategoryRow[],
  allItemPrevRows: ProductCategoryRow[],
  quarterRows: CategoryQuarterRow[],
  quarterComparable: boolean,
): CategoryPerf[] {
  const wow = (cur: number, prev: number) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
  // The base is surfaced next to the % in the table, and is null on exactly the
  // same condition the % is, so the two can never disagree.
  const prevOf = (prev: number) => (prev > 0 ? prev : null);

  const visibleItems = itemRows.filter((r) => !isHiddenProduct(r.item_name));
  const visiblePrevItems = itemPrevRows.filter((r) => !isHiddenProduct(r.item_name));

  const sumBy = <T,>(list: T[], key: (r: T) => string, rev: (r: T) => number, units: (r: T) => number) => {
    const m = new Map<string, { revenue: number; units: number }>();
    for (const r of list) {
      const c = m.get(key(r)) ?? { revenue: 0, units: 0 };
      c.revenue += rev(r);
      c.units += units(r);
      m.set(key(r), c);
    }
    return m;
  };

  // Per-store WoW always comes from the full store-tagged rows (never the active-
  // store-scoped rows), so the Hitchin/Stevenage columns stay populated for both
  // stores in combined view. Same category folding / hidden-product filtering as
  // the combined figures, and summed cur-vs-prev revenue — never averaged.
  const storeWow = (store: string) => {
    const cur = allItemRows.filter((r) => r.store === store && !isHiddenProduct(r.item_name));
    const prev = allItemPrevRows.filter((r) => r.store === store && !isHiddenProduct(r.item_name));
    const catKey = (r: ProductCategoryRow) => canonicalCategory(r.category);
    const itemKey = (r: ProductCategoryRow) => `${canonicalCategory(r.category)}::${r.item_name}`;
    const curCatS = sumBy(cur, catKey, (r) => n(r.gross_sales), (r) => n(r.units_sold));
    const prevCatS = sumBy(prev, catKey, (r) => n(r.gross_sales), (r) => n(r.units_sold));
    const curItemS = sumBy(cur, itemKey, (r) => n(r.gross_sales), (r) => n(r.units_sold));
    const prevItemS = sumBy(prev, itemKey, (r) => n(r.gross_sales), (r) => n(r.units_sold));
    return {
      cat: (category: string) => {
        const prev = prevCatS.get(category)?.revenue ?? 0;
        return { pct: wow(curCatS.get(category)?.revenue ?? 0, prev), prev: prevOf(prev) };
      },
      item: (key: string) => {
        const prev = prevItemS.get(key)?.revenue ?? 0;
        return { pct: wow(curItemS.get(key)?.revenue ?? 0, prev), prev: prevOf(prev) };
      },
    };
  };
  const hitchin = storeWow("Peckers Hitchin");
  const stevenage = storeWow("Peckers Stevenage");

  // A category's quarterly revenue is what the CATEGORY took over 16 weeks, so it
  // includes items that sold during the window but not in the anchor week. Those
  // items have no drill-down line, which is why the item rows need not sum to the
  // category total the way the weekly ones do.
  const visibleQuarter = quarterRows.filter((r) => !isHiddenProduct(r.item_name));
  const sumQuarter = (key: (r: CategoryQuarterRow) => string) => {
    const m = new Map<string, { cur: number; prev: number }>();
    for (const r of visibleQuarter) {
      const k = key(r);
      const c = m.get(k) ?? { cur: 0, prev: 0 };
      c.cur += n(r.q_net_sales);
      c.prev += n(r.prev_q_net_sales);
      m.set(k, c);
    }
    return m;
  };
  const qCat = sumQuarter((r) => canonicalCategory(r.category));
  const qItem = sumQuarter((r) => `${canonicalCategory(r.category)}::${r.item_name}`);
  const quarterOf = (m: Map<string, { cur: number; prev: number }>, key: string) => {
    const q = m.get(key) ?? { cur: 0, prev: 0 };
    return { qRevenue: q.cur, qPct: quarterComparable ? wow(q.cur, q.prev) : null };
  };

  const curCat = sumBy(visibleItems, (r) => canonicalCategory(r.category), (r) => n(r.gross_sales), (r) => n(r.units_sold));
  const prevCat = sumBy(visiblePrevItems, (r) => canonicalCategory(r.category), (r) => n(r.gross_sales), (r) => n(r.units_sold));
  const prevItem = sumBy(visiblePrevItems, (r) => `${canonicalCategory(r.category)}::${r.item_name}`, (r) => n(r.gross_sales), (r) => n(r.units_sold));

  const curItems = new Map<string, Map<string, { units: number; revenue: number }>>();
  for (const r of visibleItems) {
    const category = canonicalCategory(r.category);
    let byItem = curItems.get(category);
    if (!byItem) {
      byItem = new Map();
      curItems.set(category, byItem);
    }
    const c = byItem.get(r.item_name) ?? { units: 0, revenue: 0 };
    c.units += n(r.units_sold);
    c.revenue += n(r.gross_sales);
    byItem.set(r.item_name, c);
  }

  const cats: CategoryPerf[] = Array.from(curCat.entries()).map(([category, tot]) => {
    const byItem = curItems.get(category) ?? new Map<string, { units: number; revenue: number }>();
    const items: CategoryItem[] = Array.from(byItem.entries())
      .map(([item, it]) => {
        const key = `${category}::${item}`;
        const prev = prevItem.get(key)?.revenue ?? 0;
        const hi = hitchin.item(key);
        const st = stevenage.item(key);
        return {
          item,
          units: it.units,
          revenue: it.revenue,
          revWow: wow(it.revenue, prev),
          revPrev: prevOf(prev),
          hitchinWow: hi.pct,
          hitchinPrev: hi.prev,
          stevenageWow: st.pct,
          stevenagePrev: st.prev,
          ...quarterOf(qItem, key),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
    const prevRev = prevCat.get(category)?.revenue ?? 0;
    const hiCat = hitchin.cat(category);
    const stCat = stevenage.cat(category);
    return {
      category,
      units: tot.units,
      revenue: tot.revenue,
      revWow: wow(tot.revenue, prevRev),
      revPrev: prevOf(prevRev),
      hitchinWow: hiCat.pct,
      hitchinPrev: hiCat.prev,
      stevenageWow: stCat.pct,
      stevenagePrev: stCat.prev,
      ...quarterOf(qCat, category),
      items,
    };
  });

  // Drop the Uncategorised data-quality bucket entirely, then revenue desc.
  return cats
    .filter((c) => c.category !== "Uncategorised")
    .sort((a, b) => b.revenue - a.revenue);
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { week?: string; store?: string };
}) {
  const activeStore = resolveStore(searchParams.store);
  const scopeLabel = activeStore ? shortStore(activeStore) : "both stores combined";

  let weekIso: string | null;
  let rows: ProductRow[];
  let prevRows: ProductRow[] = [];
  let itemRows: ProductCategoryRow[] = [];
  let itemPrevRows: ProductCategoryRow[] = [];
  let quarterRows: CategoryQuarterRow[] = [];
  let newLaunches: NewLaunchRow[] = [];
  let execRows: ExecRow[] = [];
  let weekEnd = "";
  try {
    const weeks = await getWeeks();
    weekIso = searchParams.week ?? weeks[0]?.week_start_iso ?? null;
    if (!weekIso) return <EmptyWeek />;
    weekEnd = weeks.find((w) => w.week_start_iso === weekIso)?.week_end ?? "";
    const idx = weeks.findIndex((w) => w.week_start_iso === weekIso);
    const prevWeekIso = idx >= 0 ? weeks[idx + 1]?.week_start_iso ?? null : null;
    [rows, prevRows, itemRows, itemPrevRows, quarterRows, newLaunches, execRows] = await Promise.all([
      getProductsNet(weekIso),
      prevWeekIso ? getProductsNet(prevWeekIso) : Promise.resolve<ProductRow[]>([]),
      getCategoryItemsNet(weekIso),
      prevWeekIso ? getCategoryItemsNet(prevWeekIso) : Promise.resolve<ProductCategoryRow[]>([]),
      getCategoryQuarterNet(weekIso),
      getNewLaunches(),
      getExec(weekIso),
    ]);
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : "Unknown error"} />;
  }

  // Keep the full store-tagged category rows before scoping so the per-store
  // Hitchin/Stevenage WoW columns stay populated regardless of the active filter.
  const allItemRows = itemRows;
  const allItemPrevRows = itemPrevRows;

  // Scope to the selected store (or keep both when "All Stores" is chosen).
  if (activeStore) {
    rows = rows.filter((r) => r.store === activeStore);
    prevRows = prevRows.filter((r) => r.store === activeStore);
    itemRows = itemRows.filter((r) => r.store === activeStore);
    itemPrevRows = itemPrevRows.filter((r) => r.store === activeStore);
    quarterRows = quarterRows.filter((r) => r.store === activeStore);
  }

  // Denominator for Category Revenue Share = Executive dashboard total net sales
  // for the same week, scoped to the active store (summed across both when
  // combined). Sourced from getExec so % of category = category net sales /
  // total net sales; slices intentionally need not sum to 100%.
  const scopedExec = activeStore ? execRows.filter((r) => r.store === activeStore) : execRows;
  const totalNetSales = scopedExec.reduce((s, r) => s + n(r.net_sales), 0);

  if (rows.length === 0) {
    return (
      <>
        <PageTitle title="Product Performance" />
        <EmptyWeek />
      </>
    );
  }

  const quarterComparable = quarterComparableFrom(quarterRows);
  const items = aggregate(rows, prevRows);
  const newLaunchRows = aggregateNewLaunches(rows, prevRows, newLaunches);
  const categoryPerf = aggregateCategories(
    itemRows,
    itemPrevRows,
    allItemRows,
    allItemPrevRows,
    quarterRows,
    quarterComparable,
  );
  const showQuarter = quarterRows.length > 0;
  const quarterStartIso = quarterRows[0]?.q_from ?? null;
  const top = items.slice(0, 5);

  // Category commentary. Add-on categories (Fries, Drinks, etc.) stay in — they
  // are real volume. Only the "Uncategorised" data-quality bucket is excluded.
  const catsForInsight = categoryPerf.filter((c) => c.category !== "Uncategorised");
  const risingCats = [...catsForInsight]
    .filter((c) => c.revWow !== null && c.revWow > 0)
    .sort((a, b) => b.revWow! - a.revWow!)
    .slice(0, 3);
  const fallingCats = [...catsForInsight]
    .filter((c) => c.revWow !== null && c.revWow < 0)
    .sort((a, b) => a.revWow! - b.revWow!)
    .slice(0, 3);

  // revWow = (cur - prev) / prev, so prev = cur / (1 + revWow/100) — exact.
  const prevRevOf = (revenue: number, revWow: number) =>
    revWow !== 0 ? revenue / (1 + revWow / 100) : undefined;

  const topChart = top.map((t) => ({ item: t.item, Units: Math.round(t.units) }));

  // Category revenue-share donut: top 7 categories by revenue, remainder bundled
  // into "Other" so the donut stays legible. Add-on categories are kept in.
  const catShareSorted = [...categoryPerf].sort((a, b) => b.revenue - a.revenue);
  const catShareData = catShareSorted.slice(0, 7).map((c) => ({
    category: c.category,
    revenue: c.revenue,
  }));
  const otherRev = catShareSorted.slice(7).reduce((s, c) => s + c.revenue, 0);
  if (otherRev > 0) catShareData.push({ category: "Other", revenue: otherRev });

  const insightInput: ProductInput = {
    dashboard: "products",
    week: weekIso,
    store: activeStore,
    top: top.map((t) => ({
      item: t.item,
      units: t.units,
      revenue: t.revenue,
      revWow: t.revWow,
      prevRevenue: t.prevRevenue > 0 ? t.prevRevenue : undefined,
      prevUnits: t.prevUnits > 0 ? t.prevUnits : undefined,
    })),
    categories: catsForInsight.map((c) => ({
      category: c.category,
      units: c.units,
      revenue: c.revenue,
      revWow: c.revWow,
    })),
    risingCats: risingCats.map((c) => ({
      category: c.category,
      revenue: c.revenue,
      revWow: c.revWow!,
      prevRevenue: prevRevOf(c.revenue, c.revWow!),
    })),
    fallingCats: fallingCats.map((c) => ({
      category: c.category,
      revenue: c.revenue,
      revWow: c.revWow!,
      prevRevenue: prevRevOf(c.revenue, c.revWow!),
    })),
    totalNetSales,
  };
  const draft = buildInsights(insightInput);

  return (
    <div className="space-y-7">
      <PageTitle
        title="Product Performance"
        subtitle={`Most & least sellers · net sales (${scopeLabel}) · ${weekRange(weekIso, weekEnd)}`}
      />

      <Commentary initial={draft} input={insightInput} />

      {newLaunches.length > 0 && (
        <Section
          title="New Launches"
          description="Recently launched items and how they're selling this week. Add or retire items in the vm_new_launches table."
        >
          <NewLaunchesTable rows={newLaunchRows} />
        </Section>
      )}

      <Section
        title="Category Performance"
        description={
          showQuarter
            ? `Units, net revenue and week-on-week per menu category. Quarterly Revenue is the ${n(
                quarterRows[0]?.q_weeks,
              )} weeks to ${weekRange(quarterStartIso, weekEnd)}${
                quarterComparable
                  ? `, with the change vs the ${n(quarterRows[0]?.q_weeks)} weeks before it`
                  : " — the % is withheld until an equally long earlier period exists to compare against"
              }. Click a category to see its items.`
            : "Units, net revenue and week-on-week per menu category. Click a category to see its items."
        }
      >
        <CategoryPerformanceTable
          rows={categoryPerf}
          showStoreWow={!activeStore}
          showQuarter={showQuarter}
        />
      </Section>

      <Section
        title="Category Revenue Share"
        description="% of category = net sales of category / total net sales"
      >
        <ChartCard title="Share of weekly revenue by category">
          <PieChartCard
            data={catShareData}
            nameKey="category"
            valueKey="revenue"
            height={340}
            showPercent
            percentTotal={totalNetSales}
          />
        </ChartCard>
      </Section>

      <Section title="Volume Leaders">
        <ChartCard title="Top 5 products by units sold">
          <BarChartCard
            data={topChart}
            xKey="item"
            bars={[{ key: "Units", name: "Units" }]}
            height={320}
          />
        </ChartCard>
      </Section>
    </div>
  );
}
