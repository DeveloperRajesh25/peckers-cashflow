"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { ShiftEditModal } from "./ShiftEditModal";
import { DeliveryEditModal } from "./DeliveryEditModal";
import { ManagerShiftEditModal } from "./ManagerShiftEditModal";
import { CoverDriverShiftEditModal } from "./CoverDriverShiftEditModal";
import { resolveCoverDriverShift, weekdayOf } from "@/lib/cover-driver-hours";
import {
  WEEKDAY_SHORT,
  addDays,
  eachDay,
  formatGBP,
  formatHoursMinsWords,
  formatShiftRange,
  parseISODate,
  startOfISOWeek,
  toISODate,
  todayISO,
  weekdayIndex,
} from "@/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, InfoIcon } from "@/components/ui/icons";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { applyScheduleToWeek } from "@/app/actions/schedule";
import { worksForCash } from "@/lib/cash-flow";
import { wageComplianceForEmployee } from "@/lib/compliance";
import { DEFAULT_SETTINGS, type MinWageBands, type ShiftTimeSettings } from "@/lib/settings";
import type {
  AllowedUser,
  ClockEvent,
  EmployeeScheduleDay,
  RotaEmployee,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  ManagerClockEvent,
  ManagerShift,
  RotaHistoryShift,
  RotaShift,
  ShiftPreset,
  Store,
  WeeklyDelivery,
} from "@/lib/types";
import { hasRole } from "@/lib/types";

/** Short label for a rota preset, shown under the time in a filled cell. */
function presetShort(t: ShiftPreset | null): string | null {
  if (t === "open_close") return "Open–Close";
  if (t === "evening_close") return "Eve–Close";
  return null;
}

type Props = {
  stores: Store[];
  employees: RotaEmployee[];
  /** Bookings inside the visible range only. */
  shifts: RotaShift[];
  /** The 4 weeks before the range, for the rolling average — never rendered. */
  historyShifts?: RotaHistoryShift[];
  clocks: ClockEvent[];
  weeklyDeliveries: WeeklyDelivery[];
  schedules?: EmployeeScheduleDay[];
  /** Manager rota section shown above the employee rota (admin Rota page only). */
  managers?: AllowedUser[];
  managerShifts?: ManagerShift[];
  managerClocks?: ManagerClockEvent[];
  /** Cover driver rota, shown below the employee rota. Hidden entirely when the
   *  store has no cover drivers; cells stay blank on days they aren't booked,
   *  which is most weekdays. */
  coverDrivers?: CoverDriver[];
  coverDriverShifts?: CoverDriverShift[];
  coverDriverSchedules?: CoverDriverScheduleDay[];
  coverDriverClocks?: CoverDriverClockEvent[];
  minWageBands?: MinWageBands;
  shiftTimes?: ShiftTimeSettings;
  rangeStartIso: string;
  rangeEndIso: string;
  userRole: string;
  userStoreId: string | null;
};

