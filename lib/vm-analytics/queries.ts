import { getVMSupabaseServer } from "@/lib/vm-analytics/client";
import { getCashflowSupabaseServer } from "@/lib/supabase-cashflow";
import type {
  ExecRow,
  ExecChannelRow,
  LunchDealItemRow,
  LunchDealChannelRow,
  LunchDealChannelDetailRow,
  ProductRow,
  CategoryRow,
  CategoryPerfRow,
  ProductCategoryRow,
  CategoryQuarterRow,
  NewLaunchRow,
  DaypartRow,
  DaypartChannelRow,
  DaypartChannelDetailRow,
  MenuCategoryChannelRow,
  HourlyActivityRow,
  HourlyNetActivityRow,
  WeekdayRow,
  DeliveryRow,
  ComparisonRow,
  LaborCostRow,
  AttachmentRow,
  MealDealRow,
  MenuCategoryRow,
  WeekOption,
  YoyRow,
  WeeklySummaryInputRow,
} from "@/lib/vm-analytics/types";
import { canonicalStore, isDeliveryChannel } from "@/lib/vm-analytics/constants";
import { groupAgg } from "@/lib/vm-analytics/channels";

// All KPI views are weekly. Most queries take an optional ISO week_start; when
// omitted they resolve to the latest available week.

// Add N days to a YYYY-MM-DD date, returning the same format (UTC-safe so it
// never shifts across a day boundary due to local timezone).
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Monday (UTC) of the week containing `now`, as YYYY-MM-DD. Weeks at or after
// this date are the *current* (in-progress) week and shouldn't be offered as a
// completed reporting week.
function currentWeekMondayIso(now = new Date()): string {
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  const shift = day === 0 ? -6 : 1 - day;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + shift),
  );
  return monday.toISOString().slice(0, 10);
}

export async function getWeeks(): Promise<WeekOption[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_available_weeks")
    .select("week_start, week_end, week_start_iso")
    .order("week_start", { ascending: false });
  if (error) throw new Error(`getWeeks: ${error.message}`);
  return (data ?? []) as WeekOption[];
}

export async function resolveWeek(weekIso?: string): Promise<string | null> {
  if (weekIso) return weekIso;
  const weeks = await getWeeks();
  return weeks[0]?.week_start_iso ?? null;
}

// Pick the week immediately before `weekIso`, if one exists.
export async function previousWeek(weekIso: string): Promise<string | null> {
  const weeks = await getWeeks();
  const idx = weeks.findIndex((w) => w.week_start_iso === weekIso);
  if (idx === -1) return null;
  return weeks[idx + 1]?.week_start_iso ?? null;
}

export async function getExec(weekIso: string): Promise<ExecRow[]> {
  // Single-week is just the one-element multi-week case (`.in([x])` == `.eq(x)`).
  return getExecMulti([weekIso]);
}

// Current-year exec rows for one or more weeks at once. Powers both the
// single-week path (via getExec) and the 4/12-week Executive modes: buildBreakdown
// sums net_sales / customers across whatever week-rows it is handed.
export async function getExecMulti(weekIsos: string[]): Promise<ExecRow[]> {
  if (weekIsos.length === 0) return [];
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_exec_dashboard_with_wow")
    .select("*")
    .in("week_start", weekIsos);
  if (error) throw new Error(`getExecMulti: ${error.message}`);
  return (data ?? []) as ExecRow[];
}

// The N most recent completed weeks (getWeeks() is already newest-first, and
// vm_v_available_weeks excludes the in-progress week). Fewer than N is returned
// as-is so callers can surface "N of M weeks".
export async function getLatestWeeks(count: number): Promise<WeekOption[]> {
  const weeks = await getWeeks();
  return weeks.slice(0, count);
}

// Channel-level net sales + orders for a week, merged from the two raw tables
// on (store, channel). The Executive view (vm_v_exec_dashboard) only exposes
// bucketed totals, so we read the raw tables to get per-channel granularity.
export async function getExecChannels(weekIso: string): Promise<ExecChannelRow[]> {
  return getExecChannelsMulti([weekIso]);
}

