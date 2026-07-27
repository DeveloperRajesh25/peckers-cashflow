import {
  getDaypartChannels,
  getDaypartChannelDetail,
  getHourlyActivity,
  getHourlyNetActivity,
  getWeeks,
} from "@/lib/vm-analytics/queries";
import { n, gbp, int, weekRange } from "@/lib/vm-analytics/format";
import { shortStore, resolveStore } from "@/lib/vm-analytics/constants";
import { Section } from "@/components/vm-analytics/Section";
import { DataTable, type Column } from "@/components/vm-analytics/DataTable";
import { Commentary } from "@/components/vm-analytics/Commentary";
import { HourDayHeatmap, type HeatmapData } from "@/components/vm-analytics/HourDayHeatmap";
import { EmptyWeek, ErrorState, PageTitle } from "@/components/vm-analytics/PageState";
import { buildInsights, type DaypartInput } from "@/lib/vm-analytics/insights";
import type {
  DaypartChannelRow,
  DaypartChannelDetailRow,
  HourlyActivityRow,
  HourlyNetActivityRow,
} from "@/lib/vm-analytics/types";

export const dynamic = "force-dynamic";

// Morning (5-11am) is dropped: both stores open after that (Hitchin 12:00,
// Stevenage 11:30), so any orders in that bucket are pre-opening noise. When the
// finer detail view is used the SQL already filters pre-open orders, but we
// still drop rank 1 here so the column is gone even on the fallback path.
const MORNING_RANK = 1;

interface DaypartAgg {
  daypart: string;
  rank: number;
  orders: number;
  revenue: number;
  aov: number;
  deliveryOrders: number;
  deliveryRevenue: number;
  inStoreOrders: number;
  inStoreRevenue: number;
  deliveryAov: number;
  inStoreAov: number;
  // Finer cuts (null when only the Delivery/In-store fallback view is available).
  ownOrders: number | null;
  ownRevenue: number | null;
  ownAov: number | null;
  aggOrders: number | null;
  aggRevenue: number | null;
  aggAov: number | null;
}

const isAggregate = (ch: string) => /deliveroo|uber|just\s*eat/i.test(ch);
const isOwn = (ch: string) => /own|direct/i.test(ch);

const aov = (rev: number, ord: number) => (ord > 0 ? rev / ord : 0);

// Build the period rows from the finer detail view (preferred).
function fromDetail(rows: DaypartChannelDetailRow[]): DaypartAgg[] {
  const m = new Map<string, DaypartAgg>();
  for (const r of rows) {
    if (r.daypart_rank === MORNING_RANK) continue;
    const cur =
      m.get(r.daypart) ??
      ({
        daypart: r.daypart,
        rank: r.daypart_rank,
        orders: 0,
        revenue: 0,
        aov: 0,
        deliveryOrders: 0,
        deliveryRevenue: 0,
        inStoreOrders: 0,
        inStoreRevenue: 0,
        deliveryAov: 0,
        inStoreAov: 0,
        ownOrders: 0,
        ownRevenue: 0,
        ownAov: 0,
        aggOrders: 0,
        aggRevenue: 0,
        aggAov: 0,
      } as DaypartAgg);
    const orders = n(r.orders);
    const revenue = n(r.net_sales);
    cur.orders += orders;
    cur.revenue += revenue;
    if (r.channel_group === "delivery") {
      cur.deliveryOrders += orders;
      cur.deliveryRevenue += revenue;
    } else {
      cur.inStoreOrders += orders;
      cur.inStoreRevenue += revenue;
    }
    if (isOwn(r.channel_name)) {
      cur.ownOrders! += orders;
      cur.ownRevenue! += revenue;
    } else if (isAggregate(r.channel_name)) {
      cur.aggOrders! += orders;
      cur.aggRevenue! += revenue;
    }
    m.set(r.daypart, cur);
  }
  return finalise(Array.from(m.values()), true);
}

