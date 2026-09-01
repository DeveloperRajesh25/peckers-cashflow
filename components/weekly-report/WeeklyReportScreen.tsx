import { createServerSupabase } from "@/lib/supabase-server";
import { mergeSettings } from "@/lib/settings";
import { loadWeeklyReport } from "@/app/actions/weekly-report";
import { loadVmPlatformSales, loadVmSales } from "@/lib/weekly-report-sales";
import {
  getExecChannels,
  getGrossSalesByChannel,
  getWeeklySummaryInputs,
} from "@/lib/vm-analytics/queries";
import { generateWeeklySummary } from "@/lib/vm-analytics/weekly-summary";
import { WeeklySummaryTable } from "@/components/vm-analytics/WeeklySummaryTable";
import { PageTitle } from "@/components/vm-analytics/PageState";
import {
  FILLINGS_SECTIONS,
  SECTION_DEFS,
  labourTotal,
  num,
  rollUpInputs,
  round2,
  sectionTotals,
  snapshotDrift,
  transferTitle,
  type ReportSection,
  type ReportTab,
} from "@/lib/weekly-report";
import { ReportTabStrip } from "./ReportTabStrip";
import { ReportStatusBar } from "./ReportStatusBar";
import { HeaderInputsCard } from "./HeaderInputsCard";
import { LineItemGrid } from "./LineItemGrid";
import { SupplierInvoiceGrid } from "./SupplierInvoiceGrid";
import { AggregatorGrid } from "./AggregatorGrid";
import { LabourGrid } from "./LabourGrid";

const TAB_SECTIONS: Partial<Record<ReportTab, ReportSection[]>> = {
  cogs: ["cogs_supplier"],
  walkern: ["cogs_walkern"],
  hitchin: ["cogs_hitchin"],
  occupancy: ["occupancy"],
  fillings: FILLINGS_SECTIONS,
  expenses: ["expense"],
};

export async function WeeklyReportScreen({
  storeId,
  storeName,
  vmStoreName,
  weekIso,
  weekLabel,
  tab,
  canUnlock,
}: {
  storeId: string;
  storeName: string;
  vmStoreName: string | null;
  weekIso: string;
  weekLabel: string;
  tab: ReportTab;
  canUnlock: boolean;
}) {
  const supabase = createServerSupabase();

  const [bundle, sales, platformSales, settingsRes, storeRes] = await Promise.all([
    loadWeeklyReport({ store_id: storeId, week_start: weekIso }),
    loadVmSales(vmStoreName, weekIso),
    tab === "aggregator"
      ? loadVmPlatformSales(vmStoreName, weekIso)
      : Promise.resolve({ basis: "gross" as const, rows: [] }),
    supabase.from("app_settings").select("key, value"),
    supabase.from("stores").select("meppershall_default").eq("id", storeId).maybeSingle(),
  ]);

  const transferLabel = transferTitle(storeName);
  const settings = mergeSettings(settingsRes.data ?? []).weekly_report;
  const recipients = Array.from(
    new Set([...settings.recipients, ...settings.cc].map((r) => r.trim()).filter(Boolean)),
  );

  // Only asked when it could matter: a week with a report already has its
  // figures, and the legacy row lives in the other Supabase project.
  const legacy = bundle.report
    ? null
    : await getWeeklySummaryInputs(vmStoreName ?? "", weekIso).catch(() => null);

  const { report, lines, labour } = bundle;
  const readOnly = !report || report.status !== "draft";
  // The store that supplies Meppershall carries a standing figure; the other
  // one never sees the field. A report that already holds a value keeps it
  // editable even if the arrangement is later cleared off the store.
  const showMeppershall =
    storeRes.data?.meppershall_default != null || report?.meppershall != null;

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="Weekly Report" subtitle={`${storeName} · ${weekLabel}`} />

      {bundle.load_error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          Couldn&apos;t load part of this report ({bundle.load_error}). The totals below are
          incomplete — do not lock or send it until this is fixed.
        </div>
      )}

      <ReportStatusBar
        report={report}
        storeId={storeId}
        weekStart={weekIso}
        canUnlock={canUnlock}
        recipients={recipients}
        requireLockToSend={settings.require_lock_to_send}
        hasLegacyInputs={Boolean(legacy)}
      />

      {report && (
        <>
          <ReportTabStrip active={tab} transferLabel={transferLabel} />

          {tab === "summary" && (
            <SummaryTab
              bundle={bundle}
              sales={sales}
              storeName={storeName}
              transferLabel={transferLabel}
              readOnly={readOnly}
              showMeppershall={showMeppershall}
            />
          )}

          {tab === "labour" && (
            <LabourGrid reportId={report.id} lines={labour} readOnly={readOnly} />
          )}

          {tab === "aggregator" && (
            <AggregatorGrid
              reportId={report.id}
              lines={lines}
              platformSales={platformSales}
              readOnly={readOnly}
            />
          )}

          {tab === "channels" && (
            <ChannelsTab vmStoreName={vmStoreName} weekIso={weekIso} />
          )}

          {TAB_SECTIONS[tab] && (
            <div className="flex flex-col gap-5">
              {(tab === "walkern" || tab === "expenses") && (
                <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-secondary">
                  Record only — nothing on this tab feeds the P&amp;L. It is entered and totalled so
                  the week is fully documented, exactly as the workbook does.
                </p>
              )}
              {TAB_SECTIONS[tab]!.map((section) =>
                section === "cogs_supplier" ? (
                  <SupplierInvoiceGrid
                    key={section}
                    reportId={report.id}
                    def={SECTION_DEFS[section]}
                    lines={lines.filter((l) => l.section === section)}
                    readOnly={readOnly}
                  />
                ) : (
                  <LineItemGrid
                    key={section}
                    reportId={report.id}
                    def={
                      section === "cogs_hitchin"
                        ? { ...SECTION_DEFS[section], title: transferLabel }
                        : SECTION_DEFS[section]
                    }
                    lines={lines.filter((l) => l.section === section)}
                    readOnly={readOnly}
                  />
                ),
              )}
              {tab === "fillings" && (
                <FillingsTotal
                  total={round2(
                    FILLINGS_SECTIONS.reduce(
                      (t, s) => t + sectionTotals(lines)[s],
                      0,
                    ),
                  )}
                />
              )}
            </div>
          )}

          {tab === "summary" && (
            <HeaderInputsCard
              report={report}
              readOnly={readOnly}
              showMeppershall={showMeppershall}
            />
          )}
        </>
      )}
    </div>
  );
}

