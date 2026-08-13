"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import {
  addDays,
  dayWorkedHours,
  formatHoursMinsWords,
  startOfISOWeek,
  toISODate,
  todayISO,
  shiftHours,
  percentDelta,
  weekdayIndex,
} from "@/lib/utils";
import { autoCloseOpenClocks } from "@/lib/auto-clock-out";
import { mergeSettings, type AppSettings } from "@/lib/settings";
import {
  buildPrePaymentSummary,
  buildWageLinesForStore,
  payWeekOf,
  supermarketCashAmount,
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

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

async function upsertAlert(
  supabase: SupabaseClient,
  input: {
    alert_type: AlertType;
    severity?: AlertSeverity;
    store_id?: string | null;
    employee_id?: string | null;
    shift_id?: string | null;
    title: string;
    message: string;
    payload?: Record<string, unknown> | null;
  },
  collector?: NewAlert[],
) {
  // Don't create a duplicate open alert
  const { data: existing } = await supabase
    .from("alerts")
    .select("id")
    .eq("alert_type", input.alert_type)
    .eq("resolved", false)
    .eq("employee_id", input.employee_id ?? ZERO_UUID)
    .eq("shift_id", input.shift_id ?? ZERO_UUID)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("alerts")
      .update({
        message: input.message,
        payload: input.payload ?? null,
        title: input.title,
      })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data, error } = await supabase
    .from("alerts")
    .insert({
      alert_type: input.alert_type,
      severity: input.severity ?? "warning",
      store_id: input.store_id ?? null,
      employee_id: input.employee_id ?? null,
      shift_id: input.shift_id ?? null,
      title: input.title,
      message: input.message,
      payload: input.payload ?? null,
    })
    .select("id")
    .maybeSingle();

  // Suppress duplicate-key errors from the partial unique index
  if (error && !String(error.message).toLowerCase().includes("duplicate")) {
    console.error("[alerts] insert error", error.message);
  }
  if (!error && data?.id && collector) {
    collector.push({
      alert_type: input.alert_type,
      severity: input.severity ?? "warning",
      title: input.title,
      message: input.message,
    });
  }
  return data?.id ?? null;
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
async function runScan(supabase: SupabaseClient): Promise<{ ok: true; created: number }> {
  const today = todayISO();
  const weekStart = toISODate(startOfISOWeek(new Date()));
  // Tuesday pays the PREVIOUS Mon–Sun — the wage forecast must use that week.
  const payWeek = payWeekOf(weekStart);
  const fourWeeksAgo = toISODate(addDays(new Date(), -28));

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
  ] = await Promise.all([
      supabase
        .from("rota_shifts")
        .select("*")
        .gte("shift_date", fourWeeksAgo)
        .lte("shift_date", today)
        .order("shift_date"),
      supabase
        .from("clock_events")
        .select("*")
        .gte("event_date", fourWeeksAgo)
        .lte("event_date", today),
      supabase.from("employees").select("*"),
      supabase
        .from("weekly_deliveries")
        .select("*")
        .gte("week_start_date", fourWeeksAgo),
      supabase.from("employee_schedules").select("*"),
      supabase.from("app_settings").select("key, value"),
      supabase.from("stores").select("id, name"),
      supabase
        .from("daily_cash_entries")
        .select("store_id, entry_date, vita_mojo_sales, envelope_amount, difference, reason")
        .gte("entry_date", weekStart),
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

  // -------- wage_variance: this-week vs 4-week avg hours per employee --------
  const hoursByEmpWeek = new Map<string, Map<string, number>>();
  for (const s of shifts) {
    if (s.is_day_off) continue;
    const map = hoursByEmpWeek.get(s.employee_id) ?? new Map<string, number>();
    const wk = toISODate(startOfISOWeek(new Date(s.shift_date)));
    map.set(wk, (map.get(wk) ?? 0) + Number(s.scheduled_hours ?? 0));
    hoursByEmpWeek.set(s.employee_id, map);
  }

  for (const [empId, weeks] of Array.from(hoursByEmpWeek.entries())) {
    const emp = employeeById.get(empId);
    if (!emp) continue;
    const thisWeek = weeks.get(weekStart) ?? 0;
    const priorWeeks = Array.from(weeks.entries())
      .filter(([wk]) => wk !== weekStart)
      .slice(-4)
      .map(([, h]) => h);
    if (priorWeeks.length < 2) continue;
    const avg = priorWeeks.reduce((a, b) => a + b, 0) / priorWeeks.length;
    const delta = percentDelta(thisWeek, avg);
    if (Math.abs(delta) > t.wage_variance_pct) {
      await upsertAlert(
        supabase,
        {
          alert_type: "wage_variance",
          severity: "warning",
          store_id: emp.store_id,
          employee_id: emp.id,
          title: `${emp.name}: hours vary ${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`,
          message: `Scheduled ${formatHoursMinsWords(thisWeek)} this week vs ${formatHoursMinsWords(avg)} 4-week average (>${t.wage_variance_pct}% deviation).`,
          payload: { this_week: thisWeek, avg_4wk: avg, delta_percent: delta },
        },
        newAlerts,
      );
    }
  }

  // -------- min_wage_violation: rate below legal minimum for age band --------
  if (settings.min_wage_bands.enabled) {
    for (const emp of employees) {
      if (emp.employment_status !== "active") continue;
      const wc = wageComplianceForEmployee(emp, settings.min_wage_bands);
      if (wc && !wc.compliant) {
        await upsertAlert(
          supabase,
          {
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
          },
          newAlerts,
        );
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
        await upsertAlert(
          supabase,
          {
            alert_type: "delivery_unassigned",
            severity: "warning",
            store_id: wd.store_id,
            employee_id: wd.driver_id,
            title: `${driver?.name ?? "Driver"}: ${live - vita} unassigned deliveries`,
            message: `Live driver count (${live}) exceeds Vita Mojo total (${vita}). Reason required.`,
            payload: { live, vita, week: wd.week_start_date },
          },
          newAlerts,
        );
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
      .filter(([wk]) => wk !== weekStart)
      .slice(-4)
      .map(([, c]) => c);
    if (priorWeeks.length < 2) continue;
    const avg = priorWeeks.reduce((a, b) => a + b, 0) / priorWeeks.length;
    if (thisWeek > 0 && thisWeek > avg * t.delivery_spike_multiplier) {
      await upsertAlert(
        supabase,
        {
          alert_type: "delivery_payout_high",
          severity: "warning",
          store_id: driver.store_id,
          employee_id: driver.id,
          title: `${driver.name}: high delivery count this week`,
          message: `${thisWeek} deliveries this week vs ${avg.toFixed(0)} 4-week average.`,
          payload: { this_week: thisWeek, avg_4wk: avg },
        },
        newAlerts,
      );
    }
  }

  // -------- today: late / absence / early-out / variance --------
  // Effective shifts = real rota rows for today PLUS template-derived virtual
  // shifts for employees who have no rota row today but DO have a working
  // recurring schedule for today's weekday. This is what makes "missed shift"
  // detection work even when the manager hasn't published a rota.
  const realToday = shifts.filter((s) => s.shift_date === today);
  const realTodayById = new Set(realToday.map((s) => s.employee_id));
  const todayWeekday = weekdayIndex(new Date());

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
  const now = new Date();
  for (const s of effectiveToday) {
    if (!s.start_time) continue;
    const emp = employeeById.get(s.employee_id);
    if (!emp) continue;
    const [hh, mm] = s.start_time.split(":").map(Number);
    const scheduledStart = new Date();
    scheduledStart.setHours(hh, mm, 0, 0);
    const diffMin = (now.getTime() - scheduledStart.getTime()) / 60000;
    const clk = todayClocks.get(s.employee_id);

    if (!clk?.clock_in_at) {
      if (diffMin > t.absence_min && !s.same_day_edit_reason) {
        await upsertAlert(
          supabase,
          {
            alert_type: "unexpected_absence",
            severity: "critical",
            store_id: s.store_id,
            employee_id: emp.id,
            shift_id: s.id,
            title: `${emp.name}: unexpected absence`,
            message: `Scheduled at ${s.start_time} but not clocked in (${Math.round(diffMin)}m late). No reason recorded.`,
            payload: { scheduled_start: s.start_time, late_minutes: diffMin },
          },
          newAlerts,
        );
      } else if (diffMin > t.late_clock_in_min) {
        await upsertAlert(
          supabase,
          {
            alert_type: "late_clock_in",
            severity: "warning",
            store_id: s.store_id,
            employee_id: emp.id,
            shift_id: s.id,
            title: `${emp.name}: late clock-in`,
            message: `Scheduled at ${s.start_time} — ${Math.round(diffMin)}m late.`,
            payload: { scheduled_start: s.start_time, late_minutes: diffMin },
          },
          newAlerts,
        );
      }
    } else if (clk.clock_out_at && s.end_time) {
      const [eh, em] = s.end_time.split(":").map(Number);
      const scheduledEnd = new Date(s.shift_date);
      scheduledEnd.setHours(eh, em, 0, 0);
      const actualEnd = new Date(clk.clock_out_at);
      const earlyMin = (scheduledEnd.getTime() - actualEnd.getTime()) / 60000;
      if (earlyMin > t.early_clock_out_min && !s.same_day_edit_reason) {
        await upsertAlert(
          supabase,
          {
            alert_type: "early_clock_out",
            severity: "warning",
            store_id: s.store_id,
            employee_id: emp.id,
            shift_id: s.id,
            title: `${emp.name}: early clock-out`,
            message: `Clocked out ${Math.round(earlyMin)}m before scheduled end (${s.end_time}). No reason entered.`,
            payload: { scheduled_end: s.end_time, early_minutes: earlyMin },
          },
          newAlerts,
        );
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
          await upsertAlert(
            supabase,
            {
              alert_type: "scheduled_vs_actual",
              severity: "info",
              store_id: s.store_id,
              employee_id: emp.id,
              shift_id: s.id,
              title: `${emp.name}: scheduled vs actual variance`,
              message: `Worked ${formatHoursMinsWords(actualHours)} vs ${formatHoursMinsWords(scheduled)} scheduled (${delta > 0 ? "+" : ""}${delta.toFixed(0)}%).`,
              payload: { actual: actualHours, scheduled, delta_percent: delta },
            },
            newAlerts,
          );
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
  const todayWd = weekdayIndex(now); // 0=Mon .. 5=Sat .. 6=Sun
  const nowHour = now.getHours();

  // The pay week's clock rows across ALL stores. The wage forecast per store
  // needs the whole week (not just the store's own rows) so an employee whose
  // week spans stores has their NI/cash split computed once, globally, and
  // their cash hours attributed to the store they worked them at.
  const payWeekClocks = clocks.filter(
    (c) => c.event_date >= payWeek.start && c.event_date <= payWeek.end,
  );

  for (const store of stores) {
    const storeEntries = cashEntries.filter((e) => e.store_id === store.id);
    const todayEntry = storeEntries.find((e) => e.entry_date === today);

    // ----- Missing daily entry -----
    if (!todayEntry && nowHour >= settings.cash_flow.missing_entry_hour) {
      await upsertAlert(
        supabase,
        {
          alert_type: "missing_daily_entry",
          severity: "warning",
          store_id: store.id,
          title: `${store.name}: daily cash entry missing`,
          message: `No cash entry has been submitted for ${store.name} today. Please complete the daily reconciliation.`,
          payload: { date: today },
        },
        newAlerts,
      );
    }

    // ----- Unresolved discrepancy (difference logged without a reason) -----
    for (const e of storeEntries) {
      const diff = Number(e.difference) || 0;
      if (Math.abs(diff) > 0.001 && !e.reason) {
        await upsertAlert(
          supabase,
          {
            alert_type: "unresolved_discrepancy",
            severity: "warning",
            store_id: store.id,
            title: `${store.name}: unresolved discrepancy (£${Math.abs(diff).toFixed(2)})`,
            message: `A £${Math.abs(diff).toFixed(2)} ${diff > 0 ? "shortfall" : "surplus"} on ${e.entry_date} has no reason recorded.`,
            payload: { date: e.entry_date, difference: diff },
          },
          newAlerts,
        );
      }
    }

    // ----- Running balance below zero (more cash used than collected) -----
    const opening = openingByStore.get(store.id) ?? 0;
    const envelopes = storeEntries.reduce((s, e) => s + (Number(e.envelope_amount) || 0), 0);
    const cashUsed = storeEntries.reduce((s, e) => s + Math.max(Number(e.difference) || 0, 0), 0);
    const netOfUsage = opening + envelopes - cashUsed;
    if (netOfUsage < -0.001) {
      await upsertAlert(
        supabase,
        {
          alert_type: "negative_cash_balance",
          severity: "critical",
          store_id: store.id,
          title: `${store.name}: cash balance negative`,
          message: `Running cash balance is £${netOfUsage.toFixed(2)} — more cash has been used (£${cashUsed.toFixed(2)}) than collected this week.`,
          payload: { net: netOfUsage, opening, envelopes, cash_used: cashUsed },
        },
        newAlerts,
      );
    }

    // ----- Tuesday wage forecast: Post Office draw -----
    // Wages paid this Tuesday are for LAST week's work (Mon–Sun), so the
    // forecast uses the pay week — keeping it identical to the payout screen.
    // Leavers stay included: they're still owed for the pay week they worked.
    // Whoever worked at this store counts (including visitors from the other
    // store); buildWageLinesForStore keeps only those with pay due here.
    const lines = buildWageLinesForStore(store.id, employees, payWeekClocks);
    const payout = payoutByStore.get(store.id);
    const summary = buildPrePaymentSummary({
      store_id: store.id,
      week_start_date: weekStart,
      opening_balance: opening,
      entries: storeEntries,
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

    // Post Office draw required — flag on the Monday before and on payday Tuesday.
    if (summary.post_office_draw > 0.001 && todayWd <= 1) {
      await upsertAlert(
        supabase,
        {
          alert_type: "post_office_draw",
          severity: "critical",
          store_id: store.id,
          title: `${store.name}: draw £${summary.post_office_draw.toFixed(2)} from the Post Office`,
          message: `You need to draw £${summary.post_office_draw.toFixed(2)} from the Post Office before paying wages this Tuesday. Wages due £${summary.grand_total_wages.toFixed(2)}; cash available £${summary.actual_cash_available.toFixed(2)}.`,
          payload: {
            draw: summary.post_office_draw,
            wages_due: summary.grand_total_wages,
            available: summary.actual_cash_available,
          },
        },
        newAlerts,
      );
    }

    // Tuesday after the confirm deadline: wages / payments not finalised.
    if (todayWd === 1 && nowHour >= settings.cash_flow.wages_confirm_hour) {
      if (!payout || payout.status !== "confirmed") {
        await upsertAlert(
          supabase,
          {
            alert_type: "wages_not_confirmed",
            severity: "warning",
            store_id: store.id,
            title: `${store.name}: wages not yet confirmed`,
            message: `Tuesday wage payments for ${store.name} have not been confirmed in the system. Please confirm once all employees are paid.`,
            payload: { week_start: weekStart },
          },
          newAlerts,
        );
      }
    }
  }

  // ----- Unconfirmed payment for an employee (some paid, some not) on Tuesday -----
  if (todayWd === 1 && nowHour >= settings.cash_flow.wages_confirm_hour) {
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
          await upsertAlert(
            supabase,
            {
              alert_type: "unconfirmed_payment",
              severity: "warning",
              store_id: p.store_id,
              title: `${store?.name ?? "Store"}: ${agg.unpaid} employee${agg.unpaid === 1 ? "" : "s"} unpaid`,
              message: `${agg.paid} employee${agg.paid === 1 ? "" : "s"} marked paid but ${agg.unpaid} still unconfirmed for this Tuesday.`,
              payload: { paid: agg.paid, unpaid: agg.unpaid },
            },
            newAlerts,
          );
        }
      }
    }
  }

  // -------- email digest of newly-created alerts --------
  if (settings.email_alerts.enabled && newAlerts.length > 0) {
    const recipients = await resolveRecipients(supabase, settings);
    const result = await sendAlertDigest({ recipients, alerts: newAlerts });
    if (!result.sent) {
      console.warn("[alerts] digest not sent:", result.reason);
    }
  }

  return { ok: true, created: newAlerts.length };
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
    await runScan(admin as unknown as SupabaseClient);
    revalidatePath("/alerts");
    revalidatePath("/manager/alerts");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch (err) {
    console.error("[alerts] background scan failed:", err instanceof Error ? err.message : err);
    return { ok: false as const };
  }
}
