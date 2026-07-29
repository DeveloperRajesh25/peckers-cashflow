"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { resolveActiveStoreId, type CoverDriverScheduleDay } from "@/lib/types";

// =============================================================
// A cover driver's recurring weekly AVAILABILITY.
//
// Mirrors app/actions/schedule.ts, minus applyScheduleToWeek: saving a pattern
// here never creates bookings. It records which days a driver can usually
// cover, which pre-fills their cells on the Rota; the actual booking is a
// cover_driver_shifts row written by app/actions/cover-driver-rota.ts.
// =============================================================

async function requireStaff() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Not authorised");
  }
  return user;
}

/** Managers may only touch drivers at the store they're currently managing. */
async function assertDriverAccess(
  user: Awaited<ReturnType<typeof requireStaff>>,
  coverDriverId: string,
) {
  if (user.allowed!.role !== "manager") return;
  const supabase = createServerSupabase();
  const { data: driver } = await supabase
    .from("cover_drivers")
    .select("store_id")
    .eq("id", coverDriverId)
    .maybeSingle();
  if (!driver) throw new Error("Cover driver not found");
  const activeStore = resolveActiveStoreId(user.allowed);
  if (!activeStore) throw new Error("No store assigned to your account.");
  if (driver.store_id !== activeStore) {
    throw new Error("You can only manage cover drivers for the store you're managing.");
  }
}

export type CoverDriverScheduleInput = {
  weekday: number; // 0=Mon .. 6=Sun
  is_working: boolean;
  start_time?: string | null;
  end_time?: string | null;
};

/**
 * Read a driver's weekly pattern, always returning 7 entries (Mon..Sun).
 * Missing weekdays come back as non-working virtual days so the editor can
 * render a complete week without the caller special-casing gaps.
 */
export async function getCoverDriverSchedule(
  coverDriverId: string,
): Promise<CoverDriverScheduleDay[]> {
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("cover_driver_schedules")
    .select("*")
    .eq("cover_driver_id", coverDriverId)
    .order("weekday");

  const byDay = new Map((data ?? []).map((d) => [d.weekday, d]));
  return Array.from({ length: 7 }, (_, wd) => {
    const row = byDay.get(wd);
    if (row) return row as CoverDriverScheduleDay;
    return {
      id: `virtual-${coverDriverId}-${wd}`,
      cover_driver_id: coverDriverId,
      weekday: wd,
      is_working: false,
      start_time: null,
      end_time: null,
      created_at: "",
      updated_at: "",
    } satisfies CoverDriverScheduleDay;
  });
}

/** Upsert every weekday of a driver's recurring availability (staff only). */
export async function saveCoverDriverSchedule(
  coverDriverId: string,
  days: CoverDriverScheduleInput[],
): Promise<{ ok: true }> {
  const user = await requireStaff();
  if (!coverDriverId) throw new Error("Missing cover driver");
  await assertDriverAccess(user, coverDriverId);

  const supabase = createServerSupabase();
  const { data: existing } = await supabase
    .from("cover_driver_schedules")
    .select("id, weekday")
    .eq("cover_driver_id", coverDriverId);
  const idByDay = new Map(
    (existing ?? []).map((r: { id: string; weekday: number }) => [r.weekday, r.id]),
  );

  for (const d of days) {
    if (d.weekday < 0 || d.weekday > 6) continue;
    const working = !!d.is_working;
    const start = working ? d.start_time?.slice(0, 5) || null : null;
    const end = working ? d.end_time?.slice(0, 5) || null : null;
    if (working && (!start || !end)) {
      throw new Error(
        "Enter both start and end times for working days, or mark the day as off.",
      );
    }

    const base = {
      is_working: working,
      start_time: start,
      end_time: end,
      updated_by: user.id,
    };
    const existingId = idByDay.get(d.weekday);
    if (existingId) {
      const { error } = await supabase
        .from("cover_driver_schedules")
        .update(base)
        .eq("id", existingId);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("cover_driver_schedules").insert({
        cover_driver_id: coverDriverId,
        weekday: d.weekday,
        ...base,
        created_by: user.id,
      });
      if (error) throw new Error(error.message);
    }
  }

  await writeAudit({
    action: "save_cover_driver_schedule",
    entity: "cover_driver_schedule",
    entity_id: coverDriverId,
    changes: { days },
  });

  // Not /rota — a cover driver's pattern never feeds the rota.
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  return { ok: true };
}
