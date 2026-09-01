// =============================================================
// Weekly Report — turning typed line items into the ten scalars the existing
// P&L engine already consumes.
//
// PURE module (no Supabase, no server imports) so the same maths runs on the
// server, in the client grids and in a test. It deliberately does NOT touch
// lib/vm-analytics/weekly-summary.ts: that file already implements every
// workbook formula correctly, including the reversed labour variance and the
// GROSS-sales denominator on Net Margin. What changes with this module is only
// where its inputs come from — roll-ups of line items instead of ten hand-typed
// numbers.
// =============================================================

import type { WeeklySummaryInputs } from "./vm-analytics/weekly-summary";
import type { WeekOption } from "./vm-analytics/types";
import { addDays, londonISODate, parseISODate, startOfISOWeek, toISODate } from "./utils";

export type WeeklyReportStatus = "draft" | "locked" | "sent";

export const REPORT_SECTIONS = [
  "cogs_supplier",
  "cogs_walkern",
  "cogs_hitchin",
  "occupancy",
  "rice_bowls",
  "fillings",
  "samosas",
  "spring_rolls",
  "aggregator",
  "expense",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

export type LabourSource = "employee" | "cover_driver" | "manager" | "adhoc";

export type WeeklyReportLine = {
  id: string;
  report_id: string;
  section: ReportSection;
  label: string;
  sort_order: number;
  entry_date: string | null;
  qty: number | string | null;
  unit_rate: number | string | null;
  amount: number | string | null;
  /** Entered per expense line; null falls back to the standard rate. */
  vat_amount: number | string | null;
  note: string | null;
};

export type WeeklyReportLabourLine = {
  id: string;
  report_id: string;
  person_name: string;
  source: LabourSource;
  employee_id: string | null;
  cover_driver_id: string | null;
  manager_id: string | null;
  hours: number | string | null;
  ni_hours: number | string | null;
  ni_rate: number | string | null;
  cash_hours: number | string | null;
  cash_rate: number | string | null;
  deliveries: number | null;
  delivery_pay: number | string | null;
  sort_order: number;
};

export type WeeklyReport = {
  id: string;
  store_id: string;
  week_start: string;
  status: WeeklyReportStatus;
  packaging_costs: number | string | null;
  marketing: number | string | null;
  /** Null on a store that does not supply Meppershall — migration 051. */
  meppershall: number | string | null;
  cogs_hitchin: number | string | null;
  gross_margin_budget_pct: number | string | null;
  labour_budget_pct: number | string | null;
  snapshot: WeeklyReportSnapshot | null;
  locked_at: string | null;
  locked_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
  sent_to: string[] | null;
};

/** What lock freezes: the sales it was computed against plus every input. */
export type WeeklyReportSnapshot = {
  gross_sales: number;
  net_sales: number;
  inputs: WeeklySummaryInputs;
  section_totals: Record<ReportSection, number>;
  labour_total: number;
  locked_at: string;
};

// ---------------- section metadata ----------------

export type SectionShape = "amount" | "qty_rate" | "dated" | "commission";

export type SectionDef = {
  key: ReportSection;
  title: string;
  /** Column header for `label` — a supplier, a day, a site, a platform. */
  labelHeading: string;
  shape: SectionShape;
  /** Default £/unit for a new line on a qty x rate section. */
  defaultUnitRate?: number;
  /** Which summary figure this section rolls into — null = record only. */
  feeds: string | null;
};

export type ReportTab =
  | "summary"
  | "cogs"
  | "walkern"
  | "hitchin"
  | "fillings"
  | "labour"
  | "occupancy"
  | "aggregator"
  | "expenses"
  | "channels";

export const SECTION_DEFS: Record<ReportSection, SectionDef> = {
  cogs_supplier: {
    key: "cogs_supplier",
    title: "Cost of Goods",
    labelHeading: "Supplier",
    shape: "amount",
    feeds: "COGS",
  },
  cogs_walkern: {
    key: "cogs_walkern",
    title: "COGS Walkern",
    labelHeading: "Item",
    shape: "amount",
    feeds: null,
  },
  cogs_hitchin: {
    key: "cogs_hitchin",
    title: "COGS transferred out",
    labelHeading: "Item",
    shape: "amount",
    feeds: "COGS transfer (credited back against COGS)",
  },
  occupancy: {
    key: "occupancy",
    title: "Occupancy Costs",
    labelHeading: "Cost",
    shape: "amount",
    feeds: "Occupancy Costs",
  },
  rice_bowls: {
    key: "rice_bowls",
    title: "Rice Bowls",
    labelHeading: "Day",
    shape: "qty_rate",
    defaultUnitRate: 2.5,
    feeds: "Fillings and Samosas",
  },
  fillings: {
    key: "fillings",
    title: "Fillings",
    labelHeading: "Site",
    shape: "amount",
    feeds: "Fillings and Samosas",
  },
  samosas: {
    key: "samosas",
    title: "Samosas",
    labelHeading: "Site",
    shape: "qty_rate",
    defaultUnitRate: 0.7,
    feeds: "Fillings and Samosas",
  },
  spring_rolls: {
    key: "spring_rolls",
    title: "Spring Rolls",
    labelHeading: "Day",
    shape: "qty_rate",
    defaultUnitRate: 0.8,
    feeds: "Fillings and Samosas",
  },
  aggregator: {
    key: "aggregator",
    title: "Aggregator Summary",
    labelHeading: "Platform",
    shape: "commission",
    feeds: "Aggregator Costs",
  },
  expense: {
    key: "expense",
    title: "Weekly Expenses",
    labelHeading: "Place",
    shape: "dated",
    feeds: null,
  },
};

/**
 * The OTHER store. Goods move both ways — Hitchin covers a Stevenage shortage
 * and Stevenage covers Hitchin's — so the transfer sheet on each store's report
 * is named after where the goods went, never after a fixed store.
 */
export function otherStoreName(storeName: string): string {
  return /hitchin/i.test(storeName) ? "Stevenage" : "Hitchin";
}

export function transferTitle(storeName: string): string {
  return `COGS to ${otherStoreName(storeName)}`;
}

/** The four sub-tables that make up the summary's "Fillings and Samosas". */
export const FILLINGS_SECTIONS: ReportSection[] = [
  "rice_bowls",
  "fillings",
  "samosas",
  "spring_rolls",
];

export const VAT_RATE = 0.2;

// ---------------- number helpers ----------------

export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Rates only. A manager's effective hourly rate is a division, and 2dp of it
 *  drifts by pennies a week against the fixed daily wage it came from. */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/**
 * A line's money. `amount` wins when it is set — on a qty x rate section it is
 * the stored product, so a later rate edit cannot restate a line already
 * entered. The product is only the fallback for a row saved without one.
 */
export function lineAmount(line: Pick<WeeklyReportLine, "amount" | "qty" | "unit_rate">): number {
  if (line.amount != null && line.amount !== "") return num(line.amount);
  return round2(num(line.qty) * num(line.unit_rate));
}

/**
 * The Cost of Goods sheet is one ROW PER SUPPLIER with a column per invoice,
 * so the grid groups the stored per-invoice rows back into that shape. Grouping
 * is on the folded label — "MS Foods" and "MS foods" are one supplier, not two
 * rows that each total half the week.
 */
export const MIN_INVOICE_COLUMNS = 3;
export const MAX_INVOICE_COLUMNS = 10;

export type SupplierGroup = {
  key: string;
  label: string;
  invoices: WeeklyReportLine[];
  total: number;
};

export function supplierKey(label: string): string {
  return label.trim().toLowerCase();
}

export function groupSupplierLines(lines: WeeklyReportLine[]): SupplierGroup[] {
  const byKey = new Map<string, SupplierGroup>();
  for (const line of lines) {
    const key = supplierKey(line.label);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: line.label.trim(), invoices: [], total: 0 };
      byKey.set(key, group);
    }
    group.invoices.push(line);
    group.total = round2(group.total + lineAmount(line));
  }
  return Array.from(byKey.values());
}

