"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { scanForAlertsBackground } from "./alerts";
import {
  formatDDMMYYYY,
  londonHHMM,
  timeToMinutes,
  todayISO,
} from "@/lib/utils";
import { verifyGeofenceForClockOut } from "@/lib/geofence-verify";
import {
  londonWallClockToUtc,
  MAX_AUTO_SHIFT_HOURS,
  resolveManualClockOut,
} from "@/lib/auto-clock-out";
import {
  adoptHeaderIntoSession,
  applyDayDeliveryTotal,
  closeSession,
  findOpenSession,
  normaliseDeliveryInput,
  openSession,
  overlapsExistingSession,
  recomputeDayHeader,
  sessionsForEvent,
  setSessionDeliveries,
  type DeliveryInput,
} from "@/lib/clock-sessions";
// The clock-IN routine and the helpers it shares with the manager-entry path
// live in lib/ so app/actions/early-clock-in.ts can reach them: every export of
// a "use server" module is a client-callable endpoint, and performClockIn takes
// a context that can skip the geofence.
import {
  applyAutoShiftForClockIn,
  asResult,
  findShiftForClockIn,
  getEmployeeForUser,
  performClockIn,
  requireAllowed,
  revalidateClockPaths,
  stampAutoShiftWindow,
  type ClockInContext,
} from "@/lib/clock-core";
import { hasRole, resolveActiveStoreId, type ActionResult } from "@/lib/types";

type ClockInInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
  fix_age_ms: number | null;
};

/**
 * The exported signature is deliberately unchanged: it wraps the input in the
 * `geo` context, which is the only kind a client may ever ask for. The
 * pre-authorised kind is reachable only from the server, after an OTP has been
 * verified (app/actions/early-clock-in.ts).
 */
export async function clockIn(input: ClockInInput): Promise<ActionResult> {
  const ctx: ClockInContext = { kind: "geo", ...input };
  return asResult(() => performClockIn(ctx));
}

type ClockOutInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
  fix_age_ms: number | null;
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

  // Clock out at the store the shift is recorded against — or, failing that, at
  // whichever store they're actually standing in. Staff cover across stores, so
  // pinning the check to the recorded store alone can strand someone on site
  // (see verifyGeofenceForClockOut).
  const { atStore } = await verifyGeofenceForClockOut(
    supabase,
    session.store_id ?? existing.store_id,
    {
      lat: input.latitude,
      lng: input.longitude,
      accuracy: input.accuracy,
      ageMs: input.fix_age_ms,
    },
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

  // Delivery counts belong to THE SHIFT BEING CLOSED, not the day (migration
  // 033). A driver clocking out of their evening shift reports what they did on
  // that shift; the day's total is the SUM of its shifts, written by
  // recomputeDayHeader below. Before 033 this overwrote a single day-level
  // column, so a second clock-out silently erased the morning's drops.
  const closedOk = await closeSession(supabase, session.id, {
    clockOutAt: now,
    lat: input.latitude,
    lng: input.longitude,
    deliveries: isDriver
      ? {
          short: Math.max(0, Number(input.short_deliveries_count) || 0),
          long: Math.max(0, Number(input.long_deliveries_count) || 0),
          extraShort: Math.max(0, Number(input.extra_short_deliveries) || 0),
          extraLong: Math.max(0, Number(input.extra_long_deliveries) || 0),
          extraShortReason: input.extra_short_reason?.trim() || null,
          extraLongReason: input.extra_long_reason?.trim() || null,
        }
      : null,
  });
  if (!closedOk) throw new Error("You've already clocked out of that shift.");

  // Header last: first-in / last-out / summed hours AND summed deliveries all
  // come from the sessions.
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
      // Only present when they signed off somewhere other than the store the
      // shift is recorded against — worth seeing when a day's store is queried.
      clocked_out_at_store: atStore?.name ?? null,
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

  // The live count belongs to the shift the driver is ON — not the day — so a
  // count logged during the evening shift can never overwrite the morning's
  // (migration 033). Resolved from the open session, which also means a shift
  // that began yesterday and is still running updates the right day.
  const session = await findOpenSession(supabase, employee.id);
  if (!session) throw new Error("You're not clocked in — clock in before logging deliveries.");

  const clockEventId = session.clock_event_id;
  await setSessionDeliveries(supabase, session.id, {
    short: Math.max(0, Number(input.short_count) || 0),
    long: Math.max(0, Number(input.long_count) || 0),
    extraShort,
    extraLong,
    extraShortReason: input.extra_short_reason?.trim() || null,
    extraLongReason: input.extra_long_reason?.trim() || null,
  });
  // Roll the shift's counts up into the day header every reader still uses.
  await recomputeDayHeader(supabase, clockEventId);

  await writeAudit({
    action: "update_deliveries",
    entity: "clock_event",
    entity_id: clockEventId,
    changes: {
      session_id: session.id,
      session_seq: session.seq,
      short: input.short_count,
      long: input.long_count,
      extraShort,
      extraLong,
    },
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
    // The manager typed a DAY total; the day may hold several shifts. Settle
    // the difference on the last shift and leave the earlier ones as the driver
    // recorded them, then let recomputeDayHeader write the header from the
    // sessions so it stays their single writer (migration 033). A pre-029 day
    // with no sessions falls back to writing the header directly, as before.
    const applied = await applyDayDeliveryTotal(supabase, existing.id, {
      short: shortCount,
      long: longCount,
      extraShort,
      extraLong,
      extraShortReason: extraShort > 0 ? input.extra_short_reason!.trim() : null,
      extraLongReason: extraLong > 0 ? input.extra_long_reason!.trim() : null,
    });
    if (applied) {
      await recomputeDayHeader(supabase, existing.id);
    } else {
      const { error } = await supabase.from("clock_events").update(fields).eq("id", existing.id);
      if (error) throw new Error(error.message);
    }
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
  /**
   * Drops for the shift being recorded. Omitted leaves the session with no
   * counts, which reads as "nothing recorded" on Daily Approval rather than an
   * explicit zero — the distinction the "No deliveries" warning relies on.
   */
  deliveries?: DeliveryInput | null;
  /**
   * The store the work is attributed to. NOT a lookup — staff cross-cover, so
   * where someone worked is a fact only the person recording it knows, and it
   * decides which store's Tuesday payout pays the day AND whether the hours are
   * NI or fully cash (see cashHoursFromStoreTotal). Omitted keeps the previous
   * default: the manager's active store, or the employee's home store for an
   * admin. Admin-only — a manager is held to their own store below.
   */
  store_id?: string | null;
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
    .select("id, name, store_id, employment_status, position")
    .eq("id", input.employee_id)
    .maybeSingle();
  if (!employee) throw new Error("Employee not found.");
  if (employee.employment_status === "left" || employee.employment_status === "inactive") {
    throw new Error(`${employee.name} is not an active employee.`);
  }

  // Where the work happened. Defaults to the store the manager is running —
  // that's where they saw the person — or the employee's home store for an
  // admin. But the default is only a default: a Stevenage employee who covered
  // a day at Hitchin is paid by HITCHIN's sheet, and their hours there are fully
  // cash rather than counting against their home NI allowance. An admin says so
  // explicitly; assertClockEntryStore still holds a manager to their own store,
  // so nobody can write hours onto a sheet they don't run.
  const defaultStoreId =
    user.allowed!.role === "manager"
      ? resolveActiveStoreId(user.allowed) ?? employee.store_id
      : employee.store_id;
  const storeId = input.store_id ?? defaultStoreId;
  if (!storeId) throw new Error("That employee has no store assigned.");
  assertClockEntryStore(user, storeId);

  // A client-supplied id is checked against the real roster before any row is
  // written against it.
  if (input.store_id) {
    const { data: store } = await supabase
      .from("stores")
      .select("id")
      .eq("id", input.store_id)
      .maybeSingle();
    if (!store) throw new Error("That store no longer exists.");
  }

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

  // An approved day no longer blocks this. Approval sits on the SHIFT now
  // (migration 035), so a forgotten second shift is recorded as a NEW shift
  // that arrives unapproved — it changes nothing already signed off, and the
  // day simply shows as having outstanding work again. The overlap check below
  // is what stops the same hours being recorded, and so paid, twice.

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
  // Only a Driver is paid per drop, so counts submitted against anyone else are
  // dropped rather than stored where nothing would ever read them.
  const deliveries = hasRole(employee.position, "Driver")
    ? normaliseDeliveryInput(input.deliveries)
    : null;

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
      // Against THIS shift, never the day — recomputeDayHeader below sums them,
      // so filling in a forgotten morning can't wipe the evening's drops.
      deliveries,
    });
  } else if (deliveries) {
    await setSessionDeliveries(supabase, session.id, deliveries);
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
      store_id: storeId,
      // Flagged so a day booked away from the employee's home store — which
      // moves it to another store's payout and pays it fully in cash — is
      // findable in the audit log rather than inferred from the store id.
      away_from_home_store: storeId !== employee.store_id,
      ...(deliveries
        ? {
            deliveries: {
              short: deliveries.short,
              long: deliveries.long,
              extra_short: deliveries.extraShort,
              extra_long: deliveries.extraLong,
            },
          }
        : {}),
      by: user.email,
    },
  });

  // Re-scan so the unexpected_absence / late_clock_in alerts raised while the
  // clock-in was missing reflect the corrected start time.
  await scanForAlertsBackground();

  revalidateClockPaths();
}
