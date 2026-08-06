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
  weekLabel,
  parseISODate,
} from "@/lib/utils";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { DeliveryCell } from "./DeliveryCell";
import type { CashPayoutWithLines, Store } from "@/lib/types";

export function PayoutHistoryView({
  payouts,
  stores,
  isAdmin,
}: {
  payouts: CashPayoutWithLines[];
  stores: Store[];
  isAdmin: boolean;
}) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [store, setStore] = React.useState("");
  const [name, setName] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const storeById = new Map(stores.map((s) => [s.id, s.name]));

  const filtered = React.useMemo(() => {
    const q = name.trim().toLowerCase();
    return payouts.filter((p) => {
      if (from && p.week_start_date < from) return false;
      if (to && p.week_start_date > to) return false;
      if (store && p.store_id !== store) return false;
      if (q && !p.lines.some((l) => l.employee_name.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [payouts, from, to, store, name]);

  function exportCSV() {
    const headers = [
      "Week start", "Store", "Payment date", "Confirmed by", "Status",
      "Employee", "Role", "Cash hours", "Cash rate", "Cash wage",
      "Short deliveries (SD)", "Long deliveries (LD)",
      "Short misc (SM)", "Long misc (LM)",
      "Delivery wages", "Total paid",
    ];
    const rows: (string | number)[][] = [];
    for (const p of filtered) {
      const storeName = storeById.get(p.store_id) ?? "";
      for (const l of p.lines) {
        rows.push([
          formatDDMMYYYY(p.week_start_date),
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
    downloadCSV(`peckers-payout-summary-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(headers, rows));
  }

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
            <Button variant="secondary" onClick={exportCSV} iconLeft={<DownloadIcon size={16} />} className="flex-1" disabled={filtered.length === 0}>
              CSV
            </Button>
            <Button variant="secondary" onClick={() => window.print()} className="flex-1" disabled={filtered.length === 0}>
              PDF
            </Button>
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListIcon />}
            title="No payout records yet"
            description="Open the Tuesday Payout page and click 'Generate payout sheet' — drafts and confirmed payouts both appear here, searchable by date, store, or employee."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((p) => {
            const open = expanded === p.id;
            return (
              <Card key={p.id} className="p-0 overflow-hidden">
                <button
                  onClick={() => setExpanded(open ? null : p.id)}
                  className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-surface-hover transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-text-primary">{weekLabel(parseISODate(p.week_start_date))}</span>
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
                      {` · ${p.lines.length} employee${p.lines.length === 1 ? "" : "s"}`}
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
                    <div className="overflow-x-auto border-t border-border">
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
                          {p.lines.map((l, i) => (
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
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
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
