// =============================================================
// Cash Flow Module — pure calculation helpers (PRG-CF-001).
//
// No server / Supabase imports — safe to use from client UI and server actions
// alike, so the live preview and the persisted payout sheet compute identically.
//
// Core rules (confirmed with the client):
//  - Cash wage uses the NI/bank split: the first `bank_weekly_hours_limit` hours
//    (default 20) of the week are NI/bank wages; only hours ABOVE that are paid
//    in cash, at the employee's hourly_cash_rate.
//  - Drivers are paid hourly like everyone else PLUS a per-delivery petrol
//    allowance, split into SHORT and LONG deliveries each with its own
//    per-driver rate (default £2 when unset). Extra deliveries of each type
//    (logged with a reason) are paid the matching rate.
//  - Wages paid on a Tuesday are for the PREVIOUS week's work (Mon–Sun);
//    the cash used to pay them is what this week's envelopes collected, plus a
//    default supermarket cash float.
//  - Opening balance carries forward last week's surplus.
// =============================================================

import type { DailyCashEntry, Employee, PrePaymentSummary, WageLine } from "./types";
import { hasRole } from "./types";
import {
  addDays,
  parseISODate,
  resolvedDayHours,
  startOfISOWeek,
  toISODate,
} from "./utils";

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** £2 per delivery covers the driver's petrol; labour is paid hourly. */
export const DELIVERY_PETROL_RATE = 2;

/**
 * The pay week for a Tuesday payout: wages paid on this week's Tuesday are
 * for the PREVIOUS Monday–Sunday week.
 */
export function payWeekOf(weekStartISO: string): { start: string; end: string } {
  const start = toISODate(addDays(parseISODate(weekStartISO), -7));
  return { start, end: toISODate(addDays(parseISODate(start), 6)) };
}

/** Resolve a `?week=` param into the Monday-anchored week + prev/next links. */
export function resolveWeek(weekParam?: string | null): {
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
} {
  const base = weekParam ? parseISODate(weekParam) : new Date();
  const valid = isNaN(base.getTime()) ? new Date() : base;
  const weekStart = toISODate(startOfISOWeek(valid));
  const d = parseISODate(weekStart);
  return {
    weekStart,
    prevWeek: toISODate(addDays(d, -7)),
    nextWeek: toISODate(addDays(d, 7)),
  };
}

/** Split a week's worked hours into NI/bank vs cash-in-hand portions. */
export function splitHours(
  totalHours: number,
  bankLimit: number,
): { bankHours: number; cashHours: number } {
  const total = Math.max(0, Number(totalHours) || 0);
  const limit = Math.max(0, Number(bankLimit) || 0);
  const bankHours = Math.min(total, limit);
  const cashHours = Math.max(total - limit, 0);
  return { bankHours: round2(bankHours), cashHours: round2(cashHours) };
}

/**
 * Whether an employee is paid any hours in cash. An employee left with a blank
 * (or zero) cash rate doesn't work for cash at all — every hour is NI/PAYE,
 * regardless of how many hours they work in a week.
 */
export function worksForCash(emp: {
  hourly_cash_rate?: number | null;
}): boolean {
  return emp.hourly_cash_rate != null && Number(emp.hourly_cash_rate) > 0;
}

/**
 * Per-employee hours split. If the employee has no cash rate, ALL hours are
 * NI/bank hours (cash = 0) — even above the weekly bank limit. Otherwise the
 * usual "first `bank_weekly_hours_limit` hours NI, remainder cash" rule applies.
 */
export function splitHoursForEmployee(
  emp: { hourly_cash_rate?: number | null; bank_weekly_hours_limit?: number | null },
  totalHours: number,
): { bankHours: number; cashHours: number } {
  if (!worksForCash(emp)) {
    return { bankHours: round2(Math.max(0, Number(totalHours) || 0)), cashHours: 0 };
  }
  return splitHours(totalHours, emp.bank_weekly_hours_limit ?? 20);
}

