"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import { scanForAlertsBackground } from "./alerts";
import {
  formatDDMMYYYY,
  londonHHMM,
  parseISODate,
  startOfISOWeek,
  timeToMinutes,
  toISODate,
  todayISO,
} from "@/lib/utils";
import {
  detectStoreForLocation,
  verifyGeofenceAtStore,
  type GeofenceLogContext,
} from "@/lib/geofence-verify";
import { findEmployeeForUser } from "@/lib/employee-lookup";
import {
  londonWallClockToUtc,
  MAX_AUTO_SHIFT_HOURS,
  resolveManualClockOut,
} from "@/lib/auto-clock-out";
import {
  adoptHeaderIntoSession,
  closeSession,
  findOpenSession,
  openSession,
  overlapsExistingSession,
  recomputeDayHeader,
  sessionsForEvent,
} from "@/lib/clock-sessions";
import { employeeNiRate, rollupApprovedWeek } from "@/lib/employee-hours-rollup";
import { hasRole, resolveActiveStoreId, type ActionResult } from "@/lib/types";

/** Marker note for shifts the system created from a clock-in (no rota entry). */
const AUTO_SHIFT_NOTE = "Auto-created from clock-in";

/**
 * Boundary for user-triggered clock actions: converts a thrown error into a
 * returned { ok:false, error } so the message survives production. Next.js
 * masks messages thrown from server actions in prod builds — without this,
 * every validation error ("You're 300m from the store", "account not active",
 * …) surfaces to the employee as a generic 500.
 */
async function asResult(run: () => Promise<void>): Promise<ActionResult> {
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

async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

async function getEmployeeForUser(userId: string, userEmail: string) {
  return findEmployeeForUser(createServerSupabase(), userId, userEmail);
}

async function verifyGeofence(
  storeId: string,
  lat: number,
  lng: number,
  accuracy?: number | null,
  logCtx?: GeofenceLogContext,
) {
  return verifyGeofenceAtStore(createServerSupabase(), storeId, lat, lng, accuracy, logCtx);
}

type ClockInShiftCandidate = { id: string; is_day_off: boolean; start_time: string | null };

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
async function findShiftForClockIn(
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
async function applyAutoShiftForClockIn(input: {
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
async function stampAutoShiftWindow(
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
        scheduled_hours: Math.round(workedHours * 100) / 100,
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
    await admin
      .from("clock_events")
      .update({
        hours_approved: false,
        approved_hours: null,
        hours_approved_by: null,
        hours_approved_at: null,
      })
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
function revalidateClockPaths() {
  revalidatePath("/employee/attendance");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
}

export async function clockIn(input: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}): Promise<ActionResult> {
  return asResult(() => performClockIn(input));
}

async function performClockIn(input: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");
  if (employee.employment_status === "left" || employee.employment_status === "inactive") {
    throw new Error("Your account is not active.");
  }

  // Staff can work at any store, not only their home one. Detect which store
  // they're physically standing in from their location; that store is where the
  // day's work (and wages) are attributed. Also verifies they're in range.
  const detected = await detectStoreForLocation(
    supabase,
    input.latitude,
    input.longitude,
    input.accuracy,
    { actorEmail: user.email, employeeId: employee.id, action: "clock_in" },
  );
  const workedStoreId = detected.id;

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
      .update({
        shift_id: shiftId,
        // A day already carrying a shift keeps the store it started at; only a
        // fresh day takes the store just detected.
        store_id: existing.clock_in_at ? existing.store_id : workedStoreId,
      })
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
        clock_in_lat: input.latitude,
        clock_in_lng: input.longitude,
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
    lat: input.latitude,
    lng: input.longitude,
  });

  await recomputeDayHeader(supabase, clockEventId);

  // Signing off 4h and then working another 4h must not leave the day paid at
  // 4h. Revoking returns it to the pending queue with the full total.
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
    changes: { date: today, location: [input.latitude, input.longitude] },
  });

  // Auto-scan so late/variance alerts surface without a manual "Scan now".
  // Best-effort: never let a scan failure block the clock-in.
  await scanForAlertsBackground();

  revalidateClockPaths();
}

type ClockOutInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

export async function clockOut(input: ClockOutInput): Promise<ActionResult> {
  return asResult(() => performClockOut(input));
}

async function performClockOut(input: ClockOutInput) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");

  // Resolve the shift being closed from the OPEN SESSION, not from today's
  // date: a shift that started at 22:00 and runs past midnight is clocked out
  // on the following calendar day but belongs to the day it opened on.
  let session = await findOpenSession(supabase, employee.id);

  const today = todayISO();
  const { data: existing } = await supabase
    .from("clock_events")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("event_date", session?.event_date ?? today)
    .maybeSingle();

  if (!existing?.clock_in_at) {
    throw new Error("You haven't clocked in yet today.");
  }
  if (!session) {
    if (existing.clock_out_at) {
      throw new Error("You've already clocked out today.");
    }
    // Clocked in under the pre-029 build, clocking out after the deploy: the
    // header has the shift but no session row. Adopt it, then close it.
    session = await adoptHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      employee_id: employee.id,
      store_id: existing.store_id,
      event_date: existing.event_date,
    });
    if (!session) throw new Error("You haven't clocked in yet today.");
  }

  // Clock out at the same store they clocked in at — that's where the day's
  // work is recorded, so it's where they must be to sign off.
  await verifyGeofence(
    session.store_id ?? existing.store_id,
    input.latitude,
    input.longitude,
    input.accuracy,
    { actorEmail: user.email, employeeId: employee.id, action: "clock_out" },
  );

  const isDriver = hasRole(employee.position, "Driver");
  const shortMissing =
    input.short_deliveries_count == null || Number.isNaN(input.short_deliveries_count);
  const longMissing =
    input.long_deliveries_count == null || Number.isNaN(input.long_deliveries_count);
  if (isDriver && shortMissing && longMissing) {
    throw new Error(
      "Drivers must enter their short and long delivery counts before clocking out.",
    );
  }
  if (
    isDriver &&
    Number(input.extra_short_deliveries) > 0 &&
    !input.extra_short_reason?.trim()
  ) {
    throw new Error("Please give a reason for the extra short deliveries.");
  }
  if (
    isDriver &&
    Number(input.extra_long_deliveries) > 0 &&
    !input.extra_long_reason?.trim()
  ) {
    throw new Error("Please give a reason for the extra long deliveries.");
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();

  const closedOk = await closeSession(supabase, session.id, {
    clockOutAt: now,
    lat: input.latitude,
    lng: input.longitude,
  });
  if (!closedOk) throw new Error("You've already clocked out of that shift.");

  // Delivery counts are a DAY total on the header, not per shift: a driver
  // entering "12 short" at the end of their evening shift is reporting the
  // day's round so far, and the clock-out form pre-fills with what's already
  // recorded. Keeping them on the header also leaves the payout, the rota
  // delivery column and the Vita Mojo cross-check reading one row, unchanged.
  if (isDriver) {
    const extraShort = Math.max(0, Number(input.extra_short_deliveries) || 0);
    const extraLong = Math.max(0, Number(input.extra_long_deliveries) || 0);
    const { error } = await supabase
      .from("clock_events")
      .update({
        short_deliveries_count: Math.max(0, Number(input.short_deliveries_count) || 0),
        long_deliveries_count: Math.max(0, Number(input.long_deliveries_count) || 0),
        extra_short_deliveries: extraShort,
        extra_long_deliveries: extraLong,
        extra_short_reason:
          extraShort > 0 ? input.extra_short_reason?.trim() || null : null,
        extra_long_reason: extraLong > 0 ? input.extra_long_reason?.trim() || null : null,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  }

  // Header last: first-in / last-out / summed hours all come from the sessions.
  const { workedHours, lastOut } = await recomputeDayHeader(supabase, existing.id);

  // If the shift was auto-created at clock-in, stamp the real worked window on
  // it. The end is the day's LATEST clock-out and the hours are the SUM of its
  // shifts, so a split day neither bills the gap nor ends at the wrong time.
  await stampAutoShiftWindow(
    supabase,
    existing.shift_id,
    londonHHMM(lastOut ? new Date(lastOut) : nowDate),
    workedHours,
  );

  await writeAudit({
    action: "clock_out",
    entity: "clock_event",
    entity_id: employee.id,
    changes: {
      date: session.event_date,
      session_seq: session.seq,
      worked_hours: workedHours,
      location: [input.latitude, input.longitude],
      short_deliveries: input.short_deliveries_count ?? null,
      long_deliveries: input.long_deliveries_count ?? null,
    },
  });

  // Auto-scan so early-out / scheduled-vs-actual variance surfaces immediately.
  await scanForAlertsBackground();

  revalidateClockPaths();
}

type DeliveryCountInput = {
  short_count: number;
  long_count: number;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

export async function updateDeliveryCount(
  input: DeliveryCountInput,
): Promise<ActionResult> {
  return asResult(() => performUpdateDeliveryCount(input));
}

async function performUpdateDeliveryCount(input: DeliveryCountInput) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");
  if (!hasRole(employee.position, "Driver")) {
    throw new Error("Only drivers can update deliveries.");
  }

  const extraShort = Math.max(0, Number(input.extra_short_deliveries) || 0);
  const extraLong = Math.max(0, Number(input.extra_long_deliveries) || 0);
  if (extraShort > 0 && !input.extra_short_reason?.trim()) {
    throw new Error("Please give a reason for the extra short deliveries.");
  }
  if (extraLong > 0 && !input.extra_long_reason?.trim()) {
    throw new Error("Please give a reason for the extra long deliveries.");
  }

  const today = todayISO();
  const { data: existing } = await supabase
    .from("clock_events")
    .select("id")
    .eq("employee_id", employee.id)
    .eq("event_date", today)
    .maybeSingle();
  if (!existing) throw new Error("No clock event for today.");

  const { error } = await supabase
    .from("clock_events")
    .update({
      short_deliveries_count: Math.max(0, Number(input.short_count) || 0),
      long_deliveries_count: Math.max(0, Number(input.long_count) || 0),
      extra_short_deliveries: extraShort,
      extra_long_deliveries: extraLong,
      extra_short_reason: extraShort > 0 ? input.extra_short_reason!.trim() : null,
      extra_long_reason: extraLong > 0 ? input.extra_long_reason!.trim() : null,
    })
    .eq("id", existing.id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "update_deliveries",
    entity: "clock_event",
    entity_id: existing.id,
    changes: { short: input.short_count, long: input.long_count, extraShort, extraLong },
  });

  revalidatePath("/employee/attendance");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  revalidatePath("/rota");
}

type SetClockDeliveriesInput = {
  employee_id: string;
  event_date: string;
  short_deliveries_count: number;
  long_deliveries_count: number;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

/**
 * Staff (manager/admin) edit of a driver's clocked deliveries for a given day.
 * Drivers usually enter these themselves at clock-out; managers and admins can
 * correct the count or log extra deliveries (with a reason) after the fact.
 */
export async function setClockDeliveries(
  input: SetClockDeliveriesInput,
): Promise<ActionResult> {
  return asResult(() => performSetClockDeliveries(input));
}

async function performSetClockDeliveries(input: SetClockDeliveriesInput) {
  const user = await requireAllowed();
  if (user.allowed!.role !== "admin" && user.allowed!.role !== "manager") {
    throw new Error("Only managers and admins can edit clocked deliveries.");
  }
  const supabase = createServerSupabase();

  const { data: employee } = await supabase
    .from("employees")
    .select("id, store_id")
    .eq("id", input.employee_id)
    .maybeSingle();
  if (!employee) throw new Error("Employee not found.");

  // Find the day's clock event first — its store is where the driver actually
  // worked that day (which may not be their home store).
  const { data: existing } = await supabase
    .from("clock_events")
    .select("id, store_id")
    .eq("employee_id", input.employee_id)
    .eq("event_date", input.event_date)
    .maybeSingle();

  // Managers are limited to their own store: they can edit a driver's deliveries
  // for any day that driver worked AT the manager's store. When no clock row
  // exists yet, a manager creates one at their own store.
  const managerStoreId = user.allowed!.role === "manager" ? resolveActiveStoreId(user.allowed) : null;
  const eventStoreId = existing?.store_id ?? managerStoreId ?? employee.store_id ?? null;
  if (user.allowed!.role === "manager" && eventStoreId !== managerStoreId) {
    throw new Error("You can only edit drivers for days they worked at your store.");
  }

  const shortCount = Math.max(0, Number(input.short_deliveries_count) || 0);
  const longCount = Math.max(0, Number(input.long_deliveries_count) || 0);
  const extraShort = Math.max(0, Number(input.extra_short_deliveries) || 0);
  const extraLong = Math.max(0, Number(input.extra_long_deliveries) || 0);
  if (extraShort > 0 && !input.extra_short_reason?.trim()) {
    throw new Error("Please give a reason for the extra short deliveries.");
  }
  if (extraLong > 0 && !input.extra_long_reason?.trim()) {
    throw new Error("Please give a reason for the extra long deliveries.");
  }

  const fields = {
    short_deliveries_count: shortCount,
    long_deliveries_count: longCount,
    extra_short_deliveries: extraShort,
    extra_long_deliveries: extraLong,
    extra_short_reason: extraShort > 0 ? input.extra_short_reason!.trim() : null,
    extra_long_reason: extraLong > 0 ? input.extra_long_reason!.trim() : null,
  };

  if (existing) {
    const { error } = await supabase.from("clock_events").update(fields).eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    if (!eventStoreId) throw new Error("Driver has no store assigned.");
    const { error } = await supabase.from("clock_events").insert({
      employee_id: input.employee_id,
      store_id: eventStoreId,
      event_date: input.event_date,
      ...fields,
    });
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: "staff_edit_deliveries",
    entity: "clock_event",
    entity_id: existing?.id ?? input.employee_id,
    changes: { event_date: input.event_date, ...fields, by: user.email },
  });

  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/live");
  revalidatePath("/manager/live");
}

// =============================================================
// Manager-entered clock times.
//
// A clock-in can be recorded two ways: the employee self-clocks inside the
// geofence (above), or a manager records it for someone who forgot. This is the
// second path.
//
// It BYPASSES THE GEOFENCE, which is the geofence's whole purpose — so every
// row it writes is flagged `manual_entry`, carries a reason, leaves
// clock_in_lat/lng null, and lands in the audit log. It reuses
// applyAutoShiftForClockIn and revalidateClockPaths so a manually recorded day
// appears on the Rota and Live board exactly like a real one, which is the
// entire requirement.
// =============================================================

/** How much of the day the manager supplied. Stored on the row for the UI. */
type ManualEntryFields = "in" | "out" | "both";

/** Session + role gate. Called BEFORE any lookup so a non-staff caller reads nothing. */
async function requireClockEntryStaff() {
  const user = await requireAllowed();
  const role = user.allowed!.role;
  if (role !== "admin" && role !== "manager") {
    throw new Error("Only managers and admins can record clock times.");
  }
  return user;
}

/** A manager may only write against the store they're currently running. */
function assertClockEntryStore(
  user: Awaited<ReturnType<typeof requireClockEntryStaff>>,
  storeId: string,
) {
  if (user.allowed!.role !== "manager") return;
  const activeStore = resolveActiveStoreId(user.allowed);
  if (!activeStore) throw new Error("No store assigned to your account.");
  if (storeId !== activeStore) {
    throw new Error("You can only record clock times for the store you're managing.");
  }
}

export type ManualClockEntryInput = {
  employee_id: string;
  /** YYYY-MM-DD. Defaults to today on the Live board. */
  event_date: string;
  /** "HH:MM", UK wall clock. */
  clock_in_time: string;
  /** "HH:MM". Omit while the employee is still on shift. */
  clock_out_time?: string | null;
  reason: string;
};

export async function upsertManualClockEntry(
  input: ManualClockEntryInput,
): Promise<ActionResult> {
  return asResult(() => performManualClockEntry(input));
}

async function performManualClockEntry(input: ManualClockEntryInput) {
  // Role gate first — a non-staff caller must not get as far as reading a row.
  const user = await requireClockEntryStaff();
  const supabase = createServerSupabase();

  if (!input.employee_id) throw new Error("Select an employee");
  if (!input.event_date) throw new Error("Date is required");
  if (!input.clock_in_time) throw new Error("Clock-in time is required");
  if (!input.reason?.trim()) {
    throw new Error("Give a reason — this records hours without a location check.");
  }

  const { data: employee } = await supabase
    .from("employees")
    .select("id, name, store_id, employment_status")
    .eq("id", input.employee_id)
    .maybeSingle();
  if (!employee) throw new Error("Employee not found.");
  if (employee.employment_status === "left" || employee.employment_status === "inactive") {
    throw new Error(`${employee.name} is not an active employee.`);
  }

  // The work is attributed to the store the manager is running — that's where
  // they saw the person. Admins fall back to the employee's home store.
  const storeId =
    user.allowed!.role === "manager"
      ? resolveActiveStoreId(user.allowed) ?? employee.store_id
      : employee.store_id;
  if (!storeId) throw new Error("That employee has no store assigned.");
  assertClockEntryStore(user, storeId);

  const clockInAt = londonWallClockToUtc(input.event_date, input.clock_in_time);
  if (isNaN(clockInAt.getTime())) throw new Error("Clock-in time is not valid.");

  const now = new Date();
  if (clockInAt.getTime() > now.getTime()) {
    throw new Error("Clock-in time can't be in the future.");
  }

  let clockOutAt: Date | null = null;
  if (input.clock_out_time) {
    if (timeToMinutes(input.clock_out_time) === timeToMinutes(input.clock_in_time)) {
      throw new Error("Clock-out can't be the same time as clock-in.");
    }
    // A clock-out earlier in the day than the clock-in means the shift crossed
    // midnight, so it lands on the following date — the day still belongs to
    // event_date, matching how a real overnight clock-out is recorded.
    const resolved = resolveManualClockOut(
      input.event_date,
      input.clock_in_time,
      input.clock_out_time,
    );
    clockOutAt = resolved.at;
    if (isNaN(clockOutAt.getTime())) throw new Error("Clock-out time is not valid.");
    if (clockOutAt.getTime() > now.getTime()) {
      throw new Error(
        `That shift ends at ${input.clock_out_time} on ${formatDDMMYYYY(resolved.date)}, which hasn't happened yet. Record it once the shift has finished — or leave clock-out blank if they're still working.`,
      );
    }
    const hours = (clockOutAt.getTime() - clockInAt.getTime()) / 3_600_000;
    if (hours > MAX_AUTO_SHIFT_HOURS) {
      throw new Error(`That's over ${MAX_AUTO_SHIFT_HOURS} hours — check the times.`);
    }
  }

  const { data: existing } = await supabase
    .from("clock_events")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("event_date", input.event_date)
    .maybeSingle();

  // Changing the hours under an approval someone already signed off would move
  // the weekly rollup silently. Make them unapprove first.
  if (existing?.hours_approved) {
    throw new Error(
      "That day is already approved. Unapprove it first, then change the times.",
    );
  }

  // A day the employee is still working can't take an open manual shift on top
  // — the one-open-session rule applies however the shift was recorded.
  if (!clockOutAt) {
    const open = await findOpenSession(supabase, employee.id);
    if (open) {
      throw new Error(
        `${employee.name} is already clocked in. Record the clock-out time as well, or wait for them to clock out.`,
      );
    }
  }

  // Adopt a pre-029 day so its existing shift is visible to the overlap check
  // below — otherwise a second manual entry could double-pay the same hours.
  if (existing?.clock_in_at) {
    await adoptHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      employee_id: employee.id,
      store_id: existing.store_id,
      event_date: input.event_date,
    });
  }

  const daySessions = existing ? await sessionsForEvent(supabase, existing.id) : [];
  if (overlapsExistingSession(daySessions, clockInAt, clockOutAt)) {
    throw new Error(
      "Those times overlap a shift already recorded for that day. Check the existing times first.",
    );
  }

  const shift = await findShiftForClockIn(supabase, employee.id, input.event_date);

  // The rota cell starts when the day's EARLIEST shift did — by clock time, not
  // by which shift was recorded first. A manager filling in a forgotten morning
  // after the evening is the case that breaks any entry-order assumption.
  const earliestIn = daySessions.reduce(
    (min, s) =>
      new Date(s.clock_in_at).getTime() < min.getTime() ? new Date(s.clock_in_at) : min,
    clockInAt,
  );

  const shiftId = await applyAutoShiftForClockIn({
    employeeId: employee.id,
    storeId,
    eventDate: input.event_date,
    startTime: londonHHMM(earliestIn),
    shift,
  });

  const fields: ManualEntryFields = clockOutAt ? "both" : "in";
  // The header flags mean "this day contains manager-entered time" — a day whose
  // second shift was hand-recorded is still a day that wasn't fully
  // geofence-verified, and the badge is what tells a reviewer to look.
  const headerFlags = {
    shift_id: shiftId,
    manual_entry: true,
    manual_entry_by: user.id,
    manual_entry_at: now.toISOString(),
    manual_entry_reason: input.reason.trim(),
    manual_entry_fields: fields,
  };

  let clockEventId = existing?.id as string | undefined;
  if (existing) {
    const { error } = await supabase
      .from("clock_events")
      .update(headerFlags)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await supabase
      .from("clock_events")
      .insert({
        employee_id: employee.id,
        store_id: storeId,
        event_date: input.event_date,
        clock_in_at: clockInAt.toISOString(),
        // Deliberately null: a row with no coordinates was never location-verified.
        clock_in_lat: null,
        clock_in_lng: null,
        ...headerFlags,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    clockEventId = created?.id;
  }
  if (!clockEventId) throw new Error("Could not record those times. Please try again.");

  const manualStamp = {
    by: user.id,
    at: now.toISOString(),
    reason: input.reason.trim(),
  };
  const session = await openSession(supabase, {
    clockEventId,
    employeeId: employee.id,
    storeId,
    eventDate: input.event_date,
    clockInAt: clockInAt.toISOString(),
    lat: null,
    lng: null,
    manual: manualStamp,
  });
  if (clockOutAt) {
    await closeSession(supabase, session.id, {
      clockOutAt: clockOutAt.toISOString(),
      lat: null,
      lng: null,
      manual: manualStamp,
    });
  }

  const { workedHours, lastOut } = await recomputeDayHeader(supabase, clockEventId);
  // Stamp the day's LATEST clock-out, not the one just typed — adding a
  // forgotten morning shift must not pull the cell's end back to 13:00.
  if (lastOut) {
    await stampAutoShiftWindow(
      supabase,
      shiftId,
      londonHHMM(new Date(lastOut)),
      workedHours,
    );
  }

  await writeAudit({
    action: daySessions.length > 0 ? "manual_clock_entry_added_shift" : "manual_clock_entry",
    entity: "clock_event",
    entity_id: clockEventId,
    changes: {
      employee_id: employee.id,
      employee_name: employee.name,
      event_date: input.event_date,
      session_seq: session.seq,
      clock_in_at: clockInAt.toISOString(),
      clock_out_at: clockOutAt?.toISOString() ?? null,
      reason: input.reason.trim(),
      by: user.email,
    },
  });

  // Re-scan so the unexpected_absence / late_clock_in alerts raised while the
  // clock-in was missing reflect the corrected start time.
  await scanForAlertsBackground();

  revalidateClockPaths();
}
