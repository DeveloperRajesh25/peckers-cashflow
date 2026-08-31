"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { writeAudit } from "./audit";
import { sendEmail } from "@/lib/email";
import { mergeSettings } from "@/lib/settings";
import { addDays, parseISODate, toISODate } from "@/lib/utils";
import {
  buildCoverDriverWageLines,
  buildManagerWageLines,
  buildWageLinesForStore,
  cashHoursFromStoreTotal,
  type CoverDriverPayRow,
  type ManagerPayee,
  type ManagerPayRow,
} from "@/lib/cash-flow";
import {
  labourTotal,
  latestReportWeekStart,
  num,
  rollUpInputs,
  round2,
  round4,
  sectionTotals,
  REPORT_SECTIONS,
  type ReportSection,
  type WeeklyReport,
  type WeeklyReportLabourLine,
  type WeeklyReportLine,
  type WeeklyReportSnapshot,
} from "@/lib/weekly-report";
import { generateWeeklySummary } from "@/lib/vm-analytics/weekly-summary";
import { loadVmSales } from "@/lib/weekly-report-sales";
import type { Employee } from "@/lib/types";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

const LINE_COLUMNS =
  "id, report_id, section, label, sort_order, entry_date, qty, unit_rate, amount, vat_amount, note";
const LABOUR_COLUMNS =
  "id, report_id, person_name, source, employee_id, cover_driver_id, manager_id, hours, ni_hours, ni_rate, cash_hours, cash_rate, deliveries, delivery_pay, sort_order";

async function requireStaff(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("The weekly report is restricted to managers and admins.");
  }
  return user;
}

/**
 * A manager may only ever write against the store they are OPERATING AS —
 * never `allowed.store_id`, which is only their home store (migration 020).
 */
function assertStoreAccess(user: SessionUser, storeId: string) {
  if (user.allowed!.role === "manager") {
    const active = resolveActiveStoreId(user.allowed);
    if (!active) throw new Error("No store assigned to your account.");
    if (storeId !== active) {
      throw new Error("You can only edit the weekly report for the store you're managing.");
    }
  }
}

function revalidateWeeklyReport() {
  for (const p of [
    "/vm-analytics/weekly-summary",
    "/manager/weekly-report",
    "/settings",
  ]) {
    revalidatePath(p);
  }
}

function weekEndOf(weekStart: string): string {
  return toISODate(addDays(parseISODate(weekStart), 6));
}

async function loadReportRow(
  supabase: SupabaseClient,
  reportId: string,
): Promise<WeeklyReport> {
  const { data, error } = await supabase
    .from("weekly_reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Report not found.");
  return data as WeeklyReport;
}

/** A locked or sent report is a frozen record — nothing about it may be edited. */
function assertEditable(report: WeeklyReport) {
  if (report.status !== "draft") {
    throw new Error(
      "This report is locked. An admin must unlock it before it can be edited.",
    );
  }
}

// =============================================================
// Reading
// =============================================================

export type WeeklyReportBundle = {
  report: WeeklyReport | null;
  lines: WeeklyReportLine[];
  labour: WeeklyReportLabourLine[];
  /** A failed query must never read as "no costs this week". */
  load_error: string | null;
};

export async function loadWeeklyReport(input: {
  store_id: string;
  week_start: string;
}): Promise<WeeklyReportBundle> {
  await requireStaff();
  const supabase = createServerSupabase();

  const { data: reportRow, error: reportErr } = await supabase
    .from("weekly_reports")
    .select("*")
    .eq("store_id", input.store_id)
    .eq("week_start", input.week_start)
    .maybeSingle();

  const report = (reportRow ?? null) as WeeklyReport | null;

  if (!report) {
    return {
      report: null,
      lines: [],
      labour: [],
      load_error: reportErr?.message ?? null,
    };
  }

  const [linesRes, labourRes] = await Promise.all([
    supabase
      .from("weekly_report_lines")
      .select(LINE_COLUMNS)
      .eq("report_id", report.id)
      .order("section")
      .order("sort_order")
      .order("created_at"),
    supabase
      .from("weekly_report_labour_lines")
      .select(LABOUR_COLUMNS)
      .eq("report_id", report.id)
      .order("sort_order")
      .order("created_at"),
  ]);

  return {
    report,
    lines: (linesRes.data ?? []) as WeeklyReportLine[],
    labour: (labourRes.data ?? []) as WeeklyReportLabourLine[],
    load_error: reportErr?.message ?? linesRes.error?.message ?? labourRes.error?.message ?? null,
  };
}

