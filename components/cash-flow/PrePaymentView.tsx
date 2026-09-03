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
  savePayoutAdjustment,
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
import { payWeekOf, supermarketCashLabel } from "@/lib/cash-flow";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { DeliveryCell } from "./DeliveryCell";
import type {
  CashPayoutWithLines,
  PrePaymentAdjustment,
  PrePaymentSummary,
} from "@/lib/types";

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
        adjustments: frozenAdjustments(payout),
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

  // The adjustment editor. One form serves the whole list: `adjEditing` is the
  // id of the entry being changed, ADJ_NEW while adding, null when closed. The
  // boxes are seeded when it opens rather than from a effect — a refresh
  // landing mid-edit must not overwrite what is being typed.
  const [adjEditing, setAdjEditing] = React.useState<string | null>(null);
  const [adjAmount, setAdjAmount] = React.useState("");
  const [adjReason, setAdjReason] = React.useState("");

  const adjParsed = adjAmount.trim() === "" ? 0 : Number(adjAmount);
  const adjInvalid = adjAmount.trim() !== "" && !Number.isFinite(adjParsed);
  const editingId = adjEditing && adjEditing !== ADJ_NEW ? adjEditing : null;
  // Zero is only meaningful on an existing entry, where it means "remove this
  // one" — so a reason is required for everything except that.
  const adjRemoves = !!editingId && !adjInvalid && adjParsed === 0;
  const adjNeedsReason = !adjInvalid && !adjRemoves && !adjReason.trim();

  function openAdjustment(entry: PrePaymentAdjustment | null) {
    setAdjEditing(entry?.id ?? ADJ_NEW);
    setAdjAmount(entry ? String(entry.amount) : "");
    setAdjReason(entry?.reason ?? "");
  }

  function closeAdjustment() {
    setAdjEditing(null);
    setAdjAmount("");
    setAdjReason("");
  }

  async function doSaveAdjustment() {
    if (adjInvalid) {
      toast.error("Enter a valid amount.");
      return;
    }
    if (!editingId && adjParsed === 0) {
      toast.error("Enter an amount.");
      return;
    }
    if (adjNeedsReason) {
      toast.error("Give a reason for the adjustment.");
      return;
    }
    setBusy("adjust");
    try {
      await savePayoutAdjustment({
        store_id: store.id,
        week_start: weekStart,
        adjustment_id: editingId,
        amount: adjParsed,
        reason: adjReason.trim() || null,
      });
      toast.success(
        adjRemoves
          ? "Adjustment removed"
          : `Adjustment saved — ${adjParsed > 0 ? "+" : "−"}${formatGBP(Math.abs(adjParsed))}`,
      );
      closeAdjustment();
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
  // Wages paid this Tuesday are for the PREVIOUS Mon–Sun week, and the Vita
  // Mojo cash window is that SAME Mon–Sun week — both read from payWeekOf, the
  // function app/actions/payouts.ts computeSummary bounds its query with.
  const payWeek = payWeekOf(weekStart);
  const cashInStart = parseISODate(payWeek.start);
  const cashInEnd = parseISODate(payWeek.end);
  const payWeekLabel = `${formatDDMMYYYY(cashInStart)} – ${formatDDMMYYYY(cashInEnd)}`;

  // A confirmed sheet renders the FROZEN snapshot while the date label above it
  // is derived live, so a week locked under an older cash window silently reads
  // as though it were computed from the current one. Say so instead.
  const snapshotStale =
    confirmed && Math.abs(fin.vita_mojo_total - summary.vita_mojo_total) > 0.005;

  return (
    <div className="flex flex-col gap-5">
      {/* Week nav + store selector */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
          <Link href={go(store.id, prevWeek)}>
            <Button variant="secondary" size="icon" aria-label="Previous week">
              <ChevronLeftIcon size={16} />
            </Button>
          </Link>
          <span className="flex flex-col items-center min-w-0 sm:min-w-[180px]">
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
          <div className="w-full sm:w-auto sm:min-w-[180px]">
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
                label={`Vita Mojo cash sales (Mon ${formatDDMMYYYY(cashInStart)} – Sun ${formatDDMMYYYY(cashInEnd)})`}
                value={formatGBP(fin.vita_mojo_total)}
                hint={
                  snapshotStale
                    ? `Frozen when this payout was confirmed. Cash actually collected in this window is ${formatGBP(
                        summary.vita_mojo_total,
                      )} — a Super Admin must unlock and regenerate to restate it.`
                    : undefined
                }
              />
              <SummaryRow label="Less: logged differences / cash used" value={`(${formatGBP(fin.logged_differences)})`} tone="bad" />
              {fin.supermarket_cash > 0.001 && (
                <SummaryRow label={supermarketCashLabel(store.name)} value={`+ ${formatGBP(fin.supermarket_cash)}`} tone="good" />
              )}
              <SummaryRow label="Actual cash available" value={formatGBP(fin.actual_cash_available)} strong />
              <SummaryRow label="Total cash wages due" value={`(${formatGBP(fin.total_cash_wages)})`} tone="bad" />
              <SummaryRow label="Total delivery wages due" value={`(${formatGBP(fin.total_delivery_wages)})`} tone="bad" />
              <SummaryRow label="Grand total wages due" value={`(${formatGBP(fin.grand_total_wages)})`} tone="bad" strong />
              {/* One row per movement, so each keeps its own reason. Nothing is
                  rendered when there are none — a "£0.00" adjustment row on
                  every sheet is noise, and its absence is what makes a present
                  one worth reading. */}
              {fin.adjustments.map((a, i) => (
                <SummaryRow
                  key={a.id ?? `legacy-${i}`}
                  label={`Adjustment${a.reason ? ` — ${a.reason}` : ""}`}
                  value={`${a.amount > 0 ? "+" : "−"} ${formatGBP(Math.abs(a.amount))}`}
                  tone={a.amount > 0 ? "bad" : "good"}
                  // A pre-047 header figure has no row behind it to edit;
                  // adding any new entry materialises it server-side.
                  action={
                    !confirmed && a.id ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAdjustment(a)}
                        disabled={!!adjEditing}
                      >
                        Edit
                      </Button>
                    ) : null
                  }
                />
              ))}
              {fin.adjustments.length > 1 && (
                <SummaryRow
                  label={`Total adjustments (${fin.adjustments.length})`}
                  value={`${fin.adjustment > 0 ? "+" : "−"} ${formatGBP(Math.abs(fin.adjustment))}`}
                  tone={fin.adjustment > 0 ? "bad" : "good"}
                  strong
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

        {/* Manual adjustments. Every other figure on this sheet is derived, so
            cash that moved for a reason the system doesn't model had nowhere
            to go — the alternative was mis-recording an envelope, which
            corrupts the Vita Mojo reconciliation as well. A week can hold as
            many as it needs; each is a row above with its own reason and its
            own Edit button, and this one form serves all of them. Hidden once
            locked: the surplus has already been carried into next week's
            opening balance by then. */}
        {!confirmed && (
          <div className="mt-4 border-t border-border/60 pt-4 flex flex-col gap-3">
            {adjEditing ? (
              <>
                <AdjustmentForm
                  title={editingId ? "Edit adjustment" : "New adjustment"}
                  amount={adjAmount}
                  reason={adjReason}
                  onAmount={setAdjAmount}
                  onReason={setAdjReason}
                  onSave={doSaveAdjustment}
                  onCancel={closeAdjustment}
                  saving={busy === "adjust"}
                  invalid={adjInvalid}
                  needsReason={adjNeedsReason}
                  removes={adjRemoves}
                />
                <p className="text-xs text-text-muted">
                  A <span className="font-medium text-danger">positive</span> amount is cash
                  taken out of the pot — it grows the Post Office draw, or shrinks the surplus
                  carried into next week. A{" "}
                  <span className="font-medium text-success">negative</span> amount (e.g.{" "}
                  <span className="tabular-nums">-50</span>) is cash added and does the
                  opposite.{" "}
                  {editingId
                    ? "Set this one to 0 and save to remove it."
                    : "Each adjustment is saved separately, so add as many as the week needs."}{" "}
                  This does <span className="font-medium text-text-primary">not</span> change
                  the envelope figures or anyone&apos;s wages.
                  {!payout && <> Saving also generates this week&apos;s payout sheet.</>}
                </p>
              </>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-xs text-text-muted">
                  {fin.adjustments.length > 0
                    ? "Add another movement, or edit one in the rows above."
                    : "Need to add or take out cash this sheet doesn't know about?"}
                </p>
                <Button variant="outline" size="sm" className="w-full sm:w-auto sm:shrink-0" onClick={() => openAdjustment(null)}>
                  {fin.adjustments.length > 0 ? "Add another adjustment" : "Add adjustment"}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Wage breakdown */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
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
            <Button onClick={doGenerate} loading={busy === "generate"} variant={payout ? "secondary" : "primary"} className="w-full sm:w-auto sm:shrink-0">
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
            <table className="table-stack w-full text-sm">
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
                      <td className="px-4 py-3 font-medium text-text-primary" data-label="">
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
                      <td className="px-4 py-3 text-text-muted" data-label="Role">{l.role ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums" data-label="Cash hrs">
                        <HoursMinsDisplay hours={l.cash_hours} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums" data-label="Rate">{formatGBP(l.cash_rate)}</td>
                      <td className="px-4 py-3 text-right tabular-nums" data-label="Deliveries">
                        <DeliveryCell line={l} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums" data-label="Delivery £">
                        {l.delivery_wages > 0 ? formatGBP(l.delivery_wages) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-semibold" data-label="Total">{formatGBP(l.total_payment)}</td>
                      {payout && (
                        <td className="px-4 py-3" data-label="Paid">
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
                  <td className="px-4 py-3" colSpan={4} data-label="">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums" data-label="Deliveries">
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
                  <td className="px-4 py-3 text-right tabular-nums" data-label="Delivery £">
                    {formatGBP(lines.reduce((s, l) => s + l.delivery_wages, 0))}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gold" data-label="Total">
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
          <div className="px-4 sm:px-5 py-4 border-t border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            {confirmed ? (
              <>
                <p className="text-sm text-success">
                  Confirmed by {payout.confirmed_by_name ?? "—"} on{" "}
                  {payout.confirmed_at ? `${formatDDMMYYYY(payout.confirmed_at)} ${formatTimeOnly(payout.confirmed_at)}` : "—"}
                </p>
                {isAdmin && (
                  <Button variant="danger" onClick={doUnlock} loading={busy === "unlock"} className="w-full sm:w-auto sm:shrink-0">
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
                  className="w-full sm:w-auto sm:shrink-0"
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

/** Sentinel for "the form is open on a new entry", never a real adjustment id. */
const ADJ_NEW = "new";

/**
 * The frozen entries behind a confirmed payout's adjustment total. Falls back to
 * the header figure for a week settled before migration 047, so a locked sheet
 * always shows the money it applied.
 */
function frozenAdjustments(payout: CashPayoutWithLines): PrePaymentAdjustment[] {
  const rows = payout.adjustments ?? [];
  if (rows.length) {
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount) || 0,
      reason: r.reason,
      created_by_name: r.created_by_name,
    }));
  }
  const legacy = Number(payout.adjustment_amount) || 0;
  return legacy
    ? [{ id: null, amount: legacy, reason: payout.adjustment_reason ?? "Adjustment" }]
    : [];
}

/** The add/edit boxes. One instance is open at a time — see `adjEditing`. */
function AdjustmentForm({
  title,
  amount,
  reason,
  onAmount,
  onReason,
  onSave,
  onCancel,
  saving,
  invalid,
  needsReason,
  removes,
}: {
  title: string;
  amount: string;
  reason: string;
  onAmount: (v: string) => void;
  onReason: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  invalid: boolean;
  needsReason: boolean;
  /** True when saving this form deletes the entry (an existing one set to 0). */
  removes: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-3">
      <p className="text-xs font-medium text-text-subtle mb-2">{title}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Adjustment (+ / −)"
          type="number"
          step="0.01"
          prefix="£"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          error={invalid ? "Not a valid amount" : null}
          containerClassName="w-full sm:w-40"
        />
        <Input
          label="Reason *"
          placeholder="What is this money for?"
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          maxLength={200}
          disabled={removes}
          containerClassName="flex-1 w-full sm:min-w-[14rem]"
        />
        <div className="flex items-center gap-2 pb-0.5 w-full sm:w-auto">
          <Button
            className="flex-1 sm:flex-none"
            onClick={onSave}
            loading={saving}
            disabled={invalid || needsReason}
            variant={removes ? "danger" : "primary"}
          >
            {removes ? "Remove" : "Save"}
          </Button>
          <Button variant="secondary" className="flex-1 sm:flex-none" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  tone = "default",
  strong,
  highlight,
  hint,
  action,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad";
  strong?: boolean;
  highlight?: boolean;
  hint?: string;
  /** Sits to the LEFT of the figure — the row's own Edit button. */
  action?: React.ReactNode;
}) {
  const toneCls = tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-text-primary";
  return (
    <tr className={`border-t border-border/60 ${highlight ? "bg-danger/5" : ""}`}>
      <td className={`px-4 py-2.5 ${strong ? "font-semibold text-text-primary" : "text-text-subtle"}`}>
        {label}
        {hint && <span className="block text-[11px] text-warning mt-0.5">{hint}</span>}
      </td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${strong ? "font-semibold" : ""} ${toneCls}`}>
        {action ? (
          <span className="inline-flex items-center justify-end gap-3">
            {action}
            {value}
          </span>
        ) : (
          value
        )}
      </td>
    </tr>
  );
}
