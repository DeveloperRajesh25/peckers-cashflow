"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { WeekOption } from "@/lib/vm-analytics/types";
import { weekRange } from "@/lib/vm-analytics/format";

/**
 * Week picker for the manager's report, which has no VM Analytics layout above
 * it to supply one. Pushes ?week= and preserves ?tab=, so switching week keeps
 * the manager on the sub-page they were reading.
 */
export function ReportWeekSelector({
  weeks,
  selected,
}: {
  weeks: WeekOption[];
  selected: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-text-secondary">Week</span>
      <select
        value={selected}
        onChange={(e) => {
          const params = new URLSearchParams(search.toString());
          params.set("week", e.target.value);
          router.push(`${pathname}?${params.toString()}`);
        }}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-primary shadow-sm focus:border-gold focus:outline-none"
      >
        {weeks.map((w) => (
          <option key={w.week_start_iso} value={w.week_start_iso}>
            {weekRange(w.week_start, w.week_end)}
          </option>
        ))}
      </select>
    </label>
  );
}
