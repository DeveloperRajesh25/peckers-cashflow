"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { writeAudit } from "./audit";
import { scanForAlertsBackground } from "./alerts";
import { addDays, parseISODate, startOfISOWeek, toISODate } from "@/lib/utils";
import { mergeSettings } from "@/lib/settings";
import {
  buildCoverDriverWageLines,
  buildManagerWageLines,
  buildPrePaymentSummary,
  buildWageLinesForStore,
  payWeekOf,
  type CoverDriverPayRow,
  type ManagerPayee,
  type ManagerPayRow,
} from "@/lib/cash-flow";
import type {
  CashPayoutWithLines,
  DailyCashEntry,
  Employee,
  PrePaymentSummary,
} from "@/lib/types";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

async function requireStaff(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Cash flow module is restricted to managers and admins.");
  }
  return user;
}

function assertStoreAccess(user: SessionUser, storeId: string) {
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (storeId !== activeStore) {
      throw new Error("You can only manage payouts for the store you're managing.");
    }
  }
}

function revalidateCashFlow() {
  for (const p of [
    "/cash-flow",
    "/cash-flow/payout",
    "/cash-flow/history",
    "/manager/cash-flow",
    "/manager/cash-flow/payout",
    "/manager/cash-flow/history",
    "/alerts",
    "/manager/alerts",
    "/dashboard",
  ]) {
    revalidatePath(p);
  }
}

/** Monday → that week's Tuesday (payment day). */
function tuesdayOf(weekStartISO: string): string {
  return toISODate(addDays(parseISODate(weekStartISO), 1));
}

/**
 * Opening balance for a store's week = the surplus carried forward from the most
 * recent confirmed payout in an earlier week (0 if carry-forward is disabled or
 * there is no prior confirmed payout).
 */
