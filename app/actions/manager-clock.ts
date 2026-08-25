"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { detectStoreForLocation, verifyGeofenceForClockOut } from "@/lib/geofence-verify";
import {
  MAX_AUTO_SHIFT_HOURS,
  londonWallClockToUtc,
  resolveManualClockOut,
} from "@/lib/auto-clock-out";
import { formatDDMMYYYY, londonHHMM, timeToMinutes, todayISO } from "@/lib/utils";
import { resolveActiveStoreId, type ActionResult } from "@/lib/types";
import {
  addManagerSession,
  adoptManagerHeaderIntoSession,
  applyManagerDayDeliveryTotal,
  approveManagerDaySessions,
  closeManagerSession,
  findDeliveriesOnlySession,
  findOpenManagerSession,
  insertDeliveriesOnlySession,
  managerSessionsForEvent,
  openManagerSession,
  recomputeManagerDayHeader,
  setManagerSessionDeliveries,
  unapproveManagerDaySessions,
} from "@/lib/manager-clock-sessions";
import {
  normaliseDeliveryInput,
  overlapsExistingSession,
  type DeliveryInput,
} from "@/lib/clock-sessions";
import { writeAudit } from "./audit";

/**
 * Same boundary as app/actions/clock.ts: return user-facing errors instead of
 * throwing, because Next.js masks thrown messages in production builds.
 */
async function asResult(run: () => Promise<void>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    console.error("[manager-clock] action failed:", err);
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Something went wrong. Please try again.";
    return { ok: false, error: message };
  }
}

// Managers clock in/out for MONITORING only — it never touches their fixed
// salary. Managers are login accounts (allowed_users), not employees, so their
// attendance lives in manager_clock_events keyed on the login account id.
//
// A day can hold SEVERAL shifts (migration 031): open up, go home, come back
// for the evening. manager_clock_events stays one row per day — the header —
// and each in/out pair is a manager_clock_sessions row beneath it. See
// lib/manager-clock-sessions.ts.

async function requireManager() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "manager") {
    throw new Error("Only managers can clock in or out here.");
  }
  return user;
}

type ClockInput = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  /** Age of the fix in ms — see ReportedFix. Stale positions are refused. */
  fix_age_ms: number | null;
};

/**
 * Clock-out additionally carries the drops the manager covered during THAT
 * SHIFT (migration 034). Omitted entirely when they answered "no deliveries",
 * which leaves the session's counts untouched rather than stamping zeros —
 * null and 0 mean different things to the approval screen.
 */
type ManagerClockOutInput = ClockInput & { deliveries?: DeliveryInput | null };

/** Every screen that shows a manager's drops or the money they turn into. */
function revalidateManagerClockPaths() {
  for (const p of [
    "/manager/live",
    "/live",
    "/rota",
    "/manager/rota",
    "/employees",
    "/manager/employees",
    "/cash-flow/payout",
    "/manager/cash-flow/payout",
  ]) {
    revalidatePath(p);
  }
}

export async function managerClockIn(input: ClockInput): Promise<ActionResult> {
  return asResult(() => performManagerClockIn(input));
}