// Same as getExecChannels but summed across several weeks — one row per
// (store, channel) with net_sales and orders totalled over the period. Amounts
// are TEXT in the source tables, so coerce with numOf().
export async function getExecChannelsMulti(weekIsos: string[]): Promise<ExecChannelRow[]> {
  if (weekIsos.length === 0) return [];
  const sb = getVMSupabaseServer();
  const [salesRes, ordersRes] = await Promise.all([
    sb
      .from("vm_net_sales_by_channel")
      .select("store, channel, net_sales")
      .in("week_start", weekIsos),
    sb
      .from("vm_orders_by_channel")
      .select("store, channel, number_of_orders")
      .in("week_start", weekIsos),
  ]);
  if (salesRes.error) throw new Error(`getExecChannels (sales): ${salesRes.error.message}`);
  if (ordersRes.error) throw new Error(`getExecChannels (orders): ${ordersRes.error.message}`);

  const key = (store: string, channel: string) => `${store}||${channel}`;
  const merged = new Map<string, ExecChannelRow>();

  for (const r of (salesRes.data ?? []) as { store: string; channel: string; net_sales: string }[]) {
    const k = key(r.store, r.channel);
    const cur = merged.get(k) ?? { store: r.store, channel: r.channel, net_sales: 0, orders: 0 };
    cur.net_sales = (cur.net_sales as number) + numOf(r.net_sales);
    merged.set(k, cur);
  }
  for (const r of (ordersRes.data ?? []) as {
    store: string;
    channel: string;
    number_of_orders: string;
  }[]) {
    const k = key(r.store, r.channel);
    const cur = merged.get(k) ?? { store: r.store, channel: r.channel, net_sales: 0, orders: 0 };
    cur.orders = (cur.orders as number) + numOf(r.number_of_orders);
    merged.set(k, cur);
  }
  return Array.from(merged.values());
}

// Lunch Time Deals: per (store, meal deal) sales for a week, from the raw
// vm_meal_deals_sold table. The "Meal Deals Sold (weekly)" report is pulled per
// store, so net_sales and counts are already per store.
export async function getLunchDeals(weekIso: string): Promise<LunchDealItemRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_meal_deals_sold")
    .select("store, meal_deal_name, no_of_meal_deals, net_sales")
    .eq("week_start", weekIso);
  if (error) throw new Error(`getLunchDeals: ${error.message}`);
  return (data ?? []) as LunchDealItemRow[];
}

// Delivery vs in-store split for meal deals, from vm_v_lunch_deals_channel.
// Returns [] if the view is missing so the dashboard can degrade gracefully.
export async function getLunchDealsChannel(weekIso: string): Promise<LunchDealChannelRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_lunch_deals_channel")
    .select("store, channel, deal_baskets, net_sales, aov")
    .eq("week_start", weekIso);
  if (error) {
    console.warn(`getLunchDealsChannel: ${error.message}`);
    return [];
  }
  return (data ?? []) as LunchDealChannelRow[];
}

// Per-individual-channel meal-deal mix, from vm_v_lunch_deals_channel_detail.
// Returns [] if the view is missing so the dashboard can degrade gracefully.
export async function getLunchDealsChannelDetail(
  weekIso: string,
): Promise<LunchDealChannelDetailRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_lunch_deals_channel_detail")
    .select("store, channel_group, channel_name, deal_baskets, net_sales, aov")
    .eq("week_start", weekIso);
  if (error) {
    console.warn(`getLunchDealsChannelDetail: ${error.message}`);
    return [];
  }
  return (data ?? []) as LunchDealChannelDetailRow[];
}

// Local numeric coercion mirroring vm_num(): strip everything but digits and the
// decimal point. Raw channel tables store amounts as TEXT.
function numOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/[^0-9.]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

export async function getProducts(weekIso: string): Promise<ProductRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_product_performance")
    .select("*")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) throw new Error(`getProducts: ${error.message}`);
  return (data ?? []) as ProductRow[];
}

