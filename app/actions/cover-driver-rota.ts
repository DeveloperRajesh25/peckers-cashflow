"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { shiftHours, todayISO } from "@/lib/utils";
import { resolveActiveStoreId } from "@/lib/types";

// =============================================================
// Per-date cover driver rota cells.
//
// Mirrors app/actions/manager-rota.ts, with one deliberate difference: manager
// shifts are admin-only, but managers MAY edit cover driver shifts for their
// own store — they already create cover drivers and approve their hours, so
// locking them out of the rota cell would be inconsistent. Matches the
// cover_driver_shifts_modify RLS policy.
// =============================================================

async function requireStaff() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Only managers and admins can edit the cover driver rota.");
  }
  return user;
}

/** Managers may only touch drivers at the store they're currently managing. */
async function assertDriverAccess(
  user: Awaited<ReturnType<typeof requireStaff>>,
  coverDriverId: string,
): Promise<string> {
  const supabase = createServerSupabase();
  const { data: driver } = await supabase
    .from("cover_drivers")
    .select("store_id")
    .eq("id", coverDriverId)
    .maybeSingle();
  if (!driver) throw new Error("Cover driver not found");

  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (driver.store_id !== activeStore) {
      throw new Error("You can only edit cover drivers for the store you're managing.");
    }
  }
  return driver.store_id as string;
}

export type CoverDriverShiftInput = {
  cover_driver_id: string;
  store_id: string;
  shift_date: string;
  start_time?: string | null;
  end_time?: string | null;
  is_day_off?: boolean;
  notes?: string | null;
};

/** Upsert one cover driver rota cell. Computes scheduled hours server-side. */
export async function upsertCoverDriverShift(input: CoverDriverShiftInput) {
  const user = await requireStaff();
  if (!input.cover_driver_id) throw new Error("Missing cover driver");
  if (!input.shift_date) throw new Error("Missing date");

  const driverStoreId = await assertDriverAccess(user, input.cover_driver_id);
  const storeId = input.store_id || driverStoreId;

  // Past days are read-only — same rule as the employee and manager rota.
  if (input.shift_date < todayISO()) {
    throw new Error(
      "Past days are locked. You can view previous shifts but only edit today or upcoming days.",
    );
  }

  const isDayOff = !!input.is_day_off;
  const start = isDayOff ? null : input.start_time?.slice(0, 5) || null;
  const end = isDayOff ? null : input.end_time?.slice(0, 5) || null;
  if (!isDayOff && (!start || !end)) {
    throw new Error("Enter both a start and end time, or mark the day as a Day Off.");
  }
  const hours = isDayOff ? 0 : shiftHours(start, end);

  const supabase = createServerSupabase();
  const { data: existing } = await supabase
    .from("cover_driver_shifts")
    .select("*")
    .eq("cover_driver_id", input.cover_driver_id)
    .eq("shift_date", input.shift_date)
    .maybeSingle();

  const payload = {
    cover_driver_id: input.cover_driver_id,
    store_id: storeId,
    shift_date: input.shift_date,
    start_time: start,
    end_time: end,
    is_day_off: isDayOff,
    scheduled_hours: hours,
    notes: input.notes?.trim() || null,
    updated_by: user.id,
  };

  if (existing) {
    const { error } = await supabase
      .from("cover_driver_shifts")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "update",
      entity: "cover_driver_shift",
      entity_id: existing.id,
      changes: { before: existing, after: payload },
    });
  } else {
    const { error } = await supabase
      .from("cover_driver_shifts")
      .insert({ ...payload, created_by: user.id });
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "create",
      entity: "cover_driver_shift",
      entity_id: `${input.cover_driver_id}:${input.shift_date}`,
      changes: payload,
    });
  }

  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  return { ok: true };
}

/** Clear one cover driver rota cell, falling the day back to their weekly pattern. */
export async function deleteCoverDriverShift(id: string) {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: existing } = await supabase
    .from("cover_driver_shifts")
    .select("id, shift_date, cover_driver_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) throw new Error("Shift not found");
  await assertDriverAccess(user, existing.cover_driver_id);

  if (existing.shift_date < todayISO()) {
    throw new Error(
      "Past days are locked. You can view previous shifts but only edit today or upcoming days.",
    );
  }

  const { error } = await supabase.from("cover_driver_shifts").delete().eq("id", id);
  if (error) throw new Error(error.message);

  await writeAudit({ action: "delete", entity: "cover_driver_shift", entity_id: id });
  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  return { ok: true };
}
