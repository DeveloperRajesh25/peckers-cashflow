"use server";

// =============================================================
// Early clock-in, authorised by a manager over the phone (migration 043).
//
// An employee booked at 17:00 who is standing near the store can clock in at
// 16:30 and be paid for the extra half hour. Managers do sometimes ASK someone
// to start early, so this is an authorisation, not a block: the clock-in is
// refused until they type a 4-digit code the manager reads out from the Live
// board.
//
// TWO STEPS, because a phone call outlives a location fix. MAX_FIX_AGE_MS is
// 120s and geofence-verify refuses anything older (Update 106), so holding the
// original fix through the call and submitting it afterwards cannot work. The
// location verdict therefore happens in step 1:
//
//   requestEarlyClockInOtp  full detectStoreForLocation against a FRESH fix.
//                           The verified store and its coordinates are stored
//                           on the request row.
//   clockInWithEarlyOtp     no location at all. The store was already verified;
//                           the OTP is the authorisation and its TTL bounds how
//                           stale that verification can be.
//
// The employee's own session can never read early_clock_in_requests (RLS is
// staff-only, and the code is the whole point), so every write here goes
// through the service-role client and fails closed when it is unavailable.
// =============================================================

import { randomInt, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase-server";
import { createAdminClient, isProvisioningConfigured } from "@/lib/supabase-admin";
import { writeAudit } from "./audit";
import { detectStoreForLocation } from "@/lib/geofence-verify";
import { findOpenSession, hasSessionOnDate } from "@/lib/clock-sessions";
import {
  asResult,
  findShiftForClockIn,
  getEmployeeForUser,
  londonNowMinutes,
  performClockIn,
  requireAllowed,
} from "@/lib/clock-core";
import {
  bookableStartMinutes,
  EARLY_OTP_MAX_ATTEMPTS,
  EARLY_OTP_TTL_MS,
  isEarlyClockIn,
  minutesEarly,
} from "@/lib/early-clock-in";
import { timeToMinutes, todayISO } from "@/lib/utils";
import { resolveActiveStoreId, type ActionResult } from "@/lib/types";

/**
 * Unlike revokeApprovalForAddedShift, this is NOT best-effort. Without the
 * service role there is no way to issue or check a code, and quietly letting
 * the clock-in through would remove the gate entirely.
 */
const NOT_CONFIGURED =
  "Early clock-in approval isn't set up on this server. Ask your manager to record your clock-in for you.";

/**
 * Same boundary as `asResult`, for the actions that must return data as well as
 * a verdict: Next.js masks messages thrown from server actions in production,
 * so a validation error has to be a returned value or the employee sees a 500.
 */
async function asDataResult<T extends object>(
  run: () => Promise<T>,
): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await run()) };
  } catch (err) {
    console.error("[early-clock-in] action failed:", err);
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Something went wrong. Please try again.";
    return { ok: false, error: message };
  }
}

/**
 * 4 digits, 1000–9999. crypto.randomInt rather than Math.random: this code is
 * the only thing between an employee and half an hour of unearned pay, and
 * Math.random is both predictable and seeded per process.
 */
function generateOtp(): string {
  return String(randomInt(1000, 10000));
}

/** How many times to reroll a code that collides with another live one. */
const OTP_COLLISION_RETRIES = 10;

/**
 * A code that is unique among the PENDING rows.
 *
 * Not a security property — validation is keyed to the caller's own pending
 * row, so a duplicate could never cross-grant. It is so the manager's screen is
 * never ambiguous: two people waiting on the same four digits is a call nobody
 * can answer correctly.
 */
async function uniqueOtp(admin: ReturnType<typeof createAdminClient>): Promise<string> {
  for (let i = 0; i < OTP_COLLISION_RETRIES; i++) {
    const code = generateOtp();
    const { data } = await admin
      .from("early_clock_in_requests")
      .select("id")
      .eq("otp_code", code)
      .eq("status", "pending")
      .limit(1);
    if ((data ?? []).length === 0) return code;
  }
  return generateOtp();
}

/** Constant-time compare on equal-length buffers. */
function codesMatch(submitted: string, stored: string): boolean {
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function revalidateLivePaths() {
  revalidatePath("/live");
  revalidatePath("/manager/live");
}

type RequestOtpInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
  fix_age_ms: number | null;
};

/**
 * Ask for a code. Runs the SAME preflight as an ordinary clock-in, in the same
 * order, so anything that would refuse the clock-in refuses here too — being
 * out of range, not being active, already being clocked in — rather than
 * issuing a code that could never be spent.
 *
 * Returns `otp_required: false` when the clock-in turns out not to be early at
 * all; the client falls straight through to the normal `clockIn()`.
 */
export async function requestEarlyClockInOtp(input: RequestOtpInput) {
  return asDataResult(() => runRequestEarlyClockInOtp(input));
}

