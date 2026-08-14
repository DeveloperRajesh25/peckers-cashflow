"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { normalizeContactEmail, validateContactEmail } from "@/lib/credentials";
import { writeAudit } from "./audit";
import {
  addDays,
  dayWorkedHours,
  formatHoursMinsWords,
  parseISODate,
  roundHoursToMinute,
  startOfISOWeek,
  toISODate,
} from "@/lib/utils";
import { employeeNiRate, rollupApprovedWeek } from "@/lib/employee-hours-rollup";
import {
  applyDayDeliveryTotal,
  approveDaySessions,
  recomputeDayHeader,
  setSessionApproval,
  unapproveDaySessions,
} from "@/lib/clock-sessions";
import { withContactEmails } from "@/lib/contact-email";
import { resolveActiveStoreId } from "@/lib/types";
import type {
  Employee,
  EmployeeHoursComputed,
  EmployeePosition,
  EmploymentStatus,
  SessionUser,
} from "@/lib/types";

async function requireAllowed() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  return user;
}

/**
 * How many weekly rollup rows the Weekly Log will hold. One row per employee
 * per week, so ~30 staff × 52 weeks ≈ 1,560/yr — about 16 months of headroom.
 * The previous 500 was ~2 weeks from silently discarding the oldest weeks.
 *
 * Every read of employee_hours_computed uses this, because the approve actions
 * hand their result straight to the client: a different limit there would
 * install a differently-truncated list than the tab originally loaded.
 */
const WEEKLY_HOURS_MAX_ROWS = 2000;

/** The weekly rollup, plus whether the cap actually bit — never truncate in silence. */
export type WeeklyHoursSlice = {
  rows: EmployeeHoursComputed[];
  capped: boolean;
};

async function fetchWeeklyHours(supabase: ServerSupabase): Promise<WeeklyHoursSlice> {
  const { data, error } = await supabase
    .from("employee_hours_computed")
    .select("*")
    .order("week_start_date", { ascending: false })
    .limit(WEEKLY_HOURS_MAX_ROWS);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as EmployeeHoursComputed[];
  return { rows, capped: rows.length >= WEEKLY_HOURS_MAX_ROWS };
}

/**
 * Full employee rows for the Employees (cards) tab, fetched when that tab is
 * opened. Bank details, DOB and the contact-email lookup are only rendered
 * there, so none of it belongs on the approval screen's critical path.
 */
export async function loadEmployeeDirectory(): Promise<Employee[]> {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  let query = supabase
    .from("employees")
    .select("*")
    .order("employment_status")
    .order("name");
  // A manager's scope is re-derived here: a server action is a public endpoint,
  // and the page's guard does not cover it.
  if (user.allowed!.role === "manager") {
    const storeId = resolveActiveStoreId(user.allowed);
    if (!storeId) throw new Error("No store assigned to your account.");
    query = query.eq("store_id", storeId);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return withContactEmails(supabase, (data ?? []) as Employee[]);
}

/**
 * The Weekly Log's rolled-up hours. Same query the approve actions return, so
 * an approval refreshes this slice rather than merely invalidating it.
 */
export async function loadWeeklyHoursLog(): Promise<WeeklyHoursSlice> {
  await requireAllowed();
  return fetchWeeklyHours(createServerSupabase());
}

/**
 * Change the password-reset address for an existing employee. It lives on the
 * linked login account (allowed_users.contact_email), not on employees, so it
 * can't ride along in buildPayload — see migration 019.
 *
 * SECURITY — why this is ADMIN-ONLY, even though managers otherwise run their
 * own store's crew:
 *
 * Whoever controls this address can request a reset link for the account and
 * walk in as that person. So being able to change it IS being able to take the
 * account over, and the app deliberately withholds that from managers:
 * resetAccountPassword and updateAccountContactEmail are both requireAdmin.
 * Letting a manager edit this field would hand back the exact capability those
 * guards withhold — impersonated clock-ins, self-approved hours, all attributed
 * to the employee.
 *
 * (Provisioning is different: a manager creating crew already sees the generated
 * password on screen, so collecting the address there grants nothing new.)
 *
 * RLS is NOT the backstop here — allowed_users writes are admin-only under RLS,
 * but this needs the service-role client to reach the row, so the check below is
 * the only thing standing between a caller and this field. updateEmployee's own
 * guard (requireAllowed) admits ANY whitelisted user, including crew.
 *
 * Pass an empty string to clear the address (the remediation path when one is
 * wrong, stale, or attacker-controlled).
 */
async function writeContactEmail(
  actor: SessionUser,
  employeeId: string,
  raw: string,
) {
  if (!isProvisioningConfigured()) {
    throw new Error(
      "Can't save the email: SUPABASE_SERVICE_ROLE_KEY isn't set on the server.",
    );
  }
  const admin = createAdminClient();

  const { data: acct } = await admin
    .from("allowed_users")
    .select("id, store_id, contact_email")
    .eq("employee_id", employeeId)
    .maybeSingle();

  const trimmed = raw.trim();
  const contactEmail = trimmed ? normalizeContactEmail(trimmed) : null;

  // No change? Then nothing to authorise. This is what lets a manager edit a
  // crew member's phone or pay rate through the same form: the field round-trips
  // untouched and never reaches the admin check below.
  if ((acct?.contact_email ?? null) === contactEmail) return;

  if (actor.allowed?.role !== "admin") {
    throw new Error(
      "Only an admin can change the password-reset email. Ask them, or have the staff member set it themselves on their profile page.",
    );
  }

  if (contactEmail) {
    const problem = validateContactEmail(contactEmail);
    if (problem) throw new Error(problem);
  }

  if (!acct) {
    // An HR row with no login account (pre-dates one-step provisioning): there is
    // nowhere to put a reset address and no password to reset. Say so rather than
    // dropping it silently, which would look like a successful save.
    throw new Error(
      "This employee has no login account, so there's no password to reset. Leave the email blank.",
    );
  }

  const { error } = await admin
    .from("allowed_users")
    .update({ contact_email: contactEmail })
    .eq("id", acct.id);

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "That email is already used by another account. Each person needs their own.",
      );
    }
    throw new Error(error.message);
  }

  // buildPayload deliberately excludes contact_email, so updateEmployee's own
  // audit row would not record this — and this is the write most worth tracing.
  await writeAudit({
    action: "update_contact_email",
    entity: "allowed_user",
    entity_id: acct.id,
    changes: { contact_email: contactEmail, employee_id: employeeId },
  });
}

