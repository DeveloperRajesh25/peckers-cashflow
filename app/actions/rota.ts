"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { writeAudit } from "./audit";
import { shiftHours, shiftRangesOverlap, todayISO } from "@/lib/utils";
import { presetTimes, DEFAULT_SETTINGS } from "@/lib/settings";
import { hasRole, resolveActiveStoreId, type ShiftPreset } from "@/lib/types";

async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

export type RotaShiftInput = {
  id?: string;
  employee_id: string;
  store_id: string;
  shift_date: string;
  start_time?: string | null;
  end_time?: string | null;
  is_day_off?: boolean;
  /** Rota preset. When set, start/end are recomputed server-side from the
   *  configured shift_times + the employee's position (Settings is the source
   *  of truth). Null = custom times or day off. */
  shift_type?: ShiftPreset | null;
  manager_notes?: string | null;
  same_day_edit_reason?: string | null;
};

/**
 * Upsert a shift. A day can now hold several — `input.id` is the ONLY signal
 * for which case this is:
 *   - id given    -> update that exact shift (fetched by id, never by day).
 *   - id omitted  -> always INSERT a new shift for this employee+date, even
 *                    if the day already has one or more. This is what lets a
 *                    manager add a second (or third) shift to an already
 *                    booked day — the old code looked up "the" shift for the
 *                    day and would silently overwrite it instead.
 */
export async function upsertShift(input: RotaShiftInput) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  if (!input.employee_id) throw new Error("Missing employee");
  if (!input.store_id) throw new Error("Missing store");
  if (!input.shift_date) throw new Error("Missing date");

  // A manager may schedule ANY employee (including staff visiting from the other
  // store) but only ON the rota of the store they're currently managing — never
  // another store's rota.
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore || input.store_id !== activeStore) {
      throw new Error("Managers can only edit shifts at the store they're managing.");
    }
  }

  // Past days are read-only — only today and future shifts can be edited.
  if (input.shift_date < todayISO()) {
    throw new Error(
      "Past days are locked. You can view previous shifts but only edit today or upcoming days.",
    );
  }

  const isDayOff = !!input.is_day_off;
  const shiftType: ShiftPreset | null =
    !isDayOff && (input.shift_type === "open_close" || input.shift_type === "evening_close")
      ? input.shift_type
      : null;

  // Resolve the shift's start/end. A preset is authoritative: recompute the
  // times from the configured shift_times + the employee's position so Settings
  // is the single source of truth and the client can't submit mismatched times.
  // Otherwise use the entered (custom) times.
  let start: string | null;
  let end: string | null;
  if (isDayOff) {
    start = null;
    end = null;
  } else if (shiftType) {
    // Preset times come from the store the shift is on — each store trades on
    // its own hours — plus the employee's position (drivers open later).
    const [storeRes, empRes] = await Promise.all([
      supabase.from("stores").select("shift_times").eq("id", input.store_id).maybeSingle(),
      supabase.from("employees").select("position").eq("id", input.employee_id).maybeSingle(),
    ]);
    const times = presetTimes(
      shiftType,
      hasRole(empRes.data?.position ?? null, "Driver"),
      storeRes.data?.shift_times ?? DEFAULT_SETTINGS.shift_times,
    );
    start = times.start;
    end = times.end;
  } else {
    start = input.start_time?.slice(0, 5) || null;
    end = input.end_time?.slice(0, 5) || null;
  }

  if (!isDayOff && (!start || !end)) {
    throw new Error(
      "Enter both a start and end time, or mark the day as a Day Off.",
    );
  }
  const hours = isDayOff ? 0 : shiftHours(start, end);

  // A working shift can't overlap another one already booked for this
  // employee on this day — a day can hold several now, but back-to-back only,
  // never coinciding (e.g. 16:00–22:00 and 17:00–21:00 booked together makes
  // no sense and would double-count hours in the Wages/Rota totals, which sum
  // every shift on the day).
  if (!isDayOff) {
    const { data: siblings } = await supabase
      .from("rota_shifts")
      .select("id, start_time, end_time, is_day_off")
      .eq("employee_id", input.employee_id)
      .eq("shift_date", input.shift_date);
    const overlap = (siblings ?? []).find(
      (s) =>
        s.id !== input.id &&
        !s.is_day_off &&
        shiftRangesOverlap(start, end, s.start_time?.slice(0, 5) ?? null, s.end_time?.slice(0, 5) ?? null),
    );
    if (overlap) {
      throw new Error(
        `That overlaps a shift already booked ${overlap.start_time?.slice(0, 5)}–${overlap.end_time?.slice(0, 5)} this day. Times must not coincide.`,
      );
    }
  }

  // Same-day edits require a reason.
  const isSameDay = input.shift_date === todayISO();

  // Fetch the exact row being edited, by id — NEVER by day, since the day can
  // now hold several. No id means this is a brand-new shift for the day
  // (including a second/third one), so there is nothing to compare against
  // and no rewrite to justify.
  const { data: existing } = input.id
    ? await supabase.from("rota_shifts").select("*").eq("id", input.id).maybeSingle()
    : { data: null };

  const changed =
    !existing ||
    existing.start_time !== (start ? start + ":00" : null) ||
    existing.end_time !== (end ? end + ":00" : null) ||
    existing.is_day_off !== isDayOff;

  if (isSameDay && existing && changed && !input.same_day_edit_reason?.trim()) {
    throw new Error(
      "Same-day shift edits require a reason (e.g. 'Left early – family emergency').",
    );
  }

  // A manager may only edit a shift that actually belongs to the day/employee
  // named in the request — guards against a stale `id` from a race (e.g. the
  // shift was deleted in another tab) silently editing the wrong row.
  if (existing && (existing.employee_id !== input.employee_id || existing.shift_date !== input.shift_date)) {
    throw new Error("That shift no longer matches this employee/date. Refresh and try again.");
  }

  const payload = {
    employee_id: input.employee_id,
    store_id: input.store_id,
    shift_date: input.shift_date,
    start_time: start,
    end_time: end,
    is_day_off: isDayOff,
    scheduled_hours: hours,
    shift_type: shiftType,
    manager_notes: input.manager_notes?.trim() || null,
    same_day_edit_reason:
      isSameDay && changed ? input.same_day_edit_reason?.trim() || null : existing?.same_day_edit_reason ?? null,
    updated_by: user.id,
  };

  if (existing) {
    const { error } = await supabase
      .from("rota_shifts")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "update",
      entity: "rota_shift",
      entity_id: existing.id,
      changes: { before: existing, after: payload },
    });
  } else {
    const { error } = await supabase
      .from("rota_shifts")
      .insert({ ...payload, created_by: user.id });
    if (error) throw new Error(error.message);
    await writeAudit({
      action: "create",
      entity: "rota_shift",
      entity_id: `${input.employee_id}:${input.shift_date}`,
      changes: payload,
    });
  }

  revalidatePath("/rota");
  revalidatePath("/live");
  revalidatePath("/crew");
  return { ok: true };
}

