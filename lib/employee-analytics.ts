// =============================================================
// Personal analytics for the crew portal (/employee/analytics).
//
// Pure computation over an employee's OWN clock_events: hours, deliveries and
// what those are worth. No I/O, no React.
//
// The money here MUST agree with the Tuesday payout, so it is priced with the
// payout's own rules rather than a second set:
//   - hours per day come from resolvedDayHours (what payroll reads);
//   - the NI/cash split uses cashHoursFromStoreTotal from lib/cash-flow, the
//     same function buildWageLinesForStore uses;
//   - delivery pay uses the employee's own per-drop rates, falling back to
//     DELIVERY_PETROL_RATE exactly as the payout sheet does.
//
// The one thing this adds is DAY-level pricing. The NI/bank allowance is a
// WEEKLY rule, but a month doesn't start on a Monday — so each week's allowance
// is filled chronologically across that week's days, which reproduces the
// weekly split exactly while still letting days be re-bucketed into months.
//
// Every panel on the page has its OWN date window, chosen by the employee. The
// windows are resolved from URL params by resolveSelection() so the server can
// fetch the right rows; buildEmployeeAnalytics() then buckets one day-priced
// list into all of them.
// =============================================================

import {
  DELIVERY_PETROL_RATE,
  cashHoursFromStoreTotal,
  round2,
  worksForCash,
} from "@/lib/cash-flow";
import { hasRole } from "@/lib/types";
import {
  MONTH_SHORT,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  addDays,
  endOfISOWeek,
  londonHHMM,
  pad,
  parseISODate,
  resolvedDayHours,
  startOfISOWeek,
  toISODate,
  weekdayIndex,
} from "@/lib/utils";

/** Weeks in the week-by-week chart. */
export const WEEKS_IN_CHART = 4;
/** Months in the month-by-month chart. */
export const MONTHS_IN_CHART = 6;
/** Weeks the working-pattern panels describe. */
export const PATTERN_WEEKS = 4;
/** Weeks of deliveries shown until the employee picks a different span. */
export const DEFAULT_DELIVERY_WEEKS = 4;
/** Spans offered on the deliveries panel. */
export const DELIVERY_WEEK_OPTIONS = [1, 2, 3, 4, 8, 12];
/**
 * How far back any picker can reach. Bounded so a hand-edited URL can't ask for
 * an unbounded scan, and because attendance older than a year is a payroll
 * question for a manager, not a self-service one.
 */
export const MAX_HISTORY_MONTHS = 12;

/** The subset of a clock_events row this module reads. */
export type AnalyticsClockRow = {
  event_date: string;
  store_id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  worked_hours?: number | null;
  hours_approved?: boolean | null;
  approved_hours?: number | null;
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
};

/** The employee fields that decide what an hour or a drop is worth. */
export type AnalyticsEmployee = {
  store_id?: string | null;
  position?: string | null;
  hourly_rate?: number | null;
  hourly_ni_rate?: number | null;
  hourly_cash_rate?: number | null;
  bank_weekly_hours_limit?: number | null;
  short_delivery_rate?: number | null;
  long_delivery_rate?: number | null;
};

export type PayRates = {
  /** On-the-books rate. Same precedence the rest of the app uses: NI rate, else the legacy hourly_rate. */
  niRate: number;
  cashRate: number;
  shortRate: number;
  longRate: number;
  bankLimit: number;
  isDriver: boolean;
  paidAnyCash: boolean;
  /** False when no rate is set at all — the view shows hours only rather than £0.00. */
  hasRates: boolean;
};

export function resolvePayRates(emp: AnalyticsEmployee): PayRates {
  const isDriver = hasRole(emp.position ?? null, "Driver");
  const niRate = Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0) || 0;
  const cashRate = Number(emp.hourly_cash_rate ?? 0) || 0;
  return {
    niRate,
    cashRate,
    shortRate: isDriver
      ? emp.short_delivery_rate != null
        ? Number(emp.short_delivery_rate) || 0
        : DELIVERY_PETROL_RATE
      : 0,
    longRate: isDriver
      ? emp.long_delivery_rate != null
        ? Number(emp.long_delivery_rate) || 0
        : DELIVERY_PETROL_RATE
      : 0,
    bankLimit: Math.max(0, Number(emp.bank_weekly_hours_limit ?? 20) || 0),
    isDriver,
    paidAnyCash: worksForCash(emp),
    hasRates: niRate > 0 || cashRate > 0,
  };
}