export type EmployeeInput = {
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  /** Password-reset address. Stored on the linked allowed_users row, not on
   *  employees — routed there by writeContactEmail, never by buildPayload. */
  contact_email?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  position?: string | null; // Pipe-delimited positions (e.g. "Kitchen Team Member|Driver")
  employment_start_date?: string | null;
  joined_date?: string | null;
  hourly_ni_rate?: number | null;
  hourly_cash_rate?: number | null;
  short_delivery_rate?: number | null;
  long_delivery_rate?: number | null;
  hourly_rate?: number;
  store_id?: string | null;
  bank_account_name?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  sort_code?: string | null;
  employment_status?: EmploymentStatus;
  notes?: string | null;
};

function buildPayload(input: EmployeeInput) {
  const niRate = Number(input.hourly_ni_rate ?? input.hourly_rate ?? 0);
  // NOTE: we intentionally do NOT manage `email` or `auth_user_id` here — those
  // are the login linkage, set once by account provisioning (accounts.ts). The
  // profile form must never overwrite them. `contact_email` is likewise absent:
  // it isn't an employees column at all (see writeContactEmail).
  return {
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    date_of_birth: input.date_of_birth || null,
    gender: input.gender?.trim() || null,
    position: input.position || null,
    employment_start_date:
      input.employment_start_date || input.joined_date || null,
    joined_date: input.joined_date || input.employment_start_date || null,
    hourly_ni_rate: input.hourly_ni_rate != null ? Number(input.hourly_ni_rate) : null,
    hourly_cash_rate:
      input.hourly_cash_rate != null && input.hourly_cash_rate !== ("" as unknown as number)
        ? Number(input.hourly_cash_rate)
        : null,
    short_delivery_rate:
      input.short_delivery_rate != null && input.short_delivery_rate !== ("" as unknown as number)
        ? Number(input.short_delivery_rate)
        : null,
    long_delivery_rate:
      input.long_delivery_rate != null && input.long_delivery_rate !== ("" as unknown as number)
        ? Number(input.long_delivery_rate)
        : null,
    hourly_rate: niRate || Number(input.hourly_rate ?? 0),
    store_id: input.store_id || null,
    bank_account_name: input.bank_account_name?.trim() || null,
    bank_name: input.bank_name?.trim() || null,
    account_number: input.account_number?.trim() || null,
    sort_code: input.sort_code?.trim() || null,
    employment_status: input.employment_status || "active",
    notes: input.notes?.trim() || null,
  };
}

