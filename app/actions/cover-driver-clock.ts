"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { todayISO } from "@/lib/utils";
import { detectStoreForLocation, verifyGeofenceAtStore } from "@/lib/geofence-verify";
import { findCoverDriverForUser } from "@/lib/cover-driver-lookup";
import type { ActionResult } from "@/lib/types";

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
}

type ClockInInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
};

export async function coverDriverClockIn(input: ClockInInput): Promise<ActionResult> {
  return asResult(() => performClockIn(input));
}

async function performClockIn(input: ClockInInput) {
  const { driver, supabase } = await requireCoverDriver();
  if (!driver.is_active) throw new Error("Your account is not active.");

  // Cover drivers can be called to either store, so the store they're standing
  // in is the store the day's work and pay are attributed to.
  const detected = await detectStoreForLocation(
    supabase,
    input.latitude,
    input.longitude,
    input.accuracy,
  );

  const today = todayISO();
  const { data: existing } = await supabase
    .from("cover_driver_clock_events")
    .select("*")
    .eq("cover_driver_id", driver.id)
    .eq("event_date", today)
    .maybeSingle();

  if (existing?.clock_in_at) throw new Error("You've already clocked in today.");

  const payload = {
    cover_driver_id: driver.id,
    store_id: detected.id,
    event_date: today,
    clock_in_at: new Date().toISOString(),
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
  // recorded, so that's where they must be to sign off.
  await verifyGeofenceAtStore(
    supabase,
    existing.store_id,
    input.latitude,
    input.longitude,
    input.accuracy,
  );

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

  const payload = {
    clock_out_at: new Date().toISOString(),
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