/** Hours, drops and pay for a period. Every bucket on the page is one of these. */
export type Totals = {
  hours: number;
  bankHours: number;
  cashHours: number;
  bankPay: number;
  cashPay: number;
  deliveryPay: number;
  totalPay: number;
  /** Short / long drops on the normal round. */
  sd: number;
  ld: number;
  /** Short / long "miscellaneous" extras, paid at the same per-type rate. */
  sm: number;
  lm: number;
  deliveries: number;
  daysWorked: number;
};

export type DayTotals = Totals & { date: string };

export type Bucket = Totals & {
  key: string;
  label: string;
  /** The bucket in progress — its total is still accruing. */
  isCurrent: boolean;
};

export type WeekdayBucket = {
  index: number;
  short: string;
  long: string;
  hours: number;
  totalPay: number;
  daysWorked: number;
};

/** Which window each panel is showing. Every field is an anchor: the LAST
 *  week/month in that panel's range. */
export type AnalyticsSelection = {
  /** Monday of the newest week in the week-by-week chart. */
  weeksEnd: string;
  /** First of the newest month in the month-by-month chart. */
  monthsEnd: string;
  /** Monday of the newest week on the deliveries panel. */
  deliveriesEnd: string;
  /** How many weeks the deliveries panel covers, ending at deliveriesEnd. */
  deliveryWeeks: number;
  /** Monday of the newest week the pattern panels describe. */
  patternEnd: string;
};

/** A resolved range, ready to label and to bound a picker. */
export type RangeInfo = {
  start: string;
  end: string;
  label: string;
  /** Earliest / latest anchor the picker may choose. */
  minAnchor: string;
  maxAnchor: string;
  anchor: string;
};

export type EmployeeAnalytics = {
  rates: PayRates;
  selection: AnalyticsSelection;

  weeks: Bucket[];
  weeksRange: RangeInfo;
  months: Bucket[];
  monthsRange: RangeInfo;
  monthsTotal: Totals;

  /** Per-week deliveries for the chosen span, newest last. */
  deliveryWeeks: Bucket[];
  deliveryRange: RangeInfo;
  deliveryTotal: Totals;

  weekdays: WeekdayBucket[];
  patternRange: RangeInfo;
  pattern: Totals;

  thisWeek: Totals;
  lastWeek: Totals;
  thisMonth: Totals;
  lastMonth: Totals;

  avgHoursPerWeek: number;
  avgPayPerWeek: number;
  avgDayLength: number;
  avgDaysPerWeek: number;
  busiestWeekday: WeekdayBucket | null;
  bestWeek: Bucket | null;
  typicalStart: string | null;
  typicalFinish: string | null;
  longestStreak: number;
  /** Nothing worked anywhere in the fetched range — drives the empty state. */
  isEmpty: boolean;
};

// ---------------- selection ----------------

function firstOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function clampIso(iso: string, min: string, max: string) {
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
}