export async function createEmployee(input: EmployeeInput) {
  await requireAllowed();
  const supabase = createServerSupabase();
  if (!input.name?.trim()) throw new Error("Name is required");
  const ni = Number(input.hourly_ni_rate ?? input.hourly_rate ?? 0);
  if (!ni || ni <= 0) throw new Error("Hourly NI rate must be greater than 0");
  if (!input.position) throw new Error("Position is required");
  if (!input.store_id) throw new Error("Store assignment is required");

  const payload = {
    ...buildPayload(input),
    is_active: input.employment_status !== "left" && input.employment_status !== "inactive",
    bank_weekly_hours_limit: 20,
  };

  const { data, error } = await supabase
    .from("employees")
    .insert(payload)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "create",
    entity: "employee",
    entity_id: data?.id ?? null,
    changes: payload,
  });

  revalidatePath("/employees");
  revalidatePath("/rota");
  return { ok: true, id: data?.id };
}

export async function updateEmployee(input: EmployeeInput) {
  if (!input.id) throw new Error("Missing employee id");
  const actor = await requireAllowed();
  const supabase = createServerSupabase();

  const payload = {
    ...buildPayload(input),
    is_active:
      input.employment_status === "left" || input.employment_status === "inactive"
        ? false
        : true,
  };

  // Separate table, separate authorisation — and it throws. Done BEFORE the
  // employees write so a rejected email (unauthorised, malformed, already taken)
  // aborts the whole save, rather than reporting failure while the profile edit
  // has already landed. `undefined` means "form didn't manage this field"; an
  // empty string is an explicit clear.
  if (input.contact_email !== undefined && input.contact_email !== null) {
    await writeContactEmail(actor, input.id, input.contact_email);
  }

  const { error } = await supabase
    .from("employees")
    .update(payload)
    .eq("id", input.id);
  if (error) throw new Error(error.message);

  await writeAudit({
    action: "update",
    entity: "employee",
    entity_id: input.id,
    changes: payload,
  });

  revalidatePath("/employees");
  revalidatePath("/rota");
  revalidatePath("/live");
  return { ok: true };
}