// ---------------- daily reconciliation ----------------

export type WeekEntryTotals = {
  vitaMojoTotal: number;
  cashCollected: number;
  loggedDifferences: number;
  discrepancyDays: number;
};

/** Aggregate a week's daily cash entries for a single store. */
export function summariseWeekEntries(
  entries: Pick<DailyCashEntry, "vita_mojo_sales" | "envelope_amount" | "difference">[],
): WeekEntryTotals {
  let vita = 0;
  let envelope = 0;
  let discrepancyDays = 0;
  for (const e of entries) {
    vita += Number(e.vita_mojo_sales) || 0;
    envelope += Number(e.envelope_amount) || 0;
    const diff = Number(e.difference ?? (Number(e.vita_mojo_sales) - Number(e.envelope_amount)));
    if (Math.abs(diff) > 0.001) discrepancyDays += 1;
  }
  return {
    vitaMojoTotal: round2(vita),
    cashCollected: round2(envelope),
    // vita − envelopes; equals the sum of per-day differences.
    loggedDifferences: round2(vita - envelope),
    discrepancyDays,
  };
}

export type RunningBalanceRow = {
  entry_date: string;
  vita_mojo_sales: number;
  envelope_amount: number;
  difference: number;
  reason: string | null;
  is_late: boolean;
  running_balance: number;
  manager_name: string | null;
};

/**
 * Per-day cumulative running balance for a store's week. Physical cash on hand
 * = opening balance + Σ envelope amounts to date. Entries are sorted by date.
 */
