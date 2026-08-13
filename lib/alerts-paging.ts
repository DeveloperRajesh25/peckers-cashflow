// Shared between the alerts server action and AlertsView. Lives outside
// app/actions/alerts.ts because a "use server" module may only export async
// functions.

import type { SystemAlert } from "./types";

export const ALERTS_PAGE_SIZE = 10;

/**
 * The working set: the 200 most recent alerts under the current filter, same
 * cap the page carried before it was paginated. Everything older is out of
 * reach here — the backlog is cleared by resolving, not by paging to page 714.
 */
export const ALERTS_MAX_ROWS = 200;

export type AlertsPage = {
  rows: SystemAlert[];
  /** Rows reachable under the current filter, already capped at
   *  ALERTS_MAX_ROWS. This is what the page count is derived from. */
  total: number;
  /** Unresolved rows matching the STORE filter, counted in the database and
   *  then capped. Never derived from the loaded page, which would under-report
   *  once paginated. */
  openCount: number;
  /** True when the real unresolved count exceeds the cap, so the badge can say
   *  "200+" rather than claiming there are exactly 200. */
  openCountCapped: boolean;
};

/** Pages available for a capped total. Always at least 1, so an empty result
 *  still renders "Page 1 of 1" rather than "Page 1 of 0". */
export function alertsPageCount(total: number, pageSize = ALERTS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
