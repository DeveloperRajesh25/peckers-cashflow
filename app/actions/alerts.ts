"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import {
  addDays,
  dayWorkedHours,
  formatDDMMYYYY,
  formatHoursMinsWords,
  startOfISOWeek,
  toISODate,
  parseISODate,
  londonHHMM,
  londonISODate,
  timeToMinutes,
  shiftHours,
  percentDelta,
  weekdayIndex,
} from "@/lib/utils";
import { autoCloseOpenClocks } from "@/lib/auto-clock-out";
import { mergeSettings, type AppSettings } from "@/lib/settings";
import {
  buildCoverDriverWageLines,
  buildManagerWageLines,
  buildPrePaymentSummary,
  buildWageLinesForStore,
  payWeekOf,
  supermarketCashAmount,
  type CoverDriverPayRow,
  type ManagerPayee,
  type ManagerPayRow,
} from "@/lib/cash-flow";
import { wageComplianceForEmployee } from "@/lib/compliance";
import { isCredentialEmail } from "@/lib/credentials";
import { sendAlertDigest } from "@/lib/email";
import type { AlertType, AlertSeverity, SystemAlert } from "@/lib/types";
import { hasRole, resolveActiveStoreId } from "@/lib/types";
import { ALERTS_MAX_ROWS, ALERTS_PAGE_SIZE, type AlertsPage } from "@/lib/alerts-paging";

async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

// A newly-created alert collected during a scan, for the email digest.
type NewAlert = {
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
};

// =============================================================
// Alert helpers
// =============================================================

async function upsertAlert(
  supabase: SupabaseClient,
  input: {
    alert_type: AlertType;
    severity?: AlertSeverity;
    store_id?: string | null;
    employee_id?: string | null;
    shift_id?: string | null;
    /** The day (or week) the alert is ABOUT, where that is what makes it
     *  distinct. created_at is when it was noticed, which is not the same. */
    subject_date?: string | null;
    title: string;
    message: string;
    payload?: Record<string, unknown> | null;
  },
  collector?: NewAlert[],
): Promise<{ id: string | null; failed: boolean }> {
  const findOpen = async () => {
    let q = supabase
      .from("alerts")
      .select("id")
      .eq("alert_type", input.alert_type)
      .eq("resolved", false);
    for (const [col, val] of [
      ["store_id", input.store_id],
      ["employee_id", input.employee_id],
      ["shift_id", input.shift_id],
      ["subject_date", input.subject_date],
    ] as const) {
      q = val ? q.eq(col, val) : q.is(col, null);
    }
    // limit(1), not maybeSingle: a broken key left duplicates behind before
    // migration 054, and erroring on them would keep the scan from settling.
    const { data } = await q.order("created_at", { ascending: false }).limit(1);
    return data?.[0]?.id ?? null;
  };

  const applyTo = async (id: string) => {
    // severity too: an alert that escalates from warning to critical kept the
    // old badge, because only the text was ever refreshed.
    await supabase
      .from("alerts")
      .update({
        severity: input.severity ?? "warning",
        message: input.message,
        payload: input.payload ?? null,
        title: input.title,
      })
      .eq("id", id);
  };

  // Don't create a duplicate open alert. Each key column is matched with `is`
  // when it's null: a sentinel UUID compared with `eq` never matches a NULL
  // column, so every store-level alert and every alert without a shift row was
  // re-inserted on each scan instead of being updated in place.
  // store_id is part of the key -- two stores raise the same store-level alert.
  // So is subject_date (migration 053): the cash and delivery alerts carry
  // neither an employee nor a shift, so without it every date of the week
  // collapsed onto one row per store and each new day overwrote the last.
  const existingId = await findOpen();
  if (existingId) {
    await applyTo(existingId);
    return { id: existingId, failed: false };
  }

  const { data, error } = await supabase
    .from("alerts")
    .insert({
      alert_type: input.alert_type,
      severity: input.severity ?? "warning",
      store_id: input.store_id ?? null,
      employee_id: input.employee_id ?? null,
      shift_id: input.shift_id ?? null,
      subject_date: input.subject_date ?? null,
      title: input.title,
      message: input.message,
      payload: input.payload ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // Migration 054's partial unique index makes the race lose here rather than
    // duplicating. The other scan's row IS the alert, so adopt it and apply
    // this scan's figures -- dropping the write would leave the board showing
    // whichever of two near-simultaneous reads happened to land first.
    if (String(error.message).toLowerCase().includes("duplicate")) {
      const winnerId = await findOpen();
      if (winnerId) {
        await applyTo(winnerId);
        return { id: winnerId, failed: false };
      }
    }
    // Anything else is a write that silently did not happen. An alert nobody
    // can see is indistinguishable from a condition that never occurred, so
    // the count is carried back to the caller rather than swallowed here.
    console.error("[alerts] insert error", error.message);
    return { id: null, failed: true };
  }

  if (data?.id && collector) {
    collector.push({
      alert_type: input.alert_type,
      severity: input.severity ?? "warning",
      title: input.title,
      message: input.message,
    });
  }
  return { id: data?.id ?? null, failed: false };
}

/**
 * One page of alerts. Filtering happens here rather than in the browser: a page
 * of 10 filtered client-side would render two rows and count the badge off what
 * happened to be loaded.
 */
export async function listAlerts(input: {
  page: number;
  pageSize?: number;
  storeId?: string | null;
  includeResolved: boolean;
}): Promise<AlertsPage> {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  // A manager's scope is theirs to see, not theirs to choose — a server action
  // is a public endpoint, so re-derive it here rather than trusting the arg.
  const storeId =
    user.allowed!.role === "manager"
      ? resolveActiveStoreId(user.allowed)
      : input.storeId || null;

  const pageSize = input.pageSize ?? ALERTS_PAGE_SIZE;
  const page = Math.max(1, Math.floor(input.page) || 1);
  const offset = (page - 1) * pageSize;

  // The reachable window is the newest ALERTS_MAX_ROWS rows, so a page starting
  // past it has nothing to fetch and the end index is clamped to the cap.
  if (offset >= ALERTS_MAX_ROWS) {
    return { rows: [], total: ALERTS_MAX_ROWS, openCount: 0, openCountCapped: false };
  }
  const rangeEnd = Math.min(offset + pageSize, ALERTS_MAX_ROWS) - 1;

  let rowsQuery = supabase.from("alerts").select("*", { count: "exact" });
  if (storeId) rowsQuery = rowsQuery.eq("store_id", storeId);
  if (!input.includeResolved) rowsQuery = rowsQuery.eq("resolved", false);

  let openQuery = supabase
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("resolved", false);
  if (storeId) openQuery = openQuery.eq("store_id", storeId);

  const [rowsRes, openRes] = await Promise.all([
    rowsQuery
      .order("resolved")
      .order("created_at", { ascending: false })
      // Tiebreaker: created_at collides on rows written by one scan, and an
      // unstable order across pages duplicates or skips them.
      .order("id")
      .range(offset, rangeEnd),
    openQuery,
  ]);

  if (rowsRes.error) throw new Error(rowsRes.error.message);
  if (openRes.error) throw new Error(openRes.error.message);

  const realOpen = openRes.count ?? 0;

  return {
    rows: (rowsRes.data ?? []) as SystemAlert[],
    total: Math.min(rowsRes.count ?? 0, ALERTS_MAX_ROWS),
    openCount: Math.min(realOpen, ALERTS_MAX_ROWS),
    openCountCapped: realOpen > ALERTS_MAX_ROWS,
  };
}

export async function resolveAlert(input: { id: string; note?: string | null }) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();
  const { error } = await supabase
    .from("alerts")
    .update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
      resolution_note: input.note?.trim() || null,
    })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    action: "resolve",
    entity: "alert",
    entity_id: input.id,
    changes: { note: input.note ?? null },
  });
  revalidatePath("/alerts");
  revalidatePath("/manager/alerts");
  revalidatePath("/dashboard");
  return { ok: true };
}

