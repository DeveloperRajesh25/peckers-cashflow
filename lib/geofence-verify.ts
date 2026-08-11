// =============================================================
// Shared server-side geofence check. Reads store coordinates + radius and throws
// a user-facing error if the reported position is out of range OR out of date.
// Used by crew, manager and cover driver clock actions so they agree on the
// verdict.
//
//   detectStoreForLocation      clocking IN — which store are they standing in?
//   verifyGeofenceForClockOut   clocking OUT — the shift's store, or any store
//
// Both take a ReportedFix and check its freshness FIRST: an in-range verdict on
// a position captured hours ago is worse than no verdict at all, because it
// attributes the whole day to the wrong store.
//
// Takes the caller's Supabase client so RLS runs under the caller's session.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { haversineMeters, isWithinGeofence, MAX_FIX_AGE_MS } from "./utils";

/**
 * A reported position PLUS how long ago it was captured.
 *
 * The age is the reason this is an object rather than loose lat/lng arguments:
 * every clock path must supply it, and a positional parameter of the same type
 * as `accuracy` could be swapped for it without the compiler noticing.
 */
export type ReportedFix = {
  lat: number;
  lng: number;
  /** GPS ±metres, if the device reported it. */
  accuracy?: number | null;
  /**
   * Milliseconds between capturing the fix and submitting it, measured on the
   * client's MONOTONIC clock (performance.now), so a device clock correction or
   * timezone change cannot fabricate a fresh-looking age. Null means the client
   * did not say — which is refused, not trusted.
   */
  ageMs: number | null;
};

/**
 * Refuse a position that is too old to prove where someone is standing NOW.
 *
 * Geolocation is client-asserted either way, so this does not pretend to be
 * tamper-proof — it closes the ACCIDENT: a backgrounded tab submitting the fix
 * it captured hours ago at a different store. A missing age is refused rather
 * than waved through, which is deliberate: the tabs already open at deploy time
 * are exactly the ones carrying a stale fix.
 */
export function assertFreshFix(ageMs: number | null | undefined): void {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_FIX_AGE_MS) {
    throw new Error(
      "Your location check is out of date. Tap Refresh to check your location again, then clock in or out.",
    );
  }
}

/** Who/what to attribute a logged geofence failure to. Optional everywhere —
 *  omitting it just skips logging (e.g. call sites that don't have an actor
 *  yet), it never affects the geofence check itself. */
export type GeofenceLogContext = {
  actorEmail: string;
  employeeId?: string | null;
  managerId?: string | null;
  action: "clock_in" | "clock_out";
};

/**
 * Best-effort record of a failed geofence check, so "why couldn't I clock in"
 * can be answered from data later instead of guessed at. Never throws — a
 * logging failure must not mask (or replace) the real geofence error.
 */
async function logGeofenceFailure(
  supabase: SupabaseClient,
  ctx: GeofenceLogContext | undefined,
  info: {
    lat: number;
    lng: number;
    accuracy?: number | null;
    nearestStoreId: string | null;
    nearestStoreName: string | null;
    distance: number;
    radius: number;
    message: string;
  },
) {
  if (!ctx) return;
  try {
    await supabase.from("geofence_failures").insert({
      actor_email: ctx.actorEmail,
      employee_id: ctx.employeeId ?? null,
      manager_id: ctx.managerId ?? null,
      action: ctx.action,
      attempted_lat: info.lat,
      attempted_lng: info.lng,
      accuracy_m: info.accuracy ?? null,
      nearest_store_id: info.nearestStoreId,
      nearest_store_name: info.nearestStoreName,
      distance_m: info.distance,
      radius_m: info.radius,
      message: info.message,
    });
  } catch (err) {
    console.error("[geofence] failed to log failed attempt (non-blocking):", err);
  }
}

type StoreCheck = {
  inRange: boolean;
  name: string;
  distance: number;
  radius: number;
};

/** Distance verdict for one store, or null when that store has no coordinates
 *  to measure against. Neither logs nor throws — the caller decides what a miss
 *  means. */