function parseAnchor(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = parseISODate(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve every panel's window from the URL. Anything missing, unparseable or
 * out of bounds falls back to "the most recent window", which is what an
 * employee opening the page cold expects to see.
 *
 * Anchors are snapped — a week anchor to its Monday, a month anchor to the 1st —
 * so any date the employee taps in the calendar lands on a valid window.
 */
export function resolveSelection(
  params: {
    w?: string;
    m?: string;
    d?: string;
    dn?: string;
    p?: string;
  },
  today: Date = new Date(),
): AnalyticsSelection {
  const thisWeek = toISODate(startOfISOWeek(today));
  const minWeek = toISODate(
    startOfISOWeek(new Date(today.getFullYear(), today.getMonth() - MAX_HISTORY_MONTHS, 1)),
  );
  const thisMonth = toISODate(firstOfMonth(today));
  const minMonth = toISODate(
    new Date(today.getFullYear(), today.getMonth() - MAX_HISTORY_MONTHS, 1),
  );

  const week = (raw: string | undefined) => {
    const parsed = parseAnchor(raw);
    return parsed ? clampIso(toISODate(startOfISOWeek(parsed)), minWeek, thisWeek) : thisWeek;
  };

  const monthRaw = parseAnchor(params.m);
  const monthsEnd = monthRaw
    ? clampIso(toISODate(firstOfMonth(monthRaw)), minMonth, thisMonth)
    : thisMonth;

  const requestedSpan = Number(params.dn);
  const deliveryWeeks = DELIVERY_WEEK_OPTIONS.includes(requestedSpan)
    ? requestedSpan
    : DEFAULT_DELIVERY_WEEKS;

  return {
    weeksEnd: week(params.w),
    monthsEnd,
    deliveriesEnd: week(params.d),
    deliveryWeeks,
    patternEnd: week(params.p),
  };
}

function weekRangeStart(endMondayIso: string, count: number): string {
  return toISODate(addDays(parseISODate(endMondayIso), -7 * (count - 1)));
}

function shortDate(d: Date) {
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}

/**
 * "13 Jul – 3 Aug". The end is clamped to today when the newest week is the one
 * in progress — advertising a range that runs to next Sunday invites the reader
 * to wonder why days they haven't worked yet are missing.
 */
function weekRangeLabel(startIso: string, endMondayIso: string, today: Date) {
  const start = parseISODate(startIso);
  const weekEnd = endOfISOWeek(parseISODate(endMondayIso));
  const todayIso = toISODate(today);
  const end = toISODate(weekEnd) > todayIso ? parseISODate(todayIso) : weekEnd;
  return `${shortDate(start)} – ${shortDate(end)}`;
}

function monthRangeLabel(startIso: string, endIso: string) {
  const start = parseISODate(startIso);
  const end = parseISODate(endIso);
  const startLabel = `${MONTH_SHORT[start.getMonth()]}${
    start.getFullYear() === end.getFullYear() ? "" : ` ${start.getFullYear()}`
  }`;
  return `${startLabel} – ${MONTH_SHORT[end.getMonth()]} ${end.getFullYear()}`;
}

/**
 * The date range the page must fetch: every panel's window, plus the current
 * week and the previous month — the headline cards always report "this week"
 * and "last month" no matter which history the employee is browsing.
 *
 * Both ends are snapped to week boundaries. The NI allowance is filled per ISO
 * week, so a range starting mid-week would price that week's first days as if
 * the allowance were untouched.
 */
export function analyticsFetchRange(
  sel: AnalyticsSelection,
  today: Date = new Date(),
): { start: string; end: string } {
  const candidates = [
    weekRangeStart(sel.weeksEnd, WEEKS_IN_CHART),
    sel.monthsEnd,
    toISODate(
      new Date(
        parseISODate(sel.monthsEnd).getFullYear(),
        parseISODate(sel.monthsEnd).getMonth() - (MONTHS_IN_CHART - 1),
        1,
      ),
    ),
    weekRangeStart(sel.deliveriesEnd, sel.deliveryWeeks),
    weekRangeStart(sel.patternEnd, PATTERN_WEEKS),
    toISODate(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
  ];
  const start = candidates.reduce((min, c) => (c < min ? c : min), candidates[0]);

  const ends = [
    toISODate(endOfISOWeek(parseISODate(sel.weeksEnd))),
    toISODate(endOfISOWeek(parseISODate(sel.deliveriesEnd))),
    toISODate(endOfISOWeek(parseISODate(sel.patternEnd))),
    toISODate(
      new Date(
        parseISODate(sel.monthsEnd).getFullYear(),
        parseISODate(sel.monthsEnd).getMonth() + 1,
        0,
      ),
    ),
    toISODate(endOfISOWeek(today)),
  ];
  // Never past the end of the current week — no clock row can exist beyond it,
  // and a month window ending in the current month would otherwise stretch the
  // query weeks into the future.
  const thisWeekEnd = toISODate(endOfISOWeek(today));
  const end = ends.reduce((max, c) => (c > max ? c : max), ends[0]);

  return {
    start: toISODate(startOfISOWeek(parseISODate(start))),
    end: end > thisWeekEnd ? thisWeekEnd : toISODate(endOfISOWeek(parseISODate(end))),
  };
}

// ---------------- helpers ----------------

/** Minutes since midnight, UK wall clock. Null on a missing/unparseable stamp. */
function londonMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const [h, m] = londonHHMM(d).split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Median, not mean: one 03:00 finish after a late close would drag an average
 * clock-out an hour later than the shift this employee actually works.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function minutesToHHMM(mins: number | null): string | null {
  if (mins == null) return null;
  const rounded = Math.round(mins) % (24 * 60);
  return `${pad(Math.floor(rounded / 60))}:${pad(rounded % 60)}`;
}

/** Enough days to describe a habit. Below this, a "typical" time is noise. */
const MIN_DAYS_FOR_TYPICAL = 3;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function emptyTotals(): Totals {
  return {
    hours: 0,
    bankHours: 0,
    cashHours: 0,
    bankPay: 0,
    cashPay: 0,
    deliveryPay: 0,
    totalPay: 0,
    sd: 0,
    ld: 0,
    sm: 0,
    lm: 0,
    deliveries: 0,
    daysWorked: 0,
  };
}

function addTotals(acc: Totals, d: Totals): Totals {
  acc.hours += d.hours;
  acc.bankHours += d.bankHours;
  acc.cashHours += d.cashHours;
  acc.bankPay += d.bankPay;
  acc.cashPay += d.cashPay;
  acc.deliveryPay += d.deliveryPay;
  acc.totalPay += d.totalPay;
  acc.sd += d.sd;
  acc.ld += d.ld;
  acc.sm += d.sm;
  acc.lm += d.lm;
  acc.deliveries += d.deliveries;
  acc.daysWorked += d.daysWorked;
  return acc;
}

function roundTotals(t: Totals): Totals {
  return {
    ...t,
    hours: round1(t.hours),
    bankHours: round1(t.bankHours),
    cashHours: round1(t.cashHours),
    bankPay: round2(t.bankPay),
    cashPay: round2(t.cashPay),
    deliveryPay: round2(t.deliveryPay),
    totalPay: round2(t.totalPay),
  };
}

function sumDays(days: DayTotals[]): Totals {
  return roundTotals(days.reduce(addTotals, emptyTotals()));
}

/**
 * Price every worked day. Days are grouped into ISO weeks and the week's NI/bank
 * allowance is consumed in date order at the HOME store; hours at any other
 * store are cash from the first minute. That reproduces
 * cashHoursFromStoreTotal's weekly answer day by day.
 */
export function buildDayTotals(
  rows: AnalyticsClockRow[],
  rates: PayRates,
  emp: AnalyticsEmployee,
): DayTotals[] {
  const byWeek = new Map<string, AnalyticsClockRow[]>();
  for (const r of rows) {
    const key = toISODate(startOfISOWeek(parseISODate(r.event_date)));
    const arr = byWeek.get(key) ?? [];
    arr.push(r);
    byWeek.set(key, arr);
  }

  const out: DayTotals[] = [];
  for (const week of byWeek.values()) {
    week.sort((a, b) => a.event_date.localeCompare(b.event_date));
    let bankAllowanceLeft = rates.bankLimit;

    for (const row of week) {
      const hours = resolvedDayHours(row);
      const sd = Math.max(0, Math.round(Number(row.short_deliveries_count) || 0));
      const ld = Math.max(0, Math.round(Number(row.long_deliveries_count) || 0));
      const sm = Math.max(0, Math.round(Number(row.extra_short_deliveries) || 0));
      const lm = Math.max(0, Math.round(Number(row.extra_long_deliveries) || 0));
      const deliveries = rates.isDriver ? sd + ld + sm + lm : 0;
      if (hours <= 0 && deliveries === 0) continue;

      // The rule, per store, for this day's hours only.
      const cashHours = cashHoursFromStoreTotal(hours, row.store_id, {
        store_id: emp.store_id,
        hourly_cash_rate: emp.hourly_cash_rate,
        // At the home store the allowance is whatever the week has left, not
        // the full weekly limit — earlier days in the week already used some.
        bank_weekly_hours_limit: bankAllowanceLeft,
      });
      const bankHours = Math.max(0, hours - cashHours);
      if (row.store_id === emp.store_id) {
        bankAllowanceLeft = Math.max(0, bankAllowanceLeft - bankHours);
      }

      const deliveryPay = rates.isDriver
        ? (sd + sm) * rates.shortRate + (ld + lm) * rates.longRate
        : 0;
      const bankPay = bankHours * rates.niRate;
      const cashPay = cashHours * rates.cashRate;

      out.push({
        date: row.event_date,
        hours,
        bankHours,
        cashHours,
        bankPay,
        cashPay,
        deliveryPay,
        totalPay: bankPay + cashPay + deliveryPay,
        sd: rates.isDriver ? sd : 0,
        ld: rates.isDriver ? ld : 0,
        sm: rates.isDriver ? sm : 0,
        lm: rates.isDriver ? lm : 0,
        deliveries,
        daysWorked: hours > 0 ? 1 : 0,
      });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------- bucketing ----------------

function weekBuckets(
  days: DayTotals[],
  endMondayIso: string,
  count: number,
  thisWeekIso: string,
): Bucket[] {
  const end = parseISODate(endMondayIso);
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(end, -7 * (count - 1 - i));
    const startIso = toISODate(start);
    const endIso = toISODate(addDays(start, 6));
    return {
      key: startIso,
      // Unpadded d/M ("3/8", not "03/08") — labels have to fit across a phone.
      label: `${start.getDate()}/${start.getMonth() + 1}`,
      isCurrent: startIso === thisWeekIso,
      ...sumDays(days.filter((d) => d.date >= startIso && d.date <= endIso)),
    };
  });
}

function monthBuckets(
  days: DayTotals[],
  endMonthIso: string,
  count: number,
  thisMonthIso: string,
): Bucket[] {
  const end = parseISODate(endMonthIso);
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(end.getFullYear(), end.getMonth() - (count - 1 - i), 1);
    const startIso = toISODate(start);
    const endIso = toISODate(new Date(start.getFullYear(), start.getMonth() + 1, 0));
    return {
      key: startIso,
      label: MONTH_SHORT[start.getMonth()],
      isCurrent: startIso === thisMonthIso,
      ...sumDays(days.filter((d) => d.date >= startIso && d.date <= endIso)),
    };
  });
}

function daysIn(days: DayTotals[], startIso: string, endIso: string) {
  return days.filter((d) => d.date >= startIso && d.date <= endIso);
}

export function buildEmployeeAnalytics(
  rows: AnalyticsClockRow[],
  emp: AnalyticsEmployee,
  selection: AnalyticsSelection,
  today: Date = new Date(),
): EmployeeAnalytics {
  const rates = resolvePayRates(emp);
  // A day still in progress has no clock-out, so resolvedDayHours returns 0 and
  // it counts as "not yet worked" until the employee clocks out. That is the
  // honest reading — neither the hours nor the pay are final while it runs.
  const days = buildDayTotals(rows, rates, emp);

  const thisWeekIso = toISODate(startOfISOWeek(today));
  const lastWeekIso = toISODate(addDays(startOfISOWeek(today), -7));
  const thisMonthIso = toISODate(firstOfMonth(today));
  const lastMonthIso = toISODate(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  const minWeekIso = toISODate(
    startOfISOWeek(new Date(today.getFullYear(), today.getMonth() - MAX_HISTORY_MONTHS, 1)),
  );
  const minMonthIso = toISODate(
    new Date(today.getFullYear(), today.getMonth() - MAX_HISTORY_MONTHS, 1),
  );

  const oneWeek = (mondayIso: string) =>
    sumDays(daysIn(days, mondayIso, toISODate(addDays(parseISODate(mondayIso), 6))));
  const oneMonth = (firstIso: string) => {
    const first = parseISODate(firstIso);
    return sumDays(
      daysIn(days, firstIso, toISODate(new Date(first.getFullYear(), first.getMonth() + 1, 0))),
    );
  };

  const weeks = weekBuckets(days, selection.weeksEnd, WEEKS_IN_CHART, thisWeekIso);
  const months = monthBuckets(days, selection.monthsEnd, MONTHS_IN_CHART, thisMonthIso);
  const deliveryWeeks = weekBuckets(
    days,
    selection.deliveriesEnd,
    selection.deliveryWeeks,
    thisWeekIso,
  );

  const patternStartIso = weekRangeStart(selection.patternEnd, PATTERN_WEEKS);
  const patternEndIso = toISODate(endOfISOWeek(parseISODate(selection.patternEnd)));
  const patternDays = daysIn(days, patternStartIso, patternEndIso);
  const patternWeeks = weekBuckets(days, selection.patternEnd, PATTERN_WEEKS, thisWeekIso);

  const weekdays: WeekdayBucket[] = WEEKDAY_SHORT.map((short, index) => ({
    index,
    short,
    long: WEEKDAY_LONG[index],
    hours: 0,
    totalPay: 0,
    daysWorked: 0,
  }));

  const startMinutes: number[] = [];
  const finishMinutes: number[] = [];
  const rowByDate = new Map(rows.map((r) => [r.event_date, r]));

  for (const d of patternDays) {
    const wd = weekdays[weekdayIndex(parseISODate(d.date))];
    wd.hours += d.hours;
    wd.totalPay += d.totalPay;
    wd.daysWorked += d.daysWorked;

    if (d.hours <= 0) continue;
    const row = rowByDate.get(d.date);
    const inMins = londonMinutes(row?.clock_in_at);
    const outMins = londonMinutes(row?.clock_out_at);
    if (inMins != null) startMinutes.push(inMins);
    if (outMins != null) finishMinutes.push(outMins);
  }
  for (const w of weekdays) {
    w.hours = round1(w.hours);
    w.totalPay = round2(w.totalPay);
  }

  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of patternDays) {
    if (d.daysWorked === 0) continue;
    const isNext = prev != null && toISODate(addDays(parseISODate(prev), 1)) === d.date;
    run = isNext ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d.date;
  }

  const pattern = sumDays(patternDays);
  const weeksWithWork = patternWeeks.filter((w) => w.hours > 0 || w.totalPay > 0);
  const busiestWeekday = weekdays.reduce<WeekdayBucket | null>(
    (best, w) => (w.hours > 0 && (!best || w.hours > best.hours) ? w : best),
    null,
  );
  const bestWeek = patternWeeks.reduce<Bucket | null>(
    (best, w) => (w.hours > 0 && (!best || w.hours > best.hours) ? w : best),
    null,
  );
  const enoughForTypical = pattern.daysWorked >= MIN_DAYS_FOR_TYPICAL;

  const weeksStart = weekRangeStart(selection.weeksEnd, WEEKS_IN_CHART);
  const monthsStart = toISODate(
    new Date(
      parseISODate(selection.monthsEnd).getFullYear(),
      parseISODate(selection.monthsEnd).getMonth() - (MONTHS_IN_CHART - 1),
      1,
    ),
  );
  const deliveryStart = weekRangeStart(selection.deliveriesEnd, selection.deliveryWeeks);

  return {
    rates,
    selection,

    weeks,
    weeksRange: {
      start: weeksStart,
      end: selection.weeksEnd,
      label: weekRangeLabel(weeksStart, selection.weeksEnd, today),
      anchor: selection.weeksEnd,
      minAnchor: toISODate(addDays(parseISODate(minWeekIso), 7 * (WEEKS_IN_CHART - 1))),
      maxAnchor: thisWeekIso,
    },
    months,
    monthsRange: {
      start: monthsStart,
      end: selection.monthsEnd,
      label: monthRangeLabel(monthsStart, selection.monthsEnd),
      anchor: selection.monthsEnd,
      minAnchor: toISODate(
        new Date(
          parseISODate(minMonthIso).getFullYear(),
          parseISODate(minMonthIso).getMonth() + (MONTHS_IN_CHART - 1),
          1,
        ),
      ),
      maxAnchor: thisMonthIso,
    },
    monthsTotal: roundTotals(months.reduce(addTotals, emptyTotals())),

    deliveryWeeks,
    deliveryRange: {
      start: deliveryStart,
      end: selection.deliveriesEnd,
      label: weekRangeLabel(deliveryStart, selection.deliveriesEnd, today),
      anchor: selection.deliveriesEnd,
      minAnchor: toISODate(
        addDays(parseISODate(minWeekIso), 7 * (selection.deliveryWeeks - 1)),
      ),
      maxAnchor: thisWeekIso,
    },
    deliveryTotal: roundTotals(deliveryWeeks.reduce(addTotals, emptyTotals())),

    weekdays,
    patternRange: {
      start: patternStartIso,
      end: selection.patternEnd,
      label: weekRangeLabel(patternStartIso, selection.patternEnd, today),
      anchor: selection.patternEnd,
      minAnchor: toISODate(addDays(parseISODate(minWeekIso), 7 * (PATTERN_WEEKS - 1))),
      maxAnchor: thisWeekIso,
    },
    pattern,

    thisWeek: oneWeek(thisWeekIso),
    lastWeek: oneWeek(lastWeekIso),
    thisMonth: oneMonth(thisMonthIso),
    lastMonth: oneMonth(lastMonthIso),

    avgHoursPerWeek: weeksWithWork.length
      ? round1(weeksWithWork.reduce((s, w) => s + w.hours, 0) / weeksWithWork.length)
      : 0,
    avgPayPerWeek: weeksWithWork.length
      ? round2(weeksWithWork.reduce((s, w) => s + w.totalPay, 0) / weeksWithWork.length)
      : 0,
    avgDayLength: pattern.daysWorked ? round1(pattern.hours / pattern.daysWorked) : 0,
    avgDaysPerWeek: weeksWithWork.length
      ? round1(weeksWithWork.reduce((s, w) => s + w.daysWorked, 0) / weeksWithWork.length)
      : 0,
    busiestWeekday,
    bestWeek,
    typicalStart: enoughForTypical ? minutesToHHMM(median(startMinutes)) : null,
    typicalFinish: enoughForTypical ? minutesToHHMM(median(finishMinutes)) : null,
    longestStreak,
    isEmpty: days.length === 0,
  };
}