async function loadOpeningBalance(
  supabase: SupabaseClient,
  storeId: string,
  weekStartISO: string,
  carryForward: boolean,
): Promise<number> {
  if (!carryForward) return 0;
  const { data } = await supabase
    .from("cash_payouts")
    .select("surplus_carry_forward, week_start_date")
    .eq("store_id", storeId)
    .eq("status", "confirmed")
    .lt("week_start_date", weekStartISO)
    .order("week_start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.surplus_carry_forward ?? 0) || 0;
}

/**
 * Compute the live pre-payment summary for a store + week from current data.
 *
 * Pay structure (confirmed with the client): wages paid on this week's Tuesday
 * are for the PREVIOUS week's work (Mon–Sun). So the wage lines (hours +
 * deliveries) come from LAST week, while the cash available to pay them is the
 * Vita Mojo cash sales for the seven days ending the day before payday — the
 * Tuesday before this week through this Monday. (The payout is confirmed and
 * locked on payday Tuesday, so the cash window must END on the Monday before;
 * Tuesday's takings roll into next week's window instead of being lost after
 * the lock.)
 */
async function computeSummary(
  supabase: SupabaseClient,
  storeId: string,
  weekStartISO: string,
): Promise<PrePaymentSummary> {
  // Cash window: the Tuesday before this week → this Monday (Tue–Mon), i.e.
  // the seven days ending the day before payday Tuesday.
  const cashStart = toISODate(addDays(parseISODate(weekStartISO), -6));
  const cashEnd = toISODate(addDays(parseISODate(weekStartISO), 0));
  // The week being PAID: the previous Monday–Sunday.
  const payWeek = payWeekOf(weekStartISO);

  const [
    entriesRes,
    employeesRes,
    clocksRes,
    shiftsRes,
    settingsRes,
    coverRes,
    managersRes,
    managerClocksRes,
  ] = await Promise.all([
    supabase
      .from("daily_cash_entries")
      .select("*")
      .eq("store_id", storeId)
      .gte("entry_date", cashStart)
      .lte("entry_date", cashEnd),
    // Leavers stay included — wages are a week in arrears, so someone marked
    // "left" is still owed for the pay week they worked. All employees are
    // candidates (not just this store's): a visiting worker earns cash at the
    // store they actually worked. buildWageLinesForStore keeps only those with
    // pay due at this store.
    supabase.from("employees").select("*"),
    // Whole pay week across ALL stores — the weekly NI/cash split is per
    // employee (not per store), so it must see the employee's full week to
    // attribute cash hours to the store where they were worked.
    supabase
      .from("clock_events")
      .select(
        "employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, hours_approved, approved_hours, approved_short_deliveries_count, approved_long_deliveries_count, approved_extra_short_deliveries, approved_extra_long_deliveries",
      )
      .gte("event_date", payWeek.start)
      .lte("event_date", payWeek.end),
    supabase
      .from("rota_shifts")
      .select("employee_id, store_id, shift_date, is_day_off, scheduled_hours")
      .gte("shift_date", payWeek.start)
      .lte("shift_date", payWeek.end),
    supabase.from("app_settings").select("key, value"),
    // Cover drivers are paid from APPROVED days only — their pay is settled at
    // approval, where the rates were snapshotted. Scoped to this store; unlike
    // employees they aren't loaned between stores.
    supabase
      .from("cover_driver_hours_computed")
      .select(
        "cover_driver_id, driver_name, store_id, work_date, total_hours_worked, hourly_rate_snapshot, short_deliveries, long_deliveries, short_rate_snapshot, long_rate_snapshot, approved",
      )
      .eq("store_id", storeId)
      .eq("approved", true)
      .gte("work_date", payWeek.start)
      .lte("work_date", payWeek.end),
    // Managers who covered deliveries (migration 034). Only the drops are paid
    // — their salary never comes through this sheet. Scoped to this store: a
    // manager's day carries the store they clocked in at.
    supabase
      .from("allowed_users")
      .select("id, name, short_delivery_rate, long_delivery_rate")
      .eq("role", "manager"),
    supabase
      .from("manager_clock_events")
      .select(
        "manager_id, store_id, event_date, approved_short_deliveries_count, approved_long_deliveries_count, approved_extra_short_deliveries, approved_extra_long_deliveries",
      )
      .eq("store_id", storeId)
      .gte("event_date", payWeek.start)
      .lte("event_date", payWeek.end),
  ]);

  const settings = mergeSettings(settingsRes.data ?? []);
  const entries = (entriesRes.data ?? []) as DailyCashEntry[];
  const employees = (employeesRes.data ?? []) as Employee[];
  const lines = [
    ...buildWageLinesForStore(
      storeId,
      employees,
      clocksRes.data ?? [],
      shiftsRes.data ?? [],
    ),
    ...buildCoverDriverWageLines(
      storeId,
      (coverRes.data ?? []) as CoverDriverPayRow[],
    ),
    ...buildManagerWageLines(
      storeId,
      (managersRes.data ?? []) as ManagerPayee[],
      (managerClocksRes.data ?? []) as ManagerPayRow[],
    ),
  ].sort((a, b) => b.total_payment - a.total_payment);
  const opening = await loadOpeningBalance(
    supabase,
    storeId,
    weekStartISO,
    settings.cash_flow.carry_forward_surplus,
  );

  return buildPrePaymentSummary({
    store_id: storeId,
    week_start_date: weekStartISO,
    opening_balance: opening,
    entries,
    lines,
    supermarket_cash: settings.cash_flow.supermarket_default_cash,
  });
}

/** Read-only live pre-payment summary (for the payout screen / dashboard forecast). */
export async function getPrePaymentSummary(input: {
  store_id: string;
  week_start: string;
}): Promise<PrePaymentSummary> {
  const user = await requireStaff();
  assertStoreAccess(user, input.store_id);
  const supabase = createServerSupabase();
  const weekStart = toISODate(startOfISOWeek(parseISODate(input.week_start)));
  return computeSummary(supabase, input.store_id, weekStart);
}

/**
 * Generate (or refresh) the persisted payout sheet for a store + week. Creates a
 * draft cash_payouts header plus one line per employee receiving cash. Re-running
 * recomputes amounts while preserving each line's "paid" flag. A confirmed
 * (locked) payout cannot be regenerated until a Super Admin unlocks it.
 */
export async function generatePayout(input: {
  store_id: string;
  week_start: string;
}): Promise<{ ok: true; payout_id: string }> {
  const user = await requireStaff();
  assertStoreAccess(user, input.store_id);
  const supabase = createServerSupabase();
  const weekStart = toISODate(startOfISOWeek(parseISODate(input.week_start)));

  const summary = await computeSummary(supabase, input.store_id, weekStart);

  // Existing header?
  const { data: existing } = await supabase
    .from("cash_payouts")
    .select("id, locked")
    .eq("store_id", input.store_id)
    .eq("week_start_date", weekStart)
    .maybeSingle();

  if (existing?.locked) {
    throw new Error("This payout is confirmed and locked. A Super Admin must unlock it to regenerate.");
  }

  const headerPayload = {
    store_id: input.store_id,
    week_start_date: weekStart,
    payment_date: tuesdayOf(weekStart),
    status: "draft" as const,
    opening_balance: summary.opening_balance,
    cash_collected: summary.cash_collected,
    logged_differences: summary.logged_differences,
    actual_cash_available: summary.actual_cash_available,
    total_cash_wages: summary.total_cash_wages,
    total_delivery_wages: summary.total_delivery_wages,
    grand_total_wages: summary.grand_total_wages,
    post_office_draw: summary.post_office_draw,
    surplus_carry_forward: summary.surplus,
  };

  let payoutId: string;
  if (existing) {
    const { error } = await supabase
      .from("cash_payouts")
      .update(headerPayload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    payoutId = existing.id;
  } else {
    const { data, error } = await supabase
      .from("cash_payouts")
      .insert(headerPayload)
      .select("id")
      .maybeSingle();
    if (error || !data) throw new Error(error?.message ?? "Failed to create payout");
    payoutId = data.id;
  }

  // Preserve existing paid flags across regeneration.
  const { data: priorLines } = await supabase
    .from("cash_payout_lines")
    .select("id, employee_id, cover_driver_id, manager_id, is_paid, paid_at, paid_by_name")
    .eq("payout_id", payoutId);

  // A line is keyed by whichever payee it carries — employees, cover drivers
  // and managers live in three different tables, so one map keyed on
  // employee_id alone would lose the others' "paid" tick on regeneration.
  const lineKey = (l: {
    employee_id?: string | null;
    cover_driver_id?: string | null;
    manager_id?: string | null;
  }) =>
    l.cover_driver_id
      ? `cd:${l.cover_driver_id}`
      : l.manager_id
        ? `mgr:${l.manager_id}`
        : `emp:${l.employee_id}`;

  const priorByKey = new Map((priorLines ?? []).map((l) => [lineKey(l), l]));
  const keepKeys = new Set(summary.lines.map(lineKey));

  // Upsert each computed line.
  for (const line of summary.lines) {
    const prior = priorByKey.get(lineKey(line));
    const isCover = !!line.cover_driver_id;
    const isManager = !!line.manager_id;
    const payload = {
      payout_id: payoutId,
      // Exactly one of the three, enforced by cash_payout_lines_one_payee.
      employee_id: isCover || isManager ? null : line.employee_id,
      cover_driver_id: isCover ? line.cover_driver_id : null,
      manager_id: isManager ? line.manager_id : null,
      employee_name: line.employee_name,
      role: line.role,
      cash_hours: line.cash_hours,
      cash_rate: line.cash_rate,
      cash_wage: line.cash_wage,
      short_deliveries_count: line.short_deliveries_count,
      long_deliveries_count: line.long_deliveries_count,
      short_misc_count: line.short_misc_count,
      long_misc_count: line.long_misc_count,
      short_delivery_rate: line.short_delivery_rate,
      long_delivery_rate: line.long_delivery_rate,
      delivery_wages: line.delivery_wages,
      total_payment: line.total_payment,
      is_paid: prior?.is_paid ?? false,
      paid_at: prior?.paid_at ?? null,
      paid_by_name: prior?.paid_by_name ?? null,
    };
    // Update/insert by hand rather than onConflict: a line is keyed by EITHER
    // employee_id or cover_driver_id, and a single ON CONFLICT target can't
    // cover both.
    if (prior) {
      const { error } = await supabase
        .from("cash_payout_lines")
        .update(payload)
        .eq("id", prior.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cash_payout_lines").insert(payload);
      if (error) throw new Error(error.message);
    }
  }

  // Remove lines for anyone no longer in the payout.
  const staleIds = (priorLines ?? [])
    .filter((l) => !keepKeys.has(lineKey(l)))
    .map((l) => l.id);
  if (staleIds.length) {
    await supabase.from("cash_payout_lines").delete().in("id", staleIds);
  }

  await writeAudit({
    action: existing ? "regenerate" : "generate",
    entity: "cash_payout",
    entity_id: payoutId,
    changes: { store_id: input.store_id, week_start: weekStart, grand_total: summary.grand_total_wages },
  });

  revalidateCashFlow();
  return { ok: true, payout_id: payoutId };
}

/** Mark one payout line as paid / unpaid. Blocked once the payout is locked. */
export async function markLinePaid(input: {
  line_id: string;
  paid: boolean;
}): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: line } = await supabase
    .from("cash_payout_lines")
    .select("id, payout_id, cash_payouts!inner(store_id, locked)")
    .eq("id", input.line_id)
    .maybeSingle();
  if (!line) throw new Error("Payout line not found");
  const parent = (line as unknown as { cash_payouts: { store_id: string; locked: boolean } }).cash_payouts;
  assertStoreAccess(user, parent.store_id);
  if (parent.locked) throw new Error("This payout is locked.");

  const { error } = await supabase
    .from("cash_payout_lines")
    .update({
      is_paid: input.paid,
      paid_at: input.paid ? new Date().toISOString() : null,
      paid_by_name: input.paid ? (user.allowed!.name ?? user.email) : null,
    })
    .eq("id", input.line_id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: input.paid ? "mark_paid" : "mark_unpaid",
    entity: "cash_payout_line",
    entity_id: input.line_id,
  });
  revalidateCashFlow();
  return { ok: true };
}

