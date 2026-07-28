"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, findAuthUserByEmail } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import {
  buildLoginEmail,
  normalizeContactEmail,
  validateContactEmail,
} from "@/lib/credentials";
import { generatePassword, uniqueUsername } from "@/lib/provisioning";
import { resolveActiveStoreId, type EmployeePosition } from "@/lib/types";

async function requireAdmin() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin") throw new Error("Admin only");
  return user;
}

// Admin OR manager. Managers can only ever act within their own store.
async function requireStaff() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Not authorised");
  }
  return user;
}

// Credential generation (generatePassword / uniqueUsername) lives in
// lib/provisioning.ts so employee, manager and cover-driver provisioning share
// one implementation and the username-uniqueness rules cannot drift apart.

/**
 * Validate + normalise a contact email (the address password-reset links go to),
 * throwing a message fit for a toast. Required at creation so every new account
 * can recover itself without an admin.
 */
function requireContactEmail(raw: string | null | undefined): string {
  const problem = validateContactEmail(raw ?? "");
  if (problem) throw new Error(problem);
  return normalizeContactEmail(raw!);
}

/**
 * Turn a contact_email unique-violation into something an admin can act on.
 * The address is unique across every account precisely so a reset link is never
 * ambiguous, so a clash is a real conflict, not a glitch to retry.
 */
function describeAccountWriteError(err: { code?: string; message: string }): string {
  if (err.code === "23505" && err.message.includes("contact_email")) {
    return "That email is already used by another account. Each person needs their own.";
  }
  return err.message;
}

export type ProvisionResult = {
  ok: true;
  username: string;
  password: string;
  loginUrl: string;
};

/**
 * Create a MANAGER login account. Creates the auth user (service role),
 * whitelists it as a manager for a store, and returns the credentials to share.
 */
// Admin-only. Admins may create a manager for ANY store (intentionally
// unrestricted — managers can never call this; only requireAdmin passes).
export async function createManagerAccount(input: {
  name: string;
  store_id: string;
  /** Real address for password-reset links. Required — see requireContactEmail. */
  contact_email: string;
  /** Fixed daily wage (£) — monitoring/display only, never drives pay. */
  fixed_daily_wage?: number | null;
}): Promise<ProvisionResult> {
  await requireAdmin();
  if (!input.name?.trim()) throw new Error("Name is required");
  if (!input.store_id) throw new Error("Store is required");
  const contactEmail = requireContactEmail(input.contact_email);

  const admin = createAdminClient();

  const username = await uniqueUsername(input.name);
  const email = buildLoginEmail(username);
  const password = generatePassword();

  // 1) create the auth user (email pre-confirmed so they can log in immediately)
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: input.name.trim(), role: "manager" },
  });
  if (authErr || !created?.user) {
    throw new Error(authErr?.message || "Failed to create login account");
  }

  // 2) whitelist + record credentials. Use the service-role client: writing
  // allowed_users is admin-only under RLS, and this action is already
  // authorised (requireAdmin), so we bypass the policy intentionally.
  const wage =
    input.fixed_daily_wage != null && Number(input.fixed_daily_wage) > 0
      ? Number(input.fixed_daily_wage)
      : null;
  const { error: rowErr } = await admin.from("allowed_users").insert({
    email,
    contact_email: contactEmail,
    name: input.name.trim(),
    role: "manager",
    store_id: input.store_id,
    username,
    temp_password: password,
    must_change_password: true,
    fixed_daily_wage: wage,
  });
  if (rowErr) {
    // roll back the auth user so we don't orphan it
    await admin.auth.admin.deleteUser(created.user.id);
    throw new Error(describeAccountWriteError(rowErr));
  }

  await writeAudit({
    action: "create_manager_account",
    entity: "allowed_user",
    entity_id: created.user.id,
    changes: { username, store_id: input.store_id, contact_email: contactEmail },
  });

  revalidatePath("/managers");
  return { ok: true, username, password, loginUrl: "/manager/login" };
}

/**
 * Admin-only: set/clear a manager's fixed daily wage (£). Display &
 * monitoring only — it never feeds any pay calculation.
 */
export async function updateManagerWage(input: {
  allowed_user_id: string;
  fixed_daily_wage: number | null;
}): Promise<{ ok: true }> {
  await requireAdmin();
  const supabase = createServerSupabase();

  const { data: acct } = await supabase
    .from("allowed_users")
    .select("id, role")
    .eq("id", input.allowed_user_id)
    .maybeSingle();
  if (!acct) throw new Error("Account not found");
  if (acct.role !== "manager") throw new Error("Only managers have a fixed wage");

  const wage =
    input.fixed_daily_wage != null && Number(input.fixed_daily_wage) > 0
      ? Number(input.fixed_daily_wage)
      : null;

  const { error } = await supabase
    .from("allowed_users")
    .update({ fixed_daily_wage: wage })
    .eq("id", acct.id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "update_manager_wage",
    entity: "allowed_user",
    entity_id: acct.id,
    changes: { fixed_daily_wage: wage },
  });

  revalidatePath("/managers");
  revalidatePath("/live");
  return { ok: true };
}

