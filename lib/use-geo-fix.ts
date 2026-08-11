"use client";

// =============================================================
// Shared clock-screen location state. Used by the crew, manager and cover
// driver clock cards so all three treat a fix the same way — the client-side
// counterpart to geofence-verify.ts, which is the server's single verdict.
//
// A fix is PERISHABLE. Capturing one on mount and keeping it for the life of
// the tab is what let a backgrounded tab clock in at the previous night's store
// the next morning. Three things stop that here, and the server's MAX_FIX_AGE_MS
// refusal is the fourth:
//
//   expiry    a fix older than FIX_STALE_AFTER_MS stops counting as current and
//             is re-acquired, so the "In range" badge can never be stale
//   resume    coming back to the tab DROPS the fix before fetching a new one —
//             invalidating first is the point, or the old one stays armed for
//             the several seconds the GPS takes to answer
//   on press  the fix actually submitted is acquired at the button press unless
//             it is only seconds old, so no lifecycle event needs to have fired
//             for the submitted position to be current
//
// The last one is what makes this robust on mobile: iOS Safari and installed
// PWAs do not reliably fire visibilitychange when resuming from a locked screen
// or the app switcher, and bfcache restores fire pageshow instead.
// =============================================================

import * as React from "react";
import { getBestPosition, isPermissionDenied, type Fix } from "@/lib/geolocation";
import {
  FIX_RESUME_GRACE_MS,
  FIX_REUSE_AT_PRESS_MS,
  FIX_STALE_AFTER_MS,
  FIX_STALENESS_CHECK_MS,
  haversineMeters,
  isWithinGeofence,
} from "@/lib/utils";
import type { Store } from "@/lib/types";

export type GeoState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; lat: number; lng: number; accuracy: number }
  | { status: "denied" | "error"; message: string };

/** A fix plus the age the server needs to judge whether it is still current. */
export type SubmittableFix = Fix & { ageMs: number };

export type RankedStore = { store: Store; distance: number; inRange: boolean };

/**
 * Every clockable store ranked by distance from a fix, nearest first. Shared so
 * the badge shown before the press and the check made AT the press agree — they
 * run against different fixes, and disagreeing about the rule as well would make
 * a rejection impossible to explain.
 */
