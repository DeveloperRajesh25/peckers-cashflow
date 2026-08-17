// =============================================================
// The shared employee clock-IN routine, and the helpers every clock write path
// uses.
//
// This lives in lib/ rather than app/actions/clock.ts for one reason: it is
// reached from two server actions (the ordinary geofenced clock-in, and the
// OTP-authorised early clock-in in app/actions/early-clock-in.ts), and every
// export of a "use server" module is a client-callable endpoint. Exporting
// performClockIn from there would hand the browser a way to pass
// { kind: "preauthorised", storeId } and clock in at any store with no geofence
// at all.
//
// The context union is the ONLY thing that branches. Everything after the store
// is resolved — the open-session guard, the rota link, the header upsert, the
// session, recomputeDayHeader, approval revocation, audit, revalidation — runs
// once and identically, so an OTP clock-in produces a byte-for-byte ordinary
// clock record.
// =============================================================

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { writeAudit } from "@/app/actions/audit";
import { scanForAlertsBackground } from "@/app/actions/alerts";
import {
  londonHHMM,
  parseISODate,
  roundHoursToMinute,
  startOfISOWeek,
  timeToMinutes,
  toISODate,
  todayISO,
} from "@/lib/utils";
import { detectStoreForLocation } from "@/lib/geofence-verify";
import { findEmployeeForUser } from "@/lib/employee-lookup";
import {
  adoptHeaderIntoSession,
  findOpenSession,
  hasSessionOnDate,
  openSession,
  recomputeDayHeader,
} from "@/lib/clock-sessions";
import { employeeNiRate, rollupApprovedWeek } from "@/lib/employee-hours-rollup";
import { bookableStartMinutes, isEarlyClockIn } from "@/lib/early-clock-in";
import type { ActionResult } from "@/lib/types";

/** Marker note for shifts the system created from a clock-in (no rota entry). */
export const AUTO_SHIFT_NOTE = "Auto-created from clock-in";

/** Shown when someone tries to start before their booked shift without a code. */
export const EARLY_CLOCK_IN_BLOCKED_MESSAGE =
  "You're starting early — ask your manager for an OTP to clock in.";

/**
 * Boundary for user-triggered clock actions: converts a thrown error into a
 * returned { ok:false, error } so the message survives production. Next.js
 * masks messages thrown from server actions in prod builds — without this,
 * every validation error ("You're 300m from the store", "account not active",
 * …) surfaces to the employee as a generic 500.
 */
export async function asResult(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    console.error("[clock] action failed:", err);
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Something went wrong. Please try again.";
    return { ok: false, error: message };
  }
}

export async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

export async function getEmployeeForUser(userId: string, userEmail: string) {
  return findEmployeeForUser(createServerSupabase(), userId, userEmail);
}

export type ClockInShiftCandidate = {
  id: string;
  is_day_off: boolean;
  start_time: string | null;
};

/**
 * Find the rota shift a clock-in should attach to. A day can now hold several
 * booked shifts (migration 032 dropped the one-per-day constraint), so this
 * can no longer be a `.maybeSingle()` lookup — that throws the moment a
 * second shift exists for the day, which would break clock-in outright for
 * anyone with a split shift booked.
 *
 * Picks, in order:
 *   1. A shift still needing conversion (day off / no start time) — the
 *      "clocked in without a real booking yet" case `applyAutoShiftForClockIn`
 *      exists to handle, unchanged from before.
 *   2. Otherwise the EARLIEST booked shift by start time, so a fresh clock-in
 *      links to the first of the day's real shifts. Which one it lands on
 *      barely matters functionally: `stampAutoShiftWindow` only ever touches a
 *      shift carrying AUTO_SHIFT_NOTE, so a real manager-booked shift (this
 *      case) is never rewritten regardless of which one gets linked here.
 */
