"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import {
  formatDDMMYYYY,
  londonHHMM,
  shiftHours,
  timeToMinutes,
  todayISO,
} from "@/lib/utils";
import { detectStoreForLocation, verifyGeofenceForClockOut } from "@/lib/geofence-verify";
import { findCoverDriverForUser } from "@/lib/cover-driver-lookup";
import {
  londonWallClockToUtc,
  MAX_AUTO_SHIFT_HOURS,
  resolveManualClockOut,
} from "@/lib/auto-clock-out";
import { resolveActiveStoreId, type ActionResult } from "@/lib/types";
import {
  normaliseDeliveryInput,
  type DeliveryInput,
} from "@/lib/clock-sessions";

// =============================================================
// Cover driver clock in/out.
//
// Mirrors app/actions/clock.ts but deliberately does LESS:
//   * no rota_shifts writes — a cover driver's bookings live in
//     cover_driver_shifts, never in the employee rota,
//   * no alert scanning — the alerts module knows nothing about them.
//
// The geofence check is IMPORTED from lib/geofence-verify.ts rather than
// reimplemented, so the in-range verdict, the accuracy tolerance and the
// distance-aware error text can never drift from the employee flow.
// =============================================================

/**
 * Boundary for user-triggered clock actions: converts a thrown error into a
 * returned { ok:false, error } so the message survives production. Next.js
 * masks messages thrown from server actions in prod builds — without this,
 * "You're 300m from the store" reaches the driver as a generic 500.
 */
async function asResult(run: () => Promise<void>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    console.error("[cover-driver-clock] action failed:", err);
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Something went wrong. Please try again.";
    return { ok: false, error: message };
  }
}

async function requireCoverDriver() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "cover_driver") {
    throw new Error("Only cover drivers can use this clock.");
  }
  const supabase = createServerSupabase();
  const driver = await findCoverDriverForUser(supabase, user.id, user.email);
  if (!driver) throw new Error("Your login isn't linked to a cover driver profile.");
  return { user, driver, supabase };
}

function revalidateClock() {
  revalidatePath("/cover-driver/attendance");
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/live");
  revalidatePath("/manager/live");
}

/** Marker for shifts the system created from a clock-in, mirroring the employee rota. */
const AUTO_SHIFT_NOTE = "Auto-created from clock-in";

/**
 * Reflect a cover driver's clock-in on the Rota, exactly as the employee flow
 * does (see applyAutoShiftForClockIn in app/actions/clock.ts).
 *
 * This originally did nothing, on the reasoning that a booking is a manager's
 * decision and a clock-in shouldn't invent one. That was wrong in practice: the
 * Rota's Total hrs and Wages columns sum `scheduled_hours` from booked cells, so
 * a driver who clocked a full day but was never booked showed the times in the
 * cell and 0.0h / £0.00 on the row. Employees never hit that because their
 * clock-in DOES create a shift. Parity is what the columns need.
 *
 * Best-effort and service-role: cover drivers can't write cover_driver_shifts
 * under RLS (they aren't staff), so if provisioning isn't configured — or
 * anything fails — swallow it. It must never block the clock-in itself.
 */
