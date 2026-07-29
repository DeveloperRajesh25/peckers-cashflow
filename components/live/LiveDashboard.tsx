"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  WEEKDAY_LONG,
  clockedHours,
  formatDDMMYYYY,
  formatGBP,
  formatShiftRange,
  formatTimeOnly,
  shiftHours,
} from "@/lib/utils";
import type {
  AllowedUser,
  ClockEvent,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  Employee,
  EmployeeScheduleDay,
  LiveDashboardStatus,
  ManagerClockEvent,
  ManagerShift,
  RotaShift,
  Store,
} from "@/lib/types";
import { hasRole } from "@/lib/types";
import {
  coverDriverPay,
  resolveCoverDriverShift,
  totalDeliveries,
} from "@/lib/cover-driver-hours";

type Props = {
  stores: Store[];
  employees: Employee[];
  shifts: RotaShift[];
  clocks: ClockEvent[];
  /** Recurring weekly templates — used as the fallback "expected" shift when no
   *  rota row is published for today (so missed shifts still show). */
  schedules?: EmployeeScheduleDay[];
  /** Manager login accounts (allowed_users, role=manager) for attendance. */
  managers?: AllowedUser[];
  /** Today's manager clock rows, keyed on the login account. */
  managerClocks?: ManagerClockEvent[];
  /** Today's manager rota shifts — used to place a manager scheduled to cover
   *  another store under that store before they've clocked in. */
  managerShifts?: ManagerShift[];
  /** Cover drivers. The board's cover section is hidden entirely when a store
   *  has none — most stores only use them at weekends. */
  coverDrivers?: CoverDriver[];
  coverDriverClocks?: CoverDriverClockEvent[];
  coverDriverShifts?: CoverDriverShift[];
  coverDriverSchedules?: CoverDriverScheduleDay[];
  userRole: string;
  userStoreId: string | null;
};

/** Minimal shape the dashboard needs from a shift (real or template-derived). */
type EffShift = {
  is_day_off: boolean;
  start_time: string | null;
  end_time: string | null;
};

const STATUS_STYLES: Record<LiveDashboardStatus, { label: string; cls: string }> = {
  on_shift: { label: "On Shift", cls: "bg-success/15 text-success border-success/40" },
  expected: { label: "Expected", cls: "bg-warning/15 text-warning border-warning/40" },
  late: { label: "Late", cls: "bg-warning/30 text-warning border-warning/60" },
  clocked_out: {
    label: "Clocked Out",
    cls: "bg-surface-hover text-text-subtle border-border",
  },
  day_off: { label: "Day Off", cls: "bg-danger/10 text-danger border-danger/30" },
  tbc: { label: "TBC", cls: "bg-surface-hover text-text-muted border-border" },
  absent: { label: "Absent", cls: "bg-danger/20 text-danger border-danger/60" },
};

const ROW_BG: Record<LiveDashboardStatus, string> = {
  on_shift: "bg-success/5",
  expected: "bg-warning/5",
  late: "bg-warning/10",
  clocked_out: "",
  day_off: "bg-danger/5",
  tbc: "",
  absent: "bg-danger/10",
};

/**
 * Only the two timestamps are read, so this is typed structurally rather than
 * as ClockEvent — that lets cover_driver_clock_events reuse the exact same
 * late/absent thresholds instead of a second copy that could drift.
 */
type ClockLike = { clock_in_at: string | null; clock_out_at: string | null };

function computeStatus(
  shift: EffShift | null | undefined,
  clock: ClockLike | null | undefined,
  now: Date,
): LiveDashboardStatus {
  if (!shift) return "tbc";
  if (shift.is_day_off) return "day_off";
  if (clock?.clock_out_at) return "clocked_out";
  if (clock?.clock_in_at) return "on_shift";
  if (!shift.start_time) return "tbc";
  const [h, m] = shift.start_time.split(":").map(Number);
  const sched = new Date(now);
  sched.setHours(h, m, 0, 0);
  const diffMin = (now.getTime() - sched.getTime()) / 60000;
  if (diffMin > 60) return "absent";
  if (diffMin > 15) return "late";
  return "expected";
}

/** Gross hourly rate used to value a day's wage (on-the-books NI rate). */
function rateOf(emp: Employee): number {
  return Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0) || 0;
}