async function performManagerClockIn(input: ClockInput) {
  const user = await requireManager();
  const supabase = createServerSupabase();
  const managerId = user.allowed!.id;
  const storeId = resolveActiveStoreId(user.allowed);
  if (!storeId) throw new Error("You're not assigned to a store yet.");

  // Detect which store the manager is physically standing in. This enforces the
  // geofence AND powers the "wrong store" nudge: a manager can only clock in at
  // the store their app is currently switched to. If they're at a DIFFERENT
  // store, we tell them to switch there first (matching the crew clock, which
  // attributes each shift to the store actually worked).
  const detected = await detectStoreForLocation(
    supabase,
    {
      lat: input.latitude,
      lng: input.longitude,
      accuracy: input.accuracy,
      ageMs: input.fix_age_ms,
    },
    { actorEmail: user.email, managerId, action: "clock_in" },
  );
  if (detected.id !== storeId) {
    throw new Error(
      `You're at ${detected.name}, but your app is set to a different store. Switch to ${detected.name} to clock in here.`,
    );
  }

  const today = todayISO();

  // The only thing that blocks a clock-in is ALREADY BEING CLOCKED IN. A day can
  // hold several shifts, so "you've already clocked in today" is no longer a
  // reason to refuse. The open session is looked up across every date, not just
  // today, because a shift opened at 22:00 and still running belongs to
  // yesterday.
  const open = await findOpenManagerSession(supabase, managerId);
  if (open) {
    throw new Error(
      open.event_date === today
        ? "You're already clocked in. Clock out before starting another shift."
        : `You're still clocked in from ${open.event_date}. Clock out of that shift first.`,
    );
  }

  const { data: existing } = await supabase
    .from("manager_clock_events")
    .select("*")
    .eq("manager_id", managerId)
    .eq("event_date", today)
    .maybeSingle();

  const now = new Date().toISOString();

  // One header row per day, unchanged (unique on manager_id + event_date). It
  // carries the day's store; the shift itself goes in manager_clock_sessions.
  let clockEventId = existing?.id as string | undefined;
  if (existing) {
    // A day already carrying a shift keeps the store it started at; only a
    // fresh row takes the store just detected.
    if (!existing.clock_in_at) {
      const { error } = await supabase
        .from("manager_clock_events")
        .update({ store_id: storeId })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    }
  } else {
    const { data: created, error } = await supabase
      .from("manager_clock_events")
      .insert({
        manager_id: managerId,
        store_id: storeId,
        event_date: today,
        clock_in_at: now,
        clock_in_lat: input.latitude,
        clock_in_lng: input.longitude,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    clockEventId = created?.id;
  }
  if (!clockEventId) throw new Error("Could not record the clock-in. Please try again.");

  // A pre-031 day may have a clock-in on the header but no session to sit
  // beside. Adopt it so the day's shifts are complete before adding this one.
  if (existing?.clock_in_at) {
    await adoptManagerHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      manager_id: managerId,
      store_id: existing.store_id,
      event_date: today,
    });
  }

  await openManagerSession(supabase, {
    clockEventId,
    managerId,
    storeId,
    eventDate: today,
    clockInAt: now,
    lat: input.latitude,
    lng: input.longitude,
  });

  await recomputeManagerDayHeader(supabase, clockEventId);

  await writeAudit({
    action: "manager_clock_in",
    entity: "manager_clock_event",
    entity_id: managerId,
    changes: { date: today, location: [input.latitude, input.longitude] },
  });

  revalidateManagerClockPaths();
}

export async function managerClockOut(input: ManagerClockOutInput): Promise<ActionResult> {
  return asResult(() => performManagerClockOut(input));
}

async function performManagerClockOut(input: ManagerClockOutInput) {
  const user = await requireManager();
  const supabase = createServerSupabase();
  const managerId = user.allowed!.id;

  // Resolve the shift being closed from the OPEN SESSION, not from today's
  // date: a shift that started at 22:00 and runs past midnight is clocked out
  // on the following calendar day but belongs to the day it opened on.
  let session = await findOpenManagerSession(supabase, managerId);

  const today = todayISO();
  const { data: existing } = await supabase
    .from("manager_clock_events")
    .select("*")
    .eq("manager_id", managerId)
    .eq("event_date", session?.event_date ?? today)
    .maybeSingle();

  if (!existing?.clock_in_at) throw new Error("You haven't clocked in yet today.");
  if (!session) {
    if (existing.clock_out_at) throw new Error("You've already clocked out today.");
    // Clocked in under the pre-031 build, clocking out after the deploy: the
    // header has the shift but no session row. Adopt it, then close it.
    session = await adoptManagerHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      manager_id: managerId,
      store_id: existing.store_id,
      event_date: existing.event_date,
    });
    if (!session) throw new Error("You haven't clocked in yet today.");
  }

  // Clock out from the store they clocked IN at (recorded on the session) — the
  // shift stays attributed there whatever store they switched to since. Being at
  // ANOTHER store still signs the shift off, because a manager who moved sites
  // must not be stranded clocked in (see verifyGeofenceForClockOut).
  const clockedStoreId = session.store_id ?? existing.store_id;
  if (!clockedStoreId) throw new Error("Your clock-in has no store on record. Contact your admin.");

  await verifyGeofenceForClockOut(
    supabase,
    clockedStoreId,
    {
      lat: input.latitude,
      lng: input.longitude,
      accuracy: input.accuracy,
      ageMs: input.fix_age_ms,
    },
    { actorEmail: user.email, managerId, action: "clock_out" },
  );

  // Validated BEFORE the session is closed: a rejected count must not leave the
  // manager clocked out with their drops lost.
  const deliveries = normaliseDeliveryInput(input.deliveries);

  const now = new Date().toISOString();
  const closedOk = await closeManagerSession(supabase, session.id, {
    clockOutAt: now,
    lat: input.latitude,
    lng: input.longitude,
    // Per SHIFT, not per day — the same rule migration 033 established for
    // drivers. A manager who did drops on both the lunch and evening shifts has
    // them summed onto the day, not overwritten by the later clock-out.
    deliveries,
  });
  if (!closedOk) throw new Error("You've already clocked out of that shift.");

  // Header last: first-in / last-out / summed hours AND summed drops all come
  // from the sessions.
  const { workedHours, deliveries: dayDrops } = await recomputeManagerDayHeader(
    supabase,
    existing.id,
  );

  await writeAudit({
    action: "manager_clock_out",
    entity: "manager_clock_event",
    entity_id: managerId,
    changes: {
      date: session.event_date,
      session_seq: session.seq,
      worked_hours: workedHours,
      location: [input.latitude, input.longitude],
      ...(deliveries
        ? {
            shift_deliveries: {
              short: deliveries.short,
              long: deliveries.long,
              extra_short: deliveries.extraShort,
              extra_long: deliveries.extraLong,
            },
            day_deliveries: { short: dayDrops.short, long: dayDrops.long },
          }
        : {}),
    },
  });

  revalidateManagerClockPaths();
}