export function rankStoresByDistance(
  stores: Store[],
  fix: { lat: number; lng: number; accuracy?: number | null },
): RankedStore[] {
  return stores
    .filter((s) => s.latitude != null && s.longitude != null)
    .map((s) => {
      const distance = haversineMeters(
        Number(s.latitude),
        Number(s.longitude),
        fix.lat,
        fix.lng,
      );
      return {
        store: s,
        distance,
        inRange: isWithinGeofence(distance, s.geofence_radius_m ?? 250, fix.accuracy),
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

type Options = {
  /** False while there is nothing to clock against (no store coordinates set). */
  enabled: boolean;
  desiredAccuracyM?: number;
  maxWaitMs?: number;
  /**
   * Fired when the tab is resumed after long enough to matter. The clock screens
   * use it to re-fetch server data: a tab backgrounded overnight renders
   * yesterday's date, shift and hours until something refreshes it.
   */
  onResume?: () => void;
};

export function useGeoFix({
  enabled,
  desiredAccuracyM = 30,
  maxWaitMs = 12_000,
  onResume,
}: Options) {
  const [geo, setGeo] = React.useState<GeoState>({ status: "idle" });

  // Held in a ref so the resume listener never re-subscribes and never calls a
  // stale closure.
  const onResumeRef = React.useRef(onResume);
  onResumeRef.current = onResume;

  // The authoritative fix. Deliberately NOT derived from `geo`: the age has to
  // survive re-renders untouched, and it is cleared the instant a fix stops
  // being trustworthy — before any replacement arrives.
  const current = React.useRef<{ fix: Fix; capturedAt: number } | null>(null);
  // One acquisition at a time. A press during a background refresh joins the
  // in-flight fetch rather than opening a second GPS watch.
  const inFlight = React.useRef<Promise<Fix> | null>(null);
  // Permission denial is sticky until the user retries, so the background timer
  // stops asking — the browser will only refuse again.
  const denied = React.useRef(false);

  const acquire = React.useCallback((): Promise<Fix> => {
    if (inFlight.current) return inFlight.current;
    setGeo({ status: "loading" });
    const run = getBestPosition({ desiredAccuracyM, maxWaitMs })
      .then((fix) => {
        denied.current = false;
        current.current = { fix, capturedAt: performance.now() };
        setGeo({ status: "ok", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
        return fix;
      })
      .catch((err: unknown) => {
        // Never fall back to the previous fix — failing to get a new position is
        // exactly when the old one is most likely to be wrong.
        current.current = null;
        if (isPermissionDenied(err)) {
          denied.current = true;
          setGeo({
            status: "denied",
            message:
              "Location permission denied. Enable it in your browser settings, then tap Retry.",
          });
        } else {
          setGeo({
            status: "error",
            message:
              err instanceof Error ? err.message : "Could not get your location. Tap Retry.",
          });
        }
        throw err;
      })
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = run;
    return run;
  }, [desiredAccuracyM, maxWaitMs]);

  /** Manual Refresh / Retry. Drops the old fix first so it cannot be submitted. */
  const refresh = React.useCallback(() => {
    current.current = null;
    denied.current = false;
    void acquire().catch(() => {});
  }, [acquire]);

  /**
   * The fix to actually submit. Reuses the cached one only while it is seconds
   * old; otherwise it acquires a new one and the caller waits. This is what
   * makes the submitted position current regardless of which lifecycle events
   * the browser did or did not fire.
   */
  const acquireForSubmit = React.useCallback(async (): Promise<SubmittableFix> => {
    const cached = current.current;
    if (cached && performance.now() - cached.capturedAt < FIX_REUSE_AT_PRESS_MS) {
      return { ...cached.fix, ageMs: Math.round(performance.now() - cached.capturedAt) };
    }
    const fix = await acquire();
    const capturedAt = current.current?.capturedAt ?? performance.now();
    return { ...fix, ageMs: Math.round(performance.now() - capturedAt) };
  }, [acquire]);

  // First capture, then keep it from going stale while the page is watched.
  // Only while visible: a backgrounded tab polling GPS is battery for nothing,
  // and the resume handler below covers coming back.
  React.useEffect(() => {
    if (!enabled) return;
    void acquire().catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || denied.current) return;
      const cached = current.current;
      if (!cached || performance.now() - cached.capturedAt >= FIX_STALE_AFTER_MS) {
        void acquire().catch(() => {});
      }
    }, FIX_STALENESS_CHECK_MS);
    return () => clearInterval(timer);
  }, [enabled, acquire]);

  // Coming back to the tab. Covers all three ways a browser reports it, because
  // no single one of them is reliable across iOS Safari, Android Chrome and an
  // installed PWA.
  React.useEffect(() => {
    if (!enabled) return;

    const handleResume = () => {
      if (document.visibilityState !== "visible") return;
      const cached = current.current;
      const age = cached ? performance.now() - cached.capturedAt : Infinity;
      // A few seconds away is a glance at another app, not a journey. Skipping
      // those keeps the button from flicking to "getting your location" every
      // time focus returns, while anything longer is treated as a real absence.
      if (age < FIX_RESUME_GRACE_MS) return;
      current.current = null;
      if (!denied.current) void acquire().catch(() => {});
      onResumeRef.current?.();
    };
    const handlePageShow = (e: PageTransitionEvent) => {
      // Only a bfcache restore — a normal load already acquired on mount.
      if (e.persisted) handleResume();
    };

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [enabled, acquire]);

  return { geo, refresh, acquireForSubmit };
}
