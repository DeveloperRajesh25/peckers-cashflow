"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import { buildLoginEmail } from "@/lib/credentials";
import { generatePassword, uniqueUsername } from "@/lib/provisioning";
import { clockedHours } from "@/lib/utils";
import { totalDeliveries } from "@/lib/cover-driver-hours";
import {
  resolveActiveStoreId,
  type CoverDriver,
  type CoverDriverHoursComputed,
} from "@/lib/types";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

async function requireStaff(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Only managers and admins can manage cover drivers.");
  }
  return user;
}

function assertStoreAccess(user: SessionUser, storeId: string) {
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (storeId !== activeStore) {
      throw new Error("You can only manage cover drivers for the store you're managing.");
    }
  }
}

// Cover drivers appear on the employees pages and in their own portal only.
// Deliberately NOT /rota, /live, /analytics or /ni-monthly — they are absent
// from those modules by design.
function revalidateCoverDrivers() {
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/cover-driver/attendance");
}

async function freshHours(): Promise<CoverDriverHoursComputed[]> {
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("cover_driver_hours_computed")
    .select("*")
    .order("work_date", { ascending: false })
    .limit(500);
  return (data ?? []) as CoverDriverHoursComputed[];
}

export type CoverDriverInput = {
  name: string;
  store_id: string;
  phone?: string | null;
  date_of_birth?: string | null;
  hourly_cash_rate: number;
  short_delivery_rate?: number | null;
  long_delivery_rate?: number | null;
  notes?: string | null;
};

function validate(input: CoverDriverInput) {
  if (!input.name?.trim()) throw new Error("Driver name is required");
  const rate = Number(input.hourly_cash_rate);
  if (!rate || isNaN(rate) || rate <= 0) {
    throw new Error("Hourly cash rate must be greater than 0");
  }
}

function optionalRate(value: number | null | undefined): number | null {
  if (value == null || (value as unknown as string) === "") return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

/**
 * Create a cover driver AND its login in one step, mirroring
 * createEmployeeWithAccount. Rolls back the auth user and profile row if a
 * later step fails, so a half-provisioned driver is never left behind.
 */
export async function createCoverDriverWithAccount(input: CoverDriverInput): Promise<{
  ok: true;
  username: string;
  password: string;
  loginUrl: string;
  cover_driver_id: string;
}> {
  const actor = await requireStaff();
  validate(input);

  // Managers can only create drivers for the store they're currently managing
  // (resolveActiveStoreId, not store_id — a switched manager must not create
  // the driver at their home store); admins choose freely.
  const store_id =
    actor.allowed!.role === "manager"
      ? resolveActiveStoreId(actor.allowed)
      : input.store_id;
  if (!store_id) throw new Error("Store is required");

  // Service-role client: writes to cover_drivers + allowed_users are privileged
  // and already authorised above, so we bypass RLS intentionally.
  const admin = createAdminClient();

  const username = await uniqueUsername(input.name);
  const email = buildLoginEmail(username);
  const password = generatePassword();

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: input.name.trim(), role: "cover_driver" },
  });
  if (authErr || !created?.user) {
    throw new Error(authErr?.message || "Failed to create login account");
  }
  const authUserId = created.user.id;

  const profile = {
    store_id,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    date_of_birth: input.date_of_birth || null,
    hourly_cash_rate: Number(input.hourly_cash_rate),
    short_delivery_rate: optionalRate(input.short_delivery_rate),
    long_delivery_rate: optionalRate(input.long_delivery_rate),
    email,
    auth_user_id: authUserId,
    is_active: true,
    notes: input.notes?.trim() || null,
    created_by: actor.id,
  };

  const { data: driver, error: driverErr } = await admin
    .from("cover_drivers")
    .insert(profile)
    .select("id")
    .maybeSingle();
  if (driverErr || !driver) {
    await admin.auth.admin.deleteUser(authUserId);
    throw new Error(driverErr?.message || "Failed to create cover driver");
  }

  const { error: rowErr } = await admin.from("allowed_users").insert({
    email,
    name: input.name.trim(),
    role: "cover_driver",
    store_id,
    username,
    temp_password: password,
    must_change_password: true,
    cover_driver_id: driver.id,
  });
  if (rowErr) {
    await admin.from("cover_drivers").delete().eq("id", driver.id);
    await admin.auth.admin.deleteUser(authUserId);
    throw new Error(rowErr.message);
  }

  await writeAudit({
    action: "create_cover_driver_account",
    entity: "cover_driver",
    entity_id: driver.id,
    changes: { username, store_id },
  });

  revalidateCoverDrivers();
  return {
    ok: true,
    username,
    password,
    loginUrl: "/cover-driver/login",
    cover_driver_id: driver.id,
  };
}

