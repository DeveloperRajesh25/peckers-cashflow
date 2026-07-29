// =============================================================
// Cover driver hours + pay maths.
//
// Employees are summarised per ISO WEEK (lib/utils groupClockEventsByWeek);
// cover drivers are summarised per DAY, because each cover shift is a discrete
// ad-hoc engagement that is approved and paid on its own. That is why this
// lives here instead of being bolted onto the weekly helper.
// =============================================================

import { clockedHours, weekdayIndex } from "./utils";
import type {
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverDaySummary,
  CoverDriverScheduleDay,
  CoverDriverShift,
} from "./types";

/** The expected shift for a cover driver on one date, whatever its source. */
export type CoverDriverEffShift = {
  is_day_off: boolean;
  start_time: string | null;
  end_time: string | null;
  scheduled_hours: number | null;
  /** True when this came from the weekly pattern, not a per-date rota cell. */
  fromTemplate: boolean;
};

/**
 * What a cover driver is expected to work on a given date.
 *
 * Precedence mirrors the employee board: a per-date `cover_driver_shifts` row
 * wins, else their recurring weekly availability, else nothing (TBC). Shared by
 * the Live dashboard and the Rota grid so the two can never disagree about
 * whether someone is expected in.
 */
export function resolveCoverDriverShift(
  shift: CoverDriverShift | null | undefined,
  schedule: CoverDriverScheduleDay | null | undefined,
): CoverDriverEffShift | null {
  if (shift) {
    return {
      is_day_off: shift.is_day_off,
      start_time: shift.start_time,
      end_time: shift.end_time,
      scheduled_hours: Number(shift.scheduled_hours) || null,
      fromTemplate: false,
    };
  }
  if (schedule?.is_working && schedule.start_time) {
    return {
      is_day_off: false,
      start_time: schedule.start_time,
      end_time: schedule.end_time,
      scheduled_hours: null,
      fromTemplate: true,
    };
  }
  return null;
}

/** Mon=0..Sun=6 index for a date string, matching the schedule tables. */
export function weekdayOf(dateIso: string): number {
  return weekdayIndex(new Date(`${dateIso}T00:00:00`));
}

/**
 * Cash due for one cover-driver day. Deliveries are paid on top of hours:
 *   hours * hourly_cash_rate
 *   + short deliveries * short_delivery_rate
 *   + long deliveries  * long_delivery_rate
 *
 * There is no NI/bank split — every hour is cash.
 */
export function coverDriverPay(input: {
  hours: number;
  hourlyRate: number;
  shortDeliveries?: number | null;
  longDeliveries?: number | null;
  shortRate?: number | null;
  longRate?: number | null;
}): number {
  const hoursPay = (Number(input.hours) || 0) * (Number(input.hourlyRate) || 0);
  const shortPay = (Number(input.shortDeliveries) || 0) * (Number(input.shortRate) || 0);
  const longPay = (Number(input.longDeliveries) || 0) * (Number(input.longRate) || 0);
  return hoursPay + shortPay + longPay;
}

/**
 * Total deliveries of one type for a day. Matches lib/cash-flow.ts: the "extra"
 * counts are deliveries BEYOND the normal round, so they add to the base count
 * rather than replacing it.
 */
export function totalDeliveries(
  base: number | null | undefined,
  extra: number | null | undefined,
): number {
  return (Number(base) || 0) + (Number(extra) || 0);
}

/** One row per completed clock day, with pay computed at the driver's current rates. */
export function summariseCoverDriverDays(
  events: CoverDriverClockEvent[],
  drivers: CoverDriver[],
): CoverDriverDaySummary[] {
  const byId = new Map(drivers.map((d) => [d.id, d]));

  return events
    .filter((e) => e.clock_in_at && e.clock_out_at)
    .map((e) => {
      const driver = byId.get(e.cover_driver_id);
      const hours = clockedHours(e.clock_in_at, e.clock_out_at);
      const short = totalDeliveries(e.short_deliveries_count, e.extra_short_deliveries);
      const long = totalDeliveries(e.long_deliveries_count, e.extra_long_deliveries);
      const hourlyRate = Number(driver?.hourly_cash_rate ?? 0);
      const shortRate = driver?.short_delivery_rate ?? null;
      const longRate = driver?.long_delivery_rate ?? null;

      return {
        cover_driver_id: e.cover_driver_id,
        driver_name: driver?.name ?? "—",
        store_id: e.store_id,
        work_date: e.event_date,
        total_hours: hours,
        short_deliveries: short,
        long_deliveries: long,
        hourly_cash_rate: hourlyRate,
        short_delivery_rate: shortRate,
        long_delivery_rate: longRate,
        total_pay: coverDriverPay({
          hours,
          hourlyRate,
          shortDeliveries: short,
          longDeliveries: long,
          shortRate,
          longRate,
        }),
      };
    })
    .sort((a, b) => {
      const d = b.work_date.localeCompare(a.work_date);
      return d !== 0 ? d : a.driver_name.localeCompare(b.driver_name);
    });
}
