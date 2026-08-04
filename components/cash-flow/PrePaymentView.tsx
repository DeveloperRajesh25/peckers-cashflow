"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon } from "@/components/ui/icons";
import {
  generatePayout,
  markLinePaid,
  confirmPayout,
  unlockPayout,
} from "@/app/actions/payouts";
import {
  formatGBP,
  formatDDMMYYYY,
  weekLabel,
  parseISODate,
  formatTimeOnly,
  deliveryBreakdown,
} from "@/lib/utils";
import { payWeekOf } from "@/lib/cash-flow";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { DeliveryCell } from "./DeliveryCell";
import type { CashPayoutWithLines, PrePaymentSummary } from "@/lib/types";

type StoreOpt = { id: string; name: string };
type DisplayLine = {
  employee_name: string;
  /** Set on a cover driver line — they're paid from the same sheet, badged. */
  cover_driver_id?: string | null;
  /** Set on a manager line — deliveries they covered, badged the same way. */
  manager_id?: string | null;
  role: string | null;
  cash_hours: number;
  cash_rate: number;
  short_deliveries_count: number;
  long_deliveries_count: number;
  short_misc_count?: number | null;
  long_misc_count?: number | null;
  delivery_wages: number;
  total_payment: number;
  id?: string;
  is_paid?: boolean;
};