async function checkGeofenceAtStore(
  supabase: SupabaseClient,
  storeId: string,
  lat: number,
  lng: number,
  accuracy?: number | null,
): Promise<StoreCheck | null> {
  const { data: store } = await supabase
    .from("stores")
    .select("latitude, longitude, geofence_radius_m, name")
    .eq("id", storeId)
    .maybeSingle();

  if (!store?.latitude || !store?.longitude) return null;

  const distance = haversineMeters(
    Number(store.latitude),
    Number(store.longitude),
    lat,
    lng,
  );
  const radius = Number(store.geofence_radius_m ?? 250);
  return {
    inRange: isWithinGeofence(distance, radius, accuracy),
    name: store.name as string,
    distance,
    radius,
  };
}

/**
 * Geofence check for CLOCKING OUT. The shift's recorded store is tried first —
 * that is where the work is attributed, and the normal case is signing off where
 * you clocked in. But it must not be the ONLY store accepted: staff cover across
 * stores, and any drift between where the shift is recorded and where the person
 * actually is (a shift recorded at their home store, a manager-entered shift, a
 * store switched mid-day) would otherwise trap them on site with no way to clock
 * out — the app telling someone standing at Stevenage that they're 12km from
 * Hitchin.
 *
 * So: in range of the recorded store → done. Otherwise, if they are standing
 * inside SOME store's geofence, that is good enough to sign off; the returned
 * store says where they actually were, for the audit trail. Only someone at no
 * store at all is refused, which is the rule this check exists to enforce. A
 * recorded store with no coordinates configured takes the same fallback rather
 * than erroring — an admin's missing setting is not the clocker's problem.
 *
 * Attribution is deliberately NOT changed here — the day's store stays the one
 * the work was recorded against, so wages don't move between stores at clock-out.
 */
export async function verifyGeofenceForClockOut(
  supabase: SupabaseClient,
  storeId: string | null,
  fix: ReportedFix,
  logCtx?: GeofenceLogContext,
): Promise<{ distance: number; atStore: DetectedStore | null }> {
  assertFreshFix(fix.ageMs);
  if (storeId) {
    const check = await checkGeofenceAtStore(supabase, storeId, fix.lat, fix.lng, fix.accuracy);
    if (check?.inRange) return { distance: check.distance, atStore: null };
  }
  // Throws its own distance-aware error (and logs it) when they're at no store.
  const detected = await detectStoreForLocation(supabase, fix, logCtx);
  return { distance: detected.distance, atStore: detected };
}

export type DetectedStore = {
  id: string;
  name: string;
  distance: number;
};

/**
 * Find which store the caller is physically at, so an employee can clock in at
 * ANY store (not just their home one) — the store they're standing in is the
 * store the day's work is attributed to. Returns the nearest store whose
 * geofence contains the reported position. Throws a helpful, distance-aware
 * error when the position is outside every store's radius.
 *
 * Stores with no configured coordinates are skipped (admin must set them first).
 */
export async function detectStoreForLocation(
  supabase: SupabaseClient,
  fix: ReportedFix,
  logCtx?: GeofenceLogContext,
): Promise<DetectedStore> {
  assertFreshFix(fix.ageMs);
  const { lat, lng, accuracy } = fix;
  const { data: stores } = await supabase
    .from("stores")
    .select("id, name, latitude, longitude, geofence_radius_m");

  const located = (stores ?? []).filter(
    (s) => s.latitude != null && s.longitude != null,
  );
  if (located.length === 0) {
    throw new Error(
      "No store locations are configured yet. Ask your admin to set the store coordinates.",
    );
  }

  type Ranked = { id: string; name: string; distance: number; radius: number };
  const ranked: Ranked[] = located
    .map((s) => ({
      id: s.id as string,
      name: s.name as string,
      distance: haversineMeters(Number(s.latitude), Number(s.longitude), lat, lng),
      radius: Number(s.geofence_radius_m ?? 250),
    }))
    .sort((a, b) => a.distance - b.distance);

  // Nearest store whose geofence (allowing for GPS accuracy) contains the point.
  const inRange = ranked.find((s) => isWithinGeofence(s.distance, s.radius, accuracy));
  if (!inRange) {
    const nearest = ranked[0];
    const message = `You're ${Math.round(nearest.distance)}m from ${nearest.name} — too far to clock in or out. You must be within ${nearest.radius}m of a store.`;
    await logGeofenceFailure(supabase, logCtx, {
      lat,
      lng,
      accuracy,
      nearestStoreId: nearest.id,
      nearestStoreName: nearest.name,
      distance: nearest.distance,
      radius: nearest.radius,
      message,
    });
    throw new Error(message);
  }
  return { id: inRange.id, name: inRange.name, distance: inRange.distance };
}
