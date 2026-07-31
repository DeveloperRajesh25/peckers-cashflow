// =============================================================
// Clock sessions — the shifts inside a clocked day (migration 029).
//
// clock_events is still ONE row per (employee, day) and remains the header
// every other module reads. Each clock-in/out pair lives in clock_sessions
// underneath it, so a day can hold a morning shift, a break, and an evening
// shift.
//
// The header is derived, never hand-written:
//
//   clock_in_at   first session's in   (never overwritten by a later shift)
//   clock_out_at  last session's out, or NULL while any session is open
//   worked_hours  SUM of completed sessions
//   session_count how many sessions the day has
//
// Nulling clock_out_at while a session is open is deliberate and load-bearing:
// it is what lets every "is this person on shift" check in the app — the Live
// board, computeStatus, the crew screen, the auto clock-out sweep — keep
// working with no change at all.
//
// recomputeDayHeader is the ONLY writer of those four columns. Self clock-in,
// manager-entered times and the auto clock-out sweep all funnel through it, so
// the three paths cannot drift on what a day totals.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClockSession } from "@/lib/types";

/** Round to 2dp the same way every money/hours path in the app does. */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sessionHours(s: { clock_in_at: string; clock_out_at: string | null }): number {
  if (!s.clock_out_at) return 0;
  const ms = new Date(s.clock_out_at).getTime() - new Date(s.clock_in_at).getTime();
  return ms > 0 ? ms / 3_600_000 : 0;
}

export type DerivedDayHeader = {
  workedHours: number;
  sessionCount: number;
  /** How many of them are closed. Zero means worked_hours must stay null. */
  completedCount: number;
  open: boolean;
  /** Earliest clock-in of the day, by clock time. */
  firstIn: string | null;
  /** Latest clock-out of the day, by clock time. Null while a shift is open. */
  lastOut: string | null;
};

/**
 * What a day's header columns should read, given its sessions. Pure — the
 * employee and manager halves share it so the two cannot drift on what a split
 * day totals or where its bounds are.
 *
 * Bounds are the MIN clock-in and MAX clock-out by CLOCK TIME, never whichever
 * session happens to be first or last in the table. Shifts can be recorded out
 * of order (a manager entering a forgotten morning after the evening), which
 * would otherwise stamp the day as 17:00 → 13:00 (Update 72).
 */
export function deriveDayHeader(
  sessions: Array<{ clock_in_at: string; clock_out_at: string | null }>,
): DerivedDayHeader {
  if (sessions.length === 0) {
    return {
      workedHours: 0,
      sessionCount: 0,
      completedCount: 0,
      open: false,
      firstIn: null,
      lastOut: null,
    };
  }

  const completed = sessions.filter((s) => s.clock_out_at);
  const open = sessions.some((s) => !s.clock_out_at);
  const workedHours = round2(completed.reduce((sum, s) => sum + sessionHours(s), 0));

  const firstIn = sessions.reduce<string | null>(
    (min, s) =>
      !min || new Date(s.clock_in_at).getTime() < new Date(min).getTime()
        ? s.clock_in_at
        : min,
    null,
  );
  const lastOut = open
    ? null // still on shift — the day reads as open everywhere
    : completed.reduce<string | null>(
        (max, s) =>
          !max || new Date(s.clock_out_at!).getTime() > new Date(max).getTime()
            ? s.clock_out_at!
            : max,
        null,
      );

  return {
    workedHours,
    sessionCount: sessions.length,
    completedCount: completed.length,
    open,
    firstIn,
    lastOut,
  };
}

/**
 * The employee's currently open session, if any — across ALL dates, not just
 * today. A shift started at 22:00 and closed at 01:00 belongs to the day it
 * opened on, so "what am I clocking out of" cannot be answered by today's date.
 */
export async function findOpenSession(
  supabase: SupabaseClient,
  employeeId: string,
): Promise<ClockSession | null> {
  const { data, error } = await supabase
    .from("clock_sessions")
    .select("*")
    .eq("employee_id", employeeId)
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ClockSession | null) ?? null;
}

