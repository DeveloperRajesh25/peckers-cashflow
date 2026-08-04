"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { detectStoreForLocation, verifyGeofenceAtStore } from "@/lib/geofence-verify";
import { todayISO } from "@/lib/utils";
import { resolveActiveStoreId, type ActionResult } from "@/lib/types";
import {
  adoptManagerHeaderIntoSession,
  applyManagerDayDeliveryTotal,
  approveManagerDaySessions,
  closeManagerSession,
  findOpenManagerSession,
  managerSessionsForEvent,
  openManagerSession,
  recomputeManagerDayHeader,
  unapproveManagerDaySessions,
} from "@/lib/manager-clock-sessions";
import {
  normaliseDeliveryInput,
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
    input.latitude,
    input.longitude,
    input.accuracy,
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

  // Clock out from the store they clocked IN at (recorded on the session), not
  // whatever store they may have switched to since — you sign off where your
  // shift actually was.
  const clockedStoreId = session.store_id ?? existing.store_id;
  if (!clockedStoreId) throw new Error("Your clock-in has no store on record. Contact your admin.");

  await verifyGeofenceAtStore(
    supabase,
    clockedStoreId,
    input.latitude,
    input.longitude,
    input.accuracy,
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