// Fallback: only the Delivery/In-store split is available — finer cuts stay null.
function fromBasic(rows: DaypartChannelRow[]): DaypartAgg[] {
  const m = new Map<string, DaypartAgg>();
  for (const c of rows) {
    if (c.daypart_rank === MORNING_RANK) continue;
    const cur =
      m.get(c.daypart) ??
      ({
        daypart: c.daypart,
        rank: c.daypart_rank,
        orders: 0,
        revenue: 0,
        aov: 0,
        deliveryOrders: 0,
        deliveryRevenue: 0,
        inStoreOrders: 0,
        inStoreRevenue: 0,
        deliveryAov: 0,
        inStoreAov: 0,
        ownOrders: null,
        ownRevenue: null,
        ownAov: null,
        aggOrders: null,
        aggRevenue: null,
        aggAov: null,
      } as DaypartAgg);
    const orders = n(c.orders);
    const revenue = n(c.net_sales);
    cur.orders += orders;
    cur.revenue += revenue;
    if (c.channel === "Delivery") {
      cur.deliveryOrders += orders;
      cur.deliveryRevenue += revenue;
    } else if (c.channel === "In-store") {
      cur.inStoreOrders += orders;
      cur.inStoreRevenue += revenue;
    }
    m.set(c.daypart, cur);
  }
  return finalise(Array.from(m.values()), false);
}

function finalise(list: DaypartAgg[], detailed: boolean): DaypartAgg[] {
  return list
    .map((p) => ({
      ...p,
      aov: aov(p.revenue, p.orders),
      deliveryAov: aov(p.deliveryRevenue, p.deliveryOrders),
      inStoreAov: aov(p.inStoreRevenue, p.inStoreOrders),
      ownAov: detailed ? aov(p.ownRevenue ?? 0, p.ownOrders ?? 0) : null,
      aggAov: detailed ? aov(p.aggRevenue ?? 0, p.aggOrders ?? 0) : null,
    }))
    .sort((a, b) => a.rank - b.rank);
}

// One row per trading hour, rolled up across the scoped store(s). Revenue is
// NET (vm_net_sales_by_hour) and orders come from vm_hourly_order_activity, both
// pre-joined per (store, week, hour) by the vm_v_hourly_net_activity view.
interface HourAgg {
  hour: number;
  orders: number;
  revenue: number;
  aov: number;
}

function aggregateNetHours(rows: HourlyNetActivityRow[]): HourAgg[] {
  const m = new Map<number, HourAgg>();
  for (const r of rows) {
    const hour = Math.trunc(n(r.hour));
    const cur = m.get(hour) ?? { hour, orders: 0, revenue: 0, aov: 0 };
    cur.orders += n(r.orders);
    cur.revenue += n(r.net_sales);
    m.set(hour, cur);
  }
  return Array.from(m.values())
    .map((h) => ({ ...h, aov: aov(h.revenue, h.orders) }))
    .sort((a, b) => a.hour - b.hour);
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const dayIndex = (wd: string) => {
  const p = wd.trim().slice(0, 3).toLowerCase();
  return WEEKDAYS.findIndex((d) => d.toLowerCase().startsWith(p));
};

const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);

// Totals derived by summing the grid. Valid for counts and money only — a ratio
// like AOV cannot be totalled this way (see the note above buildNetHeatmap).
function withTotals(hours: number[], cells: number[][]): HeatmapData {
  const rowTotals = cells.map(sum);
  const colTotals = WEEKDAYS.map((_, di) => cells.reduce((s, row) => s + row[di], 0));
  return {
    hours,
    days: [...WEEKDAYS],
    cells,
    rowTotals,
    colTotals,
    grandTotal: sum(rowTotals),
  };
}

// Both hour × weekday matrices in one pass over vm_hourly_order_activity.
// `orders` (avg_daily_orders) is despite its name an ACTUAL order count — it
// sums exactly to vm_v_daypart_weekday.orders per weekday, so it is safe as an
// AOV denominator. `gross` (avg_daily_sales) is GROSS revenue and is used only
// as the SHAPE for splitting net across weekdays, never displayed.
interface HourGrids {
  hours: number[];
  orders: Map<number, number[]>;
  gross: Map<number, number[]>;
}

function buildHourGrids(rows: HourlyActivityRow[]): HourGrids {
  const orders = new Map<number, number[]>();
  const gross = new Map<number, number[]>();
  for (const r of rows) {
    const di = dayIndex(String(r.weekday));
    if (di < 0) continue;
    const hour = Math.trunc(n(r.order_hour));
    const o = orders.get(hour) ?? new Array(7).fill(0);
    o[di] += n(r.avg_daily_orders);
    orders.set(hour, o);
    const g = gross.get(hour) ?? new Array(7).fill(0);
    g[di] += n(r.avg_daily_sales);
    gross.set(hour, g);
  }
  return { hours: Array.from(orders.keys()).sort((a, b) => a - b), orders, gross };
}

