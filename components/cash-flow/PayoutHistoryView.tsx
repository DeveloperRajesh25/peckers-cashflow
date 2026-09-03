"use client";

import * as React from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChevronDownIcon, DownloadIcon, ListIcon } from "@/components/ui/icons";
import {
  deliveryBreakdown,
  downloadCSV,
  formatDDMMYYYY,
  formatGBP,
  formatGBPPlain,
  toCSV,
} from "@/lib/utils";
import { payWeekOf } from "@/lib/cash-flow";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { DeliveryCell } from "./DeliveryCell";
import {
  exportPayoutHistory,
  listPayoutHistory,
  loadPayoutLines,
} from "@/app/actions/payout-history";
import type {
  PayoutHistoryExportRow,
  PayoutHistoryFilters,
  PayoutHistoryHeader,
  PayoutLinesResult,
} from "@/lib/payout-history-paging";
import type { CashPayoutLine, Store } from "@/lib/types";

/** The header shows the week actually WORKED (and paid for), not the payment week. */
function payoutWeekLabel(weekStartISO: string): string {
  const { start, end } = payWeekOf(weekStartISO);
  return `${formatDDMMYYYY(start)} – ${formatDDMMYYYY(end)}`;
}

const CSV_HEADERS = [
  "Week start", "Store", "Payment date", "Confirmed by", "Status",
  "Employee", "Role", "Cash hours", "Cash rate", "Cash wage",
  "Short deliveries (SD)", "Long deliveries (LD)",
  "Short misc (SM)", "Long misc (LM)",
  "Delivery wages", "Total paid",
];