/**
 * Confirm all wage payments for a payout: requires every line marked paid, then
 * records confirmation, locks the record, and finalises the carry-forward
 * surplus (§3.7). Re-reads the live summary so the locked snapshot is final.
 */
export async function confirmPayout(input: { payout_id: string }): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: payout } = await supabase
    .from("cash_payouts")
    .select("id, store_id, week_start_date, locked")
    .eq("id", input.payout_id)
    .maybeSingle();
  if (!payout) throw new Error("Payout not found");
  assertStoreAccess(user, payout.store_id);
  if (payout.locked) throw new Error("This payout is already confirmed.");

  const { data: lines } = await supabase
    .from("cash_payout_lines")
    .select("id, is_paid, employee_id, cover_driver_id, manager_id, total_payment")
    .eq("payout_id", input.payout_id);
  if (!lines || lines.length === 0) throw new Error("No wage lines to confirm.");
  const unpaid = lines.filter((l) => !l.is_paid).length;
  if (unpaid > 0) {
    throw new Error(`${unpaid} employee${unpaid === 1 ? "" : "s"} not yet marked as paid. Mark all as paid before confirming.`);
  }

  // Finalise the financial snapshot from live data.
  const summary = await computeSummary(supabase, payout.store_id, payout.week_start_date);

  // The locked header must match the lines that were actually ticked as paid.
  // If pay-week data changed after the sheet was generated (hours approved,
  // deliveries edited), force a regenerate (which preserves paid flags) so the
  // snapshot and the carried-forward surplus reflect what was really paid out.
  // Keyed by payee, not employee_id: cover driver and manager lines have a null
  // employee_id, so keying on it alone would collapse them all onto one map
  // entry and the drift check would silently pass on wrong numbers.
  const payeeKey = (l: {
    employee_id?: string | null;
    cover_driver_id?: string | null;
    manager_id?: string | null;
  }) =>
    l.cover_driver_id
      ? `cd:${l.cover_driver_id}`
      : l.manager_id
        ? `mgr:${l.manager_id}`
        : `emp:${l.employee_id}`;
  const storedByPayee = new Map(lines.map((l) => [payeeKey(l), Number(l.total_payment)]));
  const drift =
    summary.lines.length !== storedByPayee.size ||
    summary.lines.some(
      (l) => Math.abs((storedByPayee.get(payeeKey(l)) ?? Number.NaN) - l.total_payment) > 0.005,
    );
  if (drift) {
    throw new Error(
      "Wage data for the pay week changed after this sheet was generated. Regenerate the payout sheet, re-check the payments, then confirm.",
    );
  }

  const { error } = await supabase
    .from("cash_payouts")
    .update({
      status: "confirmed",
      locked: true,
      payment_date: tuesdayOf(payout.week_start_date),
      opening_balance: summary.opening_balance,
      cash_collected: summary.cash_collected,
      logged_differences: summary.logged_differences,
      actual_cash_available: summary.actual_cash_available,
      total_cash_wages: summary.total_cash_wages,
      total_delivery_wages: summary.total_delivery_wages,
      grand_total_wages: summary.grand_total_wages,
      post_office_draw: summary.post_office_draw,
      surplus_carry_forward: summary.surplus,
      confirmed_by: user.id,
      confirmed_by_name: user.allowed!.name ?? user.email,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", input.payout_id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "confirm",
    entity: "cash_payout",
    entity_id: input.payout_id,
    changes: { grand_total: summary.grand_total_wages, surplus: summary.surplus, draw: summary.post_office_draw },
  });
  void scanForAlertsBackground();
  revalidateCashFlow();
  return { ok: true };
}

