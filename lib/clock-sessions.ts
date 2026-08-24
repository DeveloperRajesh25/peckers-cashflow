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
import { roundHoursToMinute } from "@/lib/utils";

function sessionHours(s: { clock_in_at: string; clock_out_at: string | null }): number {
  if (!s.clock_out_at) return 0;
  const ms = new Date(s.clock_out_at).getTime() - new Date(s.clock_in_at).getTime();
  return ms > 0 ? ms / 3_600_000 : 0;
}

/** The delivery counts a session (or a summed day) carries. */
export type DeliveryCounts = {
  short: number | null;
  long: number | null;
  extraShort: number;
  extraLong: number;
  extraShortReason: string | null;
  extraLongReason: string | null;
};

/** The raw delivery fields a form submits, before validation. */
export type DeliveryInput = {
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

/**
 * Upper bound on any one count for a single shift. Not a business rule — a
 * sanity bound on money: every drop is paid, so a fat-fingered "300" instead of
 * "30" is cash out of the till. Well above any real round.
 */
export const MAX_DELIVERIES_PER_SHIFT = 150;

/**
 * Validate and normalise submitted delivery counts. Shared by every write path
 * — clock-out, manual entry, Daily Approval — so all of them agree on what a
 * legal count is and on the "an extra needs a reason" rule.
 *
 * Returns null when nothing was submitted at all, which callers treat as "leave
 * whatever is already recorded alone" rather than "zero".
 */
export function normaliseDeliveryInput(
  input: DeliveryInput | null | undefined,
): DeliveryCounts | null {
  if (!input) return null;
  const given = [
    input.short_deliveries_count,
    input.long_deliveries_count,
    input.extra_short_deliveries,
    input.extra_long_deliveries,
  ].some((v) => v != null);
  if (!given) return null;

  const count = (v: number | null | undefined, label: string): number => {
    const n = Number(v) || 0;
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} can't be negative.`);
    if (n > MAX_DELIVERIES_PER_SHIFT) {
      throw new Error(`${label} looks wrong — ${Math.round(n)} is above ${MAX_DELIVERIES_PER_SHIFT}.`);
    }
    return Math.round(n);
  };

  const extraShort = count(input.extra_short_deliveries, "Extra short deliveries");
  const extraLong = count(input.extra_long_deliveries, "Extra long deliveries");
  const extraShortReason = input.extra_short_reason?.trim() || null;
  const extraLongReason = input.extra_long_reason?.trim() || null;
  if (extraShort > 0 && !extraShortReason) {
    throw new Error("Please give a reason for the extra short deliveries.");
  }
  if (extraLong > 0 && !extraLongReason) {
    throw new Error("Please give a reason for the extra long deliveries.");
  }

  return {
    short: count(input.short_deliveries_count, "Short deliveries"),
    long: count(input.long_deliveries_count, "Long deliveries"),
    extraShort,
    extraLong,
    extraShortReason,
    extraLongReason,
  };
}

