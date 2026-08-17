// Column sets for the Rota and Live pages' big queries. Both Rota pages fetch
// every store's rows (visiting staff and the "away" badge depend on it), so the
// saving has to come from the columns, not a store filter.

import type { EarlyClockInRequest } from "@/lib/types";

export const ROTA_SHIFT_COLUMNS =
  "id, employee_id, store_id, shift_date, start_time, end_time, is_day_off, scheduled_hours, shift_type, same_day_edit_reason";

/** Only what `fourWkAvg` reads — the prior weeks never reach a rota cell. */
export const ROTA_HISTORY_SHIFT_COLUMNS =
  "employee_id, shift_date, scheduled_hours, is_day_off";

export const ROTA_CLOCK_COLUMNS =
  "id, employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, session_count, auto_clocked_out, manual_entry, manual_entry_reason, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries";

// The rota needs each employee's identity, store, rates and DOB (for min-wage
// checks) — but never their bank details. Both pages load every store's staff
// (to schedule visitors), so the sensitive payment columns are deliberately
// omitted rather than shipped to the browser and ignored.
export const ROTA_EMPLOYEE_COLUMNS =
  "id, name, hourly_rate, bank_weekly_hours_limit, is_active, joined_date, date_of_birth, gender, position, employment_start_date, hourly_ni_rate, hourly_cash_rate, store_id, employment_status, short_delivery_rate, long_delivery_rate";

// Live shows today's staffing and wage bill: identity, store, and the rates
// behind expected-vs-actual pay. No DOB (no min-wage check here) and no bank
// details.
export const LIVE_EMPLOYEE_COLUMNS =
  "id, name, position, store_id, employment_status, hourly_rate, hourly_ni_rate";

/** `scheduleByEmpDay` / `effectiveShiftFor` read nothing else off a template. */
export const SCHEDULE_COLUMNS = "employee_id, weekday, is_working, start_time, end_time";

export const COVER_SCHEDULE_COLUMNS =
  "cover_driver_id, weekday, is_working, start_time, end_time";

// Sessions exist on Live only to sum a split day's hours and label it
// "09:00–13:00, 17:00–now" — the geofence coordinates and audit columns are
// never read there.
export const LIVE_CLOCK_SESSION_COLUMNS = "employee_id, clock_in_at, clock_out_at";

// Early clock-in authorisations for Live (migration 043). `otp_code` IS read
// here — the manager has to read it down the phone — which is why RLS keeps
// this table staff-only and the employee's own screen never touches it. The
// request-time coordinates and the attempt count stay on the server.
export const EARLY_CLOCK_IN_COLUMNS =
  "id, employee_id, store_id, event_date, scheduled_start, otp_code, status, requested_at, expires_at, actual_clock_in_at, employees(name), stores(name)";

type EarlyClockInRow = {
  id: string;
  employee_id: string;
  store_id: string;
  event_date: string;
  scheduled_start: string | null;
  otp_code: string;
  status: string;
  requested_at: string;
  expires_at: string;
  actual_clock_in_at: string | null;
  employees?: { name?: string | null } | { name?: string | null }[] | null;
  stores?: { name?: string | null } | { name?: string | null }[] | null;
};

/** PostgREST returns an embedded row as an object or a one-element array
 *  depending on how it infers the relationship; both shapes reach here. */
function embeddedName(rel: EarlyClockInRow["employees"]): string | null {
  const row = Array.isArray(rel) ? rel[0] : rel;
  return row?.name ?? null;
}

export function mapEarlyClockInRows(data: unknown): EarlyClockInRequest[] {
  return ((data ?? []) as EarlyClockInRow[]).map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    employee_name: embeddedName(r.employees) ?? "Unknown",
    store_id: r.store_id,
    store_name: embeddedName(r.stores),
    event_date: r.event_date,
    scheduled_start: r.scheduled_start,
    otp_code: r.otp_code,
    status: r.status as EarlyClockInRequest["status"],
    requested_at: r.requested_at,
    expires_at: r.expires_at,
    actual_clock_in_at: r.actual_clock_in_at,
  }));
}
