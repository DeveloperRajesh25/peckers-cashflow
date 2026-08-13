"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { TrashIcon, ClockIcon, CheckIcon } from "@/components/ui/icons";
import { deleteEmployeeHours, approveClockedHours } from "@/app/actions/employees";
import type {
  ClockWeeklySummary,
  EmployeeHoursComputed,
  EmployeeHoursSource,
  EmployeeSummary,
} from "@/lib/types";
import {
  cn,
  formatDDMMYYYY,
  formatHoursMins,
  formatHoursMinsWords,
  formatINR,
  parseHoursMinsInput,
} from "@/lib/utils";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { HoursMinsInput } from "@/components/ui/HoursMinsInput";

// One row = one employee + one week.
// Shows both the manager-entered value AND the clock-event total side-by-side.
type MergedRow = {
  key: string;
  employee_id: string;
  employee_name: string;
  week_start_date: string;
  // Manager manually entered hours (employee_hours table)
  manual: {
    id: string;
    total_hours: number;
    bank_hours: number;
    cash_hours: number;
    cash_amount: number;
    logged_at: string;
    approved: boolean;
    source: EmployeeHoursSource;
  } | null;
  // Weekly total from clock-in/out events (sum of all sessions that week)
  clocked: {
    total_hours: number;
    session_count: number;
  } | null;
};