export function RotaView({
  stores,
  employees,
  shifts,
  historyShifts = [],
  clocks,
  weeklyDeliveries,
  schedules = [],
  managers = [],
  managerShifts = [],
  managerClocks = [],
  coverDrivers = [],
  coverDriverShifts = [],
  coverDriverSchedules = [],
  coverDriverClocks = [],
  minWageBands = DEFAULT_SETTINGS.min_wage_bands,
  shiftTimes = DEFAULT_SETTINGS.shift_times,
  rangeStartIso,
  rangeEndIso,
  userRole,
  userStoreId,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const rangeStart = React.useMemo(() => parseISODate(rangeStartIso), [rangeStartIso]);
  const rangeEnd = React.useMemo(() => parseISODate(rangeEndIso), [rangeEndIso]);
  // ISO week anchoring the range start — used for weekly deliveries & "apply
  // defaults", both of which remain week-based concepts.
  const weekStart = React.useMemo(() => startOfISOWeek(rangeStart), [rangeStart]);
  const [applying, setApplying] = React.useState(false);
  const [activeStoreId, setActiveStoreId] = React.useState<string>(
    userStoreId && stores.some((s) => s.id === userStoreId)
      ? userStoreId
      : stores[0]?.id ?? "",
  );
  // Employees the user has pulled onto this store's rota from another store
  // (before their first shift is saved). Cleared when the active store changes.
  const [addedVisitorIds, setAddedVisitorIds] = React.useState<string[]>([]);
  React.useEffect(() => setAddedVisitorIds([]), [activeStoreId]);
  // Same idea for managers: other-store managers pulled onto this store's
  // manager rota before their first cover shift is saved.
  const [addedManagerVisitorIds, setAddedManagerVisitorIds] = React.useState<string[]>([]);
  React.useEffect(() => setAddedManagerVisitorIds([]), [activeStoreId]);
  const [editingShift, setEditingShift] = React.useState<{
    employee: RotaEmployee;
    date: string;
    existing: RotaShift | null;
    prefill: { start: string; end: string } | null;
    /** Every shift already booked for this employee+date at this store — lets
     *  the modal show them and offer "add another" alongside editing `existing`. */
    dayShifts: RotaShift[];
  } | null>(null);
  const [editingDelivery, setEditingDelivery] = React.useState<{
    driver: RotaEmployee;
    existing: WeeklyDelivery | null;
    weekDays: string[];
    events: ClockEvent[];
  } | null>(null);
  const [editingCoverShift, setEditingCoverShift] = React.useState<{
    driver: CoverDriver;
    date: string;
    existing: CoverDriverShift | null;
    prefill: { start: string; end: string } | null;
  } | null>(null);
  const [editingManagerShift, setEditingManagerShift] = React.useState<{
    manager: AllowedUser;
    date: string;
    existing: ManagerShift | null;
    prefill: { start: string; end: string } | null;
  } | null>(null);

  const isSuperAdmin = userRole === "admin";
  const activeStore = stores.find((s) => s.id === activeStoreId);
  // Every day in the selected range (kept as `weekDays` for the rest of the
  // component, but it can now span any number of days).
  const weekDays = React.useMemo(
    () => eachDay(rangeStart, rangeEnd),
    [rangeStart, rangeEnd],
  );
  const rangeDayCount = weekDays.length;

  const storeById = React.useMemo(() => new Map(stores.map((s) => [s.id, s])), [stores]);

  const visibleDates = React.useMemo(
    () => new Set(weekDays.map((d) => toISODate(d))),
    [weekDays],
  );

  // Employees who have a shift AT the active store within the visible range —
  // i.e. staff visiting from the other store to cover here.
  const visitorIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of shifts) {
      if (s.store_id === activeStoreId && visibleDates.has(s.shift_date)) {
        set.add(s.employee_id);
      }
    }
    return set;
  }, [shifts, activeStoreId, visibleDates]);

  // Rows shown on this store's rota: the store's own active staff, anyone with a
  // shift here in range (a visitor), and anyone just picked from another store.
  // Home staff sort first, then visitors, each alphabetical.
  const rotaEmployees = React.useMemo(() => {
    return employees
      .filter(
        (e) =>
          e.employment_status === "active" &&
          (e.store_id === activeStoreId ||
            visitorIds.has(e.id) ||
            addedVisitorIds.includes(e.id)),
      )
      .sort((a, b) => {
        const av = a.store_id === activeStoreId ? 0 : 1;
        const bv = b.store_id === activeStoreId ? 0 : 1;
        return av - bv || a.name.localeCompare(b.name);
      });
  }, [employees, activeStoreId, visitorIds, addedVisitorIds]);

  // Other-store staff not already on the grid — the pool for "add visiting staff".
  const eligibleVisitors = React.useMemo(
    () =>
      employees
        .filter(
          (e) =>
            e.employment_status === "active" &&
            e.store_id !== activeStoreId &&
            !visitorIds.has(e.id) &&
            !addedVisitorIds.includes(e.id),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, activeStoreId, visitorIds, addedVisitorIds],
  );

  // Index shifts: key = `${employee_id}:${shift_date}`. A day can hold several
  // shifts now (split days), so every date buckets to a LIST, not one cell.
  const shiftByKey = React.useMemo(() => {
    const m = new Map<string, RotaShift[]>();
    for (const s of shifts) {
      const key = `${s.employee_id}:${s.shift_date}`;
      const arr = m.get(key) ?? [];
      arr.push(s);
      m.set(key, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
    }
    return m;
  }, [shifts]);

  // Clocks indexed by employee+date
  const clockByKey = React.useMemo(() => {
    const m = new Map<string, ClockEvent>();
    for (const c of clocks) m.set(`${c.employee_id}:${c.event_date}`, c);
    return m;
  }, [clocks]);

  // Managers who have a cover shift AT the active store within the visible range
  // — i.e. a manager visiting from the other store to cover here.
  const managerVisitorIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of managerShifts) {
      if (s.store_id === activeStoreId && visibleDates.has(s.shift_date)) {
        set.add(s.manager_id);
      }
    }
    return set;
  }, [managerShifts, activeStoreId, visibleDates]);

  // Managers shown above the employee rota: this store's own managers, anyone
  // covering here in range (a visitor), and anyone just picked from another
  // store. Home managers sort first, then visitors, each alphabetical.
  const activeManagers = React.useMemo(
    () =>
      managers
        .filter(
          (m) =>
            m.store_id === activeStoreId ||
            managerVisitorIds.has(m.id) ||
            addedManagerVisitorIds.includes(m.id),
        )
        .sort((a, b) => {
          const av = a.store_id === activeStoreId ? 0 : 1;
          const bv = b.store_id === activeStoreId ? 0 : 1;
          return (
            av - bv ||
            (a.name || a.username || "").localeCompare(b.name || b.username || "")
          );
        }),
    [managers, activeStoreId, managerVisitorIds, addedManagerVisitorIds],
  );

  // Other-store managers not already on the grid — the pool for "add a
  // visiting manager".
  const eligibleManagerVisitors = React.useMemo(
    () =>
      managers
        .filter(
          (m) =>
            m.store_id !== activeStoreId &&
            !managerVisitorIds.has(m.id) &&
            !addedManagerVisitorIds.includes(m.id),
        )
        .sort((a, b) =>
          (a.name || a.username || "").localeCompare(b.name || b.username || ""),
        ),
    [managers, activeStoreId, managerVisitorIds, addedManagerVisitorIds],
  );

  const managerVisitingCount = activeManagers.filter(
    (m) => m.store_id !== activeStoreId,
  ).length;

  // Manager shifts indexed by manager+date
  const managerShiftByKey = React.useMemo(() => {
    const m = new Map<string, ManagerShift>();
    for (const s of managerShifts) m.set(`${s.manager_id}:${s.shift_date}`, s);
    return m;
  }, [managerShifts]);

  // Manager clocks indexed by manager+date
  const managerClockByKey = React.useMemo(() => {
    const m = new Map<string, ManagerClockEvent>();
    for (const c of managerClocks) m.set(`${c.manager_id}:${c.event_date}`, c);
    return m;
  }, [managerClocks]);

  // ---- Cover drivers ----
  // Unlike staff and managers, cover drivers belong to one store and aren't
  // loaned out, so there's no "visiting" case to resolve here.
  const activeCoverDrivers = React.useMemo(
    () =>
      coverDrivers
        .filter((d) => d.is_active && d.store_id === activeStoreId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [coverDrivers, activeStoreId],
  );

  const coverShiftByKey = React.useMemo(() => {
    const m = new Map<string, CoverDriverShift>();
    for (const s of coverDriverShifts) m.set(`${s.cover_driver_id}:${s.shift_date}`, s);
    return m;
  }, [coverDriverShifts]);

  const coverScheduleByKey = React.useMemo(() => {
    const m = new Map<string, CoverDriverScheduleDay>();
    for (const s of coverDriverSchedules) m.set(`${s.cover_driver_id}:${s.weekday}`, s);
    return m;
  }, [coverDriverSchedules]);

  const coverClockByKey = React.useMemo(() => {
    const m = new Map<string, CoverDriverClockEvent>();
    for (const c of coverDriverClocks) m.set(`${c.cover_driver_id}:${c.event_date}`, c);
    return m;
  }, [coverDriverClocks]);

  // Booked hours across the visible range. Counts only saved rota cells — the
  // weekly availability pattern is a hint, not a booking, so it must not inflate
  // the total or the expected wage.
  function rangeCoverTotalHours(driverId: string): number {
    return weekDays.reduce((sum, d) => {
      const cell = coverShiftByKey.get(`${driverId}:${toISODate(d)}`);
      if (!cell || cell.is_day_off) return sum;
      return sum + (Number(cell.scheduled_hours) || 0);
    }, 0);
  }

  // Deliveries logged at clock-out, summed per cover driver for the shown range.
  // Read-only: cover drivers have no 4-week average or Vita Mojo cross-check —
  // weekly_deliveries is keyed to `employees`, and they are ad-hoc anyway, so
  // there is no baseline to average against.
  const coverDeliveriesByDriver = React.useMemo(() => {
    const weekSet = new Set(weekDays.map((d) => toISODate(d)));
    const live = new Map<string, number>();
    const extra = new Map<string, number>();
    for (const c of coverDriverClocks) {
      if (!weekSet.has(c.event_date)) continue;
      if (c.short_deliveries_count != null || c.long_deliveries_count != null) {
        const total =
          (Number(c.short_deliveries_count) || 0) + (Number(c.long_deliveries_count) || 0);
        live.set(c.cover_driver_id, (live.get(c.cover_driver_id) ?? 0) + total);
      }
      const ex =
        (Number(c.extra_short_deliveries) || 0) + (Number(c.extra_long_deliveries) || 0);
      if (ex) extra.set(c.cover_driver_id, (extra.get(c.cover_driver_id) ?? 0) + ex);
    }
    return { live, extra };
  }, [coverDriverClocks, weekDays]);

  // Drops a manager covered in the shown range, at THIS store. Managers aren't
  // hourly, so the manager rota has no wage column — but these are paid per
  // drop, so the count belongs on the row that shows what they worked.
  const managerDeliveriesByMgr = React.useMemo(() => {
    const weekSet = new Set(weekDays.map((d) => toISODate(d)));
    const live = new Map<string, number>();
    const extra = new Map<string, number>();
    for (const c of managerClocks) {
      if (!weekSet.has(c.event_date)) continue;
      if (c.store_id && c.store_id !== activeStoreId) continue;
      const base =
        (Number(c.short_deliveries_count) || 0) + (Number(c.long_deliveries_count) || 0);
      if (base) live.set(c.manager_id, (live.get(c.manager_id) ?? 0) + base);
      const ex =
        (Number(c.extra_short_deliveries) || 0) + (Number(c.extra_long_deliveries) || 0);
      if (ex) extra.set(c.manager_id, (extra.get(c.manager_id) ?? 0) + ex);
    }
    return { live, extra };
  }, [managerClocks, weekDays, activeStoreId]);

  // Hours scheduled AT THE ACTIVE STORE only — a manager can be covering another
  // store on a given day, and those hours belong to that store's rota.
  function weekManagerTotalHours(managerId: string): number {
    return weekDays.reduce((sum, d) => {
      const s = managerShiftByKey.get(`${managerId}:${toISODate(d)}`);
      if (!s || s.is_day_off || s.store_id !== activeStoreId) return sum;
      return sum + Number(s.scheduled_hours ?? 0);
    }, 0);
  }

  // Deliveries indexed by driver
  const deliveryByDriver = React.useMemo(() => {
    const m = new Map<string, WeeklyDelivery>();
    for (const d of weeklyDeliveries) m.set(d.driver_id, d);
    return m;
  }, [weeklyDeliveries]);

  // Recurring schedule template indexed by employee + weekday (0=Mon..6=Sun).
  const scheduleByEmpDay = React.useMemo(() => {
    const m = new Map<string, EmployeeScheduleDay>();
    for (const s of schedules) m.set(`${s.employee_id}:${s.weekday}`, s);
    return m;
  }, [schedules]);

  // Live deliveries logged at clock-out, summed per driver for the shown week.
  const liveDeliveriesByEmp = React.useMemo(() => {
    const weekSet = new Set(weekDays.map((d) => toISODate(d)));
    const m = new Map<string, number>();
    for (const c of clocks) {
      if (c.short_deliveries_count == null && c.long_deliveries_count == null) continue;
      if (!weekSet.has(c.event_date)) continue;
      const total = (Number(c.short_deliveries_count) || 0) + (Number(c.long_deliveries_count) || 0);
      m.set(c.employee_id, (m.get(c.employee_id) ?? 0) + total);
    }
    return m;
  }, [clocks, weekDays]);

  // Extra deliveries (beyond the normal round) summed per driver for the week.
  const liveExtraByEmp = React.useMemo(() => {
    const weekSet = new Set(weekDays.map((d) => toISODate(d)));
    const m = new Map<string, number>();
    for (const c of clocks) {
      const extra = (Number(c.extra_short_deliveries) || 0) + (Number(c.extra_long_deliveries) || 0);
      if (!extra) continue;
      if (!weekSet.has(c.event_date)) continue;
      m.set(c.employee_id, (m.get(c.employee_id) ?? 0) + extra);
    }
    return m;
  }, [clocks, weekDays]);

  // 4-week rolling avg per employee (across all stores) using prior weeks.
  // History rows arrive separately from the visible range's bookings but feed
  // the same week buckets, oldest first so `slice(-4)` takes the latest four.
  const fourWkAvg = React.useMemo(() => {
    const result = new Map<string, number>();
    const allShifts: RotaHistoryShift[] = [...historyShifts, ...shifts];
    for (const emp of employees) {
      const empShifts = allShifts.filter(
        (s) => s.employee_id === emp.id && !s.is_day_off,
      );
      const byWeek = new Map<string, number>();
      for (const s of empShifts) {
        const wk = toISODate(startOfISOWeek(new Date(s.shift_date)));
        byWeek.set(wk, (byWeek.get(wk) ?? 0) + Number(s.scheduled_hours ?? 0));
      }
      const current = toISODate(weekStart);
      const prior = Array.from(byWeek.entries())
        .filter(([wk]) => wk !== current)
        .slice(-4)
        .map(([, h]) => h);
      const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
      result.set(emp.id, avg);
    }
    return result;
  }, [shifts, historyShifts, employees, weekStart]);

  // Navigate by pushing the range to the URL; the server page re-fetches the
  // shifts/clocks for whatever range is requested.
  function setRange(startIso: string, endIso: string) {
    router.push(`${pathname}?start=${startIso}&end=${endIso}`);
  }

  // Step the whole window forward/backward by its own length, so paging keeps
  // showing the same number of days.
  function shiftRange(direction: number) {
    const step = direction * rangeDayCount;
    setRange(
      toISODate(addDays(rangeStart, step)),
      toISODate(addDays(rangeEnd, step)),
    );
  }

  function goToday() {
    const ws = startOfISOWeek(new Date());
    setRange(toISODate(ws), toISODate(addDays(ws, 6)));
  }

  // Generate this week's shifts from each employee's recurring schedule.
  // Only fills empty cells (existing shifts are kept).
  async function applyDefaults() {
    setApplying(true);
    try {
      const res = await applyScheduleToWeek({
        store_id: activeStoreId,
        week_start: toISODate(weekStart),
        overwrite: false,
      });
      const parts: string[] = [];
      if (res.created) parts.push(`${res.created} added`);
      if (res.updated) parts.push(`${res.updated} updated`);
      if (res.skipped) parts.push(`${res.skipped} kept`);
      toast.success(
        parts.length
          ? `Schedule applied — ${parts.join(", ")}`
          : "No schedule templates set for this store yet",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setApplying(false);
    }
  }

  // Hours scheduled AT THE ACTIVE STORE only (a shift can now sit at another
  // store on any given day — those belong to that store's rota, not this one).
  // A day can hold several shifts, so every one of them counts, not just the
  // first.
  function weekTotalHours(empId: string): number {
    return weekDays.reduce((sum, d) => {
      const dayShifts = shiftByKey.get(`${empId}:${toISODate(d)}`) ?? [];
      return (
        sum +
        dayShifts.reduce((s, sh) => {
          if (sh.is_day_off || sh.store_id !== activeStoreId) return s;
          return s + Number(sh.scheduled_hours ?? 0);
        }, 0)
      );
    }, 0);
  }

  // Active-store hours grouped by ISO week. The NI/cash split is a weekly rule,
  // so for multi-week ranges we apply the threshold per week.
  function hoursByWeek(empId: string): number[] {
    const byWeek = new Map<string, number>();
    for (const d of weekDays) {
      const dayShifts = shiftByKey.get(`${empId}:${toISODate(d)}`) ?? [];
      const wk = toISODate(startOfISOWeek(d));
      for (const s of dayShifts) {
        if (s.is_day_off || s.store_id !== activeStoreId) continue;
        byWeek.set(wk, (byWeek.get(wk) ?? 0) + Number(s.scheduled_hours ?? 0));
      }
    }
    return Array.from(byWeek.values());
  }

  // Cash hours for THIS store. NI/bank is a home-store concept: at the
  // employee's home store only hours above the weekly limit are cash; at a store
  // they're visiting, every hour is cash (no NI record there). No cash rate ⇒ no
  // cash hours.
  function weekCashHours(emp: RotaEmployee): number {
    if (!worksForCash(emp)) return 0;
    const isHome = emp.store_id === activeStoreId;
    const limit = Number(emp.bank_weekly_hours_limit ?? 20) || 20;
    return hoursByWeek(emp.id).reduce(
      (sum, h) => sum + (isHome ? Math.max(h - limit, 0) : h),
      0,
    );
  }

  function weekWages(emp: RotaEmployee): { ni: number; cash: number; total: number } {
    const niRate = Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0);
    const cashRate = Number(emp.hourly_cash_rate ?? 0);
    const cashEligible = worksForCash(emp);
    const isHome = emp.store_id === activeStoreId;
    const limit = Number(emp.bank_weekly_hours_limit ?? 20) || 20;
    let niHours = 0;
    let cashHours = 0;
    for (const h of hoursByWeek(emp.id)) {
      if (!cashEligible) {
        // No cash rate: all hours are NI (only meaningful at the home store).
        niHours += h;
      } else if (isHome) {
        niHours += Math.min(h, limit);
        cashHours += Math.max(h - limit, 0);
      } else {
        // Visiting another store — no NI record there, so all hours are cash.
        cashHours += h;
      }
    }
    const ni = niHours * niRate;
    const cash = cashHours * cashRate;
    return { ni, cash, total: ni + cash };
  }

  const expectedWageBill = rotaEmployees.reduce(
    (sum, e) => sum + weekWages(e).total,
    0,
  );
  const visitingCount = rotaEmployees.filter((e) => e.store_id !== activeStoreId).length;

  return (
    <div className="flex flex-col gap-6">
      {/* Store tabs & week nav */}
      <Card>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex gap-2 flex-wrap items-center">
            {stores.map((store) => (
              <button
                key={store.id}
                onClick={() => setActiveStoreId(store.id)}
                disabled={!isSuperAdmin && userStoreId !== null && userStoreId !== store.id}
                className={
                  "px-4 h-10 rounded-xl border text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
                  (store.id === activeStoreId
                    ? "bg-gold text-black border-gold"
                    : "bg-surface text-text-primary border-border hover:bg-surface-hover")
                }
              >
                {store.name}
              </button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={applyDefaults}
              loading={applying}
              title="Fill this week's empty days from each employee's recurring weekly schedule"
              className="w-full sm:w-auto"
            >
              Apply default schedules
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => shiftRange(-1)}
              iconLeft={<ChevronLeftIcon size={14} />}
              title={`Back ${rangeDayCount} day${rangeDayCount === 1 ? "" : "s"}`}
            >
              Prev
            </Button>
            <DateRangePicker
              start={rangeStartIso}
              end={rangeEndIso}
              onApply={setRange}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => shiftRange(1)}
              iconRight={<ChevronRightIcon size={14} />}
              title={`Forward ${rangeDayCount} day${rangeDayCount === 1 ? "" : "s"}`}
            >
              Next
            </Button>
            <Button variant="ghost" size="sm" onClick={goToday}>
              Today
            </Button>
          </div>
        </div>
      </Card>

      {/* Manager rota — managers are on a fixed daily wage, not hourly, so this
          is scheduling + attendance only (no wage/hours-avg columns). */}
      {managers.length > 0 && (
        <Card className="overflow-hidden p-0">
          <CardHeader className="px-4 sm:px-5 pt-5 flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <CardTitle>{activeStore?.name ?? "—"} Manager Rota</CardTitle>
              <CardDescription>
                {activeManagers.length} manager{activeManagers.length === 1 ? "" : "s"}
                {managerVisitingCount > 0 ? ` (${managerVisitingCount} visiting)` : ""} · fixed
                daily wage — not hourly, shown for scheduling &amp; attendance only
              </CardDescription>
            </div>
            {eligibleManagerVisitors.length > 0 && (
              <select
                className="h-10 w-full sm:w-auto rounded-xl border border-border bg-surface px-3 text-sm text-text-primary hover:bg-surface-hover cursor-pointer sm:max-w-[260px]"
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    setAddedManagerVisitorIds((p) => [...p, e.target.value]);
                }}
                title="Add a manager from another store to cover a shift here"
              >
                <option value="">+ Add manager from another store…</option>
                {eligibleManagerVisitors.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.username || "Manager"} —{" "}
                    {storeById.get(m.store_id ?? "")?.name ?? "Other store"}
                  </option>
                ))}
              </select>
            )}
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-surface-hover text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="text-left px-3 py-2 sticky left-0 bg-surface-hover z-10 sticky-col">
                    Manager
                  </th>
                  {weekDays.map((d) => (
                    <th
                      key={d.toISOString()}
                      className="text-center px-2 py-2 min-w-[110px]"
                    >
                      <div>{WEEKDAY_SHORT[(d.getDay() + 6) % 7]}</div>
                      <div className="text-[10px] font-normal text-text-muted normal-case">
                        {String(d.getDate()).padStart(2, "0")}/{String(d.getMonth() + 1).padStart(2, "0")}
                      </div>
                    </th>
                  ))}
                  <th
                    className="text-center px-2 py-2"
                    title="Deliveries this manager covered, paid per drop on the Tuesday sheet"
                  >
                    Deliveries
                  </th>
                  <th className="text-right px-3 py-2">Total hrs</th>
                </tr>
              </thead>
              <tbody>
                {activeManagers.length === 0 && (
                  <tr>
                    <td
                      colSpan={weekDays.length + 3}
                      className="px-4 py-8 text-center text-text-muted"
                    >
                      No managers assigned to this store yet. Add one on the Managers page.
                    </td>
                  </tr>
                )}
                {activeManagers.map((mgr) => {
                  const total = weekManagerTotalHours(mgr.id);
                  return (
                    <tr
                      key={mgr.id}
                      className="border-t border-border hover:bg-surface-hover/60 transition-colors"
                    >
                      <td className="px-3 py-2 sticky left-0 bg-surface z-10 sticky-col font-medium text-text-primary">
                        {mgr.name || mgr.username || "Manager"}
                        {mgr.store_id !== activeStoreId && (
                          <span
                            className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-gold/15 text-gold border border-gold/30 align-middle"
                            title={`Visiting from ${storeById.get(mgr.store_id ?? "")?.name ?? "another store"}`}
                          >
                            visiting
                          </span>
                        )}
                      </td>
                      {weekDays.map((d) => {
                        const dateIso = toISODate(d);
                        const cell = managerShiftByKey.get(`${mgr.id}:${dateIso}`);
                        const isToday = dateIso === todayISO();
                        // Covering ANOTHER store this day — read-only here, so this
                        // store's view shows where the manager has gone.
                        if (cell && cell.store_id !== activeStoreId) {
                          const awayStore = storeById.get(cell.store_id);
                          return (
                            <td
                              key={dateIso}
                              className={
                                "px-1 py-1 text-center align-middle " +
                                (isToday ? "bg-gold/5" : "")
                              }
                            >
                              <div
                                className="w-full h-12 rounded-lg text-[11px] border border-dashed border-gold/40 bg-gold/5 text-gold flex flex-col items-center justify-center px-1"
                                title={`Covering ${awayStore?.name ?? "another store"} this day`}
                              >
                                <span className="font-medium truncate max-w-full">
                                  @ {awayStore?.name?.split(" ")[0] ?? "Away"}
                                </span>
                                {!cell.is_day_off && cell.start_time && (
                                  <span className="opacity-80 truncate max-w-full">
                                    {formatShiftRange(false, cell.start_time, cell.end_time)}
                                  </span>
                                )}
                              </div>
                            </td>
                          );
                        }
                        const clk = managerClockByKey.get(`${mgr.id}:${dateIso}`);
                        const isPast = dateIso < todayISO();
                        const prevShift = managerShiftByKey.get(
                          `${mgr.id}:${toISODate(addDays(d, -1))}`,
                        );
                        const prefill =
                          !cell && prevShift && !prevShift.is_day_off && prevShift.start_time
                            ? {
                                start: prevShift.start_time.slice(0, 5),
                                end: (prevShift.end_time ?? "").slice(0, 5),
                              }
                            : null;
                        // "Came or not" — a past scheduled (non-day-off) shift
                        // with no clock-in is a no-show.
                        const missed = isPast && !!cell && !cell.is_day_off && !clk?.clock_in_at;
                        const cellInner = (
                          <>
                            {cell ? formatShiftRange(cell.is_day_off, cell.start_time, cell.end_time) : "—"}
                            {clk?.clock_in_at && (
                              <div className="text-[9px] text-success mt-0.5">
                                ✓ in{" "}
                                {new Date(clk.clock_in_at).toLocaleTimeString("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                                {clk.clock_out_at && (
                                  <>
                                    {" "}
                                    · out{" "}
                                    {new Date(clk.clock_out_at).toLocaleTimeString("en-GB", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                    {clk.auto_clocked_out && (
                                      <span
                                        className="text-warning"
                                        title="No clock-out recorded — the scheduled shift end was used."
                                      >
                                        {" "}
                                        (auto)
                                      </span>
                                    )}
                                  </>
                                )}
                                {/* Attendance, not the schedule: the times above
                                    span the whole day, so a split day needs its
                                    real total spelling out. */}
                                {Number(clk.session_count) > 1 && (
                                  <span
                                    className="block text-gold"
                                    title={`${clk.session_count} separate shifts worked this day, ${formatHoursMinsWords(Number(clk.worked_hours ?? 0))} in total excluding the gap between them.`}
                                  >
                                    {clk.session_count} shifts worked
                                    {clk.worked_hours != null && (
                                      <> · {formatHoursMinsWords(Number(clk.worked_hours))}</>
                                    )}
                                  </span>
                                )}
                              </div>
                            )}
                            {missed && (
                              <div className="text-[9px] text-danger mt-0.5">✗ not clocked in</div>
                            )}
                          </>
                        );
                        return (
                          <td
                            key={dateIso}
                            className={
                              "px-1 py-1 text-center align-middle " +
                              (isToday ? "bg-gold/5" : "")
                            }
                          >
                            {isPast ? (
                              <div
                                className={
                                  "w-full h-12 rounded-lg text-xs border flex flex-col items-center justify-center cursor-default opacity-70 " +
                                  (cell?.is_day_off
                                    ? "bg-danger/5 border-danger/20 text-danger"
                                    : cell?.start_time
                                      ? "bg-success/5 border-success/20 text-success"
                                      : "border-dashed border-border text-text-muted")
                                }
                                title="Past day — view only (locked for editing)"
                              >
                                {cellInner}
                              </div>
                            ) : (
                              <button
                                onClick={() =>
                                  setEditingManagerShift({
                                    manager: mgr,
                                    date: dateIso,
                                    existing: cell ?? null,
                                    prefill,
                                  })
                                }
                                className={
                                  "w-full h-12 rounded-lg text-xs border transition-colors " +
                                  (cell?.is_day_off
                                    ? "bg-danger/10 border-danger/30 text-danger"
                                    : cell?.start_time
                                      ? "bg-success/10 border-success/30 text-success hover:bg-success/15"
                                      : "border-dashed border-border text-text-muted hover:bg-surface-hover")
                                }
                              >
                                {cellInner}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-center tabular-nums">
                        {(() => {
                          const live = managerDeliveriesByMgr.live.get(mgr.id) ?? 0;
                          const extra = managerDeliveriesByMgr.extra.get(mgr.id) ?? 0;
                          if (live + extra === 0) {
                            return <span className="text-text-subtle">—</span>;
                          }
                          return (
                            <span
                              className="text-gold font-medium"
                              title={
                                extra > 0
                                  ? `${live} on the round + ${extra} extra, paid at the same per-drop rate`
                                  : "Drops covered on the normal round"
                              }
                            >
                              {live + extra}
                              {extra > 0 && (
                                <span className="text-[10px] text-text-muted"> (+{extra})</span>
                              )}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        <HoursMinsDisplay hours={total} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Rota grid */}
      <Card className="overflow-hidden p-0">
        <CardHeader className="px-5 pt-5 flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>{activeStore?.name ?? "—"} Rota</CardTitle>
            <CardDescription>
              {rotaEmployees.length} staff
              {visitingCount > 0 ? ` (${visitingCount} visiting)` : ""} · Expected wage bill{" "}
              <span className="text-text-primary font-medium">
                {formatGBP(expectedWageBill)}
              </span>
            </CardDescription>
          </div>
          {eligibleVisitors.length > 0 && (
            <select
              className="h-10 rounded-xl border border-border bg-surface px-3 text-sm text-text-primary hover:bg-surface-hover cursor-pointer max-w-[260px]"
              value=""
              onChange={(e) => {
                if (e.target.value) setAddedVisitorIds((p) => [...p, e.target.value]);
              }}
              title="Add a member of staff from the other store to cover a shift here"
            >
              <option value="">+ Add staff from another store…</option>
              {eligibleVisitors.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {storeById.get(e.store_id ?? "")?.name ?? "Other store"}
                </option>
              ))}
            </select>
          )}
        </CardHeader>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1200px]">
            <thead className="bg-surface-hover text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="text-left px-3 py-2 sticky left-0 bg-surface-hover z-10 sticky-col">
                  Employee
                </th>
                <th className="text-left px-2 py-2">Position</th>
                <th className="text-right px-2 py-2">NI £/h</th>
                <th className="text-right px-2 py-2">Cash £/h</th>
                {weekDays.map((d) => (
                  <th
                    key={d.toISOString()}
                    className="text-center px-2 py-2 min-w-[110px]"
                  >
                    <div>{WEEKDAY_SHORT[(d.getDay() + 6) % 7]}</div>
                    <div className="text-[10px] font-normal text-text-muted normal-case">
                      {String(d.getDate()).padStart(2, "0")}/{String(d.getMonth() + 1).padStart(2, "0")}
                    </div>
                  </th>
                ))}
                <th className="text-right px-2 py-2">Total hrs</th>
                <th className="text-right px-2 py-2" title="Hours above 20/week are paid in cash">
                  Cash hrs
                </th>
                <th className="text-right px-2 py-2">4-wk avg</th>
                <th className="text-right px-3 py-2 group relative">
                  Wages
                  <InfoIcon size={11} className="inline ml-1 opacity-60" />
                </th>
                <th className="text-center px-2 py-2">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {rotaEmployees.length === 0 && (
                <tr>
                  <td
                    colSpan={16}
                    className="px-4 py-8 text-center text-text-muted"
                  >
                    No staff on this store&apos;s rota yet. Assign staff to this store
                    in Employees, or add someone from the other store above.
                  </td>
                </tr>
              )}
              {rotaEmployees.map((emp) => {
                const total = weekTotalHours(emp.id);
                const cashHrs = weekCashHours(emp);
                const avg = fourWkAvg.get(emp.id) ?? 0;
                const wages = weekWages(emp);
                const variance =
                  avg > 0 ? ((total - avg) / avg) * 100 : 0;
                const flagVariance = avg > 0 && Math.abs(variance) > 20;
                const isDriver = hasRole(emp.position, "Driver");
                const delivery = deliveryByDriver.get(emp.id);
                const wage = wageComplianceForEmployee(emp, minWageBands);
                const underMinWage = wage ? !wage.compliant : false;
                const liveDeliv = liveDeliveriesByEmp.get(emp.id) ?? 0;
                const liveExtra = liveExtraByEmp.get(emp.id) ?? 0;

                return (
                  <tr
                    key={emp.id}
                    className="border-t border-border hover:bg-surface-hover/60 transition-colors"
                  >
                    <td className="px-3 py-2 sticky left-0 bg-surface z-10 sticky-col font-medium text-text-primary">
                      {emp.name}
                      {emp.store_id !== activeStoreId && (
                        <span
                          className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide bg-gold/15 text-gold border border-gold/30 align-middle"
                          title={`Visiting from ${storeById.get(emp.store_id ?? "")?.name ?? "another store"}`}
                        >
                          visiting
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-text-subtle">
                      {emp.position ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right text-text-subtle">
                      <span className={underMinWage ? "text-danger font-medium" : ""}>
                        £{Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0).toFixed(2)}
                      </span>
                      {underMinWage && wage && (
                        <span
                          className="block text-[9px] text-danger"
                          title={`Below minimum wage for age ${wage.age}: needs £${wage.required.toFixed(2)}/h (${minWageBands.effective_label})`}
                        >
                          ⚠ below min
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right text-text-subtle">
                      {emp.hourly_cash_rate
                        ? `£${Number(emp.hourly_cash_rate).toFixed(2)}`
                        : "—"}
                    </td>
                    {weekDays.map((d) => {
                      const dateIso = toISODate(d);
                      const dayAll = shiftByKey.get(`${emp.id}:${dateIso}`) ?? [];
                      // A day can now hold several shifts; split them by which
                      // store they belong to (a shift can sit at another store).
                      const localShifts = dayAll.filter((s) => s.store_id === activeStoreId);
                      const awayShifts = dayAll.filter((s) => s.store_id !== activeStoreId);
                      const isToday = dateIso === todayISO();
                      // Scheduled at ANOTHER store this day (and nothing here) —
                      // read-only, so a home manager can see where their staff are
                      // covering. If they ALSO have a shift here, the local cell
                      // below takes priority and the away shift is not shown.
                      if (localShifts.length === 0 && awayShifts.length > 0) {
                        const awayStore = storeById.get(awayShifts[0].store_id);
                        return (
                          <td
                            key={dateIso}
                            className={
                              "px-1 py-1 text-center align-middle " +
                              (isToday ? "bg-gold/5" : "")
                            }
                          >
                            <div
                              className="w-full min-h-12 h-auto py-1 rounded-lg text-[11px] border border-dashed border-gold/40 bg-gold/5 text-gold flex flex-col items-center justify-center px-1"
                              title={`Working at ${awayStore?.name ?? "another store"} this day`}
                            >
                              <span className="font-medium truncate max-w-full">
                                @ {awayStore?.name?.split(" ")[0] ?? "Away"}
                              </span>
                              {awayShifts.map(
                                (s) =>
                                  !s.is_day_off &&
                                  s.start_time && (
                                    <span key={s.id} className="opacity-80 truncate max-w-full">
                                      {formatShiftRange(false, s.start_time, s.end_time)}
                                    </span>
                                  ),
                              )}
                            </div>
                          </td>
                        );
                      }
                      // Kept for the ghost/ prefill logic below, which only cares
                      // about "is there at least one shift already" — the cell
                      // itself renders every one of `localShifts`, not just this.
                      const cell = localShifts[0] ?? null;
                      const clk = clockByKey.get(`${emp.id}:${dateIso}`);
                      // Past days are read-only — managers & admins can view but
                      // not edit yesterday or earlier; only today onwards.
                      const isPast = dateIso < todayISO();
                      // Ghost hint: the employee's recurring schedule for this
                      // weekday, shown faintly in empty cells as a suggestion.
                      const tmpl = scheduleByEmpDay.get(
                        `${emp.id}:${weekdayIndex(d)}`,
                      );
                      const ghost =
                        !cell && tmpl && tmpl.is_working && tmpl.start_time
                          ? `${tmpl.start_time.slice(0, 5)}–${(tmpl.end_time ?? "").slice(0, 5)}`
                          : null;
                      // Previous day's FIRST shift — used to pre-fill a new shift.
                      const prevShift = (
                        shiftByKey.get(`${emp.id}:${toISODate(addDays(d, -1))}`) ?? []
                      )[0];
                      const prefill =
                        !cell && prevShift && !prevShift.is_day_off && prevShift.start_time
                          ? {
                              start: prevShift.start_time.slice(0, 5),
                              end: (prevShift.end_time ?? "").slice(0, 5),
                            }
                          : null;
                      // Ghost defaults are only actionable on editable days.
                      const showGhost = ghost && !isPast;
                      const cellInner = (
                        <>
                          {localShifts.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {localShifts.map((s) => (
                                <div key={s.id}>
                                  {formatShiftRange(s.is_day_off, s.start_time, s.end_time)}
                                  {!s.is_day_off && s.shift_type && (
                                    <span className="block text-[9px] uppercase tracking-wide opacity-70">
                                      {presetShort(s.shift_type)}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : showGhost ? (
                            <span className="opacity-60">
                              {ghost}
                              <span className="block text-[9px] uppercase tracking-wide">
                                default
                              </span>
                            </span>
                          ) : (
                            "—"
                          )}
                          {clk?.clock_in_at && (
                            <div className="text-[9px] text-text-muted mt-0.5">
                              in {new Date(clk.clock_in_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                              {/* Labelled as WORKED, on its own line: the row
                                  above is the scheduled shift, and the two are
                                  different things on a split day. */}
                              {Number(clk.session_count) > 1 && (
                                <span
                                  className="block text-gold"
                                  title={`Attendance, not the schedule: ${clk.session_count} separate shifts worked this day, ${formatHoursMinsWords(Number(clk.worked_hours ?? 0))} in total excluding the gap between them.`}
                                >
                                  {clk.session_count} shifts worked
                                  {clk.worked_hours != null && (
                                    <> · {formatHoursMinsWords(Number(clk.worked_hours))}</>
                                  )}
                                </span>
                              )}
                              {clk.manual_entry && (
                                <span
                                  className="text-warning"
                                  title={
                                    clk.manual_entry_reason
                                      ? `Entered by a manager — ${clk.manual_entry_reason}`
                                      : "Entered by a manager (no location check)"
                                  }
                                >
                                  {" "}
                                  (manual)
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      );
                      return (
                        <td
                          key={dateIso}
                          className={
                            "px-1 py-1 text-center align-middle " +
                            (isToday ? "bg-gold/5" : "")
                          }
                        >
                          {isPast ? (
                            <div
                              className={
                                "w-full min-h-12 h-auto py-1 rounded-lg text-xs border flex flex-col items-center justify-center cursor-default opacity-70 " +
                                (cell?.is_day_off
                                  ? "bg-danger/5 border-danger/20 text-danger"
                                  : cell?.start_time
                                    ? "bg-success/5 border-success/20 text-success"
                                    : "border-dashed border-border text-text-muted")
                              }
                              title={
                                cell?.same_day_edit_reason
                                  ? `Reason: ${cell.same_day_edit_reason}`
                                  : "Past day — view only (locked for editing)"
                              }
                            >
                              {cellInner}
                            </div>
                          ) : (
                            <button
                              onClick={() =>
                                setEditingShift({
                                  employee: emp,
                                  date: dateIso,
                                  existing: cell ?? null,
                                  prefill,
                                  dayShifts: localShifts,
                                })
                              }
                              className={
                                "w-full min-h-12 h-auto py-1 rounded-lg text-xs border transition-colors " +
                                (cell?.is_day_off
                                  ? "bg-danger/10 border-danger/30 text-danger"
                                  : cell?.start_time
                                    ? "bg-success/10 border-success/30 text-success hover:bg-success/15"
                                    : ghost
                                      ? "border-dashed border-gold/30 text-text-muted hover:bg-gold/5"
                                      : "border-dashed border-border text-text-muted hover:bg-surface-hover")
                              }
                              title={
                                cell?.same_day_edit_reason
                                  ? `Reason: ${cell.same_day_edit_reason}`
                                  : localShifts.length > 1
                                    ? `${localShifts.length} shifts — click to manage`
                                    : ghost
                                      ? "Default from recurring schedule — click to add this shift"
                                      : undefined
                              }
                            >
                              {cellInner}
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-right font-medium">
                      <HoursMinsDisplay hours={total} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      {cashHrs > 0 ? (
                        <span className="font-medium text-gold">
                          <HoursMinsDisplay hours={cashHrs} />
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right text-text-subtle">
                      <span className={flagVariance ? "text-warning" : ""}>
                        <HoursMinsDisplay hours={avg} />
                        {flagVariance && (
                          <span className="ml-1 text-[10px]">
                            ({variance > 0 ? "+" : ""}
                            {variance.toFixed(0)}%)
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="font-medium text-text-primary">
                        {formatGBP(wages.total)}
                      </div>
                      <div className="text-[10px] text-text-muted leading-tight mt-0.5">
                        <span>NI {formatGBP(wages.ni)}</span>
                        {wages.cash > 0 && (
                          <span className="block text-success">Cash {formatGBP(wages.cash)}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center text-xs">
                      {isDriver ? (
                        <button
                          onClick={() =>
                            setEditingDelivery({
                              driver: emp,
                              existing: delivery ?? null,
                              weekDays: weekDays.map((d) => toISODate(d)),
                              events: clocks.filter(
                                (c) =>
                                  c.employee_id === emp.id &&
                                  weekDays.some((d) => toISODate(d) === c.event_date),
                              ),
                            })
                          }
                          className="text-text-subtle hover:text-text-primary underline-offset-2 hover:underline"
                        >
                          {delivery?.manager_avg_4wk != null
                            ? `Avg ${delivery.manager_avg_4wk}`
                            : "Enter"}
                          {delivery?.vita_mojo_count != null && (
                            <span className="block text-[10px] text-text-muted">
                              Vita {delivery.vita_mojo_count}
                            </span>
                          )}
                          <span
                            className="block text-[10px] text-success"
                            title="Deliveries logged via clock-out this week"
                          >
                            Live {liveDeliv}
                            {liveExtra > 0 && (
                              <span className="text-gold"> (+{liveExtra} extra)</span>
                            )}
                          </span>
                        </button>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Cover driver rota — hidden entirely when this store has no cover
          drivers. Cells stay blank on days they aren't booked, which is most
          weekdays: cover drivers are mainly a weekend resource. */}
      {activeCoverDrivers.length > 0 && (
        <Card className="overflow-hidden p-0">
          <CardHeader className="px-5 pt-5">
            <div>
              <CardTitle>{activeStore?.name ?? "—"} Cover Driver Rota</CardTitle>
              <CardDescription>
                {activeCoverDrivers.length} cover driver
                {activeCoverDrivers.length === 1 ? "" : "s"} · paid cash per hour worked —
                booking a day sets the expected shift, pay still comes from what they clock
              </CardDescription>
            </div>
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-surface-hover text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="text-left px-3 py-2 sticky left-0 bg-surface-hover z-10 sticky-col">
                    Cover Driver
                  </th>
                  {weekDays.map((d) => (
                    <th key={d.toISOString()} className="text-center px-2 py-2 min-w-[110px]">
                      <div>{WEEKDAY_SHORT[(d.getDay() + 6) % 7]}</div>
                      <div className="text-[10px] font-normal text-text-muted normal-case">
                        {String(d.getDate()).padStart(2, "0")}/
                        {String(d.getMonth() + 1).padStart(2, "0")}
                      </div>
                    </th>
                  ))}
                  <th className="text-right px-2 py-2">Total hrs</th>
                  <th
                    className="text-right px-3 py-2"
                    title="Booked hours × cash rate. Cover drivers are paid cash only — no NI split."
                  >
                    Wages
                  </th>
                  <th className="text-center px-2 py-2">Deliveries</th>
                </tr>
              </thead>
              <tbody>
                {activeCoverDrivers.map((driver) => {
                  const total = rangeCoverTotalHours(driver.id);
                  const rate = Number(driver.hourly_cash_rate) || 0;
                  const liveDeliv = coverDeliveriesByDriver.live.get(driver.id) ?? 0;
                  const liveExtra = coverDeliveriesByDriver.extra.get(driver.id) ?? 0;
                  return (
                    <tr
                      key={driver.id}
                      className="border-t border-border hover:bg-surface-hover/60 transition-colors"
                    >
                      <td className="px-3 py-2 sticky left-0 bg-surface z-10 sticky-col font-medium text-text-primary">
                        {driver.name}
                        <span className="block text-[10px] text-text-muted font-normal">
                          {formatGBP(driver.hourly_cash_rate)}/h cash
                        </span>
                      </td>
                      {weekDays.map((d) => {
                        const dateIso = toISODate(d);
                        const cell = coverShiftByKey.get(`${driver.id}:${dateIso}`) ?? null;
                        const tmpl = coverScheduleByKey.get(
                          `${driver.id}:${weekdayOf(dateIso)}`,
                        );
                        const eff = resolveCoverDriverShift(cell, tmpl);
                        const clk = coverClockByKey.get(`${driver.id}:${dateIso}`);
                        const isToday = dateIso === todayISO();
                        const isPast = dateIso < todayISO();
                        // Their usual availability pre-fills a new booking, so
                        // the common case is two clicks: open, save.
                        const prefill =
                          !cell && tmpl?.is_working && tmpl.start_time
                            ? {
                                start: tmpl.start_time.slice(0, 5),
                                end: (tmpl.end_time ?? "").slice(0, 5),
                              }
                            : null;
                        const missed =
                          isPast && !!cell && !cell.is_day_off && !clk?.clock_in_at;

                        const cellInner = (
                          <>
                            {cell ? (
                              formatShiftRange(cell.is_day_off, cell.start_time, cell.end_time)
                            ) : eff && !eff.is_day_off ? (
                              <span className="opacity-70">
                                {formatShiftRange(false, eff.start_time, eff.end_time)}
                                <span className="block text-[9px] uppercase tracking-wide">
                                  usual
                                </span>
                              </span>
                            ) : (
                              "—"
                            )}
                            {clk?.clock_in_at && (
                              <div className="text-[9px] text-success mt-0.5">
                                ✓ in{" "}
                                {new Date(clk.clock_in_at).toLocaleTimeString("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                                {clk.clock_out_at && (
                                  <>
                                    {" "}
                                    · out{" "}
                                    {new Date(clk.clock_out_at).toLocaleTimeString("en-GB", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </>
                                )}
                                {clk.manual_entry && (
                                  <span
                                    className="text-warning"
                                    title={
                                      clk.manual_entry_reason
                                        ? `Entered by a manager — ${clk.manual_entry_reason}`
                                        : "Entered by a manager (no location check)"
                                    }
                                  >
                                    {" "}
                                    (manual)
                                  </span>
                                )}
                              </div>
                            )}
                            {missed && (
                              <div className="text-[9px] text-danger mt-0.5">
                                ✗ not clocked in
                              </div>
                            )}
                          </>
                        );

                        return (
                          <td
                            key={dateIso}
                            className={
                              "px-1 py-1 text-center align-middle " +
                              (isToday ? "bg-gold/5" : "")
                            }
                          >
                            {isPast ? (
                              <div
                                className={
                                  "w-full h-12 rounded-lg text-xs border flex flex-col items-center justify-center cursor-default opacity-70 " +
                                  (cell?.is_day_off
                                    ? "bg-danger/5 border-danger/20 text-danger"
                                    : cell?.start_time
                                      ? "bg-success/5 border-success/20 text-success"
                                      : "border-dashed border-border text-text-muted")
                                }
                                title="Past day — view only (locked for editing)"
                              >
                                {cellInner}
                              </div>
                            ) : (
                              <button
                                onClick={() =>
                                  setEditingCoverShift({
                                    driver,
                                    date: dateIso,
                                    existing: cell,
                                    prefill,
                                  })
                                }
                                className={
                                  "w-full h-12 rounded-lg text-xs border transition-colors " +
                                  (cell?.is_day_off
                                    ? "bg-danger/10 border-danger/30 text-danger"
                                    : cell?.start_time
                                      ? "bg-success/10 border-success/30 text-success hover:bg-success/15"
                                      : "border-dashed border-border text-text-muted hover:bg-surface-hover")
                                }
                              >
                                {cellInner}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-right font-medium">
                        <HoursMinsDisplay hours={total} />
                      </td>
                      {/* Cash only — no NI/cash split, unlike the employee rota. */}
                      <td className="px-3 py-2 text-right">
                        <div className="font-medium text-success">
                          {formatGBP(total * rate)}
                        </div>
                        <div className="text-[10px] text-text-muted leading-tight mt-0.5">
                          Cash · {formatGBP(rate)}/h
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center text-xs">
                        {liveDeliv > 0 || liveExtra > 0 ? (
                          <span
                            className="text-success"
                            title="Deliveries logged via clock-out in this range"
                          >
                            {liveDeliv}
                            {liveExtra > 0 && (
                              <span className="text-gold"> (+{liveExtra} extra)</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Modals */}
      {editingShift && (
        <ShiftEditModal
          employee={editingShift.employee}
          storeId={activeStoreId}
          shiftDate={editingShift.date}
          existing={editingShift.existing}
          dayShifts={editingShift.dayShifts}
          shiftTimes={activeStore?.shift_times ?? shiftTimes}
          prefill={editingShift.prefill}
          onClose={() => setEditingShift(null)}
          onSaved={() => {
            setEditingShift(null);
            toast.success("Shift updated");
            router.refresh();
          }}
        />
      )}
      {editingDelivery && (
        <DeliveryEditModal
          driver={editingDelivery.driver}
          storeId={activeStoreId}
          weekStartIso={toISODate(weekStart)}
          existing={editingDelivery.existing}
          weekDays={editingDelivery.weekDays}
          events={editingDelivery.events}
          onClose={() => setEditingDelivery(null)}
          onSaved={() => {
            setEditingDelivery(null);
            toast.success("Deliveries saved");
            router.refresh();
          }}
        />
      )}
      {editingCoverShift && (
        <CoverDriverShiftEditModal
          driver={editingCoverShift.driver}
          storeId={activeStoreId}
          shiftDate={editingCoverShift.date}
          existing={editingCoverShift.existing}
          prefill={editingCoverShift.prefill}
          onClose={() => setEditingCoverShift(null)}
          onSaved={() => {
            setEditingCoverShift(null);
            toast.success("Cover shift updated");
            router.refresh();
          }}
        />
      )}
      {editingManagerShift && (
        <ManagerShiftEditModal
          manager={editingManagerShift.manager}
          storeId={activeStoreId}
          shiftDate={editingManagerShift.date}
          existing={editingManagerShift.existing}
          prefill={editingManagerShift.prefill}
          onClose={() => setEditingManagerShift(null)}
          onSaved={() => {
            setEditingManagerShift(null);
            toast.success("Shift updated");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
