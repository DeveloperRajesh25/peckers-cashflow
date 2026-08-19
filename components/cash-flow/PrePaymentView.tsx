"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon } from "@/components/ui/icons";
import {
  generatePayout,
  markLinePaid,
  confirmPayout,
  setPayoutAdjustment,
  unlockPayout,
} from "@/app/actions/payouts";
import {
  formatGBP,
  formatDDMMYYYY,
  weekLabel,
  parseISODate,
  formatTimeOnly,
  deliveryBreakdown,
  addDays,
} from "@/lib/utils";
import { payWeekOf, supermarketCashLabel } from "@/lib/cash-flow";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { DeliveryCell } from "./DeliveryCell";
import type { CashPayoutWithLines, PrePaymentSummary } from "@/lib/types";

type StoreOpt = { id: string; name: string };
type DisplayLine = {
  employee_name: string;
  /** Null on a cover driver or manager line — one of the two ids below is set. */
  employee_id?: string | null;
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
  vmDeliveryOrders,
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
  /** Vita Mojo delivery orders for the pay week, or null when VM has no data. */
  vmDeliveryOrders?: number | null;
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
        // Frozen with everything else at confirm — the adjustment that was
        // actually settled, not whatever the live figure says now.
        adjustment: Number(payout.adjustment_amount) || 0,
        adjustment_reason: payout.adjustment_reason ?? null,
        post_office_draw: payout.post_office_draw,
        surplus: payout.surplus_carry_forward,
      }
    : summary;

  const lines: DisplayLine[] = payout ? payout.lines : summary.lines;

  // A generated sheet is a SNAPSHOT of cash_payout_lines, not a live view. Work
  // approved after it was generated changes `summary` but not the saved lines,
  // so the sheet silently kept showing the old figures and the only signal was
  // confirmPayout refusing to lock. Compare the two here and say so.
  const drift = React.useMemo(() => {
    if (!payout) return null;
    const keyOf = (l: DisplayLine) =>
      l.cover_driver_id
        ? `cd:${l.cover_driver_id}`
        : l.manager_id
          ? `mgr:${l.manager_id}`
          : `emp:${l.employee_id}`;
    const dropsOf = (l: DisplayLine) => {
      const d = deliveryBreakdown(l);
      return d.sd + d.ld + d.sm + d.lm;
    };
    const stored = new Map(payout.lines.map((l) => [keyOf(l), l as DisplayLine]));
    const added: string[] = [];
    const changed: { name: string; from: number; to: number; drops: number }[] = [];
    for (const live of summary.lines) {
      const prior = stored.get(keyOf(live));
      if (!prior) {
        added.push(live.employee_name);
        continue;
      }
      stored.delete(keyOf(live));
      // Money AND drop counts: a correction that swaps a short for a long drop
      // can leave the total identical while the sheet still shows wrong counts.
      if (
        Math.abs(Number(prior.total_payment) - live.total_payment) > 0.005 ||
        dropsOf(prior) !== dropsOf(live)
      ) {
        changed.push({
          name: live.employee_name,
          from: Number(prior.total_payment),
          to: live.total_payment,
          drops: dropsOf(live) - dropsOf(prior),
        });
      }
    }
    const removed = Array.from(stored.values()).map((l) => l.employee_name);
    if (added.length === 0 && changed.length === 0 && removed.length === 0) return null;
    return { added, changed, removed };
  }, [payout, summary.lines]);

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

  // Delivery totals for the footer, summed per drop type (SD / LD / SM / LM).
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

  // Footer split: what a manager signs off (the normal round) vs the extra drops
  // logged beyond it, so both can be read against Vita Mojo's delivery orders.
  const approvedDeliveries =
    totals.short_deliveries_count + totals.long_deliveries_count;
  const miscDeliveries = totals.short_misc_count + totals.long_misc_count;

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

  // The adjustment editor. Seeded from whatever is on record and re-seeded
  // whenever the server figure changes, so a save (or another manager's edit
  // landing on refresh) leaves the boxes agreeing with the row above them.
  const [adjAmount, setAdjAmount] = React.useState(
    fin.adjustment ? String(fin.adjustment) : "",
  );
  const [adjReason, setAdjReason] = React.useState(fin.adjustment_reason ?? "");
  const [adjOpen, setAdjOpen] = React.useState(false);
  React.useEffect(() => {
    setAdjAmount(fin.adjustment ? String(fin.adjustment) : "");
    setAdjReason(fin.adjustment_reason ?? "");
  }, [fin.adjustment, fin.adjustment_reason]);

  const adjParsed = adjAmount.trim() === "" ? 0 : Number(adjAmount);
  const adjInvalid = adjAmount.trim() !== "" && !Number.isFinite(adjParsed);
  const adjNeedsReason = !adjInvalid && adjParsed !== 0 && !adjReason.trim();

  async function doSaveAdjustment() {
    if (adjInvalid) {
      toast.error("Enter a valid amount.");
      return;
    }
    if (adjNeedsReason) {
      toast.error("Give a reason for the adjustment.");
      return;
    }
    setBusy("adjust");
    try {
      await setPayoutAdjustment({
        store_id: store.id,
        week_start: weekStart,
        amount: adjParsed,
        reason: adjReason.trim() || null,
      });
      toast.success(
        adjParsed === 0
          ? "Adjustment cleared"
          : `Adjustment saved — ${adjParsed > 0 ? "+" : "−"}${formatGBP(Math.abs(adjParsed))}`,
      );
      setAdjOpen(false);
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
  // Vita Mojo cash window: the Tuesday before this week through this Monday —
  // mirrors the cashStart/cashEnd calc in app/actions/payouts.ts computeSummary.
  const cashInStart = addDays(parseISODate(weekStart), -6);
  const cashInEnd = parseISODate(weekStart);
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
              <SummaryRow
                label={`Vita Mojo cash sales (Tue ${formatDDMMYYYY(cashInStart)} – Mon ${formatDDMMYYYY(cashInEnd)})`}
                value={formatGBP(fin.vita_mojo_total)}
              />
              <SummaryRow label="Less: logged differences / cash used" value={`(${formatGBP(fin.logged_differences)})`} tone="bad" />
              {fin.supermarket_cash > 0.001 && (
                <SummaryRow label={supermarketCashLabel(store.name)} value={`+ ${formatGBP(fin.supermarket_cash)}`} tone="good" />
              )}
              <SummaryRow label="Actual cash available" value={formatGBP(fin.actual_cash_available)} strong />
              <SummaryRow label="Total cash wages due" value={`(${formatGBP(fin.total_cash_wages)})`} tone="bad" />
              <SummaryRow label="Total delivery wages due" value={`(${formatGBP(fin.total_delivery_wages)})`} tone="bad" />
              <SummaryRow label="Grand total wages due" value={`(${formatGBP(fin.grand_total_wages)})`} tone="bad" strong />
              {/* Only rendered when there is something to explain — a "£0.00"
                  adjustment row on every sheet is noise, and its absence is
                  what makes a present one worth reading. */}
              {Math.abs(fin.adjustment) > 0.001 && (
                <SummaryRow
                  label={`Adjustment${fin.adjustment_reason ? ` — ${fin.adjustment_reason}` : ""}`}
                  value={`${fin.adjustment > 0 ? "+" : "−"} ${formatGBP(Math.abs(fin.adjustment))}`}
                  tone={fin.adjustment > 0 ? "good" : "bad"}
                />
              )}
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

        {/* Manual adjustment. Every other figure on this sheet is derived, so
            cash that moved for a reason the system doesn't model had nowhere
            to go — the alternative was mis-recording an envelope, which
            corrupts the Vita Mojo reconciliation as well. Hidden once locked:
            the surplus has already been carried into next week's opening
            balance by then. */}
        {!confirmed && (
          <div className="mt-4 border-t border-border/60 pt-4">
            {!adjOpen ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-text-muted">
                  {Math.abs(fin.adjustment) > 0.001 ? (
                    <>
                      Adjusted by{" "}
                      <span className="font-medium text-text-primary">
                        {fin.adjustment > 0 ? "+" : "−"}
                        {formatGBP(Math.abs(fin.adjustment))}
                      </span>
                      {fin.adjustment_reason ? ` — ${fin.adjustment_reason}` : ""}
                    </>
                  ) : (
                    <>Need to add or take out cash this sheet doesn&apos;t know about?</>
                  )}
                </p>
                <Button variant="outline" size="sm" onClick={() => setAdjOpen(true)}>
                  {Math.abs(fin.adjustment) > 0.001 ? "Edit adjustment" : "Add adjustment"}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <Input
                    label="Adjustment (+ / −)"
                    type="number"
                    step="0.01"
                    prefix="£"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    error={adjInvalid ? "Not a valid amount" : null}
                    containerClassName="w-40"
                  />
                  <Input
                    label="Reason *"
                    placeholder="What is this money for?"
                    value={adjReason}
                    onChange={(e) => setAdjReason(e.target.value)}
                    maxLength={200}
                    containerClassName="flex-1 min-w-[14rem]"
                  />
                  <div className="flex items-center gap-2 pb-0.5">
                    <Button
                      onClick={doSaveAdjustment}
                      loading={busy === "adjust"}
                      disabled={adjInvalid || adjNeedsReason}
                    >
                      Save
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setAdjOpen(false);
                        setAdjAmount(fin.adjustment ? String(fin.adjustment) : "");
                        setAdjReason(fin.adjustment_reason ?? "");
                      }}
                      disabled={busy === "adjust"}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-text-muted">
                  A <span className="font-medium text-success">positive</span> amount is
                  cash added to the pot — it shrinks the Post Office draw, or grows the
                  surplus carried into next week. A{" "}
                  <span className="font-medium text-danger">negative</span> amount (e.g.{" "}
                  <span className="tabular-nums">-50</span>) is cash taken out and does the
                  opposite. Set it to 0 to remove the adjustment. This does{" "}
                  <span className="font-medium text-text-primary">not</span> change the
                  envelope figures or anyone&apos;s wages.
                  {!payout && (
                    <> Saving also generates this week&apos;s payout sheet.</>
                  )}
                </p>
              </div>
            )}
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

        {/* Approvals landing after the sheet was generated are invisible below
            — the table renders the saved snapshot. Say what changed and offer
            the one click that pulls it in, rather than letting the sheet be
            confirmed on figures nobody has seen. */}
        {drift && (
          <div className="mx-5 mt-4 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3">
            <p className="text-sm font-medium text-warning">
              This sheet is out of date — work was approved after it was generated.
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-text-subtle">
              {drift.added.map((name) => (
                <li key={`a:${name}`}>
                  <span className="font-medium text-text-primary">{name}</span> is not
                  on the sheet yet
                </li>
              ))}
              {drift.changed.map((c) => (
                <li key={`c:${c.name}`}>
                  <span className="font-medium text-text-primary">{c.name}</span>{" "}
                  {formatGBP(c.from)} → {formatGBP(c.to)}
                  {c.drops !== 0 && (
                    <>
                      {" "}
                      ({c.drops > 0 ? "+" : ""}
                      {c.drops} deliver{Math.abs(c.drops) === 1 ? "y" : "ies"})
                    </>
                  )}
                </li>
              ))}
              {drift.removed.map((name) => (
                <li key={`r:${name}`}>
                  <span className="font-medium text-text-primary">{name}</span> no
                  longer has anything to pay
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-text-muted">
              {locked
                ? "Unlock the payout to pull these in — the figures below are the confirmed snapshot."
                : "Regenerate the sheet to pull these in. Payments already ticked stay ticked."}
            </p>
            {!locked && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={doGenerate}
                loading={busy === "generate"}
              >
                Regenerate sheet
              </Button>
            )}
          </div>
        )}

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
                    <span className="flex flex-col items-end gap-0.5 whitespace-nowrap">
                      <span className="text-[10px] font-normal text-text-muted">
                        {totals.short_deliveries_count} SD ·{" "}
                        {totals.long_deliveries_count} LD ·{" "}
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