export function PrePaymentView({
  summary,
  payout,
  store,
  stores,
  weekStart,
  prevWeek,
  nextWeek,
  isAdmin,
  basePath,
}: {
  summary: PrePaymentSummary;
  payout: CashPayoutWithLines | null;
  store: StoreOpt;
  stores: StoreOpt[];
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  isAdmin: boolean;
  basePath: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const locked = payout?.locked ?? false;
  const confirmed = payout?.status === "confirmed";

  // Financial figures: use the locked snapshot once confirmed, else the live forecast.
  const fin = confirmed && payout
    ? {
        opening_balance: payout.opening_balance,
        vita_mojo_total: payout.cash_collected + payout.logged_differences,
        cash_collected: payout.cash_collected,
        logged_differences: payout.logged_differences,
        // Locked snapshots don't store the float separately; reconstruct it from
        // the recorded total (actual = opening + collected + supermarket float).
        supermarket_cash: Math.max(
          0,
          payout.actual_cash_available - payout.cash_collected - payout.opening_balance,
        ),
        actual_cash_available: payout.actual_cash_available,
        total_cash_wages: payout.total_cash_wages,
        total_delivery_wages: payout.total_delivery_wages,
        grand_total_wages: payout.grand_total_wages,
        post_office_draw: payout.post_office_draw,
        surplus: payout.surplus_carry_forward,
      }
    : summary;

  const lines: DisplayLine[] = payout ? payout.lines : summary.lines;

  // Ticking "paid" writes to the server and then re-renders the whole page, so
  // the box used to sit on its old value for a second or more. Hold the new
  // value locally the moment it's clicked (and spin in place of the box while
  // it saves); the override is dropped once the server agrees, or rolled back
  // if the write failed.
  const [optimisticPaid, setOptimisticPaid] = React.useState<Record<string, boolean>>({});
  const [savingLines, setSavingLines] = React.useState<string[]>([]);

  React.useEffect(() => {
    setOptimisticPaid((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const l of lines) {
        if (l.id && next[l.id] !== undefined && (l.is_paid ?? false) === next[l.id]) {
          delete next[l.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [lines]);

  const isLinePaid = React.useCallback(
    (l: DisplayLine) => (l.id ? optimisticPaid[l.id] : undefined) ?? l.is_paid ?? false,
    [optimisticPaid],
  );
  const paidCount = payout ? payout.lines.filter(isLinePaid).length : 0;

  // Delivery totals for the footer, shaped like a payout line so the footer
  // cell foots to a checkable number per drop type (SD / LD / SM / LM).
  const totals = React.useMemo(
    () =>
      lines.reduce(
        (acc, l) => {
          const d = deliveryBreakdown(l);
          return {
            short_deliveries_count: acc.short_deliveries_count + d.sd,
            long_deliveries_count: acc.long_deliveries_count + d.ld,
            short_misc_count: acc.short_misc_count + d.sm,
            long_misc_count: acc.long_misc_count + d.lm,
          };
        },
        {
          short_deliveries_count: 0,
          long_deliveries_count: 0,
          short_misc_count: 0,
          long_misc_count: 0,
        },
      ),
    [lines],
  );

  function go(storeId: string, week: string) {
    return `${basePath}/payout?week=${week}&store=${storeId}`;
  }

  async function doGenerate() {
    setBusy("generate");
    try {
      await generatePayout({ store_id: store.id, week_start: weekStart });
      toast.success(payout ? "Payout sheet refreshed" : "Payout sheet generated");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function togglePaid(lineId: string, paid: boolean) {
    setOptimisticPaid((p) => ({ ...p, [lineId]: paid }));
    setSavingLines((s) => [...s, lineId]);
    try {
      await markLinePaid({ line_id: lineId, paid });
      router.refresh();
    } catch (err) {
      // Roll the tick back — the server never took it.
      setOptimisticPaid((p) => {
        const next = { ...p };
        delete next[lineId];
        return next;
      });
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSavingLines((s) => s.filter((id) => id !== lineId));
    }
  }

  async function doConfirm() {
    if (!payout) return;
    setBusy("confirm");
    try {
      await confirmPayout({ payout_id: payout.id });
      toast.success("Wages confirmed and locked");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function doUnlock() {
    if (!payout) return;
    if (!confirm("Unlock this confirmed payout for amendment?")) return;
    setBusy("unlock");
    try {
      await unlockPayout({ payout_id: payout.id });
      toast.success("Payout unlocked");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const tuesday = formatDDMMYYYY(
    new Date(parseISODate(weekStart).getTime() + 1 * 86400000),
  );
  // Wages paid this Tuesday are for the PREVIOUS Mon–Sun week.
  const payWeekStartDate = new Date(parseISODate(weekStart).getTime() - 7 * 86400000);
  const payWeekLabel = `${formatDDMMYYYY(payWeekStartDate)} – ${formatDDMMYYYY(
    new Date(payWeekStartDate.getTime() + 6 * 86400000),
  )}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Week nav + store selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Link href={go(store.id, prevWeek)}>
            <Button variant="secondary" size="icon" aria-label="Previous week">
              <ChevronLeftIcon size={16} />
            </Button>
          </Link>
          <span className="flex flex-col items-center min-w-[180px]">
            <span className="text-sm font-medium text-text-primary text-center">
              {weekLabel(parseISODate(weekStart))}
            </span>
            {/* Wages are a week in arrears, and "why isn't this person here?"
                is almost always this window being misread — so name it. */}
            <span className="text-[10px] text-text-muted text-center">
              paying work from {formatDDMMYYYY(payWeekOf(weekStart).start)} –{" "}
              {formatDDMMYYYY(payWeekOf(weekStart).end)}
            </span>
          </span>
          <Link href={go(store.id, nextWeek)}>
            <Button variant="secondary" size="icon" aria-label="Next week">
              <ChevronRightIcon size={16} />
            </Button>
          </Link>
        </div>
        {isAdmin && stores.length > 1 && (
          <div className="min-w-[180px]">
            <Select
              value={store.id}
              onChange={(e) => router.push(go(e.target.value, weekStart))}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {summary.load_error && (
        <div className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3">
          <p className="text-sm font-medium text-danger">
            These figures are incomplete — a query behind this sheet failed.
          </p>
          <p className="text-xs text-danger/80 mt-1">
            Do not pay from this screen until it is fixed. If a database
            migration is pending, run it and reload. ({summary.load_error})
          </p>
        </div>
      )}

      {/* Pre-payment summary */}
      <Card>
        <CardHeader
          action={
            confirmed ? (
              <Badge variant="success">Confirmed &amp; locked</Badge>
            ) : payout ? (
              <Badge variant="gold">Draft</Badge>
            ) : null
          }
        >
          <CardTitle>Pre-Payment Summary — {store.name}</CardTitle>
          <CardDescription>
            Wages due on Tuesday {tuesday} — for last week&apos;s work ({payWeekLabel})
          </CardDescription>
        </CardHeader>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              <SummaryRow label="Opening balance (carried forward)" value={formatGBP(fin.opening_balance)} />
              <SummaryRow label="Vita Mojo cash sales (Tue – Mon)" value={formatGBP(fin.vita_mojo_total)} />
              <SummaryRow label="Less: logged differences / cash used" value={`(${formatGBP(fin.logged_differences)})`} tone="bad" />
              {fin.supermarket_cash > 0.001 && (
                <SummaryRow label="Plus: Walkern and watton-at-stone money" value={`+ ${formatGBP(fin.supermarket_cash)}`} tone="good" />
              )}
              <SummaryRow label="Actual cash available" value={formatGBP(fin.actual_cash_available)} strong />
              <SummaryRow label="Total cash wages due" value={`(${formatGBP(fin.total_cash_wages)})`} tone="bad" />
              <SummaryRow label="Total delivery wages due" value={`(${formatGBP(fin.total_delivery_wages)})`} tone="bad" />
              <SummaryRow label="Grand total wages due" value={`(${formatGBP(fin.grand_total_wages)})`} tone="bad" strong />
              {fin.post_office_draw > 0.001 ? (
                <SummaryRow
                  label="⚠ Post Office draw required"
                  value={formatGBP(fin.post_office_draw)}
                  tone="bad"
                  strong
                  highlight
                />
              ) : (
                <SummaryRow label="Surplus cash remaining after wages" value={formatGBP(fin.surplus)} tone="good" strong />
              )}
            </tbody>
          </table>
        </div>

        {fin.post_office_draw > 0.001 && (
          <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger font-medium">
            Draw {formatGBP(fin.post_office_draw)} from the Post Office before paying wages this Tuesday.
          </div>
        )}
      </Card>

      {/* Wage breakdown */}
      <Card className="p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Tuesday Wage Breakdown</h3>
            <p className="text-sm text-text-muted mt-0.5">
              Hours &amp; deliveries from {payWeekLabel} ·{" "}
              {payout
                ? `${paidCount}/${payout.lines.length} marked paid`
                : "live forecast — generate the sheet to mark payments"}
            </p>
            <p className="text-xs text-text-subtle mt-1">
              Misc = extra drops logged beyond the normal round (with a reason at
              clock-out). Paid at the same short/long rate.
            </p>
          </div>
          {!locked && (
            <Button onClick={doGenerate} loading={busy === "generate"} variant={payout ? "secondary" : "primary"}>
              {payout ? "Regenerate sheet" : "Generate payout sheet"}
            </Button>
          )}
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-12">
            No employees have cash wages or deliveries to pay for {payWeekLabel}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
                  <th className="px-4 py-3 font-medium">Employee</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium text-right">Cash hrs</th>
                  <th className="px-4 py-3 font-medium text-right">Rate</th>
                  <th
                    className="px-4 py-3 font-medium text-right"
                    title="SD short · LD long · SM short misc · LM long misc"
                  >
                    Deliveries
                  </th>
                  <th className="px-4 py-3 font-medium text-right">Delivery £</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  {payout && <th className="px-4 py-3 font-medium text-center">Paid</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const lineId = l.id ?? null;
                  const isPaid = isLinePaid(l);
                  const saving = !!lineId && savingLines.includes(lineId);
                  return (
                    <tr key={lineId ?? l.employee_name + i} className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}>
                      <td className="px-4 py-3 font-medium text-text-primary">
                        {l.employee_name}
                        {l.cover_driver_id && (
                          <span
                            className="ml-2 align-middle text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-gold/40 bg-gold/10 text-gold font-medium"
                            title="Cover driver — paid cash from this sheet, no NI"
                          >
                            Cover
                          </span>
                        )}
                        {l.manager_id && (
                          <span
                            className="ml-2 align-middle text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-gold/40 bg-gold/10 text-gold font-medium"
                            title="Manager — deliveries they covered, paid per drop. Their salary is not on this sheet."
                          >
                            Manager
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-muted">{l.role ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <HoursMinsDisplay hours={l.cash_hours} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatGBP(l.cash_rate)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <DeliveryCell line={l} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {l.delivery_wages > 0 ? formatGBP(l.delivery_wages) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold">{formatGBP(l.total_payment)}</td>
                      {payout && (
                        <td className="px-4 py-3">
                          {lineId && (
                            // The tick flips straight away (optimistic), and a
                            // spinner sits beside it until the save lands.
                            <span className="flex items-center justify-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={isPaid}
                                disabled={locked || saving}
                                onChange={(e) => togglePaid(lineId, e.target.checked)}
                                className="h-4 w-4 accent-gold cursor-pointer disabled:cursor-not-allowed"
                                aria-label={`Mark ${l.employee_name} paid`}
                              />
                              <span
                                role="status"
                                aria-label={saving ? `Saving ${l.employee_name}` : undefined}
                                className={
                                  "h-3 w-3 rounded-full border-2 border-gold border-t-transparent " +
                                  (saving ? "animate-spin" : "invisible")
                                }
                              />
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-bg/60 font-semibold">
                  <td className="px-4 py-3" colSpan={4}>Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <DeliveryCell line={totals} total />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatGBP(lines.reduce((s, l) => s + l.delivery_wages, 0))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gold">
                    {formatGBP(lines.reduce((s, l) => s + l.total_payment, 0))}
                  </td>
                  {payout && <td></td>}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Confirmation footer */}
        {payout && (
          <div className="px-5 py-4 border-t border-border flex items-center justify-between gap-3 flex-wrap">
            {confirmed ? (
              <>
                <p className="text-sm text-success">
                  Confirmed by {payout.confirmed_by_name ?? "—"} on{" "}
                  {payout.confirmed_at ? `${formatDDMMYYYY(payout.confirmed_at)} ${formatTimeOnly(payout.confirmed_at)}` : "—"}
                </p>
                {isAdmin && (
                  <Button variant="danger" onClick={doUnlock} loading={busy === "unlock"}>
                    Unlock for amendment
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-text-muted">
                  Mark each employee paid, then confirm to lock the record and generate the weekly summary.
                </p>
                <Button
                  onClick={doConfirm}
                  loading={busy === "confirm"}
                  iconLeft={<CheckIcon size={16} />}
                  disabled={paidCount < payout.lines.length}
                >
                  Confirm all payments
                </Button>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  tone = "default",
  strong,
  highlight,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
  strong?: boolean;
  highlight?: boolean;
}) {
  const toneCls = tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-text-primary";
  return (
    <tr className={`border-t border-border/60 ${highlight ? "bg-danger/5" : ""}`}>
      <td className={`px-4 py-2.5 ${strong ? "font-semibold text-text-primary" : "text-text-subtle"}`}>{label}</td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${strong ? "font-semibold" : ""} ${toneCls}`}>{value}</td>
    </tr>
  );
}