export function invoiceColumnCount(groups: SupplierGroup[]): number {
  const widest = groups.reduce((n, g) => Math.max(n, g.invoices.length), 0);
  return Math.min(MAX_INVOICE_COLUMNS, Math.max(MIN_INVOICE_COLUMNS, widest));
}

export function sumSection(lines: WeeklyReportLine[], section: ReportSection): number {
  return round2(
    lines.reduce((t, l) => (l.section === section ? t + lineAmount(l) : t), 0),
  );
}

export function sectionTotals(lines: WeeklyReportLine[]): Record<ReportSection, number> {
  const totals = {} as Record<ReportSection, number>;
  for (const s of REPORT_SECTIONS) totals[s] = sumSection(lines, s);
  return totals;
}

/** VAT on an expense line, at the standard rate. Display only — record-only tab. */
export function expenseVat(amount: number): number {
  return round2(amount * VAT_RATE);
}

/**
 * A line's VAT: what was typed, else the standard rate on the amount.
 *
 * Typed wins because not every expense carries 20% — zero-rated food, a
 * non-registered supplier, a receipt that states its own figure. The computed
 * rate is only the starting point.
 */
export function lineVat(
  line: Pick<WeeklyReportLine, "vat_amount" | "amount" | "qty" | "unit_rate">,
): number {
  if (line.vat_amount != null && line.vat_amount !== "") return round2(num(line.vat_amount));
  return expenseVat(lineAmount(line));
}