// =============================================================
// Manager-entered deliveries for a day the manager never clocked (migration 037)
//
// The third missed-entry path on Daily Approval, beside the employee and cover
// driver ones. Deliberately NOT a manual clock-in: a manager's fixed daily wage
// turns on merely having clocked in, so inventing times would overstate the
// wage bill on the Live board and mark them present on the Rota for a day they
// weren't there. Only the drops are recorded — which is all a manager is ever
// paid for through this app.
//
// The counts go on a DELIVERIES-ONLY session, never straight onto the day
// header: header-only counts are what Update 94 had to repair, because the next
// recompute derives the header from its shifts and erases them.
// =============================================================

/** Above this, a missed-entry submission is a typo rather than a round. */
const MAX_MANUAL_MANAGER_DROPS = 150;

export type ManualManagerDeliveryInput = {
  manager_id: string;
  /** YYYY-MM-DD. Never in the future — the day has to have happened. */
  event_date: string;
  deliveries: DeliveryInput;
  reason: string;
};

export async function upsertManualManagerDeliveryEntry(
  input: ManualManagerDeliveryInput,
): Promise<ActionResult> {
  return asResult(() => performManualManagerDeliveryEntry(input));
}

async function performManualManagerDeliveryEntry(input: ManualManagerDeliveryInput) {
  // Role gate first — a non-staff caller must not get as far as reading a row.
  const user = await requireApprover();
  const supabase = createServerSupabase();

  if (!input.manager_id) throw new Error("Select a manager");
  if (!input.event_date) throw new Error("Date is required");
  if (!input.reason?.trim()) {
    throw new Error("Give a reason — this records deliveries with no clock record.");
  }
  if (input.event_date > todayISO()) {
    throw new Error("That date hasn't happened yet.");
  }

  const deliveries = normaliseDeliveryInput(input.deliveries);
  if (!deliveries) throw new Error("Enter the deliveries this manager covered.");
  const total =
    (deliveries.short ?? 0) +
    (deliveries.long ?? 0) +
    deliveries.extraShort +
    deliveries.extraLong;
  if (total <= 0) {
    // A day of nothing has nothing to approve and nothing to pay — it would
    // create a row that never appears on any screen.
    throw new Error("Enter at least one delivery.");
  }
  if (total > MAX_MANUAL_MANAGER_DROPS) {
    throw new Error(`${total} deliveries in one day looks wrong — check the counts.`);
  }

  const { data: manager } = await supabase
    .from("allowed_users")
    .select("id, name, role, store_id")
    .eq("id", input.manager_id)
    .maybeSingle();
  if (!manager) throw new Error("Manager not found.");
  if (manager.role !== "manager") throw new Error("That account isn't a manager.");

  const { data: existing } = await supabase
    .from("manager_clock_events")
    .select("*")
    .eq("manager_id", input.manager_id)
    .eq("event_date", input.event_date)
    .maybeSingle();

  // Attributed to the store the caller is running — that is where the drops
  // were covered. An admin falls back to the day's own store, then the
  // manager's home store.
  const storeId =
    user.allowed!.role === "manager"
      ? resolveActiveStoreId(user.allowed)
      : existing?.store_id ?? manager.store_id;
  if (!storeId) throw new Error("No store to record these deliveries against.");
  if (
    user.allowed!.role === "manager" &&
    existing?.store_id &&
    existing.store_id !== storeId
  ) {
    throw new Error("That day was clocked at another store — record it from there.");
  }

  const now = new Date();
  const manualStamp = {
    by: user.id,
    at: now.toISOString(),
    reason: input.reason.trim(),
  };

  let clockEventId = existing?.id as string | undefined;
  if (!existing) {
    const { data: created, error } = await supabase
      .from("manager_clock_events")
      .insert({
        manager_id: input.manager_id,
        store_id: storeId,
        event_date: input.event_date,
        // Deliberately null: the manager was never here, and clock_in_at is
        // what the Live board reads to count their daily wage.
        clock_in_at: null,
        clock_out_at: null,
        manual_entry: true,
        manual_entry_by: manualStamp.by,
        manual_entry_at: manualStamp.at,
        manual_entry_reason: manualStamp.reason,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    clockEventId = created?.id;
  }
  if (!clockEventId) throw new Error("Could not record those deliveries. Please try again.");

  // A pre-031 day keeps its times on the HEADER with no session beneath it.
  // Adding a session to such a day would make the header derive from that one
  // session alone and blank the real clock-in, so the existing shift is adopted
  // into a session of its own first.
  if (existing?.clock_in_at) {
    await adoptManagerHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      manager_id: input.manager_id,
      store_id: existing.store_id,
      event_date: input.event_date,
    });
  }

  // A day already carrying hand-entered drops is CORRECTED, not added to —
  // otherwise re-submitting the same round would pay it twice.
  const alreadyEntered = await findDeliveriesOnlySession(supabase, clockEventId);
  if (alreadyEntered?.deliveries_approved) {
    throw new Error(
      "Those deliveries are already approved. Undo the approval on the day's row to change them.",
    );
  }

  if (alreadyEntered) {
    await setManagerSessionDeliveries(supabase, alreadyEntered.id, deliveries);
  } else {
    await insertDeliveriesOnlySession(supabase, {
      clockEventId,
      managerId: input.manager_id,
      storeId,
      eventDate: input.event_date,
      // Midday, and never shown: the row exists to carry counts, and it is
      // zero-length so it contributes no hours wherever it is summed.
      at: londonWallClockToUtc(input.event_date, "12:00").toISOString(),
      deliveries,
      manual: manualStamp,
    });
  }

  if (existing) {
    // An existing day is flagged too — the drops on it were still entered by
    // hand, and the badge is what tells a reviewer to look.
    const { error } = await supabase
      .from("manager_clock_events")
      .update({
        manual_entry: true,
        manual_entry_by: manualStamp.by,
        manual_entry_at: manualStamp.at,
        manual_entry_reason: manualStamp.reason,
      })
      .eq("id", clockEventId);
    if (error) throw new Error(error.message);
  }

  await recomputeManagerDayHeader(supabase, clockEventId);

  await writeAudit({
    action: alreadyEntered
      ? "manual_manager_deliveries_corrected"
      : "manual_manager_deliveries",
    entity: "manager_clock_event",
    entity_id: clockEventId,
    changes: {
      manager_id: input.manager_id,
      manager_name: manager.name,
      event_date: input.event_date,
      store_id: storeId,
      deliveries: {
        short: deliveries.short,
        long: deliveries.long,
        extra_short: deliveries.extraShort,
        extra_long: deliveries.extraLong,
      },
      reason: manualStamp.reason,
      by: user.email,
    },
  });

  revalidateManagerClockPaths();
}

