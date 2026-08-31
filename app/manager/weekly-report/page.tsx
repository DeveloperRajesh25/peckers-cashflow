import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { getWeeks } from "@/lib/vm-analytics/queries";
import { weekRange } from "@/lib/vm-analytics/format";
import { ErrorState } from "@/components/vm-analytics/PageState";
import { WeeklyReportScreen } from "@/components/weekly-report/WeeklyReportScreen";
import { ReportWeekSelector } from "@/components/weekly-report/ReportWeekSelector";
import { reportWeekOptions, resolveReportWeek, type ReportTab } from "@/lib/weekly-report";

export const dynamic = "force-dynamic";

const TABS = new Set<ReportTab>([
  "summary",
  "cogs",
  "walkern",
  "hitchin",
  "fillings",
  "labour",
  "occupancy",
  "aggregator",
  "expenses",
  "channels",
]);

/**
 * The manager's twin of the admin weekly report.
 *
 * VM Analytics stays admin-only — opening `/vm-analytics` in middleware would
 * expose Product Performance, Daypart and the rest of it. This one screen is
 * reached at its own route instead, scoped by resolveActiveStoreId: a manager
 * can switch stores, so their `store_id` is only their HOME store.
 *
 * The manager owns the week end to end — they enter it, lock it and send it.
 * `canUnlock` is false: reopening a frozen report is the single admin-only act.
 */
export default async function ManagerWeeklyReportPage({
  searchParams,
}: {
  searchParams: { week?: string; tab?: string };
}) {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed);
  if (!storeId) return <ErrorState message="No store is assigned to your account." />;

  const supabase = createServerSupabase();
  const { data: store, error } = await supabase
    .from("stores")
    .select("id, name, vm_store_name")
    .eq("id", storeId)
    .maybeSingle();
  if (error) return <ErrorState message={error.message} />;
  if (!store) return <ErrorState message="Your store could not be loaded." />;

  const vmWeeks = await getWeeks().catch(() => []);
  const weeks = reportWeekOptions(vmWeeks);
  const weekIso = resolveReportWeek(weeks, searchParams.week);
  if (!weekIso) return <ErrorState message="No weeks available." />;
  const weekOption = weeks.find((w) => w.week_start_iso === weekIso);
  const tab = TABS.has(searchParams.tab as ReportTab)
    ? (searchParams.tab as ReportTab)
    : "summary";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <ReportWeekSelector weeks={weeks} selected={weekIso} />
      </div>
      <WeeklyReportScreen
        storeId={store.id}
        storeName={store.name}
        vmStoreName={store.vm_store_name}
        weekIso={weekIso}
        weekLabel={weekRange(weekIso, weekOption?.week_end)}
        tab={tab}
        canUnlock={false}
      />
    </div>
  );
}