/** Edit a profile. Never touches email/auth_user_id — that is the login linkage. */
export async function updateCoverDriver(
  input: CoverDriverInput & { id: string },
): Promise<{ ok: true; driver: CoverDriver }> {
  const user = await requireStaff();
  validate(input);
  if (!input.id) throw new Error("Missing cover driver id");

  const supabase = createServerSupabase();
  const { data: existing } = await supabase
    .from("cover_drivers")
    .select("id, store_id")
    .eq("id", input.id)
    .maybeSingle();
  if (!existing) throw new Error("Cover driver not found");
  assertStoreAccess(user, existing.store_id);

  // A manager cannot move a driver out of their own store.
  const store_id =
    user.allowed!.role === "manager"
      ? existing.store_id
      : input.store_id || existing.store_id;

  const payload = {
    store_id,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    date_of_birth: input.date_of_birth || null,
    hourly_cash_rate: Number(input.hourly_cash_rate),
    short_delivery_rate: optionalRate(input.short_delivery_rate),
    long_delivery_rate: optionalRate(input.long_delivery_rate),
    notes: input.notes?.trim() || null,
  };

  const { data, error } = await supabase
    .from("cover_drivers")
    .update(payload)
    .eq("id", input.id)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Failed to update cover driver");

  await writeAudit({
    action: "update",
    entity: "cover_driver",
    entity_id: input.id,
    changes: payload,
  });

  revalidateCoverDrivers();
  return { ok: true, driver: data as CoverDriver };
}

/** Deactivate (or restore) a driver. Blocks clock-in without deleting history. */
export async function archiveCoverDriver(
  id: string,
  archive: boolean,
): Promise<{ ok: true; driver: CoverDriver }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: existing } = await supabase
    .from("cover_drivers")
    .select("id, store_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) throw new Error("Cover driver not found");
  assertStoreAccess(user, existing.store_id);

  const { data, error } = await supabase
    .from("cover_drivers")
    .update({ is_active: !archive })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Failed to update cover driver");

  await writeAudit({
    action: archive ? "archive" : "restore",
    entity: "cover_driver",
    entity_id: id,
  });

  revalidateCoverDrivers();
  return { ok: true, driver: data as CoverDriver };
}

/**
 * Approve one cover-driver DAY (employees approve per week; a cover shift is a
 * discrete engagement). Hours and delivery counts are recomputed server-side
 * from the clock event — never trusted from the client — and the driver's rates
 * are snapshot so historic pay can't drift when a rate is later changed.
 */
export async function approveCoverDriverDay(input: {
  cover_driver_id: string;
  work_date: string;
}): Promise<{ ok: true; hours: CoverDriverHoursComputed[] }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  if (!input.cover_driver_id) throw new Error("Select a cover driver");
  if (!input.work_date) throw new Error("Work date is required");

  const { data: driver } = await supabase
    .from("cover_drivers")
    .select("id, store_id, hourly_cash_rate, short_delivery_rate, long_delivery_rate")
    .eq("id", input.cover_driver_id)
    .maybeSingle();
  if (!driver) throw new Error("Cover driver not found");
  assertStoreAccess(user, driver.store_id);

  const { data: event } = await supabase
    .from("cover_driver_clock_events")
    .select("*")
    .eq("cover_driver_id", input.cover_driver_id)
    .eq("event_date", input.work_date)
    .maybeSingle();

  if (!event?.clock_in_at || !event?.clock_out_at) {
    throw new Error("No completed clock-in/out for this driver on that date.");
  }

  const hours = Math.round(clockedHours(event.clock_in_at, event.clock_out_at) * 100) / 100;
  if (hours <= 0) throw new Error("That day has no worked hours to approve.");

  const payload = {
    cover_driver_id: input.cover_driver_id,
    store_id: event.store_id,
    work_date: input.work_date,
    total_hours_worked: hours,
    hourly_rate_snapshot: Number(driver.hourly_cash_rate),
    short_deliveries: totalDeliveries(
      event.short_deliveries_count,
      event.extra_short_deliveries,
    ),
    long_deliveries: totalDeliveries(
      event.long_deliveries_count,
      event.extra_long_deliveries,
    ),
    short_rate_snapshot: driver.short_delivery_rate,
    long_rate_snapshot: driver.long_delivery_rate,
    source: "clocked" as const,
    approved: true,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("cover_driver_hours")
    .select("id")
    .eq("cover_driver_id", input.cover_driver_id)
    .eq("work_date", input.work_date)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("cover_driver_hours")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("cover_driver_hours").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: "approve_cover_driver_day",
    entity: "cover_driver_hours",
    entity_id: existing?.id ?? input.cover_driver_id,
    changes: payload,
  });

  revalidateCoverDrivers();
  return { ok: true, hours: await freshHours() };
}

/** Remove an approved day. The underlying clock event is kept. */
export async function deleteCoverDriverHours(
  id: string,
): Promise<{ ok: true; deletedId: string }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: row } = await supabase
    .from("cover_driver_hours")
    .select("id, store_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("Record not found");
  assertStoreAccess(user, row.store_id);

  const { error } = await supabase.from("cover_driver_hours").delete().eq("id", id);
  if (error) throw new Error(error.message);

  await writeAudit({ action: "delete", entity: "cover_driver_hours", entity_id: id });
  revalidateCoverDrivers();
  return { ok: true, deletedId: id };
}