/**
 * Completed days in the week that nobody has signed off. The prefill pulls
 * APPROVED hours only, so a half-approved week would otherwise read as a cheap
 * week — the same reasoning as "a failed query must not read as nobody worked".
 */
async function countUnapprovedDays(
  supabase: SupabaseClient,
  storeId: string,
  weekStart: string,
): Promise<number> {
  const weekEnd = weekEndOf(weekStart);
  const [empRes, coverRes, mgrRes] = await Promise.all([
    supabase
      .from("clock_events")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .gte("event_date", weekStart)
      .lte("event_date", weekEnd)
      .not("clock_in_at", "is", null)
      .not("clock_out_at", "is", null)
      .eq("hours_approved", false),
    supabase
      .from("cover_driver_hours_computed")
      .select("cover_driver_id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .gte("work_date", weekStart)
      .lte("work_date", weekEnd)
      .eq("approved", false),
    supabase
      .from("manager_clock_events")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .gte("event_date", weekStart)
      .lte("event_date", weekEnd)
      .not("clock_out_at", "is", null)
      .eq("deliveries_approved", false),
  ]);
  return (empRes.count ?? 0) + (coverRes.count ?? 0) + (mgrRes.count ?? 0);
}

// =============================================================
// Creating and seeding
// =============================================================

/**
 * Open a store's week, creating the draft if it does not exist yet.
 *
 * `seed_from_previous` copies the PREVIOUS week's structure — every label,
 * unit_rate and sort_order, with quantities and amounts blank. Exactly what
 * duplicating the spreadsheet does today, and self-maintaining: a supplier added
 * once carries forward without anyone maintaining a template.
 */
export async function ensureWeeklyReport(input: {
  store_id: string;
  week_start: string;
  seed_from_previous?: boolean;
}): Promise<{ ok: true; report_id: string; seeded: number }> {
  const user = await requireStaff();
  assertStoreAccess(user, input.store_id);
  if (input.week_start > latestReportWeekStart()) {
    throw new Error("That week has not finished yet — it opens on its final Sunday.");
  }
  const supabase = createServerSupabase();

  const existing = await supabase
    .from("weekly_reports")
    .select("id")
    .eq("store_id", input.store_id)
    .eq("week_start", input.week_start)
    .maybeSingle();

  let reportId = existing.data?.id as string | undefined;

  if (!reportId) {
    const { data, error } = await supabase
      .from("weekly_reports")
      .insert({
        store_id: input.store_id,
        week_start: input.week_start,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    reportId = data.id as string;
  }

  let seeded = 0;
  if (input.seed_from_previous) seeded = await seedFromPreviousWeek(supabase, reportId, input);

  revalidateWeeklyReport();
  return { ok: true, report_id: reportId, seeded };
}

async function seedFromPreviousWeek(
  supabase: SupabaseClient,
  reportId: string,
  input: { store_id: string; week_start: string },
): Promise<number> {
  // Never seed on top of existing lines — carry-forward is an offer made to an
  // empty week, not a merge.
  const { count } = await supabase
    .from("weekly_report_lines")
    .select("id", { count: "exact", head: true })
    .eq("report_id", reportId);
  if ((count ?? 0) > 0) return 0;

  const prevWeek = toISODate(addDays(parseISODate(input.week_start), -7));
  const { data: prevReport } = await supabase
    .from("weekly_reports")
    .select("id, packaging_costs, marketing, gross_margin_budget_pct, labour_budget_pct")
    .eq("store_id", input.store_id)
    .eq("week_start", prevWeek)
    .maybeSingle();
  if (!prevReport) return 0;

  const { data: prevLines } = await supabase
    .from("weekly_report_lines")
    .select(LINE_COLUMNS)
    .eq("report_id", prevReport.id);

  // Expenses are dated one-offs, not a structure — deliberately not carried.
  const payload = ((prevLines ?? []) as WeeklyReportLine[])
    .filter((l) => l.section !== "expense")
    .map((l) => ({
      report_id: reportId,
      section: l.section,
      label: l.label,
      sort_order: l.sort_order,
      unit_rate: l.unit_rate == null ? null : num(l.unit_rate),
    }));

  // The budget percentages are a standing target, not a weekly figure, so they
  // carry across even though every amount is blanked.
  await supabase
    .from("weekly_reports")
    .update({
      gross_margin_budget_pct: prevReport.gross_margin_budget_pct,
      labour_budget_pct: prevReport.labour_budget_pct,
    })
    .eq("id", reportId);

  if (payload.length === 0) return 0;
  const { error } = await supabase.from("weekly_report_lines").insert(payload);
  if (error) throw new Error(error.message);
  return payload.length;
}

// =============================================================
// Editing
// =============================================================

export async function saveReportHeader(input: {
  report_id: string;
  packaging_costs?: number | null;
  marketing?: number | null;
  gross_margin_budget_pct?: number | null;
  labour_budget_pct?: number | null;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  // A percentage may arrive as 65 or as 0.65 depending on which field wrote it;
  // the column stores decimals, so normalise once here rather than in the UI.
  const pct = (v: number | null | undefined) => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
  };
  const money = (v: number | null | undefined) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? round2(n) : null;
  };

  const { error } = await supabase
    .from("weekly_reports")
    .update({
      packaging_costs: money(input.packaging_costs),
      marketing: money(input.marketing),
      gross_margin_budget_pct: pct(input.gross_margin_budget_pct),
      labour_budget_pct: pct(input.labour_budget_pct),
    })
    .eq("id", input.report_id);
  if (error) throw new Error(error.message);

  revalidateWeeklyReport();
  return { ok: true };
}

export async function saveReportLine(input: {
  report_id: string;
  id?: string | null;
  section: ReportSection;
  label: string;
  sort_order?: number | null;
  entry_date?: string | null;
  qty?: number | null;
  unit_rate?: number | null;
  amount?: number | null;
  vat_amount?: number | null;
  note?: string | null;
}): Promise<{ ok: true; id: string }> {
  const user = await requireStaff();
  if (!REPORT_SECTIONS.includes(input.section)) throw new Error("Unknown section.");
  const label = (input.label ?? "").trim();
  if (!label) throw new Error("A line needs a label.");

  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  const qty = input.qty == null ? null : Number(input.qty);
  const unitRate = input.unit_rate == null ? null : Number(input.unit_rate);
  // The stored amount is authoritative: a rate edited next week must not
  // restate a line already entered.
  const amount =
    input.amount != null
      ? round2(Number(input.amount) || 0)
      : qty != null && unitRate != null
        ? round2(qty * unitRate)
        : null;

  const payload = {
    report_id: input.report_id,
    section: input.section,
    label,
    sort_order: input.sort_order ?? 0,
    entry_date: input.entry_date || null,
    qty,
    unit_rate: unitRate,
    amount,
    // Null is meaningful: it means "the standard rate on the amount", which is
    // what every line entered before this column existed still gets.
    vat_amount: input.vat_amount == null ? null : round2(Number(input.vat_amount) || 0),
    note: input.note?.trim() || null,
  };

  if (input.id) {
    const { error } = await supabase
      .from("weekly_report_lines")
      .update(payload)
      .eq("id", input.id)
      .eq("report_id", input.report_id);
    if (error) throw new Error(error.message);
    revalidateWeeklyReport();
    return { ok: true, id: input.id };
  }

  const { data, error } = await supabase
    .from("weekly_report_lines")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidateWeeklyReport();
  return { ok: true, id: data.id as string };
}

export async function deleteReportLine(input: {
  report_id: string;
  id: string;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  const { error } = await supabase
    .from("weekly_report_lines")
    .delete()
    .eq("id", input.id)
    .eq("report_id", input.report_id);
  if (error) throw new Error(error.message);
  revalidateWeeklyReport();
  return { ok: true };
}

export async function reorderReportLines(input: {
  report_id: string;
  ordered_ids: string[];
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  for (const [index, id] of input.ordered_ids.entries()) {
    const { error } = await supabase
      .from("weekly_report_lines")
      .update({ sort_order: index })
      .eq("id", id)
      .eq("report_id", input.report_id);
    if (error) throw new Error(error.message);
  }
  revalidateWeeklyReport();
  return { ok: true };
}

export async function saveLabourLine(input: {
  report_id: string;
  id?: string | null;
  person_name: string;
  source?: "employee" | "cover_driver" | "manager" | "adhoc";
  hours?: number | null;
  ni_hours?: number | null;
  ni_rate?: number | null;
  cash_hours?: number | null;
  cash_rate?: number | null;
  deliveries?: number | null;
  delivery_pay?: number | null;
  sort_order?: number | null;
}): Promise<{ ok: true; id: string }> {
  const user = await requireStaff();
  const name = (input.person_name ?? "").trim();
  if (!name) throw new Error("A labour line needs a name.");

  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  // Bounded like every other hours input in the app: a week is 168 hours, and a
  // typo of 800 must not reach the P&L.
  const hrs = (v: number | null | undefined) => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return round2(Math.min(n, 168));
  };
  const money = (v: number | null | undefined) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? round2(Math.max(0, n)) : null;
  };
  // Rates carry 4dp: a manager's is a fixed daily wage divided by the hours they
  // clocked, and 2dp of that drifts against the wage it came from.
  const rate = (v: number | null | undefined) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? round4(Math.max(0, n)) : null;
  };

  const payload = {
    report_id: input.report_id,
    person_name: name,
    source: input.source ?? "adhoc",
    hours: hrs(input.hours),
    ni_hours: hrs(input.ni_hours),
    ni_rate: rate(input.ni_rate),
    cash_hours: hrs(input.cash_hours),
    cash_rate: rate(input.cash_rate),
    deliveries: input.deliveries == null ? null : Math.max(0, Math.round(Number(input.deliveries) || 0)),
    delivery_pay: money(input.delivery_pay),
    sort_order: input.sort_order ?? 0,
  };

  if (input.id) {
    // person_name and source are the only fields a manual edit may not move a
    // prefilled row off — everything else is a correction, which is the point.
    const { error } = await supabase
      .from("weekly_report_labour_lines")
      .update(payload)
      .eq("id", input.id)
      .eq("report_id", input.report_id);
    if (error) throw new Error(error.message);
    revalidateWeeklyReport();
    return { ok: true, id: input.id };
  }

  const { data, error } = await supabase
    .from("weekly_report_labour_lines")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  revalidateWeeklyReport();
  return { ok: true, id: data.id as string };
}

export async function deleteLabourLine(input: {
  report_id: string;
  id: string;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  const { error } = await supabase
    .from("weekly_report_labour_lines")
    .delete()
    .eq("id", input.id)
    .eq("report_id", input.report_id);
  if (error) throw new Error(error.message);
  revalidateWeeklyReport();
  return { ok: true };
}

// =============================================================
// Labour prefill
// =============================================================

/**
 * Write one labour line per person who worked the report's week at its store.
 *
 * THREE TRAPS, all of them load-bearing:
 *
 *  1. The payout pays a DIFFERENT week. `payWeekOf(w)` returns `w − 7 days`, so
 *     the Tuesday sheet for week W settles work done in W−7. This report wants
 *     the labour worked in ITS OWN week, so it reads approved hours for
 *     `report.week_start` directly and never goes near the payout screen.
 *  2. The payout is cash-only; the P&L figure is not. The Tuesday sheet excludes
 *     NI/bank hours (they go through PAYE), but `Labour Cost`!K20 is the FULL
 *     cost. So the NI half is added back here — same hours, both halves priced.
 *  3. Unapproved days are invisible to it. Only approved hours are pulled, so
 *     the page banners a week that still has days waiting on Daily Approval.
 *
 * A prefill WRITES ROWS the manager then corrects. It is not a live join, for
 * the same reason a payout freezes rather than recomputes.
 */
export async function prefillLabour(input: {
  report_id: string;
}): Promise<{ ok: true; lines: number; unapproved_days: number }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  const storeId = report.store_id;
  const weekStart = report.week_start;
  const weekEnd = weekEndOf(weekStart);

  const [employeesRes, clocksRes, coverRes, managersRes, managerClocksRes] =
    await Promise.all([
      // Leavers included: someone marked "left" still worked the week being
      // costed. All stores' employees are candidates — staff cross-cover.
      supabase.from("employees").select("*"),
      // The whole week across ALL stores: the NI/cash split is per EMPLOYEE,
      // not per store, so it must see the full week to attribute cash hours to
      // the store they were worked at.
      supabase
        .from("clock_events")
        .select(
          "employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, hours_approved, approved_hours, approved_short_deliveries_count, approved_long_deliveries_count, approved_extra_short_deliveries, approved_extra_long_deliveries",
        )
        .gte("event_date", weekStart)
        .lte("event_date", weekEnd),
      supabase
        .from("cover_driver_hours_computed")
        .select(
          "cover_driver_id, driver_name, store_id, work_date, total_hours_worked, hourly_rate_snapshot, short_deliveries, long_deliveries, extra_short_deliveries, extra_long_deliveries, short_rate_snapshot, long_rate_snapshot, approved",
        )
        .eq("store_id", storeId)
        .eq("approved", true)
        .gte("work_date", weekStart)
        .lte("work_date", weekEnd),
      supabase
        .from("allowed_users")
        .select(
          "id, name, fixed_daily_wage, short_delivery_rate, long_delivery_rate, extra_short_delivery_rate, extra_long_delivery_rate",
        )
        .eq("role", "manager"),
      supabase
        .from("manager_clock_events")
        .select(
          "manager_id, store_id, event_date, clock_in_at, worked_hours, approved_short_deliveries_count, approved_long_deliveries_count, approved_extra_short_deliveries, approved_extra_long_deliveries",
        )
        .eq("store_id", storeId)
        .gte("event_date", weekStart)
        .lte("event_date", weekEnd),
    ]);

  const loadError =
    employeesRes.error?.message ??
    clocksRes.error?.message ??
    coverRes.error?.message ??
    managerClocksRes.error?.message ??
    null;
  if (loadError) throw new Error(`Couldn't read the week's hours: ${loadError}`);

  const employees = (employeesRes.data ?? []) as Employee[];
  const clocks = clocksRes.data ?? [];

  // The cash + delivery halves come from the SAME builder the Tuesday payout
  // uses, so the two can never disagree about what a week's cash was worth.
  const cashLines = new Map(
    buildWageLinesForStore(storeId, employees, clocks).map((l) => [l.employee_id, l]),
  );

  const payload: Array<Record<string, unknown>> = [];
  let sort = 0;

  for (const emp of employees) {
    const hoursAtStore = round2(
      clocks
        .filter((c) => c.employee_id === emp.id && c.store_id === storeId && c.clock_in_at)
        .reduce((t, c) => t + (Number(c.approved_hours) || 0), 0),
    );
    const wage = cashLines.get(emp.id);
    if (hoursAtStore <= 0 && !wage) continue;

    // The one rule that must not be restated: cashHoursFromStoreTotal is the
    // exported home-store NI rule the payout itself calls.
    const cashHours = wage
      ? Number(wage.cash_hours) || 0
      : round2(cashHoursFromStoreTotal(hoursAtStore, storeId, emp));
    const niHours = round2(Math.max(0, hoursAtStore - cashHours));

    payload.push({
      report_id: input.report_id,
      person_name: emp.name,
      source: "employee",
      employee_id: emp.id,
      hours: hoursAtStore,
      ni_hours: niHours,
      ni_rate: emp.hourly_ni_rate != null ? Number(emp.hourly_ni_rate) : Number(emp.hourly_rate) || 0,
      cash_hours: cashHours,
      cash_rate: wage ? Number(wage.cash_rate) || 0 : Number(emp.hourly_cash_rate) || 0,
      deliveries: wage
        ? (wage.short_deliveries_count ?? 0) +
          (wage.long_deliveries_count ?? 0) +
          (wage.short_misc_count ?? 0) +
          (wage.long_misc_count ?? 0)
        : 0,
      delivery_pay: wage ? Number(wage.delivery_wages) || 0 : 0,
      sort_order: sort++,
    });
  }

  // Cash only, and paid from the rates SNAPSHOTTED at approval — never the
  // driver's current profile, or a rate change would restate an approved week.
  for (const line of buildCoverDriverWageLines(
    storeId,
    (coverRes.data ?? []) as CoverDriverPayRow[],
  )) {
    payload.push({
      report_id: input.report_id,
      person_name: line.employee_name,
      source: "cover_driver",
      cover_driver_id: line.cover_driver_id,
      hours: Number(line.cash_hours) || 0,
      ni_hours: 0,
      ni_rate: 0,
      cash_hours: Number(line.cash_hours) || 0,
      cash_rate: Number(line.cash_rate) || 0,
      deliveries:
        (line.short_deliveries_count ?? 0) +
        (line.long_deliveries_count ?? 0) +
        (line.short_misc_count ?? 0) +
        (line.long_misc_count ?? 0),
      delivery_pay: Number(line.delivery_wages) || 0,
      sort_order: sort++,
    });
  }

  // A manager's cost is their FIXED DAILY WAGE for the days they clocked, plus
  // the per-drop allowance for rounds they covered. The sheet has no flat-amount
  // column — the workbook's K20 is NI + cash + delivery — so the wage is carried
  // as their EFFECTIVE hourly rate over the hours they actually worked: the
  // money is identical, and the Hours worked column stays true.
  // Deliveries-only rows (migration 037) carry a null clock_in_at and are
  // correctly not a day worked.
  const managerDays = new Map<string, { days: number; hours: number }>();
  for (const d of managerClocksRes.data ?? []) {
    if (!d.clock_in_at) continue;
    const acc = managerDays.get(d.manager_id) ?? { days: 0, hours: 0 };
    acc.days += 1;
    acc.hours += Number(d.worked_hours) || 0;
    managerDays.set(d.manager_id, acc);
  }
  const managers = (managersRes.data ?? []) as Array<
    ManagerPayee & { fixed_daily_wage: number | null }
  >;
  const managerDelivery = new Map(
    buildManagerWageLines(
      storeId,
      managers,
      (managerClocksRes.data ?? []) as ManagerPayRow[],
    ).map((l) => [l.manager_id!, l]),
  );

  for (const mgr of managers) {
    const worked = managerDays.get(mgr.id);
    const delivery = managerDelivery.get(mgr.id);
    if (!worked && !delivery) continue;
    const hours = worked ? round2(worked.hours) : 0;
    const wage = worked ? round2(worked.days * (Number(mgr.fixed_daily_wage) || 0)) : 0;
    // A day still open has no hours yet, so there is no rate to divide into.
    // The row lands at zero rather than inventing one, and the manager corrects
    // it — the same reason nothing here reads the rota.
    payload.push({
      report_id: input.report_id,
      person_name: mgr.name ?? "Manager",
      source: "manager",
      manager_id: mgr.id,
      hours,
      ni_hours: hours,
      ni_rate: hours > 0 ? round4(wage / hours) : 0,
      cash_hours: 0,
      cash_rate: 0,
      deliveries: delivery
        ? (delivery.short_deliveries_count ?? 0) +
          (delivery.long_deliveries_count ?? 0) +
          (delivery.short_misc_count ?? 0) +
          (delivery.long_misc_count ?? 0)
        : 0,
      delivery_pay: delivery ? Number(delivery.delivery_wages) || 0 : 0,
      sort_order: sort++,
    });
  }

  // Replace the prefilled rows only. An ad-hoc worker typed in by hand has no
  // clock record to re-derive them from, so re-running the prefill must leave
  // them exactly where they are.
  const { error: delErr } = await supabase
    .from("weekly_report_labour_lines")
    .delete()
    .eq("report_id", input.report_id)
    .neq("source", "adhoc");
  if (delErr) throw new Error(delErr.message);

  if (payload.length > 0) {
    const { error } = await supabase.from("weekly_report_labour_lines").insert(payload);
    if (error) throw new Error(error.message);
  }

  const unapproved = await countUnapprovedDays(supabase, storeId, weekStart);
  await writeAudit({
    action: "weekly_report_prefill_labour",
    entity: "weekly_reports",
    entity_id: input.report_id,
    changes: { lines: payload.length, unapproved_days: unapproved },
  });

  revalidateWeeklyReport();
  return { ok: true, lines: payload.length, unapproved_days: unapproved };
}

// =============================================================
// Lock, unlock, send
// =============================================================

async function computeSnapshot(
  supabase: SupabaseClient,
  report: WeeklyReport,
): Promise<WeeklyReportSnapshot> {
  const [{ data: store }, linesRes, labourRes] = await Promise.all([
    supabase.from("stores").select("vm_store_name").eq("id", report.store_id).maybeSingle(),
    supabase.from("weekly_report_lines").select(LINE_COLUMNS).eq("report_id", report.id),
    supabase
      .from("weekly_report_labour_lines")
      .select(LABOUR_COLUMNS)
      .eq("report_id", report.id),
  ]);
  if (linesRes.error) throw new Error(linesRes.error.message);
  if (labourRes.error) throw new Error(labourRes.error.message);

  const lines = (linesRes.data ?? []) as WeeklyReportLine[];
  const labour = (labourRes.data ?? []) as WeeklyReportLabourLine[];
  // Sales are re-read here, not taken from the client: a frozen figure must be
  // one the server saw.
  const sales = await loadVmSales(store?.vm_store_name ?? null, report.week_start);

  return {
    gross_sales: sales.gross_sales,
    net_sales: sales.net_sales,
    inputs: rollUpInputs(report, lines, labour),
    section_totals: sectionTotals(lines),
    labour_total: labourTotal(labour),
    locked_at: new Date().toISOString(),
  };
}

/**
 * Freeze the week. Lines become read-only and `snapshot` records the sales plus
 * every derived figure as they stand right now, so a rate changed in August
 * cannot restate a report mailed in June. Unlock is admin-only.
 */
export async function lockWeeklyReport(input: {
  report_id: string;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  if (report.status !== "draft") throw new Error("This report is already locked.");

  const snapshot = await computeSnapshot(supabase, report);
  const { error } = await supabase
    .from("weekly_reports")
    .update({
      status: "locked",
      snapshot,
      locked_at: snapshot.locked_at,
      locked_by: user.id,
    })
    .eq("id", input.report_id)
    .eq("status", "draft");
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "weekly_report_lock",
    entity: "weekly_reports",
    entity_id: input.report_id,
    changes: { week_start: report.week_start, store_id: report.store_id },
  });
  revalidateWeeklyReport();
  return { ok: true };
}