// =============================================================
// Manager-entered clock TIMES for a manager who forgot to clock in
//
// The sibling of the employee path in app/actions/clock.ts, and deliberately a
// DIFFERENT thing from the deliveries-only entry above. That one is for a
// manager who was never on site and only covered drops, so it records no times.
// This one is for a manager who genuinely worked a shift and forgot to clock:
// their real times are the truth, and recording them is what puts the day back
// on the Live board, the Rota and Daily Approval.
//
// It BYPASSES THE GEOFENCE, so every row it writes is flagged `manual_entry`,
// carries a reason, leaves lat/lng null, and lands in the audit log.
//
// What it moves, and what it does not:
//   • Live board — the manager reads "On Shift"/"Clocked Out", and their
//     fixed_daily_wage joins that store's wage bill, which turns on clock_in_at
//     being set. That is CORRECT here, and is exactly why migration 037 refused
//     to do it for a day nobody worked.
//   • Tuesday payout — untouched. A manager's salary does not come through this
//     app; only their DROPS are paid, and this path records NO drops. A manager
//     who covered a round is given them on Daily Approval's "Add manager entry",
//     which is the one place manager delivery counts are hand-entered.
// =============================================================

export type ManualManagerClockEntryInput = {
  manager_id: string;
  /** YYYY-MM-DD. Defaults to today on the Live board. */
  event_date: string;
  /** "HH:MM", UK wall clock. */
  clock_in_time: string;
  /** "HH:MM". Omit while the manager is still on shift. */
  clock_out_time?: string | null;
  reason: string;
  /**
   * The store the shift is attributed to — it decides which store's Live board
   * and payout the day lands on. Admin-only; a manager is held to the store
   * they are running.
   */
  store_id?: string | null;
};