// Per store × week × category aggregate with SQL-computed WoW, from
// vm_v_category_performance. Returns [] if the view is missing (e.g. before the
// category SQL has been run) so the Product Performance page still renders.
export async function getCategoryPerformance(weekIso: string): Promise<CategoryPerfRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_category_performance")
    .select("store, week_start, category, units_sold, gross_sales, revenue_wow_pct, units_wow_pct")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) {
    console.warn(`getCategoryPerformance: ${error.message}`);
    return [];
  }
  return (data ?? []) as CategoryPerfRow[];
}

// Every product row tagged with its category, from vm_v_product_category. Powers
// the Category Performance drill-down. Returns [] if the view is missing so the
// page degrades gracefully.
export async function getCategoryItems(weekIso: string): Promise<ProductCategoryRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_product_category")
    .select("*")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) {
    console.warn(`getCategoryItems: ${error.message}`);
    return [];
  }
  return (data ?? []) as ProductCategoryRow[];
}

// The curated new-launch list (item_name -> display_name + launch_date), from
// vm_new_launches. Week-independent: the products page matches these against the
// selected week's product rows. Returns [] if the table is missing (e.g. before
// the seed SQL has been run) so the page still renders without the section.
export async function getNewLaunches(): Promise<NewLaunchRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_new_launches")
    .select("item_name, display_name, launch_date");
  if (error) {
    console.warn(`getNewLaunches: ${error.message}`);
    return [];
  }
  return (data ?? []) as NewLaunchRow[];
}

// NET counterparts of getProducts / getCategoryItems, reading the vm_v_product_net
// chain. The net revenue column `net_sales` is aliased to `gross_sales` so the
// Product Performance aggregation (which reads `gross_sales`) computes on NET with
// no code change — the returned `gross_sales` field carries the NET value. The
// gross variants above are kept for other consumers (e.g. weekly-exception).
export async function getProductsNet(weekIso: string): Promise<ProductRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_product_net")
    .select("store, week_start, item_name, units_sold, gross_sales:net_sales")
    .eq("week_start", weekIso)
    .order("net_sales", { ascending: false });
  if (error) throw new Error(`getProductsNet: ${error.message}`);
  return (data ?? []) as ProductRow[];
}

// Trailing N-week NET revenue per store x category x item for the given anchor
// week, plus the N weeks before it, from vm_mv_category_quarter_net. Returns []
// if the matview is missing OR has not been refreshed since this week synced, so
// the Product Performance page still renders — the quarterly column just hides.
// A hidden column is visible to the user in a way stale figures would not be.
//
// Paged: the item grain spans two windows of menu history, which can exceed the
// REST layer's 1000-row response cap. A silently truncated page would drop whole
// categories out of the quarterly column with no error to show for it.
export async function getCategoryQuarterNet(weekIso: string): Promise<CategoryQuarterRow[]> {
  const sb = getVMSupabaseServer();
  const PAGE = 1000;
  const MAX_PAGES = 20;
  const out: CategoryQuarterRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await sb
      .from("vm_mv_category_quarter_net")
      .select(
        "store, category, item_name, q_from, q_to, prev_from, prev_to, q_weeks, prev_weeks, q_net_sales, prev_q_net_sales",
      )
      .eq("anchor_week", weekIso)
      .order("store")
      .order("item_name")
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(`getCategoryQuarterNet: ${error.message}`);
      return [];
    }
    const rows = (data ?? []) as CategoryQuarterRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function getCategoryItemsNet(weekIso: string): Promise<ProductCategoryRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_product_category_net")
    .select("store, week_start, item_name, units_sold, category, gross_sales:net_sales")
    .eq("week_start", weekIso)
    .order("net_sales", { ascending: false });
  if (error) {
    console.warn(`getCategoryItemsNet: ${error.message}`);
    return [];
  }
  return (data ?? []) as ProductCategoryRow[];
}

