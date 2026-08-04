"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ClockIcon } from "@/components/ui/icons";
import { managerClockIn, managerClockOut } from "@/app/actions/manager-clock";
import { switchStore } from "@/app/actions/store-switch";
import { getBestPosition, isPermissionDenied } from "@/lib/geolocation";
import {
  formatHoursMins,
  formatTimeOnly,
  haversineMeters,
  isWithinGeofence,
  liveDayWorkedHours,
} from "@/lib/utils";
import type { ManagerClockEvent, ManagerClockSession, Store } from "@/lib/types";

type Props = {
  managerName: string;
  /** The store the manager is currently operating as (active store). */
  store: Store | null;
  /** All stores, so we can detect which one the manager is physically at. */
  allStores?: Store[];
  /** The day's header row. Its In is the FIRST clock-in and its Out the last. */
  todayClock: ManagerClockEvent | null;
  /**
   * The day's individual shifts. A manager can open up, go home and come back
   * for the evening, so the day is a list of in/out pairs rather than one.
   */
  todaySessions?: ManagerClockSession[];
};

type GeoState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; lat: number; lng: number; accuracy: number; distance: number | null }
  | { status: "denied" | "error"; message: string };

export function ManagerClockCard({
  managerName,
  store,
  allStores,
  todayClock,
  todaySessions = [],
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [geo, setGeo] = React.useState<GeoState>({ status: "idle" });
  const [busy, setBusy] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  // Clock-out asks about drops first. Null = not asking; "ask" = the yes/no
  // question; "enter" = the counts. A manager who did none never sees a form.
  const [dropStep, setDropStep] = React.useState<null | "ask" | "enter">(null);
  const [shortDrops, setShortDrops] = React.useState("");
  const [longDrops, setLongDrops] = React.useState("");
  const [extraShort, setExtraShort] = React.useState("");
  const [extraLong, setExtraLong] = React.useState("");
  const [extraShortReason, setExtraShortReason] = React.useState("");
  const [extraLongReason, setExtraLongReason] = React.useState("");

  const storeConfigured = store?.latitude != null && store?.longitude != null;

  const requestLocation = React.useCallback(() => {
    setGeo({ status: "loading" });
    // Converge on a precise GPS fix rather than trusting the first coarse
    // (Wi-Fi/network) reading, so the distance/in-range verdict is trustworthy.
    getBestPosition({ desiredAccuracyM: 30, maxWaitMs: 12_000 })
      .then((fix) => {
        const distance =
          store?.latitude != null && store?.longitude != null
            ? haversineMeters(
                Number(store.latitude),
                Number(store.longitude),
                fix.lat,
                fix.lng,
              )
            : null;
        setGeo({
          status: "ok",
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
          distance,
        });
      })
      .catch((err: unknown) => {
        if (isPermissionDenied(err)) {
          setGeo({
            status: "denied",
            message: "Location permission denied. Enable it in your browser settings, then tap Retry.",
          });
        } else {
          setGeo({
            status: "error",
            message: err instanceof Error ? err.message : "Could not get your location. Tap Retry.",
          });
        }
      });
  }, [store?.latitude, store?.longitude]);

  React.useEffect(() => {
    if (storeConfigured) requestLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inRange =
    geo.status === "ok" &&
    store?.geofence_radius_m != null &&
    geo.distance != null &&
    isWithinGeofence(geo.distance, store.geofence_radius_m, geo.accuracy);

  // Which store is the manager physically standing in? Nearest one whose
  // geofence contains their position. Used to nudge them to switch when they're
  // at a store other than the one the app is currently set to.
  const detectedStore = React.useMemo(() => {
    if (geo.status !== "ok" || !allStores?.length) return null;
    const ranked = allStores
      .filter((s) => s.latitude != null && s.longitude != null)
      .map((s) => ({
        store: s,
        distance: haversineMeters(Number(s.latitude), Number(s.longitude), geo.lat, geo.lng),
      }))
      .filter(({ store: s, distance }) =>
        isWithinGeofence(distance, s.geofence_radius_m ?? 250, geo.accuracy),
      )
      .sort((a, b) => a.distance - b.distance);
    return ranked[0]?.store ?? null;
  }, [geo, allStores]);

  const atDifferentStore = detectedStore != null && store != null && detectedStore.id !== store.id;

  async function switchToDetected() {
    if (!detectedStore) return;
    setSwitching(true);
    try {
      const res = await switchStore(detectedStore.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Switched to ${detectedStore.name}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch store.");
    } finally {
      setSwitching(false);
    }
  }

  // Chronological, never by seq — seq is insertion order.
  const sessions = React.useMemo(
    () => [...todaySessions].sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at)),
    [todaySessions],
  );
  // The header's clock_out_at is nulled while any shift is open, so it answers
  // "still on shift" for pre-031 days that have no session rows too.
  const openSession = sessions.find((s) => !s.clock_out_at) ?? null;
  const clockedIn =
    !!openSession || (!!todayClock?.clock_in_at && !todayClock?.clock_out_at);
  // There is no terminal phase any more: having clocked out is no bar to
  // starting another shift, which is the whole point of the feature.
  const phase: "in" | "out" = clockedIn ? "out" : "in";
  const completedCount = sessions.filter((s) => s.clock_out_at).length;
  const hasFinishedShift = completedCount > 0 || !!todayClock?.clock_out_at;
  const workedToday = todayClock?.clock_in_at
    ? liveDayWorkedHours(todayClock, sessions)
    : 0;

  // Drops already logged against the OTHER shifts of today, so the manager
  // counts only this one — the day's total is the sum of its shifts.
  const earlierDropsToday = React.useMemo(() => {
    let short = 0;
    let long = 0;
    for (const s of sessions) {
      if (!s.clock_out_at) continue; // the shift being closed now
      short += (Number(s.short_deliveries_count) || 0) + (Number(s.extra_short_deliveries) || 0);
      long += (Number(s.long_deliveries_count) || 0) + (Number(s.extra_long_deliveries) || 0);
    }
    return { short, long, any: short > 0 || long > 0 };
  }, [sessions]);

  function resetDropForm() {
    setShortDrops("");
    setLongDrops("");
    setExtraShort("");
    setExtraLong("");
    setExtraShortReason("");
    setExtraLongReason("");
  }

  /** The button. Clocking IN goes straight through; clocking OUT asks first. */
  function act() {
    if (geo.status !== "ok") {
      toast.error("Capture your location first.");
      return;
    }
    if (phase === "out") {
      setDropStep("ask");
      return;
    }
    void submit(null);
  }

  async function submit(deliveries: {
    short_deliveries_count: number;
    long_deliveries_count: number;
    extra_short_deliveries: number;
    extra_long_deliveries: number;
    extra_short_reason: string | null;
    extra_long_reason: string | null;
  } | null) {
    if (geo.status !== "ok") {
      toast.error("Capture your location first.");
      return;
    }
    setBusy(true);
    try {
      const payload = { latitude: geo.lat, longitude: geo.lng, accuracy: geo.accuracy };
      const res =
        phase === "out"
          ? await managerClockOut({ ...payload, deliveries })
          : await managerClockIn(payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDropStep(null);
      resetDropForm();
      toast.success(
        phase === "out"
          ? deliveries
            ? "Clocked out — deliveries recorded."
            : "Clocked out. Thanks!"
          : "Clocked in. Have a good shift!",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const extraShortNeedsReason = (Number(extraShort) || 0) > 0 && !extraShortReason.trim();
  const extraLongNeedsReason = (Number(extraLong) || 0) > 0 && !extraLongReason.trim();
  const dropTotal =
    (Number(shortDrops) || 0) +
    (Number(longDrops) || 0) +
    (Number(extraShort) || 0) +
    (Number(extraLong) || 0);

  function submitDrops() {
    if (extraShortNeedsReason) {
      toast.error("Give a reason for the extra short deliveries.");
      return;
    }
    if (extraLongNeedsReason) {
      toast.error("Give a reason for the extra long deliveries.");
      return;
    }
    if (dropTotal <= 0) {
      toast.error("Enter at least one delivery, or go back and answer No.");
      return;
    }
    void submit({
      short_deliveries_count: Number(shortDrops) || 0,
      long_deliveries_count: Number(longDrops) || 0,
      extra_short_deliveries: Number(extraShort) || 0,
      extra_long_deliveries: Number(extraLong) || 0,
      extra_short_reason: extraShortReason.trim() || null,
      extra_long_reason: extraLongReason.trim() || null,
    });
  }

  return (
    <Card className="border-gold/30">
      <CardHeader>
        <div>
          <CardTitle>Your attendance</CardTitle>
          <CardDescription>
            {managerName} · clock in when you arrive at {store?.name ?? "your store"}. This is for
            monitoring only — it doesn&apos;t change your salary.
          </CardDescription>
        </div>
      </CardHeader>

      {!store ? (
        <p className="text-sm text-danger">
          You&apos;re not assigned to a store yet. Ask your admin to set your store.
        </p>
      ) : !storeConfigured ? (
        <p className="text-sm text-danger">
          Your store&apos;s location hasn&apos;t been set up yet. Ask your admin to add the store
          coordinates before you can clock in.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Location status */}
          <div className="rounded-xl border border-border p-4 bg-surface-hover/40">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  Location check
                  {geo.status === "ok" && (
                    <Badge variant={inRange ? "success" : "danger"}>
                      {inRange ? "In range" : "Out of range"}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {geo.status === "loading"
                    ? "Getting your location…"
                    : geo.status === "ok"
                      ? geo.distance != null
                        ? `${Math.round(geo.distance)}m from ${store?.name ?? "store"} · ±${Math.round(geo.accuracy)}m GPS accuracy`
                        : "No store location configured."
                      : geo.status === "denied" || geo.status === "error"
                        ? geo.message
                        : `You must be within ${store?.geofence_radius_m ?? 250}m of ${store?.name ?? "your store"}.`}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={requestLocation}
                loading={geo.status === "loading"}
              >
                {geo.status === "ok" ? "Refresh" : "Retry"}
              </Button>
            </div>
          </div>

          {/* You're at another store — offer to switch the whole app to it. */}
          {atDifferentStore && (
            <div className="rounded-xl border border-gold/40 bg-gold/10 p-4">
              <p className="text-sm font-medium text-text-primary">
                You&apos;re at {detectedStore!.name}
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                Your app is set to {store?.name ?? "another store"}. Switch to{" "}
                {detectedStore!.name} to clock in and manage it here.
              </p>
              <Button
                size="sm"
                className="mt-3"
                onClick={switchToDetected}
                loading={switching}
              >
                Switch to {detectedStore!.name}
              </Button>
            </div>
          )}

          {/* Today's shifts so far. Shown alongside the button rather than
              instead of it: finishing a shift no longer ends the day. */}
          {hasFinishedShift && (
            <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success">
              <div className="flex items-center justify-between gap-2 font-medium">
                <span className="flex items-center gap-2">
                  <ClockIcon size={16} />
                  {completedCount > 1
                    ? `${completedCount} shifts logged today`
                    : "Shift logged for today"}
                </span>
                <span className="text-base font-semibold tabular-nums">
                  {formatHoursMins(workedToday)}h
                </span>
              </div>
              {sessions.length > 0 ? (
                <ul className="text-xs mt-1 text-success/80 space-y-0.5">
                  {sessions.map((s) => (
                    <li key={s.id} className="tabular-nums">
                      {formatTimeOnly(s.clock_in_at)} –{" "}
                      {s.clock_out_at ? formatTimeOnly(s.clock_out_at) : "still on shift"}
                      {s.auto_clocked_out && (
                        <span
                          className="ml-1 text-warning"
                          title="No clock-out recorded — the scheduled shift end was used."
                        >
                          (auto)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs mt-1 text-success/80">
                  Clocked in {formatTimeOnly(todayClock?.clock_in_at)} · Clocked out{" "}
                  {formatTimeOnly(todayClock?.clock_out_at)}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              className="w-full text-base h-14"
              variant={phase === "out" ? "secondary" : "primary"}
              onClick={act}
              loading={busy}
              disabled={!inRange || busy}
              iconLeft={<ClockIcon size={18} />}
            >
              {phase === "out"
                ? "Clock Out Now"
                : hasFinishedShift
                  ? "Start Another Shift"
                  : "Clock In Now"}
            </Button>
            {!inRange && geo.status === "ok" && (
              <p className="text-xs text-danger text-center">
                You&apos;re too far from {store?.name ?? "your store"} to clock{" "}
                {phase === "out" ? "out" : "in"}.
              </p>
            )}
            {phase === "out" && (
              <p className="text-[11px] text-text-muted text-center">
                Clocked in at{" "}
                {formatTimeOnly(openSession?.clock_in_at ?? todayClock?.clock_in_at)}.
              </p>
            )}
            {phase === "in" && hasFinishedShift && (
              <p className="text-[11px] text-text-muted text-center">
                Coming back later? Clock in again and today&apos;s hours add up.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Step 1 — the question. Asked on every clock-out because a busy night
          is exactly the night it's forgotten, and an unrecorded drop is money
          the manager never gets back. */}
      {dropStep === "ask" && (
        <Modal
          open
          onClose={() => setDropStep(null)}
          title="Did you do any deliveries this shift?"
          description="Drops you covered are paid per delivery on the Tuesday sheet, on top of your salary."
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => void submit(null)}
                loading={busy}
                disabled={busy}
              >
                No deliveries
              </Button>
              <Button onClick={() => setDropStep("enter")} disabled={busy}>
                Yes, I did
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            Answering <span className="text-text-primary">No</span> clocks you out straight
            away and records nothing. You can still have a manager add the drops on the
            Daily Approval screen if you remember later.
          </p>
        </Modal>
      )}

      {/* Step 2 — the counts, laid out exactly like the driver clock-out form
          so a manager filling one in recognises the other. */}
      {dropStep === "enter" && (
        <Modal
          open
          onClose={() => setDropStep(null)}
          title="Deliveries this shift"
          description="Count only the shift you're clocking out of — today's shifts add up."
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDropStep("ask")} disabled={busy}>
                Back
              </Button>
              <Button
                onClick={submitDrops}
                loading={busy}
                disabled={busy || dropTotal <= 0 || extraShortNeedsReason || extraLongNeedsReason}
              >
                Clock out
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {earlierDropsToday.any && (
              <p className="text-xs text-text-muted rounded-xl border border-border bg-bg px-3 py-2">
                Earlier today you already logged {earlierDropsToday.short} short ·{" "}
                {earlierDropsToday.long} long. Those are saved — enter only this shift below.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input
                type="number"
                min="0"
                step="1"
                label="Short deliveries (SD)"
                value={shortDrops}
                onChange={(e) => setShortDrops(e.target.value)}
              />
              <Input
                type="number"
                min="0"
                step="1"
                label="Long deliveries (LD)"
                value={longDrops}
                onChange={(e) => setLongDrops(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                type="number"
                min="0"
                step="1"
                label="Extra short (MS)"
                value={extraShort}
                onChange={(e) => setExtraShort(e.target.value)}
              />
              <Input
                type="number"
                min="0"
                step="1"
                label="Extra long (ML)"
                value={extraLong}
                onChange={(e) => setExtraLong(e.target.value)}
              />
            </div>

            {/* Two boxes, not one: each extra can be raised for a different
                reason, and a single shared box could only ever explain one. */}
            {(Number(extraShort) || 0) > 0 && (
              <Input
                label="Reason for extra short deliveries *"
                placeholder="Why were these beyond the round?"
                value={extraShortReason}
                onChange={(e) => setExtraShortReason(e.target.value)}
                maxLength={200}
              />
            )}
            {(Number(extraLong) || 0) > 0 && (
              <Input
                label="Reason for extra long deliveries *"
                placeholder="Why were these beyond the round?"
                value={extraLongReason}
                onChange={(e) => setExtraLongReason(e.target.value)}
                maxLength={200}
              />
            )}

            <p className="text-xs text-text-muted">
              MS / ML are miscellaneous drops beyond the normal round — paid at the same
              per-drop rate, but they carry a written reason. These counts appear on Daily
              Approval for sign-off and on the Tuesday payout sheet.
            </p>
          </div>
        </Modal>
      )}
    </Card>
  );
}