/** Merge manual rows and clock summaries so each (employee, week) shows once. */
function buildMergedRows(
  manual: EmployeeHoursComputed[],
  clocked: ClockWeeklySummary[],
): MergedRow[] {
  const map = new Map<string, MergedRow>();

  for (const r of manual) {
    const key = `${r.employee_id}:${r.week_start_date}`;
    map.set(key, {
      key,
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      week_start_date: r.week_start_date,
      manual: {
        id: r.id,
        total_hours: Number(r.total_hours_worked),
        bank_hours: Number(r.bank_hours),
        cash_hours: Number(r.cash_hours),
        cash_amount: Number(r.cash_amount_due),
        logged_at: r.created_at,
        approved: !!r.approved,
        source: r.source,
      },
      clocked: null,
    });
  }

  for (const cs of clocked) {
    const key = `${cs.employee_id}:${cs.week_start_date}`;
    const existing = map.get(key);
    const clockedData = {
      total_hours: cs.total_hours,
      session_count: cs.event_count,
    };
    if (existing) {
      existing.clocked = clockedData;
    } else {
      // Clock-only week: compute bank/cash from clocked hours + employee rate
      const bankH = Math.min(cs.total_hours, 20);
      const cashH = Math.max(cs.total_hours - 20, 0);
      const niRate = Number(cs.hourly_ni_rate ?? cs.hourly_rate ?? 0);
      map.set(key, {
        key,
        employee_id: cs.employee_id,
        employee_name: cs.employee_name,
        week_start_date: cs.week_start_date,
        manual: null,
        clocked: clockedData,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const d = b.week_start_date.localeCompare(a.week_start_date);
    return d !== 0 ? d : a.employee_name.localeCompare(b.employee_name);
  });
}

export function HoursTable({
  employees,
  rows,
  clockSummaries = [],
  onDeleted,
  onApproved,
  hideApprove = false,
}: {
  employees: EmployeeSummary[];
  rows: EmployeeHoursComputed[];
  clockSummaries?: ClockWeeklySummary[];
  onDeleted: (deletedId: string) => void;
  onApproved?: (freshHours: EmployeeHoursComputed[]) => void;
  /**
   * Weekly-log mode: hide the per-week Approve control (approval now happens
   * day-by-day in the Daily Approval tab) and show a Pending badge instead.
   */
  hideApprove?: boolean;
}) {
  const toast = useToast();
  const [filterEmp, setFilterEmp] = React.useState<string>("");
  const [from, setFrom] = React.useState<string>("");
  const [to, setTo] = React.useState<string>("");
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [approvingKey, setApprovingKey] = React.useState<string | null>(null);
  // Manager-edited hours per row, keyed by row key, staged before approval.
  const [editedHours, setEditedHours] = React.useState<Record<string, string>>({});

  async function handleApprove(
    employee_id: string,
    week_start_date: string,
    key: string,
    overrideHours?: number,
  ) {
    setApprovingKey(key);
    try {
      const res = await approveClockedHours({
        employee_id,
        week_start_date,
        override_hours: overrideHours,
      });
      toast.success("Clocked hours approved");
      onApproved?.(res.hours);
      setEditedHours((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setApprovingKey(null);
    }
  }

  const allMerged = React.useMemo(
    () => buildMergedRows(rows, clockSummaries),
    [rows, clockSummaries],
  );

  const filtered = allMerged.filter((r) => {
    if (filterEmp && r.employee_id !== filterEmp) return false;
    if (from && r.week_start_date < from) return false;
    if (to && r.week_start_date > to) return false;
    return true;
  });

  async function handleDelete(id: string) {
    if (!confirm("Delete this manually-logged hours entry?")) return;
    setDeletingId(id);
    try {
      await deleteEmployeeHours(id);
      toast.success("Entry deleted");
      onDeleted(id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setDeletingId(null);
    }
  }

  // All employee IDs that appear in either source
  const presentIds = new Set([
    ...rows.map((r) => r.employee_id),
    ...clockSummaries.map((c) => c.employee_id),
  ]);
  const filterableEmployees = employees.filter((e) => presentIds.has(e.id));

  return (
    <div className="flex flex-col gap-4">
      {/* Legend */}
      <p className="text-xs text-text-muted">
        <span className="font-medium text-text-primary">Clocked</span> = sum of all daily clock-in/out sessions for that week.{" "}
        <span className="font-medium text-text-primary">Entered</span> = the approved weekly total (rolled up from daily approvals, or an admin manual correction).
        {hideApprove && (
          <> Approve hours day-by-day in the <span className="font-medium text-text-primary">Daily Approval</span> tab.</>
        )}
      </p>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Select
          label="Employee"
          value={filterEmp}
          onChange={(e) => setFilterEmp(e.target.value)}
        >
          <option value="">All employees</option>
          {filterableEmployees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <DatePicker
          label="From"
          value={from}
          onChange={setFrom}
        />
        <DatePicker
          label="To"
          value={to}
          onChange={setTo}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ClockIcon />}
          title="No hours recorded"
          description="Hours appear here when a manager logs them manually, or when staff clock in and out."
        />
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border">
                <th className="px-3 py-2 font-medium">Employee</th>
                <th className="px-3 py-2 font-medium">Week of</th>
                <th className="px-3 py-2 font-medium text-right">
                  Entered hrs
                  <span className="block text-[10px] normal-case font-normal text-text-muted">by manager</span>
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  Clocked hrs
                  <span className="block text-[10px] normal-case font-normal text-text-muted">from clock-in/out</span>
                </th>
                <th className="px-3 py-2 font-medium text-right">Bank</th>
                <th className="px-3 py-2 font-medium text-right">Cash hrs</th>
                <th className="px-3 py-2 font-medium text-right">Cash £</th>
                <th className="px-3 py-2 font-medium text-right">Logged</th>
                <th className="px-3 py-2 font-medium text-center">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                // For payroll: use manually-entered hours if the manager set them,
                // otherwise fall back to clocked total.
                const payrollHours = r.manual
                  ? r.manual.total_hours
                  : (r.clocked?.total_hours ?? 0);
                const bankH = r.manual
                  ? r.manual.bank_hours
                  : Math.min(payrollHours, 20);
                const cashH = r.manual
                  ? r.manual.cash_hours
                  : Math.max(payrollHours - 20, 0);
                const cashAmt = r.manual ? r.manual.cash_amount : 0;

                // Flag discrepancy: both exist and differ by more than 0.25h
                const bothExist = r.manual !== null && r.clocked !== null;
                const discrepancy =
                  bothExist &&
                  Math.abs(r.manual!.total_hours - r.clocked!.total_hours) > 0.25;

                // Clocked hours awaiting approval can be adjusted by a manager/admin.
                const isPendingApproval = r.clocked !== null && !r.manual?.approved;
                const rawEdit = editedHours[r.key];
                // Typed as H.MM (minutes, not a decimal fraction) — see
                // parseHoursMinsInput. Invalid input (e.g. minutes > 59) falls
                // back to the clocked total, same as an unparseable value did
                // before.
                const parsedEdit = rawEdit !== undefined ? parseHoursMinsInput(rawEdit) : null;
                const invalidEdit =
                  rawEdit !== undefined && rawEdit.trim() !== "" && parsedEdit === null;
                const effectiveHours =
                  rawEdit !== undefined && parsedEdit !== null && parsedEdit > 0
                    ? parsedEdit
                    : (r.clocked?.total_hours ?? 0);

                return (
                  <tr
                    key={r.key}
                    className={`${i % 2 === 0 ? "" : "bg-bg/50"} border-t border-border/60`}
                  >
                    <td className="px-3 py-3 whitespace-nowrap font-medium">
                      {r.employee_name}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {formatDDMMYYYY(r.week_start_date)}
                    </td>

                    {/* Manager-entered hours */}
                    <td className="px-3 py-3 text-right tabular-nums">
                      {r.manual ? (
                        <span className="font-medium">
                          <HoursMinsDisplay hours={r.manual.total_hours} />
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>

                    {/* Clock-event weekly total */}
                    <td className="px-3 py-3 text-right tabular-nums">
                      {r.clocked && isPendingApproval && !hideApprove ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <div className="flex items-center gap-1">
                            <HoursMinsInput
                              value={rawEdit ?? formatHoursMins(r.clocked.total_hours)}
                              onChange={(next) =>
                                setEditedHours((prev) => ({ ...prev, [r.key]: next }))
                              }
                              invalid={invalidEdit}
                              hourAriaLabel={`Hours for ${r.employee_name}, week of ${formatDDMMYYYY(r.week_start_date)}`}
                              minAriaLabel={`Minutes for ${r.employee_name}, week of ${formatDDMMYYYY(r.week_start_date)}`}
                            />
                            <span
                              className="text-[10px] text-text-muted"
                              title={`${r.clocked.session_count} clock session${r.clocked.session_count === 1 ? "" : "s"} this week`}
                            >
                              ×{r.clocked.session_count}d
                            </span>
                            {discrepancy && (
                              <span
                                className="text-warning text-[10px]"
                                title="Entered and clocked hours differ by more than 15 min"
                              >
                                ⚠
                              </span>
                            )}
                          </div>
                          {invalidEdit && (
                            <span className="text-[10px] text-danger">Invalid — minutes above 59</span>
                          )}
                        </div>
                      ) : r.clocked ? (
                        <span
                          className={discrepancy ? "text-warning" : ""}
                          title={`${r.clocked.session_count} clock session${r.clocked.session_count === 1 ? "" : "s"} this week`}
                        >
                          <HoursMinsDisplay hours={r.clocked.total_hours} />
                          <span className="ml-1 text-[10px] text-text-muted">
                            ×{r.clocked.session_count}d
                          </span>
                          {discrepancy && (
                            <span
                              className="ml-1 text-warning text-[10px]"
                              title="Entered and clocked hours differ by more than 15 min"
                            >
                              ⚠
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums">
                      <HoursMinsDisplay hours={bankH} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <HoursMinsDisplay hours={cashH} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {cashAmt > 0 ? (
                        <Badge variant="gold">{formatINR(cashAmt)}</Badge>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-text-muted whitespace-nowrap text-xs">
                      {r.manual?.logged_at
                        ? formatDDMMYYYY(r.manual.logged_at)
                        : <span className="text-text-muted">—</span>}
                    </td>

                    {/* Approval status */}
                    <td className="px-3 py-3 text-center whitespace-nowrap">
                      {r.manual?.approved ? (
                        <Badge variant="success">
                          <CheckIcon size={12} />
                          {r.manual.source === "clocked" ? "Approved" : "Logged"}
                        </Badge>
                      ) : r.clocked && hideApprove ? (
                        <Badge
                          variant="warning"
                          className="whitespace-nowrap"
                        >
                          Pending — approve daily
                        </Badge>
                      ) : r.clocked ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() =>
                            handleApprove(r.employee_id, r.week_start_date, r.key, effectiveHours)
                          }
                          loading={approvingKey === r.key}
                          disabled={!(effectiveHours > 0)}
                        >
                          Approve {formatHoursMinsWords(effectiveHours)}
                        </Button>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right">
                      {r.manual ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(r.manual!.id)}
                          loading={deletingId === r.manual!.id}
                          aria-label="Delete manual entry"
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

          {/* Legend for "×Nd" notation */}
          <p className="mt-2 px-3 text-[11px] text-text-muted">
            ×Nd = clocked across N sessions this week
            {filtered.some((r) => r.manual !== null && r.clocked !== null) && (
              <> · <span className="text-warning">⚠ orange</span> = entered and clocked hours differ by more than 15 min</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
