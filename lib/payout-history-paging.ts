// Shared between the payout-history server actions and PayoutHistoryView.
// Lives outside app/actions/payout-history.ts because a "use server" module may
// only export async functions.

import type { CashPayout, CashPayoutLine } from "./types";

/**
 * A payout card as the list renders it: the header, its store name, and how
 * many lines it holds. The LINES THEMSELVES ARE NOT HERE — every card is
 * collapsed by default and only one opens at a time, so shipping ~15 lines ×
 * every payout was the single largest payload in the app.
 *
 * `line_count` comes from a `cash_payout_lines(count)` embed, never from a
 * loaded array — the collapsed card prints "N employees" and that must stay
 * true whether or not the lines have been fetched.
 */
export type PayoutHistoryHeader = CashPayout & {
  store_name: string | null;
  line_count: number;
};

/** What the list is filtered by. All of it is applied in SQL, not the browser. */
export type PayoutHistoryFilters = {
  /** Inclusive `week_start_date` lower bound, or "" for none. */
  from: string;
  /** Inclusive `week_start_date` upper bound, or "" for none. */
  to: string;
  /** Store id, or "" for all. Ignored for managers — see listPayoutHistory. */
  storeId: string;
  /** Case-insensitive substring of an employee name on any of the payout's lines. */
  name: string;
};

export const EMPTY_PAYOUT_FILTERS: PayoutHistoryFilters = {
  from: "",
  to: "",
  storeId: "",
  name: "",
};

/**
 * The reachable window. 2 stores × 52 weeks ≈ 104 payouts a year, so this is
 * roughly five years of history — the cap is a guard rail, not a pager.
 */
export const PAYOUT_HISTORY_MAX_ROWS = 500;

/** A payout plus its lines, as the CSV/PDF export needs them. */
export type PayoutHistoryExportRow = PayoutHistoryHeader & {
  lines: CashPayoutLine[];
};

/**
 * The list query's select. Pulls only the line IDS, not the line rows — the
 * card header prints "N employees" and nothing else about them until it is
 * expanded.
 *
 * `cash_payout_lines(id)` rather than PostgREST's `(count)` aggregate embed on
 * purpose: aggregate embeds depend on the project having aggregate functions
 * enabled, which could not be verified against this database, and a payroll
 * screen is the wrong place to ship a query that might error. Ids are one
 * column instead of ~20 — the great majority of the saving, with none of the
 * uncertainty. Worth revisiting once someone can confirm the aggregate embed
 * against the live project.
 */
export const PAYOUT_HISTORY_SELECT = "*, stores(name), cash_payout_lines(id)";

/** Shape the list query's rows into headers. Shared by the pages and the action. */
export function mapPayoutHeaders(rows: unknown[]): PayoutHistoryHeader[] {
  return rows.map((row) => {
    const { stores, cash_payout_lines, ...header } = row as Record<string, unknown> & {
      stores: { name: string } | null;
      cash_payout_lines: Array<{ id: string }> | null;
    };
    return {
      ...(header as unknown as PayoutHistoryHeader),
      store_name: stores?.name ?? null,
      line_count: cash_payout_lines?.length ?? 0,
    };
  });
}