export async function getCategories(weekIso: string): Promise<CategoryRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_category_performance")
    .select("*")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) throw new Error(`getCategories: ${error.message}`);
  return (data ?? []) as CategoryRow[];
}

export async function getDayparts(weekIso: string): Promise<DaypartRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_daypart_summary")
    .select("*")
    .eq("week_start", weekIso)
    .order("daypart_rank", { ascending: true });
  if (error) throw new Error(`getDayparts: ${error.message}`);
  return (data ?? []) as DaypartRow[];
}

// Delivery vs in-store split for dayparts, from vm_v_daypart_channel
// (derived from line-item data). Returns [] if the view is missing so the
// dashboard can degrade gracefully.
export async function getDaypartChannels(weekIso: string): Promise<DaypartChannelRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_daypart_channel")
    .select("store, week_start, daypart, daypart_rank, channel, orders, net_sales, aov")
    .eq("week_start", weekIso)
    .order("daypart_rank", { ascending: true });
  if (error) {
    console.warn(`getDaypartChannels: ${error.message}`);
    return [];
  }
  return (data ?? []) as DaypartChannelRow[];
}

// Finer per-channel daypart breakdown, from vm_v_daypart_channel_detail. Lets
// the Daypart dashboard show Own Delivery / Aggregate / Eat-in columns. Returns
// [] if the view is missing (e.g. before the SQL has been run) so the dashboard
// can degrade to the Delivery/In-store split gracefully.
export async function getDaypartChannelDetail(
  weekIso: string,
): Promise<DaypartChannelDetailRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_daypart_channel_detail")
    .select("store, week_start, daypart, daypart_rank, channel_group, channel_name, orders, net_sales, aov")
    .eq("week_start", weekIso)
    .order("daypart_rank", { ascending: true });
  if (error) {
    console.warn(`getDaypartChannelDetail: ${error.message}`);
    return [];
  }
  return (data ?? []) as DaypartChannelDetailRow[];
}

// Menu-category × channel breakdown, from vm_v_menu_category_channel (line-item
// derived). Lets the Daypart dashboard show per-channel AOV for the
// "Meal Boxes & Platters" / "Platters" categories. Returns [] if the view is
// missing (e.g. before the SQL has been run) so the dashboard degrades
// gracefully.
export async function getMenuCategoryChannels(
  weekIso: string,
): Promise<MenuCategoryChannelRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_menu_category_channel")
    .select("store, week_start, menu_category, channel_group, channel_name, orders, net_sales, aov")
    .eq("week_start", weekIso);
  if (error) {
    console.warn(`getMenuCategoryChannels: ${error.message}`);
    return [];
  }
  return (data ?? []) as MenuCategoryChannelRow[];
}

// Per (store, weekday, hour) trading activity from the raw
// vm_hourly_order_activity report. Powers the Daypart order heat map (weekday x
// hour order counts). Its avg_daily_sales is GROSS, so it is no longer used for
// the hourly Revenue column — see getHourlyNetActivity for that.
export async function getHourlyActivity(weekIso: string): Promise<HourlyActivityRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_hourly_order_activity")
    .select("store, week_start, weekday, weekday_id, order_hour, avg_daily_sales, avg_daily_orders")
    .eq("week_start", weekIso)
    .order("order_hour", { ascending: true });
  if (error) throw new Error(`getHourlyActivity: ${error.message}`);
  return (data ?? []) as HourlyActivityRow[];
}

// Per (store, week, hour) NET revenue joined to order counts, from the
// vm_v_hourly_net_activity view. Powers the hourly "Performance by Time Period"
// table (Revenue = net, AOV = net / orders). Net comes from vm_net_sales_by_hour;
// orders from vm_hourly_order_activity.
export async function getHourlyNetActivity(weekIso: string): Promise<HourlyNetActivityRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_hourly_net_activity")
    .select("store, week_start, hour, orders, net_sales")
    .eq("week_start", weekIso)
    .order("hour", { ascending: true });
  if (error) throw new Error(`getHourlyNetActivity: ${error.message}`);
  return (data ?? []) as HourlyNetActivityRow[];
}

