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
import { deriveDayHeader, type DerivedDayHeader } from "@/lib/clock-sessions";
import type { ManagerClockSession } from "@/lib/types";

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

  const derived = deriveDayHeader(sessions);

  const { error } = await supabase
    .from("manager_clock_events")
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
  },
): Promise<ManagerClockSession | null> {
  if (!header.clock_in_at) return null;

  const existing = await managerSessionsForEvent(supabase, header.id);
  if (existing.length > 0) return existing[0];

  const { data, error } = await supabase
    .from("manager_clock_sessions")
    .insert({
      clock_event_id: header.id,
      manager_id: header.manager_id,
      store_id: header.store_id,
      event_date: header.event_date,
      seq: 1,
      clock_in_at: header.clock_in_at,
      clock_out_at: header.clock_out_at ?? null,
      clock_in_lat: header.clock_in_lat ?? null,
      clock_in_lng: header.clock_in_lng ?? null,
      clock_out_lat: header.clock_out_lat ?? null,
      clock_out_lng: header.clock_out_lng ?? null,
      auto_clocked_out: !!header.auto_clocked_out,
      auto_clock_out_source: header.auto_clock_out_source ?? null,
      auto_clock_out_at: header.auto_clock_out_at ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ManagerClockSession | null) ?? null;
}
