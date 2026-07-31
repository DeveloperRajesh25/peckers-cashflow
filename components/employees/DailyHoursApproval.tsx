"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { DatePicker } from "@/components/ui/DatePicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import {
  AlertIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
} from "@/components/ui/icons";
import { addDays, cn, parseISODate, toISODate } from "@/lib/utils";
import { ManualClockEntryModal } from "@/components/clock/ManualClockEntryModal";
import type {
  ClockDailySummary,
  CoverDailyApprovalRow,
  Store,
} from "@/lib/types";

const WD = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MO = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function longDate(iso: string): string {
  const d = parseISODate(iso);
  if (isNaN(d.getTime())) return iso;
  return `${WD[d.getDay()]}, ${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
}

function relLabel(iso: string, todayISO: string): string | null {
  if (iso === todayISO) return "Today";
  if (iso === toISODate(addDays(parseISODate(todayISO), -1))) return "Yesterday";
  return null;
}

/**
 * Employee and cover-driver days share this screen, so both are normalised to
 * one row shape. `kind` is what routes an approval to the right server action —
 * the two are different tables with different pay rules underneath.
 */
type ApprovalRow = {
  kind: "employee" | "cover";
  person_id: string;
  name: string;
  store_id: string | null;
  event_date: string;
  clocked_hours: number;
  /**
   * The day's individual shifts. Approval stays per DAY on the total — this is
   * shown so a manager can see WHY a day totals what it does before signing it
   * off. Empty for cover drivers and for days with no session detail.
   */
  shifts: string[];
  approved: boolean;
  approved_hours: number | null;
  /** cover_driver_hours row id — cover rows only, needed to undo. */
  approved_row_id: string | null;
  auto_clocked_out: boolean;
  manual_entry: boolean;
  manual_entry_reason: string | null;
  /** Only drivers earn a per-delivery allowance, so only they get the inputs. */
  is_driver: boolean;
  /** The normal round — editable here; a correction replaces the driver's figure. */
  short_deliveries: number;
  long_deliveries: number;
  /**
   * Beyond the normal round. Editable here, but a count above zero requires
   * a reason — the same rule every other delivery write path enforces.
   */
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
};

/** "09:00–13:00" for one shift; an unfinished one reads "17:00–…". */
function shiftLabels(
  sessions: ClockDailySummary["sessions"] | undefined,
): string[] {
  if (!sessions || sessions.length < 2) return []; // a single shift adds nothing
  return sessions.map(
    (s) =>
      `${hhmm(s.clock_in_at)}–${s.clock_out_at ? hhmm(s.clock_out_at) : "…"}`,
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const rowKey = (r: ApprovalRow) => `${r.kind}:${r.person_id}:${r.event_date}`;

function fromEmployee(s: ClockDailySummary): ApprovalRow {
  return {
    kind: "employee",
    person_id: s.employee_id,
    name: s.employee_name,
    store_id: s.store_id,
    event_date: s.event_date,
    clocked_hours: s.clocked_hours,
    shifts: shiftLabels(s.sessions),
    approved: s.hours_approved,
    approved_hours: s.approved_hours,
    approved_row_id: null,
    auto_clocked_out: Boolean(s.auto_clocked_out),
    manual_entry: Boolean(s.manual_entry),
    manual_entry_reason: s.manual_entry_reason ?? null,
    is_driver: Boolean(s.is_driver),
    short_deliveries: s.short_deliveries ?? 0,
    long_deliveries: s.long_deliveries ?? 0,
    extra_short_deliveries: s.extra_short_deliveries ?? 0,
    extra_long_deliveries: s.extra_long_deliveries ?? 0,
    extra_short_reason: s.extra_short_reason ?? null,
    extra_long_reason: s.extra_long_reason ?? null,
  };
}

function fromCover(c: CoverDailyApprovalRow): ApprovalRow {
  return {
    kind: "cover",
    person_id: c.cover_driver_id,
    name: c.driver_name,
    store_id: c.store_id,
    event_date: c.work_date,
    clocked_hours: c.clocked_hours,
    // Cover drivers are single-shift: multi-shift days are an employee feature.
    shifts: [],
    approved: c.approved,
    approved_hours: c.approved_hours,
    approved_row_id: c.approved_row_id,
    auto_clocked_out: c.auto_clocked_out,
    manual_entry: c.manual_entry,
    manual_entry_reason: c.manual_entry_reason,
    // Cover drivers' deliveries are settled by their own per-day approval
    // (approveCoverDriverDay snapshots the rates), so they are not edited here.
    is_driver: false,
    short_deliveries: 0,
    long_deliveries: 0,
    extra_short_deliveries: 0,
    extra_long_deliveries: 0,
    extra_short_reason: null,
    extra_long_reason: null,
  };
}

type Handlers = {
  onApprove: (
    employee_id: string,
    event_date: string,
    override_hours?: number,
    deliveries?: {
      short?: number;
      long?: number;
      extraShort?: number;
      extraShortReason?: string;
      extraLong?: number;
      extraLongReason?: string;
    },
  ) => Promise<void>;
  onApproveDate: (event_date: string, employee_ids: string[]) => Promise<void>;
  onUnapprove: (employee_id: string, event_date: string) => Promise<void>;
  onCoverApprove?: (
    cover_driver_id: string,
    work_date: string,
    override_hours?: number,
  ) => Promise<void>;
  onCoverApproveDate?: (
    work_date: string,
    cover_driver_ids: string[],
  ) => Promise<void>;
  onCoverUnapprove?: (approved_row_id: string) => Promise<void>;
};

export function DailyHoursApproval({
  summaries,
  coverSummaries = [],
  stores,
  todayISO,
  showStore,
  employees = [],
  coverDrivers = [],
  onManualSaved,
  onApprove,
  onApproveDate,
  onUnapprove,
  onCoverApprove,
  onCoverApproveDate,
  onCoverUnapprove,
}: {
  summaries: ClockDailySummary[];
  /** Cover driver days, shown alongside employees on the same date. */
  coverSummaries?: CoverDailyApprovalRow[];
  stores: Store[];
  todayISO: string;
  showStore: boolean;
  /** Active roster, for the "someone forgot to clock in" picker. */
  employees?: Array<{ id: string; name: string }>;
  coverDrivers?: Array<{ id: string; name: string }>;
  onManualSaved?: () => void;
} & Handlers) {
  const toast = useToast();
  const [selectedDate, setSelectedDate] = React.useState(todayISO);
  const [showAddMissed, setShowAddMissed] = React.useState<
    "employee" | "cover_driver" | null
  >(null);
  const [edited, setEdited] = React.useState<Record<string, string>>({});
  // Corrected delivery counts, keyed `<rowKey>:short` / `<rowKey>:long`. Kept
  // separate from `edited` (hours) so an untouched field stays undefined and is
  // never sent — the server only writes a count it was actually given.
  const [editedDeliv, setEditedDeliv] = React.useState<Record<string, string>>({});
  // Reason text for a corrected extra count, keyed `<rowKey>:extraShort` /
  // `<rowKey>:extraLong`. Only rendered (and only required) once the matching
  // extra count has actually been changed to something above zero.
  const [editedExtraReason, setEditedExtraReason] = React.useState<
    Record<string, string>
  >({});
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [busyDate, setBusyDate] = React.useState<string | null>(null);
  const [hideApproved, setHideApproved] = React.useState(false);

  // Employees first, then cover drivers, matching the Live board's ordering.
  const allRows = React.useMemo<ApprovalRow[]>(
    () => [...summaries.map(fromEmployee), ...coverSummaries.map(fromCover)],
    [summaries, coverSummaries],
  );

  const storeName = React.useMemo(() => {
    const m = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [stores]);

  // Manager-confirmed hours for a row: the edited value if valid, else the value
  // approved earlier, else the raw clocked total.
  function effHours(s: ApprovalRow): number {
    const raw = edited[rowKey(s)];
    const parsed = raw !== undefined ? parseFloat(raw) : NaN;
    if (raw !== undefined && !isNaN(parsed) && parsed > 0) return parsed;
    if (s.approved_hours != null) return s.approved_hours;
    return s.clocked_hours;
  }

  type DeliveryField = "short" | "long" | "extraShort" | "extraLong";

  function storedDeliveryValue(s: ApprovalRow, which: DeliveryField): number {
    switch (which) {
      case "short":
        return s.short_deliveries;
      case "long":
        return s.long_deliveries;
      case "extraShort":
        return s.extra_short_deliveries;
      case "extraLong":
        return s.extra_long_deliveries;
    }
  }

  /** Manager-confirmed delivery count for a row: the edit if valid, else the
   *  count the driver entered (or, for the extras, the count already on
   *  record). Zero is legitimate, so the guard is on the parse succeeding,
   *  not on the number being truthy. */
  function effDeliveries(s: ApprovalRow, which: DeliveryField): number {
    const raw = editedDeliv[`${rowKey(s)}:${which}`];
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    if (raw !== undefined && !isNaN(parsed) && parsed >= 0) return parsed;
    return storedDeliveryValue(s, which);
  }

  function deliveryChanged(s: ApprovalRow, which: DeliveryField): boolean {
    return effDeliveries(s, which) !== storedDeliveryValue(s, which);
  }

  function effExtraReason(s: ApprovalRow, which: "extraShort" | "extraLong"): string {
    const raw = editedExtraReason[`${rowKey(s)}:${which}`];
    if (raw !== undefined) return raw;
    return (which === "extraShort" ? s.extra_short_reason : s.extra_long_reason) ?? "";
  }

  /** An extra count the manager raised above zero, with nothing explaining it
   *  yet — mirrors the rule setClockDeliveries and DeliveryEditModal already
   *  enforce, surfaced here before the write is attempted rather than after. */
  function extraNeedsReason(s: ApprovalRow, which: "extraShort" | "extraLong"): boolean {
    return (
      deliveryChanged(s, which) &&
      effDeliveries(s, which) > 0 &&
      !effExtraReason(s, which).trim()
    );
  }

  /** A driver day with nothing recorded — flagged, never blocked. A real
   *  zero-delivery shift happens, and refusing would strand the day's hours. */
  function missingDeliveries(s: ApprovalRow): boolean {
    return (
      s.is_driver &&
      !s.approved &&
      s.short_deliveries === 0 &&
      s.long_deliveries === 0 &&
      s.extra_short_deliveries === 0 &&
      s.extra_long_deliveries === 0
    );
  }

  const selectedRows = allRows.filter((s) => s.event_date === selectedDate);
  const approvedCount = selectedRows.filter((s) => s.approved).length;
  const pendingCount = selectedRows.filter(
    (s) => !s.approved && s.clocked_hours > 0,
  ).length;
  const visibleSelected = hideApproved
    ? selectedRows.filter((s) => !s.approved)
    : selectedRows;

  // Every OTHER date that still has unapproved clocked days, newest first.
  const otherPendingByDate = React.useMemo(() => {
    const map = new Map<string, ApprovalRow[]>();
    for (const s of allRows) {
      if (s.event_date === selectedDate) continue;
      if (s.approved || s.clocked_hours <= 0) continue;
      const arr = map.get(s.event_date) ?? [];
      arr.push(s);
      map.set(s.event_date, arr);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [allRows, selectedDate]);

  const totalOtherPending = otherPendingByDate.reduce(
    (n, [, rows]) => n + rows.length,
    0,
  );

  // Who can still be added for the selected day: anyone on the roster without a
  // clock record. Deliberately the whole roster rather than "expected today" —
  // the rota isn't loaded here, and someone who picked up an unscheduled shift
  // is exactly the person most likely to have forgotten to clock in.
  // Everyone active stays pickable, including those who already worked that
  // day: a day can hold several shifts, so "already has a record" is no longer
  // a reason to hide someone — it's just something to label. The server rejects
  // a window overlapping one already recorded.
  const manualCandidates = React.useMemo(() => {
    const shiftsThatDay = new Map<string, number>();
    for (const s of summaries) {
      if (s.event_date !== selectedDate) continue;
      shiftsThatDay.set(s.employee_id, Math.max(1, s.sessions.length));
    }
    return employees
      .map((e) => ({
        id: e.id,
        name: e.name,
        existing_shifts: shiftsThatDay.get(e.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, summaries, selectedDate]);

  const coverManualCandidates = React.useMemo(() => {
    const withRecord = new Set(
      coverSummaries
        .filter((s) => s.work_date === selectedDate)
        .map((s) => s.cover_driver_id),
    );
    return coverDrivers
      .filter((d) => !withRecord.has(d.id))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [coverDrivers, coverSummaries, selectedDate]);

  function shiftDay(delta: number) {
    const next = toISODate(addDays(parseISODate(selectedDate), delta));
    if (delta > 0 && next > todayISO) return;
    setSelectedDate(next);
  }

  async function doApprove(s: ApprovalRow) {
    const key = rowKey(s);
    const eff = effHours(s);
    if (!(eff > 0)) return;
    const override = Math.abs(eff - s.clocked_hours) > 0.01 ? eff : undefined;

    // An extra raised above zero with nothing explaining it is refused before
    // the request is even sent — the server enforces the same rule, but there
    // is no reason to make a round trip for it.
    if (s.is_driver && extraNeedsReason(s, "extraShort")) {
      toast.error("Give a reason for the extra short deliveries.");
      return;
    }
    if (s.is_driver && extraNeedsReason(s, "extraLong")) {
      toast.error("Give a reason for the extra long deliveries.");
      return;
    }

    // Only send a field the manager actually changed. Sending the unchanged
    // value would be harmless but makes every approval look like a correction
    // in the audit log.
    const short = effDeliveries(s, "short");
    const long = effDeliveries(s, "long");
    const extraShort = effDeliveries(s, "extraShort");
    const extraLong = effDeliveries(s, "extraLong");
    const shortChanged = deliveryChanged(s, "short");
    const longChanged = deliveryChanged(s, "long");
    const extraShortChanged = deliveryChanged(s, "extraShort");
    const extraLongChanged = deliveryChanged(s, "extraLong");
    const anyDeliveryChanged =
      shortChanged || longChanged || extraShortChanged || extraLongChanged;

    const deliveries =
      s.is_driver && anyDeliveryChanged
        ? {
            ...(shortChanged ? { short } : {}),
            ...(longChanged ? { long } : {}),
            ...(extraShortChanged
              ? {
                  extraShort,
                  extraShortReason: effExtraReason(s, "extraShort").trim(),
                }
              : {}),
            ...(extraLongChanged
              ? {
                  extraLong,
                  extraLongReason: effExtraReason(s, "extraLong").trim(),
                }
              : {}),
          }
        : undefined;

    setBusyKey(key);
    try {
      if (s.kind === "cover") {
        if (!onCoverApprove) return;
        await onCoverApprove(s.person_id, s.event_date, override);
      } else {
        await onApprove(s.person_id, s.event_date, override, deliveries);
      }
      toast.success(
        deliveries
          ? `Approved ${s.name} — ${eff.toFixed(2)}h, ${short + long + extraShort + extraLong} deliveries`
          : `Approved ${s.name} — ${eff.toFixed(2)}h`,
      );
      setEdited((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      setEditedDeliv((p) => {
        const n = { ...p };
        delete n[`${key}:short`];
        delete n[`${key}:long`];
        delete n[`${key}:extraShort`];
        delete n[`${key}:extraLong`];
        return n;
      });
      setEditedExtraReason((p) => {
        const n = { ...p };
        delete n[`${key}:extraShort`];
        delete n[`${key}:extraLong`];
        return n;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setBusyKey(null);
    }
  }

  async function doUnapprove(s: ApprovalRow) {
    const key = rowKey(s);
    setBusyKey(key);
    try {
      if (s.kind === "cover") {
        if (!onCoverUnapprove || !s.approved_row_id) return;
        await onCoverUnapprove(s.approved_row_id);
      } else {
        await onUnapprove(s.person_id, s.event_date);
      }
      toast.success(`Reverted ${s.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function doApproveDate(date: string, rows: ApprovalRow[]) {
    const pending = rows.filter((r) => !r.approved && r.clocked_hours > 0);
    const empIds = pending.filter((r) => r.kind === "employee").map((r) => r.person_id);
    const covIds = pending.filter((r) => r.kind === "cover").map((r) => r.person_id);
    if (empIds.length === 0 && covIds.length === 0) return;
    setBusyDate(date);
    try {
      // Sequential, not parallel: two writes to the same day's rollup.
      if (empIds.length > 0) await onApproveDate(date, empIds);
      if (covIds.length > 0 && onCoverApproveDate) {
        await onCoverApproveDate(date, covIds);
      }
      const n = empIds.length + covIds.length;
      toast.success(`Approved ${n} ${n === 1 ? "person" : "people"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyDate(null);
    }
  }

  function Row({ s }: { s: ApprovalRow }) {
    const key = rowKey(s);
    const busy = busyKey === key;
    const store = showStore ? storeName(s.store_id) : null;
    const adjusted =
      s.approved &&
      s.approved_hours != null &&
      Math.abs(s.approved_hours - s.clocked_hours) > 0.01;

    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 py-3",
          s.approved && "opacity-75",
        )}
      >
        <div className="flex-1 min-w-[8rem]">
          <p className="font-medium truncate">
            {s.name}
            {s.kind === "cover" && (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-gold/40 bg-gold/10 text-gold font-medium"
                title="Cover driver — paid cash only, with no NI or bank split."
              >
                Cover
              </span>
            )}
            {s.auto_clocked_out && (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-warning/40 bg-warning/10 text-warning font-medium"
                title="No clock-out was recorded — the scheduled shift end was used. Check the hours before approving."
              >
                Auto out
              </span>
            )}
            {s.manual_entry && (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-warning/40 bg-warning/10 text-warning font-medium"
                title={
                  s.manual_entry_reason
                    ? `Times entered by a manager (no location check) — ${s.manual_entry_reason}`
                    : "Times entered by a manager — this day was not location-verified."
                }
              >
                Manual
              </span>
            )}
            {s.shifts.length > 1 && (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-border bg-surface-hover text-text-subtle font-medium"
                title={`Worked in ${s.shifts.length} separate shifts — ${s.shifts.join(", ")}`}
              >
                {s.shifts.length} shifts
              </span>
            )}
            {missingDeliveries(s) && (
              <span
                className="ml-2 align-middle text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-warning/40 bg-warning/10 text-warning font-medium"
                title="This driver recorded no deliveries for the day. If that's wrong, correct it before approving — deliveries are paid per drop."
              >
                No deliveries
              </span>
            )}
          </p>
          <p className="text-xs text-text-muted">
            {s.auto_clocked_out ? "Assumed" : "Clocked"} {s.clocked_hours.toFixed(2)}h
            {store && <> · {store}</>}
            {s.kind === "cover" && <> · cash</>}
          </p>
          {/* The total above is the SUM of these, never last-out minus
              first-in — the gap between shifts isn't worked time. */}
          {s.shifts.length > 1 && (
            <p className="text-[11px] text-text-subtle">{s.shifts.join(" · ")}</p>
          )}
        </div>

        {s.approved ? (
          <div className="flex items-center gap-2">
            <Badge variant="success">
              <CheckIcon size={12} />
              {(s.approved_hours ?? s.clocked_hours).toFixed(2)}h approved
            </Badge>
            {s.is_driver && (
              <span
                className="text-[11px] text-text-muted tabular-nums"
                title="Confirmed deliveries for this day — normal round, plus any extras."
              >
                {s.short_deliveries} SD · {s.long_deliveries} LD
                {(s.extra_short_deliveries > 0 || s.extra_long_deliveries > 0) && (
                  <>
                    {" "}
                    · {s.extra_short_deliveries} MS · {s.extra_long_deliveries} ML
                  </>
                )}
              </span>
            )}
            {adjusted && (
              <span
                className="text-[11px] text-warning"
                title={`Adjusted from clocked ${s.clocked_hours.toFixed(2)}h`}
              >
                adj
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => doUnapprove(s)}
              loading={busy}
              className="text-text-muted hover:text-danger"
            >
              Undo
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.01"
                min="0"
                value={edited[key] ?? s.clocked_hours.toFixed(2)}
                onChange={(e) =>
                  setEdited((p) => ({ ...p, [key]: e.target.value }))
                }
                aria-label={`Hours for ${s.name} on ${longDate(s.event_date)}`}
                className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30"
              />
              <span className="text-xs text-text-muted">h</span>
            </div>

            {/* Drivers only — everyone else is paid on hours alone, and empty
                delivery boxes on a kitchen shift are just noise. */}
            {s.is_driver && (
              <>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={editedDeliv[`${key}:short`] ?? String(s.short_deliveries)}
                    onChange={(e) =>
                      setEditedDeliv((p) => ({ ...p, [`${key}:short`]: e.target.value }))
                    }
                    aria-label={`Short deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    title="SD — short deliveries, the normal round"
                    className={cn(
                      "w-14 rounded-lg border bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30",
                      missingDeliveries(s) ? "border-warning/50" : "border-border",
                    )}
                  />
                  <span className="text-xs text-text-muted">sd</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={editedDeliv[`${key}:long`] ?? String(s.long_deliveries)}
                    onChange={(e) =>
                      setEditedDeliv((p) => ({ ...p, [`${key}:long`]: e.target.value }))
                    }
                    aria-label={`Long deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    title="LD — long deliveries, the normal round"
                    className={cn(
                      "w-14 rounded-lg border bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30",
                      missingDeliveries(s) ? "border-warning/50" : "border-border",
                    )}
                  />
                  <span className="text-xs text-text-muted">ld</span>
                </div>

                {/* Extras — beyond the normal round, paid at the same per-drop
                    rate. Raising either above zero requires a reason, exactly
                    like the Rota's delivery modal, so a reason box appears
                    inline the moment that becomes true rather than after the
                    server rejects the approval. */}
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={
                      editedDeliv[`${key}:extraShort`] ?? String(s.extra_short_deliveries)
                    }
                    onChange={(e) =>
                      setEditedDeliv((p) => ({
                        ...p,
                        [`${key}:extraShort`]: e.target.value,
                      }))
                    }
                    aria-label={`Extra short deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    title="MS — miscellaneous (extra) short deliveries, beyond the normal round"
                    className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30"
                  />
                  <span className="text-xs text-text-muted">ms</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={
                      editedDeliv[`${key}:extraLong`] ?? String(s.extra_long_deliveries)
                    }
                    onChange={(e) =>
                      setEditedDeliv((p) => ({
                        ...p,
                        [`${key}:extraLong`]: e.target.value,
                      }))
                    }
                    aria-label={`Extra long deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    title="ML — miscellaneous (extra) long deliveries, beyond the normal round"
                    className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30"
                  />
                  <span className="text-xs text-text-muted">ml</span>
                </div>

                {/* Two independent boxes, not one shared one — extra short and
                    extra long can each be raised with a DIFFERENT reason, and
                    a single box could only ever satisfy one of them, leaving
                    Approve stuck disabled if both were raised at once. */}
                {extraNeedsReason(s, "extraShort") && (
                  <input
                    type="text"
                    value={editedExtraReason[`${key}:extraShort`] ?? ""}
                    onChange={(e) =>
                      setEditedExtraReason((p) => ({
                        ...p,
                        [`${key}:extraShort`]: e.target.value,
                      }))
                    }
                    placeholder="Reason for extra SD"
                    aria-label={`Reason for extra short deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    className="w-36 rounded-lg border border-warning/50 bg-surface px-2 py-1 text-xs outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30"
                  />
                )}
                {extraNeedsReason(s, "extraLong") && (
                  <input
                    type="text"
                    value={editedExtraReason[`${key}:extraLong`] ?? ""}
                    onChange={(e) =>
                      setEditedExtraReason((p) => ({
                        ...p,
                        [`${key}:extraLong`]: e.target.value,
                      }))
                    }
                    placeholder="Reason for extra LD"
                    aria-label={`Reason for extra long deliveries for ${s.name} on ${longDate(s.event_date)}`}
                    className="w-36 rounded-lg border border-warning/50 bg-surface px-2 py-1 text-xs outline-none focus:border-gold/60 focus:ring-2 focus:ring-gold/30"
                  />
                )}
              </>
            )}

            <Button
              variant="primary"
              size="sm"
              onClick={() => doApprove(s)}
              loading={busy}
              disabled={
                !(effHours(s) > 0) ||
                (s.is_driver &&
                  (extraNeedsReason(s, "extraShort") || extraNeedsReason(s, "extraLong")))
              }
            >
              Approve
            </Button>
          </div>
        )}
      </div>
    );
  }

  const selRel = relLabel(selectedDate, todayISO);

  return (
    <div className="flex flex-col gap-5">
      {/* Controls */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-2">
          <DatePicker
            label="Approve day"
            value={selectedDate}
            onChange={(v) => setSelectedDate(v || todayISO)}
            max={todayISO}
            containerClassName="w-44"
          />
          <div className="flex items-center gap-1 pb-0.5">
            <Button
              variant="secondary"
              size="icon"
              onClick={() => shiftDay(-1)}
              aria-label="Previous day"
            >
              <ChevronLeftIcon size={16} />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => shiftDay(1)}
              disabled={selectedDate >= todayISO}
              aria-label="Next day"
            >
              <ChevronRightIcon size={16} />
            </Button>
            {selectedDate !== todayISO && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedDate(todayISO)}
              >
                Today
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 pb-2">
          <label className="flex items-center gap-2 text-sm text-text-subtle cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideApproved}
              onChange={(e) => setHideApproved(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-gold"
            />
            Hide approved
          </label>
          {manualCandidates.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddMissed("employee")}
              title="Record a shift an employee forgot to clock in for — including a second shift on a day they already worked"
            >
              Add missed entry
            </Button>
          )}
          {coverManualCandidates.length > 0 && onCoverApprove && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddMissed("cover_driver")}
              title="Record a day for a cover driver who forgot to clock in"
            >
              Add cover entry
            </Button>
          )}
        </div>
      </div>

      {/* Selected day */}
      <section className="rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              {selRel ? `${selRel} · ` : ""}
              {longDate(selectedDate)}
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              {selectedRows.length === 0 ? (
                "No one clocked in"
              ) : pendingCount === 0 ? (
                <span className="text-success">All {approvedCount} approved ✓</span>
              ) : (
                <>
                  {approvedCount} approved · {pendingCount} pending
                </>
              )}
            </p>
          </div>
          {pendingCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => doApproveDate(selectedDate, selectedRows)}
              loading={busyDate === selectedDate}
              iconLeft={<CheckIcon size={16} />}
            >
              Approve all {pendingCount}
            </Button>
          )}
        </div>

        {selectedRows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<ClockIcon />}
              title="No clocked hours"
              description="No completed clock-in/out sessions for this day. Try another date."
            />
          </div>
        ) : visibleSelected.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">
            All hours for this day are approved. Un-tick “Hide approved” to review them.
          </p>
        ) : (
          <div className="px-4 divide-y divide-border/60">
            {visibleSelected.map((s) => (
              <Row key={rowKey(s)} s={s} />
            ))}
          </div>
        )}
      </section>

      {/* Other dates still needing approval */}
      {otherPendingByDate.length > 0 && (
        <section className="rounded-xl border border-warning/30 bg-warning/5 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-warning">
            <AlertIcon size={16} />
            <p className="text-sm font-medium">
              {totalOtherPending} clocked day
              {totalOtherPending === 1 ? "" : "s"} on{" "}
              {otherPendingByDate.length} other date
              {otherPendingByDate.length === 1 ? "" : "s"} still need approval
            </p>
          </div>

          {otherPendingByDate.map(([date, rows]) => {
            const rel = relLabel(date, todayISO);
            return (
              <div
                key={date}
                className="rounded-lg border border-border bg-surface"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border">
                  <button
                    type="button"
                    onClick={() => setSelectedDate(date)}
                    className="text-sm font-medium text-text-primary hover:text-gold transition-colors"
                    title="Open this day"
                  >
                    {rel ? `${rel} · ` : ""}
                    {longDate(date)}{" "}
                    <span className="text-text-muted font-normal">
                      ({rows.length})
                    </span>
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => doApproveDate(date, rows)}
                    loading={busyDate === date}
                    iconLeft={<CheckIcon size={16} />}
                  >
                    Approve all {rows.length}
                  </Button>
                </div>
                <div className="px-3 divide-y divide-border/60">
                  {rows.map((s) => (
                    <Row key={rowKey(s)} s={s} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {showAddMissed && (
        <ManualClockEntryModal
          mode={showAddMissed}
          eventDate={selectedDate}
          candidates={
            showAddMissed === "cover_driver" ? coverManualCandidates : manualCandidates
          }
          requireClockOut
          title={
            showAddMissed === "cover_driver"
              ? "Add missed cover driver entry"
              : "Add missed entry"
          }
          onClose={() => setShowAddMissed(null)}
          onSaved={() => {
            setShowAddMissed(null);
            onManualSaved?.();
          }}
        />
      )}

      {/* How the daily total feeds payroll */}
      <p className="text-xs text-text-muted">
        Approving a day confirms its hours and rolls them into that employee’s
        weekly total. The <span className="font-medium text-text-primary">bank vs cash</span>{" "}
        split is worked out per week (first 20h = bank) — see the{" "}
        <span className="font-medium text-text-primary">Weekly Log</span> tab.{" "}
        <span className="font-medium text-text-primary">Cover</span> rows are cash
        only and are paid per approved day, with no weekly split.
      </p>
      <p className="text-xs text-text-muted">
        For drivers, <span className="font-medium text-text-primary">sd</span> /{" "}
        <span className="font-medium text-text-primary">ld</span> are the day’s
        short and long deliveries (the normal round), and{" "}
        <span className="font-medium text-text-primary">ms</span> /{" "}
        <span className="font-medium text-text-primary">ml</span> are
        miscellaneous — extra deliveries beyond it, paid at the same per-drop
        rate. Correcting any of these here{" "}
        <span className="font-medium text-text-primary">replaces</span> what the
        driver entered — the original is kept in the audit log, and the new
        figure flows straight to the Tuesday payout and the Rota. Raising ms or
        ml above zero asks for a reason, same as editing them from the Rota.{" "}
        <span className="font-medium text-text-primary">Approve all</span> signs
        off hours at their clocked value and leaves deliveries untouched.
      </p>
    </div>
  );
}