/** Unlock a confirmed payout for amendment — Super Admins only. */
export async function unlockPayout(input: { payout_id: string }): Promise<{ ok: true }> {
  const user = await getSessionUser();
  if (!user || user.allowed?.role !== "admin") {
    throw new Error("Only Super Admins can unlock a confirmed payout.");
  }
  const supabase = createServerSupabase();
  const { error } = await supabase
    .from("cash_payouts")
    .update({
      status: "draft",
      locked: false,
      confirmed_by: null,
      confirmed_by_name: null,
      confirmed_at: null,
    })
    .eq("id", input.payout_id);
  if (error) throw new Error(error.message);
  await writeAudit({ action: "unlock", entity: "cash_payout", entity_id: input.payout_id });
  revalidateCashFlow();
  return { ok: true };
}

/** Delete a payout record (and its lines) — Super Admins only. */
export async function deletePayout(input: { payout_id: string; reason?: string | null }): Promise<{ ok: true }> {
  const user = await getSessionUser();
  if (!user || user.allowed?.role !== "admin") {
    throw new Error("Only Super Admins can delete a payout record.");
  }
  const supabase = createServerSupabase();
  const { error } = await supabase.from("cash_payouts").delete().eq("id", input.payout_id);
  if (error) throw new Error(error.message);
  await writeAudit({
    action: "delete",
    entity: "cash_payout",
    entity_id: input.payout_id,
    changes: { reason: input.reason ?? null },
  });
  revalidateCashFlow();
  return { ok: true };
}

