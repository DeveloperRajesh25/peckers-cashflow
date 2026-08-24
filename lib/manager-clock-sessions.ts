// =============================================================
// Manager clock sessions — the shifts inside a manager's day (migration 031).
//
// The exact mirror of lib/clock-sessions.ts, one table over.
// manager_clock_events stays ONE row per (manager, day) and remains the header
// every other module reads; each clock-in/out pair lives in
// manager_clock_sessions underneath it, so a manager who opens the store, goes
// home, and comes back for the evening can record both shifts.
//
// The header is derived, never hand-written:
//
//   clock_in_at   first session's in   (never overwritten by a later shift)
//   clock_out_at  last session's out, or NULL while any session is open
//   worked_hours  SUM of completed sessions
//   session_count how many sessions the day has
//
// Nulling clock_out_at while a session is open is deliberate and load-bearing:
// it is what lets every "is this manager on shift" check keep working with no
// change at all — managerStatusOf on the Live board, the Rota's ✓in/out marks,
// the shift-reminder cron, and the auto clock-out sweep's open-row scan.
//
// recomputeManagerDayHeader is the ONLY writer of those four columns, and the
// arithmetic itself is deriveDayHeader from lib/clock-sessions — shared with
// employees so the two halves cannot drift on what a split day totals.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveDayHeader,
  sumSessionDeliveries,
  type DeliveryCounts,
  type DerivedDayHeader,
} from "@/lib/clock-sessions";
import type {
  ManagerClockEvent,
  ManagerClockSession,
  ManagerDailyApprovalRow,
} from "@/lib/types";
import { dayWorkedHours } from "@/lib/utils";

/**
 * Manager days as the Daily Approval screen sees them. Kept pure and shared so
 * the admin and manager pages can't drift on which days are listed or on how a
 * split day's hours are totalled.
 *
 * Days with NO drops are returned too — the screen decides what to show — but
 * a day still open is included as well: a manager can log drops mid-shift and
 * a peer may sign them off before the shift ends.
 */
export function mapManagerDaysToApproval(
  days: ManagerClockEvent[],
  names: Map<string, string>,
): ManagerDailyApprovalRow[] {
  return days.map((d) => ({
    manager_id: d.manager_id,
    manager_name: names.get(d.manager_id) ?? "Manager",
    store_id: d.store_id,
    event_date: d.event_date,
    // Never last-out minus first-in: that spans the gap between two shifts.
    worked_hours: dayWorkedHours(d),
    short_deliveries: Number(d.short_deliveries_count) || 0,
    long_deliveries: Number(d.long_deliveries_count) || 0,
    extra_short_deliveries: Number(d.extra_short_deliveries) || 0,
    extra_long_deliveries: Number(d.extra_long_deliveries) || 0,
    extra_short_reason: d.extra_short_reason ?? null,
    extra_long_reason: d.extra_long_reason ?? null,
    approved: Boolean(d.deliveries_approved),
    auto_clocked_out: Boolean(d.auto_clocked_out),
    session_count: Number(d.session_count) || 0,
    manual_entry: Boolean(d.manual_entry),
    manual_entry_reason: d.manual_entry_reason ?? null,
  }));
}

/**
 * The manager's currently open session, if any — across ALL dates, not just
 * today. A shift started at 22:00 and closed at 01:00 belongs to the day it
 * opened on, so "what am I clocking out of" cannot be answered by today's date.
 */
export async function findOpenManagerSession(
  supabase: SupabaseClient,
  managerId: string,
): Promise<ManagerClockSession | null> {
  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .select("*")
    .eq("manager_id", managerId)
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerClockSession | null) ?? null;
}