async function runRequestEarlyClockInOtp(input: RequestOtpInput) {
  const user = await requireAllowed();
  const supabase = createServerSupabase();

  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");
  if (employee.employment_status === "left" || employee.employment_status === "inactive") {
    throw new Error("Your account is not active.");
  }

  // The one and only geofence check of this flow — a fresh fix, judged now,
  // exactly as performClockIn would judge it. Consuming the code takes no
  // location, so this verdict is what the shift is recorded against.
  const detected = await detectStoreForLocation(
    supabase,
    {
      lat: input.latitude,
      lng: input.longitude,
      accuracy: input.accuracy,
      ageMs: input.fix_age_ms,
    },
    { actorEmail: user.email, employeeId: employee.id, action: "clock_in" },
  );

  const today = todayISO();

  const open = await findOpenSession(supabase, employee.id);
  if (open) {
    throw new Error(
      open.event_date === today
        ? "You're already clocked in. Clock out before starting another shift."
        : `You're still clocked in from ${open.event_date}. Clock out of that shift first.`,
    );
  }

  const shift = await findShiftForClockIn(supabase, employee.id, today);
  const scheduledStartMinutes = bookableStartMinutes(shift);
  const nowMinutes = londonNowMinutes();
  const early =
    scheduledStartMinutes != null &&
    isEarlyClockIn({
      nowMinutes,
      scheduledStartMinutes,
      hasSessionToday: await hasSessionOnDate(supabase, employee.id, today),
    });
  if (!early) return { otp_required: false as const };

  if (!isProvisioningConfigured()) throw new Error(NOT_CONFIGURED);
  const admin = createAdminClient();

  // A second attempt REPLACES the first rather than stacking another code on
  // the manager's screen. The partial unique index enforces it too.
  await admin
    .from("early_clock_in_requests")
    .update({ status: "cancelled" })
    .eq("employee_id", employee.id)
    .eq("status", "pending");

  const { data: created, error } = await admin
    .from("early_clock_in_requests")
    .insert({
      employee_id: employee.id,
      store_id: detected.id,
      event_date: today,
      shift_id: shift?.id ?? null,
      scheduled_start: shift?.start_time ?? null,
      otp_code: await uniqueOtp(admin),
      expires_at: new Date(Date.now() + EARLY_OTP_TTL_MS).toISOString(),
      requested_lat: input.latitude,
      requested_lng: input.longitude,
      requested_accuracy_m: input.accuracy ?? null,
    })
    .select("id, expires_at, scheduled_start")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!created) throw new Error("Could not request a code. Please try again.");

  // Never the code itself — the audit log is readable by more people than the
  // Live board, and a spent code in it is a spent code someone can look up.
  await writeAudit({
    action: "early_clock_in_otp_requested",
    entity: "early_clock_in_request",
    entity_id: created.id,
    changes: {
      employee_id: employee.id,
      employee_name: employee.name,
      event_date: today,
      store_id: detected.id,
      store_name: detected.name,
      scheduled_start: shift?.start_time ?? null,
      minutes_early: minutesEarly(nowMinutes, scheduledStartMinutes!),
    },
  });

  revalidateLivePaths();

  return {
    otp_required: true as const,
    request_id: created.id as string,
    expires_at: created.expires_at as string,
    scheduled_start: (created.scheduled_start as string | null) ?? null,
    store_name: detected.name,
  };
}

/**
 * What the waiting employee's screen polls. Deliberately never selects
 * `otp_code`: this payload is the one thing that reaches the person the code is
 * gating.
 */
export async function getEarlyClockInStatus() {
  return asDataResult(() => runGetEarlyClockInStatus());
}

async function runGetEarlyClockInStatus() {
  const user = await requireAllowed();
  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");

  if (!isProvisioningConfigured()) throw new Error(NOT_CONFIGURED);
  const admin = createAdminClient();

  // Expire lazily on read. A 20-minute TTL does not justify a cron, and the
  // screen that cares is the one asking.
  await admin
    .from("early_clock_in_requests")
    .update({ status: "expired" })
    .eq("employee_id", employee.id)
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString());

  const { data } = await admin
    .from("early_clock_in_requests")
    .select("id, status, expires_at, scheduled_start")
    .eq("employee_id", employee.id)
    .eq("event_date", todayISO())
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    request_id: (data?.id as string | undefined) ?? null,
    status: (data?.status as string | undefined) ?? null,
    expires_at: (data?.expires_at as string | undefined) ?? null,
    scheduled_start: (data?.scheduled_start as string | undefined) ?? null,
  };
}

/**
 * Spend the code. Takes NO location: the store was verified when the code was
 * issued, and re-checking here would refuse the fix that has been sitting
 * through the phone call — which is the problem this design exists to solve.
 */
export async function clockInWithEarlyOtp(input: { otp: string }): Promise<ActionResult> {
  return asResult(() => runClockInWithEarlyOtp(input));
}