async function applyAutoShiftForCoverClockIn(input: {
  supabase: ReturnType<typeof createServerSupabase>;
  coverDriverId: string;
  storeId: string;
  eventDate: string;
  /** HH:MM, UK wall clock. */
  startTime: string;
}) {
  const { supabase, coverDriverId, storeId, eventDate, startTime } = input;
  try {
    if (!isProvisioningConfigured()) return;

    const { data: existing } = await supabase
      .from("cover_driver_shifts")
      .select("id, is_day_off, start_time")
      .eq("cover_driver_id", coverDriverId)
      .eq("shift_date", eventDate)
      .maybeSingle();

    // A real booking a manager made is left alone — only an absent row or a
    // Day Off / empty cell is converted.
    if (existing && !existing.is_day_off && existing.start_time) return;

    const admin = createAdminClient();
    const payload = {
      cover_driver_id: coverDriverId,
      store_id: storeId,
      shift_date: eventDate,
      start_time: startTime,
      end_time: null,
      is_day_off: false,
      scheduled_hours: 0,
      notes: AUTO_SHIFT_NOTE,
    };
    if (existing) {
      await admin.from("cover_driver_shifts").update(payload).eq("id", existing.id);
    } else {
      await admin.from("cover_driver_shifts").insert(payload);
    }
  } catch (err) {
    console.error(
      "[cover-driver-clock] auto-shift creation failed (clock-in continues):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Stamp the end time + hours on a shift the system created, so the Rota row
 * totals the real worked window. Only touches auto-created cells — a manager's
 * own booking keeps the hours they planned.
 */
async function stampAutoCoverShiftEnd(input: {
  supabase: ReturnType<typeof createServerSupabase>;
  coverDriverId: string;
  eventDate: string;
  /** HH:MM, UK wall clock. */
  endTime: string;
}) {
  const { supabase, coverDriverId, eventDate, endTime } = input;
  try {
    if (!isProvisioningConfigured()) return;

    const { data: shift } = await supabase
      .from("cover_driver_shifts")
      .select("id, start_time, notes")
      .eq("cover_driver_id", coverDriverId)
      .eq("shift_date", eventDate)
      .maybeSingle();
    if (!shift || shift.notes !== AUTO_SHIFT_NOTE || !shift.start_time) return;

    const admin = createAdminClient();
    await admin
      .from("cover_driver_shifts")
      .update({
        end_time: endTime,
        scheduled_hours: shiftHours(shift.start_time.slice(0, 5), endTime),
      })
      .eq("id", shift.id);
  } catch (err) {
    console.error(
      "[cover-driver-clock] auto-shift end-stamp failed (clock-out continues):",
      err instanceof Error ? err.message : err,
    );
  }
}

type ClockInInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
  fix_age_ms: number | null;
};

export async function coverDriverClockIn(input: ClockInInput): Promise<ActionResult> {
  return asResult(() => performClockIn(input));
}

async function performClockIn(input: ClockInInput) {
  const { driver, supabase } = await requireCoverDriver();
  if (!driver.is_active) throw new Error("Your account is not active.");

  // Cover drivers can be called to either store, so the store they're standing
  // in is the store the day's work and pay are attributed to.
  const detected = await detectStoreForLocation(supabase, {
    lat: input.latitude,
    lng: input.longitude,
    accuracy: input.accuracy,
    ageMs: input.fix_age_ms,
  });

  const today = todayISO();
  const { data: existing } = await supabase
    .from("cover_driver_clock_events")
    .select("*")
    .eq("cover_driver_id", driver.id)
    .eq("event_date", today)
    .maybeSingle();

  if (existing?.clock_in_at) throw new Error("You've already clocked in today.");

  const nowDate = new Date();
  await applyAutoShiftForCoverClockIn({
    supabase,
    coverDriverId: driver.id,
    storeId: detected.id,
    eventDate: today,
    startTime: londonHHMM(nowDate),
  });

  const payload = {
    cover_driver_id: driver.id,
    store_id: detected.id,
    event_date: today,
    clock_in_at: nowDate.toISOString(),
    clock_in_lat: input.latitude,
    clock_in_lng: input.longitude,
  };

  if (existing) {
    const { error } = await supabase
      .from("cover_driver_clock_events")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("cover_driver_clock_events").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: "cover_driver_clock_in",
    entity: "cover_driver_clock_event",
    entity_id: driver.id,
    changes: { date: today, store: detected.name, location: [input.latitude, input.longitude] },
  });

  revalidateClock();
}

type ClockOutInput = ClockInInput & {
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

export async function coverDriverClockOut(input: ClockOutInput): Promise<ActionResult> {
  return asResult(() => performClockOut(input));
}

async function performClockOut(input: ClockOutInput) {
  const { driver, supabase } = await requireCoverDriver();

  const today = todayISO();
  const { data: existing } = await supabase
    .from("cover_driver_clock_events")
    .select("*")
    .eq("cover_driver_id", driver.id)
    .eq("event_date", today)
    .maybeSingle();

  if (!existing?.clock_in_at) throw new Error("You haven't clocked in yet today.");
  if (existing.clock_out_at) throw new Error("You've already clocked out today.");

  // Clock out at the store they clocked IN at — that's where the day's work is
  // recorded. Standing at another store still signs the day off rather than
  // stranding them clocked in (see verifyGeofenceForClockOut).
  await verifyGeofenceForClockOut(supabase, existing.store_id, {
    lat: input.latitude,
    lng: input.longitude,
    accuracy: input.accuracy,
    ageMs: input.fix_age_ms,
  });

  const shortMissing =
    input.short_deliveries_count == null || Number.isNaN(input.short_deliveries_count);
  const longMissing =
    input.long_deliveries_count == null || Number.isNaN(input.long_deliveries_count);
  if (shortMissing && longMissing) {
    throw new Error(
      "Enter your short and long delivery counts before clocking out.",
    );
  }

  const extraShort = Math.max(0, Number(input.extra_short_deliveries) || 0);
  const extraLong = Math.max(0, Number(input.extra_long_deliveries) || 0);
  if (extraShort > 0 && !input.extra_short_reason?.trim()) {
    throw new Error("Please give a reason for the extra short deliveries.");
  }
  if (extraLong > 0 && !input.extra_long_reason?.trim()) {
    throw new Error("Please give a reason for the extra long deliveries.");
  }

  const outDate = new Date();
  await stampAutoCoverShiftEnd({
    supabase,
    coverDriverId: driver.id,
    eventDate: today,
    endTime: londonHHMM(outDate),
  });

  const payload = {
    clock_out_at: outDate.toISOString(),
    clock_out_lat: input.latitude,
    clock_out_lng: input.longitude,
    short_deliveries_count: Math.max(0, Number(input.short_deliveries_count) || 0),
    long_deliveries_count: Math.max(0, Number(input.long_deliveries_count) || 0),
    extra_short_deliveries: extraShort,
    extra_long_deliveries: extraLong,
    extra_short_reason: extraShort > 0 ? input.extra_short_reason!.trim() : null,
    extra_long_reason: extraLong > 0 ? input.extra_long_reason!.trim() : null,
  };

  const { error } = await supabase
    .from("cover_driver_clock_events")
    .update(payload)
    .eq("id", existing.id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "cover_driver_clock_out",
    entity: "cover_driver_clock_event",
    entity_id: existing.id,
    changes: { date: today, ...payload },
  });

  revalidateClock();
}

type DeliveryCountInput = {
  short_count: number;
  long_count: number;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

/** Update the running delivery count mid-shift, before clocking out. */
export async function updateCoverDriverDeliveries(
  input: DeliveryCountInput,
): Promise<ActionResult> {
  return asResult(async () => {
    const { driver, supabase } = await requireCoverDriver();

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
      .from("cover_driver_clock_events")
      .select("id")
      .eq("cover_driver_id", driver.id)
      .eq("event_date", today)
      .maybeSingle();
    if (!existing) throw new Error("No clock event for today.");

    const { error } = await supabase
      .from("cover_driver_clock_events")
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
      action: "cover_driver_update_deliveries",
      entity: "cover_driver_clock_event",
      entity_id: existing.id,
      changes: { short: input.short_count, long: input.long_count, extraShort, extraLong },
    });

    revalidateClock();
  });
}

