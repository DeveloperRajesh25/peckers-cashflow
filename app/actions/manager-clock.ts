"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { detectStoreForLocation, verifyGeofenceAtStore } from "@/lib/geofence-verify";
import { todayISO } from "@/lib/utils";
import { resolveActiveStoreId, type ActionResult } from "@/lib/types";
import {
  adoptManagerHeaderIntoSession,
  closeManagerSession,
  findOpenManagerSession,
  openManagerSession,
  recomputeManagerDayHeader,
} from "@/lib/manager-clock-sessions";
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

  revalidatePath("/manager/live");
  revalidatePath("/live");
  revalidatePath("/rota");
}

export async function managerClockOut(input: ClockInput): Promise<ActionResult> {
  return asResult(() => performManagerClockOut(input));
}

async function performManagerClockOut(input: ClockInput) {
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

  const now = new Date().toISOString();
  const closedOk = await closeManagerSession(supabase, session.id, {
    clockOutAt: now,
    lat: input.latitude,
    lng: input.longitude,
  });
  if (!closedOk) throw new Error("You've already clocked out of that shift.");

  // Header last: first-in / last-out / summed hours all come from the sessions.
  const { workedHours } = await recomputeManagerDayHeader(supabase, existing.id);

  await writeAudit({
    action: "manager_clock_out",
    entity: "manager_clock_event",
    entity_id: managerId,
    changes: {
      date: session.event_date,
      session_seq: session.seq,
      worked_hours: workedHours,
      location: [input.latitude, input.longitude],
    },
  });

  revalidatePath("/manager/live");
  revalidatePath("/live");
  revalidatePath("/rota");
}