export async function getWeekdays(weekIso: string): Promise<WeekdayRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_daypart_weekday")
    .select("*")
    .eq("week_start", weekIso)
    .order("weekday_id", { ascending: true });
  if (error) throw new Error(`getWeekdays: ${error.message}`);
  return (data ?? []) as WeekdayRow[];
}

export async function getDelivery(weekIso: string): Promise<DeliveryRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_delivery_mix")
    .select("*")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) throw new Error(`getDelivery: ${error.message}`);
  return (data ?? []) as DeliveryRow[];
}

export async function getComparison(weekIso: string): Promise<ComparisonRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_store_comparison")
    .select("*")
    .eq("week_start", weekIso);
  if (error) throw new Error(`getComparison: ${error.message}`);
  return (data ?? []) as ComparisonRow[];
}

// Per-item attachment rates (share of orders containing the item) with WoW
// delta. Used by the Weekly Exception Report for falling-attachment risks and
// upselling opportunities. Ordered most-attached first.
export async function getAttachmentRates(weekIso: string): Promise<AttachmentRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_attachment_with_wow")
    .select("*")
    .eq("week_start", weekIso)
    .order("attach_pct", { ascending: false });
  if (error) throw new Error(`getAttachmentRates: ${error.message}`);
  return (data ?? []) as AttachmentRow[];
}

// Meal-deal basket penetration per store with WoW. Supports upselling signals.
export async function getMealDeals(weekIso: string): Promise<MealDealRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_meal_deals")
    .select("*")
    .eq("week_start", weekIso);
  if (error) throw new Error(`getMealDeals: ${error.message}`);
  return (data ?? []) as MealDealRow[];
}

// Real menu categories with WoW (from products-with-modifiers source). The
// exception report uses this for "fastest-growing category" since the external-
// category report is largely blank for these stores.
export async function getMenuCategories(weekIso: string): Promise<MenuCategoryRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("vm_v_menu_category_wow")
    .select("*")
    .eq("week_start", weekIso)
    .order("gross_sales", { ascending: false });
  if (error) throw new Error(`getMenuCategories: ${error.message}`);
  return (data ?? []) as MenuCategoryRow[];
}

// Get available weeks for Labor Cost dashboard (from cashflow Supabase).
// week_start_date is the only week field these tables carry, so it serves as
// both the start and the (display) end of the option.
export async function getLaborCostWeeks(): Promise<WeekOption[]> {
  const sb = getCashflowSupabaseServer();
  const { data, error } = await sb
    .from("labor_cost_performance")
    .select("week_start_date")
    .order("week_start_date", { ascending: false });

  if (error) throw new Error(`getLaborCostWeeks: ${error.message}`);

  // Deduplicate (the view has one row per store/week) and drop nulls.
  // week_start_date is the Monday; the week runs Mon–Sun, so week_end is +6 days.
  // Exclude the current in-progress week — its data isn't fully synced yet, so
  // we only offer completed weeks (most recent completed week shows by default).
  const thisMonday = currentWeekMondayIso();
  const seen = new Set<string>();
  const weeks: WeekOption[] = [];
  for (const row of data ?? []) {
    const weekDate = (row as { week_start_date: string | null }).week_start_date;
    if (weekDate && weekDate < thisMonday && !seen.has(weekDate)) {
      seen.add(weekDate);
      weeks.push({
        week_start: weekDate,
        week_end: addDaysIso(weekDate, 6),
        week_start_iso: weekDate,
      });
    }
  }
  return weeks;
}