/** Admin only — the single privileged act, matching a confirmed cash_payouts row. */
export async function unlockWeeklyReport(input: {
  report_id: string;
  reason?: string | null;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  if (user.allowed!.role !== "admin") {
    throw new Error("Only an admin can unlock a report.");
  }
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);

  // The snapshot is deliberately KEPT: it is the record of what was sent, and
  // the Summary tab compares the regenerated draft against it.
  const { error } = await supabase
    .from("weekly_reports")
    .update({ status: "draft", locked_at: null, locked_by: null })
    .eq("id", input.report_id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "weekly_report_unlock",
    entity: "weekly_reports",
    entity_id: input.report_id,
    changes: { week_start: report.week_start, reason: input.reason ?? null },
  });
  revalidateWeeklyReport();
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gbp(n: number): string {
  return `£${(Number(n) || 0).toFixed(2)}`;
}

function pct(n: number | undefined): string {
  return n == null ? "—" : `${(n * 100).toFixed(2)}%`;
}

function summaryHtml(
  storeName: string,
  weekStart: string,
  snapshot: WeeklyReportSnapshot,
): string {
  const summary = generateWeeklySummary(
    { gross_sales: snapshot.gross_sales, net_sales: snapshot.net_sales },
    snapshot.inputs,
  );
  const rows = summary.metrics
    .map(
      (m) =>
        `<tr>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(m.entity)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${gbp(m.actual ?? 0)}${
          m.actual_pct != null
            ? `<br><span style="color:#777;font-size:12px;">${pct(m.actual_pct)}</span>`
            : ""
        }</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${
          m.budget != null ? gbp(m.budget) : "—"
        }</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${
          m.variance != null ? gbp(m.variance) : "—"
        }</td>` +
        `</tr>`,
    )
    .join("");

  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;">` +
    `<h2 style="margin:0 0 4px;">Weekly Report — ${escapeHtml(storeName)}</h2>` +
    `<p style="color:#666;margin:0 0 16px;font-size:14px;">Week commencing ${escapeHtml(weekStart)}. ` +
    `Figures frozen at lock; they will not change if a rate is edited later.</p>` +
    `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;">` +
    `<thead><tr style="background:#fafafa;">` +
    `<th style="padding:8px 12px;text-align:left;">Entity</th>` +
    `<th style="padding:8px 12px;text-align:right;">Actual</th>` +
    `<th style="padding:8px 12px;text-align:right;">Budget</th>` +
    `<th style="padding:8px 12px;text-align:right;">Variance</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#888;font-size:12px;margin-top:16px;">` +
    `Note: Occupancy totals every line entered. The spreadsheet this replaces summed from its ` +
    `second row down, leaving the first cost out — so occupancy here reads slightly higher than the ` +
    `old workbook did for the same week.</p>` +
    `</div>`
  );
}