/**
 * Create an ADMIN login account in one step. There are a few owners who each
 * get their own admin credential; they all share the same single admin panel
 * and data — only the display name differs (shown in the sidebar). Creates the
 * auth user with the given email + a generated password, then whitelists it as
 * an admin. Returns the credentials to hand over.
 */
export async function createAdminAccount(input: {
  name: string;
  email: string;
}): Promise<{ ok: true; email: string; password: string; loginUrl: string }> {
  await requireAdmin();
  if (!input.name?.trim()) throw new Error("Name is required");
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("A valid email is required");

  const admin = createAdminClient();
  const password = generatePassword(12);

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: input.name.trim(), role: "admin" },
  });
  if (authErr || !created?.user) {
    throw new Error(authErr?.message || "Failed to create login account");
  }

  // An admin signs in with a real address, so it serves as both login identity
  // and reset target — no separate field to collect.
  const { error: rowErr } = await admin.from("allowed_users").insert({
    email,
    contact_email: email,
    name: input.name.trim(),
    role: "admin",
    store_id: null,
    must_change_password: true,
  });
  if (rowErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    throw new Error(describeAccountWriteError(rowErr));
  }

  await writeAudit({
    action: "create_admin_account",
    entity: "allowed_user",
    entity_id: created.user.id,
    changes: { email, name: input.name.trim() },
  });

  revalidatePath("/settings");
  return { ok: true, email, password, loginUrl: "/login" };
}

/**
 * Create an EMPLOYEE record AND its login account in one step.
 * Builds the HR profile (employees row) and a username/password login.
 */
export async function createEmployeeWithAccount(input: {
  name: string;
  /** Real address for password-reset links. Required — see requireContactEmail. */
  contact_email: string;
  phone?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  position: EmployeePosition;
  employment_start_date?: string | null;
  hourly_ni_rate: number;
  hourly_cash_rate?: number | null;
  short_delivery_rate?: number | null;
  long_delivery_rate?: number | null;
  store_id: string;
  bank_account_name?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  sort_code?: string | null;
  notes?: string | null;
}): Promise<ProvisionResult & { employee_id: string }> {
  const actor = await requireStaff();
  if (!input.name?.trim()) throw new Error("Name is required");
  if (!input.position) throw new Error("Position is required");
  if (!input.hourly_ni_rate || input.hourly_ni_rate <= 0)
    throw new Error("Hourly NI rate must be greater than 0");
  const contactEmail = requireContactEmail(input.contact_email);

  // Managers create staff for the store they're currently managing; admins choose freely.
  const store_id =
    actor.allowed!.role === "manager"
      ? resolveActiveStoreId(actor.allowed)
      : input.store_id;
  if (!store_id) throw new Error("Store is required");

  // Service-role client: provisioning writes to employees + allowed_users are
  // privileged and already authorised above (requireStaff), so we bypass RLS.
  const admin = createAdminClient();

  const username = await uniqueUsername(input.name);
  const email = buildLoginEmail(username);
  const password = generatePassword();

  // 1) auth user
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: input.name.trim(), role: "employee" },
  });
  if (authErr || !created?.user) {
    throw new Error(authErr?.message || "Failed to create login account");
  }
  const authUserId = created.user.id;

  // 2) employees (HR profile) row
  const employeePayload = {
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    email,
    auth_user_id: authUserId,
    date_of_birth: input.date_of_birth || null,
    gender: input.gender?.trim() || null,
    position: input.position,
    employment_start_date: input.employment_start_date || null,
    joined_date: input.employment_start_date || null,
    hourly_ni_rate: Number(input.hourly_ni_rate),
    hourly_cash_rate:
      input.hourly_cash_rate != null ? Number(input.hourly_cash_rate) : null,
    short_delivery_rate:
      input.short_delivery_rate != null ? Number(input.short_delivery_rate) : null,
    long_delivery_rate:
      input.long_delivery_rate != null ? Number(input.long_delivery_rate) : null,
    hourly_rate: Number(input.hourly_ni_rate),
    store_id,
    bank_account_name: input.bank_account_name?.trim() || null,
    bank_name: input.bank_name?.trim() || null,
    account_number: input.account_number?.trim() || null,
    sort_code: input.sort_code?.trim() || null,
    employment_status: "active",
    notes: input.notes?.trim() || null,
    is_active: true,
    bank_weekly_hours_limit: 20,
  };

  const { data: emp, error: empErr } = await admin
    .from("employees")
    .insert(employeePayload)
    .select("id")
    .maybeSingle();
  if (empErr || !emp) {
    await admin.auth.admin.deleteUser(authUserId);
    throw new Error(empErr?.message || "Failed to create employee");
  }

  // 3) whitelist login account linked to the employee row
  const { error: rowErr } = await admin.from("allowed_users").insert({
    email,
    contact_email: contactEmail,
    name: input.name.trim(),
    role: "employee",
    store_id,
    username,
    temp_password: password,
    must_change_password: true,
    employee_id: emp.id,
  });
  if (rowErr) {
    await admin.from("employees").delete().eq("id", emp.id);
    await admin.auth.admin.deleteUser(authUserId);
    throw new Error(describeAccountWriteError(rowErr));
  }

  await writeAudit({
    action: "create_employee_account",
    entity: "employee",
    entity_id: emp.id,
    changes: { username, store_id, position: input.position, contact_email: contactEmail },
  });

  revalidatePath("/employees");
  return {
    ok: true,
    username,
    password,
    loginUrl: "/employee/login",
    employee_id: emp.id,
  };
}