function FillingsTotal({ total }: { total: number }) {
  return (
    <div className="vm-card flex flex-wrap items-baseline justify-between gap-2 p-4">
      <div>
        <p className="text-sm font-semibold text-text-primary">
          Fillings and Samosas → Weekly Summary
        </p>
        <p className="text-xs text-text-muted">
          All four sub-tables. The workbook&apos;s own formula reads the rice-bowl block alone,
          which leaves the fillings and samosas it is named after out of gross margin — the same
          partial-SUM slip as Occupancy&apos;s.
        </p>
      </div>
      <span className="font-mono text-lg font-semibold text-text-primary">
        £{total.toFixed(2)}
      </span>
    </div>
  );
}

function SummaryTab({
  bundle,
  sales,
  storeName,
  transferLabel,
  readOnly,
  showMeppershall,
}: {
  bundle: Awaited<ReturnType<typeof loadWeeklyReport>>;
  sales: { gross_sales: number; net_sales: number };
  storeName: string;
  transferLabel: string;
  readOnly: boolean;
  showMeppershall: boolean;
}) {
  const report = bundle.report!;
  const liveInputs = rollUpInputs(report, bundle.lines, bundle.labour);
  const totals = sectionTotals(bundle.lines);

  // A locked report shows what was FROZEN, not what the same lines compute
  // today — otherwise a rate changed in August restates a report mailed in June.
  const frozen = report.status !== "draft" ? report.snapshot : null;
  const summary = frozen
    ? generateWeeklySummary(
        { gross_sales: frozen.gross_sales, net_sales: frozen.net_sales },
        frozen.inputs,
      )
    : generateWeeklySummary(sales, liveInputs);

  const drift = frozen
    ? snapshotDrift(frozen, { ...sales, inputs: liveInputs })
    : [];

  return (
    <div className="flex flex-col gap-5">
      {frozen && drift.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          This report is frozen, and {drift.join(", ")}{" "}
          {drift.length === 1 ? "now computes" : "now compute"} differently from the figure
          {drift.length === 1 ? "" : "s"} below. That is the snapshot doing its job, not a
          calculation bug — unlock and re-lock if you want the current numbers.
        </div>
      )}

      {sales.net_sales === 0 && !frozen && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          No sales have synced from VM for this week yet, so every margin reads against zero. The
          costs below are still saved — the percentages fill in once the week lands.
        </div>
      )}

      <WeeklySummaryTable data={summary} store={storeName} />

      <div className="vm-card p-5">
        <h3 className="text-sm font-semibold text-text-primary">Where each figure came from</h3>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="COGS" value={totals.cogs_supplier} note="Cost of Goods tab" />
          <Row
            label="Fillings and Samosas"
            value={round2(FILLINGS_SECTIONS.reduce((t, s) => t + totals[s], 0))}
            note="Samosas & Fillings tab, all four tables"
          />
          <Row label="Labour" value={labourTotal(bundle.labour)} note="Labour Cost tab" />
          <Row label="Occupancy" value={totals.occupancy} note="Occupancy tab, every line" />
          <Row label="Aggregator" value={totals.aggregator} note="Commission entered per platform" />
          <Row label="COGS Walkern" value={totals.cogs_walkern} note="Record only" />
          <Row
            label={transferLabel}
            value={totals.cogs_hitchin}
            note={`${transferLabel} tab — credited back against COGS`}
          />
          <Row label="Weekly expenses" value={totals.expense} note="Record only" />
          {showMeppershall && (
            <Row
              label="Meppershall"
              value={num(report.meppershall)}
              note="Typed in below — credited back against COGS"
            />
          )}
        </dl>
      </div>

      {readOnly && (
        <p className="text-xs text-text-muted">
          Locked reports are read-only. Unlocking is an admin action.
        </p>
      )}
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-1.5">
      <dt className="text-text-secondary">
        {label}
        <span className="ml-2 text-xs text-text-muted">{note}</span>
      </dt>
      <dd className="font-mono text-text-primary">£{value.toFixed(2)}</dd>
    </div>
  );
}

