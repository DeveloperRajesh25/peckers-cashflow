import { createServerSupabase } from "@/lib/supabase-server";
import { getWeeks } from "@/lib/vm-analytics/queries";
import { weekRange } from "@/lib/vm-analytics/format";
import { shortStore, STORES, resolveStore as resolveStoreParam } from "@/lib/vm-analytics/constants";
import { generateWeeklySummary } from "@/lib/vm-analytics/weekly-summary";
import { PageTitle, ErrorState } from "@/components/vm-analytics/PageState";
import { Section } from "@/components/vm-analytics/Section";
import { WeeklySummaryTable } from "@/components/vm-analytics/WeeklySummaryTable";
import { WeeklyReportScreen } from "@/components/weekly-report/WeeklyReportScreen";
import { loadWeeklyReport } from "@/app/actions/weekly-report";
import { loadVmSales } from "@/lib/weekly-report-sales";
import {
  combineInputs,
  reportWeekOptions,
  resolveReportWeek,
  rollUpInputs,
  type ReportTab,
} from "@/lib/weekly-report";
import type { Store } from "@/lib/types";

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

function resolveTab(param?: string): ReportTab {
  return param && TABS.has(param as ReportTab) ? (param as ReportTab) : "summary";
}

export default async function WeeklySummaryPage({
  searchParams,
}: {
  searchParams: { week?: string; store?: string; tab?: string };
}) {
  // VM weeks alone would miss a week the sync is late on — see
  // reportWeekOptions. A failure there is not fatal: the local Mondays stand in.
  // ?week= is SHARED with the other dashboards, whose lists differ, so it is
  // resolved against this one rather than trusted.
  const vmWeeks = await getWeeks().catch(() => []);
  const weeks = reportWeekOptions(vmWeeks);
  const weekIso = resolveReportWeek(weeks, searchParams.week);
  if (!weekIso) return <ErrorState message="No weeks available." />;

  const weekOption = weeks.find((w) => w.week_start_iso === weekIso);
  const weekLabel = weekRange(weekIso, weekOption?.week_end);
  const selectedVmStore = resolveStoreParam(searchParams.store);

  const supabase = createServerSupabase();
  const { data: storeRows, error: storesError } = await supabase
    .from("stores")
    .select("id, code, name, vm_store_name")
    .order("name");
  if (storesError) return <ErrorState message={storesError.message} />;
  const stores = (storeRows ?? []) as Pick<Store, "id" | "code" | "name" | "vm_store_name">[];

  if (selectedVmStore) {
    const store = stores.find((s) => s.vm_store_name === selectedVmStore);
    if (!store) {
      return (
        <ErrorState
          message={`No store in the operations database is mapped to "${selectedVmStore}". Set its vm_store_name (migration 048).`}
        />
      );
    }
    return (
      <WeeklyReportScreen
        storeId={store.id}
        storeName={shortStore(selectedVmStore)}
        vmStoreName={store.vm_store_name}
        weekIso={weekIso}
        weekLabel={weekLabel}
        tab={resolveTab(searchParams.tab)}
        canUnlock
      />
    );
  }

  return <CombinedView stores={stores} weekIso={weekIso} weekLabel={weekLabel} />;
}

/**
 * Both stores at once — READ ONLY. It is a roll-up, and there is no such thing
 * as editing "the combined week": every line belongs to one store's report.
 */
async function CombinedView({
  stores,
  weekIso,
  weekLabel,
}: {
  stores: Pick<Store, "id" | "code" | "name" | "vm_store_name">[];
  weekIso: string;
  weekLabel: string;
}) {
  const perStore = await Promise.all(
    STORES.map(async (vmName) => {
      const store = stores.find((s) => s.vm_store_name === vmName);
      if (!store) return { vmName, store: null, sales: null, inputs: null };
      const [bundle, sales] = await Promise.all([
        loadWeeklyReport({ store_id: store.id, week_start: weekIso }),
        loadVmSales(vmName, weekIso),
      ]);
      const frozen = bundle.report?.status !== "draft" ? bundle.report?.snapshot ?? null : null;
      return {
        vmName,
        store,
        sales: frozen ? { gross_sales: frozen.gross_sales, net_sales: frozen.net_sales } : sales,
        inputs: bundle.report
          ? frozen?.inputs ?? rollUpInputs(bundle.report, bundle.lines, bundle.labour)
          : null,
      };
    }),
  );

  const combinedSales = perStore.reduce(
    (t, s) => ({
      gross_sales: t.gross_sales + (s.sales?.gross_sales ?? 0),
      net_sales: t.net_sales + (s.sales?.net_sales ?? 0),
    }),
    { gross_sales: 0, net_sales: 0 },
  );
  const combined = combineInputs(perStore[0]?.inputs ?? null, perStore[1]?.inputs ?? null);
  const missing = perStore.filter((s) => !s.inputs).map((s) => shortStore(s.vmName));

  return (
    <div className="space-y-7">
      <PageTitle title="Weekly Report" subtitle={`Combined · ${weekLabel}`} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {perStore.map((s) => (
          <div key={s.vmName} className="vm-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {shortStore(s.vmName)}
            </div>
            <div className="mt-2 flex items-end justify-between">
              <div>
                <div className="text-sm text-text-secondary">Net Sales</div>
                <div className="text-xl font-semibold text-text-primary">
                  £{(s.sales?.net_sales ?? 0).toFixed(2)}
                </div>
              </div>
              {s.inputs ? (
                <span className="rounded bg-green-100 px-2 py-1 text-xs text-green-700">
                  Report started ✓
                </span>
              ) : (
                <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700">
                  No report yet
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {missing.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {missing.join(" and ")} {missing.length === 1 ? "has" : "have"} no report for this week, so
          the combined figures below are incomplete. Pick a store above to enter one.
        </div>
      )}

      <Section
        title="Combined Results"
        description="Sums for money, averages for the budget percentages. Read-only — edit each store's week on its own report."
      >
        <WeeklySummaryTable data={generateWeeklySummary(combinedSales, combined)} />
      </Section>
    </div>
  );
}