export function PayoutHistoryView({
  initialPayouts,
  stores,
  isAdmin,
  loadError = null,
}: {
  initialPayouts: PayoutHistoryHeader[];
  stores: Store[];
  isAdmin: boolean;
  /** A failed initial query — surfaced, never rendered as "no payouts". */
  loadError?: string | null;
}) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [store, setStore] = React.useState("");
  const [name, setName] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const [payouts, setPayouts] = React.useState<PayoutHistoryHeader[]>(initialPayouts);
  const [listError, setListError] = React.useState<string | null>(loadError);
  const [listLoading, setListLoading] = React.useState(false);

  // Lines arrive when a card is opened. `undefined` means "not fetched yet",
  // which is NOT the same as a payout that genuinely has no lines.
  const [linesById, setLinesById] = React.useState<Map<string, PayoutLinesResult>>(
    () => new Map(),
  );
  const [linesLoading, setLinesLoading] = React.useState<string | null>(null);
  const [linesError, setLinesError] = React.useState<Record<string, string>>({});

  const [exporting, setExporting] = React.useState(false);
  const [printRows, setPrintRows] = React.useState<PayoutHistoryExportRow[] | null>(null);

  const storeById = React.useMemo(
    () => new Map(stores.map((s) => [s.id, s.name])),
    [stores],
  );

  const filters: PayoutHistoryFilters = React.useMemo(
    () => ({ from, to, storeId: store, name }),
    [from, to, store, name],
  );

  // The name box types a character at a time; everything else is a discrete
  // pick. Debouncing only the text input keeps date/store changes instant.
  const [debouncedName, setDebouncedName] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedName(name), 300);
    return () => clearTimeout(t);
  }, [name]);

  // Skips the fetch on first render — the server already sent the unfiltered
  // first page, and refetching it would be a wasted round trip on every load.
  const primed = React.useRef(false);
  const seq = React.useRef(0);

  React.useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      return;
    }
    const mine = ++seq.current;
    setListLoading(true);
    setListError(null);
    listPayoutHistory({ from, to, storeId: store, name: debouncedName })
      .then((rows) => {
        // A slow reply for an old filter must not land on top of a fast one.
        if (mine !== seq.current) return;
        setPayouts(rows);
        setExpanded(null);
        setListLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setListError(err instanceof Error ? err.message : "Failed to load payouts");
        setListLoading(false);
      });
  }, [from, to, store, debouncedName]);

  function toggleExpand(payoutId: string) {
    if (expanded === payoutId) {
      setExpanded(null);
      return;
    }
    setExpanded(payoutId);
    if (linesById.has(payoutId) || linesLoading === payoutId) return;

    setLinesLoading(payoutId);
    setLinesError((prev) => {
      const next = { ...prev };
      delete next[payoutId];
      return next;
    });
    loadPayoutLines(payoutId)
      .then((result) => {
        setLinesById((prev) => new Map(prev).set(payoutId, result));
        setLinesLoading(null);
      })
      .catch((err: unknown) => {
        setLinesError((prev) => ({
          ...prev,
          [payoutId]: err instanceof Error ? err.message : "Failed to load lines",
        }));
        setLinesLoading(null);
      });
  }

  function exportRowsToCSV(rows: PayoutHistoryExportRow[]) {
    const out: (string | number)[][] = [];
    for (const p of rows) {
      const storeName = storeById.get(p.store_id) ?? p.store_name ?? "";
      for (const l of p.lines) {
        out.push([
          formatDDMMYYYY(payWeekOf(p.week_start_date).start),
          storeName,
          p.payment_date ? formatDDMMYYYY(p.payment_date) : "",
          p.confirmed_by_name ?? "",
          p.status,
          l.employee_name,
          l.role ?? "",
          l.cash_hours,
          formatGBPPlain(l.cash_rate),
          formatGBPPlain(l.cash_wage),
          l.short_deliveries_count,
          l.long_deliveries_count,
          l.short_misc_count ?? 0,
          l.long_misc_count ?? 0,
          formatGBPPlain(l.delivery_wages),
          formatGBPPlain(l.total_payment),
        ]);
      }
    }
    downloadCSV(
      `peckers-payout-summary-${new Date().toISOString().slice(0, 10)}.csv`,
      toCSV(CSV_HEADERS, out),
    );
  }

  // Both exports cover the whole FILTERED set, not the cards on screen — the
  // lines are fetched for the export rather than read from what happens to be
  // expanded. Shrinking a payroll export to one open card would be a
  // regression, not an optimisation.
  async function runExport(mode: "csv" | "pdf") {
    setExporting(true);
    try {
      const rows = await exportPayoutHistory(filters);
      if (mode === "csv") {
        exportRowsToCSV(rows);
        return;
      }
      setPrintRows(rows);
      // Let the print-only block commit before the browser snapshots the page.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      window.print();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  React.useEffect(() => {
    if (!printRows) return;
    const clear = () => setPrintRows(null);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, [printRows]);

  const exportDisabled = exporting || listLoading || payouts.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="print:hidden">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <DatePicker label="From" value={from} onChange={setFrom} />
          <DatePicker label="To" value={to} onChange={setTo} />
          {isAdmin && (
            <Select label="Store" value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
          <Input label="Employee" placeholder="Name…" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex items-end gap-2">
            <Button
              variant="secondary"
              onClick={() => runExport("csv")}
              iconLeft={<DownloadIcon size={16} />}
              className="flex-1"
              disabled={exportDisabled}
            >
              {exporting ? "…" : "CSV"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => runExport("pdf")}
              className="flex-1"
              disabled={exportDisabled}
            >
              {exporting ? "…" : "PDF"}
            </Button>
          </div>
        </div>
      </Card>

      {listError ? (
        <Card className="print:hidden">
          <p className="text-sm text-danger">
            Couldn&apos;t load the payout history — {listError}. An empty list here means
            the query failed, not that nobody was paid.
          </p>
        </Card>
      ) : listLoading ? (
        <Card className="print:hidden">
          <p className="text-sm text-text-muted">Loading payouts…</p>
        </Card>
      ) : payouts.length === 0 ? (
        <Card className="print:hidden">
          <EmptyState
            icon={<ListIcon />}
            title="No confirmed payouts yet"
            description="A payout appears here once it is confirmed on the Tuesday Payout page. Draft sheets stay there until then."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3 print:hidden">
          {payouts.map((p) => {
            const open = expanded === p.id;
            const lines = linesById.get(p.id);
            return (
              <Card key={p.id} className="p-0 overflow-hidden">
                <button
                  onClick={() => toggleExpand(p.id)}
                  className="w-full px-4 sm:px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-surface-hover transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-text-primary">{payoutWeekLabel(p.week_start_date)}</span>
                      <Badge variant="neutral">{storeById.get(p.store_id) ?? p.store_name ?? "Store"}</Badge>
                      {p.status === "confirmed" ? (
                        <Badge variant="success">Confirmed</Badge>
                      ) : (
                        <Badge variant="gold">Draft</Badge>
                      )}
                      {p.post_office_draw > 0.001 && (
                        <Badge variant="danger">Drew {formatGBP(p.post_office_draw)}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      Paid {p.payment_date ? formatDDMMYYYY(p.payment_date) : "—"}
                      {p.confirmed_by_name && ` · by ${p.confirmed_by_name}`}
                      {` · ${p.line_count} employee${p.line_count === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-text-muted">Total paid</p>
                      <p className="font-semibold text-gold tabular-nums">{formatGBP(p.grand_total_wages)}</p>
                    </div>
                    <ChevronDownIcon size={18} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
                  </div>
                </button>

                {open && (
                  <div className="border-t border-border">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 sm:p-5">
                      <Mini label="Cash collected" value={formatGBP(p.cash_collected)} />
                      <Mini label="Cash available" value={formatGBP(p.actual_cash_available)} />
                      <Mini label="Cash wages" value={formatGBP(p.total_cash_wages)} />
                      <Mini label="Delivery wages" value={formatGBP(p.total_delivery_wages)} />
                      <Mini label="Opening balance" value={formatGBP(p.opening_balance)} />
                      <Mini label="Logged differences" value={formatGBP(p.logged_differences)} />
                      <Mini label="Post Office draw" value={formatGBP(p.post_office_draw)} />
                      <Mini label="Surplus carried fwd" value={formatGBP(p.surplus_carry_forward)} />
                      {/* Only on the weeks that carry one — otherwise every
                          historical sheet grows a "£0.00" tile that explains
                          nothing. The draw and surplus above already include it. */}
                      {Math.abs(Number(p.adjustment_amount) || 0) > 0.001 && (
                        <Mini
                          label={`Adjustment${p.adjustment_reason ? ` — ${p.adjustment_reason}` : ""}`}
                          value={`${Number(p.adjustment_amount) > 0 ? "+" : "−"} ${formatGBP(
                            Math.abs(Number(p.adjustment_amount)),
                          )}`}
                        />
                      )}
                    </div>
                    {linesError[p.id] ? (
                      <p className="text-sm text-danger px-5 pb-5 border-t border-border pt-4">
                        Couldn&apos;t load this payout&apos;s lines — {linesError[p.id]}. This
                        is a failed query, not an unpaid week.
                      </p>
                    ) : lines === undefined ? (
                      <p className="text-sm text-text-muted px-5 pb-5 border-t border-border pt-4">
                        Loading payment lines…
                      </p>
                    ) : (
                      <div className="overflow-x-auto border-t border-border">
                        <LinesTable
                          lines={lines.lines}
                          vmDeliveryOrders={lines.vm_delivery_orders}
                        />
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Print-only rendering of the whole filtered set, so PDF keeps covering
          everything the filter matches rather than the one expanded card. */}
      {printRows && (
        <div className="hidden print:block print-sheet">
          {/* Landscape plus the `@media print` rules in globals.css (chrome
              hidden, compact cells) are what keep all 8 columns on the sheet —
              the Total column was being clipped off the page edge. */}
          <style media="print">{`@page { size: landscape; margin: 10mm; }`}</style>
          {printRows.map((p) => (
            <div key={p.id} className="mb-6 break-inside-avoid">
              <h3 className="font-semibold">
                {payoutWeekLabel(p.week_start_date)} —{" "}
                {storeById.get(p.store_id) ?? p.store_name ?? "Store"} ({p.status})
              </h3>
              <p className="text-xs">
                Paid {p.payment_date ? formatDDMMYYYY(p.payment_date) : "—"}
                {p.confirmed_by_name && ` · by ${p.confirmed_by_name}`} · Total{" "}
                {formatGBP(p.grand_total_wages)}
              </p>
              <LinesTable lines={p.lines} vmDeliveryOrders={p.vm_delivery_orders} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinesTable({
  lines,
  vmDeliveryOrders,
}: {
  lines: CashPayoutLine[];
  /** VM's delivery orders for the pay week; null when VM has no data. */
  vmDeliveryOrders?: number | null;
}) {
  const totals = lines.reduce(
    (acc, l) => {
      const d = deliveryBreakdown(l);
      return {
        cash_hours: acc.cash_hours + l.cash_hours,
        cash_wage: acc.cash_wage + l.cash_wage,
        delivery_wages: acc.delivery_wages + l.delivery_wages,
        total_payment: acc.total_payment + l.total_payment,
        short_deliveries_count: acc.short_deliveries_count + d.sd,
        long_deliveries_count: acc.long_deliveries_count + d.ld,
        short_misc_count: acc.short_misc_count + d.sm,
        long_misc_count: acc.long_misc_count + d.lm,
      };
    },
    {
      cash_hours: 0,
      cash_wage: 0,
      delivery_wages: 0,
      total_payment: 0,
      short_deliveries_count: 0,
      long_deliveries_count: 0,
      short_misc_count: 0,
      long_misc_count: 0,
    },
  );

  // Same split the Tuesday Payout sheet's footer prints: what a manager signed
  // off (the normal round) vs the extra drops logged beyond it, both readable
  // against Vita Mojo's own delivery orders.
  const approvedDeliveries =
    totals.short_deliveries_count + totals.long_deliveries_count;
  const miscDeliveries = totals.short_misc_count + totals.long_misc_count;

  return (
    <table className="table-stack w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
          <th className="px-4 py-2.5 font-medium">Employee</th>
          <th className="px-4 py-2.5 font-medium">Role</th>
          <th className="px-4 py-2.5 font-medium text-right">Cash hrs</th>
          <th className="px-4 py-2.5 font-medium text-right">Rate</th>
          <th className="px-4 py-2.5 font-medium text-right">Cash wage</th>
          <th
            className="px-4 py-2.5 font-medium text-right"
            title="SD short · LD long · SM short misc · LM long misc"
          >
            Deliveries
          </th>
          <th className="px-4 py-2.5 font-medium text-right">Delivery £</th>
          <th className="px-4 py-2.5 font-medium text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={l.id} className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}>
            <td className="px-4 py-2.5 font-medium" data-label="">
              {l.employee_name}
              {l.cover_driver_id && (
                <span
                  className="ml-2 align-middle text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-gold/40 bg-gold/10 text-gold font-medium"
                  title="Cover driver — paid cash, no NI"
                >
                  Cover
                </span>
              )}
              {l.manager_id && (
                <span
                  className="ml-2 align-middle text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-gold/40 bg-gold/10 text-gold font-medium"
                  title="Manager — deliveries only, paid per drop"
                >
                  Manager
                </span>
              )}
            </td>
            <td className="px-4 py-2.5 text-text-muted" data-label="Role">{l.role ?? "—"}</td>
            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Cash hrs">
              <HoursMinsDisplay hours={l.cash_hours} />
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Rate">{formatGBP(l.cash_rate)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Cash wage">{formatGBP(l.cash_wage)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Deliveries">
              <DeliveryCell line={l} />
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Delivery £">{l.delivery_wages > 0 ? formatGBP(l.delivery_wages) : "—"}</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-semibold" data-label="Total">{formatGBP(l.total_payment)}</td>
          </tr>
        ))}
        {/* The totals live in the body's last row, not a <tfoot> — a footer is
            REPEATED on every printed page, which would stamp the week's grand
            total halfway down a table that spilled onto a second page. */}
        <tr className="border-t-2 border-border bg-bg/60 font-semibold">
          <td className="px-4 py-3" colSpan={2} data-label="">Total</td>
          <td className="px-4 py-3 text-right tabular-nums" data-label="Cash hrs">
            <HoursMinsDisplay hours={totals.cash_hours} />
          </td>
          <td className="px-4 py-3 text-right tabular-nums text-text-muted" data-label="Rate">—</td>
          <td className="px-4 py-3 text-right tabular-nums" data-label="Cash wage">{formatGBP(totals.cash_wage)}</td>
          <td className="px-4 py-3 text-right tabular-nums" data-label="Deliveries">
            <span className="flex flex-col items-end gap-0.5 whitespace-nowrap">
              <span className="text-[10px] font-normal text-text-muted">
                {totals.short_deliveries_count} SD · {totals.long_deliveries_count} LD ·{" "}
                <span className={totals.short_misc_count > 0 ? "text-gold font-medium" : ""}>
                  {totals.short_misc_count} SM
                </span>{" "}
                ·{" "}
                <span className={totals.long_misc_count > 0 ? "text-gold font-medium" : ""}>
                  {totals.long_misc_count} LM
                </span>
              </span>
              <span className="text-[11px] font-normal text-text-muted">
                VM deliveries{" "}
                <span
                  className="ml-1 font-semibold text-text-primary tabular-nums"
                  title="Total delivery orders Vita Mojo recorded for this pay week"
                >
                  {vmDeliveryOrders == null ? "—" : vmDeliveryOrders}
                </span>
              </span>
              <span className="text-[11px] font-normal text-text-muted">
                Approved{" "}
                <span className="ml-1 font-semibold text-text-primary tabular-nums">
                  {approvedDeliveries}
                </span>
              </span>
              <span className="text-[11px] font-normal text-text-muted">
                Miscellaneous{" "}
                <span
                  className={
                    "ml-1 font-semibold tabular-nums " +
                    (miscDeliveries > 0 ? "text-gold" : "text-text-primary")
                  }
                >
                  {miscDeliveries}
                </span>
              </span>
            </span>
          </td>
          <td className="px-4 py-3 text-right tabular-nums" data-label="Delivery £">{formatGBP(totals.delivery_wages)}</td>
          <td className="px-4 py-3 text-right tabular-nums text-gold" data-label="Total">
            {formatGBP(totals.total_payment)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg border border-border px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}