async function ChannelsTab({
  vmStoreName,
  weekIso,
}: {
  vmStoreName: string | null;
  weekIso: string;
}) {
  // The spreadsheet this sheet replaces reports channels GROSS, so gross is what
  // shows. Net stays as the fallback for a week vm_sales_store_channel has not
  // ingested — the column header says which is on screen.
  const [grossRows, netRows] = vmStoreName
    ? await Promise.all([
        getGrossSalesByChannel(weekIso)
          .then((r) => r.filter((c) => c.store === vmStoreName))
          .catch(() => []),
        getExecChannels(weekIso)
          .then((r) => r.filter((c) => c.store === vmStoreName))
          .catch(() => []),
      ])
    : [[], []];

  const isGross = grossRows.length > 0;
  const orders = new Map(netRows.map((r) => [r.channel, Number(r.orders || 0)]));
  const rows = isGross
    ? grossRows
        .map((r) => ({ channel: r.channel, sales: r.gross_sales, orders: orders.get(r.channel) ?? 0 }))
        .sort((a, b) => b.sales - a.sales)
    : netRows.map((r) => ({
        channel: r.channel,
        sales: Number(r.net_sales || 0),
        orders: Number(r.orders || 0),
      }));
  const total = rows.reduce((t, r) => t + r.sales, 0);

  return (
    <div className="vm-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">Sale by Channel</h3>
        <p className="text-xs text-text-muted">
          Read-only — this comes straight from VM and is nothing anyone types.
          {isGross ? " Figures are GROSS sales, matching the spreadsheet." : ""}
        </p>
      </div>
      <div className="table-scroll overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-hover text-xs uppercase tracking-wide text-text-muted">
              <th className="px-3 py-2 text-left font-semibold">Channel</th>
              <th className="px-3 py-2 text-right font-semibold">
                {isGross ? "Gross sales" : "Net sales"}
              </th>
              <th className="px-3 py-2 text-right font-semibold">Orders</th>
              <th className="px-3 py-2 text-right font-semibold">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channel} className="border-b border-border">
                <td className="px-3 py-2 text-text-primary">{r.channel}</td>
                <td className="px-3 py-2 text-right font-mono text-text-primary">
                  £{r.sales.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {r.orders}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-muted">
                  {total > 0 ? `${((r.sales / total) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-text-muted">
                  No channel data has synced for this week yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