function buildOrderHeatmap(grids: HourGrids): HeatmapData {
  return withTotals(
    grids.hours,
    grids.hours.map((h) => grids.orders.get(h)!.map((v) => Math.round(v)))
  );
}

// Net sales per hour is known exactly (vm_net_sales_by_hour) but carries no
// weekday dimension, so each hour's net total is split across the week in
// proportion to that hour's GROSS weekday shape. Row (hour) totals are therefore
// exact; the weekday split — and so the column totals — are derived.
// Falls back to the order shape when an hour has no gross figure.
// See docs/DAYPART_HEATMAP_FEASIBILITY.md.
function buildNetHeatmap(grids: HourGrids, netRows: HourlyNetActivityRow[]): HeatmapData {
  const netByHour = new Map<number, number>();
  for (const r of netRows) {
    const hour = Math.trunc(n(r.hour));
    netByHour.set(hour, (netByHour.get(hour) ?? 0) + n(r.net_sales));
  }
  const cells = grids.hours.map((h) => {
    const netHour = netByHour.get(h) ?? 0;
    if (netHour === 0) return new Array(7).fill(0);
    let shape = grids.gross.get(h)!;
    let total = sum(shape);
    if (total <= 0) {
      shape = grids.orders.get(h)!;
      total = sum(shape);
    }
    if (total <= 0) return new Array(7).fill(0);
    return shape.map((v) => (netHour * v) / total);
  });
  return withTotals(grids.hours, cells);
}

// NOTE: an AOV heat map at this grain was built and removed — see Update 34.
// 804 orders across 84 cells averages ~10 per cell, and AOV is a ratio, so most
// cells carried ±£3-4 of sampling noise: the colours read as trading pattern but
// were largely random. Counts and sums (the two grids above) do not have this
// problem. Reliable AOV by hour is in the Performance by Time Period table
// below, which pools all seven days.

