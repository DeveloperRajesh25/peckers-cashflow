"use server";

import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import type { CashPayoutLine } from "@/lib/types";
import {
  PAYOUT_HISTORY_MAX_ROWS,
  PAYOUT_HISTORY_SELECT,
  mapPayoutHeaders,
  type PayoutHistoryExportRow,
  type PayoutHistoryFilters,
  type PayoutHistoryHeader,
} from "@/lib/payout-history-paging";

async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

/**
 * A manager's scope is theirs to SEE, not theirs to CHOOSE. A server action is
 * a public endpoint and the admin page's requireRole does not cover it, so the
 * store is re-derived here rather than trusted from the argument.
 */
async function resolveScopeStoreId(requested: string): Promise<string | null> {
  const user = await requireAllowed();
  if (user.allowed!.role === "manager") {
    return resolveActiveStoreId(user.allowed) ?? null;
  }
  return requested || null;
}

/**
 * Payout ids whose lines carry an employee matching `name`.
 *
 * Deliberately a SEPARATE query rather than `cash_payout_lines!inner(*)` with
 * the filter on the embedded resource: PostgREST would filter the embedded ROWS
 * as well as the parents, so expanding a matched payout would show only the
 * matching employee and hide everyone else paid that week. On a payroll record
 * that is silent corruption, not a filter.
 *
 * No date/store predicate is applied here either — the caller's main query
 * already carries both, so narrowing twice would only add an embed whose
 * behaviour could not be verified against this database. The id set stays small
 * in practice (one employee's payouts), so the follow-up `.in()` URL is short.
 */
async function payoutIdsMatchingName(
  supabase: ReturnType<typeof createServerSupabase>,
  name: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("cash_payout_lines")
    .select("payout_id")
    .ilike("employee_name", `%${name}%`);

  if (error) throw new Error(error.message);
  return Array.from(new Set((data ?? []).map((r) => r.payout_id as string)));
}


/**
 * The payout list — headers and line COUNTS only. Filtering happens here rather
 * than in the browser so the page stops shipping every line of every payout
 * just to support a name search.
 */
export async function listPayoutHistory(
  filters: PayoutHistoryFilters,
): Promise<PayoutHistoryHeader[]> {
  const storeId = await resolveScopeStoreId(filters.storeId);
  const supabase = createServerSupabase();

  let matchingIds: string[] | null = null;
  const name = filters.name.trim();
  if (name) {
    matchingIds = await payoutIdsMatchingName(supabase, name);
    // No line matched, so no payout can — skip the second round trip entirely.
    if (matchingIds.length === 0) return [];
  }

  let q = supabase.from("cash_payouts").select(PAYOUT_HISTORY_SELECT);

  if (filters.from) q = q.gte("week_start_date", filters.from);
  if (filters.to) q = q.lte("week_start_date", filters.to);
  if (storeId) q = q.eq("store_id", storeId);
  if (matchingIds) q = q.in("id", matchingIds);

  const { data, error } = await q
    .order("week_start_date", { ascending: false })
    // week_start_date collides across stores every single week, so an unstable
    // order would shuffle cards between refetches (and duplicate/skip rows the
    // moment this is paginated).
    .order("store_id")
    .order("id")
    .limit(PAYOUT_HISTORY_MAX_ROWS);

  if (error) throw new Error(error.message);
  return mapPayoutHeaders(data ?? []);
}

/**
 * One payout's lines, fetched when its card is expanded. Sorted highest-paid
 * first, server-side, to match the order the page used when it loaded every
 * line up front.
 */
export async function loadPayoutLines(payoutId: string): Promise<CashPayoutLine[]> {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  // Managers may only open their own store's payouts. RLS is the real gate;
  // this makes the refusal explicit rather than returning a silent empty list
  // that would read as "nobody was paid that week".
  if (user.allowed!.role === "manager") {
    const storeId = resolveActiveStoreId(user.allowed) ?? null;
    const { data: owner, error: ownerErr } = await supabase
      .from("cash_payouts")
      .select("store_id")
      .eq("id", payoutId)
      .maybeSingle();
    if (ownerErr) throw new Error(ownerErr.message);
    if (!owner || owner.store_id !== storeId) throw new Error("Not authorised");
  }

  const { data, error } = await supabase
    .from("cash_payout_lines")
    .select("*")
    .eq("payout_id", payoutId)
    .order("total_payment", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CashPayoutLine[];
}

/**
 * The full filtered set WITH lines, for CSV and PDF.
 *
 * The exports have always covered everything matching the filter, not just what
 * is on screen. Deferring the lines must not quietly shrink a payroll export to
 * the one card the user happened to open, so this is its own path rather than a
 * read of whatever the list has cached.
 */
export async function exportPayoutHistory(
  filters: PayoutHistoryFilters,
): Promise<PayoutHistoryExportRow[]> {
  const headers = await listPayoutHistory(filters);
  if (headers.length === 0) return [];

  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from("cash_payout_lines")
    .select("*")
    .in(
      "payout_id",
      headers.map((h) => h.id),
    )
    .order("total_payment", { ascending: false });

  if (error) throw new Error(error.message);

  const byPayout = new Map<string, CashPayoutLine[]>();
  for (const line of (data ?? []) as CashPayoutLine[]) {
    const arr = byPayout.get(line.payout_id) ?? [];
    arr.push(line);
    byPayout.set(line.payout_id, arr);
  }

  return headers.map((h) => ({ ...h, lines: byPayout.get(h.id) ?? [] }));
}
