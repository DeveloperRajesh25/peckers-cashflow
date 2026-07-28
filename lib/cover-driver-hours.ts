// =============================================================
// Cover driver hours + pay maths.
//
// Employees are summarised per ISO WEEK (lib/utils groupClockEventsByWeek);
// cover drivers are summarised per DAY, because each cover shift is a discrete
// ad-hoc engagement that is approved and paid on its own. That is why this
// lives here instead of being bolted onto the weekly helper.
// =============================================================

import { clockedHours } from "./utils";
import type { CoverDriver, CoverDriverClockEvent, CoverDriverDaySummary } from "./types";

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
