// =============================================================
// Cash Flow — shared server-side data loaders.
// Used by both the admin (/cash-flow/*) and manager (/manager/cash-flow/*)
// pages so the two portals stay in sync. Server-only (uses Supabase + cookies).
// =============================================================

import { createServerSupabase } from "./supabase-server";
import { mergeSettings } from "./settings";
import { runningBalanceRows } from "./cash-flow";
import { getPrePaymentSummary } from "@/app/actions/payouts";
import { addDays, parseISODate, toISODate } from "./utils";
import type { DailyCashEntry } from "./types";
import type { StoreCashView } from "@/components/cash-flow/CashFlowDashboard";

type StoreOpt = { id: string; name: string };

/** Whether carry-forward is enabled (from app_settings). */
async function carryForwardEnabled(): Promise<boolean> {
  const supabase = createServerSupabase();
  const { data } = await supabase.from("app_settings").select("key, value");
  return mergeSettings(data ?? []).cash_flow.carry_forward_surplus;
}

/** Opening balances (carried-forward surplus) per store for a given week. */
export async function loadOpeningBalances(
  storeIds: string[],
  weekStart: string,
): Promise<Record<string, number>> {
  if (storeIds.length === 0) return {};
  if (!(await carryForwardEnabled())) return {};
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("cash_payouts")
    .select("store_id, surplus_carry_forward, week_start_date")
    .in("store_id", storeIds)
    .eq("status", "confirmed")
    .lt("week_start_date", weekStart)
    .order("week_start_date", { ascending: false });
  const map: Record<string, number> = {};
  for (const r of data ?? []) {
    if (!(r.store_id in map)) map[r.store_id] = Number(r.surplus_carry_forward) || 0;
  }
  return map;
}

/**
 * Entries for the last `days` days (today + previous days) for the given stores.
 * Used by the quick 3-date entry form so it can pre-fill an existing entry even
 * when "yesterday"/"day before" fall in the previous week.
 */
export async function loadRecentEntries(
  storeIds: string[],
  days = 3,
): Promise<DailyCashEntry[]> {
  if (storeIds.length === 0) return [];
  const supabase = createServerSupabase();
  const start = toISODate(addDays(new Date(), -(days - 1)));
  const { data } = await supabase
    .from("daily_cash_entries")
    .select("*")
    .in("store_id", storeIds)
    .gte("entry_date", start)
    .order("entry_date", { ascending: false });
  return (data ?? []) as DailyCashEntry[];
}

/** All daily entries for the given stores within a week. */
export async function loadWeekEntries(
  storeIds: string[],
  weekStart: string,
): Promise<DailyCashEntry[]> {
  if (storeIds.length === 0) return [];
  const supabase = createServerSupabase();
  const weekEnd = toISODate(addDays(parseISODate(weekStart), 6));
  const { data } = await supabase
    .from("daily_cash_entries")
    .select("*")
    .in("store_id", storeIds)
    .gte("entry_date", weekStart)
    .lte("entry_date", weekEnd)
    .order("entry_date");
  return (data ?? []) as DailyCashEntry[];
}

/**
 * One store's dashboard view model. The four reads are independent of each
 * other, so they go out together rather than one at a time.
 */
export async function buildStoreCashView(
  store: StoreOpt,
  weekStart: string,
): Promise<StoreCashView> {
  const supabase = createServerSupabase();
  const weekEnd = toISODate(addDays(parseISODate(weekStart), 6));

  const [summary, entriesRes, lastRes, payoutRes] = await Promise.all([
    getPrePaymentSummary({ store_id: store.id, week_start: weekStart }),
    supabase
      .from("daily_cash_entries")
      .select("*")
      .eq("store_id", store.id)
      .gte("entry_date", weekStart)
      .lte("entry_date", weekEnd)
      .order("entry_date"),
    supabase
      .from("daily_cash_entries")
      .select("submitted_by_name, edited_by_name, entry_date, created_at, edited_at")
      .eq("store_id", store.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("cash_payouts")
      .select("status")
      .eq("store_id", store.id)
      .eq("week_start_date", weekStart)
      .maybeSingle(),
  ]);

  const weekEntries = (entriesRes.data ?? []) as DailyCashEntry[];
  const rows = runningBalanceRows(weekEntries, summary.opening_balance);
  const runningBalance = rows.length
    ? rows[rows.length - 1].running_balance
    : summary.opening_balance;
  const last = lastRes.data;

  return {
    store,
    openingBalance: summary.opening_balance,
    runningBalance,
    rows,
    discrepancyDays: weekEntries.filter(
      (e) => Math.abs(Number(e.difference) || 0) > 0.001,
    ).length,
    summary,
    lastEntry: last
      ? {
          name: last.edited_by_name ?? last.submitted_by_name,
          date: last.entry_date,
          at: last.edited_at ?? last.created_at,
        }
      : null,
    payoutStatus: (payoutRes.data?.status as "draft" | "confirmed" | undefined) ?? "none",
  };
}

/** Rich per-store dashboard view models for the cash flow dashboard. */
export async function buildDashboardViews(
  stores: StoreOpt[],
  weekStart: string,
): Promise<StoreCashView[]> {
  return Promise.all(stores.map((store) => buildStoreCashView(store, weekStart)));
}