async function runClockInWithEarlyOtp(input: { otp: string }) {
  const user = await requireAllowed();
  const employee = await getEmployeeForUser(user.id, user.email);
  if (!employee) throw new Error("Your account is not linked to a crew profile.");

  const submitted = (input.otp ?? "").trim();
  if (!/^\d{4}$/.test(submitted)) {
    throw new Error("Enter the 4-digit code your manager gave you.");
  }

  if (!isProvisioningConfigured()) throw new Error(NOT_CONFIGURED);
  const admin = createAdminClient();

  // Keyed to THIS employee's own pending row, which is what makes a code
  // collision harmless: another person's digits match nothing here.
  const { data: request } = await admin
    .from("early_clock_in_requests")
    .select("*")
    .eq("employee_id", employee.id)
    .eq("status", "pending")
    .maybeSingle();
  if (!request) {
    throw new Error("No early clock-in is waiting. Ask your manager for a new code.");
  }

  if (new Date(request.expires_at).getTime() <= Date.now()) {
    await admin
      .from("early_clock_in_requests")
      .update({ status: "expired" })
      .eq("id", request.id);
    throw new Error("That code has expired. Ask your manager for a new one.");
  }

  const attempts = Number(request.attempts) || 0;
  if (attempts >= EARLY_OTP_MAX_ATTEMPTS) {
    await admin
      .from("early_clock_in_requests")
      .update({ status: "locked" })
      .eq("id", request.id);
    throw new Error("Too many wrong codes. Ask your manager for a new one.");
  }

  if (!codesMatch(submitted, String(request.otp_code))) {
    const used = attempts + 1;
    const locked = used >= EARLY_OTP_MAX_ATTEMPTS;
    await admin
      .from("early_clock_in_requests")
      .update({ attempts: used, ...(locked ? { status: "locked" } : {}) })
      .eq("id", request.id);
    throw new Error(
      locked
        ? "Too many wrong codes. Ask your manager for a new one."
        : `That code isn't right — ${EARLY_OTP_MAX_ATTEMPTS - used} ${EARLY_OTP_MAX_ATTEMPTS - used === 1 ? "try" : "tries"} left.`,
    );
  }

  // From here it is an ORDINARY clock-in: same header upsert, same session, same
  // recomputeDayHeader, same rota stamp, same revalidation. Nothing downstream
  // can tell it apart, which is the point — approval and the Tuesday sheet must
  // treat it exactly like any other shift.
  const outcome = await performClockIn({
    kind: "preauthorised",
    storeId: request.store_id,
    latitude: Number(request.requested_lat),
    longitude: Number(request.requested_lng),
    requestId: request.id,
  });

  await admin
    .from("early_clock_in_requests")
    .update({
      status: "used",
      consumed_at: new Date().toISOString(),
      clock_event_id: outcome.clockEventId,
      actual_clock_in_at: outcome.clockInAt,
    })
    .eq("id", request.id);

  await writeAudit({
    action: "early_clock_in_otp_used",
    entity: "early_clock_in_request",
    entity_id: request.id,
    changes: {
      employee_id: employee.id,
      employee_name: employee.name,
      event_date: request.event_date,
      store_id: request.store_id,
      scheduled_start: request.scheduled_start,
      minutes_early: request.scheduled_start
        ? minutesEarly(londonNowMinutes(), timeToMinutes(request.scheduled_start))
        : null,
    },
  });

  revalidateLivePaths();
}

/**
 * The manager denies a request from the Live board, or the employee backs out
 * of their own. Either way the code stops working immediately.
 */
export async function cancelEarlyClockInRequest(input: {
  requestId: string;
}): Promise<ActionResult> {
  return asResult(() => runCancelEarlyClockInRequest(input));
}

async function runCancelEarlyClockInRequest(input: { requestId: string }) {
  const user = await requireAllowed();
  if (!input.requestId) throw new Error("No request to cancel.");

  if (!isProvisioningConfigured()) throw new Error(NOT_CONFIGURED);
  const admin = createAdminClient();

  const { data: request } = await admin
    .from("early_clock_in_requests")
    .select("id, employee_id, store_id, status, event_date, scheduled_start")
    .eq("id", input.requestId)
    .maybeSingle();
  if (!request) throw new Error("That request no longer exists.");
  // Already used, expired or cancelled — nothing to withdraw, and re-cancelling
  // a spent code must not restate a clock-in that already happened.
  if (request.status !== "pending") return;

  const role = user.allowed!.role;
  if (role === "manager") {
    // resolveActiveStoreId, never allowed.store_id: a manager covering the other
    // store is answering that store's phone.
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (request.store_id !== activeStore) {
      throw new Error("You can only manage early clock-ins for the store you're running.");
    }
  } else if (role !== "admin") {
    const employee = await getEmployeeForUser(user.id, user.email);
    if (!employee || employee.id !== request.employee_id) {
      throw new Error("Not authorised");
    }
  }

  await admin
    .from("early_clock_in_requests")
    .update({ status: "cancelled", cancelled_by: user.id })
    .eq("id", request.id)
    .eq("status", "pending");

  await writeAudit({
    action: "early_clock_in_otp_cancelled",
    entity: "early_clock_in_request",
    entity_id: request.id,
    changes: {
      employee_id: request.employee_id,
      event_date: request.event_date,
      scheduled_start: request.scheduled_start,
      by: user.email,
      by_role: role,
    },
  });

  revalidateLivePaths();
}
