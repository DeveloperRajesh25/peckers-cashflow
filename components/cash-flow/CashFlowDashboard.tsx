"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  ArchiveIcon,
  ChevronRightIcon,
  ListIcon,
  WalletIcon,
} from "@/components/ui/icons";
import { loadStoreCashView } from "@/app/actions/cash-flow";
import { formatDDMMYYYY, formatGBP, formatTimeOnly, weekLabel, parseISODate } from "@/lib/utils";
import type { PrePaymentSummary } from "@/lib/types";
import type { RunningBalanceRow } from "@/lib/cash-flow";

export type StoreCashView = {
  store: { id: string; name: string };
  openingBalance: number;
  runningBalance: number;
  rows: RunningBalanceRow[];
  discrepancyDays: number;
  summary: PrePaymentSummary;
  lastEntry: { name: string | null; date: string; at: string } | null;
  payoutStatus: "none" | "draft" | "confirmed";
};

function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "bad" | "gold";
  hint?: string;
}) {
  const toneCls =
    tone === "good"
      ? "text-success"
      : tone === "bad"
        ? "text-danger"
        : tone === "gold"
          ? "text-gold"
          : "text-text-primary";
  return (
    <div className="rounded-xl bg-bg border border-border px-4 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${toneCls}`}>{value}</p>
      {hint && <p className="text-[11px] text-text-muted mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * A link off to another cash-flow page. Deliberately NOT button-styled: filled
 * pills sitting in a row read as a selected tab / filter, which is what these
 * used to look like. The trailing chevron (and the nudge it gets on hover) says
 * "this takes you somewhere else".
 */
function PageLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm font-medium text-text-subtle hover:text-gold hover:bg-surface-hover transition-colors"
    >
      <span className="text-text-muted group-hover:text-gold transition-colors">{icon}</span>
      <span className="underline-offset-4 group-hover:underline">{children}</span>
      <ChevronRightIcon
        size={14}
        className="text-text-muted group-hover:text-gold group-hover:translate-x-0.5 transition-all"
      />
    </Link>
  );
}

export function CashFlowDashboard({
  stores,
  views,
  weekStart,
  basePath,
}: {
  /** Every store — the tabs are driven by this, NOT by what has loaded. */
  stores: { id: string; name: string }[];
  /** The store the page opened on. Others arrive from loadStoreCashView. */
  views: StoreCashView[];
  weekStart: string;
  basePath: string;
}) {
  const [activeId, setActiveId] = React.useState(
    views[0]?.store.id ?? stores[0]?.id ?? "",
  );
  // Keyed by store AND week — stepping to another week must not serve the
  // previous week's figures back for a store already in the map.
  const [loaded, setLoaded] = React.useState<Map<string, StoreCashView>>(() => {
    const seed = new Map<string, StoreCashView>();
    for (const v of views) seed.set(`${v.store.id}:${weekStart}`, v);
    return seed;
  });
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const activeKey = `${activeId}:${weekStart}`;
  const activeView = loaded.get(activeKey);

  React.useEffect(() => {
    if (!activeId || loaded.has(activeKey)) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadStoreCashView({ store_id: activeId, week_start: weekStart })
      .then((view) => {
        if (!cancelled) setLoaded((prev) => new Map(prev).set(activeKey, view));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load this store");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, activeKey, weekStart, loaded]);

  // Each store is a separate business — show one at a time, never combined.
  const shown = activeView ? [activeView] : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 -mt-2">
        <p className="text-sm text-text-muted">
          Week of {weekLabel(parseISODate(weekStart))}
        </p>
        {stores.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            {stores.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={
                  "px-4 h-9 rounded-xl border text-sm font-medium transition-colors " +
                  (s.id === activeId
                    ? "bg-gold text-black border-gold"
                    : "bg-surface text-text-primary border-border hover:bg-surface-hover")
                }
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {loadError && (
        <Card className="border-danger/40">
          <p className="text-sm text-danger">
            Couldn&apos;t load this store&apos;s cash flow — {loadError}. Nothing below is
            trustworthy for this store; reload before acting on it.
          </p>
        </Card>
      )}

      {!loadError && !activeView && (
        <Card>
          <p className="text-sm text-text-muted">
            {loading ? "Loading…" : "No cash flow to show for this store."}
          </p>
        </Card>
      )}

      {shown.map((v) => {
        const draw = v.summary.post_office_draw;
        return (
          <Card key={v.store.id} className="p-0 overflow-hidden">
            <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-text-primary">{v.store.name}</h2>
                {v.payoutStatus === "confirmed" && <Badge variant="success">Wages paid</Badge>}
                {v.payoutStatus === "draft" && <Badge variant="gold">Payout in progress</Badge>}
              </div>
              {/* Links to the other cash-flow pages. Styled as navigation —
                  identical treatment, leading icon, trailing chevron — so none
                  of them reads as a selected filter on this page. */}
              <div className="flex items-center gap-1 text-sm flex-wrap">
                <PageLink href={`${basePath}/daily?week=${weekStart}`} icon={<ListIcon size={14} />}>
                  Daily entries
                </PageLink>
                <PageLink
                  href={`${basePath}/payout?week=${weekStart}&store=${v.store.id}`}
                  icon={<WalletIcon size={14} />}
                >
                  Tuesday payout
                </PageLink>
                <PageLink href={`${basePath}/history`} icon={<ArchiveIcon size={14} />}>
                  History
                </PageLink>
              </div>
            </div>

            <div className="p-5 flex flex-col gap-5">
              {/* Post Office draw alert */}
              {draw > 0.001 && (
                <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
                  <p className="text-sm font-semibold text-danger">
                    ⚠ Draw {formatGBP(draw)} from the Post Office before Tuesday
                  </p>
                  <p className="text-xs text-text-subtle mt-1">
                    Forecast wages {formatGBP(v.summary.grand_total_wages)} exceed available cash{" "}
                    {formatGBP(v.summary.actual_cash_available)}.
                  </p>
                </div>
              )}

              {/* Stat tiles */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Stat label="Running cash balance" value={formatGBP(v.runningBalance)} tone="gold" />
                <Stat
                  label="Tuesday wage forecast"
                  value={formatGBP(v.summary.grand_total_wages)}
                  hint={`Cash ${formatGBP(v.summary.total_cash_wages)} + delivery ${formatGBP(v.summary.total_delivery_wages)}`}
                />
                <Stat
                  label="Post Office draw"
                  value={formatGBP(draw)}
                  tone={draw > 0.001 ? "bad" : "good"}
                />
              </div>

              {/* This week's daily summary */}
              {v.rows.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="table-stack w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
                        <th className="px-4 py-2.5 font-medium">Date</th>
                        <th className="px-4 py-2.5 font-medium">Manager</th>
                        <th className="px-4 py-2.5 font-medium text-right">Vita Mojo</th>
                        <th className="px-4 py-2.5 font-medium text-right">Envelope</th>
                        <th className="px-4 py-2.5 font-medium text-right">Diff</th>
                        <th className="px-4 py-2.5 font-medium text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.rows.map((r, i) => {
                        const balanced = Math.abs(r.difference) < 0.001;
                        return (
                          <tr key={r.entry_date} className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}>
                            <td className="px-4 py-2.5 whitespace-nowrap" data-label="">
                              {formatDDMMYYYY(r.entry_date)}
                              {r.is_late && (
                                <Badge variant="warning" className="ml-2 text-[10px] py-0 px-1.5">Late</Badge>
                              )}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-text-subtle" data-label="Manager">{r.manager_name ?? "—"}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Vita Mojo">{formatGBP(r.vita_mojo_sales)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums" data-label="Envelope">{formatGBP(r.envelope_amount)}</td>
                            <td data-label="Diff" className={`px-4 py-2.5 text-right tabular-nums ${balanced ? "text-text-muted" : r.difference > 0 ? "text-danger" : "text-warning"}`}>
                              {formatGBP(r.difference)}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums font-medium" data-label="Balance">{formatGBP(r.running_balance)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-text-muted">No cash entries recorded this week yet.</p>
              )}

              {/* Last entry */}
              <p className="text-xs text-text-muted">
                {v.lastEntry
                  ? `Last entry: ${formatDDMMYYYY(v.lastEntry.date)} by ${v.lastEntry.name ?? "—"} at ${formatTimeOnly(v.lastEntry.at)}`
                  : "No entries submitted yet."}
                {v.openingBalance > 0 && ` · Opening balance carried forward: ${formatGBP(v.openingBalance)}`}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
