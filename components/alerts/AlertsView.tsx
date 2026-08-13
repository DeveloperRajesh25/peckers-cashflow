"use client";

import * as React from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { listAlerts, resolveAlert, scanForAlerts } from "@/app/actions/alerts";
import {
  ALERTS_MAX_ROWS,
  ALERTS_PAGE_SIZE,
  alertsPageCount,
  type AlertsPage,
} from "@/lib/alerts-paging";
import { formatDDMMYYYY, formatTimeOnly } from "@/lib/utils";
import type { Employee, Store, SystemAlert } from "@/lib/types";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";

const ALERT_LABELS: Record<string, { title: string; variant: "warning" | "danger" | "neutral" | "gold" }> = {
  wage_variance: { title: "Wage variance", variant: "warning" },
  min_wage_violation: { title: "Minimum wage", variant: "danger" },
  delivery_payout_high: { title: "High delivery payout", variant: "warning" },
  delivery_unassigned: { title: "Unassigned deliveries", variant: "warning" },
  late_clock_in: { title: "Late clock-in", variant: "warning" },
  unexpected_absence: { title: "Unexpected absence", variant: "danger" },
  early_clock_out: { title: "Early clock-out", variant: "warning" },
  scheduled_vs_actual: { title: "Scheduled vs actual", variant: "neutral" },
  missing_daily_entry: { title: "Missing cash entry", variant: "warning" },
  unresolved_discrepancy: { title: "Cash discrepancy", variant: "warning" },
  post_office_draw: { title: "Post Office draw", variant: "danger" },
  negative_cash_balance: { title: "Negative cash balance", variant: "danger" },
  wages_not_confirmed: { title: "Wages not confirmed", variant: "warning" },
  unconfirmed_payment: { title: "Unconfirmed payment", variant: "warning" },
};