// Labor Cost Performance (from cashflow Supabase)
export async function getLaborCost(weekIso: string): Promise<LaborCostRow[]> {
  const sb = getCashflowSupabaseServer();
  const { data, error } = await sb
    .from("labor_cost_performance")
    .select("*")
    .eq("week_start_date", weekIso)
    .order("store", { ascending: true });

  if (error) throw new Error(`getLaborCost: ${error.message}`);

  // Cast rows and compute TOTAL row (sum across stores)
  const rows = (data ?? []) as LaborCostRow[];
  if (rows.length > 0) {
    const total: LaborCostRow = {
      store: "TOTAL",
      week_start_date: weekIso,
      labour_cost: rows.reduce((sum, r) => sum + (parseFloat(String(r.labour_cost)) || 0), 0),
      revenue: rows.reduce((sum, r) => sum + (parseFloat(String(r.revenue)) || 0), 0),
      labour_pct: 0,
    };
    // Recalculate labour_pct for the total
    const rev = Number(total.revenue ?? 0);
    const cost = Number(total.labour_cost ?? 0);
    total.labour_pct = rev > 0 ? Math.round((cost / rev) * 1000) / 10 : 0;
    return [...rows, total];
  }
  return rows;
}

/**
 * Fetch manager-entered inputs for a single store + week.
 * Returns null if no data has been entered yet.
 */
export async function getWeeklySummaryInputs(
  store: string,
  weekIso: string,
): Promise<WeeklySummaryInputRow | null> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("weekly_summary_inputs")
    .select("*")
    .eq("store", store)
    .eq("week_start_iso", weekIso)
    .maybeSingle();
  if (error) throw new Error(`getWeeklySummaryInputs: ${error.message}`);
  return data as WeeklySummaryInputRow | null;
}

/**
 * Fetch manager-entered inputs for ALL stores for a given week.
 * Used in the combined / "all stores" view.
 */
export async function getWeeklySummaryInputsForWeek(
  weekIso: string,
): Promise<WeeklySummaryInputRow[]> {
  const sb = getVMSupabaseServer();
  const { data, error } = await sb
    .from("weekly_summary_inputs")
    .select("*")
    .eq("week_start_iso", weekIso);
  if (error) throw new Error(`getWeeklySummaryInputsForWeek: ${error.message}`);
  return (data ?? []) as WeeklySummaryInputRow[];
}

/**
 * Returns the Monday ISO date 364 days before `weekIso`.
 * 364 days = 52 × 7, so the result always lands on the same weekday in the
 * prior year — the standard QSR YoY baseline convention.
 */
