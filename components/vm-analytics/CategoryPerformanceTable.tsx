"use client";

import { Fragment, useState } from "react";
import { int, gbp, signedPct, deltaClass } from "@/lib/vm-analytics/format";

// Each WoW column carries the previous week's revenue alongside its percentage,
// so the % can be traced back to the figure it was measured against. The `*Prev`
// fields are null exactly when their percentage is null (no prior revenue).
export interface CategoryItem {
  item: string;
  units: number;
  revenue: number;
  revWow: number | null;
  revPrev: number | null;
  hitchinWow: number | null;
  hitchinPrev: number | null;
  stevenageWow: number | null;
  stevenagePrev: number | null;
  qRevenue: number;
  qPct: number | null;
}

export interface CategoryPerf {
  category: string;
  units: number;
  revenue: number;
  revWow: number | null;
  revPrev: number | null;
  hitchinWow: number | null;
  hitchinPrev: number | null;
  stevenageWow: number | null;
  stevenagePrev: number | null;
  qRevenue: number;
  qPct: number | null;
  items: CategoryItem[];
}

// Previous-week revenue with its delta underneath in a smaller font, coloured
// green when up and red when down. `dense` is used on the drill-down rows, which
// already render at text-xs.
function WowCell({
  prev,
  pct,
  dense,
}: {
  prev: number | null;
  pct: number | null;
  dense?: boolean;
}) {
  if (prev === null || pct === null) return <span className="text-tertiary">—</span>;
  return (
    <span className={deltaClass(pct)}>
      {gbp(prev)}
      <span className={`ml-1 font-medium ${dense ? "text-[10px]" : "text-xs"}`}>
        ({signedPct(pct)})
      </span>
    </span>
  );
}

// Trailing 16-week net revenue with its change vs the previous 16 weeks. Unlike
// WowCell this leads with the CURRENT figure — the quarter total is the number
// being reported, and the % is the qualifier on it. `pct` is null when the
// previous window has no revenue to measure against (a new item, or not enough
// history loaded yet), in which case the total still stands on its own.
function QuarterCell({
  revenue,
  pct,
  dense,
}: {
  revenue: number;
  pct: number | null;
  dense?: boolean;
}) {
  if (revenue <= 0) return <span className="text-tertiary">—</span>;
  return (
    <span className={dense ? "text-secondary" : "text-primary"}>
      {gbp(revenue)}
      <span
        className={`ml-1 font-medium ${dense ? "text-[10px]" : "text-xs"} ${
          pct === null ? "text-tertiary" : deltaClass(pct)
        }`}
      >
        ({signedPct(pct)})
      </span>
    </span>
  );
}

// showStoreWow adds the per-store Hitchin/Stevenage WoW columns. They only make
// sense in combined view — when a single store is selected they'd just duplicate
// the (already store-scoped) Revenue WoW column, so the page hides them.
export function CategoryPerformanceTable({
  rows,
  showStoreWow = false,
  showQuarter = false,
}: {
  rows: CategoryPerf[];
  showStoreWow?: boolean;
  showQuarter?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (category: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(category) ? next.delete(category) : next.add(category);
      return next;
    });

  return (
    <div className="vm-table-container">
      <div className="table-scroll overflow-x-auto">
        <table className="vm-table text-sm">
          <thead>
            <tr className="bg-surface-hover text-secondary">
              <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-left">
                Category
              </th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                Units Sold
              </th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                Revenue
              </th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                Revenue WoW
              </th>
              {showStoreWow && (
                <>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                    Hitchin WoW
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                    Stevenage WoW
                  </th>
                </>
              )}
              {showQuarter && (
                <th className="whitespace-nowrap px-4 py-3 font-semibold uppercase text-xs tracking-wide border-b border-line text-right">
                  Quarterly Revenue
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4 + (showStoreWow ? 2 : 0) + (showQuarter ? 1 : 0)} className="px-4 py-8 text-center text-tertiary">
                  No data for this week.
                </td>
              </tr>
            ) : (
              rows.map((cat) => {
                const isOpen = expanded.has(cat.category);
                return (
                  <Fragment key={cat.category}>
                    <tr
                      onClick={() => toggle(cat.category)}
                      className="cursor-pointer hover:bg-surface-hover"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-primary text-left font-medium">
                        <span className="mr-2 inline-block w-3 text-tertiary">
                          {isOpen ? "▾" : "▸"}
                        </span>
                        {cat.category}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-primary text-right tabular-nums">
                        {int(cat.units)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-primary text-right tabular-nums">
                        {gbp(cat.revenue)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                        <WowCell prev={cat.revPrev} pct={cat.revWow} />
                      </td>
                      {showStoreWow && (
                        <>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            <WowCell prev={cat.hitchinPrev} pct={cat.hitchinWow} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                            <WowCell prev={cat.stevenagePrev} pct={cat.stevenageWow} />
                          </td>
                        </>
                      )}
                      {showQuarter && (
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                          <QuarterCell revenue={cat.qRevenue} pct={cat.qPct} />
                        </td>
                      )}
                    </tr>
                    {isOpen &&
                      cat.items.map((it) => (
                        <tr key={`${cat.category}::${it.item}`} className="bg-surface-hover/40">
                          <td className="whitespace-nowrap px-4 py-2 pl-8 text-secondary text-left text-xs">
                            {it.item}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-secondary text-right tabular-nums text-xs">
                            {int(it.units)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-secondary text-right tabular-nums text-xs">
                            {gbp(it.revenue)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-xs">
                            <WowCell prev={it.revPrev} pct={it.revWow} dense />
                          </td>
                          {showStoreWow && (
                            <>
                              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-xs">
                                <WowCell prev={it.hitchinPrev} pct={it.hitchinWow} dense />
                              </td>
                              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-xs">
                                <WowCell prev={it.stevenagePrev} pct={it.stevenageWow} dense />
                              </td>
                            </>
                          )}
                          {showQuarter && (
                            <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-xs">
                              <QuarterCell revenue={it.qRevenue} pct={it.qPct} dense />
                            </td>
                          )}
                        </tr>
                      ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