export async function deleteShift(id: string) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  // Block clearing shifts on past days — they are read-only.
  const { data: existing } = await supabase
    .from("rota_shifts")
    .select("shift_date, store_id")
    .eq("id", id)
    .maybeSingle();
  if (existing && existing.shift_date < todayISO()) {
    throw new Error(
      "Past days are locked. You can view previous shifts but only edit today or upcoming days.",
    );
  }
  // Managers can only clear shifts on the rota of the store they're managing.
  if (existing && user.allowed!.role === "manager" && existing.store_id !== resolveActiveStoreId(user.allowed)) {
    throw new Error("Managers can only clear shifts at the store they're managing.");
  }

  const { error } = await supabase.from("rota_shifts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await writeAudit({ action: "delete", entity: "rota_shift", entity_id: id });
  revalidatePath("/rota");
  revalidatePath("/live");
  return { ok: true };
}

export async function upsertWeeklyDelivery(input: {
  driver_id: string;
  store_id: string;
  week_start_date: string;
  manager_avg_4wk?: number | null;
  vita_mojo_count?: number | null;
  notes?: string | null;
  reason?: string | null;
}) {
  await requireAllowed();
  const supabase = createServerSupabase();

  const { data: existing } = await supabase
    .from("weekly_deliveries")
    .select("id")
    .eq("driver_id", input.driver_id)
    .eq("week_start_date", input.week_start_date)
    .maybeSingle();

  const payload = {
    driver_id: input.driver_id,
    store_id: input.store_id,
    week_start_date: input.week_start_date,
    manager_avg_4wk:
      input.manager_avg_4wk != null ? Number(input.manager_avg_4wk) : null,
    vita_mojo_count: input.vita_mojo_count != null ? Number(input.vita_mojo_count) : null,
    notes: input.notes?.trim() || null,
    reason: input.reason?.trim() || null,
  };

  if (existing) {
    const { error } = await supabase
      .from("weekly_deliveries")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("weekly_deliveries").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: "upsert",
    entity: "weekly_delivery",
    entity_id: existing?.id ?? `${input.driver_id}:${input.week_start_date}`,
    changes: payload,
  });

  revalidatePath("/rota");
  return { ok: true };
}
