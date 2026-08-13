"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { writeAudit } from "./audit";
import { scanForAlertsBackground } from "./alerts";
import { buildStoreCashView } from "@/lib/cash-flow-data";
import type { StoreCashView } from "@/components/cash-flow/CashFlowDashboard";
import { addDays, parseISODate, toISODate, todayISO } from "@/lib/utils";

async function requireStaff() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Cash flow module is restricted to managers and admins.");
  }
  return user;
}

function revalidateCashFlow() {
  for (const p of [
    "/cash-flow",
    "/cash-flow/daily",
    "/cash-flow/payout",
    "/cash-flow/history",
    "/manager/cash-flow",
    "/manager/cash-flow/daily",
    "/manager/cash-flow/payout",
    "/manager/cash-flow/history",
    "/alerts",
    "/manager/alerts",
    "/dashboard",
  ]) {
    revalidatePath(p);
  }
}

/**
 * One store's cash-flow dashboard, fetched when an admin switches store tabs.
 * The page builds the first store's view only.
 */
export async function loadStoreCashView(input: {
  store_id: string;
  week_start: string;
}): Promise<StoreCashView> {
  const user = await requireStaff();
  if (!input.store_id) throw new Error("Store is required");
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (input.store_id !== activeStore) {
      throw new Error("You can only view cash flow for the store you're managing.");
    }
  }

  const supabase = createServerSupabase();
  const { data: store } = await supabase
    .from("stores")
    .select("id, name")
    .eq("id", input.store_id)
    .maybeSingle();
  if (!store) throw new Error("Store not found");

  return buildStoreCashView(store, input.week_start);
}

/**
 * Create or update a store's daily cash reconciliation entry.
 * - Vita Mojo sales and envelope amount are mandatory.
 * - A reason is mandatory whenever a difference exists.
 * - Duplicate (store, date) entries are prevented — an existing row is edited
 *   instead, and the edit is stamped with the editor's name + timestamp.
 * - Entries for a past day are flagged as late submissions.
 */
export async function upsertDailyCashEntry(input: {
  store_id: string;
  entry_date: string;
  vita_mojo_sales: number;
  envelope_amount: number;
  supermarket_expenses?: number | null;
  reason?: string | null;
}) {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  // Managers may only write to the store they're currently operating as — their
  // ACTIVE store (home store, or whichever they've switched to). Admins: any store.
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (input.store_id !== activeStore) {
      throw new Error("You can only record cash entries for the store you're managing.");
    }
  }
  if (!input.store_id) throw new Error("Store is required");
  if (!input.entry_date) throw new Error("Date is required");

  // entry_date must be canonical YYYY-MM-DD — the window comparisons below are
  // lexicographic and a non-padded date (e.g. "2026-06-1") would slip past them.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entry_date)) {
    throw new Error("Invalid date format.");
  }
  const entryParsed = parseISODate(input.entry_date);
  if (isNaN(entryParsed.getTime()) || toISODate(entryParsed) !== input.entry_date) {
    throw new Error("Invalid date.");
  }

  // Entries can only be made for today or the past two days (e.g. on the 11th
  // you may enter the 11th, 10th or 9th — not the 8th). No future dates.
  // Admins are exempt from the lower bound so they can correct history.
  const today = todayISO();
  if (input.entry_date > today) {
    throw new Error("You can't record a cash entry for a future date.");
  }
  const earliestAllowed = toISODate(addDays(parseISODate(today), -2));
  if (user.allowed!.role === "manager" && input.entry_date < earliestAllowed) {
    throw new Error(
      "Cash entries can only be added for today or the past 2 days. Ask an admin to correct older dates.",
    );
  }

  const vita = Number(input.vita_mojo_sales);
  const envelope = Number(input.envelope_amount);
  const supermarketExpenses = Math.max(0, Number(input.supermarket_expenses) || 0);
  if (isNaN(vita) || input.vita_mojo_sales === ("" as unknown as number))
    throw new Error("Vita Mojo cash sales figure is required");
  if (isNaN(envelope) || input.envelope_amount === ("" as unknown as number))
    throw new Error("Cash placed in envelope is required");
  if (vita < 0 || envelope < 0) throw new Error("Amounts cannot be negative");

  const difference = Math.round((vita - envelope) * 100) / 100;
  // The envelope is EXPECTED to equal sales − supermarket expenses. A reason is
  // only required when the manager overrides it to something else.
  const expectedEnvelope = Math.round((vita - supermarketExpenses) * 100) / 100;
  const envelopeOverridden = Math.abs(envelope - expectedEnvelope) > 0.001;
  const reason = input.reason?.trim() || null;
  if (envelopeOverridden && !reason) {
    throw new Error(
      "The envelope should equal sales − supermarket expenses. Give a reason if it differs.",
    );
  }

  // Late if the entry is being recorded for a day that has already passed.
  const isLate = input.entry_date < todayISO();
  const submitterName = user.allowed!.name ?? user.email;

  // Look for an existing row to decide insert vs edit (and stamp the editor).
  const { data: existing } = await supabase
    .from("daily_cash_entries")
    .select("id")
    .eq("store_id", input.store_id)
    .eq("entry_date", input.entry_date)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("daily_cash_entries")
      .update({
        vita_mojo_sales: vita,
        envelope_amount: envelope,
        supermarket_expenses: supermarketExpenses,
        reason: envelopeOverridden ? reason : null,
        is_late: isLate,
        edited_by_name: submitterName,
        edited_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "update",
      entity: "daily_cash_entry",
      entity_id: existing.id,
      changes: { store_id: input.store_id, entry_date: input.entry_date, vita, envelope, difference, reason },
    });
  } else {
    const { data, error } = await supabase
      .from("daily_cash_entries")
      .insert({
        store_id: input.store_id,
        entry_date: input.entry_date,
        vita_mojo_sales: vita,
        envelope_amount: envelope,
        supermarket_expenses: supermarketExpenses,
        reason: envelopeOverridden ? reason : null,
        is_late: isLate,
        submitted_by: user.id,
        submitted_by_name: submitterName,
        submitted_by_email: user.email,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "create",
      entity: "daily_cash_entry",
      entity_id: data?.id ?? null,
      changes: { store_id: input.store_id, entry_date: input.entry_date, vita, envelope, difference, reason, is_late: isLate },
    });
  }

  // Refresh cash alerts (missing entry, discrepancy, negative balance, draw).
  void scanForAlertsBackground();
  revalidateCashFlow();
  return { ok: true, is_late: isLate, difference };
}

/** Delete a daily cash entry — Super Admins only (deletion is logged). */
export async function deleteDailyCashEntry(input: { id: string; reason?: string | null }) {
  const user = await getSessionUser();
  if (!user || user.allowed?.role !== "admin") {
    throw new Error("Only Super Admins can delete a cash entry.");
  }
  const supabase = createServerSupabase();
  const { error } = await supabase.from("daily_cash_entries").delete().eq("id", input.id);
  if (error) throw new Error(error.message);
  await writeAudit({
    action: "delete",
    entity: "daily_cash_entry",
    entity_id: input.id,
    changes: { reason: input.reason ?? null },
  });
  revalidateCashFlow();
  return { ok: true };
}
