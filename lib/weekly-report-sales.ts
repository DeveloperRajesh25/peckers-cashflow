// =============================================================
// The VM half of the weekly report: the two sales scalars and the per-platform
// delivery split.
//
// Kept out of app/actions/weekly-report.ts deliberately — every export of a
// "use server" module is a client-callable endpoint, and these are plain reads
// a page performs for itself.
//
// Sales stay in the VM project and are fetched at render time, exactly as the
// existing Weekly Summary page already does. Nothing is copied across the
// project boundary except at LOCK, where the figure is frozen on the snapshot.
// =============================================================

import {
  getComparison,
  getDelivery,
  getExec,
  getGrossSalesByChannel,
} from "./vm-analytics/queries";
import { num } from "./weekly-report";

export type VmSales = { gross_sales: number; net_sales: number };

/**
 * Sales for one store-week. Net comes from the EXEC view and gross from the
 * comparison view — `vm_v_store_comparison.net_sales` has historically returned
 * wrong values, and the exec view does not expose gross.
 *
 * Returns zeroes rather than throwing: a week VM has not synced yet must still
 * be enterable, which is the whole reason a manager can start a report early.
 */
export async function loadVmSales(
  vmStoreName: string | null,
  weekIso: string,
): Promise<VmSales> {
  if (!vmStoreName) return { gross_sales: 0, net_sales: 0 };
  try {
    const [comparison, exec] = await Promise.all([
      getComparison(weekIso),
      getExec(weekIso),
    ]);
    const comp = comparison.find((r) => r.store === vmStoreName);
    const ex = exec.find((r) => r.store === vmStoreName);
    return {
      gross_sales: num(comp?.gross_sales),
      net_sales: num(ex?.net_sales ?? comp?.net_sales),
    };
  } catch {
    return { gross_sales: 0, net_sales: 0 };
  }
}

export type VmPlatformSales = {
  /** Which basis `rows` is in — the aggregator sheet labels its column from it. */
  basis: "gross" | "net";
  rows: Array<{ platform: string; sales: number }>;
};

/**
 * Per-platform sales for the aggregator tab, GROSS to match the spreadsheet and
 * the commission the platforms actually charge. Falls back to the delivery
 * mix's NET for a week `vm_sales_store_channel` has not ingested; `basis` says
 * which came back, and an empty `rows` means VM has no week at all.
 */
export async function loadVmPlatformSales(
  vmStoreName: string | null,
  weekIso: string,
): Promise<VmPlatformSales> {
  if (!vmStoreName) return { basis: "gross", rows: [] };

  const gross = await getGrossSalesByChannel(weekIso)
    .then((rows) =>
      rows
        .filter((r) => r.store === vmStoreName)
        .map((r) => ({ platform: r.channel, sales: r.gross_sales })),
    )
    .catch(() => []);
  if (gross.length > 0) return { basis: "gross", rows: gross };

  try {
    const rows = await getDelivery(weekIso);
    return {
      basis: "net",
      rows: rows
        .filter((r) => r.store === vmStoreName && r.platform)
        .map((r) => ({ platform: r.platform, sales: num(r.net_sales) })),
    };
  } catch {
    return { basis: "net", rows: [] };
  }
}