// =============================================================
// Resolve email recipients: explicit list from settings, else admin inboxes.
// Manager/employee logins use synthetic emails — never emailed.
// =============================================================
async function resolveRecipients(
  supabase: SupabaseClient,
  settings: AppSettings,
): Promise<string[]> {
  const explicit = settings.email_alerts.recipients.filter(Boolean);
  if (explicit.length) return explicit;
  const { data } = await supabase
    .from("allowed_users")
    .select("email")
    .eq("role", "admin");
  return (data ?? [])
    .map((r: { email: string }) => r.email)
    .filter((e: string) => e && !isCredentialEmail(e));
}

// =============================================================
// Core scan. Client-agnostic so it works with the RLS client (staff "Scan now")
// or the service-role client (auto-scan triggered by an employee clock event).
// Reads thresholds + min-wage bands from app_settings and emails a digest of
// any newly-created alerts when email is enabled.
// =============================================================
async function runScan(
  supabase: SupabaseClient,
): Promise<{ ok: true; created: number; failed: number }> {
  // ONE London "now" for the whole scan. Every date the scan reasons about is a
  // UK business date -- which day's rota, which ISO week, whether it is Tuesday
  // yet -- and the server runs UTC. Update 157 moved the clock-time reads to
  // London but left the date reads on the server, so between 23:00 and midnight
  // UTC during BST the scan compared tomorrow's wall clock against yesterday's
  // roster. Derive both from the same instant, in London, or neither.
  const now = new Date();
  const today = londonISODate(now);
  const nowMinutes = timeToMinutes(londonHHMM(now));
  const nowHour = Number(londonHHMM(now).slice(0, 2));
  // 0=Mon .. 5=Sat .. 6=Sun, off the London date rather than the server's.
  const todayWeekday = weekdayIndex(parseISODate(today));
  const weekStartDate = startOfISOWeek(parseISODate(today));
  const weekStart = toISODate(weekStartDate);
  // Tuesday pays the PREVIOUS Mon–Sun — the wage forecast must use that week.
  const payWeek = payWeekOf(weekStart);
  // Whole ISO weeks, never "the last 28 days". The variance alerts compare this
  // week's SCHEDULE against prior weeks, so both bounds must be week edges: an
  // upper bound of today drops the rota's Thu–Sun and reports a drop nobody
  // scheduled, and a lower bound of today−28 lands mid-week, leaving the oldest
  // baseline week partial and dragging the average down.
  const historyStart = toISODate(addDays(weekStartDate, -28));
  const weekEnd = toISODate(addDays(weekStartDate, 6));

  const [
    shiftsRes,
    clocksRes,
    employeesRes,
    deliveriesRes,
    schedulesRes,
    settingsRes,
    storesRes,
    cashEntriesRes,
    payoutsRes,
    priorPayoutsRes,
    coverRes,
    managersRes,
    managerClocksRes,
  ] = await Promise.all([
      supabase
        .from("rota_shifts")
        .select("*")
        .gte("shift_date", historyStart)
        .lte("shift_date", weekEnd)
        .order("shift_date"),
      supabase
        .from("clock_events")
        .select("*")
        .gte("event_date", historyStart)
        .lte("event_date", weekEnd),
      supabase.from("employees").select("*"),
      supabase
        .from("weekly_deliveries")
        .select("*")
        .gte("week_start_date", historyStart),
      supabase.from("employee_schedules").select("*"),
      supabase.from("app_settings").select("key, value"),
      supabase.from("stores").select("id, name"),
      // Spans BOTH cash windows: the current week feeds the reconciliation
      // alerts, the pay week funds the Tuesday forecast. Bounded at both ends
      // so a mistyped future date can't inflate either.
      supabase
        .from("daily_cash_entries")
        .select("store_id, entry_date, vita_mojo_sales, envelope_amount, difference, reason")
        .gte("entry_date", payWeek.start)
        .lte("entry_date", weekEnd),
      supabase
        .from("cash_payouts")
        .select(
          "id, store_id, week_start_date, status, locked, adjustment_amount, adjustment_reason",
        )
        .eq("week_start_date", weekStart),
      supabase
        .from("cash_payouts")
        .select("store_id, surplus_carry_forward, week_start_date")
        .eq("status", "confirmed")
        .lt("week_start_date", weekStart)
        .order("week_start_date", { ascending: false }),
      // The rest of the payout sheet's wage lines. Fetched estate-wide and
      // filtered per store by the builders, the same way payWeekClocks is --
      // one read for two stores rather than a query pair inside the loop.
      supabase
        .from("cover_driver_hours_computed")
        .select(
          "cover_driver_id, driver_name, store_id, work_date, total_hours_worked, hourly_rate_snapshot, short_deliveries, long_deliveries, extra_short_deliveries, extra_long_deliveries, short_rate_snapshot, long_rate_snapshot, approved",
        )
        .eq("approved", true)
        .gte("work_date", payWeek.start)
        .lte("work_date", payWeek.end),
      supabase
        .from("allowed_users")
        .select(
          "id, name, short_delivery_rate, long_delivery_rate, extra_short_delivery_rate, extra_long_delivery_rate",
        )
        .eq("role", "manager"),
      supabase
        .from("manager_clock_events")
        .select(
          "manager_id, store_id, event_date, approved_short_deliveries_count, approved_long_deliveries_count, approved_extra_short_deliveries, approved_extra_long_deliveries",
        )
        .gte("event_date", payWeek.start)
        .lte("event_date", payWeek.end),
    ]);

  const shifts = shiftsRes.data ?? [];
  const clocks = clocksRes.data ?? [];
  const employees = employeesRes.data ?? [];
  const deliveries = deliveriesRes.data ?? [];
  const schedules = schedulesRes.data ?? [];
  const settings = mergeSettings(settingsRes.data ?? []);
  const t = settings.alert_thresholds;

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const scheduleByKey = new Map(
    schedules.map((s: { employee_id: string; weekday: number }) => [
      `${s.employee_id}:${s.weekday}`,
      s,
    ]),
  );

  const newAlerts: NewAlert[] = [];

  // Ids raised this scan, for the sweeps at the end.
  const touchedIds = new Set<string>();
  // Writes that failed outright. Reported back so a scan that could not record
  // what it found never reads as a scan that found nothing.
  let writeFailures = 0;
  const raise = async (input: Parameters<typeof upsertAlert>[1]) => {
    const { id, failed } = await upsertAlert(supabase, input, newAlerts);
    if (id) touchedIds.add(id);
    if (failed) writeFailures += 1;
  };

  // -------- wage_variance: this-week vs 4-week avg hours per employee --------
  const hoursByEmpWeek = new Map<string, Map<string, number>>();
  for (const s of shifts) {
    if (s.is_day_off) continue;
    const map = hoursByEmpWeek.get(s.employee_id) ?? new Map<string, number>();
    const wk = toISODate(startOfISOWeek(new Date(s.shift_date)));
    map.set(wk, (map.get(wk) ?? 0) + Number(s.scheduled_hours ?? 0));
    hoursByEmpWeek.set(s.employee_id, map);
  }

  // A week nobody has published yet is not a 100% cut to anyone's hours. Until
  // a store's rota exists there is no this-week figure to compare, and treating
  // the absence as zero alerted that store's ENTIRE roster every Monday morning
  // and emailed the lot. Once the rota is up, an employee genuinely left off it
  // still reads as -100% and still alerts, which is the case worth seeing.
  const storesWithRotaThisWeek = new Set(
    shifts
      .filter((s) => s.shift_date >= weekStart && !s.is_day_off)
      .map((s) => s.store_id),
  );

  for (const [empId, weeks] of Array.from(hoursByEmpWeek.entries())) {
    const emp = employeeById.get(empId);
    if (!emp || emp.employment_status !== "active") continue;
    if (!storesWithRotaThisWeek.has(emp.store_id)) continue;
    const thisWeek = weeks.get(weekStart) ?? 0;
    // Sorted, not insertion-ordered: clock_events comes back unordered, so
    // "the last four entries" was four arbitrary weeks.
    const priorWeeks = Array.from(weeks.entries())
      .filter(([wk]) => wk < weekStart)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-4)
      .map(([, h]) => h);
    if (priorWeeks.length < 2) continue;
    const avg = priorWeeks.reduce((a, b) => a + b, 0) / priorWeeks.length;
    const delta = percentDelta(thisWeek, avg);
    if (Math.abs(delta) > t.wage_variance_pct) {
      await raise({
        alert_type: "wage_variance",
        severity: "warning",
        store_id: emp.store_id,
        employee_id: emp.id,
        title: `${emp.name}: hours vary ${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`,
        message: `Scheduled ${formatHoursMinsWords(thisWeek)} this week vs ${formatHoursMinsWords(avg)} 4-week average (>${t.wage_variance_pct}% deviation).`,
        payload: { this_week: thisWeek, avg_4wk: avg, delta_percent: delta },
      });
    }
  }

  // -------- min_wage_violation: rate below legal minimum for age band --------
  if (settings.min_wage_bands.enabled) {
    for (const emp of employees) {
      if (emp.employment_status !== "active") continue;
      const wc = wageComplianceForEmployee(emp, settings.min_wage_bands);
      if (wc && !wc.compliant) {
        await raise({
          alert_type: "min_wage_violation",
          severity: "critical",
          store_id: emp.store_id,
          employee_id: emp.id,
          title: `${emp.name}: pay below minimum wage`,
          message: `On £${wc.rate.toFixed(2)}/h, but the legal minimum for age ${wc.age} is £${wc.required.toFixed(2)}/h (${settings.min_wage_bands.effective_label}). Short by £${wc.shortfall.toFixed(2)}/h.`,
          payload: {
            age: wc.age,
            rate: wc.rate,
            required: wc.required,
            shortfall: wc.shortfall,
          },
        });
      }
    }
  }

  // -------- delivery_unassigned: live driver count > vita mojo count --------
  for (const wd of deliveries) {
    if (wd.vita_mojo_count != null && wd.manager_avg_4wk != null) {
      const live = Number(wd.manager_avg_4wk);
      const vita = Number(wd.vita_mojo_count);
      if (live - vita > 0 && !wd.reason) {
        const driver = employeeById.get(wd.driver_id);
        await raise({
          alert_type: "delivery_unassigned",
          severity: "warning",
          store_id: wd.store_id,
          employee_id: wd.driver_id,
          subject_date: wd.week_start_date,
          title: `${driver?.name ?? "Driver"}: ${live - vita} unassigned deliveries`,
          message: `Live driver count (${live}) exceeds Vita Mojo total (${vita}). Reason required.`,
          payload: { live, vita, week: wd.week_start_date },
        });
      }
    }
  }

  // -------- delivery_payout_high: this-week deliveries > multiplier × 4-week avg --------
  const deliveriesByDriverWeek = new Map<string, Map<string, number>>();
  for (const ce of clocks) {
    const total = (Number(ce.short_deliveries_count) || 0) + (Number(ce.long_deliveries_count) || 0);
    if (!total) continue;
    const map = deliveriesByDriverWeek.get(ce.employee_id) ?? new Map<string, number>();
    const wk = toISODate(startOfISOWeek(new Date(ce.event_date)));
    map.set(wk, (map.get(wk) ?? 0) + total);
    deliveriesByDriverWeek.set(ce.employee_id, map);
  }
  for (const [driverId, weeks] of Array.from(deliveriesByDriverWeek.entries())) {
    const driver = employeeById.get(driverId);
    if (!driver || !hasRole(driver.position, "Driver")) continue;
    const thisWeek = weeks.get(weekStart) ?? 0;
    const priorWeeks = Array.from(weeks.entries())
      .filter(([wk]) => wk < weekStart)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-4)
      .map(([, c]) => c);
    if (priorWeeks.length < 2) continue;
    const avg = priorWeeks.reduce((a, b) => a + b, 0) / priorWeeks.length;
    if (thisWeek > 0 && thisWeek > avg * t.delivery_spike_multiplier) {
      await raise({
        alert_type: "delivery_payout_high",
        severity: "warning",
        store_id: driver.store_id,
        employee_id: driver.id,
        title: `${driver.name}: high delivery count this week`,
        message: `${thisWeek} deliveries this week vs ${avg.toFixed(0)} 4-week average.`,
        payload: { this_week: thisWeek, avg_4wk: avg },
      });
    }
  }

  // -------- retire day-scoped alerts once their day has passed --------
  // These four are raised ONLY from the effectiveToday loop, so each one
  // describes one particular day and is keyed on that day's rota row. A new
  // shift_id every morning means the dedup can never match yesterday's, and
  // nothing else closed them -- so every working day left roughly two more
  // open rows per employee on the board, permanently, which is what pinned the
  // badge at its 200 cap.
  // Swept by DATE, not by whether this scan re-raised them: within the day
  // "not re-raised" still means "the lateness happened and was fixed", and
  // that alert must stand until the day is over.
  const dayScopedTypes: AlertType[] = [
    "late_clock_in",
    "unexpected_absence",
    "early_clock_out",
    "scheduled_vs_actual",
  ];
  // Start of today in London, less an hour: London is UTC+0 or +1, so this is
  // at or before its true midnight and can never sweep an alert raised today.
  // Erring the other way would delete a live alert an hour after it was made.
  const londonDayStart = new Date(`${today}T00:00:00Z`);
  const dayCutoff = new Date(londonDayStart.getTime() - 3600_000).toISOString();
  const { data: openDayScoped } = await supabase
    .from("alerts")
    .select("id")
    .eq("resolved", false)
    .in("alert_type", dayScopedTypes)
    .lt("created_at", dayCutoff);
  const agedIds = (openDayScoped ?? []).map((r: { id: string }) => r.id);
  if (agedIds.length) {
    await supabase
      .from("alerts")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolution_note: "Auto-resolved: the shift day this alert covers has passed.",
      })
      .in("id", agedIds);
  }

  // -------- today: late / absence / early-out / variance --------
  // Effective shifts = real rota rows for today PLUS template-derived virtual
  // shifts for employees who have no rota row today but DO have a working
  // recurring schedule for today's weekday. This is what makes "missed shift"
  // detection work even when the manager hasn't published a rota.
  const realToday = shifts.filter((s) => s.shift_date === today);
  const realTodayById = new Set(realToday.map((s) => s.employee_id));

  type EffShift = {
    id: string | null;
    employee_id: string;
    store_id: string;
    shift_date: string;
    start_time: string | null;
    end_time: string | null;
    is_day_off: boolean;
    scheduled_hours: number;
    same_day_edit_reason: string | null;
  };

  const effectiveToday: EffShift[] = realToday
    .filter((s) => !s.is_day_off)
    .map((s) => ({
      id: s.id,
      employee_id: s.employee_id,
      store_id: s.store_id,
      shift_date: s.shift_date,
      start_time: s.start_time,
      end_time: s.end_time,
      is_day_off: s.is_day_off,
      scheduled_hours: Number(s.scheduled_hours ?? 0),
      same_day_edit_reason: s.same_day_edit_reason ?? null,
    }));

  for (const emp of employees) {
    if (emp.employment_status !== "active" || !emp.store_id) continue;
    if (realTodayById.has(emp.id)) continue; // they have a published row today
    const tmpl = scheduleByKey.get(`${emp.id}:${todayWeekday}`) as
      | { is_working: boolean; start_time: string | null; end_time: string | null }
      | undefined;
    if (!tmpl || !tmpl.is_working || !tmpl.start_time) continue;
    effectiveToday.push({
      id: null,
      employee_id: emp.id,
      store_id: emp.store_id,
      shift_date: today,
      start_time: tmpl.start_time,
      end_time: tmpl.end_time,
      is_day_off: false,
      scheduled_hours: shiftHours(tmpl.start_time, tmpl.end_time),
      same_day_edit_reason: null,
    });
  }

  const todayClocks = new Map(
    clocks.filter((c) => c.event_date === today).map((c) => [c.employee_id, c]),
  );
  for (const s of effectiveToday) {
    if (!s.start_time) continue;
    const emp = employeeById.get(s.employee_id);
    if (!emp) continue;
    const diffMin = nowMinutes - timeToMinutes(s.start_time);
    const clk = todayClocks.get(s.employee_id);

    if (!clk?.clock_in_at) {
      if (diffMin > t.absence_min && !s.same_day_edit_reason) {
        await raise({
          alert_type: "unexpected_absence",
          severity: "critical",
          store_id: s.store_id,
          employee_id: emp.id,
          shift_id: s.id,
          title: `${emp.name}: unexpected absence`,
          message: `Scheduled at ${s.start_time} but not clocked in (${Math.round(diffMin)}m late). No reason recorded.`,
          payload: { scheduled_start: s.start_time, late_minutes: diffMin },
        });
      } else if (diffMin > t.late_clock_in_min) {
        await raise({
          alert_type: "late_clock_in",
          severity: "warning",
          store_id: s.store_id,
          employee_id: emp.id,
          shift_id: s.id,
          title: `${emp.name}: late clock-in`,
          message: `Scheduled at ${s.start_time} — ${Math.round(diffMin)}m late.`,
          payload: { scheduled_start: s.start_time, late_minutes: diffMin },
        });
      }
    } else if (clk.clock_out_at && s.end_time && s.start_time) {
      // Both sides in London minutes-from-shift-start, so an overnight shift
      // unrolls past midnight the way shiftHours does -- 22:00–02:00 clocked out
      // at 02:00 is on time, not 20 hours early.
      const startMin = timeToMinutes(s.start_time);
      const endMin = timeToMinutes(s.end_time);
      const scheduledEndMin = endMin < startMin ? endMin + 1440 : endMin;
      let actualEndMin = timeToMinutes(londonHHMM(new Date(clk.clock_out_at)));
      if (actualEndMin < startMin) actualEndMin += 1440;
      const earlyMin = scheduledEndMin - actualEndMin;
      if (earlyMin > t.early_clock_out_min && !s.same_day_edit_reason) {
        await raise({
          alert_type: "early_clock_out",
          severity: "warning",
          store_id: s.store_id,
          employee_id: emp.id,
          shift_id: s.id,
          title: `${emp.name}: early clock-out`,
          message: `Clocked out ${Math.round(earlyMin)}m before scheduled end (${s.end_time}). No reason entered.`,
          payload: { scheduled_end: s.end_time, early_minutes: earlyMin },
        });
      }
    }

    // scheduled vs actual variance (only for completed shifts)
    if (clk?.clock_in_at && clk.clock_out_at) {
      // Summed shifts: a day worked 09:00–13:00 and 17:00–21:00 is 8h against
      // an 8h rota, not the 12h variance the raw span would report.
      const actualHours = dayWorkedHours(clk);
      const scheduled = Number(s.scheduled_hours ?? shiftHours(s.start_time, s.end_time));
      if (scheduled > 0) {
        const delta = percentDelta(actualHours, scheduled);
        if (Math.abs(delta) > t.scheduled_vs_actual_pct) {
          await raise({
            alert_type: "scheduled_vs_actual",
            severity: "info",
            store_id: s.store_id,
            employee_id: emp.id,
            shift_id: s.id,
            title: `${emp.name}: scheduled vs actual variance`,
            message: `Worked ${formatHoursMinsWords(actualHours)} vs ${formatHoursMinsWords(scheduled)} scheduled (${delta > 0 ? "+" : ""}${delta.toFixed(0)}%).`,
            payload: { actual: actualHours, scheduled, delta_percent: delta },
          });
        }
      }
    }
  }

  // =============================================================
  // CASH FLOW ALERTS (Stage 2)
  // =============================================================
  const stores = (storesRes.data ?? []) as Array<{ id: string; name: string }>;
  const cashEntries = (cashEntriesRes.data ?? []) as Array<{
    store_id: string;
    entry_date: string;
    vita_mojo_sales: number;
    envelope_amount: number;
    difference: number;
    reason: string | null;
  }>;
  const weekPayouts = (payoutsRes.data ?? []) as Array<{
    id: string;
    store_id: string;
    status: string;
    locked: boolean;
    adjustment_amount: number | null;
    adjustment_reason: string | null;
  }>;
  const coverRows = (coverRes.data ?? []) as CoverDriverPayRow[];
  const managerPayees = (managersRes.data ?? []) as ManagerPayee[];
  const managerPayRows = (managerClocksRes.data ?? []) as ManagerPayRow[];
  const priorPayouts = (priorPayoutsRes.data ?? []) as Array<{
    store_id: string;
    surplus_carry_forward: number;
    week_start_date: string;
  }>;

  // Latest confirmed surplus per store = this week's opening balance.
  const openingByStore = new Map<string, number>();
  if (settings.cash_flow.carry_forward_surplus) {
    for (const p of priorPayouts) {
      if (!openingByStore.has(p.store_id)) {
        openingByStore.set(p.store_id, Number(p.surplus_carry_forward) || 0);
      }
    }
  }

  const payoutByStore = new Map(weekPayouts.map((p) => [p.store_id, p]));

  // The pay week's clock rows across ALL stores. The wage forecast per store
  // needs the whole week (not just the store's own rows) so an employee whose
  // week spans stores has their NI/cash split computed once, globally, and
  // their cash hours attributed to the store they worked them at.
  const payWeekClocks = clocks.filter(
    (c) => c.event_date >= payWeek.start && c.event_date <= payWeek.end,
  );

  // Which stores' pay-week cash this client could actually READ. `alerts` is
  // is_staff() but daily_cash_entries is can_access_store, so on a MANAGER's
  // manual "Scan now" the other store comes back empty -- indistinguishable
  // from a week that banked nothing, which forecasts a draw of the entire wage
  // bill and would overwrite the correct figure. Guarding the raise (not just
  // the sweep) is what closes the follow-up left open by Update 160; it matters
  // more now that the forecast runs on every scan rather than twice a week. The
  // background scan runs service-role and sees every store.
  const cashReadableStores = new Set(
    cashEntries.filter((e) => e.entry_date <= payWeek.end).map((e) => e.store_id),
  );
  const payday = formatDDMMYYYY(addDays(parseISODate(weekStart), 1));
  const payWeekLabel = `${formatDDMMYYYY(payWeek.start)} - ${formatDDMMYYYY(payWeek.end)}`;

  for (const store of stores) {
    const forStore = cashEntries.filter((e) => e.store_id === store.id);
    // The reconciliation alerts are about the week in progress...
    const storeEntries = forStore.filter((e) => e.entry_date >= weekStart);
    // ...the Tuesday forecast is funded by the pay week's envelopes, the same
    // window computeSummary bounds its query with. Reading the current week
    // here reported a draw against a Monday that has collected almost nothing.
    const payWeekEntries = forStore.filter(
      (e) => e.entry_date >= payWeek.start && e.entry_date <= payWeek.end,
    );
    const todayEntry = storeEntries.find((e) => e.entry_date === today);

    // ----- Missing daily entry -----
    if (!todayEntry && nowHour >= settings.cash_flow.missing_entry_hour) {
      await raise({
        alert_type: "missing_daily_entry",
        severity: "warning",
        store_id: store.id,
        subject_date: today,
        title: `${store.name}: daily cash entry missing`,
        message: `No cash entry has been submitted for ${store.name} today. Please complete the daily reconciliation.`,
        payload: { date: today },
      });
    }

    // ----- Unresolved discrepancy (difference logged without a reason) -----
    for (const e of storeEntries) {
      const diff = Number(e.difference) || 0;
      if (Math.abs(diff) > 0.001 && !e.reason) {
        await raise({
          alert_type: "unresolved_discrepancy",
          severity: "warning",
          store_id: store.id,
          subject_date: e.entry_date,
          title: `${store.name}: unresolved discrepancy (£${Math.abs(diff).toFixed(2)})`,
          message: `A £${Math.abs(diff).toFixed(2)} ${diff > 0 ? "shortfall" : "surplus"} on ${e.entry_date} has no reason recorded.`,
          payload: { date: e.entry_date, difference: diff },
        });
      }
    }

    // ----- Running balance below zero -----
    // Cash on hand = opening + envelopes banked, exactly as runningBalanceRows
    // defines it. It does NOT also subtract each day's `difference`: the
    // envelope is `vita_mojo_sales - supermarket_expenses` by construction (see
    // the daily_cash_entries CHECK), so the money spent is already missing from
    // it and taking it off again charged the same spend twice. That turned any
    // day banked as 0 -- counted later, entered short -- into a critical.
    // Consequence worth knowing: surplus_carry_forward is written from
    // buildPrePaymentSummary's `surplus`, which is clamped at 0, so with the
    // double-count gone the only thing that can still trip this is a negative
    // opening the payout sheet cannot currently produce.
    const opening = openingByStore.get(store.id) ?? 0;
    const envelopes = storeEntries.reduce((s, e) => s + (Number(e.envelope_amount) || 0), 0);
    const onHand = opening + envelopes;
    if (onHand < -0.001) {
      await raise({
        alert_type: "negative_cash_balance",
        severity: "critical",
        store_id: store.id,
        title: `${store.name}: cash balance negative`,
        message: `Running cash balance is £${onHand.toFixed(2)} — the £${opening.toFixed(2)} carried forward is not covered by the £${envelopes.toFixed(2)} banked so far this week.`,
        payload: { net: onHand, opening, envelopes },
      });
    }

    // ----- Tuesday wage forecast: Post Office draw -----
    // Wages paid this Tuesday are for LAST week's work (Mon–Sun), so the
    // forecast uses the pay week — keeping it identical to the payout screen.
    // Leavers stay included: they're still owed for the pay week they worked.
    // Whoever worked at this store counts (including visitors from the other
    // store); buildWageLinesForStore keeps only those with pay due here.
    // All THREE payee kinds, merged exactly as computeSummary merges them --
    // a cover driver's day and a manager's drops are cash out of the same pot,
    // so omitting them understated wages due and hid draws the sheet showed.
    const lines = [
      ...buildWageLinesForStore(store.id, employees, payWeekClocks),
      ...buildCoverDriverWageLines(store.id, coverRows),
      ...buildManagerWageLines(store.id, managerPayees, managerPayRows),
    ].sort((a, b) => b.total_payment - a.total_payment);
    const payout = payoutByStore.get(store.id);
    const summary = buildPrePaymentSummary({
      store_id: store.id,
      week_start_date: weekStart,
      opening_balance: opening,
      entries: payWeekEntries,
      lines,
      supermarket_cash: supermarketCashAmount(
        store.name,
        settings.cash_flow.supermarket_default_cash,
      ),
      // Must match the sheet: a manual adjustment can be the whole reason a
      // draw is or isn't needed, and an alert warning of a shortfall the sheet
      // doesn't show is worse than no alert at all.
      adjustment: Number(payout?.adjustment_amount) || 0,
      adjustment_reason: payout?.adjustment_reason ?? null,
    });

    // ----- Post Office draw required -----
    // Recomputed on EVERY scan. It used to be written only on the Monday and
    // Tuesday it is acted on, and never revisited: an hour approved or a cash
    // entry corrected midweek moved the payout sheet and left the board showing
    // a draw the sheet disagreed with, with no way to tell which was current.
    // subject_date pins it to the PAY WEEK, so the row can no longer be reused
    // across weeks -- an undated draw could not say which week it meant, and
    // the sweep below could not tell a stale one from a live one.
    if (summary.post_office_draw > 0.001 && cashReadableStores.has(store.id)) {
      await raise({
        alert_type: "post_office_draw",
        severity: "critical",
        store_id: store.id,
        subject_date: payWeek.start,
        title: `${store.name}: draw £${summary.post_office_draw.toFixed(2)} from the Post Office`,
        message: `Draw £${summary.post_office_draw.toFixed(2)} from the Post Office to pay wages on Tuesday ${payday}, for the week ${payWeekLabel}. Wages due £${summary.grand_total_wages.toFixed(2)}; cash available £${summary.actual_cash_available.toFixed(2)}.`,
        payload: {
          draw: summary.post_office_draw,
          wages_due: summary.grand_total_wages,
          available: summary.actual_cash_available,
          pay_week_start: payWeek.start,
          pay_week_end: payWeek.end,
          payday_week_start: weekStart,
        },
      });
    }

    // Tuesday after the confirm deadline: wages / payments not finalised.
    if (todayWeekday === 1 && nowHour >= settings.cash_flow.wages_confirm_hour) {
      if (!payout || payout.status !== "confirmed") {
        await raise({
          alert_type: "wages_not_confirmed",
          severity: "warning",
          store_id: store.id,
          title: `${store.name}: wages not yet confirmed`,
          message: `Tuesday wage payments for ${store.name} have not been confirmed in the system. Please confirm once all employees are paid.`,
          payload: { week_start: weekStart },
        });
      }
    }
  }

  // ----- Unconfirmed payment for an employee (some paid, some not) on Tuesday -----
  if (todayWeekday === 1 && nowHour >= settings.cash_flow.wages_confirm_hour) {
    const draftPayoutIds = weekPayouts.filter((p) => !p.locked).map((p) => p.id);
    if (draftPayoutIds.length) {
      const { data: lineRows } = await supabase
        .from("cash_payout_lines")
        .select("payout_id, employee_name, is_paid")
        .in("payout_id", draftPayoutIds);
      const byPayout = new Map<string, { paid: number; unpaid: number }>();
      for (const l of lineRows ?? []) {
        const agg = byPayout.get(l.payout_id) ?? { paid: 0, unpaid: 0 };
        if (l.is_paid) agg.paid += 1;
        else agg.unpaid += 1;
        byPayout.set(l.payout_id, agg);
      }
      for (const p of weekPayouts) {
        const agg = byPayout.get(p.id);
        if (agg && agg.paid > 0 && agg.unpaid > 0) {
          const store = stores.find((s) => s.id === p.store_id);
          await raise({
            alert_type: "unconfirmed_payment",
            severity: "warning",
            store_id: p.store_id,
            title: `${store?.name ?? "Store"}: ${agg.unpaid} employee${agg.unpaid === 1 ? "" : "s"} unpaid`,
            message: `${agg.paid} employee${agg.paid === 1 ? "" : "s"} marked paid but ${agg.unpaid} still unconfirmed for this Tuesday.`,
            payload: { paid: agg.paid, unpaid: agg.unpaid },
          });
        }
      }
    }
  }

  // -------- retire alerts whose condition has cleared --------
  // Runs LAST, once touchedIds holds everything this scan raised. An open alert
  // of a recomputed type that was not re-raised no longer holds; without this a
  // corrected figure never reaches the board, because the alert simply stops
  // being raised and its stale message sits there indefinitely.
  //
  // `since` bounds a sweep to the dates the scan actually recomputed. Only a
  // date-keyed type can be bounded, and only a bounded sweep can tell "the
  // reason was filled in" from "that week fell out of the read window" -- an
  // unbounded one closes the second as though it were the first.
  // `storeIds` bounds it to the stores it could READ. `alerts` is is_staff() so
  // this client can resolve any store's rows, but daily_cash_entries is
  // can_access_store -- on a manager's manual scan the other store returns no
  // entries, which without this would look exactly like every discrepancy there
  // having been explained.
  const sweepUnraised = async (
    types: AlertType[],
    opts?: { since?: string; storeIds?: string[] },
  ) => {
    if (!types.length) return;
    if (opts?.storeIds && !opts.storeIds.length) return;
    let q = supabase.from("alerts").select("id").eq("resolved", false).in("alert_type", types);
    if (opts?.since) q = q.gte("subject_date", opts.since);
    if (opts?.storeIds) q = q.in("store_id", opts.storeIds);
    const { data } = await q;
    const ids = (data ?? [])
      .map((r: { id: string }) => r.id)
      .filter((id: string) => !touchedIds.has(id));
    if (!ids.length) return;
    await supabase
      .from("alerts")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolution_note: "Auto-resolved: no longer applies as of the latest scan.",
      })
      .in("id", ids);
  };

  // Current-state types: one row per employee, recomputed unconditionally, no
  // date to bound them by. min_wage_violation only when the bands are on --
  // with them off it is never raised, so every open one would look cleared.
  const stateTypes: AlertType[] = ["wage_variance", "delivery_payout_high"];
  if (settings.min_wage_bands.enabled) stateTypes.push("min_wage_violation");
  await sweepUnraised(stateTypes);
  // weekly_deliveries is is_staff(), so this one is read estate-wide by any
  // client the scan runs under and needs no store bound.
  await sweepUnraised(["delivery_unassigned"], { since: historyStart });
  await sweepUnraised(["unresolved_discrepancy"], {
    since: weekStart,
    storeIds: Array.from(new Set(cashEntries.map((e) => e.store_id))),
  });

  // post_office_draw takes NO `since`. Every other dated type is swept within
  // the window it was recomputed over, because outside it "not re-raised" only
  // means "not looked at". A draw is different: exactly one pay week is ever
  // live, so an open draw for any OTHER week is finished business — that
  // Tuesday has been and gone — and one for THIS week that the scan did not
  // re-raise is a shortfall that has since been covered. Both should close.
  // Still store-bounded, for the RLS reason above.
  await sweepUnraised(["post_office_draw"], {
    storeIds: Array.from(cashReadableStores),
  });

  // missing_daily_entry is raised for TODAY only, and only after the cut-off
  // hour, so "not re-raised" can never mean "cleared" for a past day. Its
  // condition is simply whether the entry now exists, so read that directly.
  const enteredKeys = new Set(cashEntries.map((e) => `${e.store_id}|${e.entry_date}`));
  const { data: openMissing } = await supabase
    .from("alerts")
    .select("id, store_id, subject_date")
    .eq("resolved", false)
    .eq("alert_type", "missing_daily_entry")
    .gte("subject_date", payWeek.start);
  const filledIds = (openMissing ?? [])
    .filter((r: { store_id: string | null; subject_date: string | null }) =>
      enteredKeys.has(`${r.store_id}|${r.subject_date}`),
    )
    .map((r: { id: string }) => r.id);
  if (filledIds.length) {
    await supabase
      .from("alerts")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolution_note: "Auto-resolved: the cash entry for this day has since been submitted.",
      })
      .in("id", filledIds);
  }

  // -------- email digest of newly-created alerts --------
  if (settings.email_alerts.enabled && newAlerts.length > 0) {
    const recipients = await resolveRecipients(supabase, settings);
    const result = await sendAlertDigest({ recipients, alerts: newAlerts });
    if (!result.sent) {
      console.warn("[alerts] digest not sent:", result.reason);
    }
  }

  return { ok: true, created: newAlerts.length, failed: writeFailures };
}

