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
  const [linesById, setLinesById] = React.useState<Map<string, CashPayoutLine[]>>(
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
      .then((lines) => {
        setLinesById((prev) => new Map(prev).set(payoutId, lines));
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
            title="No payout records yet"
            description="Open the Tuesday Payout page and click 'Generate payout sheet' — drafts and confirmed payouts both appear here, searchable by date, store, or employee."
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
                  className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-surface-hover transition-colors"
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
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-5">
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
                        <LinesTable lines={lines} />
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
        <div className="hidden print:block">
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
              <LinesTable lines={p.lines} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinesTable({ lines }: { lines: CashPayoutLine[] }) {
  return (
    <table className="w-full text-sm">
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
            <td className="px-4 py-2.5 font-medium">
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
            <td className="px-4 py-2.5 text-text-muted">{l.role ?? "—"}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              <HoursMinsDisplay hours={l.cash_hours} />
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">{formatGBP(l.cash_rate)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">{formatGBP(l.cash_wage)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              <DeliveryCell line={l} />
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">{l.delivery_wages > 0 ? formatGBP(l.delivery_wages) : "—"}</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{formatGBP(l.total_payment)}</td>
          </tr>
        ))}
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
