// =============================================================
// Auto clock-out — close the days people forgot to clock out of.
//
// Every hours calculation in the app needs BOTH clock_in_at and clock_out_at
// (see resolvedDayHours / aggregateWorked / mapClockEventsToDaily). So a
// forgotten clock-out doesn't just lose the tail of a shift — it erases the
// whole day: 0.00h on the Tuesday payout sheet, and the day never appears in
// the daily approval queue for a manager to notice.
//
// This sweep closes any still-open row on a day that has already finished,
// stamping the person's SCHEDULED shift end as the clock-out time. The day
// then counts everywhere, flagged (auto_clocked_out) so a manager can see the
// end time was assumed and correct it when approving hours.
//
// Rules that keep it safe:
//   • Only days STRICTLY BEFORE today (UK) are touched — nobody still on shift
//     can be clocked out from under them.
//   • Plus a grace period after the assumed end, so an overnight shift that
//     runs past midnight isn't closed while it's still running.
//   • A real clock-out always wins: updates are guarded on clock_out_at still
//     being null.
//   • The assumed shift is capped at MAX_AUTO_SHIFT_HOURS so a bad rota row
//     can never invent a 30-hour day.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseISODate, shiftHours, timeToMinutes, weekdayIndex } from "@/lib/utils";
import {
  adoptHeaderIntoSession,
  closeSession,
  findOpenSession,
  recomputeDayHeader,
} from "@/lib/clock-sessions";
import {
  adoptManagerHeaderIntoSession,
  closeManagerSession,
  findOpenManagerSession,
  recomputeManagerDayHeader,
} from "@/lib/manager-clock-sessions";

/** Marker note for shifts the system created from a clock-in (see actions/clock.ts). */
const AUTO_SHIFT_NOTE = "Auto-created from clock-in";

/** Wait this long after the assumed end before closing the day. */
export const AUTO_CLOSE_GRACE_MIN = 120;
/** An auto-closed day can never be longer than this. */
export const MAX_AUTO_SHIFT_HOURS = 16;
/** Used when no rota, template or store closing time gives a usable end. */
export const FALLBACK_AUTO_SHIFT_HOURS = 8;
/** How far back a sweep looks for open rows. */
export const DEFAULT_LOOKBACK_DAYS = 180;
/** Safety valve so one sweep can never fan out unbounded. */
const MAX_ROWS_PER_SWEEP = 500;

export type AutoClockOutSource = "rota" | "schedule" | "store_close" | "fallback";

// ---------------- London wall-clock helpers ----------------
//
// Shift times are stored as plain UK time-of-day; the server runs in UTC. Both
// the "what date is it" test and the "17:00 on 2026-07-22" conversion have to
// be done in Europe/London or every BST shift lands an hour out.