// =============================================================
// Manual scan — triggered by staff via the "Scan now" button. Uses the RLS
// client (staff can read everything they need and write alerts).
// =============================================================
export async function scanForAlerts() {
  await requireAllowed();
  const supabase = createServerSupabase();
  await sweepForgottenClockOuts();
  const result = await runScan(supabase);
  revalidatePath("/alerts");
  revalidatePath("/manager/alerts");
  revalidatePath("/dashboard");
  return result;
}

/**
 * Close any day someone forgot to clock out of, before scanning. Bolted onto
 * the alert scan on purpose: the scan already runs on every clock-in/out and
 * from the manual "Scan now", so forgotten clock-outs get recorded even on
 * sites where the cron (app/api/cron/auto-clock-out) was never wired up.
 * Best-effort — a failure here must never break clocking or the scan.
 */
async function sweepForgottenClockOuts() {
  try {
    if (!isProvisioningConfigured()) return;
    const result = await autoCloseOpenClocks(createAdminClient());
    if (result.closed.length > 0) {
      revalidatePath("/live");
      revalidatePath("/manager/live");
      revalidatePath("/rota");
      revalidatePath("/manager/rota");
      revalidatePath("/employees");
      revalidatePath("/manager/employees");
    }
  } catch (err) {
    console.error(
      "[alerts] auto clock-out sweep failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// =============================================================
// Background scan — fire-and-forget from clock-in/out (employee context).
// Uses the service-role client so it can read all rows and write staff-only
// alerts even though an employee triggered it. No-ops if provisioning isn't
// configured; never throws (must not break clocking).
// =============================================================
export async function scanForAlertsBackground() {
  try {
    if (!isProvisioningConfigured()) return { ok: false as const };
    const admin = createAdminClient();
    await sweepForgottenClockOuts();
    const { failed } = await runScan(admin as unknown as SupabaseClient);
    // Nobody reads this return -- it is fired and forgotten from the clock
    // paths -- so a failed write only exists if it is logged here.
    if (failed > 0) console.warn(`[alerts] ${failed} alert write(s) failed`);
    revalidatePath("/alerts");
    revalidatePath("/manager/alerts");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch (err) {
    console.error("[alerts] background scan failed:", err instanceof Error ? err.message : err);
    return { ok: false as const };
  }
}