/**
 * Mail the locked report to the superiors.
 *
 * The manager owns the week end to end — they enter it, freeze it and send it,
 * without waiting on an admin (unlock is the only privileged act). It is the
 * LOCK that gates this: a draft is not a frozen snapshot, so what the superiors
 * read could change under them.
 *
 * Refuses an empty recipient list LOUDLY rather than no-opping — a send that
 * silently reached nobody is worse than one that failed.
 */
export async function sendWeeklyReport(input: {
  report_id: string;
}): Promise<{ ok: true; recipients: string[] }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);

  const [{ data: settingsRows }, { data: store }] = await Promise.all([
    supabase.from("app_settings").select("key, value"),
    supabase.from("stores").select("name").eq("id", report.store_id).maybeSingle(),
  ]);
  const settings = mergeSettings(settingsRows ?? []).weekly_report;

  if (settings.require_lock_to_send && report.status === "draft") {
    throw new Error("Lock the report before sending it — a draft can still change.");
  }

  const recipients = Array.from(
    new Set([...settings.recipients, ...settings.cc].map((r) => r.trim()).filter(Boolean)),
  );
  if (recipients.length === 0) {
    throw new Error(
      "No recipients configured. Add the superiors' email addresses in Settings → Weekly Report.",
    );
  }

  // A draft that is allowed to send has no snapshot, so compute one for the
  // email without freezing the report.
  const snapshot = report.snapshot ?? (await computeSnapshot(supabase, report));
  const storeName = store?.name ?? "Peckers";

  const result = await sendEmail({
    recipients,
    subject: `Weekly Report — ${storeName} — w/c ${report.week_start}`,
    html: summaryHtml(storeName, report.week_start, snapshot),
    text: `Weekly Report for ${storeName}, week commencing ${report.week_start}.`,
  });
  if (!result.sent) throw new Error(`Couldn't send: ${result.reason ?? "unknown error"}`);

  const { error } = await supabase
    .from("weekly_reports")
    .update({
      status: report.status === "draft" ? "draft" : "sent",
      sent_at: new Date().toISOString(),
      sent_by: user.id,
      sent_to: recipients,
    })
    .eq("id", input.report_id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "weekly_report_send",
    entity: "weekly_reports",
    entity_id: input.report_id,
    changes: { week_start: report.week_start, recipients },
  });
  revalidateWeeklyReport();
  return { ok: true, recipients };
}