export function runningBalanceRows(
  entries: DailyCashEntry[],
  openingBalance: number,
): RunningBalanceRow[] {
  const sorted = [...entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  let balance = Number(openingBalance) || 0;
  return sorted.map((e) => {
    balance += Number(e.envelope_amount) || 0;
    return {
      entry_date: e.entry_date,
      vita_mojo_sales: Number(e.vita_mojo_sales) || 0,
      envelope_amount: Number(e.envelope_amount) || 0,
      difference: Number(e.difference) || 0,
      reason: e.reason,
      is_late: e.is_late,
      running_balance: round2(balance),
      manager_name: e.edited_by_name ?? e.submitted_by_name ?? null,
    };
  });
}

// ---------------- wages ----------------

export type WeekWorked = {
  /** Worked hours for the week (from clock records, else scheduled rota). */
  hours: number;
  /** Short deliveries completed in the week (incl. extras). */
  shortDeliveries: number;
  /** Long deliveries completed in the week (incl. extras). */
  longDeliveries: number;
};

/**
 * Build the per-employee wage lines for a store's pay week.
 * `workedByEmployee` maps employee_id -> {hours, deliveries}. Employees whose
 * total payment is £0 (no cash hours and no deliveries) are omitted — the
 * payout sheet lists only those actually receiving cash.
 */
export function buildWageLines(
  employees: Employee[],
  workedByEmployee: Map<string, WeekWorked>,
): WageLine[] {
  const lines: WageLine[] = [];
  for (const emp of employees) {
    // Leavers are NOT skipped: wages are a week in arrears, so an employee who
    // left this week is still owed for the pay week. Anyone with nothing due is
    // dropped by the total<=0 check below.
    const worked =
      workedByEmployee.get(emp.id) ?? { hours: 0, shortDeliveries: 0, longDeliveries: 0 };
    // No cash rate ⇒ no cash hours at all (every hour is NI), even past the
    // weekly bank limit. Otherwise hours above the limit are paid in cash.
    const { cashHours } = splitHoursForEmployee(emp, worked.hours);
    const cashRate = Number(emp.hourly_cash_rate ?? 0) || 0;
    const cashWage = round2(cashHours * cashRate);

    const isDriver = hasRole(emp.position, "Driver");
    const shortDeliveries = isDriver ? Math.max(0, Math.round(worked.shortDeliveries)) : 0;
    const longDeliveries = isDriver ? Math.max(0, Math.round(worked.longDeliveries)) : 0;
    // £2/delivery petrol allowance unless a custom per-driver rate is set.
    const shortRate = isDriver
      ? emp.short_delivery_rate != null
        ? Number(emp.short_delivery_rate)
        : DELIVERY_PETROL_RATE
      : 0;
    const longRate = isDriver
      ? emp.long_delivery_rate != null
        ? Number(emp.long_delivery_rate)
        : DELIVERY_PETROL_RATE
      : 0;
    const deliveryWages = round2(shortDeliveries * shortRate + longDeliveries * longRate);

    const total = round2(cashWage + deliveryWages);
    if (total <= 0) continue;

    lines.push({
      employee_id: emp.id,
      employee_name: emp.name,
      role: emp.position ?? null,
      cash_hours: cashHours,
      cash_rate: cashRate,
      cash_wage: cashWage,
      short_deliveries_count: shortDeliveries,
      long_deliveries_count: longDeliveries,
      // This single-store roll-up folds the extra ("misc") drops into the
      // counts above, so there is nothing left to report separately.
      short_misc_count: 0,
      long_misc_count: 0,
      short_delivery_rate: shortRate,
      long_delivery_rate: longRate,
      delivery_wages: deliveryWages,
      total_payment: total,
    });
  }
  return lines.sort((a, b) => b.total_payment - a.total_payment);
}

/** Assemble the full §3.4 pre-payment summary from its parts. */
export function buildPrePaymentSummary(input: {
  store_id: string;
  week_start_date: string;
  opening_balance: number;
  entries: Pick<DailyCashEntry, "vita_mojo_sales" | "envelope_amount" | "difference">[];
  lines: WageLine[];
  /** Default supermarket cash float added to the pot (0 if not configured). */
  supermarket_cash?: number;
}): PrePaymentSummary {
  const totals = summariseWeekEntries(input.entries);
  const opening = round2(input.opening_balance);
  const supermarketCash = round2(Math.max(0, Number(input.supermarket_cash) || 0));
  // Cash available to pay wages = carried-forward surplus + envelopes collected
  // + the default supermarket float. Wages are deducted from this; any remainder
  // is surplus, and a shortfall is the Post Office draw.
  const actualCashAvailable = round2(opening + totals.cashCollected + supermarketCash);
  const totalCashWages = round2(input.lines.reduce((s, l) => s + l.cash_wage, 0));
  const totalDeliveryWages = round2(input.lines.reduce((s, l) => s + l.delivery_wages, 0));
  const grandTotal = round2(totalCashWages + totalDeliveryWages);
  const diff = round2(actualCashAvailable - grandTotal);

  return {
    store_id: input.store_id,
    week_start_date: input.week_start_date,
    opening_balance: opening,
    vita_mojo_total: totals.vitaMojoTotal,
    cash_collected: totals.cashCollected,
    logged_differences: totals.loggedDifferences,
    supermarket_cash: supermarketCash,
    actual_cash_available: actualCashAvailable,
    total_cash_wages: totalCashWages,
    total_delivery_wages: totalDeliveryWages,
    grand_total_wages: grandTotal,
    post_office_draw: diff < 0 ? round2(-diff) : 0,
    surplus: diff > 0 ? diff : 0,
    lines: input.lines,
  };
}

// ---------------- aggregation from clock events ----------------

type ClockRow = {
  employee_id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  short_deliveries_count: number | null;
  long_deliveries_count: number | null;
  /** Deliveries beyond the normal round — paid the matching per-type rate. */
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  /** Summed shifts for the day — see resolvedDayHours(). */
  worked_hours?: number | string | null;
  /** Manager approval override — see resolvedDayHours(). */
  hours_approved?: boolean | null;
  approved_hours?: number | string | null;
};


type ShiftRow = {
  employee_id: string;
  is_day_off: boolean;
  scheduled_hours: number | null;
};

/**
 * Worked hours + deliveries per employee for a week. Hours come from completed
 * clock events; if an employee has no clock hours at all that week we fall back
 * to their scheduled rota hours so a payout can still be produced. Deliveries
 * always come from the clock events ("Deliveries – Live Count").
 */
export function aggregateWorked(
  clocks: ClockRow[],
  shifts: ShiftRow[],
): Map<string, WeekWorked> {
  const clockHours = new Map<string, number>();
  const shortDeliveries = new Map<string, number>();
  const longDeliveries = new Map<string, number>();
  for (const c of clocks) {
    const shortDelivered =
      (Number(c.short_deliveries_count) || 0) + (Number(c.extra_short_deliveries) || 0);
    const longDelivered =
      (Number(c.long_deliveries_count) || 0) + (Number(c.extra_long_deliveries) || 0);
    if (shortDelivered > 0) {
      shortDeliveries.set(c.employee_id, (shortDeliveries.get(c.employee_id) ?? 0) + shortDelivered);
    }
    if (longDelivered > 0) {
      longDeliveries.set(c.employee_id, (longDeliveries.get(c.employee_id) ?? 0) + longDelivered);
    }
    if (c.clock_in_at && c.clock_out_at) {
      const hours = resolvedDayHours(c);
      if (hours > 0) {
        clockHours.set(c.employee_id, (clockHours.get(c.employee_id) ?? 0) + hours);
      }
    }
  }

  const scheduledHours = new Map<string, number>();
  for (const s of shifts) {
    if (s.is_day_off) continue;
    scheduledHours.set(
      s.employee_id,
      (scheduledHours.get(s.employee_id) ?? 0) + (Number(s.scheduled_hours) || 0),
    );
  }

  const result = new Map<string, WeekWorked>();
  const ids = new Set<string>([
    ...Array.from(clockHours.keys()),
    ...Array.from(shortDeliveries.keys()),
    ...Array.from(longDeliveries.keys()),
    ...Array.from(scheduledHours.keys()),
  ]);
  for (const id of Array.from(ids)) {
    const hours = clockHours.has(id) ? clockHours.get(id)! : scheduledHours.get(id) ?? 0;
    result.set(id, {
      hours: round2(hours),
      shortDeliveries: shortDeliveries.get(id) ?? 0,
      longDeliveries: longDeliveries.get(id) ?? 0,
    });
  }
  return result;
}

// ---------------- cross-store weekly wage attribution ----------------
//
// Employees are not locked to one store: someone can work Mon–Wed at Hitchin and
// Thu–Fri at Stevenage. Each DAY's work (and pay) is attributed to the store it
// was worked at (one clock/shift row per day, so a day maps to exactly one
// store).
//
// NI/cash split (confirmed with the client): NI/bank is a HOME-store concept —
// the employee's payroll record lives at their home store, so only the home
// store runs their NI. A SECONDARY store (one they don't belong to, just cover
// at) has no NI record for them, so it pays every hour worked there in CASH.
//   - Home store  → first `bank_weekly_hours_limit` (default 20) hours worked at
//     home are NI/bank; home hours beyond that are cash.
//   - Secondary store → all hours worked there are cash.
// Example: Pavan (home = Stevenage) works 40h Stevenage + 30h Hitchin in a week.
// Stevenage: 20h NI + 20h cash. Hitchin: 30h cash. Total 20 NI + 50 cash.

/** A clock row carrying which store + day it belongs to. */
export type StoreClockRow = {
  employee_id: string;
  store_id: string;
  event_date: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  short_deliveries_count: number | null;
  long_deliveries_count: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  /** Summed shifts for the day — see resolvedDayHours(). */
  worked_hours?: number | string | null;
  /** Manager approval override — see resolvedDayHours(). */
  hours_approved?: boolean | null;
  approved_hours?: number | string | null;
};

/** A scheduled shift row carrying which store + day it belongs to. */
export type StoreShiftRow = {
  employee_id: string;
  store_id: string;
  shift_date: string;
  is_day_off: boolean;
  scheduled_hours: number | null;
};

/** One resolved working day: the store worked and the hours that count. */
type DayWork = { date: string; store_id: string; hours: number };

/**
 * Resolve an employee's working days for the week. Clock records are the source
 * of truth: if the employee clocked in AND out on ANY day that week, only
 * clocked days count (each attributed to the store it was clocked at). If they
 * never completed a clock all week, fall back to their scheduled rota days so a
 * payout can still be produced.
 */
function resolveWorkingDays(clocks: StoreClockRow[], shifts: StoreShiftRow[]): DayWork[] {
  const clockedDays: DayWork[] = [];
  for (const c of clocks) {
    if (c.clock_in_at && c.clock_out_at) {
      const hours = resolvedDayHours(c);
      if (hours > 0) {
        clockedDays.push({ date: c.event_date, store_id: c.store_id, hours });
      }
    }
  }
  if (clockedDays.length > 0) return clockedDays;

  const scheduledDays: DayWork[] = [];
  for (const s of shifts) {
    if (s.is_day_off) continue;
    const hours = Number(s.scheduled_hours) || 0;
    if (hours > 0) scheduledDays.push({ date: s.shift_date, store_id: s.store_id, hours });
  }
  return scheduledDays;
}

/** Total resolved working hours per store for an employee's week. */
function hoursByStore(days: DayWork[]): Map<string, number> {
  const byStore = new Map<string, number>();
  for (const d of days) byStore.set(d.store_id, (byStore.get(d.store_id) ?? 0) + d.hours);
  return byStore;
}

/**
 * The home-store NI rule in ONE place, expressed over a week's hour total at a
 * single store:
 *   - at their HOME store: only hours above the weekly bank limit are cash;
 *   - at any SECONDARY store: every hour is cash (no NI record there).
 * No cash rate ⇒ no cash hours anywhere (they're paid entirely on the books).
 *
 * Exported so the crew analytics page can price a week the same way the payout
 * does without restating the rule — a second copy would eventually disagree
 * with the envelope, which is the one thing that must never happen.
 */
export function cashHoursFromStoreTotal(
  hoursAtStore: number,
  storeId: string,
  emp: {
    store_id?: string | null;
    hourly_cash_rate?: number | null;
    bank_weekly_hours_limit?: number | null;
  },
): number {
  if (!worksForCash(emp)) return 0;
  const hoursHere = Math.max(0, Number(hoursAtStore) || 0);
  if (emp.store_id === storeId) {
    const limit = Math.max(0, Number(emp.bank_weekly_hours_limit ?? 20) || 0);
    return Math.max(0, hoursHere - limit);
  }
  return hoursHere;
}

function cashHoursAtStore(
  days: DayWork[],
  storeId: string,
  emp: {
    store_id?: string | null;
    hourly_cash_rate?: number | null;
    bank_weekly_hours_limit?: number | null;
  },
): number {
  return cashHoursFromStoreTotal(hoursByStore(days).get(storeId) ?? 0, storeId, emp);
}

/**
 * Build the wage lines for ONE store's pay week, correctly handling employees
 * whose week spans multiple stores. `clocks`/`shifts` must cover the whole pay
 * week across ALL stores: the "clock trumps schedule" resolution and the
 * home-store NI rule both need to see the employee's full week (their home hours
 * may sit at a different store than `storeId`). Only employees with cash and/or
 * deliveries AT `storeId` produce a line — so it can be handed the full employee
 * roster and it will keep just those who worked at the store.
 */
export function buildWageLinesForStore(
  storeId: string,
  employees: Employee[],
  clocks: StoreClockRow[],
  shifts: StoreShiftRow[],
): WageLine[] {
  const clocksByEmp = new Map<string, StoreClockRow[]>();
  for (const c of clocks) {
    const arr = clocksByEmp.get(c.employee_id) ?? [];
    arr.push(c);
    clocksByEmp.set(c.employee_id, arr);
  }
  const shiftsByEmp = new Map<string, StoreShiftRow[]>();
  for (const s of shifts) {
    const arr = shiftsByEmp.get(s.employee_id) ?? [];
    arr.push(s);
    shiftsByEmp.set(s.employee_id, arr);
  }

  const lines: WageLine[] = [];
  for (const emp of employees) {
    const empClocks = clocksByEmp.get(emp.id) ?? [];
    const empShifts = shiftsByEmp.get(emp.id) ?? [];
    const days = resolveWorkingDays(empClocks, empShifts);
    const cashHours = round2(cashHoursAtStore(days, storeId, emp));

    // Deliveries always come from the actual clock rows AT this store.
    const isDriver = hasRole(emp.position, "Driver");
    // Normal-round drops and the extra ("miscellaneous") drops are counted
    // separately so the payout sheet can show SD / LD / SM / LM, but both are
    // paid at the same per-type rate.
    let shortDeliveries = 0;
    let longDeliveries = 0;
    let shortMisc = 0;
    let longMisc = 0;
    if (isDriver) {
      for (const c of empClocks) {
        if (c.store_id !== storeId) continue;
        shortDeliveries += Number(c.short_deliveries_count) || 0;
        longDeliveries += Number(c.long_deliveries_count) || 0;
        shortMisc += Number(c.extra_short_deliveries) || 0;
        longMisc += Number(c.extra_long_deliveries) || 0;
      }
    }
    shortDeliveries = Math.max(0, Math.round(shortDeliveries));
    longDeliveries = Math.max(0, Math.round(longDeliveries));
    shortMisc = Math.max(0, Math.round(shortMisc));
    longMisc = Math.max(0, Math.round(longMisc));

    const cashRate = Number(emp.hourly_cash_rate ?? 0) || 0;
    const cashWage = round2(cashHours * cashRate);
    const shortRate = isDriver
      ? emp.short_delivery_rate != null
        ? Number(emp.short_delivery_rate)
        : DELIVERY_PETROL_RATE
      : 0;
    const longRate = isDriver
      ? emp.long_delivery_rate != null
        ? Number(emp.long_delivery_rate)
        : DELIVERY_PETROL_RATE
      : 0;
    const deliveryWages = round2(
      (shortDeliveries + shortMisc) * shortRate + (longDeliveries + longMisc) * longRate,
    );
    const total = round2(cashWage + deliveryWages);
    if (total <= 0) continue;

    lines.push({
      employee_id: emp.id,
      employee_name: emp.name,
      role: emp.position ?? null,
      cash_hours: cashHours,
      cash_rate: cashRate,
      cash_wage: cashWage,
      short_deliveries_count: shortDeliveries,
      long_deliveries_count: longDeliveries,
      short_misc_count: shortMisc,
      long_misc_count: longMisc,
      short_delivery_rate: shortRate,
      long_delivery_rate: longRate,
      delivery_wages: deliveryWages,
      total_payment: total,
    });
  }
  return lines.sort((a, b) => b.total_payment - a.total_payment);
}

// ---------------- cover drivers ----------------

/** One approved cover-driver day, as read from cover_driver_hours_computed. */
export type CoverDriverPayRow = {
  cover_driver_id: string;
  driver_name: string;
  store_id: string;
  work_date: string;
  total_hours_worked: number | string;
  hourly_rate_snapshot: number | string;
  short_deliveries: number | string;
  long_deliveries: number | string;
  short_rate_snapshot: number | string | null;
  long_rate_snapshot: number | string | null;
  approved: boolean;
};

/**
 * Wage lines for cover drivers working at one store during the pay week.
 *
 * Differs from the employee builder in two ways that matter:
 *   * ONLY APPROVED DAYS COUNT. An employee's cash is derived from clock rows,
 *     but a cover driver's pay is settled at approval, where the rates were
 *     snapshotted. Paying from unapproved days would hand over cash a manager
 *     hasn't signed off.
 *   * The rates come from the snapshot on the approved row, never from the
 *     driver's current profile — so changing someone's rate can't silently
 *     restate a week that's already been approved.
 *
 * Cash only: every hour is cash, so there is no NI/bank split to apply.
 */
export function buildCoverDriverWageLines(
  storeId: string,
  rows: CoverDriverPayRow[],
): WageLine[] {
  const byDriver = new Map<
    string,
    {
      name: string;
      hours: number;
      rate: number;
      short: number;
      long: number;
      shortRate: number;
      longRate: number;
    }
  >();

  for (const r of rows) {
    if (!r.approved) continue;
    if (r.store_id !== storeId) continue;

    const hours = Number(r.total_hours_worked) || 0;
    const rate = Number(r.hourly_rate_snapshot) || 0;
    const short = Math.max(0, Math.round(Number(r.short_deliveries) || 0));
    const long = Math.max(0, Math.round(Number(r.long_deliveries) || 0));
    const shortRate = Number(r.short_rate_snapshot) || 0;
    const longRate = Number(r.long_rate_snapshot) || 0;

    const acc = byDriver.get(r.cover_driver_id) ?? {
      name: r.driver_name,
      hours: 0,
      rate,
      short: 0,
      long: 0,
      shortRate,
      longRate,
    };
    acc.hours += hours;
    acc.short += short;
    acc.long += long;
    // Rates are snapshot per day. If a rate changed mid-week the later day
    // wins for display, but the money below is summed per day so the total
    // stays correct either way.
    acc.rate = rate || acc.rate;
    acc.shortRate = shortRate || acc.shortRate;
    acc.longRate = longRate || acc.longRate;
    byDriver.set(r.cover_driver_id, acc);
  }

  // Sum the money per DAY, not from the aggregated hours × a single rate, so a
  // mid-week rate change is paid exactly as approved.
  const moneyByDriver = new Map<string, { cash: number; delivery: number }>();
  for (const r of rows) {
    if (!r.approved || r.store_id !== storeId) continue;
    const cash =
      (Number(r.total_hours_worked) || 0) * (Number(r.hourly_rate_snapshot) || 0);
    const delivery =
      (Number(r.short_deliveries) || 0) * (Number(r.short_rate_snapshot) || 0) +
      (Number(r.long_deliveries) || 0) * (Number(r.long_rate_snapshot) || 0);
    const acc = moneyByDriver.get(r.cover_driver_id) ?? { cash: 0, delivery: 0 };
    acc.cash += cash;
    acc.delivery += delivery;
    moneyByDriver.set(r.cover_driver_id, acc);
  }

  const lines: WageLine[] = [];
  for (const [driverId, acc] of byDriver) {
    const money = moneyByDriver.get(driverId) ?? { cash: 0, delivery: 0 };
    const cashWage = round2(money.cash);
    const deliveryWages = round2(money.delivery);
    const total = round2(cashWage + deliveryWages);
    if (total <= 0) continue;

    lines.push({
      employee_id: "",
      cover_driver_id: driverId,
      is_cover_driver: true,
      employee_name: acc.name,
      role: "Cover Driver",
      cash_hours: round2(acc.hours),
      cash_rate: acc.rate,
      cash_wage: cashWage,
      short_deliveries_count: acc.short,
      long_deliveries_count: acc.long,
      // Cover drivers record deliveries as a single count per type; there is no
      // separate "miscellaneous" round to split out.
      short_misc_count: 0,
      long_misc_count: 0,
      short_delivery_rate: acc.shortRate,
      long_delivery_rate: acc.longRate,
      delivery_wages: deliveryWages,
      total_payment: total,
    });
  }
  return lines;
}