// =============================================================
// Manager-entered cover driver clock times.
//
// Mirrors upsertManualClockEntry in app/actions/clock.ts, with two deliberate
// differences — both matching what cover-driver SELF clock-in already does:
//   * no cover_driver_shifts write. A booking is something a manager makes on
//     the Rota; a clock-in never creates one, so a manual clock-in mustn't
//     either or it would do MORE than a real one.
//   * no alert scan. The alerts module doesn't cover cover drivers.
//
// Like the employee version this bypasses the geofence, so every row is flagged
// manual_entry, carries a reason, and leaves the coordinates null.
// =============================================================

export type ManualCoverDriverClockEntryInput = {
  cover_driver_id: string;
  /** YYYY-MM-DD. */
  event_date: string;
  /** "HH:MM", UK wall clock. */
  clock_in_time: string;
  /** "HH:MM". Omit while the driver is still on shift. */
  clock_out_time?: string | null;
  reason: string;
  /**
   * Drops for the day. Cover drivers are single-shift, so these land straight
   * on the clock event. Omitted leaves the counts untouched — on an existing
   * row that means "times corrected, drops left alone".
   */
  deliveries?: DeliveryInput | null;
};

export async function upsertManualCoverDriverClockEntry(
  input: ManualCoverDriverClockEntryInput,
): Promise<ActionResult> {
  return asResult(() => performManualCoverEntry(input));
}

