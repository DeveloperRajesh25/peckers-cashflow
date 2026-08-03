"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { TrashIcon, ClockIcon, CheckIcon } from "@/components/ui/icons";
import {
  approveCoverDriverDay,
  deleteCoverDriverHours,
} from "@/app/actions/cover-drivers";
import { formatDDMMYYYY, formatGBP, formatHoursMins } from "@/lib/utils";
import { ManualClockEntryModal } from "@/components/clock/ManualClockEntryModal";
import type {
  CoverDriver,
  CoverDriverDaySummary,
  CoverDriverHoursComputed,
} from "@/lib/types";

// One row = one driver + one DAY. Employees are keyed by ISO week; a cover
// shift is a discrete ad-hoc engagement, so it is approved and paid per day.
//
// Compared to the employee table this deliberately drops "Entered hrs (by
// manager)" — cover drivers have no manual-entry path — and "Bank", since
// cover drivers are cash-only with no 20h NI threshold.
type MergedRow = {
  key: string;
  cover_driver_id: string;
  driver_name: string;
  store_id: string;
  work_date: string;
  clocked_hours: number;
  /** Present once a manager has approved the day. */
  approved: {
    id: string;
    hours: number;
    cash_amount: number;
    logged_at: string;
  } | null;
};

function buildRows(
  days: CoverDriverDaySummary[],
  approved: CoverDriverHoursComputed[],
): MergedRow[] {
  const map = new Map<string, MergedRow>();

  for (const d of days) {
    const key = `${d.cover_driver_id}:${d.work_date}`;
    map.set(key, {
      key,
      cover_driver_id: d.cover_driver_id,
      driver_name: d.driver_name,
      store_id: d.store_id,
      work_date: d.work_date,
      clocked_hours: d.total_hours,
      approved: null,
    });
  }

  for (const a of approved) {
    const key = `${a.cover_driver_id}:${a.work_date}`;
    const row = map.get(key);
    const approvedData = {
      id: a.id,
      hours: Number(a.total_hours_worked),
      cash_amount: Number(a.total_pay),
      logged_at: a.created_at,
    };
    if (row) {
      row.approved = approvedData;
    } else {
      // Approved but no clock event in range (e.g. a migrated legacy record).
      map.set(key, {
        key,
        cover_driver_id: a.cover_driver_id,
        driver_name: a.driver_name,
        store_id: a.store_id,
        work_date: a.work_date,
        clocked_hours: Number(a.total_hours_worked),
        approved: approvedData,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const d = b.work_date.localeCompare(a.work_date);
    return d !== 0 ? d : a.driver_name.localeCompare(b.driver_name);
  });
}

export function CoverDriverHoursTable({
  drivers,
  days,
  approvedRows,
  todayISO,
  onApproved,
  onDeleted,
  onManualSaved,
}: {
  drivers: CoverDriver[];
  days: CoverDriverDaySummary[];
  approvedRows: CoverDriverHoursComputed[];
  /** Server's "today", used as the default date for a missed entry. */
  todayISO?: string;
  onApproved: (fresh: CoverDriverHoursComputed[]) => void;
  onDeleted: (deletedId: string) => void;
  onManualSaved?: () => void;
}) {
  const toast = useToast();
  const [filterDriver, setFilterDriver] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [approvingKey, setApprovingKey] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [showAddMissed, setShowAddMissed] = React.useState(false);

  const allRows = React.useMemo(() => buildRows(days, approvedRows), [days, approvedRows]);

  const filtered = allRows.filter((r) => {
    if (filterDriver && r.cover_driver_id !== filterDriver) return false;
    if (from && r.work_date < from) return false;
    if (to && r.work_date > to) return false;
    return true;
  });

  const presentIds = new Set(allRows.map((r) => r.cover_driver_id));
  const filterableDrivers = drivers.filter((d) => presentIds.has(d.id));

  async function handleApprove(row: MergedRow) {
    setApprovingKey(row.key);
    try {
      const res = await approveCoverDriverDay({
        cover_driver_id: row.cover_driver_id,
        work_date: row.work_date,
      });
      toast.success("Cover shift approved");
      onApproved(res.hours);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setApprovingKey(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this approved cover shift? The clock record is kept.")) return;
    setDeletingId(id);
    try {
      await deleteCoverDriverHours(id);
      toast.success("Approval removed");
      onDeleted(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">
        <span className="font-medium text-text-primary">Clocked</span> = hours from that
        day&apos;s clock-in/out.{" "}
        <span className="font-medium text-text-primary">Approve</span> confirms the day for
        payment. Cover drivers are cash-only — every hour is cash, with no NI or bank split.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Select
          label="Cover driver"
          value={filterDriver}
          onChange={(e) => setFilterDriver(e.target.value)}
        >
          <option value="">All cover drivers</option>
          {filterableDrivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <DatePicker label="From" value={from} onChange={setFrom} />
        <DatePicker label="To" value={to} onChange={setTo} />
      </div>

      {drivers.filter((d) => d.is_active).length > 0 && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAddMissed(true)}
            title="Record a day for a cover driver who forgot to clock in"
          >
            Add missed entry
          </Button>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ClockIcon />}
          title="No cover hours recorded"
          description="Hours appear here once a cover driver clocks in and out."
        />
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border">
                <th className="px-3 py-2 font-medium">Driver</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium text-right">
                  Clocked hrs
                  <span className="block text-[10px] normal-case font-normal text-text-muted">
                    from clock-in/out
                  </span>
                </th>
                <th className="px-3 py-2 font-medium text-right">Cash hrs</th>
                <th className="px-3 py-2 font-medium text-right">Cash £</th>
                <th className="px-3 py-2 font-medium text-right">Logged</th>
                <th className="px-3 py-2 font-medium text-center">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                // Cash hours == clocked hours: there is no 20h bank threshold.
                const payHours = r.approved ? r.approved.hours : r.clocked_hours;
                return (
                  <tr
                    key={r.key}
                    className={`${i % 2 === 0 ? "" : "bg-bg/50"} border-t border-border/60`}
                  >
                    <td className="px-3 py-3 whitespace-nowrap font-medium">
                      {r.driver_name}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {formatDDMMYYYY(r.work_date)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatHoursMins(r.clocked_hours)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatHoursMins(payHours)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {r.approved ? (
                        <Badge variant="gold">{formatGBP(r.approved.cash_amount)}</Badge>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-text-muted whitespace-nowrap text-xs">
                      {r.approved ? formatDDMMYYYY(r.approved.logged_at) : "—"}
                    </td>
                    <td className="px-3 py-3 text-center whitespace-nowrap">
                      {r.approved ? (
                        <Badge variant="success">
                          <CheckIcon size={12} />
                          Approved
                        </Badge>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleApprove(r)}
                          loading={approvingKey === r.key}
                        >
                          Approve {formatHoursMins(r.clocked_hours)}h
                        </Button>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {r.approved ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(r.approved!.id)}
                          loading={deletingId === r.approved!.id}
                          aria-label="Remove approval"
                          className="text-text-muted hover:text-danger"
                        >
                          <TrashIcon size={16} />
                        </Button>
                      ) : (
                        <span className="inline-block w-10" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAddMissed && (
        <ManualClockEntryModal
          mode="cover_driver"
          eventDate={todayISO ?? new Date().toISOString().slice(0, 10)}
          candidates={drivers
            .filter((d) => d.is_active)
            .map((d) => ({ id: d.id, name: d.name }))}
          requireClockOut
          title="Add missed cover driver entry"
          onClose={() => setShowAddMissed(false)}
          onSaved={() => {
            setShowAddMissed(false);
            onManualSaved?.();
          }}
        />
      )}
    </div>
  );
}