export async function archiveEmployee(id: string, archive: boolean) {
  await requireAllowed();
  const supabase = createServerSupabase();
  const { error } = await supabase
    .from("employees")
    .update({
      is_active: !archive,
      employment_status: archive ? "inactive" : "active",
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await writeAudit({
    action: archive ? "archive" : "restore",
    entity: "employee",
    entity_id: id,
  });
  revalidatePath("/employees");
  revalidatePath("/rota");
  return { ok: true };
}

export async function reassignEmployeeStore(id: string, store_id: string) {
  await requireAllowed();
  const supabase = createServerSupabase();
  const { error } = await supabase
    .from("employees")
    .update({ store_id })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await writeAudit({
    action: "reassign_store",
    entity: "employee",
    entity_id: id,
    changes: { store_id },
  });
  revalidatePath("/employees");
  revalidatePath("/rota");
  revalidatePath("/live");
  return { ok: true };
}

export async function logEmployeeHours(input: {
  employee_id: string;
  week_start_date: string;
  total_hours_worked: number;
  notes?: string | null;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  if (!input.employee_id) throw new Error("Select an employee");
  if (!input.week_start_date) throw new Error("Week start date required");
  if (
    input.total_hours_worked == null ||
    input.total_hours_worked <= 0 ||
    isNaN(Number(input.total_hours_worked))
  )
    throw new Error("Hours must be greater than 0");

  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("hourly_rate, hourly_ni_rate")
    .eq("id", input.employee_id)
    .maybeSingle();
  if (empErr || !emp) throw new Error("Employee not found");

  const rate = Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0);

  const { data: existing } = await supabase
    .from("employee_hours")
    .select("id")
    .eq("employee_id", input.employee_id)
    .eq("week_start_date", input.week_start_date)
    .maybeSingle();

  const payload = {
    employee_id: input.employee_id,
    week_start_date: input.week_start_date,
    total_hours_worked: Number(input.total_hours_worked),
    hourly_rate_snapshot: rate,
    notes: input.notes?.trim() || null,
    logged_by: user.id,
    source: "manual" as const,
    approved: true,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from("employee_hours")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("employee_hours").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: existing ? "update" : "create",
    entity: "employee_hours",
    entity_id: existing?.id ?? input.employee_id,
    changes: payload,
  });

  // Fetch the fresh computed rows so the client can update state immediately
  // without waiting for the router cache to clear.
  const fresh = await fetchWeeklyHours(supabase);

  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/analytics");
  return { ok: true, hours: fresh.rows, hoursCapped: fresh.capped };
}

/**
 * Approve the hours an employee actually clocked for a week. The clocked total
 * is recomputed server-side from clock_events (not trusted from the client),
 * then persisted as an employee_hours row stamped approved + source 'clocked'.
 * This replaces manual weekly-hours logging for managers.
 */
export async function approveClockedHours(input: {
  employee_id: string;
  week_start_date: string;
  override_hours?: number;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  if (!input.employee_id) throw new Error("Select an employee");
  if (!input.week_start_date) throw new Error("Week start date required");

  const { data: emp, error: empErr } = await supabase
    .from("employees")
    .select("hourly_rate, hourly_ni_rate")
    .eq("id", input.employee_id)
    .maybeSingle();
  if (empErr || !emp) throw new Error("Employee not found");
  const rate = Number(emp.hourly_ni_rate ?? emp.hourly_rate ?? 0);

  // Recompute the week's clocked total from completed clock sessions.
  const weekEnd = toISODate(addDays(parseISODate(input.week_start_date), 6));
  const { data: events } = await supabase
    .from("clock_events")
    .select("clock_in_at, clock_out_at, worked_hours")
    .eq("employee_id", input.employee_id)
    .gte("event_date", input.week_start_date)
    .lte("event_date", weekEnd)
    .not("clock_out_at", "is", null);

  const clockedHours = (events ?? []).reduce(
    (sum, ev) => sum + dayWorkedHours(ev),
    0,
  );
  const clockedTotal = roundHoursToMinute(clockedHours);
  if (clockedTotal <= 0) {
    throw new Error("No completed clock-in/out sessions to approve for this week.");
  }

  // Manager/admin may adjust the hours before approving (e.g. correcting a
  // missed clock-out). Falls back to the recomputed clocked total otherwise.
  const hasOverride =
    input.override_hours != null && !isNaN(Number(input.override_hours));
  const totalHours = hasOverride ? Number(input.override_hours) : clockedTotal;
  if (totalHours <= 0) throw new Error("Hours must be greater than 0");
  const wasAdjusted = hasOverride && Math.abs(totalHours - clockedTotal) > 0.01;

  const { data: existing } = await supabase
    .from("employee_hours")
    .select("id")
    .eq("employee_id", input.employee_id)
    .eq("week_start_date", input.week_start_date)
    .maybeSingle();

  const payload = {
    employee_id: input.employee_id,
    week_start_date: input.week_start_date,
    total_hours_worked: totalHours,
    hourly_rate_snapshot: rate,
    notes: wasAdjusted
      ? `Adjusted from clocked ${formatHoursMinsWords(clockedTotal)} by manager`
      : null,
    logged_by: user.id,
    source: "clocked" as const,
    approved: true,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from("employee_hours")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("employee_hours").insert(payload);
    if (error) throw new Error(error.message);
  }

  await writeAudit({
    action: "approve_hours",
    entity: "employee_hours",
    entity_id: existing?.id ?? input.employee_id,
    changes: payload,
  });

  const fresh = await fetchWeeklyHours(supabase);

  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/analytics");
  return { ok: true, hours: fresh.rows, hoursCapped: fresh.capped };
}

export async function deleteEmployeeHours(id: string) {
  await requireAllowed();
  const supabase = createServerSupabase();
  const { error } = await supabase.from("employee_hours").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await writeAudit({ action: "delete", entity: "employee_hours", entity_id: id });
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/analytics");
  return { ok: true, deletedId: id };
}

// =============================================================
// Per-DAY approval of clocked hours
//
// Managers approve one day at a time. Each approval stamps the (employee, day)
// clock_events row, then the week's employee_hours rollup is recomputed as the
// SUM of approved_hours across that week's approved days — keeping the weekly
// row (which payroll/NI/analytics read) authoritative and the 20h bank/cash
// split unchanged.
// =============================================================

type ServerSupabase = ReturnType<typeof createServerSupabase>;

/** Refetch computed weekly rows + revalidate the pages that show hours. */
async function freshHoursResult(supabase: ServerSupabase) {
  const fresh = await fetchWeeklyHours(supabase);
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
  revalidatePath("/analytics");
  return { ok: true, hours: fresh.rows, hoursCapped: fresh.capped };
}

/**
 * Approve a single clocked DAY. The day's hours are recomputed server-side from
 * the clock_events row (not trusted from the client); a manager may override to
 * correct a missed clock-out.
 */
/** Nobody does more than this in one day; guards a mistyped payout. */
const MAX_DAILY_DELIVERIES = 200;

/**
 * A delivery count a manager corrected while approving. Bounded because these
 * are paid per unit: a fat-fingered 500 would quietly inflate the payout.
 * Returns undefined when the caller sent nothing (a non-driver, or no change).
 */
function normaliseDeliveryCount(
  value: number | undefined,
  label: string,
): number | undefined {
  if (value == null || value === ("" as unknown as number)) return undefined;
  const n = Number(value);
  if (isNaN(n)) throw new Error(`${label} must be a number.`);
  if (n < 0) throw new Error(`${label} can't be negative.`);
  if (!Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
  if (n > MAX_DAILY_DELIVERIES) {
    throw new Error(`${label} of ${n} looks wrong — check the count.`);
  }
  return n;
}

export async function approveDailyHours(input: {
  employee_id: string;
  event_date: string;
  override_hours?: number;
  /**
   * Manager-confirmed delivery counts for the day. These REPLACE the driver's
   * entered counts on clock_events rather than living in a parallel "approved"
   * column: payout, the Rota delivery column and Analytics all read
   * short_deliveries_count / long_deliveries_count directly, so a second
   * precedence rule would have to be honoured identically in three places.
   * Omitted for non-drivers and when the manager changed nothing.
   */
  short_deliveries?: number;
  long_deliveries?: number;
  /**
   * Deliveries beyond the normal round. Each requires a written reason — the
   * same rule `setClockDeliveries` and the Rota's `DeliveryEditModal` already
   * enforce — so approving a driver's day can never leave an extra count
   * standing with nothing explaining it.
   */
  extra_short_deliveries?: number;
  extra_short_reason?: string;
  extra_long_deliveries?: number;
  extra_long_reason?: string;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();
  if (!input.employee_id) throw new Error("Select an employee");
  if (!input.event_date) throw new Error("Date required");

  const { data: ce, error: ceErr } = await supabase
    .from("clock_events")
    .select(
      "id, clock_in_at, clock_out_at, worked_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, extra_short_reason, extra_long_reason",
    )
    .eq("employee_id", input.employee_id)
    .eq("event_date", input.event_date)
    .maybeSingle();
  if (ceErr) throw new Error(ceErr.message);
  if (!ce || !ce.clock_in_at || !ce.clock_out_at)
    throw new Error("No completed clock-in/out for this day.");

  // Summed shifts, so a day worked 09:00–13:00 and 17:00–21:00 approves at 8h
  // rather than the 12h the first-in-to-last-out span would suggest.
  const rawHours = roundHoursToMinute(dayWorkedHours(ce));
  const hasOverride =
    input.override_hours != null && !isNaN(Number(input.override_hours));
  const approvedHours = hasOverride ? Number(input.override_hours) : rawHours;
  if (approvedHours <= 0) throw new Error("Hours must be greater than 0");

  const shortIn = normaliseDeliveryCount(input.short_deliveries, "Short deliveries");
  const longIn = normaliseDeliveryCount(input.long_deliveries, "Long deliveries");
  const extraShortIn = normaliseDeliveryCount(
    input.extra_short_deliveries,
    "Extra short deliveries",
  );
  const extraLongIn = normaliseDeliveryCount(
    input.extra_long_deliveries,
    "Extra long deliveries",
  );
  // Matches every other write path (clock-out, setClockDeliveries, the Rota's
  // DeliveryEditModal): an extra count above zero must carry a reason, or a
  // paid delivery has nothing on record explaining why it was extra.
  if (extraShortIn !== undefined && extraShortIn > 0 && !input.extra_short_reason?.trim()) {
    throw new Error("Give a reason for the extra short deliveries.");
  }
  if (extraLongIn !== undefined && extraLongIn > 0 && !input.extra_long_reason?.trim()) {
    throw new Error("Give a reason for the extra long deliveries.");
  }

  const prevShort = Math.max(0, Number(ce.short_deliveries_count) || 0);
  const prevLong = Math.max(0, Number(ce.long_deliveries_count) || 0);
  const prevExtraShort = Math.max(0, Number(ce.extra_short_deliveries) || 0);
  const prevExtraLong = Math.max(0, Number(ce.extra_long_deliveries) || 0);
  const deliveriesChanged =
    (shortIn !== undefined && shortIn !== prevShort) ||
    (longIn !== undefined && longIn !== prevLong) ||
    (extraShortIn !== undefined && extraShortIn !== prevExtraShort) ||
    (extraLongIn !== undefined && extraLongIn !== prevExtraLong);

  // Delivery fields, only when the manager actually supplied a figure — a plain
  // "Approve" on a non-driver must not blank a driver-entered count. Reason
  // follows the count to null exactly like every other delivery write path: an
  // extra corrected down to zero has nothing left to explain.
  const deliveryFields = {
    ...(shortIn !== undefined ? { short_deliveries_count: shortIn } : {}),
    ...(longIn !== undefined ? { long_deliveries_count: longIn } : {}),
    ...(extraShortIn !== undefined
      ? {
          extra_short_deliveries: extraShortIn,
          extra_short_reason: extraShortIn > 0 ? input.extra_short_reason!.trim() : null,
        }
      : {}),
    ...(extraLongIn !== undefined
      ? {
          extra_long_deliveries: extraLongIn,
          extra_long_reason: extraLongIn > 0 ? input.extra_long_reason!.trim() : null,
        }
      : {}),
  };

  // A corrected count is a DAY total the manager typed, and the day may hold
  // several shifts (migration 033). Settle it across the sessions and let
  // recomputeDayHeader write the header's delivery columns, so it stays their
  // single writer. Only fall back to writing them here when the day has no
  // sessions at all (a pre-029 row).
  let deliveriesAppliedToSessions = false;
  if (deliveriesChanged) {
    deliveriesAppliedToSessions = await applyDayDeliveryTotal(supabase, ce.id, {
      short: shortIn ?? prevShort,
      long: longIn ?? prevLong,
      extraShort: extraShortIn ?? prevExtraShort,
      extraLong: extraLongIn ?? prevExtraLong,
      extraShortReason:
        (extraShortIn ?? prevExtraShort) > 0
          ? input.extra_short_reason?.trim() ?? ce.extra_short_reason ?? null
          : null,
      extraLongReason:
        (extraLongIn ?? prevExtraLong) > 0
          ? input.extra_long_reason?.trim() ?? ce.extra_long_reason ?? null
          : null,
    });
  }

  // Approval lives on the SHIFT now (migration 035), because nothing is paid
  // until it is signed off and a day can gain another shift after part of it
  // has been. Approving here means "sign off everything still outstanding on
  // this day"; the header's hours_approved / approved_hours are then derived
  // from the shifts by recomputeDayHeader, which owns them.
  const approvedShifts = await approveDaySessions(supabase, ce.id, {
    by: user.id,
    dayHours: hasOverride ? approvedHours : null,
  });

  if (approvedShifts > 0 || deliveriesAppliedToSessions) {
    await recomputeDayHeader(supabase, ce.id);
  }

  // A pre-029 day has no shifts to carry the approval, so its header still is
  // the record. Everything else has just been derived and must not be
  // hand-written over the top.
  if (approvedShifts === 0 && !deliveriesAppliedToSessions) {
    const { error: upErr } = await supabase
      .from("clock_events")
      .update({
        hours_approved: true,
        approved_hours: approvedHours,
        approved_short_deliveries_count: shortIn ?? prevShort,
        approved_long_deliveries_count: longIn ?? prevLong,
        approved_extra_short_deliveries: extraShortIn ?? prevExtraShort,
        approved_extra_long_deliveries: extraLongIn ?? prevExtraLong,
        approved_session_count: 1,
        ...deliveryFields,
      })
      .eq("id", ce.id);
    if (upErr) throw new Error(upErr.message);
  }

  const { error: stampErr } = await supabase
    .from("clock_events")
    .update({
      hours_approved_by: user.id,
      hours_approved_at: new Date().toISOString(),
    })
    .eq("id", ce.id);
  if (stampErr) throw new Error(stampErr.message);

  const rate = await employeeNiRate(supabase, input.employee_id);
  const weekStart = toISODate(startOfISOWeek(parseISODate(input.event_date)));
  await rollupApprovedWeek(supabase, input.employee_id, weekStart, rate, user.id);

  await writeAudit({
    action: "approve_daily_hours",
    entity: "clock_events",
    entity_id: ce.id,
    changes: {
      employee_id: input.employee_id,
      event_date: input.event_date,
      approved_hours: approvedHours,
      // The driver's original figures are only recoverable from here once the
      // manager's correction has replaced them in place.
      ...(deliveriesChanged
        ? {
            deliveries_corrected: {
              short: { from: prevShort, to: shortIn ?? prevShort },
              long: { from: prevLong, to: longIn ?? prevLong },
              extra_short: { from: prevExtraShort, to: extraShortIn ?? prevExtraShort },
              extra_long: { from: prevExtraLong, to: extraLongIn ?? prevExtraLong },
            },
          }
        : {}),
    },
  });

  // Approving is now what PUTS the day on the Tuesday sheet (migration 035), so
  // the payout has to be refreshed every time, not only when a count changed.
  // freshHoursResult covers the employees + analytics screens; the rest show
  // hours or drops and would otherwise sit stale.
  revalidateApprovalPaths();

  return freshHoursResult(supabase);
}

/**
 * Every screen whose numbers move when a day is signed off or withdrawn. A
 * missing path here reads as a stale screen, and on the payout that means a
 * wage sheet showing money that is no longer approved (Update 66).
 */
function revalidateApprovalPaths() {
  revalidatePath("/rota");
  revalidatePath("/manager/rota");
  revalidatePath("/live");
  revalidatePath("/manager/live");
  revalidatePath("/cash-flow/payout");
  revalidatePath("/manager/cash-flow/payout");
  revalidatePath("/employees");
  revalidatePath("/manager/employees");
}

/** Revert a day's approval and recompute the week's rollup. */
export async function unapproveDailyHours(input: {
  employee_id: string;
  event_date: string;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();
  if (!input.employee_id) throw new Error("Select an employee");
  if (!input.event_date) throw new Error("Date required");

  const { data: ce } = await supabase
    .from("clock_events")
    .select("id")
    .eq("employee_id", input.employee_id)
    .eq("event_date", input.event_date)
    .maybeSingle();
  if (!ce) throw new Error("Clock record not found.");

  // Withdraw every shift's sign-off, then let the header re-derive. Undoing a
  // whole day is the blunt instrument; unapproveShift takes back ONE shift and
  // leaves the rest of the day paid.
  const withdrawn = await unapproveDaySessions(supabase, ce.id, user.id);
  if (withdrawn > 0) {
    await recomputeDayHeader(supabase, ce.id);
  } else {
    // Pre-029 day: no shifts, so the header carries the approval itself.
    const { error: upErr } = await supabase
      .from("clock_events")
      .update({
        hours_approved: false,
        approved_hours: null,
        approved_short_deliveries_count: null,
        approved_long_deliveries_count: null,
        approved_extra_short_deliveries: 0,
        approved_extra_long_deliveries: 0,
        approved_session_count: 0,
      })
      .eq("id", ce.id);
    if (upErr) throw new Error(upErr.message);
  }

  const { error: stampErr } = await supabase
    .from("clock_events")
    .update({ hours_approved_by: null, hours_approved_at: null })
    .eq("id", ce.id);
  if (stampErr) throw new Error(stampErr.message);

  const rate = await employeeNiRate(supabase, input.employee_id);
  const weekStart = toISODate(startOfISOWeek(parseISODate(input.event_date)));
  await rollupApprovedWeek(supabase, input.employee_id, weekStart, rate, user.id);

  await writeAudit({
    action: "unapprove_daily_hours",
    entity: "clock_events",
    entity_id: ce.id,
    changes: { ...input, shifts_withdrawn: withdrawn },
  });

  revalidateApprovalPaths();

  return freshHoursResult(supabase);
}

/**
 * Sign off, or withdraw, ONE shift of a day.
 *
 * This is what makes the accumulate/undo behaviour work: a day whose morning
 * shift is approved at 3 drops and whose evening shift is then approved at 1
 * pays 4; withdrawing the evening shift alone returns the day to 3 rather than
 * dropping it to nothing. Approving or undoing the whole day is the same thing
 * applied to every shift at once.
 */
export async function setShiftApproval(input: {
  session_id: string;
  approved: boolean;
  /** Corrected hours for this shift only. Ignored when withdrawing. */
  override_hours?: number;
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();
  if (!input.session_id) throw new Error("Shift not identified.");

  const { data: session, error: sErr } = await supabase
    .from("clock_sessions")
    .select("id, clock_event_id, employee_id, event_date, clock_in_at, clock_out_at")
    .eq("id", input.session_id)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (!session) throw new Error("That shift no longer exists.");
  if (input.approved && !session.clock_out_at) {
    throw new Error("That shift is still open — it can be approved once it ends.");
  }

  let approvedHours: number | null = null;
  if (input.approved && input.override_hours != null) {
    const h = Number(input.override_hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24) {
      throw new Error("Hours must be between 0 and 24.");
    }
    approvedHours = roundHoursToMinute(h);
  }

  await setSessionApproval(supabase, session.id, {
    approved: input.approved,
    approvedHours,
    by: user.id,
  });
  await recomputeDayHeader(supabase, session.clock_event_id);

  const rate = await employeeNiRate(supabase, session.employee_id);
  const weekStart = toISODate(startOfISOWeek(parseISODate(session.event_date)));
  await rollupApprovedWeek(supabase, session.employee_id, weekStart, rate, user.id);

  await writeAudit({
    action: input.approved ? "approve_shift" : "unapprove_shift",
    entity: "clock_sessions",
    entity_id: session.id,
    changes: {
      employee_id: session.employee_id,
      event_date: session.event_date,
      ...(approvedHours != null ? { approved_hours: approvedHours } : {}),
    },
  });

  revalidateApprovalPaths();

  return freshHoursResult(supabase);
}

/**
 * Approve every not-yet-approved clocked day on a given date for the supplied
 * employees (the rows a manager currently sees). One click clears a whole day.
 */
export async function approveDailyHoursForDate(input: {
  event_date: string;
  employee_ids: string[];
}) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();
  if (!input.event_date) throw new Error("Date required");
  const ids = Array.from(new Set((input.employee_ids ?? []).filter(Boolean)));
  if (ids.length === 0) return freshHoursResult(supabase);

  const { data: events } = await supabase
    .from("clock_events")
    .select(
      "id, employee_id, clock_in_at, clock_out_at, worked_hours, hours_approved, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries",
    )
    .eq("event_date", input.event_date)
    .in("employee_id", ids);

  const nowIso = new Date().toISOString();
  const affected = new Set<string>();
  for (const e of events ?? []) {
    // A null clock_out_at also means "a shift is still open", so anyone mid-way
    // through a split day is skipped rather than approved at half their hours.
    if (!e.clock_in_at || !e.clock_out_at) continue;
    const rawHours = roundHoursToMinute(dayWorkedHours(e));
    if (rawHours <= 0) continue;

    // No day total is passed: a bulk approve confirms what was clocked, so each
    // shift keeps its own duration rather than a share of one typed figure.
    const approvedShifts = await approveDaySessions(supabase, e.id, { by: user.id });

    // Re-derive even when nothing was pending. A day can read approved while
    // its header still disagrees with its shifts — migration 035's backfill
    // seeded exactly that on days whose deliveries had never reached the
    // sessions — and skipping on hours_approved alone left no screen able to
    // heal it (Update 94). A day already in step recomputes to itself.
    const derived = await recomputeDayHeader(supabase, e.id);

    // A pre-029 day has no shifts to carry the approval, so its header still is
    // the record and has to be written by hand.
    if (derived.sessionCount === 0) {
      if (e.hours_approved) continue;
      const { error } = await supabase
        .from("clock_events")
        .update({
          hours_approved: true,
          approved_hours: rawHours,
          approved_short_deliveries_count: e.short_deliveries_count,
          approved_long_deliveries_count: e.long_deliveries_count,
          approved_extra_short_deliveries: Number(e.extra_short_deliveries) || 0,
          approved_extra_long_deliveries: Number(e.extra_long_deliveries) || 0,
          approved_session_count: 1,
        })
        .eq("id", e.id);
      if (error) throw new Error(error.message);
    }

    // Only stamp when this call is what signed the day off. A heal must leave
    // the manager who originally approved it on the record.
    if (approvedShifts > 0 || derived.sessionCount === 0) {
      const { error: stampErr } = await supabase
        .from("clock_events")
        .update({ hours_approved_by: user.id, hours_approved_at: nowIso })
        .eq("id", e.id);
      if (stampErr) throw new Error(stampErr.message);
    }
    affected.add(e.employee_id);
  }

  const weekStart = toISODate(startOfISOWeek(parseISODate(input.event_date)));
  for (const empId of affected) {
    const rate = await employeeNiRate(supabase, empId);
    await rollupApprovedWeek(supabase, empId, weekStart, rate, user.id);
  }

  await writeAudit({
    action: "approve_daily_hours_bulk",
    entity: "clock_events",
    entity_id: input.event_date,
    changes: { event_date: input.event_date, approved: affected.size },
  });

  revalidateApprovalPaths();

  return freshHoursResult(supabase);
}