const LONDON_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function londonParts(d: Date) {
  const parts = LONDON_FMT.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Europe/London calendar date (YYYY-MM-DD) for an instant. */
export function londonDateISO(d: Date): string {
  const p = londonParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC offset of Europe/London at a given instant, in ms (+1h during BST). */
function londonOffsetMs(d: Date): number {
  const p = londonParts(d);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - d.getTime();
}

/**
 * The instant at which it is `hh:mm` UK time on `dateIso`. Resolved in two
 * passes: guess the offset from the naive instant, then re-check it at the
 * corrected instant so a time either side of a DST switch still lands right.
 */
export function londonWallClockToUtc(dateIso: string, hhmm: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  const mins = timeToMinutes(hhmm);
  const naive = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0);
  let utc = naive - londonOffsetMs(new Date(naive));
  utc = naive - londonOffsetMs(new Date(utc));
  return new Date(utc);
}

/** YYYY-MM-DD `days` after `dateIso`. */
function shiftDate(dateIso: string, days: number): string {
  const d = parseISODate(dateIso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The instant a hand-entered clock-out happened, given the day the shift STARTED
 * on. A wall-clock time at or before the clock-in belongs to the next calendar
 * day: 14:00 → 00:00 is a ten-hour overnight shift, not a negative one.
 *
 * Equal times are rejected by the caller — 14:00 → 14:00 is ambiguous, not a
 * 24-hour shift.
 */
export function resolveManualClockOut(
  eventDate: string,
  clockInHHMM: string,
  clockOutHHMM: string,
): { at: Date; overnight: boolean; date: string } {
  const overnight = timeToMinutes(clockOutHHMM) <= timeToMinutes(clockInHHMM);
  const date = overnight ? shiftDate(eventDate, 1) : eventDate;
  return { at: londonWallClockToUtc(date, clockOutHHMM), overnight, date };
}

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);

// ---------------- resolving the assumed end time ----------------

export type ShiftWindow = { start: string | null; end: string | null } | null;

/**
 * Decide what time someone who forgot to clock out should be clocked out at.
 * Candidates are tried best-first — their own rota row, then their recurring
 * weekly template, then the store's closing time — and the first one that
 * yields a sane shift (ends after they clocked in, no longer than
 * MAX_AUTO_SHIFT_HOURS) wins. If none do, fall back to a standard shift
 * measured from the clock-in, so the day is never dropped entirely.
 */
export function resolveAutoClockOut(input: {
  eventDate: string;
  clockInAt: string;
  rota?: ShiftWindow;
  template?: ShiftWindow;
  storeClose?: string | null;
}): { at: Date; source: AutoClockOutSource } {
  const clockIn = new Date(input.clockInAt).getTime();
  const maxMs = MAX_AUTO_SHIFT_HOURS * 3_600_000;

  const candidates: Array<{ source: AutoClockOutSource; start: string | null; end: string | null }> = [
    { source: "rota", start: hhmm(input.rota?.start), end: hhmm(input.rota?.end) },
    { source: "schedule", start: hhmm(input.template?.start), end: hhmm(input.template?.end) },
    { source: "store_close", start: null, end: hhmm(input.storeClose) },
  ];

  for (const c of candidates) {
    if (!c.end) continue;
    // An overnight shift (17:00 → 02:00) ends on the FOLLOWING calendar day.
    const overnight = !!c.start && timeToMinutes(c.end) <= timeToMinutes(c.start);
    const at = londonWallClockToUtc(overnight ? shiftDate(input.eventDate, 1) : input.eventDate, c.end);
    const worked = at.getTime() - clockIn;
    if (worked <= 0 || worked > maxMs) continue; // clocked in after it, or implausibly long
    return { at, source: c.source };
  }

  return {
    at: new Date(clockIn + FALLBACK_AUTO_SHIFT_HOURS * 3_600_000),
    source: "fallback",
  };
}

// ---------------- the sweep ----------------

export type AutoClosedRow = {
  kind: "employee" | "manager" | "cover_driver";
  id: string;
  personId: string;
  eventDate: string;
  clockOutAt: string;
  source: AutoClockOutSource;
  hours: number;
};

export type AutoCloseResult = {
  ok: boolean;
  scanned: number;
  closed: AutoClosedRow[];
  /** Open rows deliberately left alone (still inside the grace window). */
  waiting: number;
  error?: string;
};

type OpenClock = {
  id: string;
  employee_id: string;
  store_id: string;
  event_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  shift_id: string | null;
  manual_entry: boolean | null;
  manual_entry_by: string | null;
  manual_entry_at: string | null;
  manual_entry_reason: string | null;
  /** Carried so a pre-029 row adopted into a session keeps its drops (033). */
  short_deliveries_count: number | null;
  long_deliveries_count: number | null;
  extra_short_deliveries: number | null;
  extra_long_deliveries: number | null;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
};

type OpenManagerClock = {
  id: string;
  manager_id: string;
  store_id: string | null;
  event_date: string;
  clock_in_at: string;
};

type OpenCoverClock = {
  id: string;
  cover_driver_id: string;
  store_id: string | null;
  event_date: string;
  clock_in_at: string;
};

/**
 * Close every open clock row (employees + managers + cover drivers) whose day is over.
 * Needs the service-role client: it writes rows belonging to other people.
 * Best-effort by design — callers treat a failure as a no-op.
 */
export async function autoCloseOpenClocks(
  admin: SupabaseClient,
  opts?: { now?: Date; lookbackDays?: number },
): Promise<AutoCloseResult> {
  const now = opts?.now ?? new Date();
  const today = londonDateISO(now);
  const from = shiftDate(today, -(opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const graceMs = AUTO_CLOSE_GRACE_MIN * 60_000;
  const closed: AutoClosedRow[] = [];
  let scanned = 0;
  let waiting = 0;

  try {
    const [empOpenRes, mgrOpenRes, coverOpenRes, storesRes] = await Promise.all([
      admin
        // clock_events.clock_out_at is null exactly when a day is still open —
        // either a session is running, or the row pre-dates migration 029 and
        // has no session at all. One query still finds both.
        .from("clock_events")
        // The delivery columns ride along because a pre-029 row adopted into a
        // session below must carry its drops with it — that session becomes the
        // only thing the header is summed from, so leaving them behind would
        // have recomputeDayHeader wipe the day's counts (migration 033).
        .select(
          "id, employee_id, store_id, event_date, clock_in_at, clock_out_at, clock_in_lat, clock_in_lng, shift_id, manual_entry, manual_entry_by, manual_entry_at, manual_entry_reason, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, extra_short_reason, extra_long_reason",
        )
        .not("clock_in_at", "is", null)
        .is("clock_out_at", null)
        .gte("event_date", from)
        .lt("event_date", today)
        .order("event_date", { ascending: true })
        .limit(MAX_ROWS_PER_SWEEP),
      admin
        .from("manager_clock_events")
        .select("id, manager_id, store_id, event_date, clock_in_at")
        .not("clock_in_at", "is", null)
        .is("clock_out_at", null)
        .gte("event_date", from)
        .lt("event_date", today)
        .order("event_date", { ascending: true })
        .limit(MAX_ROWS_PER_SWEEP),
      admin
        .from("cover_driver_clock_events")
        .select("id, cover_driver_id, store_id, event_date, clock_in_at")
        .not("clock_in_at", "is", null)
        .is("clock_out_at", null)
        .gte("event_date", from)
        .lt("event_date", today)
        .order("event_date", { ascending: true })
        .limit(MAX_ROWS_PER_SWEEP),
      admin.from("stores").select("id, shift_times"),
    ]);

    const openEmp = (empOpenRes.data ?? []) as OpenClock[];
    const openMgr = (mgrOpenRes.data ?? []) as OpenManagerClock[];
    const openCover = (coverOpenRes.data ?? []) as OpenCoverClock[];
    scanned = openEmp.length + openMgr.length + openCover.length;
    if (scanned === 0) return { ok: true, scanned: 0, closed, waiting: 0 };

    // Each store closes at its own time — the last-resort end time before the
    // fixed fallback (see supabase_store_shift_times.sql).
    const storeClose = new Map<string, string | null>();
    for (const s of (storesRes.data ?? []) as Array<{ id: string; shift_times: { close?: string } | null }>) {
      storeClose.set(s.id, s.shift_times?.close ?? null);
    }

    // ---------------- employees ----------------
    if (openEmp.length > 0) {
      const empIds = Array.from(new Set(openEmp.map((r) => r.employee_id)));
      const dates = openEmp.map((r) => r.event_date).sort();
      const [rotaRes, schedRes] = await Promise.all([
        admin
          .from("rota_shifts")
          .select("id, employee_id, shift_date, start_time, end_time, is_day_off, manager_notes")
          .in("employee_id", empIds)
          .gte("shift_date", dates[0])
          .lte("shift_date", dates[dates.length - 1]),
        admin
          .from("employee_schedules")
          .select("employee_id, weekday, is_working, start_time, end_time")
          .in("employee_id", empIds),
      ]);

      type RotaRow = {
        id: string;
        employee_id: string;
        shift_date: string;
        start_time: string | null;
        end_time: string | null;
        is_day_off: boolean;
        manager_notes: string | null;
      };
      // A day can now hold several booked shifts (migration 032), so this must
      // keep every row per employee+date, not just the last one seen — a plain
      // Map.set on collision used to silently discard all but one shift, and
      // the sweep would then resolve a split day's forgotten clock-out against
      // whichever shift happened to survive, ignoring the one the open session
      // actually belongs to.
      const rotaByKey = new Map<string, RotaRow[]>();
      for (const r of (rotaRes.data ?? []) as RotaRow[]) {
        const key = `${r.employee_id}:${r.shift_date}`;
        const arr = rotaByKey.get(key) ?? [];
        arr.push(r);
        rotaByKey.set(key, arr);
      }

      /**
       * Pick the booked shift a still-open SESSION belongs to: the working shift
       * whose start is latest but not after the session's clock-in, i.e. the one
       * that was current when the person clocked in. Falls back to the earliest
       * shift if the clock-in landed before every booked start (e.g. they showed
       * up early). Day-off rows are never picked here — the caller already
       * discards a day-off `rota` via `!rota.is_day_off` at the call site, but
       * filtering here too keeps a single-shift day's existing behaviour exact.
       */
      function pickRotaForSession(rows: RotaRow[], clockInAt: string): RotaRow | undefined {
        const working = rows.filter((r) => !r.is_day_off && r.start_time);
        if (working.length <= 1) return working[0];
        const clockInParts = londonParts(new Date(clockInAt));
        const clockInMin = clockInParts.hour * 60 + clockInParts.minute;
        const startMin = (r: RotaRow) => timeToMinutes(r.start_time);
        const notAfter = working
          .filter((r) => startMin(r) <= clockInMin)
          .sort((a, b) => startMin(b) - startMin(a));
        if (notAfter.length) return notAfter[0];
        return [...working].sort((a, b) => startMin(a) - startMin(b))[0];
      }
      const tmplByKey = new Map<string, { start_time: string | null; end_time: string | null }>();
      for (const s of (schedRes.data ?? []) as Array<{
        employee_id: string;
        weekday: number;
        is_working: boolean;
        start_time: string | null;
        end_time: string | null;
      }>) {
        if (!s.is_working) continue;
        tmplByKey.set(`${s.employee_id}:${s.weekday}`, s);
      }

      for (const row of openEmp) {
        // Close the open SESSION, not the day. On a split day the header's
        // clock_in_at is the morning shift's start, so resolving from it would
        // measure the assumed end against the wrong shift — and the rota end
        // would fall before the evening shift even began.
        const session =
          (await findOpenSession(admin, row.employee_id)) ??
          (await adoptHeaderIntoSession(admin, row));
        if (!session || session.clock_event_id !== row.id) continue;

        const rota = pickRotaForSession(
          rotaByKey.get(`${row.employee_id}:${row.event_date}`) ?? [],
          session.clock_in_at,
        );
        const tmpl = tmplByKey.get(
          `${row.employee_id}:${weekdayIndex(parseISODate(row.event_date))}`,
        );
        const resolved = resolveAutoClockOut({
          eventDate: row.event_date,
          clockInAt: session.clock_in_at,
          // A rota end that lands before this shift started is discarded by
          // resolveAutoClockOut's `worked <= 0` guard, which is what makes a
          // second shift fall through to the store close / fallback instead of
          // inheriting the morning's finish time.
          rota: rota && !rota.is_day_off ? { start: rota.start_time, end: rota.end_time } : null,
          template: tmpl ? { start: tmpl.start_time, end: tmpl.end_time } : null,
          storeClose: row.store_id ? storeClose.get(row.store_id) ?? null : null,
        });
        if (now.getTime() < resolved.at.getTime() + graceMs) {
          waiting += 1;
          continue;
        }

        const clockOutAt = resolved.at.toISOString();
        let workedHours: number;
        try {
          // Guarded on the session still being open, so a real clock-out that
          // landed meanwhile wins.
          const didClose = await closeSession(admin, session.id, {
            clockOutAt,
            auto: { source: resolved.source, at: now.toISOString() },
          });
          if (!didClose) continue;
          await admin
            .from("clock_events")
            .update({
              auto_clocked_out: true,
              auto_clock_out_source: resolved.source,
              auto_clock_out_at: now.toISOString(),
            })
            .eq("id", row.id);
          ({ workedHours } = await recomputeDayHeader(admin, row.id));
        } catch (err) {
          console.error(
            "[auto-clock-out] employee update failed:",
            err instanceof Error ? err.message : err,
          );
          continue;
        }

        // A shift the system created at clock-in needs the real window stamped
        // on it. scheduled_hours is the SUMMED shifts, never end − start, which
        // on a split day would bill the gap between them.
        if (rota && rota.manager_notes === AUTO_SHIFT_NOTE && rota.start_time) {
          const endHHMM = londonParts(resolved.at);
          const end = `${String(endHHMM.hour).padStart(2, "0")}:${String(endHHMM.minute).padStart(2, "0")}`;
          await admin
            .from("rota_shifts")
            .update({ end_time: end, scheduled_hours: workedHours })
            .eq("id", rota.id);
        }

        closed.push({
          kind: "employee",
          id: row.id,
          personId: row.employee_id,
          eventDate: row.event_date,
          clockOutAt,
          source: resolved.source,
          // The day's total across every shift, not just the one just closed.
          hours: workedHours,
        });
      }
    }

    // ---------------- managers ----------------
    if (openMgr.length > 0) {
      const mgrIds = Array.from(new Set(openMgr.map((r) => r.manager_id)));
      const dates = openMgr.map((r) => r.event_date).sort();
      const { data: mgrShifts } = await admin
        .from("manager_shifts")
        .select("manager_id, shift_date, start_time, end_time, is_day_off")
        .in("manager_id", mgrIds)
        .gte("shift_date", dates[0])
        .lte("shift_date", dates[dates.length - 1]);

      const shiftByKey = new Map<string, { start_time: string | null; end_time: string | null; is_day_off: boolean }>();
      for (const s of (mgrShifts ?? []) as Array<{
        manager_id: string;
        shift_date: string;
        start_time: string | null;
        end_time: string | null;
        is_day_off: boolean;
      }>) {
        shiftByKey.set(`${s.manager_id}:${s.shift_date}`, s);
      }

      for (const row of openMgr) {
        // Close the open SESSION, not the day. On a split day the header's
        // clock_in_at is the morning shift's start, so resolving from it would
        // measure the assumed end against the wrong shift — and the rota end
        // would fall before the evening shift even began.
        const session =
          (await findOpenManagerSession(admin, row.manager_id)) ??
          (await adoptManagerHeaderIntoSession(admin, row));
        if (!session || session.clock_event_id !== row.id) continue;

        const shift = shiftByKey.get(`${row.manager_id}:${row.event_date}`);
        const resolved = resolveAutoClockOut({
          eventDate: row.event_date,
          clockInAt: session.clock_in_at,
          // A shift end that lands before this shift started is discarded by
          // resolveAutoClockOut's `worked <= 0` guard, which is what makes a
          // second shift fall through to the store close / fallback instead of
          // inheriting the morning's finish time.
          rota: shift && !shift.is_day_off ? { start: shift.start_time, end: shift.end_time } : null,
          storeClose: row.store_id ? storeClose.get(row.store_id) ?? null : null,
        });
        if (now.getTime() < resolved.at.getTime() + graceMs) {
          waiting += 1;
          continue;
        }

        const clockOutAt = resolved.at.toISOString();
        let workedHours: number;
        try {
          // Guarded on the session still being open, so a real clock-out that
          // landed meanwhile wins.
          const didClose = await closeManagerSession(admin, session.id, {
            clockOutAt,
            auto: { source: resolved.source, at: now.toISOString() },
          });
          if (!didClose) continue;
          await admin
            .from("manager_clock_events")
            .update({
              auto_clocked_out: true,
              auto_clock_out_source: resolved.source,
              auto_clock_out_at: now.toISOString(),
            })
            .eq("id", row.id);
          ({ workedHours } = await recomputeManagerDayHeader(admin, row.id));
        } catch (err) {
          console.error(
            "[auto-clock-out] manager update failed:",
            err instanceof Error ? err.message : err,
          );
          continue;
        }

        closed.push({
          kind: "manager",
          id: row.id,
          personId: row.manager_id,
          eventDate: row.event_date,
          clockOutAt,
          source: resolved.source,
          // The day's total across every shift, not just the one just closed.
          hours: workedHours,
        });
      }
    }

    // ---------------- cover drivers ----------------
    // Same shape as managers, but the expected end falls back through the
    // per-date rota cell, then their recurring weekly availability, then the
    // store's closing time.
    if (openCover.length > 0) {
      const driverIds = Array.from(new Set(openCover.map((r) => r.cover_driver_id)));
      const dates = openCover.map((r) => r.event_date).sort();
      const [coverShiftRes, coverSchedRes] = await Promise.all([
        admin
          .from("cover_driver_shifts")
          .select("cover_driver_id, shift_date, start_time, end_time, is_day_off")
          .in("cover_driver_id", driverIds)
          .gte("shift_date", dates[0])
          .lte("shift_date", dates[dates.length - 1]),
        admin
          .from("cover_driver_schedules")
          .select("cover_driver_id, weekday, is_working, start_time, end_time")
          .in("cover_driver_id", driverIds),
      ]);

      const coverShiftByKey = new Map<
        string,
        { start_time: string | null; end_time: string | null; is_day_off: boolean }
      >();
      for (const s of (coverShiftRes.data ?? []) as Array<{
        cover_driver_id: string;
        shift_date: string;
        start_time: string | null;
        end_time: string | null;
        is_day_off: boolean;
      }>) {
        coverShiftByKey.set(`${s.cover_driver_id}:${s.shift_date}`, s);
      }

      const coverTmplByKey = new Map<
        string,
        { start_time: string | null; end_time: string | null }
      >();
      for (const s of (coverSchedRes.data ?? []) as Array<{
        cover_driver_id: string;
        weekday: number;
        is_working: boolean;
        start_time: string | null;
        end_time: string | null;
      }>) {
        if (!s.is_working) continue;
        coverTmplByKey.set(`${s.cover_driver_id}:${s.weekday}`, s);
      }

      for (const row of openCover) {
        const shift = coverShiftByKey.get(`${row.cover_driver_id}:${row.event_date}`);
        const tmpl = coverTmplByKey.get(
          `${row.cover_driver_id}:${weekdayIndex(parseISODate(row.event_date))}`,
        );
        const resolved = resolveAutoClockOut({
          eventDate: row.event_date,
          clockInAt: row.clock_in_at,
          rota:
            shift && !shift.is_day_off
              ? { start: shift.start_time, end: shift.end_time }
              : null,
          template: tmpl ? { start: tmpl.start_time, end: tmpl.end_time } : null,
          storeClose: row.store_id ? storeClose.get(row.store_id) ?? null : null,
        });
        if (now.getTime() < resolved.at.getTime() + graceMs) {
          waiting += 1;
          continue;
        }

        const clockOutAt = resolved.at.toISOString();
        const { data: updated, error } = await admin
          .from("cover_driver_clock_events")
          .update({
            clock_out_at: clockOutAt,
            auto_clocked_out: true,
            auto_clock_out_source: resolved.source,
            auto_clock_out_at: now.toISOString(),
          })
          .eq("id", row.id)
          .is("clock_out_at", null)
          .select("id");
        if (error) {
          console.error("[auto-clock-out] cover driver update failed:", error.message);
          continue;
        }
        if (!updated || updated.length === 0) continue;

        closed.push({
          kind: "cover_driver",
          id: row.id,
          personId: row.cover_driver_id,
          eventDate: row.event_date,
          clockOutAt,
          source: resolved.source,
          hours:
            Math.round(
              ((resolved.at.getTime() - new Date(row.clock_in_at).getTime()) / 3_600_000) *
                100,
            ) / 100,
        });
      }
    }

    // One audit row per closed day — these are pay-affecting writes with no
    // human actor, so they need to be traceable.
    if (closed.length > 0) {
      const { error } = await admin.from("audit_log").insert(
        closed.map((c) => ({
          actor_id: null,
          actor_email: "system@auto-clock-out",
          action:
            c.kind === "manager"
              ? "auto_manager_clock_out"
              : c.kind === "cover_driver"
                ? "auto_cover_driver_clock_out"
                : "auto_clock_out",
          entity:
            c.kind === "manager"
              ? "manager_clock_event"
              : c.kind === "cover_driver"
                ? "cover_driver_clock_event"
                : "clock_event",
          entity_id: c.id,
          changes: {
            person_id: c.personId,
            event_date: c.eventDate,
            clock_out_at: c.clockOutAt,
            source: c.source,
            hours: c.hours,
          },
        })),
      );
      if (error) console.error("[auto-clock-out] audit write failed:", error.message);
    }

    return { ok: true, scanned, closed, waiting };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auto-clock-out] sweep failed:", message);
    return { ok: false, scanned, closed, waiting, error: message };
  }
}