export async function findShiftForClockIn(
  supabase: ReturnType<typeof createServerSupabase>,
  employeeId: string,
  date: string,
): Promise<ClockInShiftCandidate | null> {
  const { data } = await supabase
    .from("rota_shifts")
    .select("id, is_day_off, start_time")
    .eq("employee_id", employeeId)
    .eq("shift_date", date)
    .order("start_time", { ascending: true, nullsFirst: true });
  const rows = (data ?? []) as ClockInShiftCandidate[];
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return rows.find((s) => s.is_day_off || !s.start_time) ?? rows[0];
}

/**
 * Reflect a clock-in on the rota so the employee shows as present that day.
 * Two cases need a system-managed shift:
 *   1. No shift row at all → create one (start = clock-in time).
 *   2. A row exists but it's a Day Off or has no start time → convert it to a
 *      working shift. (The "clocked in on a day off / covering" case.) A real
 *      scheduled shift is left untouched.
 *
 * Shared by self clock-in and manager-entered clock-in so a manually recorded
 * day appears on the Rota exactly like a real one — that parity is the whole
 * point of the manual-entry feature.
 *
 * Best-effort: this is a convenience, not a requirement. It needs the
 * service-role client (employees can't write rota_shifts under RLS), so if
 * provisioning isn't configured — or anything else fails — swallow it. It must
 * NEVER block the clock-in itself.
 *
 * Returns the shift id to attach to the clock row, if there is one.
 */
export async function applyAutoShiftForClockIn(input: {
  employeeId: string;
  storeId: string;
  eventDate: string;
  /** HH:MM in UK wall-clock time. */
  startTime: string;
  shift: { id: string; is_day_off: boolean; start_time: string | null } | null;
}): Promise<string | null> {
  const { employeeId, storeId, eventDate, startTime, shift } = input;
  let shiftId = shift?.id ?? null;

  const needsAutoShift = !shift || shift.is_day_off || !shift.start_time;
  if (!needsAutoShift) return shiftId;

  try {
    if (isProvisioningConfigured()) {
      const admin = createAdminClient();
      if (!shift) {
        const { data: created } = await admin
          .from("rota_shifts")
          .insert({
            employee_id: employeeId,
            store_id: storeId,
            shift_date: eventDate,
            start_time: startTime,
            end_time: null,
            is_day_off: false,
            scheduled_hours: 0,
            manager_notes: AUTO_SHIFT_NOTE,
          })
          .select("id")
          .maybeSingle();
        if (created) shiftId = created.id;
      } else {
        // Convert the existing day-off / empty shift into a worked one at the
        // store they actually turned up to (they may be covering elsewhere).
        await admin
          .from("rota_shifts")
          .update({
            store_id: storeId,
            start_time: startTime,
            end_time: null,
            is_day_off: false,
            scheduled_hours: 0,
            manager_notes: AUTO_SHIFT_NOTE,
          })
          .eq("id", shift.id);
        shiftId = shift.id;
      }
    }
  } catch (err) {
    console.error(
      "[clock] auto-shift creation failed (clock-in continues):",
      err instanceof Error ? err.message : err,
    );
  }
  return shiftId;
}

/**
 * Stamp an auto-created rota cell with the day's real window.
 *
 * `scheduled_hours` is the SUMMED session hours, not end − start: on a day
 * worked 09:00–13:00 and 17:00–21:00 the cell reads 09:00–21:00 but must total
 * 8h, or the Rota (and every wage forecast built on it) pays for the afternoon
 * off as well.
 *
 * `manager_notes` is left as exactly AUTO_SHIFT_NOTE even on a multi-shift day.
 * Three modules compare that string with strict equality to decide whether a
 * cell is system-managed — the auto clock-out sweep among them — so appending
 * a shift count here would quietly stop them recognising their own cells. The
 * shift count is shown from session data instead.
 *
 * Best-effort throughout: needs the service-role client, and must never block
 * a clock action.
 */