/**
 * Admin-only: set/change the address a staff member's password-reset links go
 * to. The fallback for anyone provisioned before migration 019 (no contact_email
 * yet) and for anyone who changes address; staff can also do this themselves
 * from their own profile/settings page (see app/actions/self.ts).
 */
export async function updateAccountContactEmail(input: {
  allowed_user_id: string;
  /** Empty string clears it — the remediation path for a wrong or stale address. */
  contact_email: string;
}): Promise<{ ok: true; contact_email: string | null }> {
  await requireAdmin();
  const trimmed = (input.contact_email ?? "").trim();
  const contactEmail = trimmed ? requireContactEmail(trimmed) : null;
  const supabase = createServerSupabase();

  const { data: acct } = await supabase
    .from("allowed_users")
    .select("id")
    .eq("id", input.allowed_user_id)
    .maybeSingle();
  if (!acct) throw new Error("Account not found");

  const { error } = await supabase
    .from("allowed_users")
    .update({ contact_email: contactEmail })
    .eq("id", acct.id);
  if (error) throw new Error(describeAccountWriteError(error));

  await writeAudit({
    action: "update_contact_email",
    entity: "allowed_user",
    entity_id: acct.id,
    changes: { contact_email: contactEmail },
  });

  revalidatePath("/managers");
  revalidatePath("/employees");
  return { ok: true, contact_email: contactEmail };
}

/** Regenerate the password for an existing account (manager or employee). */
export async function resetAccountPassword(input: {
  allowed_user_id: string;
}): Promise<{ ok: true; username: string; password: string }> {
  await requireAdmin();
  const admin = createAdminClient();
  const supabase = createServerSupabase();

  const { data: acct, error } = await supabase
    .from("allowed_users")
    .select("id, email, username, role")
    .eq("id", input.allowed_user_id)
    .maybeSingle();
  if (error || !acct) throw new Error("Account not found");
  if (acct.role === "admin") throw new Error("Admin passwords are managed in Supabase");

  const password = generatePassword();
  const authUser = await findAuthUserByEmail(admin, acct.email);
  if (!authUser) throw new Error("Login account not found in auth");

  const { error: updErr } = await admin.auth.admin.updateUserById(authUser.id, {
    password,
  });
  if (updErr) throw new Error(updErr.message);

  await supabase
    .from("allowed_users")
    .update({ temp_password: password, must_change_password: true })
    .eq("id", acct.id);

  await writeAudit({
    action: "reset_password",
    entity: "allowed_user",
    entity_id: acct.id,
  });

  revalidatePath("/managers");
  revalidatePath("/employees");
  return { ok: true, username: acct.username ?? acct.email, password };
}

/** Delete a login account (and its auth user). Optionally keep the HR row. */
export async function deleteAccount(input: { allowed_user_id: string }) {
  await requireAdmin();
  const admin = createAdminClient();
  const supabase = createServerSupabase();

  const { data: acct, error } = await supabase
    .from("allowed_users")
    .select("id, email, role")
    .eq("id", input.allowed_user_id)
    .maybeSingle();
  if (error || !acct) throw new Error("Account not found");
  if (acct.role === "admin") throw new Error("Cannot delete an admin account here");

  // Remove the auth user FIRST; only drop the whitelist row if that succeeded,
  // so we never leave a usable login pointing at a deleted whitelist entry.
  const authUser = await findAuthUserByEmail(admin, acct.email);
  if (authUser) {
    const { error: delErr } = await admin.auth.admin.deleteUser(authUser.id);
    if (delErr) throw new Error(delErr.message);
  }

  await supabase.from("allowed_users").delete().eq("id", acct.id);

  await writeAudit({
    action: "delete_account",
    entity: "allowed_user",
    entity_id: acct.id,
  });

  revalidatePath("/managers");
  revalidatePath("/employees");
  return { ok: true };
}