/** Find the stored payout (with lines) for a store + week, if one exists. */
export async function getPayoutForWeek(input: {
  store_id: string;
  week_start: string;
}): Promise<CashPayoutWithLines | null> {
  const user = await requireStaff();
  assertStoreAccess(user, input.store_id);
  const supabase = createServerSupabase();
  const weekStart = toISODate(startOfISOWeek(parseISODate(input.week_start)));
  const { data } = await supabase
    .from("cash_payouts")
    .select("*, stores(name), cash_payout_lines(*)")
    .eq("store_id", input.store_id)
    .eq("week_start_date", weekStart)
    .maybeSingle();
  if (!data) return null;
  const { stores, cash_payout_lines, ...header } = data as Record<string, unknown> & {
    stores: { name: string } | null;
    cash_payout_lines: unknown[];
  };
  return {
    ...(header as unknown as CashPayoutWithLines),
    store_name: stores?.name ?? null,
    lines: ((cash_payout_lines ?? []) as CashPayoutWithLines["lines"]).sort(
      (a, b) => b.total_payment - a.total_payment,
    ),
  };
}

/** Load a stored payout with its lines (for the history detail / confirmation screen). */
export async function loadPayout(input: { payout_id: string }): Promise<CashPayoutWithLines | null> {
  const user = await requireStaff();
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("cash_payouts")
    .select("*, stores(name), cash_payout_lines(*)")
    .eq("id", input.payout_id)
    .maybeSingle();
  if (!data) return null;
  assertStoreAccess(user, data.store_id);
  const { stores, cash_payout_lines, ...header } = data as Record<string, unknown> & {
    stores: { name: string } | null;
    cash_payout_lines: unknown[];
  };
  return {
    ...(header as unknown as CashPayoutWithLines),
    store_name: stores?.name ?? null,
    lines: (cash_payout_lines ?? []) as CashPayoutWithLines["lines"],
  };
}