/** Every session of a manager's day, earliest first. */
export async function managerSessionsForEvent(
  supabase: SupabaseClient,
  clockEventId: string,
): Promise<ManagerClockSession[]> {
  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .select("*")
    // CHRONOLOGICAL, never by seq — seq is insertion order (see ClockSession).
    .eq("clock_event_id", clockEventId)
    .order("clock_in_at", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ManagerClockSession[];
}

/**
 * Recompute a manager's day header from its sessions. Returns the resolved
 * bounds and totals so the caller doesn't need a re-read.
 */
export async function recomputeManagerDayHeader(
  supabase: SupabaseClient,
  clockEventId: string,
): Promise<DerivedDayHeader> {
  const sessions = await managerSessionsForEvent(supabase, clockEventId);

  // Never derive a header from nothing: with no sessions there is nothing to
  // sum, and writing the nulls would erase a day recorded by an older build.
  if (sessions.length === 0) return deriveDayHeader(sessions);

  // deriveDayHeader is shared with employees and reads `hours_approved`. A
  // manager's shift only ever has its DELIVERIES signed off — their hours are
  // salaried and pay nothing — so the flag is mapped across rather than the
  // shared function learning a second field name for the same idea.
  const mapped = sessions.map((s) => ({ ...s, hours_approved: s.deliveries_approved }));

  // TWO derivations, because a deliveries-only row (migration 037) is a carrier
  // for drops, not a shift. It has no duration and the manager was never here,
  // so it must not put a clock-in on the day: that is what the Live board reads
  // to count their fixed daily wage, and what the Rota reads to mark them
  // present. Times, hours and shift count come from the REAL shifts; the drops
  // and their sign-off come from all of them.
  const derived = deriveDayHeader(mapped.filter((s) => !s.deliveries_only));
  const withDeliveries = deriveDayHeader(mapped);

  // Same rule recomputeDayHeader follows for employees (Update 94): when NO
  // shift carries a count, the sum is not "zero drops" — there is nothing to
  // sum, and the header may still hold counts written before 034 moved them
  // onto the shifts. Writing the derived nulls over the top would erase the
  // only surviving record of that round.
  const sessionsHaveDeliveries =
    withDeliveries.deliveries.short != null ||
    withDeliveries.deliveries.long != null ||
    withDeliveries.deliveries.extraShort > 0 ||
    withDeliveries.deliveries.extraLong > 0;

  const { error } = await supabase
    .from("manager_clock_events")
    .update({
      clock_in_at: derived.firstIn,
      clock_out_at: derived.lastOut,
      worked_hours: derived.completedCount > 0 ? derived.workedHours : null,
      session_count: derived.sessionCount,
      // Same rule as employees: the day follows the store of the shift they're
      // on, so a manager covering elsewhere shows under that store. From the
      // REAL shifts only — a deliveries-only row is not attendance anywhere.
      ...(derived.storeId ? { store_id: derived.storeId } : {}),
      // The day's drop totals are a SUM of its shifts (migration 034), and this
      // is their ONLY writer — the same rule recomputeDayHeader follows for
      // employees, so a manager who did drops on two separate shifts has both
      // counted rather than the later one overwriting the earlier.
      ...(sessionsHaveDeliveries
        ? {
            short_deliveries_count: withDeliveries.deliveries.short,
            long_deliveries_count: withDeliveries.deliveries.long,
            extra_short_deliveries: withDeliveries.deliveries.extraShort,
            extra_long_deliveries: withDeliveries.deliveries.extraLong,
            extra_short_reason: withDeliveries.deliveries.extraShortReason,
            extra_long_reason: withDeliveries.deliveries.extraLongReason,
          }
        : {}),
      // The approved half (migration 035): only signed-off drops are paid.
      approved_short_deliveries_count: withDeliveries.approvedDeliveries.short,
      approved_long_deliveries_count: withDeliveries.approvedDeliveries.long,
      approved_extra_short_deliveries: withDeliveries.approvedDeliveries.extraShort,
      approved_extra_long_deliveries: withDeliveries.approvedDeliveries.extraLong,
      approved_session_count: withDeliveries.approvedSessionCount,
      deliveries_approved: withDeliveries.allApproved,
    })
    .eq("id", clockEventId);
  if (error) throw new Error(error.message);

  // The bounds and hours the caller stamps elsewhere come from the real shifts;
  // the drops it audits must be the day's whole total.
  return { ...derived, deliveries: withDeliveries.deliveries };
}

/**
 * The day's deliveries-only row, if it has one (migration 037). At most one
 * exists — manager_clock_sessions_one_deliveries_only enforces it — so
 * re-recording a manager's missed drops corrects that day rather than paying
 * the same round twice.
 */
export async function findDeliveriesOnlySession(
  supabase: SupabaseClient,
  clockEventId: string,
): Promise<ManagerClockSession | null> {
  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .select("*")
    .eq("clock_event_id", clockEventId)
    .eq("deliveries_only", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerClockSession | null) ?? null;
}

/**
 * Record drops for a day the manager never clocked.
 *
 * Zero-length and closed, deliberately: closed so it can never occupy the
 * one-open-session slot and lock the manager out of clocking in, zero-length so
 * that even a reader which does sum it contributes nothing to worked hours.
 * The caller recomputes the day header afterwards.
 */
export async function insertDeliveriesOnlySession(
  supabase: SupabaseClient,
  input: {
    clockEventId: string;
    managerId: string;
    storeId: string;
    eventDate: string;
    at: string;
    deliveries: DeliveryCounts;
    manual: { by: string; at: string; reason: string };
  },
): Promise<ManagerClockSession> {
  const existing = await managerSessionsForEvent(supabase, input.clockEventId);
  const seq = existing.length > 0 ? Math.max(...existing.map((s) => s.seq)) + 1 : 1;

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .insert({
      clock_event_id: input.clockEventId,
      manager_id: input.managerId,
      store_id: input.storeId,
      event_date: input.eventDate,
      seq,
      clock_in_at: input.at,
      clock_out_at: input.at,
      deliveries_only: true,
      // Null, and it stays null: a row with no coordinates was never verified.
      clock_in_lat: null,
      clock_in_lng: null,
      manual_entry: true,
      manual_entry_by: input.manual.by,
      manual_entry_at: input.manual.at,
      manual_entry_reason: input.manual.reason,
      short_deliveries_count: input.deliveries.short,
      long_deliveries_count: input.deliveries.long,
      extra_short_deliveries: input.deliveries.extraShort,
      extra_long_deliveries: input.deliveries.extraLong,
      extra_short_reason:
        input.deliveries.extraShort > 0 ? input.deliveries.extraShortReason : null,
      extra_long_reason:
        input.deliveries.extraLong > 0 ? input.deliveries.extraLongReason : null,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "Deliveries have already been recorded by hand for that day. Correct them on the approval row instead.",
      );
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Could not record those deliveries. Please try again.");
  return data as ManagerClockSession;
}

/** Sign off (or withdraw) one manager shift's deliveries. */
export async function setManagerSessionApproval(
  supabase: SupabaseClient,
  sessionId: string,
  approval: { approved: boolean; by: string },
): Promise<void> {
  const { error } = await supabase
    .from("manager_clock_sessions")
    .update(
      approval.approved
        ? {
            deliveries_approved: true,
            deliveries_approved_by: approval.by,
            deliveries_approved_at: new Date().toISOString(),
          }
        : {
            deliveries_approved: false,
            deliveries_approved_by: null,
            deliveries_approved_at: null,
          },
    )
    .eq("id", sessionId);
  if (error) throw new Error(error.message);
}

/** Approve every completed manager shift of a day. Returns how many changed. */
export async function approveManagerDaySessions(
  supabase: SupabaseClient,
  clockEventId: string,
  by: string,
): Promise<number> {
  const sessions = await managerSessionsForEvent(supabase, clockEventId);
  const pending = sessions.filter((s) => s.clock_out_at && !s.deliveries_approved);
  for (const s of pending) {
    await setManagerSessionApproval(supabase, s.id, { approved: true, by });
  }
  return pending.length;
}

/** Withdraw approval on every manager shift of a day. Returns how many changed. */
export async function unapproveManagerDaySessions(
  supabase: SupabaseClient,
  clockEventId: string,
  by: string,
): Promise<number> {
  const sessions = await managerSessionsForEvent(supabase, clockEventId);
  const approved = sessions.filter((s) => s.deliveries_approved);
  for (const s of approved) {
    await setManagerSessionApproval(supabase, s.id, { approved: false, by });
  }
  return approved.length;
}

/**
 * Write one manager shift's delivery counts. The caller recomputes the day
 * header afterwards — this never touches manager_clock_events itself, so
 * recomputeManagerDayHeader stays the single writer of the day's totals.
 */
export async function setManagerSessionDeliveries(
  supabase: SupabaseClient,
  sessionId: string,
  deliveries: DeliveryCounts,
): Promise<void> {
  const { error } = await supabase
    .from("manager_clock_sessions")
    .update({
      short_deliveries_count: deliveries.short,
      long_deliveries_count: deliveries.long,
      extra_short_deliveries: deliveries.extraShort,
      extra_long_deliveries: deliveries.extraLong,
      extra_short_reason: deliveries.extraShort > 0 ? deliveries.extraShortReason : null,
      extra_long_reason: deliveries.extraLong > 0 ? deliveries.extraLongReason : null,
    })
    .eq("id", sessionId);
  if (error) throw new Error(error.message);
}

/**
 * Apply a DAY-level drop total a manager typed on Daily Approval onto a day
 * that may hold several shifts. Identical reasoning to applyDayDeliveryTotal
 * for employees: the approver is correcting the day, not a shift, so the
 * difference is settled on the day's LAST shift and the earlier ones keep what
 * was recorded at the time.
 *
 * Returns false when the day has no sessions at all (a pre-031 row); the caller
 * falls back to writing the header directly.
 */
export async function applyManagerDayDeliveryTotal(
  supabase: SupabaseClient,
  clockEventId: string,
  total: DeliveryCounts,
): Promise<boolean> {
  const sessions = await managerSessionsForEvent(supabase, clockEventId);
  if (sessions.length === 0) return false;

  const last = sessions[sessions.length - 1];
  const rest = sumSessionDeliveries(sessions.slice(0, -1));

  // Never let the remainder go negative — lowering a day total below what the
  // earlier shifts already hold would credit a negative drop against the day.
  const remainder: DeliveryCounts = {
    short: total.short == null ? null : Math.max(0, total.short - (rest.short ?? 0)),
    long: total.long == null ? null : Math.max(0, total.long - (rest.long ?? 0)),
    extraShort: Math.max(0, total.extraShort - rest.extraShort),
    extraLong: Math.max(0, total.extraLong - rest.extraLong),
    extraShortReason: total.extraShortReason,
    extraLongReason: total.extraLongReason,
  };

  await setManagerSessionDeliveries(supabase, last.id, remainder);
  return true;
}

/** Manager sessions for many days at once, keyed by manager_clock_events.id. */
export async function managerSessionsByEventId(
  supabase: SupabaseClient,
  clockEventIds: string[],
): Promise<Map<string, ManagerClockSession[]>> {
  const byEvent = new Map<string, ManagerClockSession[]>();
  const ids = Array.from(new Set(clockEventIds.filter(Boolean)));
  if (ids.length === 0) return byEvent;

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .select("*")
    .in("clock_event_id", ids)
    .order("clock_in_at", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);

  for (const s of (data ?? []) as ManagerClockSession[]) {
    const arr = byEvent.get(s.clock_event_id) ?? [];
    arr.push(s);
    byEvent.set(s.clock_event_id, arr);
  }
  return byEvent;
}

/**
 * Start a session on a manager's day. `seq` continues the day's numbering.
 *
 * The caller must have established there is no open session first — the
 * manager_clock_sessions_one_open index enforces it at the database level too,
 * and a violation surfaces as a friendly message rather than a raw constraint
 * error.
 */
export async function openManagerSession(
  supabase: SupabaseClient,
  input: {
    clockEventId: string;
    managerId: string;
    storeId: string;
    eventDate: string;
    clockInAt: string;
    lat?: number | null;
    lng?: number | null;
  },
): Promise<ManagerClockSession> {
  const existing = await managerSessionsForEvent(supabase, input.clockEventId);
  const seq = existing.length > 0 ? Math.max(...existing.map((s) => s.seq)) + 1 : 1;

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .insert({
      clock_event_id: input.clockEventId,
      manager_id: input.managerId,
      store_id: input.storeId,
      event_date: input.eventDate,
      seq,
      clock_in_at: input.clockInAt,
      clock_in_lat: input.lat ?? null,
      clock_in_lng: input.lng ?? null,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new Error("You're already clocked in. Clock out before starting another shift.");
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Could not start the shift. Please try again.");
  return data as ManagerClockSession;
}

/** Close a session. Guarded on it still being open so a race can't double-close. */
export async function closeManagerSession(
  supabase: SupabaseClient,
  sessionId: string,
  input: {
    clockOutAt: string;
    lat?: number | null;
    lng?: number | null;
    auto?: { source: string; at: string } | null;
    /** Drops this shift covered. Omitted leaves the session's counts alone. */
    deliveries?: DeliveryCounts | null;
  },
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    clock_out_at: input.clockOutAt,
    clock_out_lat: input.lat ?? null,
    clock_out_lng: input.lng ?? null,
  };
  if (input.deliveries) {
    payload.short_deliveries_count = input.deliveries.short;
    payload.long_deliveries_count = input.deliveries.long;
    payload.extra_short_deliveries = input.deliveries.extraShort;
    payload.extra_long_deliveries = input.deliveries.extraLong;
    payload.extra_short_reason =
      input.deliveries.extraShort > 0 ? input.deliveries.extraShortReason : null;
    payload.extra_long_reason =
      input.deliveries.extraLong > 0 ? input.deliveries.extraLongReason : null;
  }
  if (input.auto) {
    payload.auto_clocked_out = true;
    payload.auto_clock_out_source = input.auto.source;
    payload.auto_clock_out_at = input.auto.at;
  }

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .update(payload)
    .eq("id", sessionId)
    .is("clock_out_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * Give a session to a manager day that has none.
 *
 * Two rows need this. A day clocked in under the pre-031 build and clocked out
 * after the deploy — the header has a clock-in but no session to close. And the
 * open legacy rows migration 031 deliberately skipped, because several per
 * manager would have collided on the one-open-session index.
 *
 * `closeWith` inserts the row already CLOSED, for the nightly sweep — an open
 * row would collide with a shift the manager has running on another date.
 *
 * Returns the adopted session, or null when the header has nothing to adopt.
 */
export async function adoptManagerHeaderIntoSession(
  supabase: SupabaseClient,
  header: {
    id: string;
    manager_id: string;
    store_id: string | null;
    event_date: string;
    clock_in_at: string | null;
    clock_out_at?: string | null;
    clock_in_lat?: number | null;
    clock_in_lng?: number | null;
    clock_out_lat?: number | null;
    clock_out_lng?: number | null;
    auto_clocked_out?: boolean | null;
    auto_clock_out_source?: string | null;
    auto_clock_out_at?: string | null;
    short_deliveries_count?: number | null;
    long_deliveries_count?: number | null;
    extra_short_deliveries?: number | null;
    extra_long_deliveries?: number | null;
    extra_short_reason?: string | null;
    extra_long_reason?: string | null;
  },
  opts?: { closeWith?: { clockOutAt: string; auto: { source: string; at: string } } },
): Promise<ManagerClockSession | null> {
  if (!header.clock_in_at) return null;

  const existing = await managerSessionsForEvent(supabase, header.id);
  if (existing.length > 0) return existing[0];

  const close = opts?.closeWith;

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .insert({
      clock_event_id: header.id,
      manager_id: header.manager_id,
      store_id: header.store_id,
      event_date: header.event_date,
      seq: 1,
      clock_in_at: header.clock_in_at,
      clock_out_at: close?.clockOutAt ?? header.clock_out_at ?? null,
      clock_in_lat: header.clock_in_lat ?? null,
      clock_in_lng: header.clock_in_lng ?? null,
      clock_out_lat: header.clock_out_lat ?? null,
      clock_out_lng: header.clock_out_lng ?? null,
      auto_clocked_out: close ? true : !!header.auto_clocked_out,
      auto_clock_out_source: close?.auto.source ?? header.auto_clock_out_source ?? null,
      auto_clock_out_at: close?.auto.at ?? header.auto_clock_out_at ?? null,
      // The day's drops come with it. This session becomes the only thing the
      // header is summed from, so leaving them behind would have the very next
      // recomputeManagerDayHeader wipe the day's counts to zero.
      short_deliveries_count: header.short_deliveries_count ?? null,
      long_deliveries_count: header.long_deliveries_count ?? null,
      extra_short_deliveries: header.extra_short_deliveries ?? 0,
      extra_long_deliveries: header.extra_long_deliveries ?? 0,
      extra_short_reason: header.extra_short_reason ?? null,
      extra_long_reason: header.extra_long_reason ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerClockSession | null) ?? null;
}