export function AlertsView({
  initialPage,
  stores,
  employees,
}: {
  /** Page 1 with the default filters — every later page is fetched on demand. */
  initialPage: AlertsPage;
  stores: Store[];
  employees: Employee[];
}) {
  const toast = useToast();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [showResolved, setShowResolved] = React.useState(false);
  const [storeFilter, setStoreFilter] = React.useState<string>("all");
  const [resolving, setResolving] = React.useState<SystemAlert | null>(null);
  const [note, setNote] = React.useState("");

  const [alerts, setAlerts] = React.useState<SystemAlert[]>(initialPage.rows);
  const [total, setTotal] = React.useState(initialPage.total);
  const [openCount, setOpenCount] = React.useState(initialPage.openCount);
  const [openCapped, setOpenCapped] = React.useState(initialPage.openCountCapped);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // Page 1 is already in hand; only refetch it once a filter actually changes.
  const filtersTouched = React.useRef(false);
  // Toggling a filter twice in quick succession must not let the first reply
  // land on top of the second.
  const requestSeq = React.useRef(0);

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  const fetchPage = React.useCallback(
    async (target: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listAlerts({
          page: target,
          storeId: storeFilter === "all" ? null : storeFilter,
          includeResolved: showResolved,
        });
        if (seq !== requestSeq.current) return;
        // One page REPLACES the last — this is a pager, not an infinite list.
        setAlerts(res.rows);
        setTotal(res.total);
        setOpenCount(res.openCount);
        setOpenCapped(res.openCountCapped);
        setPage(target);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load alerts");
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [storeFilter, showResolved],
  );

  // A filter change re-asks the server — the list is a page, not the whole set,
  // so it can't be narrowed in the browser without the badge lying.
  React.useEffect(() => {
    if (!filtersTouched.current) return;
    void fetchPage(1);
  }, [fetchPage]);

  const pageCount = alertsPageCount(total);
  const firstShown = total === 0 ? 0 : (page - 1) * ALERTS_PAGE_SIZE + 1;
  const lastShown = Math.min(page * ALERTS_PAGE_SIZE, total);

  function changeFilters(apply: () => void) {
    filtersTouched.current = true;
    apply();
  }

  async function runScan() {
    setScanning(true);
    try {
      await scanForAlerts();
      toast.success("Scan complete");
      await fetchPage(1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setScanning(false);
    }
  }

  async function doResolve() {
    if (!resolving) return;
    const id = resolving.id;
    const trimmed = note.trim() || null;
    setBusyId(id);
    try {
      await resolveAlert({ id, note });
      toast.success("Resolved");
      setResolving(null);
      setNote("");
      // Resolving flips the sort key. Refetching would jump every loaded row
      // under the cursor, so the row is updated where it sits instead.
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, resolved: true, resolution_note: trimmed } : a,
        ),
      );
      setOpenCount((c) => Math.max(0, c - 1));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant={openCount > 0 ? "warning" : "success"}>
            {openCount}
            {openCapped ? "+" : ""} open
          </Badge>
          <button
            onClick={() => changeFilters(() => setShowResolved((v) => !v))}
            className="text-xs text-gold hover:underline"
          >
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
          <select
            value={storeFilter}
            onChange={(e) => {
              const next = e.target.value;
              changeFilters(() => setStoreFilter(next));
            }}
            className="h-9 px-3 rounded-lg bg-surface border border-border text-sm"
          >
            <option value="all">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={runScan} loading={scanning}>
          Scan now
        </Button>
      </div>

      {loadError ? (
        <Card className="border-danger/40">
          <p className="text-sm text-danger">
            Couldn&apos;t load alerts — {loadError}. This list is incomplete; retry
            before treating it as &quot;nothing outstanding&quot;.
          </p>
        </Card>
      ) : alerts.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted text-center py-10">
            {loading
              ? "Loading alerts…"
              : `No alerts ${showResolved ? "" : "open"}. Click "Scan now" to check for new issues.`}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {alerts.map((a) => {
            const meta = ALERT_LABELS[a.alert_type] ?? {
              title: a.alert_type,
              variant: "neutral",
            };
            const store = a.store_id ? storeById.get(a.store_id) : null;
            const emp = a.employee_id ? empById.get(a.employee_id) : null;
            return (
              <Card
                key={a.id}
                className={a.resolved ? "opacity-70" : ""}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={meta.variant}>{meta.title}</Badge>
                      {store && <Badge variant="neutral">{store.name}</Badge>}
                      {a.resolved && <Badge variant="success">Resolved</Badge>}
                      <span className="text-xs text-text-muted">
                        {formatDDMMYYYY(a.created_at)} · {formatTimeOnly(a.created_at)}
                      </span>
                    </div>
                    <h3 className="font-medium mt-2 text-text-primary">
                      {a.title}
                    </h3>
                    <p className="text-sm text-text-subtle mt-1">{a.message}</p>
                    {a.resolution_note && (
                      <p className="text-xs text-success mt-2">
                        Resolved: {a.resolution_note}
                      </p>
                    )}
                  </div>
                  {!a.resolved && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setResolving(a)}
                      iconLeft={<CheckIcon size={14} />}
                    >
                      Resolve
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <p className="text-xs text-text-muted">
              Showing {firstShown}–{lastShown} of {total}
              {openCapped && ` (newest ${ALERTS_MAX_ROWS})`}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void fetchPage(page - 1)}
                disabled={page <= 1 || loading}
                aria-label="Previous 10 alerts"
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-surface border border-border text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-surface transition-colors"
              >
                <ChevronLeftIcon size={16} />
              </button>
              <span className="text-xs text-text-muted tabular-nums min-w-[5.5rem] text-center">
                Page {page} of {pageCount}
              </span>
              <button
                onClick={() => void fetchPage(page + 1)}
                disabled={page >= pageCount || loading}
                aria-label="Next 10 alerts"
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-surface border border-border text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-surface transition-colors"
              >
                <ChevronRightIcon size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resolve modal */}
      {resolving && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setResolving(null)}
          />
          <div className="relative w-full sm:max-w-md bg-surface border border-border rounded-t-2xl sm:rounded-2xl p-5">
            <h3 className="font-semibold mb-2">Resolve alert</h3>
            <p className="text-sm text-text-muted mb-3">{resolving.title}</p>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional resolution note"
              className="w-full rounded-xl bg-bg border border-border px-3 py-2 text-sm outline-none focus:border-gold/60"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setResolving(null)}>
                Cancel
              </Button>
              <Button
                onClick={doResolve}
                loading={busyId === resolving.id}
              >
                Mark resolved
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
