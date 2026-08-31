"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { WeekOption, ExecMode } from "@/lib/vm-analytics/types";
import { weekRange } from "@/lib/vm-analytics/format";

// Global week picker shown in the top bar. Pushes ?week=ISO so every dashboard
// reads the same selected week from searchParams.
//
// On the Executive dashboard it also exposes a mode dropdown (Week / 4 Weeks /
// 12 Weeks) via ?mode=. In 4w/12w mode the single-week picker is hidden and a
// static label of the resolved period (latest N completed weeks) is shown; other
// dashboards ignore ?mode= and stay week-only.
//
// The Labor Cost dashboard reads from a different Supabase (cashflow) whose
// available weeks differ from the VM sales weeks, so the layout passes that
// dashboard's weeks separately and we switch on the current route.
//
// The Weekly Report gets a THIRD list: it ends at last week like the others,
// but adds the Sunday of the closing week and any week the sales sync is late
// on, which vm_v_available_weeks cannot hold. See reportWeekOptions.
export function WeekSelector({
  weeks,
  laborWeeks = [],
  reportWeeks = [],
}: {
  weeks: WeekOption[];
  laborWeeks?: WeekOption[];
  reportWeeks?: WeekOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selected = search.get("week");

  const isLaborCost = pathname.includes("/labor-cost");
  const isExecutive = pathname.includes("/executive");
  const isWeeklyReport = pathname.includes("/weekly-summary");
  const list = isLaborCost ? laborWeeks : isWeeklyReport ? reportWeeks : weeks;

  const rawMode = search.get("mode");
  const mode: ExecMode = rawMode === "4w" ? "4w" : rawMode === "12w" ? "12w" : "week";

  function onWeekChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(search.toString());
    params.set("week", e.target.value);
    router.push(`${pathname}?${params.toString()}`);
  }

  function onModeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(search.toString());
    const next = e.target.value as ExecMode;
    if (next === "week") {
      // Default mode — drop the param and keep the current single-week picker.
      params.delete("mode");
    } else {
      // Latest N completed weeks — no individual week needed.
      params.set("mode", next);
      params.delete("week");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  if (list.length === 0) {
    return <span className="text-sm text-secondary">No weeks synced yet</span>;
  }

  const selectClass =
    "min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-primary shadow-sm focus:border-gold focus:outline-none sm:flex-none";

  // Resolved period label for 4w/12w: oldest→newest of the latest N weeks.
  function periodLabel(n: number): string {
    const period = weeks.slice(0, n);
    if (period.length === 0) return "—";
    const label = weekRange(period[period.length - 1].week_start, period[0].week_end);
    return period.length < n ? `${label} · ${period.length} of ${n} wks` : label;
  }

  const weekPicker = (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm sm:flex-none">
      <span className="text-secondary">Week</span>
      <select value={selected ?? list[0].week_start_iso} onChange={onWeekChange} className={selectClass}>
        {list.map((w) => (
          <option key={w.week_start_iso} value={w.week_start_iso} className="bg-surface text-primary">
            {weekRange(w.week_start, w.week_end)}
          </option>
        ))}
      </select>
    </label>
  );

  // Non-executive dashboards keep the plain week picker (mode is executive-only).
  if (!isExecutive) return weekPicker;

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-secondary">View</span>
        <select value={mode} onChange={onModeChange} className={selectClass}>
          <option value="week" className="bg-surface text-primary">Week</option>
          <option value="4w" className="bg-surface text-primary">4 Weeks</option>
          <option value="12w" className="bg-surface text-primary">12 Weeks</option>
        </select>
      </label>
      {mode === "week" ? (
        weekPicker
      ) : (
        <span className="text-sm text-secondary">
          Latest {mode === "12w" ? 12 : 4} weeks · {periodLabel(mode === "12w" ? 12 : 4)}
        </span>
      )}
    </div>
  );
}
