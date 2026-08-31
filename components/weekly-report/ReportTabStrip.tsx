"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ReportTab } from "@/lib/weekly-report";

/**
 * The report's sub-pages, on ONE route with a ?tab= parameter.
 *
 * That is what makes "one week selector applies to every sub-page" free: ?week=
 * and ?store= are preserved on every switch, so the selector in the layout is
 * literally the same component rather than a copy per page.
 */
export const REPORT_TABS: Array<{ id: ReportTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "cogs", label: "Cost of Goods" },
  { id: "walkern", label: "COGS Walkern" },
  { id: "hitchin", label: "COGS transferred out" },
  { id: "fillings", label: "Samosas & Fillings" },
  { id: "labour", label: "Labour Cost" },
  { id: "occupancy", label: "Occupancy" },
  { id: "aggregator", label: "Aggregator" },
  { id: "expenses", label: "Weekly Expenses" },
  { id: "channels", label: "Sale by Channel" },
];

export function ReportTabStrip({
  active,
  transferLabel,
}: {
  active: ReportTab;
  /** "COGS to Stevenage" on Hitchin's report, and the reverse — goods move both ways. */
  transferLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  function go(tab: ReportTab) {
    const params = new URLSearchParams(search.toString());
    if (tab === "summary") params.delete("tab");
    else params.set("tab", tab);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div
      role="tablist"
      aria-label="Weekly report sections"
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1"
    >
      {REPORT_TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          onClick={() => go(t.id)}
          className={cn(
            "h-9 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors",
            t.id === active
              ? "bg-gold text-black shadow-sm"
              : "text-text-subtle hover:bg-surface-hover hover:text-text-primary",
          )}
        >
          {t.id === "hitchin" ? transferLabel : t.label}
        </button>
      ))}
    </div>
  );
}