type SessionDeliveryRow = {
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

/** The approval a shift carries (migration 035). */
type SessionApprovalRow = {
  hours_approved?: boolean | null;
  approved_hours?: number | string | null;
};

export type DerivedDayHeader = {
  /**
   * Which store the day belongs to: the store of the shift currently OPEN, else
   * the latest shift's. Null when no shift carries one.
   *
   * The day is a header over shifts that can each be at a DIFFERENT store —
   * staff cross-cover, and a manager-entered shift is stamped with the store
   * the manager was running, not one GPS ever verified. Freezing the day at the
   * first store it saw put people on the wrong store's Live board while they
   * stood in another store, and paid the day to the wrong till.
   */
  storeId: string | null;
  workedHours: number;
  sessionCount: number;
  /** How many of them are closed. Zero means worked_hours must stay null. */
  completedCount: number;
  open: boolean;
  /** Earliest clock-in of the day, by clock time. */
  firstIn: string | null;
  /** Latest clock-out of the day, by clock time. Null while a shift is open. */
  lastOut: string | null;
  /** The day's deliveries: the SUM across its shifts (migration 033). */
  deliveries: DeliveryCounts;
  /**
   * The same sums restricted to APPROVED shifts (migration 035) — the figures
   * the Tuesday payout pays. Everything above stays the raw record of what was
   * worked, which is what the Live board, the Rota and the employee's own view
   * must keep showing.
   */
  approvedHours: number | null;
  approvedDeliveries: DeliveryCounts;
  approvedSessionCount: number;
  /**
   * True when every COMPLETED shift is signed off and at least one exists. An
   * open shift never counts against it — a manager can't approve a shift that
   * hasn't finished, so a day mid-way through must not read as outstanding
   * work forever.
   */
  allApproved: boolean;
};

/**
 * Sum a day's delivery counts across its shifts.
 *
 * short/long stay NULL when no shift recorded anything — null and 0 mean
 * different things to the Daily Approval "No deliveries" warning, which exists
 * to catch a driver who never entered a count at all.
 *
 * The reasons are not summable, so the day carries the first non-empty one of
 * each. A reason explains why extras happened that day; a manager reviewing the
 * day sees it alongside the total, and the per-shift text stays intact on the
 * session row it belongs to.
 */
export function sumSessionDeliveries(sessions: SessionDeliveryRow[]): DeliveryCounts {
  let short: number | null = null;
  let long: number | null = null;
  let extraShort = 0;
  let extraLong = 0;
  for (const s of sessions) {
    if (s.short_deliveries_count != null) short = (short ?? 0) + Number(s.short_deliveries_count);
    if (s.long_deliveries_count != null) long = (long ?? 0) + Number(s.long_deliveries_count);
    extraShort += Number(s.extra_short_deliveries) || 0;
    extraLong += Number(s.extra_long_deliveries) || 0;
  }
  return {
    short,
    long,
    extraShort,
    extraLong,
    extraShortReason:
      sessions.map((s) => s.extra_short_reason?.trim()).find((r) => !!r) ?? null,
    extraLongReason:
      sessions.map((s) => s.extra_long_reason?.trim()).find((r) => !!r) ?? null,
  };
}

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
  sessions: Array<
    { clock_in_at: string; clock_out_at: string | null; store_id?: string | null } &
      SessionDeliveryRow &
      SessionApprovalRow
  >,
): DerivedDayHeader {
  if (sessions.length === 0) {
    return {
      storeId: null,
      workedHours: 0,
      sessionCount: 0,
      completedCount: 0,
      open: false,
      firstIn: null,
      lastOut: null,
      deliveries: sumSessionDeliveries([]),
      approvedHours: null,
      approvedDeliveries: sumSessionDeliveries([]),
      approvedSessionCount: 0,
      allApproved: false,
    };
  }

  const completed = sessions.filter((s) => s.clock_out_at);
  const open = sessions.some((s) => !s.clock_out_at);
  const workedHours = roundHoursToMinute(
    completed.reduce((sum, s) => sum + sessionHours(s), 0),
  );

  // Where they are NOW (the open shift), else where they were last. By clock
  // time, never insertion order — a forgotten morning entered after the evening
  // must not become "the latest shift".
  const latest = sessions.reduce((newest, s) =>
    new Date(s.clock_in_at).getTime() > new Date(newest.clock_in_at).getTime() ? s : newest,
  );
  const storeId =
    sessions.find((s) => !s.clock_out_at)?.store_id ?? latest.store_id ?? null;

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

  // Only a finished shift can be signed off, so approval is read off the
  // completed ones. An unapproved OPEN shift is not outstanding work — it is
  // work still happening.
  const approved = completed.filter((s) => s.hours_approved);
  const approvedHours = roundHoursToMinute(
    approved.reduce(
      (sum, s) =>
        sum + (s.approved_hours != null ? Number(s.approved_hours) || 0 : sessionHours(s)),
      0,
    ),
  );

  return {
    storeId,
    workedHours,
    sessionCount: sessions.length,
    completedCount: completed.length,
    open,
    firstIn,
    lastOut,
    // Every shift counts, including one still running — a driver logs drops
    // live during their shift, and the Live board must show them as they come.
    deliveries: sumSessionDeliveries(sessions),
    approvedHours: approved.length > 0 ? approvedHours : null,
    approvedDeliveries: sumSessionDeliveries(approved),
    approvedSessionCount: approved.length,
    allApproved: approved.length > 0 && approved.length === completed.length,
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

/**
 * Has this person clocked at all on a given date? Answered from the SESSIONS,
 * not the day header, because the header's clock_in_at survives a shift being
 * deleted and a day can exist with no shifts on it at all.
 *
 * Used by the early clock-in gate: the second shift of a day is never asked for
 * an OTP, since the person is already on site and the morning verified them.
 */
export async function hasSessionOnDate(
  supabase: SupabaseClient,
  employeeId: string,
  eventDate: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("clock_sessions")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("event_date", eventDate)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
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

/**
 * Write one shift's delivery counts. The caller recomputes the day header
 * afterwards — this never touches clock_events itself, so recomputeDayHeader
 * stays the single writer of the day's totals.
 */
export async function setSessionDeliveries(
  supabase: SupabaseClient,
  sessionId: string,
  deliveries: DeliveryCounts,
): Promise<void> {
  const { error } = await supabase
    .from("clock_sessions")
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
 * Apply a DAY-level delivery total that a manager typed (Daily Approval, the
 * Rota's delivery modal) onto a day that may hold several shifts.
 *
 * The manager is correcting the day, not a shift — they have no per-shift view
 * — so the difference is settled on the day's LAST shift and the earlier ones
 * are left exactly as the driver recorded them. That keeps the day's sum equal
 * to what the manager typed (which is the number they will check afterwards)
 * while preserving the per-shift detail that is actually known to be right.
 *
 * Returns false when the day has no sessions at all (a pre-029 row); the caller
 * falls back to writing the header directly, as it always did.
 */
export async function applyDayDeliveryTotal(
  supabase: SupabaseClient,
  clockEventId: string,
  total: DeliveryCounts,
): Promise<boolean> {
  const sessions = await sessionsForEvent(supabase, clockEventId);
  if (sessions.length === 0) return false;

  const last = sessions[sessions.length - 1];
  const others = sessions.slice(0, -1);
  const rest = sumSessionDeliveries(others);

  // Never let the remainder go negative: a manager lowering the day total below
  // what the earlier shifts already hold would otherwise credit a negative drop
  // against the day — and so against the driver's pay.
  const remainder: DeliveryCounts = {
    short: total.short == null ? null : Math.max(0, total.short - (rest.short ?? 0)),
    long: total.long == null ? null : Math.max(0, total.long - (rest.long ?? 0)),
    extraShort: Math.max(0, total.extraShort - rest.extraShort),
    extraLong: Math.max(0, total.extraLong - rest.extraLong),
    extraShortReason: total.extraShortReason,
    extraLongReason: total.extraLongReason,
  };

  await setSessionDeliveries(supabase, last.id, remainder);
  return true;
}

/**
 * Sign off (or withdraw) one shift. `approvedHours` corrects that shift's hours;
 * null leaves the clocked duration standing.
 *
 * Deliberately does NOT recompute the day header — the caller does that once
 * after the last shift it touches, so approving a whole day is one recompute
 * rather than one per shift.
 */
export async function setSessionApproval(
  supabase: SupabaseClient,
  sessionId: string,
  approval: { approved: boolean; approvedHours?: number | null; by: string },
): Promise<void> {
  const { error } = await supabase
    .from("clock_sessions")
    .update(
      approval.approved
        ? {
            hours_approved: true,
            approved_hours: approval.approvedHours ?? null,
            hours_approved_by: approval.by,
            hours_approved_at: new Date().toISOString(),
          }
        : {
            hours_approved: false,
            // The correction goes with the approval. Leaving it behind would
            // silently re-apply a manager's old figure if the shift were later
            // approved again by someone who never saw it.
            approved_hours: null,
            hours_approved_by: null,
            hours_approved_at: null,
          },
    )
    .eq("id", sessionId);
  if (error) throw new Error(error.message);
}

/**
 * Approve every completed shift of a day that isn't already signed off, and
 * return how many that was.
 *
 * `dayHours`, when given, is a DAY total the manager typed. It is settled the
 * same way a corrected delivery total is: the shifts already approved keep
 * their agreed figures and the difference lands on the last shift being
 * approved now, so the day sums to exactly the number the manager will check
 * afterwards. Never negative — a total below what the earlier shifts already
 * hold would otherwise pay the difference back out of someone's wages.
 */
export async function approveDaySessions(
  supabase: SupabaseClient,
  clockEventId: string,
  opts: { by: string; dayHours?: number | null },
): Promise<number> {
  const sessions = await sessionsForEvent(supabase, clockEventId);
  const completed = sessions.filter((s) => s.clock_out_at);
  const pending = completed.filter((s) => !s.hours_approved);
  if (pending.length === 0) return 0;

  let remaining =
    opts.dayHours != null && Number.isFinite(opts.dayHours)
      ? Math.max(
          0,
          Number(opts.dayHours) -
            completed
              .filter((s) => s.hours_approved)
              .reduce(
                (sum, s) =>
                  sum +
                  (s.approved_hours != null
                    ? Number(s.approved_hours) || 0
                    : sessionHours(s)),
                0,
              ),
        )
      : null;

  for (let i = 0; i < pending.length; i++) {
    const s = pending[i];
    let approvedHours: number | null = null;
    if (remaining != null) {
      const isLast = i === pending.length - 1;
      // Everything left over goes on the final shift so the day totals exactly.
      const share = isLast ? remaining : Math.min(remaining, sessionHours(s));
      approvedHours = roundHoursToMinute(share);
      // Deduct what was actually STORED, not the raw share — subtracting the
      // pre-rounded figure leaves a sliver behind on every shift, and the day
      // then fails to add up to the total the manager typed.
      remaining = roundHoursToMinute(Math.max(0, remaining - approvedHours));
    }
    await setSessionApproval(supabase, s.id, {
      approved: true,
      approvedHours,
      by: opts.by,
    });
  }
  return pending.length;
}

/** Withdraw the approval on every shift of a day. Returns how many changed. */
export async function unapproveDaySessions(
  supabase: SupabaseClient,
  clockEventId: string,
  by: string,
): Promise<number> {
  const sessions = await sessionsForEvent(supabase, clockEventId);
  const approved = sessions.filter((s) => s.hours_approved);
  for (const s of approved) {
    await setSessionApproval(supabase, s.id, { approved: false, by });
  }
  return approved.length;
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

  // Same rule as the empty-sessions guard above, one level down: when NO shift
  // has ever recorded a count, the sum is not "zero drops" — there is simply
  // nothing to sum, and the header may still hold counts written before
  // migration 033 moved them onto the shifts. Writing the derived nulls over
  // the top would erase the only surviving record of that round, and on a
  // driver who is under the NI limit deliveries are their entire pay
  // (Update 94). Once any shift carries a count the sessions are authoritative
  // again, including a manager correcting a day down to a genuine zero.
  const sessionsHaveDeliveries =
    derived.deliveries.short != null ||
    derived.deliveries.long != null ||
    derived.deliveries.extraShort > 0 ||
    derived.deliveries.extraLong > 0;

  const { error } = await supabase
    .from("clock_events")
    .update({
      clock_in_at: derived.firstIn,
      clock_out_at: derived.lastOut,
      worked_hours: derived.completedCount > 0 ? derived.workedHours : null,
      session_count: derived.sessionCount,
      // The day follows the shift they're ON, so someone who clocks in at
      // another store shows — and is paid — there rather than wherever the day
      // happened to start. Never nulled: a legacy shift with no store of its own
      // leaves the day's existing one standing.
      ...(derived.storeId ? { store_id: derived.storeId } : {}),
      // The day's delivery totals are a SUM of its shifts (migration 033), and
      // this is their ONLY writer. Keeping them on the header is what lets the
      // Rota, the Tuesday payout, Payout History, the Live board, Daily
      // Approval and the Vita Mojo cross-check keep reading one row, unchanged
      // — they simply read a correct number now on a split day.
      ...(sessionsHaveDeliveries
        ? {
            short_deliveries_count: derived.deliveries.short,
            long_deliveries_count: derived.deliveries.long,
            extra_short_deliveries: derived.deliveries.extraShort,
            extra_long_deliveries: derived.deliveries.extraLong,
            extra_short_reason: derived.deliveries.extraShortReason,
            extra_long_reason: derived.deliveries.extraLongReason,
          }
        : {}),
      // The APPROVED half (migration 035) — what the Tuesday payout pays. Same
      // rule as the raw columns: derived here and nowhere else, so approving,
      // undoing, correcting a count and adding a shift all settle through one
      // writer and cannot disagree.
      approved_short_deliveries_count: derived.approvedDeliveries.short,
      approved_long_deliveries_count: derived.approvedDeliveries.long,
      approved_extra_short_deliveries: derived.approvedDeliveries.extraShort,
      approved_extra_long_deliveries: derived.approvedDeliveries.extraLong,
      approved_session_count: derived.approvedSessionCount,
      approved_hours: derived.approvedHours,
      hours_approved: derived.allApproved,
    })
    .eq("id", clockEventId);
  if (error) throw new Error(error.message);

  return derived;
}

/**
 * Add a session to a day. `seq` continues the day's existing numbering.
 *
 * Left OPEN when no `clockOutAt` is given — the caller must have established
 * there is no open session first, and the clock_sessions_one_open index
 * enforces it at the database level too. Given both times, the row is inserted
 * ALREADY CLOSED: a finished shift being recorded after the fact must never
 * occupy the one-open slot, which the person's current shift may be holding
 * (the same reason insertDeliveriesOnlySession writes a closed row).
 */
export async function addSession(
  supabase: SupabaseClient,
  input: {
    clockEventId: string;
    employeeId: string;
    storeId: string;
    eventDate: string;
    clockInAt: string;
    /** Set only when the shift is already finished. */
    clockOutAt?: string | null;
    lat?: number | null;
    lng?: number | null;
    manual?: { by: string; at: string; reason: string } | null;
    /** This shift's own drops — see migration 033. */
    deliveries?: DeliveryCounts | null;
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
      clock_out_at: input.clockOutAt ?? null,
      clock_in_lat: input.lat ?? null,
      clock_in_lng: input.lng ?? null,
      manual_entry: !!input.manual,
      manual_entry_by: input.manual?.by ?? null,
      manual_entry_at: input.manual?.at ?? null,
      manual_entry_reason: input.manual?.reason ?? null,
      ...(input.deliveries
        ? {
            short_deliveries_count: input.deliveries.short,
            long_deliveries_count: input.deliveries.long,
            extra_short_deliveries: input.deliveries.extraShort,
            extra_long_deliveries: input.deliveries.extraLong,
            extra_short_reason:
              input.deliveries.extraShort > 0 ? input.deliveries.extraShortReason : null,
            extra_long_reason:
              input.deliveries.extraLong > 0 ? input.deliveries.extraLongReason : null,
          }
        : {}),
    })
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      // A closed row cannot violate the one-open index, so a collision there is
      // a racing second write of the same shift, not a clocked-in employee.
      throw new Error(
        input.clockOutAt
          ? "That shift was just recorded by someone else. Reload the day and check the times."
          : "You're already clocked in. Clock out before starting another shift.",
      );
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
    /** Corrects the start too — a manager completing a shift may also be
     *  fixing the time it was recorded as starting. */
    clockInAt?: string;
    /** Only the manual path sets this: the store the shift is being recorded
     *  against, which the actor may have corrected along with the times. */
    storeId?: string;
    lat?: number | null;
    lng?: number | null;
    auto?: { source: string; at: string } | null;
    manual?: { by: string; at: string; reason: string } | null;
    /** This shift's own drops — see migration 033. Omitted leaves whatever the
     *  driver already logged live during the shift untouched. */
    deliveries?: DeliveryCounts | null;
  },
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    clock_out_at: input.clockOutAt,
    clock_out_lat: input.lat ?? null,
    clock_out_lng: input.lng ?? null,
  };
  if (input.clockInAt) payload.clock_in_at = input.clockInAt;
  if (input.storeId) payload.store_id = input.storeId;
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
 * employee would have collided on the one-open-session index. A manual entry
 * that failed part-way leaves the same shape (Update 133).
 *
 * `closeWith` inserts the row already CLOSED. The nightly sweep needs it: an
 * open row would collide with a shift the person has running on another date,
 * and the collision is what stopped session-less days ever being swept.
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
  } & SessionDeliveryRow,
  opts?: { closeWith?: { clockOutAt: string; auto: { source: string; at: string } } },
): Promise<ClockSession | null> {
  if (!header.clock_in_at) return null;

  const existing = await sessionsForEvent(supabase, header.id);
  if (existing.length > 0) return existing[0];

  const close = opts?.closeWith;

  const { data, error } = await supabase
    .from("clock_sessions")
    .insert({
      clock_event_id: header.id,
      employee_id: header.employee_id,
      store_id: header.store_id,
      event_date: header.event_date,
      seq: 1,
      clock_in_at: header.clock_in_at,
      clock_out_at: close?.clockOutAt ?? header.clock_out_at,
      clock_in_lat: header.clock_in_lat ?? null,
      clock_in_lng: header.clock_in_lng ?? null,
      clock_out_lat: header.clock_out_lat ?? null,
      clock_out_lng: header.clock_out_lng ?? null,
      manual_entry: !!header.manual_entry,
      manual_entry_by: header.manual_entry_by ?? null,
      manual_entry_at: header.manual_entry_at ?? null,
      manual_entry_reason: header.manual_entry_reason ?? null,
      auto_clocked_out: close ? true : !!header.auto_clocked_out,
      auto_clock_out_source: close?.auto.source ?? header.auto_clock_out_source ?? null,
      auto_clock_out_at: close?.auto.at ?? header.auto_clock_out_at ?? null,
      // The day's drops come with it. This session becomes the only thing the
      // header is summed from, so leaving them behind would have the very next
      // recomputeDayHeader wipe a legacy day's counts to zero (migration 033).
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