export function yoyWeekIso(weekIso: string): string {
  const d = new Date(weekIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 364);
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch the single YoY row for `weekIso` from the appropriate table.
 * Returns null if no historical data exists for that week.
 */
export async function getYoy(
  weekIso: string,
  store: string | null
): Promise<YoyRow | null> {
  const sb = getVMSupabaseServer();

  const table =
    store === "Peckers Hitchin"
      ? "vm_yoy_hitchin"
      : store === "Peckers Stevenage"
      ? "vm_yoy_stevenage"
      : "vm_yoy_both_stores";

  const yoyWeek = yoyWeekIso(weekIso);

  const { data, error } = await sb
    .from(table)
    .select("*")
    .eq("week_commencing", yoyWeek)
    .maybeSingle();

  if (error) {
    console.warn(`getYoy (${table}): ${error.message}`);
    return null;
  }
  return data as YoyRow | null;
}

/**
 * Prior-year rows for several weeks at once (4/12-week Executive modes).
 * Maps each current Monday through yoyWeekIso() (−364d) and fetches those
 * week_commencing rows from the store-scoped table. Returns how many of the
 * requested weeks actually matched so the page can surface "N of M weeks".
 */
export async function getYoyMulti(
  weekIsos: string[],
  store: string | null,
): Promise<{ rows: YoyRow[]; matched: number; requested: number }> {
  const requested = weekIsos.length;
  if (requested === 0) return { rows: [], matched: 0, requested: 0 };

  const sb = getVMSupabaseServer();
  const table =
    store === "Peckers Hitchin"
      ? "vm_yoy_hitchin"
      : store === "Peckers Stevenage"
      ? "vm_yoy_stevenage"
      : "vm_yoy_both_stores";

  const yoyWeeks = weekIsos.map(yoyWeekIso);
  const { data, error } = await sb
    .from(table)
    .select("*")
    .in("week_commencing", yoyWeeks);

  if (error) {
    console.warn(`getYoyMulti (${table}): ${error.message}`);
    return { rows: [], matched: 0, requested };
  }
  const rows = (data ?? []) as YoyRow[];
  return { rows, matched: rows.length, requested };
}

/**
 * Sum several prior-year rows into one period total. Additive fields (sales,
 * order counts, customers) are summed; every percentage is RECOMPUTED from the
 * summed sales totals — never averaged — so it reconciles with the current-year
 * multi-week aggregation. Returns a zeroed row for an empty input.
 */
export function sumYoyRows(rows: YoyRow[]): YoyRow {
  const sum = (f: keyof YoyRow) => rows.reduce((s, r) => s + numOf(r[f]), 0);

  const total_sales = sum("total_sales");
  const in_store_sales = sum("in_store_sales");
  const delivery_sales = sum("delivery_sales");
  const own_delivery_sales = sum("own_delivery_sales");
  const aggregate_sales = sum("aggregate_sales");
  const pctOf = (part: number) => (total_sales > 0 ? (100 * part) / total_sales : 0);

  return {
    // Latest prior-year Monday in the set; not shown in multi-week mode.
    week_commencing: rows.length ? String(rows[rows.length - 1].week_commencing) : "",
    click_collect: sum("click_collect"),
    kiosk: sum("kiosk"),
    till_eat_in: sum("till_eat_in"),
    till_takeaway: sum("till_takeaway"),
    own_delivery: sum("own_delivery"),
    deliveroo: sum("deliveroo"),
    just_eat: sum("just_eat"),
    uber_eats: sum("uber_eats"),
    total_sales,
    in_store_sales,
    delivery_sales,
    in_store_pct: pctOf(in_store_sales),
    delivery_pct: pctOf(delivery_sales),
    own_delivery_sales,
    aggregate_sales,
    own_delivery_pct: pctOf(own_delivery_sales),
    aggregate_pct: pctOf(aggregate_sales),
    total_orders: sum("total_orders"),
    new_customers: sum("new_customers"),
    return_customers: sum("return_customers"),
    total_customers: sum("total_customers"),
    // Per-channel net sales. Summed only when EVERY row in the period carries
    // the column; otherwise null, so a partially-backfilled period falls back to
    // the order-count comparison rather than reporting a total that silently
    // omits the missing weeks.
    click_collect_sales: sumIfComplete(rows, "click_collect_sales"),
    kiosk_sales: sumIfComplete(rows, "kiosk_sales"),
    till_eat_in_sales: sumIfComplete(rows, "till_eat_in_sales"),
    till_takeaway_sales: sumIfComplete(rows, "till_takeaway_sales"),
    deliveroo_sales: sumIfComplete(rows, "deliveroo_sales"),
    just_eat_sales: sumIfComplete(rows, "just_eat_sales"),
    uber_eats_sales: sumIfComplete(rows, "uber_eats_sales"),
  };
}

// Sum a nullable column, returning null unless every row supplies a value. A
// part-summed period would understate the prior year and inflate the YoY %.
function sumIfComplete(rows: YoyRow[], f: keyof YoyRow): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const r of rows) {
    const v = r[f];
    if (v === null || v === undefined) return null;
    total += numOf(v);
  }
  return total;
}

// Delivery order count for one week, scoped to a store — the same figure the
// Executive dashboard prints as "Delivery Orders" (its channel-table TOTAL), so
// the Tuesday payout can be checked against what Vita Mojo recorded. Store names
// differ between the VM and cashflow databases, hence canonicalStore. Returns
// null when the week has no VM rows at all, which must read as "not loaded"
// rather than zero deliveries.
export async function getDeliveryOrdersForWeek(
  weekIso: string,
  store?: string | null,
): Promise<number | null> {
  const rows = await getExecChannels(weekIso);
  const scoped = store
    ? rows.filter((r) => canonicalStore(r.store) === canonicalStore(store))
    : rows;
  if (scoped.length === 0) return null;
  return groupAgg(scoped, isDeliveryChannel).orders;
}