export async function stampAutoShiftWindow(
  supabase: ReturnType<typeof createServerSupabase>,
  shiftId: string | null,
  endHHMM: string,
  workedHours: number,
) {
  if (!shiftId || !isProvisioningConfigured()) return;
  try {
    const { data: shift } = await supabase
      .from("rota_shifts")
      .select("id, start_time, manager_notes")
      .eq("id", shiftId)
      .maybeSingle();
    if (!shift?.start_time || shift.manager_notes !== AUTO_SHIFT_NOTE) return;

    const admin = createAdminClient();
    await admin
      .from("rota_shifts")
      .update({
        end_time: endHHMM,
        scheduled_hours: roundHoursToMinute(workedHours),
      })
      .eq("id", shift.id);
  } catch (err) {
    console.error(
      "[clock] auto-shift end-stamp failed (clock action continues):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * A day that was already approved has just gained another shift, so the
 * approved figure is no longer the day's total. Revoke the approval and
 * re-roll the week, putting the day back in the manager's pending queue.
 *
 * Without this the second shift is invisible to payroll: resolvedDayHours
 * prefers approved_hours, so a day approved at 4h stays paid at 4h no matter
 * how much more was worked.
 *
 * Service-role, because employee_hours writes are staff-only under RLS and the
 * actor here is the employee. Best-effort — it must never block a clock-in.
 */
async function revokeApprovalForAddedShift(input: {
  clockEventId: string;
  employeeId: string;
  eventDate: string;
}) {
  if (!isProvisioningConfigured()) return;
  try {
    const admin = createAdminClient();
    // Only the day's roll-up is restated. The already-approved shift KEEPS its
    // approval and keeps paying (migration 035) — it was worked and signed off,
    // and starting a second shift is no reason to take the first one back off
    // the sheet. recomputeDayHeader flips hours_approved to false because the
    // new shift is outstanding, which is what returns the day to the queue.
    await admin
      .from("clock_events")
      .update({ hours_approved_by: null, hours_approved_at: null })
      .eq("id", input.clockEventId);

    const rate = await employeeNiRate(admin, input.employeeId);
    const weekStart = toISODate(startOfISOWeek(parseISODate(input.eventDate)));
    await rollupApprovedWeek(admin, input.employeeId, weekStart, rate, null);

    await writeAudit({
      action: "approval_revoked_new_shift",
      entity: "clock_event",
      entity_id: input.clockEventId,
      changes: {
        employee_id: input.employeeId,
        event_date: input.eventDate,
        reason: "Another shift was started on an already-approved day",
      },
    });
  } catch (err) {
    console.error(
      "[clock] could not revoke approval for an added shift:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Paths refreshed after any clock write, self-service or manager-entered. */
export function revalidateClockPaths() {
  revalidatePath("/employee/attendance");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  // A clock write moves the payout too: a new shift lands unapproved, which
  // takes the day back off the sheet until it's signed off (migration 035).
  revalidatePath("/cash-flow/payout");
  revalidatePath("/manager/cash-flow/payout");
}

/** London wall-clock minutes since midnight — never Date#getHours(), which
 *  answers in the server's timezone. */
export function londonNowMinutes(now: Date = new Date()): number {
  return timeToMinutes(londonHHMM(now));
}

/**
 * Withdraw any live OTP request the employee is holding. Called when they clock
 * in through the ordinary path instead — they gave up on the phone call and
 * waited for their start time, and leaving the code live would keep them on the
 * manager's Live board as still waiting.
 *
 * Service-role: early_clock_in_requests is staff-only under RLS (migration
 * 043), and the actor here is the employee. Best-effort — a cleanup failure
 * must not block a clock-in that has already been written.
 */
export async function cancelPendingEarlyClockInRequests(input: {
  employeeId: string;
  reason: string;
}): Promise<void> {
  if (!isProvisioningConfigured()) return;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("early_clock_in_requests")
      .update({ status: "cancelled" })
      .eq("employee_id", input.employeeId)
      .eq("status", "pending")
      .select("id");
    if ((data ?? []).length === 0) return;
    await writeAudit({
      action: "early_clock_in_otp_cancelled",
      entity: "early_clock_in_request",
      entity_id: data![0].id,
      changes: { employee_id: input.employeeId, reason: input.reason },
    });
  } catch (err) {
    console.error(
      "[clock] could not clear a pending early clock-in request:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Refuse a clock-in made before the employee's booked start.
 *
 * The crew screen already routes an early press to requestEarlyClockInOtp, so
 * this is rarely what the employee sees. It exists because a gate enforced only
 * in the client is not a gate — without it the whole feature is bypassed by
 * calling clockIn() directly. Both sides evaluate isEarlyClockIn so they cannot
 * disagree about a verdict a manager would have to explain.
 */
async function assertNotEarlyClockIn(
  supabase: ReturnType<typeof createServerSupabase>,
  employeeId: string,
  eventDate: string,
  shift: ClockInShiftCandidate | null,
) {
  const scheduledStartMinutes = bookableStartMinutes(shift);
  if (scheduledStartMinutes == null) return;
  const early = isEarlyClockIn({
    nowMinutes: londonNowMinutes(),
    scheduledStartMinutes,
    hasSessionToday: await hasSessionOnDate(supabase, employeeId, eventDate),
  });
  if (early) throw new Error(EARLY_CLOCK_IN_BLOCKED_MESSAGE);
}

/**
 * How this clock-in proved where the employee is standing.
 *
 * `geo` is the ordinary path: a fresh fix, judged now. `preauthorised` is the
 * OTP path, where the fix was judged at REQUEST time — a phone call to the
 * manager outlives MAX_FIX_AGE_MS, so re-checking here would refuse a position
 * the geofence has already accepted (migration 043 explains the split).
 */
export type ClockInContext =
  | {
      kind: "geo";
      latitude: number;
      longitude: number;
      accuracy?: number | null;
      /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
      fix_age_ms: number | null;
    }
  | {
      kind: "preauthorised";
      storeId: string;
      latitude: number;
      longitude: number;
      requestId: string;
    };

export type ClockInOutcome = {
  clockEventId: string;
  clockInAt: string;
  storeId: string;
};

export async function performClockIn(ctx: ClockInContext): Promise<ClockInOutcome> {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");
  if (employee.employment_status === "left" || employee.employment_status === "inactive") {
    throw new Error("Your account is not active.");
  }

  // Staff can work at any store, not only their home one. On the geo path the
  // store is detected from where they're standing — that store is where the
  // day's work (and wages) are attributed — which also verifies they're in
  // range and that the fix is recent enough to prove where they are NOW. On the
  // pre-authorised path that verdict was already reached and persisted on the
  // OTP request, so it is trusted rather than re-taken.
  let workedStoreId: string;
  if (ctx.kind === "geo") {
    const detected = await detectStoreForLocation(
      supabase,
      {
        lat: ctx.latitude,
        lng: ctx.longitude,
        accuracy: ctx.accuracy,
        ageMs: ctx.fix_age_ms,
      },
      { actorEmail: user.email, employeeId: employee.id, action: "clock_in" },
    );
    workedStoreId = detected.id;
  } else {
    workedStoreId = ctx.storeId;
  }

  const today = todayISO();

  // The only thing that blocks a clock-in is ALREADY BEING CLOCKED IN. A day can
  // hold several shifts — morning, break, evening — so "you've already clocked
  // in today" is no longer a reason to refuse. The open session is looked up
  // across every date, not just today, because a shift opened at 22:00 and
  // still running belongs to yesterday.
  const open = await findOpenSession(supabase, employee.id);
  if (open) {
    throw new Error(
      open.event_date === today
        ? "You're already clocked in. Clock out before starting another shift."
        : `You're still clocked in from ${open.event_date}. Clock out of that shift first.`,
    );
  }

  // Link to today's scheduled shift if one exists. Clock-in is self-service:
  // staff can clock in whenever they're on-site, with or without a shift on the
  // rota (covering a colleague, picking up an extra shift, etc.). A scheduled
  // shift simply gets attached so the Live board can compare planned vs actual.
  const shift = await findShiftForClockIn(supabase, employee.id, today);

  if (ctx.kind === "geo") {
    await assertNotEarlyClockIn(supabase, employee.id, today, shift);
  }

  const { data: existing } = await supabase
    .from("clock_events")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("event_date", today)
    .maybeSingle();

  const nowDate = new Date();
  const now = nowDate.toISOString();

  const shiftId = await applyAutoShiftForClockIn({
    employeeId: employee.id,
    storeId: workedStoreId,
    eventDate: today,
    // Later shifts must not move the rota cell's start time — the day began
    // when the FIRST shift did.
    startTime: londonHHMM(existing?.clock_in_at ? new Date(existing.clock_in_at) : nowDate),
    shift,
  });

  // One header row per day, unchanged (clock_events_unique). It carries the
  // day's store and rota link; the shift itself goes in clock_sessions.
  let clockEventId = existing?.id as string | undefined;
  if (existing) {
    const { error } = await supabase
      .from("clock_events")
      // The day's store is deliberately NOT written here: recomputeDayHeader
      // derives it from the shifts below, so clocking in at another store moves
      // the day there rather than leaving it frozen at wherever it started.
      .update({ shift_id: shiftId })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await supabase
      .from("clock_events")
      .insert({
        employee_id: employee.id,
        shift_id: shiftId,
        store_id: workedStoreId,
        event_date: today,
        clock_in_at: now,
        clock_in_lat: ctx.latitude,
        clock_in_lng: ctx.longitude,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    clockEventId = created?.id;
  }
  if (!clockEventId) throw new Error("Could not record the clock-in. Please try again.");

  // A pre-029 day may have a clock-in on the header but no session to sit
  // beside. Adopt it so the day's shifts are complete before adding this one.
  if (existing?.clock_in_at) {
    await adoptHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      employee_id: employee.id,
      store_id: existing.store_id,
      event_date: today,
    });
  }

  await openSession(supabase, {
    clockEventId,
    employeeId: employee.id,
    storeId: workedStoreId,
    eventDate: today,
    clockInAt: now,
    lat: ctx.latitude,
    lng: ctx.longitude,
  });

  await recomputeDayHeader(supabase, clockEventId);

  // Signing off 4h and then working another 4h must not leave the day reading
  // as fully approved. The new shift is unapproved, so recomputeDayHeader has
  // already returned the day to the pending queue; this clears the stale
  // "approved by" stamp and restates the week.
  if (existing?.hours_approved) {
    await revokeApprovalForAddedShift({
      clockEventId,
      employeeId: employee.id,
      eventDate: today,
    });
  }

  await writeAudit({
    action: "clock_in",
    entity: "clock_event",
    entity_id: employee.id,
    changes: {
      date: today,
      location: [ctx.latitude, ctx.longitude],
      ...(ctx.kind === "preauthorised"
        ? { early_clock_in_request_id: ctx.requestId }
        : {}),
    },
  });

  // They clocked in on time after all, so any code the manager issued is spent.
  // After the write, never before: cancelling a live request and then failing to
  // record the shift would leave them with neither.
  if (ctx.kind === "geo") {
    await cancelPendingEarlyClockInRequests({
      employeeId: employee.id,
      reason: "Clocked in through the normal path",
    });
  }

  // Auto-scan so late/variance alerts surface without a manual "Scan now".
  // Best-effort: never let a scan failure block the clock-in.
  await scanForAlertsBackground();

  revalidateClockPaths();

  return { clockEventId, clockInAt: now, storeId: workedStoreId };
}