// ---------------- labour ----------------

export type LabourLineTotals = {
  /** The workbook's "Hours worked" — the two halves of one week, never typed. */
  hours: number;
  ni_total: number;
  cash_total: number;
  delivery_pay: number;
  total_pay: number;
};

export function labourLineTotals(l: WeeklyReportLabourLine): LabourLineTotals {
  const ni_total = round2(num(l.ni_hours) * num(l.ni_rate));
  const cash_total = round2(num(l.cash_hours) * num(l.cash_rate));
  const delivery_pay = round2(num(l.delivery_pay));
  return {
    hours: round2(num(l.ni_hours) + num(l.cash_hours)),
    ni_total,
    cash_total,
    delivery_pay,
    total_pay: round2(ni_total + cash_total + delivery_pay),
  };
}

/**
 * The week's labour cost — the workbook's `Labour Cost`!K20, which is
 * NI total + cash total + delivery pay and nothing else.
 *
 * FULL COST, not the cash the Tuesday payout hands over. The payout excludes
 * NI/bank hours because they go through PAYE; the P&L has to carry them.
 */
export function labourTotal(lines: WeeklyReportLabourLine[]): number {
  return round2(lines.reduce((t, l) => t + labourLineTotals(l).total_pay, 0));
}

// ---------------- aggregator ----------------

/**
 * The three platforms that charge commission. Own Delivery and collection are
 * the store's own orders — there is no aggregator to pay — so the sheet is
 * fixed to these rather than following whatever VM's delivery mix lists.
 */
export const AGGREGATOR_PLATFORMS = ["Just Eat", "Deliveroo", "Uber Eats"] as const;

/** Which of the three a VM platform label or a saved commission line is. */
export function aggregatorPlatform(label: string): string | null {
  const p = (label ?? "").toLowerCase();
  if (p.includes("just eat") || p.includes("justeat")) return "Just Eat";
  if (p.includes("deliveroo")) return "Deliveroo";
  if (p.includes("uber")) return "Uber Eats";
  return null;
}

export type AggregatorRow = {
  platform: string;
  /** From VM's delivery mix — never typed by a manager. */
  sales: number;
  commission: number;
  income: number;
  commission_pct: number;
  line: WeeklyReportLine | null;
};

/**
 * Merge the manager's commission lines with VM's per-platform sales, for the
 * three aggregators and nothing else. All three always appear, so a platform
 * nobody has costed reads as a zero rather than a missing row.
 */