/** Attendance status for a manager from their clock row. */
type ManagerStatus = "on_shift" | "clocked_out" | "not_in";
function managerStatusOf(mc: ManagerClockEvent | null | undefined): ManagerStatus {
  if (mc?.clock_out_at) return "clocked_out";
  if (mc?.clock_in_at) return "on_shift";
  return "not_in";
}
const MANAGER_STATUS: Record<ManagerStatus, { label: string; cls: string }> = {
  on_shift: { label: "On Shift", cls: "bg-success/15 text-success border-success/40" },
  clocked_out: { label: "Clocked Out", cls: "bg-surface-hover text-text-subtle border-border" },
  not_in: { label: "Not clocked in", cls: "bg-warning/15 text-warning border-warning/40" },
};

export function LiveDashboard({
  stores,
  employees,
  shifts,
  clocks,
  schedules = [],
  managers = [],
  managerClocks = [],
  managerShifts = [],
  coverDrivers = [],
  coverDriverClocks = [],
  coverDriverShifts = [],
  coverDriverSchedules = [],
  userRole,
  userStoreId,
}: Props) {
  const router = useRouter();
  const [now, setNow] = React.useState<Date>(() => new Date());

  // Local clock ticks every 30s so the "updated HH:MM" label and time-based
  // statuses (late/absent) stay fresh without hitting the server.
  React.useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // Server data refresh runs every 30 seconds, and only while the tab is
  // visible — keeps the board "live" without hammering Supabase on idle tabs.
  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => router.refresh(), 30_000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [router]);

  const isSuperAdmin = userRole === "admin";

  const visibleStores = stores.filter((s) =>
    isSuperAdmin || !userStoreId ? true : s.id === userStoreId,
  );

  const shiftByEmp = new Map(shifts.map((s) => [s.employee_id, s]));
  const clockByEmp = new Map(clocks.map((c) => [c.employee_id, c]));
  const managerClockByMgr = new Map(managerClocks.map((mc) => [mc.manager_id, mc]));
  const managerShiftByMgr = new Map(managerShifts.map((s) => [s.manager_id, s]));

  const storeById = new Map(stores.map((s) => [s.id, s]));

  // Which store an employee belongs to TODAY: where they clocked in (the source
  // of truth for where they actually are), else where they're scheduled, else
  // their home store. Staff aren't locked to one store, so a visiting worker
  // shows under the store they actually worked at — not their home store.
  const todayStoreOf = (emp: Employee): string | null => {
    const c = clockByEmp.get(emp.id);
    if (c?.store_id) return c.store_id;
    const s = shiftByEmp.get(emp.id);
    if (s?.store_id) return s.store_id;
    return emp.store_id ?? null;
  };

  // Same rule for a manager: the store they clocked in at today (source of truth
  // for where they actually are), else where they're scheduled to cover, else
  // their home store. Lets a manager covering another store show under it.
  const managerTodayStoreOf = (m: AllowedUser): string | null => {
    const c = managerClockByMgr.get(m.id);
    if (c?.store_id) return c.store_id;
    const s = managerShiftByMgr.get(m.id);
    if (s?.store_id && !s.is_day_off) return s.store_id;
    return m.store_id ?? null;
  };
  const scheduleByEmpDay = new Map(
    schedules.map((s) => [`${s.employee_id}:${s.weekday}`, s]),
  );
  const todayWeekday = (now.getDay() + 6) % 7;

  const coverClockByDriver = new Map(
    coverDriverClocks.map((c) => [c.cover_driver_id, c]),
  );
  const coverShiftByDriver = new Map(
    coverDriverShifts.map((s) => [s.cover_driver_id, s]),
  );
  const coverScheduleByDriverDay = new Map(
    coverDriverSchedules.map((s) => [`${s.cover_driver_id}:${s.weekday}`, s]),
  );

  // Same "where are they actually today" rule as staff: the store they clocked
  // in at wins, then the rota cell, then their home store.
  const coverTodayStoreOf = (d: CoverDriver): string | null => {
    const c = coverClockByDriver.get(d.id);
    if (c?.store_id) return c.store_id;
    const s = coverShiftByDriver.get(d.id);
    if (s?.store_id && !s.is_day_off) return s.store_id;
    return d.store_id ?? null;
  };

  // Real published rota row for today, else the recurring template for today's
  // weekday — so an expected shift (and late/absent status) still shows even
  // when the manager hasn't published a rota.
  function effectiveShiftFor(
    empId: string,
  ): { shift: EffShift | null; fromTemplate: boolean } {
    const real = shiftByEmp.get(empId);
    if (real) return { shift: real, fromTemplate: false };
    const tmpl = scheduleByEmpDay.get(`${empId}:${todayWeekday}`);
    if (tmpl && tmpl.is_working && tmpl.start_time) {
      return {
        shift: {
          is_day_off: false,
          start_time: tmpl.start_time,
          end_time: tmpl.end_time,
        },
        fromTemplate: true,
      };
    }
    return { shift: null, fromTemplate: false };
  }

  const today = new Date();
  const weekday = WEEKDAY_LONG[(today.getDay() + 6) % 7];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <span>{weekday}, {formatDDMMYYYY(today)}</span>
        <span>·</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-success animate-pulse" />
          Live · updated {formatTimeOnly(now.toISOString())}
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {visibleStores.map((store) => {
          const storeEmployees = employees.filter(
            (e) => todayStoreOf(e) === store.id && e.employment_status === "active",
          );
          // This store's own staff who are working at ANOTHER store today, so the
          // store's manager can see where they've gone.
          const awayStaff = employees
            .filter(
              (e) =>
                e.store_id === store.id &&
                e.employment_status === "active" &&
                todayStoreOf(e) !== store.id,
            )
            .map((e) => ({ emp: e, at: storeById.get(todayStoreOf(e) ?? "") ?? null }))
            .sort((a, b) => a.emp.name.localeCompare(b.emp.name));
          // Sort: manager first, then on-shift, then others
          const sorted = [...storeEmployees].sort((a, b) => {
            const pa = a.position === "Manager" ? 0 : 1;
            const pb = b.position === "Manager" ? 0 : 1;
            return pa - pb || a.name.localeCompare(b.name);
          });

          // Managers are login accounts (allowed_users), not employees — pulled
          // from their own table with their own clock rows. A manager shows under
          // the store they're actually at today (clocked in / scheduled to
          // cover), so a visiting manager appears here, not at their home store.
          const storeManagers = managers.filter(
            (m) => managerTodayStoreOf(m) === store.id,
          );
          // This store's own managers covering ANOTHER store today.
          const awayManagers = managers
            .filter(
              (m) => m.store_id === store.id && managerTodayStoreOf(m) !== store.id,
            )
            .map((m) => ({ mgr: m, at: storeById.get(managerTodayStoreOf(m) ?? "") ?? null }))
            .sort((a, b) =>
              (a.mgr.name || a.mgr.username || "").localeCompare(
                b.mgr.name || b.mgr.username || "",
              ),
            );

          const onShiftCount = sorted.filter((e) => {
            const c = clockByEmp.get(e.id);
            return c?.clock_in_at && !c.clock_out_at;
          }).length;

          // Per-employee daily wage: expected (scheduled hours × rate) and
          // actual (hours clocked so far × rate). Drives the table columns and
          // the store totals below.
          const wageRows = sorted.map((emp) => {
            const { shift, fromTemplate } = effectiveShiftFor(emp.id);
            const realShift = shiftByEmp.get(emp.id);
            const clock = clockByEmp.get(emp.id);
            const status = computeStatus(shift, clock, now);
            const rate = rateOf(emp);
            const expHours =
              shift && !shift.is_day_off
                ? realShift && Number(realShift.scheduled_hours) > 0
                  ? Number(realShift.scheduled_hours)
                  : shiftHours(shift.start_time, shift.end_time)
                : 0;
            const actHours = clockedHours(clock?.clock_in_at, clock?.clock_out_at, now);
            return {
              emp,
              shift,
              fromTemplate,
              clock,
              status,
              expectedWage: expHours * rate,
              actualWage: actHours * rate,
            };
          });
          const expectedTotal = wageRows.reduce((s, r) => s + r.expectedWage, 0);
          const actualTotal = wageRows.reduce((s, r) => s + r.actualWage, 0);

          // Managers are on a fixed daily wage (not hourly), and it only
          // counts once they've actually clocked in — no clock-in, no wage.
          // So expected and actual are the same figure for managers.
          const managerExpectedTotal = storeManagers.reduce((s, m) => {
            const mc = managerClockByMgr.get(m.id);
            return s + (mc?.clock_in_at ? Number(m.fixed_daily_wage) || 0 : 0);
          }, 0);
          const managerActualTotal = managerExpectedTotal;

          // Cover drivers: only those actually attached to this store today.
          // A store with none renders no cover section at all — most stores
          // only use cover drivers at weekends, so an empty block every weekday
          // would be noise.
          const storeCoverRows = coverDrivers
            .filter((d) => d.is_active && coverTodayStoreOf(d) === store.id)
            .map((driver) => {
              const clock = coverClockByDriver.get(driver.id) ?? null;
              const shift = resolveCoverDriverShift(
                coverShiftByDriver.get(driver.id),
                coverScheduleByDriverDay.get(`${driver.id}:${todayWeekday}`),
              );
              const status = computeStatus(shift, clock, now);
              const rate = Number(driver.hourly_cash_rate) || 0;
              const expHours =
                shift && !shift.is_day_off
                  ? shift.scheduled_hours && shift.scheduled_hours > 0
                    ? shift.scheduled_hours
                    : shiftHours(shift.start_time, shift.end_time)
                  : 0;
              const actHours = clockedHours(clock?.clock_in_at, clock?.clock_out_at, now);
              const shortD = totalDeliveries(
                clock?.short_deliveries_count,
                clock?.extra_short_deliveries,
              );
              const longD = totalDeliveries(
                clock?.long_deliveries_count,
                clock?.extra_long_deliveries,
              );
              return {
                driver,
                shift,
                clock,
                status,
                deliveries: shortD + longD,
                // Expected pay values hours only — deliveries aren't known until
                // they're done, so counting them here would inflate the forecast.
                expectedWage: expHours * rate,
                actualWage: coverDriverPay({
                  hours: actHours,
                  hourlyRate: rate,
                  shortDeliveries: shortD,
                  longDeliveries: longD,
                  shortRate: driver.short_delivery_rate,
                  longRate: driver.long_delivery_rate,
                }),
              };
            })
            .sort((a, b) => a.driver.name.localeCompare(b.driver.name));

          const coverExpectedTotal = storeCoverRows.reduce(
            (s, r) => s + r.expectedWage,
            0,
          );
          const coverActualTotal = storeCoverRows.reduce((s, r) => s + r.actualWage, 0);
          const hasCover = storeCoverRows.length > 0;

          const expectedGrandTotal =
            expectedTotal + managerExpectedTotal + coverExpectedTotal;
          const actualGrandTotal = actualTotal + managerActualTotal + coverActualTotal;

          return (
            <Card key={store.id} className="p-0 overflow-hidden">
              <div className="px-5 pt-5 pb-3 border-b border-border">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="text-lg font-semibold tracking-wide">
                      {store.name}
                    </h2>
                    <p className="text-xs text-text-muted mt-1">
                      {sorted.length} scheduled · {onShiftCount} on shift now
                    </p>
                  </div>
                </div>

                {/* Manager attendance — clock in/out for monitoring (fixed salary) */}
                {storeManagers.length > 0 && (
                  <div className="mt-3 rounded-lg border border-border bg-surface-hover/50 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
                      Manager attendance
                    </div>
                    <div className="flex flex-col gap-2">
                      {storeManagers.map((m) => {
                        const mc = managerClockByMgr.get(m.id);
                        const status = managerStatusOf(mc);
                        const style = MANAGER_STATUS[status];
                        const worked = mc?.clock_in_at
                          ? clockedHours(mc.clock_in_at, mc.clock_out_at, now)
                          : 0;
                        return (
                          <div
                            key={m.id}
                            className="flex items-start justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-text-primary truncate">
                                {m.name || m.username}
                                {m.store_id !== store.id && (
                                  <span
                                    className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-gold/15 text-gold border border-gold/30 align-middle"
                                    title={`Covering — home store ${storeById.get(m.store_id ?? "")?.name ?? "elsewhere"}`}
                                  >
                                    visiting
                                  </span>
                                )}
                              </div>
                              {isSuperAdmin && m.fixed_daily_wage != null && (
                                <div className="text-[11px] text-text-muted">
                                  {formatGBP(m.fixed_daily_wage)} / day
                                </div>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <span
                                className={
                                  "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border " +
                                  style.cls
                                }
                              >
                                {style.label}
                              </span>
                              {mc?.clock_in_at && (
                                <div className="text-[11px] text-text-muted mt-0.5 tabular-nums">
                                  In {formatTimeOnly(mc.clock_in_at)}
                                  {mc.clock_out_at
                                    ? ` · Out ${formatTimeOnly(mc.clock_out_at)}`
                                    : ""}{" "}
                                  · {worked.toFixed(1)}h
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Daily wage summary — expected (from the schedule) vs actual (clocked so far) */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border bg-surface-hover px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-text-muted">
                      Expected wage today
                    </div>
                    <div className="text-base font-semibold tabular-nums text-text-primary">
                      {formatGBP(expectedGrandTotal)}
                    </div>
                    {isSuperAdmin && (storeManagers.length > 0 || hasCover) && (
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {formatGBP(expectedTotal)} staff + {formatGBP(managerExpectedTotal)} mgrs
                        {hasCover && <> + {formatGBP(coverExpectedTotal)} cover</>}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-surface-hover px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-text-muted">
                      Actual wage so far
                    </div>
                    <div className="text-base font-semibold tabular-nums text-gold">
                      {formatGBP(actualGrandTotal)}
                    </div>
                    {isSuperAdmin && (storeManagers.length > 0 || hasCover) && (
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {formatGBP(actualTotal)} staff + {formatGBP(managerActualTotal)} mgrs
                        {hasCover && <> + {formatGBP(coverActualTotal)} cover</>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Home staff & managers working at the other store today */}
                {(awayStaff.length > 0 || awayManagers.length > 0) && (
                  <div className="mt-3 rounded-lg border border-gold/30 bg-gold/5 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-gold/90 mb-1.5">
                      Working at another store today
                    </div>
                    <div className="flex flex-col gap-1">
                      {awayManagers.map(({ mgr, at }) => (
                        <div
                          key={mgr.id}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <span className="text-text-primary truncate">
                            {mgr.name || mgr.username}
                            <span className="ml-1 text-[10px] uppercase tracking-wide text-text-muted">
                              manager
                            </span>
                          </span>
                          <span className="text-gold text-xs shrink-0">
                            @ {at?.name ?? "another store"}
                          </span>
                        </div>
                      ))}
                      {awayStaff.map(({ emp, at }) => (
                        <div
                          key={emp.id}
                          className="flex items-center justify-between gap-2 text-sm"
                        >
                          <span className="text-text-primary truncate">{emp.name}</span>
                          <span className="text-gold text-xs shrink-0">
                            @ {at?.name ?? "another store"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead className="bg-surface-hover text-xs uppercase tracking-wider text-text-muted">
                    <tr>
                      <th className="text-left px-3 py-2">Employee</th>
                      <th className="text-left px-2 py-2">Role</th>
                      <th className="text-left px-2 py-2">Shift</th>
                      <th className="text-center px-2 py-2">In</th>
                      <th className="text-center px-2 py-2">Out</th>
                      <th className="text-center px-2 py-2">Status</th>
                      <th className="text-right px-2 py-2">Exp. £</th>
                      <th className="text-right px-2 py-2">Act. £</th>
                      <th className="text-center px-2 py-2">Deliv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 && (
                      <tr>
                        <td
                          colSpan={9}
                          className="px-4 py-8 text-center text-text-muted text-sm"
                        >
                          No staff scheduled today. <span className="text-warning">TBC</span>
                        </td>
                      </tr>
                    )}
                    {wageRows.map(({ emp, shift, fromTemplate, clock, status, expectedWage, actualWage }) => {
                      const style = STATUS_STYLES[status];
                      return (
                        <tr
                          key={emp.id}
                          className={
                            "border-t border-border " + (ROW_BG[status] ?? "")
                          }
                        >
                          <td className="px-3 py-2 font-medium text-text-primary">
                            {emp.name}
                          </td>
                          <td className="px-2 py-2 text-text-subtle">
                            {emp.position ?? "—"}
                          </td>
                          <td className="px-2 py-2 text-text-subtle">
                            {formatShiftRange(
                              shift?.is_day_off ?? false,
                              shift?.start_time ?? null,
                              shift?.end_time ?? null,
                            )}
                            {fromTemplate && shift && (
                              <span
                                className="ml-1 text-[9px] uppercase tracking-wide text-text-muted"
                                title="From the employee's recurring schedule (no rota published)"
                              >
                                default
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center text-xs">
                            {formatTimeOnly(clock?.clock_in_at)}
                          </td>
                          <td className="px-2 py-2 text-center text-xs">
                            {formatTimeOnly(clock?.clock_out_at)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <span
                              className={
                                "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border " +
                                style.cls
                              }
                            >
                              {style.label}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right text-xs tabular-nums text-text-subtle">
                            {expectedWage > 0 ? formatGBP(expectedWage) : "—"}
                          </td>
                          <td className="px-2 py-2 text-right text-xs tabular-nums text-text-primary">
                            {actualWage > 0 ? formatGBP(actualWage) : "—"}
                          </td>
                          <td className="px-2 py-2 text-center text-xs text-text-subtle">
                            {hasRole(emp.position, "Driver")
                              ? clock?.short_deliveries_count == null &&
                                clock?.long_deliveries_count == null
                                ? "—"
                                : (Number(clock?.short_deliveries_count) || 0) +
                                  (Number(clock?.long_deliveries_count) || 0)
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Cover drivers — rendered only when this store has any today.
                  Most stores use them at weekends only, so an empty block every
                  weekday would be noise. */}
              {hasCover && (
                <div className="border-t-2 border-gold/30">
                  <div className="px-3 py-2 bg-gold/5 text-[10px] uppercase tracking-wider text-gold/90">
                    Cover drivers · {storeCoverRows.length}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead className="bg-surface-hover text-xs uppercase tracking-wider text-text-muted">
                        <tr>
                          <th className="text-left px-3 py-2">Employee</th>
                          <th className="text-left px-2 py-2">Role</th>
                          <th className="text-left px-2 py-2">Shift</th>
                          <th className="text-center px-2 py-2">In</th>
                          <th className="text-center px-2 py-2">Out</th>
                          <th className="text-center px-2 py-2">Status</th>
                          <th className="text-right px-2 py-2">Exp. £</th>
                          <th className="text-right px-2 py-2">Act. £</th>
                          <th className="text-center px-2 py-2">Deliv.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {storeCoverRows.map(
                          ({ driver, shift, clock, status, deliveries, expectedWage, actualWage }) => {
                            const style = STATUS_STYLES[status];
                            return (
                              <tr
                                key={driver.id}
                                className={
                                  "border-t border-border " + (ROW_BG[status] ?? "")
                                }
                              >
                                <td className="px-3 py-2 font-medium text-text-primary">
                                  {driver.name}
                                </td>
                                <td className="px-2 py-2 text-text-subtle">Cover Driver</td>
                                <td className="px-2 py-2 text-text-subtle">
                                  {formatShiftRange(
                                    shift?.is_day_off ?? false,
                                    shift?.start_time ?? null,
                                    shift?.end_time ?? null,
                                  )}
                                  {shift?.fromTemplate && (
                                    <span
                                      className="ml-1 text-[9px] uppercase tracking-wide text-text-muted"
                                      title="From the driver's usual weekly availability (no shift set for today)"
                                    >
                                      usual
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-2 text-center text-xs">
                                  {formatTimeOnly(clock?.clock_in_at)}
                                </td>
                                <td className="px-2 py-2 text-center text-xs">
                                  {formatTimeOnly(clock?.clock_out_at)}
                                </td>
                                <td className="px-2 py-2 text-center">
                                  <span
                                    className={
                                      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border " +
                                      style.cls
                                    }
                                  >
                                    {style.label}
                                  </span>
                                </td>
                                <td className="px-2 py-2 text-right text-xs tabular-nums text-text-subtle">
                                  {expectedWage > 0 ? formatGBP(expectedWage) : "—"}
                                </td>
                                <td className="px-2 py-2 text-right text-xs tabular-nums text-text-primary">
                                  {actualWage > 0 ? formatGBP(actualWage) : "—"}
                                </td>
                                <td className="px-2 py-2 text-center text-xs text-text-subtle">
                                  {clock?.short_deliveries_count == null &&
                                  clock?.long_deliveries_count == null
                                    ? "—"
                                    : deliveries}
                                </td>
                              </tr>
                            );
                          },
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="text-xs text-text-muted">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-text-subtle font-medium">Status key:</span>
          {(["on_shift", "expected", "late", "clocked_out", "day_off", "absent", "tbc"] as LiveDashboardStatus[]).map(
            (s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className={
                    "inline-block h-3 w-3 rounded-sm border " + STATUS_STYLES[s].cls
                  }
                />
                {STATUS_STYLES[s].label}
              </span>
            ),
          )}
        </div>
      </Card>
    </div>
  );
}