async function performManualCoverEntry(input: ManualCoverDriverClockEntryInput) {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  const role = user.allowed.role;
  if (role !== "admin" && role !== "manager") {
    throw new Error("Only managers and admins can record clock times.");
  }

  if (!input.cover_driver_id) throw new Error("Select a cover driver");
  if (!input.event_date) throw new Error("Date is required");
  if (!input.clock_in_time) throw new Error("Clock-in time is required");
  if (!input.reason?.trim()) {
    throw new Error("Give a reason — this records hours without a location check.");
  }

  const supabase = createServerSupabase();
  const { data: driver } = await supabase
    .from("cover_drivers")
    .select("id, name, store_id, is_active")
    .eq("id", input.cover_driver_id)
    .maybeSingle();
  if (!driver) throw new Error("Cover driver not found.");
  if (!driver.is_active) throw new Error(`${driver.name} is not active.`);

  if (role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (driver.store_id !== activeStore) {
      throw new Error("You can only record clock times for the store you're managing.");
    }
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
    .from("cover_driver_clock_events")
    .select("*")
    .eq("cover_driver_id", driver.id)
    .eq("event_date", input.event_date)
    .maybeSingle();

  // Approved cash pay must not move under an approval already signed off.
  const { data: approved } = await supabase
    .from("cover_driver_hours")
    .select("id, approved")
    .eq("cover_driver_id", driver.id)
    .eq("work_date", input.event_date)
    .maybeSingle();
  if (approved?.approved) {
    throw new Error(
      "That day is already approved. Remove the approval first, then change the times.",
    );
  }

  // Same Rota reflection as a real clock-in, so a manually recorded day totals
  // its hours on the Rota row like any other.
  await applyAutoShiftForCoverClockIn({
    supabase,
    coverDriverId: driver.id,
    storeId: driver.store_id,
    eventDate: input.event_date,
    startTime: input.clock_in_time.slice(0, 5),
  });
  if (input.clock_out_time) {
    await stampAutoCoverShiftEnd({
      supabase,
      coverDriverId: driver.id,
      eventDate: input.event_date,
      endTime: input.clock_out_time.slice(0, 5),
    });
  }

  const payload: Record<string, unknown> = {
    cover_driver_id: driver.id,
    store_id: driver.store_id,
    event_date: input.event_date,
    clock_in_at: clockInAt.toISOString(),
    // Deliberately null: a row with no coordinates was never location-verified.
    clock_in_lat: null,
    clock_in_lng: null,
    manual_entry: true,
    manual_entry_by: user.id,
    manual_entry_at: now.toISOString(),
    manual_entry_reason: input.reason.trim(),
    manual_entry_fields: clockOutAt ? "both" : "in",
  };
  if (clockOutAt) {
    payload.clock_out_at = clockOutAt.toISOString();
    payload.clock_out_lat = null;
    payload.clock_out_lng = null;
  }

  // Drops go straight on the day: cover drivers have no sessions table, one
  // engagement per date. Omitted counts leave whatever is on record alone, so
  // correcting a bad clock-out time can't silently zero a day's deliveries.
  const deliveries = normaliseDeliveryInput(input.deliveries);
  if (deliveries) {
    payload.short_deliveries_count = deliveries.short;
    payload.long_deliveries_count = deliveries.long;
    payload.extra_short_deliveries = deliveries.extraShort;
    payload.extra_long_deliveries = deliveries.extraLong;
    payload.extra_short_reason = deliveries.extraShort > 0 ? deliveries.extraShortReason : null;
    payload.extra_long_reason = deliveries.extraLong > 0 ? deliveries.extraLongReason : null;
  }

  if (existing) {
    const { error } = await supabase
      .from("cover_driver_clock_events")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("cover_driver_clock_events").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: existing ? "manual_cover_driver_clock_update" : "manual_cover_driver_clock_entry",
    entity: "cover_driver_clock_event",
    entity_id: existing?.id ?? driver.id,
    changes: {
      cover_driver_id: driver.id,
      driver_name: driver.name,
      event_date: input.event_date,
      clock_in_at: payload.clock_in_at,
      clock_out_at: payload.clock_out_at ?? null,
      reason: input.reason.trim(),
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

  revalidateClock();
}