export function aggregatorRows(
  lines: WeeklyReportLine[],
  salesByPlatform: Map<string, number>,
): AggregatorRow[] {
  const keyed = new Map<string, WeeklyReportLine>();
  for (const l of lines) {
    if (l.section !== "aggregator") continue;
    const platform = aggregatorPlatform(l.label);
    if (platform) keyed.set(platform, l);
  }

  const sales = new Map<string, number>();
  for (const [label, amount] of salesByPlatform) {
    const platform = aggregatorPlatform(label);
    if (platform) sales.set(platform, (sales.get(platform) ?? 0) + amount);
  }

  return AGGREGATOR_PLATFORMS.map((platform) => {
    const line = keyed.get(platform) ?? null;
    const commission = line ? lineAmount(line) : 0;
    const platformSales = round2(sales.get(platform) ?? 0);
    return {
      platform,
      sales: platformSales,
      commission,
      income: round2(platformSales - commission),
      commission_pct: platformSales > 0 ? commission / platformSales : 0,
      line,
    };
  });
}

// ---------------- the roll-up ----------------

/**
 * Turn a report's header scalars and line items into the ten inputs
 * generateWeeklySummary() already consumes.
 *
 * `cogs_hitchin` (summary line B11, a CREDIT against COGS for stock that left
 * for the other store) is the transfer sheet's own total. It was a separately
 * typed header scalar until it was pointed out that the two are the same
 * figure and nobody should key it twice. The header column survives only as
 * the fallback below, for a week typed before the sheet existed.
 *
 * cogs_walkern and expense still feed nothing — those are records, not costs
 * this P&L carries.
 *
 * One deliberate correction: "Fillings and Samosas" sums all FOUR sub-tables.
 * The workbook's B12 reads only the rice-bowl block, which leaves the fillings
 * and samosas it is named after out of the margin — the same class of
 * partial-SUM bug as Occupancy's `SUM(B11:B26)` skipping its first row.
 */
export function rollUpInputs(
  report: Pick<
    WeeklyReport,
    | "packaging_costs"
    | "marketing"
    | "meppershall"
    | "cogs_hitchin"
    | "gross_margin_budget_pct"
    | "labour_budget_pct"
  >,
  lines: WeeklyReportLine[],
  labourLines: WeeklyReportLabourLine[],
): WeeklySummaryInputs {
  const totals = sectionTotals(lines);
  const transfer = lines.some((l) => l.section === "cogs_hitchin")
    ? totals.cogs_hitchin
    : num(report.cogs_hitchin);
  return {
    cogs: totals.cogs_supplier,
    cogs_hitchin: transfer,
    fillings_and_samosas: round2(
      FILLINGS_SECTIONS.reduce((t, s) => t + totals[s], 0),
    ),
    meppershall: num(report.meppershall),
    packaging_costs: num(report.packaging_costs),
    marketing: num(report.marketing),
    labour_cost: labourTotal(labourLines),
    occupancy_cost: totals.occupancy,
    aggregator_costs: totals.aggregator,
    gross_margin_budget_pct: num(report.gross_margin_budget_pct),
    labour_budget_pct: num(report.labour_budget_pct),
  };
}

/** Sum two stores' inputs for the read-only combined view. Budget %s average. */
export function combineInputs(
  a: WeeklySummaryInputs | null,
  b: WeeklySummaryInputs | null,
): WeeklySummaryInputs {
  const add = (k: keyof WeeklySummaryInputs) => num(a?.[k]) + num(b?.[k]);
  const avg = (k: keyof WeeklySummaryInputs) => {
    if (a && b) return (num(a[k]) + num(b[k])) / 2;
    if (a) return num(a[k]) || undefined;
    if (b) return num(b[k]) || undefined;
    return undefined;
  };
  return {
    cogs: add("cogs"),
    cogs_hitchin: add("cogs_hitchin"),
    fillings_and_samosas: add("fillings_and_samosas"),
    meppershall: add("meppershall"),
    packaging_costs: add("packaging_costs"),
    marketing: add("marketing"),
    labour_cost: add("labour_cost"),
    occupancy_cost: add("occupancy_cost"),
    aggregator_costs: add("aggregator_costs"),
    gross_margin_budget_pct: avg("gross_margin_budget_pct"),
    labour_budget_pct: avg("labour_budget_pct"),
  };
}

