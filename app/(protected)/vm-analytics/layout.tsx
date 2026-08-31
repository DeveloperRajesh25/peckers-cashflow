import { Suspense } from "react";
import { DashboardSelector } from "@/components/vm-analytics/nav/DashboardSelector";
import { WeekSelector } from "@/components/vm-analytics/nav/WeekSelector";
import { StoreSelector } from "@/components/vm-analytics/nav/StoreSelector";
import { getWeeks, getLaborCostWeeks } from "@/lib/vm-analytics/queries";
import { reportWeekOptions } from "@/lib/weekly-report";

export default async function VmAnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let weeks = [] as Awaited<ReturnType<typeof getWeeks>>;
  try {
    weeks = await getWeeks();
  } catch {
    weeks = [];
  }

  let laborWeeks = [] as Awaited<ReturnType<typeof getLaborCostWeeks>>;
  try {
    laborWeeks = await getLaborCostWeeks();
  } catch {
    laborWeeks = [];
  }

  return (
    <div className="flex flex-col gap-6">
      {/* VM Analytics sub-nav: dashboard picker + store/week selectors */}
      <div className="flex flex-col gap-3 pb-4 border-b border-border md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div className="w-full md:w-64">
          <Suspense fallback={<div className="text-sm text-text-muted">Loading…</div>}>
            <DashboardSelector />
          </Suspense>
        </div>
        <Suspense fallback={null}>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {weeks[0] && (
              <span className="text-xs text-text-muted hidden md:block">
                Last synced: week ending {weeks[0].week_end}
              </span>
            )}
            <StoreSelector />
            <WeekSelector
              weeks={weeks}
              laborWeeks={laborWeeks}
              reportWeeks={reportWeekOptions(weeks)}
            />
          </div>
        </Suspense>
      </div>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