/** Every session of a day, earliest first. */
export async function sessionsForEvent(
  supabase: SupabaseClient,
  clockEventId: string,
): Promise<ClockSession[]> {
  const { data, error } = await supabase
    .from("clock_sessions")
    .select("*")
    .eq("clock_event_id", clockEventId)
    // CHRONOLOGICAL, never by seq. seq is insertion order, and a manager
    // recording a forgotten day can enter the evening shift before the morning
    // one — ordering by seq would then report the day as starting at 17:00 and
    // ending at 13:00.
    .order("clock_in_at", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ClockSession[];
}

/** Sessions for many days at once, keyed by clock_events.id — for list screens. */
export async function sessionsByEventId(
  supabase: SupabaseClient,
  clockEventIds: string[],
): Promise<Map<string, ClockSession[]>> {
  const byEvent = new Map<string, ClockSession[]>();
  const ids = Array.from(new Set(clockEventIds.filter(Boolean)));
  if (ids.length === 0) return byEvent;

  const { data, error } = await supabase
    .from("clock_sessions")
    .select("*")
    .in("clock_event_id", ids)
    .order("clock_in_at", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);

  for (const s of (data ?? []) as ClockSession[]) {
    const arr = byEvent.get(s.clock_event_id) ?? [];
    arr.push(s);
    byEvent.set(s.clock_event_id, arr);
  }
  return byEvent;
}

/**
 * Recompute a day's header from its sessions. Returns the resolved bounds and
 * totals so the caller can stamp the rota cell without a re-read.
 */
export async function recomputeDayHeader(
  supabase: SupabaseClient,
  clockEventId: string,
): Promise<DerivedDayHeader> {
  const sessions = await sessionsForEvent(supabase, clockEventId);

  // Never derive a header from nothing: with no sessions there is nothing to
  // sum, and writing the nulls would erase a day recorded by an older build.
  if (sessions.length === 0) {
    return deriveDayHeader(sessions);
  }

  const derived = deriveDayHeader(sessions);

  const { error } = await supabase
    .from("clock_events")
    .update({
      clock_in_at: derived.firstIn,
      clock_out_at: derived.lastOut,
      worked_hours: derived.completedCount > 0 ? derived.workedHours : null,
      session_count: derived.sessionCount,
    })
    .eq("id", clockEventId);
  if (error) throw new Error(error.message);

  return derived;
}

/**
 * Start a session on a day. `seq` continues the day's existing numbering.
 *
 * The caller must have established there is no open session first — the
 * clock_sessions_one_open index enforces it at the database level too, and a
 * violation surfaces as a friendly message rather than a raw constraint error.
 */
export async function openSession(
  supabase: SupabaseClient,
  input: {
    clockEventId: string;
    employeeId: string;
    storeId: string;
    eventDate: string;
    clockInAt: string;
    lat?: number | null;
    lng?: number | null;
    manual?: { by: string; at: string; reason: string } | null;
  },
): Promise<ClockSession> {
  const existing = await sessionsForEvent(supabase, input.clockEventId);
  const seq = existing.length > 0 ? Math.max(...existing.map((s) => s.seq)) + 1 : 1;

  const { data, error } = await supabase
    .from("clock_sessions")
    .insert({
      clock_event_id: input.clockEventId,
      employee_id: input.employeeId,
      store_id: input.storeId,
      event_date: input.eventDate,
      seq,
      clock_in_at: input.clockInAt,
      clock_in_lat: input.lat ?? null,
      clock_in_lng: input.lng ?? null,
      manual_entry: !!input.manual,
      manual_entry_by: input.manual?.by ?? null,
      manual_entry_at: input.manual?.at ?? null,
      manual_entry_reason: input.manual?.reason ?? null,
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
  return data as ClockSession;
}

/** Close a session. Guarded on it still being open so a race can't double-close. */
export async function closeSession(
  supabase: SupabaseClient,
  sessionId: string,
  input: {
    clockOutAt: string;
    lat?: number | null;
    lng?: number | null;
    auto?: { source: string; at: string } | null;
    manual?: { by: string; at: string; reason: string } | null;
  },
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    clock_out_at: input.clockOutAt,
    clock_out_lat: input.lat ?? null,
    clock_out_lng: input.lng ?? null,
  };
  if (input.auto) {
    payload.auto_clocked_out = true;
    payload.auto_clock_out_source = input.auto.source;
    payload.auto_clock_out_at = input.auto.at;
  }
  if (input.manual) {
    payload.manual_entry = true;
    payload.manual_entry_by = input.manual.by;
    payload.manual_entry_at = input.manual.at;
    payload.manual_entry_reason = input.manual.reason;
  }

  const { data, error } = await supabase
    .from("clock_sessions")
    .update(payload)
    .eq("id", sessionId)
    .is("clock_out_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * Give a session to a day that has none.
 *
 * Two rows need this. A day clocked in under the pre-029 build and clocked out
 * after the deploy — the header has a clock-in but no session to close. And the
 * open legacy rows migration 029 deliberately skipped, because several per
 * employee would have collided on the one-open-session index.
 *
 * Returns the adopted session, or null when the header has nothing to adopt.
 */
export async function adoptHeaderIntoSession(
  supabase: SupabaseClient,
  header: {
    id: string;
    employee_id: string;
    store_id: string;
    event_date: string;
    clock_in_at: string | null;
    clock_out_at: string | null;
    clock_in_lat?: number | null;
    clock_in_lng?: number | null;
    clock_out_lat?: number | null;
    clock_out_lng?: number | null;
    manual_entry?: boolean | null;
    manual_entry_by?: string | null;
    manual_entry_at?: string | null;
    manual_entry_reason?: string | null;
    auto_clocked_out?: boolean | null;
    auto_clock_out_source?: string | null;
    auto_clock_out_at?: string | null;
  },
): Promise<ClockSession | null> {
  if (!header.clock_in_at) return null;

  const existing = await sessionsForEvent(supabase, header.id);
  if (existing.length > 0) return existing[0];

  const { data, error } = await supabase
    .from("clock_sessions")
    .insert({
      clock_event_id: header.id,
      employee_id: header.employee_id,
      store_id: header.store_id,
      event_date: header.event_date,
      seq: 1,
      clock_in_at: header.clock_in_at,
      clock_out_at: header.clock_out_at,
      clock_in_lat: header.clock_in_lat ?? null,
      clock_in_lng: header.clock_in_lng ?? null,
      clock_out_lat: header.clock_out_lat ?? null,
      clock_out_lng: header.clock_out_lng ?? null,
      manual_entry: !!header.manual_entry,
      manual_entry_by: header.manual_entry_by ?? null,
      manual_entry_at: header.manual_entry_at ?? null,
      manual_entry_reason: header.manual_entry_reason ?? null,
      auto_clocked_out: !!header.auto_clocked_out,
      auto_clock_out_source: header.auto_clock_out_source ?? null,
      auto_clock_out_at: header.auto_clock_out_at ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ClockSession | null) ?? null;
}

/**
 * Does [inAt, outAt] collide with a session the day already has? Manager-entered
 * times are the only path that can write an arbitrary window, and two
 * overlapping shifts would pay the same minutes twice.
 */
export function overlapsExistingSession(
  sessions: Array<{ id: string; clock_in_at: string; clock_out_at: string | null }>,
  inAt: Date,
  outAt: Date | null,
  ignoreSessionId?: string,
): boolean {
  const start = inAt.getTime();
  // An open new session has no end, so treat it as extending to now for the
  // purposes of the check — it must not start inside an existing shift.
  const end = outAt ? outAt.getTime() : start;
  for (const s of sessions) {
    if (ignoreSessionId && s.id === ignoreSessionId) continue;
    const sStart = new Date(s.clock_in_at).getTime();
    const sEnd = s.clock_out_at ? new Date(s.clock_out_at).getTime() : Infinity;
    if (start < sEnd && end > sStart) return true;
  }
  return false;
}