// =============================================================
// Legacy import
// =============================================================

/**
 * Pull a `weekly_summary_inputs` row (the old ten hand-typed scalars, in the VM
 * project) into this report as header scalars plus one line per section total.
 *
 * Offered rather than run automatically: the two live in SEPARATE Supabase
 * projects, so this cannot be a SQL migration, and the VM-side client is
 * anonymous (see migration 048's header), which makes "how many rows are really
 * there" a question only a human pressing the button can answer.
 */
export async function importLegacyWeeklyInputs(input: {
  report_id: string;
}): Promise<{ ok: true; imported: boolean }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const report = await loadReportRow(supabase, input.report_id);
  assertStoreAccess(user, report.store_id);
  assertEditable(report);

  const { data: store } = await supabase
    .from("stores")
    .select("vm_store_name")
    .eq("id", report.store_id)
    .maybeSingle();
  if (!store?.vm_store_name) return { ok: true, imported: false };

  const { getWeeklySummaryInputs } = await import("@/lib/vm-analytics/queries");
  let legacy: Awaited<ReturnType<typeof getWeeklySummaryInputs>> = null;
  try {
    legacy = await getWeeklySummaryInputs(store.vm_store_name, report.week_start);
  } catch {
    legacy = null;
  }
  if (!legacy) return { ok: true, imported: false };

  await supabase
    .from("weekly_reports")
    .update({
      packaging_costs: num(legacy.packaging_costs),
      marketing: num(legacy.marketing),
      gross_margin_budget_pct: num(legacy.gross_margin_budget_pct),
      labour_budget_pct: num(legacy.labour_budget_pct),
    })
    .eq("id", input.report_id);

  // Each old scalar becomes ONE line labelled as an import, so the figure is
  // visible and editable on its own tab instead of being an untouchable header.
  const seeds = (
    [
      { section: "cogs_supplier", amount: num(legacy.cogs) },
      { section: "fillings", amount: num(legacy.fillings_and_samosas) },
      { section: "occupancy", amount: num(legacy.occupancy_cost) },
      { section: "aggregator", amount: num(legacy.aggregator_costs) },
      { section: "cogs_hitchin", amount: num(legacy.cogs_hitchin) },
    ] satisfies Array<{ section: ReportSection; amount: number }>
  ).filter((s) => s.amount !== 0);

  if (seeds.length > 0) {
    const { error } = await supabase.from("weekly_report_lines").insert(
      seeds.map((s) => ({
        report_id: input.report_id,
        section: s.section,
        label: "Imported from Weekly Summary",
        amount: round2(s.amount),
        sort_order: -1,
        note: "Carried over from the old single-figure form",
      })),
    );
    if (error) throw new Error(error.message);
  }

  // The old form held ONE labour figure with no hours behind it, and the sheet
  // has no flat-amount column. It lands as a single hour at the total, named so
  // nobody mistakes it for someone's week — the manager replaces it by
  // prefilling.
  if (num(legacy.labour_cost) !== 0) {
    await supabase.from("weekly_report_labour_lines").insert({
      report_id: input.report_id,
      person_name: "Imported labour total (no per-person detail)",
      source: "adhoc",
      hours: 1,
      ni_hours: 1,
      ni_rate: round2(num(legacy.labour_cost)),
      sort_order: -1,
    });
  }

  await writeAudit({
    action: "weekly_report_import_legacy",
    entity: "weekly_reports",
    entity_id: input.report_id,
    changes: { week_start: report.week_start, lines: seeds.length },
  });
  revalidateWeeklyReport();
  return { ok: true, imported: true };
}