/**
 * Fields where a locked report's frozen figure disagrees with what the same
 * inputs compute today. Mirrors the stale-Vita-Mojo warning on the payout sheet
 * (Update 128): a snapshot that has drifted must read as a snapshot, not as a
 * calculation bug.
 */
export function snapshotDrift(
  snapshot: WeeklyReportSnapshot,
  live: { gross_sales: number; net_sales: number; inputs: WeeklySummaryInputs },
): string[] {
  const drift: string[] = [];
  if (round2(snapshot.gross_sales) !== round2(live.gross_sales)) drift.push("Gross Sales");
  if (round2(snapshot.net_sales) !== round2(live.net_sales)) drift.push("Net Sales");
  const labels: Partial<Record<keyof WeeklySummaryInputs, string>> = {
    cogs: "COGS",
    cogs_hitchin: "COGS transfer",
    fillings_and_samosas: "Fillings and Samosas",
    meppershall: "Meppershall",
    packaging_costs: "Packaging",
    marketing: "Marketing",
    labour_cost: "Labour",
    occupancy_cost: "Occupancy",
    aggregator_costs: "Aggregator",
  };
  for (const [key, label] of Object.entries(labels) as [keyof WeeklySummaryInputs, string][]) {
    if (round2(num(snapshot.inputs[key])) !== round2(num(live.inputs[key]))) drift.push(label);
  }
  return drift;
}

// ---------------- week options ----------------

/**
 * The Monday of the newest week a report may be opened for.
 *
 * Every VM Analytics dashboard reads up to LAST week, and the report reads
 * alongside them, so the in-progress week is not offered — with one exception.
 * On its final day the week is done in every way that matters here: the
 * invoices are in, the manager enters them that Sunday, and Monday's sales sync
 * then lands against a week already costed.
 *
 * Sunday is judged in Europe/London, not the server's clock — a UTC box is an
 * hour behind British Summer Time and would open the week an hour late.
 */
export function latestReportWeekStart(now = new Date()): string {
  const today = parseISODate(londonISODate(now));
  const thisMonday = startOfISOWeek(today);
  return toISODate(today.getDay() === 0 ? thisMonday : addDays(thisMonday, -7));
}

/**
 * The weeks a report may be started for: everything VM has synced, PLUS the
 * most recent Mondays generated locally, and nothing newer than
 * `latestReportWeekStart`.
 *
 * `vm_v_available_weeks` only holds weeks the sales sync has landed, so without
 * the local half the Sunday week — and any week the sync is late on — would be
 * missing. Costs are enterable before sales exist; the summary simply reads its
 * margins against zero until the week syncs, and says so.
 */
export function reportWeekOptions(
  vmWeeks: WeekOption[],
  localCount = 8,
  now = new Date(),
): WeekOption[] {
  const latest = latestReportWeekStart(now);
  const byIso = new Map(
    vmWeeks.filter((w) => w.week_start_iso <= latest).map((w) => [w.week_start_iso, w]),
  );
  let monday = parseISODate(latest);
  for (let i = 0; i < localCount; i++) {
    const iso = toISODate(monday);
    if (!byIso.has(iso)) {
      byIso.set(iso, {
        week_start: iso,
        week_end: toISODate(addDays(parseISODate(iso), 6)),
        week_start_iso: iso,
      });
    }
    monday = addDays(monday, -7);
  }
  return Array.from(byIso.values()).sort((a, b) =>
    b.week_start_iso.localeCompare(a.week_start_iso),
  );
}

/** The requested week, or the newest allowed one when it is out of range. */
export function resolveReportWeek(weeks: WeekOption[], requested?: string): string | null {
  if (requested && weeks.some((w) => w.week_start_iso === requested)) return requested;
  return weeks[0]?.week_start_iso ?? null;
}