/** A manager may only record against the store they're currently running. */
function assertManagerEntryStore(
  user: Awaited<ReturnType<typeof requireApprover>>,
  storeId: string,
) {
  if (user.allowed!.role !== "manager") return;
  const activeStore = resolveActiveStoreId(user.allowed);
  if (!activeStore) throw new Error("No store assigned to your account.");
  if (storeId !== activeStore) {
    throw new Error("You can only record clock times for the store you're managing.");
  }
}

export type OpenManagerShiftOnDay = {
  manager_id: string;
  session_id: string;
  /** "HH:MM", UK wall clock — what the manual entry's clock-in box pre-fills with. */
  clock_in_time: string;
  store_id: string | null;
};

/**
 * The manager shifts still RUNNING on a given day, so the manual entry can
 * offer to close one rather than ask for a clock-in it already holds.
 * Deliveries-only rows are excluded — they are closed by construction and are
 * not shifts.
 */
export async function listOpenManagerShiftsForDate(
  eventDate: string,
): Promise<
  { ok: true; shifts: OpenManagerShiftOnDay[] } | { ok: false; error: string }
> {
  try {
    const user = await requireApprover();
    if (!eventDate) throw new Error("Date is required");

    const supabase = createServerSupabase();
    let query = supabase
      .from("manager_clock_sessions")
      .select("id, manager_id, store_id, clock_in_at")
      .eq("event_date", eventDate)
      .eq("deliveries_only", false)
      .is("clock_out_at", null);
    // A shift open at another store is not this manager's to close.
    if (user.allowed!.role === "manager") {
      const activeStore = resolveActiveStoreId(user.allowed);
      if (!activeStore) throw new Error("No store assigned to your account.");
      query = query.eq("store_id", activeStore);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return {
      ok: true,
      shifts: (data ?? []).map((s) => ({
        manager_id: s.manager_id as string,
        session_id: s.id as string,
        clock_in_time: londonHHMM(new Date(s.clock_in_at as string)),
        store_id: (s.store_id as string | null) ?? null,
      })),
    };
  } catch (err) {
    console.error("[manager-clock] open shift lookup failed:", err);
    return {
      ok: false,
      error:
        err instanceof Error && err.message
          ? err.message
          : "Could not check for open shifts.",
    };
  }
}

export async function upsertManualManagerClockEntry(
  input: ManualManagerClockEntryInput,
): Promise<ActionResult> {
  return asResult(() => performManualManagerClockEntry(input));
}

async function performManualManagerClockEntry(input: ManualManagerClockEntryInput) {
  // Role gate first — a non-staff caller must not get as far as reading a row.
  const user = await requireApprover();
  const supabase = createServerSupabase();

  if (!input.manager_id) throw new Error("Select a manager");
  if (!input.event_date) throw new Error("Date is required");
  if (!input.clock_in_time) throw new Error("Clock-in time is required");
  if (!input.reason?.trim()) {
    throw new Error("Give a reason — this records hours without a location check.");
  }

  const { data: manager } = await supabase
    .from("allowed_users")
    .select("id, name, username, role, store_id")
    .eq("id", input.manager_id)
    .maybeSingle();
  if (!manager) throw new Error("Manager not found.");
  if (manager.role !== "manager") throw new Error("That account isn't a manager.");
  const managerName = manager.name || manager.username || "That manager";

  const { data: existing } = await supabase
    .from("manager_clock_events")
    .select("*")
    .eq("manager_id", manager.id)
    .eq("event_date", input.event_date)
    .maybeSingle();

  // Where the shift happened. The caller says so explicitly from the Live
  // board's store card; otherwise the day's own store, then the manager's home
  // store. assertManagerEntryStore still holds a manager to their own store.
  const storeId =
    input.store_id ??
    (user.allowed!.role === "manager"
      ? resolveActiveStoreId(user.allowed) ?? existing?.store_id ?? manager.store_id
      : existing?.store_id ?? manager.store_id);
  if (!storeId) throw new Error("No store to record this shift against.");
  assertManagerEntryStore(user, storeId);

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
    // A clock-out earlier in the day than the clock-in crossed midnight, so it
    // lands on the following date while the day stays on event_date.
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

  // A manager still working can't take an open manual shift on top — the
  // one-open-session rule applies however the shift was recorded.
  if (!clockOutAt) {
    const open = await findOpenManagerSession(supabase, manager.id);
    if (open) {
      throw new Error(
        `${managerName} is already clocked in. Record the clock-out time as well, or wait for them to clock out.`,
      );
    }
  }

  const manualStamp = {
    by: user.id,
    at: now.toISOString(),
    reason: input.reason.trim(),
  };

  let clockEventId = existing?.id as string | undefined;
  if (!existing) {
    const { data: created, error } = await supabase
      .from("manager_clock_events")
      .insert({
        manager_id: manager.id,
        store_id: storeId,
        event_date: input.event_date,
        clock_in_at: clockInAt.toISOString(),
        // Deliberately null: a row with no coordinates was never verified.
        clock_in_lat: null,
        clock_in_lng: null,
        manual_entry: true,
        manual_entry_by: manualStamp.by,
        manual_entry_at: manualStamp.at,
        manual_entry_reason: manualStamp.reason,
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    clockEventId = created?.id;
  }
  if (!clockEventId) throw new Error("Could not record those times. Please try again.");

  // Adopt a pre-031 day so its existing shift is visible to the overlap check
  // below — otherwise a second manual entry could record the same hours twice.
  if (existing?.clock_in_at) {
    await adoptManagerHeaderIntoSession(supabase, {
      ...existing,
      id: existing.id,
      manager_id: manager.id,
      store_id: existing.store_id,
      event_date: input.event_date,
    });
  }

  // Deliveries-only rows are excluded throughout: they sit at midday with no
  // duration, so any real shift spanning lunch would read as overlapping one.
  const daySessions = (await managerSessionsForEvent(supabase, clockEventId)).filter(
    (s) => !s.deliveries_only,
  );

  // A window that COVERS the day's running shift is that shift being finished
  // off, so it closes it rather than being added beside it. An open session
  // runs to Infinity for the overlap check, so without this it could only ever
  // be refused — leaving a manually recorded clock-in with nothing to close it.
  const openOnDay =
    (clockOutAt &&
      daySessions.find(
        (s) => !s.clock_out_at && overlapsExistingSession([s], clockInAt, clockOutAt),
      )) ||
    null;

  const otherSessions = daySessions.filter((s) => s.id !== openOnDay?.id);
  if (overlapsExistingSession(otherSessions, clockInAt, clockOutAt)) {
    throw new Error(
      "Those times overlap a shift already recorded for that day. Check the existing times first.",
    );
  }

  const startUnchanged =
    !!openOnDay && new Date(openOnDay.clock_in_at).getTime() === clockInAt.getTime();

  let sessionSeq: number;
  if (openOnDay) {
    // No `deliveries` key at all, so whatever the manager logged live during
    // the shift survives being clocked out by hand.
    const closed = await closeManagerSession(supabase, openOnDay.id, {
      clockInAt: clockInAt.toISOString(),
      clockOutAt: clockOutAt!.toISOString(),
      storeId,
      manual: manualStamp,
    });
    if (!closed) {
      throw new Error(
        `${managerName} was clocked out while you were filling this in. Reload the day and check the times.`,
      );
    }
    sessionSeq = openOnDay.seq;
  } else {
    // A finished shift is INSERTED closed, never opened and then closed: an
    // open row holds the one-open slot for the width of a round-trip, which
    // collides with whatever shift the manager has running right now.
    const session = await addManagerSession(supabase, {
      clockEventId,
      managerId: manager.id,
      storeId,
      eventDate: input.event_date,
      clockInAt: clockInAt.toISOString(),
      clockOutAt: clockOutAt?.toISOString() ?? null,
      lat: null,
      lng: null,
      manual: manualStamp,
    });
    sessionSeq = session.seq;
  }

  if (existing) {
    // An existing day is flagged too — it now contains manager-entered time,
    // and the badge is what tells a reviewer to look.
    const { error } = await supabase
      .from("manager_clock_events")
      .update({
        manual_entry: true,
        manual_entry_by: manualStamp.by,
        manual_entry_at: manualStamp.at,
        manual_entry_reason: manualStamp.reason,
      })
      .eq("id", clockEventId);
    if (error) throw new Error(error.message);
  }

  // Header last: first-in / last-out / summed hours / summed drops and the
  // day's store all derive from the sessions.
  const { workedHours } = await recomputeManagerDayHeader(supabase, clockEventId);

  await writeAudit({
    action: openOnDay
      ? "manual_manager_clock_entry_closed_shift"
      : otherSessions.length > 0
        ? "manual_manager_clock_entry_added_shift"
        : "manual_manager_clock_entry",
    entity: "manager_clock_event",
    entity_id: clockEventId,
    changes: {
      manager_id: manager.id,
      manager_name: manager.name,
      event_date: input.event_date,
      session_seq: sessionSeq,
      fields: !clockOutAt ? "in" : startUnchanged ? "out" : "both",
      clock_in_at: clockInAt.toISOString(),
      clock_out_at: clockOutAt?.toISOString() ?? null,
      worked_hours: workedHours,
      store_id: storeId,
      reason: manualStamp.reason,
      by: user.email,
    },
  });

  revalidateManagerClockPaths();
}

// =============================================================
// Manager delivery approval
//
// Managers are trusted to sign off their own drops as well as a peer's — the
// client's explicit call. So there is no "not your own day" guard here, only a
// store-access one.
//
// Approval REFINES, it does not gate: the drops already reach the Tuesday sheet
// from the day header, exactly as an employee's do. Approving records who
// checked the numbers and lets a wrong count be corrected before payday.
// =============================================================

async function requireApprover() {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  const role = user.allowed.role;
  if (role !== "admin" && role !== "manager") {
    throw new Error("Only managers and admins can approve deliveries.");
  }
  return user;
}

/** The manager's day, checked against the caller's store scope. */
async function loadManagerDayForApproval(
  supabase: ReturnType<typeof createServerSupabase>,
  user: Awaited<ReturnType<typeof requireApprover>>,
  managerId: string,
  eventDate: string,
) {
  const { data: day } = await supabase
    .from("manager_clock_events")
    .select("*")
    .eq("manager_id", managerId)
    .eq("event_date", eventDate)
    .maybeSingle();
  if (!day) throw new Error("No clock record for that manager on that date.");

  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (day.store_id && day.store_id !== activeStore) {
      throw new Error("You can only approve deliveries for the store you're managing.");
    }
  }
  return day;
}

export async function approveManagerDeliveries(input: {
  manager_id: string;
  event_date: string;
  /** Corrected day totals. Omit to sign off what was clocked, unchanged. */
  deliveries?: DeliveryInput | null;
}): Promise<ActionResult> {
  return asResult(async () => {
    const user = await requireApprover();
    const supabase = createServerSupabase();
    if (!input.manager_id) throw new Error("Select a manager");
    if (!input.event_date) throw new Error("Date is required");

    const day = await loadManagerDayForApproval(
      supabase,
      user,
      input.manager_id,
      input.event_date,
    );

    const corrected = normaliseDeliveryInput(input.deliveries);
    if (corrected) {
      // Settle the correction on the day's LAST shift so the day sums to what
      // the approver typed, then let the header recompute from the sessions —
      // recomputeManagerDayHeader stays the only writer of the totals.
      const applied = await applyManagerDayDeliveryTotal(supabase, day.id, corrected);
      if (applied) {
        await recomputeManagerDayHeader(supabase, day.id);
      } else {
        // Pre-031 day with no sessions to carry the counts: write the header
        // directly, as the old build always did.
        const { error } = await supabase
          .from("manager_clock_events")
          .update({
            short_deliveries_count: corrected.short,
            long_deliveries_count: corrected.long,
            extra_short_deliveries: corrected.extraShort,
            extra_long_deliveries: corrected.extraLong,
            extra_short_reason: corrected.extraShort > 0 ? corrected.extraShortReason : null,
            extra_long_reason: corrected.extraLong > 0 ? corrected.extraLongReason : null,
          })
          .eq("id", day.id);
        if (error) throw new Error(error.message);
      }
    }

    // Sign-off lives on the SHIFT (migration 035), so a second shift added
    // later arrives unapproved instead of inheriting the day's flag.
    await approveManagerDaySessions(supabase, day.id, user.id);
    const sessions = await managerSessionsForEvent(supabase, day.id);
    if (sessions.length > 0) {
      await recomputeManagerDayHeader(supabase, day.id);
    } else {
      // Pre-031 day with no shifts to carry it: the header IS the record, so
      // the approved columns are copied from the raw ones — re-read, because a
      // correction above may have just rewritten them.
      const { data: fresh } = await supabase
        .from("manager_clock_events")
        .select(
          "short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries",
        )
        .eq("id", day.id)
        .maybeSingle();
      const { error } = await supabase
        .from("manager_clock_events")
        .update({
          deliveries_approved: true,
          approved_short_deliveries_count: fresh?.short_deliveries_count ?? null,
          approved_long_deliveries_count: fresh?.long_deliveries_count ?? null,
          approved_extra_short_deliveries: Number(fresh?.extra_short_deliveries) || 0,
          approved_extra_long_deliveries: Number(fresh?.extra_long_deliveries) || 0,
          approved_session_count: 1,
        })
        .eq("id", day.id);
      if (error) throw new Error(error.message);
    }

    const { error } = await supabase
      .from("manager_clock_events")
      .update({
        deliveries_approved_by: user.id,
        deliveries_approved_at: new Date().toISOString(),
      })
      .eq("id", day.id);
    if (error) throw new Error(error.message);

    await writeAudit({
      action: "manager_deliveries_approved",
      entity: "manager_clock_event",
      entity_id: day.id,
      changes: {
        manager_id: input.manager_id,
        event_date: input.event_date,
        was: {
          short: day.short_deliveries_count,
          long: day.long_deliveries_count,
          extra_short: day.extra_short_deliveries,
          extra_long: day.extra_long_deliveries,
        },
        ...(corrected
          ? {
              corrected_to: {
                short: corrected.short,
                long: corrected.long,
                extra_short: corrected.extraShort,
                extra_long: corrected.extraLong,
              },
            }
          : {}),
        by: user.email,
      },
    });

    revalidateManagerClockPaths();
  });
}

export async function unapproveManagerDeliveries(input: {
  manager_id: string;
  event_date: string;
}): Promise<ActionResult> {
  return asResult(async () => {
    const user = await requireApprover();
    const supabase = createServerSupabase();

    const day = await loadManagerDayForApproval(
      supabase,
      user,
      input.manager_id,
      input.event_date,
    );

    // Only the sign-off is withdrawn. The counts stay exactly as they are —
    // they are the record of what the manager actually did — but they stop
    // being paid until someone signs them off again (migration 035).
    const withdrawn = await unapproveManagerDaySessions(supabase, day.id, user.id);
    if (withdrawn > 0) {
      await recomputeManagerDayHeader(supabase, day.id);
    } else {
      const { error: hdrErr } = await supabase
        .from("manager_clock_events")
        .update({
          deliveries_approved: false,
          approved_short_deliveries_count: null,
          approved_long_deliveries_count: null,
          approved_extra_short_deliveries: 0,
          approved_extra_long_deliveries: 0,
          approved_session_count: 0,
        })
        .eq("id", day.id);
      if (hdrErr) throw new Error(hdrErr.message);
    }

    const { error } = await supabase
      .from("manager_clock_events")
      .update({ deliveries_approved_by: null, deliveries_approved_at: null })
      .eq("id", day.id);
    if (error) throw new Error(error.message);

    await writeAudit({
      action: "manager_deliveries_unapproved",
      entity: "manager_clock_event",
      entity_id: day.id,
      changes: { manager_id: input.manager_id, event_date: input.event_date, by: user.email },
    });

    revalidateManagerClockPaths();
  });
}