// "17" -> "5pm", "12" -> "12pm", "0" -> "12am". Used to label an hour bucket as
// the window it covers, e.g. hour 11 -> "11am-12pm".
function hour12(h: number): string {
  const period = h >= 12 && h < 24 ? "pm" : "am";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${period}`;
}
const hourLabel = (h: number) => `${hour12(h)}-${hour12((h + 1) % 24)}`;

export default async function DaypartPage({
  searchParams,
}: {
  searchParams: { week?: string; store?: string };
}) {
  const activeStore = resolveStore(searchParams.store);
  const scopeLabel = activeStore ? shortStore(activeStore) : "both stores";

  let weekIso: string | null;
  let detailRows: DaypartChannelDetailRow[];
  let basicRows: DaypartChannelRow[];
  let hourlyRows: HourlyActivityRow[];
  let netRows: HourlyNetActivityRow[];
  let weekEnd = "";
  try {
    const weeks = await getWeeks();
    weekIso = searchParams.week ?? weeks[0]?.week_start_iso ?? null;
    if (!weekIso) return <EmptyWeek />;
    weekEnd = weeks.find((w) => w.week_start_iso === weekIso)?.week_end ?? "";
    [detailRows, basicRows, hourlyRows, netRows] = await Promise.all([
      getDaypartChannelDetail(weekIso),
      getDaypartChannels(weekIso),
      getHourlyActivity(weekIso),
      getHourlyNetActivity(weekIso),
    ]);
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : "Unknown error"} />;
  }

  // Scope to the selected store (or keep both when "All Stores" is chosen).
  if (activeStore) {
    detailRows = detailRows.filter((c) => c.store === activeStore);
    basicRows = basicRows.filter((c) => c.store === activeStore);
    hourlyRows = hourlyRows.filter((c) => c.store === activeStore);
    netRows = netRows.filter((c) => c.store === activeStore);
  }

  const hours = aggregateNetHours(netRows);
  const grids = buildHourGrids(hourlyRows);
  const heatmap = buildOrderHeatmap(grids);
  const netHeatmap = buildNetHeatmap(grids, netRows);

  // vm_net_sales_by_hour is the row margin of both derived grids, and a gap in
  // it renders as a silent £0 row rather than an error (the backfill shipped
  // after Update 28). Compare what landed in the grid against the raw feed so a
  // shortfall is surfaced instead of read as a genuinely quiet hour.
  const netFeedTotal = netRows.reduce((s, r) => s + n(r.net_sales), 0);
  const netUnallocated = netFeedTotal - netHeatmap.grandTotal;
  const netDataMissing = netFeedTotal <= 0;

  const hasDetail = detailRows.length > 0;
  const periods = hasDetail ? fromDetail(detailRows) : fromBasic(basicRows);

  if (periods.length === 0) {
    return (
      <>
        <PageTitle title="Daypart Analysis" />
        <EmptyWeek />
      </>
    );
  }

  // Hourly "Performance by Time Period" table. Net revenue per hour has no
  // channel dimension, so this view is Orders / Revenue / AOV only (the
  // Own Delivery / Aggregate / In-store cuts are only defined per daypart).
  const hourColumns: Column<HourAgg>[] = [
    { key: "hour", header: "Time Period", render: (r) => <span className="font-medium">{hourLabel(r.hour)}</span> },
    { key: "orders", header: "Orders", align: "right", render: (r) => int(r.orders) },
    { key: "revenue", header: "Revenue", align: "right", render: (r) => gbp(r.revenue) },
    { key: "aov", header: "AOV", align: "right", render: (r) => gbp(r.aov) },
  ];

  // Trading-pattern facts for the commentary, drawn from the same hourly source
  // as the heat map and the table above so the figures reconcile.
  const dayTotals = heatmap.days.map((day, di) => ({ day, orders: heatmap.colTotals[di] }));
  const busiestDay = dayTotals.reduce((a, b) => (b.orders > a.orders ? b : a), dayTotals[0]);
  const quietestDay = dayTotals.reduce((a, b) => (b.orders < a.orders ? b : a), dayTotals[0]);

  let peakCell: { day: string; hourLabel: string; orders: number } | null = null;
  heatmap.cells.forEach((row, ri) => {
    row.forEach((v, ci) => {
      if (!peakCell || v > peakCell.orders) {
        peakCell = { day: heatmap.days[ci], hourLabel: hourLabel(heatmap.hours[ri]), orders: v };
      }
    });
  });

  const insightInput: DaypartInput = {
    dashboard: "daypart",
    week: weekIso,
    store: activeStore,
    hours: hours.map((h) => ({
      label: hourLabel(h.hour),
      orders: h.orders,
      revenue: h.revenue,
      aov: h.aov,
    })),
    heatmap: {
      busiestDay: heatmap.grandTotal > 0 ? busiestDay : null,
      quietestDay: heatmap.grandTotal > 0 ? quietestDay : null,
      peakCell: heatmap.grandTotal > 0 ? peakCell : null,
      totalOrders: heatmap.grandTotal,
    },
  };
  const draft = buildInsights(insightInput);

  return (
    <div className="space-y-7">
      <PageTitle
        title="Daypart Analysis"
        subtitle={`Trading patterns across the day (${scopeLabel}) · ${weekRange(weekIso, weekEnd)}`}
      />

      <Commentary initial={draft} input={insightInput} />

      <Section
        title="Order Heat Map — Hour × Day"
        description="Orders per trading hour by weekday (average day's activity). Cells are shaded low→high; the Total column and Total row are shaded on their own scales."
      >
        <HourDayHeatmap data={heatmap} />
      </Section>

      <Section
        title="Net Sales Heat Map — Hour × Day"
        description="Net sales per trading hour by weekday. Each hour's total is exact (from the hourly net sales feed); the split across weekdays is derived from that hour's order distribution, so the Total column is exact and the Total row is indicative."
      >
        {netDataMissing ? (
          <div className="vm-table-container px-4 py-8 text-center text-tertiary">
            No hourly net sales data for this week.
          </div>
        ) : (
          <>
            <HourDayHeatmap
              data={netHeatmap}
              formatValue={gbp}
              legendLabel="net sales / hour"
            />
            {netUnallocated > 0.01 && (
              <p className="mt-2 text-xs text-warning">
                ⚠ {gbp(netUnallocated)} of net sales could not be placed on the grid — those
                hours have no matching order activity, so the figures above understate the week.
              </p>
            )}
          </>
        )}
      </Section>

      <Section
        title="Performance by Time Period"
        description="Orders, net revenue and AOV per trading hour (AOV = net revenue ÷ orders). Revenue is net sales — after VAT, service charge and delivery fees — totalled across the week for each hour."
      >
        <DataTable
          columns={hourColumns}
          rows={hours}
          emptyMessage="No hourly activity for this week."
        />
      </Section>

    </div>
  );
}
