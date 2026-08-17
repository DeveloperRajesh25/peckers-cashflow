// =============================================================
// Early clock-in — the ONE rule, shared by the client pre-check and the server
// gate (migration 043).
//
// An employee booked at 17:00 who clocks in at 16:30 is paid for the extra half
// hour. Rather than block that (managers do sometimes ask someone to start
// early), the clock-in is refused until they enter a code the manager reads out.
//
// CrewClockApp evaluates the rule from props it already holds, so an ON-TIME
// clock-in still makes exactly one server call and gains no round-trip. That
// client check is a routing optimisation only — performClockIn evaluates the
// same rule server-side and refuses independently, or the gate would be
// bypassable by calling the action directly.
//
// Deliberately pure: no Node, no Supabase, nothing that cannot reach a client
// bundle. generateOtp lives in app/actions/early-clock-in.ts instead, because it
// needs node:crypto (same split as credentials.ts / password-reset.ts).
// =============================================================

import { timeToMinutes } from "@/lib/utils";

/**
 * How many minutes before the booked start still count as on time. Zero today —
 * clocking in at or after the scheduled minute never asks for a code. Named so
 * it can be widened without hunting for the comparison.
 */
export const EARLY_CLOCK_IN_GRACE_MINUTES = 0;

/** How long a code stays live. Also bounds how stale the request-time geofence
 *  verdict can be, since consuming the code takes no location of its own. */
export const EARLY_OTP_TTL_MS = 20 * 60_000;

/** Wrong codes before the request locks and the manager must issue a new one. */
export const EARLY_OTP_MAX_ATTEMPTS = 5;

/**
 * The booked start to measure earliness against, in minutes, or null when there
 * is nothing to be early for.
 *
 * Only a BOOKING counts. `employee_schedules` is availability — a recurring
 * pattern that never creates a shift (see CLAUDE.md) — so a day with no
 * `rota_shifts` row, a day off, or a booking with no start time all clock in
 * exactly as they do today.
 */
export function bookableStartMinutes(
  shift: { is_day_off?: boolean | null; start_time: string | null } | null,
): number | null {
  if (!shift || shift.is_day_off || !shift.start_time) return null;
  return timeToMinutes(shift.start_time);
}

/**
 * `nowMinutes` and `scheduledStartMinutes` are both LONDON wall-clock minutes —
 * derived through londonHHMM + timeToMinutes, never Date#getHours(), which
 * answers in whatever timezone the reader happens to be in.
 */
export function isEarlyClockIn(args: {
  nowMinutes: number;
  scheduledStartMinutes: number | null;
  hasSessionToday: boolean;
}): boolean {
  if (args.scheduledStartMinutes == null) return false;
  // Second and later shifts are never gated: they are already on site, and the
  // morning's clock-in verified them.
  if (args.hasSessionToday) return false;
  return args.nowMinutes < args.scheduledStartMinutes - EARLY_CLOCK_IN_GRACE_MINUTES;
}

export function minutesEarly(nowMinutes: number, startMinutes: number): number {
  return Math.max(0, startMinutes - nowMinutes);
}
