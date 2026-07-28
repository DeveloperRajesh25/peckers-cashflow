"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { ClockIcon } from "@/components/ui/icons";
import {
  coverDriverClockIn,
  coverDriverClockOut,
  updateCoverDriverDeliveries,
} from "@/app/actions/cover-driver-clock";
import { coverDriverPay, totalDeliveries } from "@/lib/cover-driver-hours";
import {
  WEEKDAY_LONG,
  addDays,
  clockedHours,
  formatDDMMYYYY,
  formatGBP,
  formatTimeOnly,
  haversineMeters,
  isWithinGeofence,
  startOfISOWeek,
  toISODate,
  todayISO,
} from "@/lib/utils";
import type { CoverDriver, CoverDriverClockEvent, Store } from "@/lib/types";

type Props = {
  driver: CoverDriver;
  /** All stores — a cover driver may be called to whichever one needs them. */
  stores: Store[];
  todayClock: CoverDriverClockEvent | null;
  weekClocks?: CoverDriverClockEvent[];
};

type GeoState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; lat: number; lng: number; accuracy: number }
  | { status: "denied" | "error"; message: string };

export function CoverDriverClockApp({
  driver,
  stores,
  todayClock,
  weekClocks = [],
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [geo, setGeo] = React.useState<GeoState>({ status: "idle" });
  const [busy, setBusy] = React.useState(false);
  const [shortDeliveries, setShortDeliveries] = React.useState<string>(
    todayClock?.short_deliveries_count?.toString() ?? "",
  );
  const [longDeliveries, setLongDeliveries] = React.useState<string>(
    todayClock?.long_deliveries_count?.toString() ?? "",
  );
  const [extraShort, setExtraShort] = React.useState<string>(
    todayClock?.extra_short_deliveries ? String(todayClock.extra_short_deliveries) : "",
  );
  const [extraLong, setExtraLong] = React.useState<string>(
    todayClock?.extra_long_deliveries ? String(todayClock.extra_long_deliveries) : "",
  );
  const [extraShortReason, setExtraShortReason] = React.useState<string>(
    todayClock?.extra_short_reason ?? "",
  );
  const [extraLongReason, setExtraLongReason] = React.useState<string>(
    todayClock?.extra_long_reason ?? "",
  );

  const today = todayISO();
  const weekStart = startOfISOWeek(new Date());

  const locatedStores = React.useMemo(
    () => stores.filter((s) => s.latitude != null && s.longitude != null),
    [stores],
  );

  const clockByDate = React.useMemo(() => {
    const m = new Map<string, CoverDriverClockEvent>();
    for (const c of weekClocks) m.set(c.event_date, c);
    return m;
  }, [weekClocks]);

  const todayWorkedHours = todayClock?.clock_out_at
    ? clockedHours(todayClock.clock_in_at, todayClock.clock_out_at)
    : 0;

  const clockedIn = !!todayClock?.clock_in_at && !todayClock?.clock_out_at;
  const clockedOut = !!todayClock?.clock_out_at;
  const currentPhase: "in" | "out" | "done" = clockedOut ? "done" : clockedIn ? "out" : "in";

  const requestLocation = React.useCallback(() => {
    setGeo({ status: "loading" });
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo({ status: "error", message: "Geolocation not supported by this device." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({
          status: "ok",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGeo({
            status: "denied",
            message:
              "Location permission denied. Enable it in your browser settings, then tap Retry.",
          });
        } else {
          setGeo({
            status: "error",
            message: err.message || "Could not get your location. Tap Retry.",
          });
        }
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  }, []);

  // Capture location on open so the clock button is ready immediately (this
  // also triggers the browser's permission prompt once).
  React.useEffect(() => {
    if (locatedStores.length > 0) requestLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const storeDistances = React.useMemo(() => {
    if (geo.status !== "ok") return [] as { store: Store; distance: number; inRange: boolean }[];
    return locatedStores
      .map((s) => {
        const distance = haversineMeters(
          Number(s.latitude),
          Number(s.longitude),
          geo.lat,
          geo.lng,
        );
        return {
          store: s,
          distance,
          inRange: isWithinGeofence(distance, s.geofence_radius_m, geo.accuracy),
        };
      })
      .sort((a, b) => a.distance - b.distance);
  }, [geo, locatedStores]);

  // Clocking out is fixed to the store they clocked IN at; clocking in targets
  // the nearest store they're actually within range of.
  const clockedStore = todayClock?.store_id
    ? stores.find((s) => s.id === todayClock.store_id) ?? null
    : null;

  let targetStore: Store | null;
  let targetDistance: number | null;
  let inRange: boolean;
  if (currentPhase === "out" || currentPhase === "done") {
    targetStore = clockedStore;
    const d = storeDistances.find((sd) => sd.store.id === clockedStore?.id) ?? null;
    targetDistance = d?.distance ?? null;
    inRange = !!d?.inRange;
  } else {
    const detected = storeDistances.find((sd) => sd.inRange) ?? null;
    targetStore = detected?.store ?? storeDistances[0]?.store ?? null;
    targetDistance = detected?.distance ?? storeDistances[0]?.distance ?? null;
    inRange = !!detected;
  }

  const todayPay = todayClock
    ? coverDriverPay({
        hours: todayWorkedHours,
        hourlyRate: driver.hourly_cash_rate,
        shortDeliveries: totalDeliveries(
          todayClock.short_deliveries_count,
          todayClock.extra_short_deliveries,
        ),
        longDeliveries: totalDeliveries(
          todayClock.long_deliveries_count,
          todayClock.extra_long_deliveries,
        ),
        shortRate: driver.short_delivery_rate,
        longRate: driver.long_delivery_rate,
      })
    : 0;

  async function doClockIn() {
    if (geo.status !== "ok") {
      toast.error("Capture your location first.");
      return;
    }
    if (!inRange || !targetStore) {
      toast.error("You're not within range of a store yet.");
      return;
    }
    setBusy(true);
    try {
      const res = await coverDriverClockIn({
        latitude: geo.lat,
        longitude: geo.lng,
        accuracy: geo.accuracy,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Clocked in at ${targetStore.name}. Have a good shift!`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function doClockOut() {
    if (geo.status !== "ok") {
      toast.error("Capture your location first.");
      return;
    }
    if (!shortDeliveries.trim() && !longDeliveries.trim()) {
      toast.error("Enter your short and long delivery counts before clocking out.");
      return;
    }
    if (Number(extraShort) > 0 && !extraShortReason.trim()) {
      toast.error("Please give a reason for the extra short deliveries.");
      return;
    }
    if (Number(extraLong) > 0 && !extraLongReason.trim()) {
      toast.error("Please give a reason for the extra long deliveries.");
      return;
    }
    setBusy(true);
    try {
      const res = await coverDriverClockOut({
        latitude: geo.lat,
        longitude: geo.lng,
        accuracy: geo.accuracy,
        short_deliveries_count: Number(shortDeliveries) || 0,
        long_deliveries_count: Number(longDeliveries) || 0,
        extra_short_deliveries: Number(extraShort) || 0,
        extra_long_deliveries: Number(extraLong) || 0,
        extra_short_reason: extraShortReason.trim() || null,
        extra_long_reason: extraLongReason.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Clocked out. Thanks!");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveLiveDeliveries() {
    if (!shortDeliveries.trim() && !longDeliveries.trim()) return;
    if (Number(extraShort) > 0 && !extraShortReason.trim()) {
      toast.error("Please give a reason for the extra short deliveries.");
      return;
    }
    if (Number(extraLong) > 0 && !extraLongReason.trim()) {
      toast.error("Please give a reason for the extra long deliveries.");
      return;
    }
    setBusy(true);
    try {
      const res = await updateCoverDriverDeliveries({
        short_count: Number(shortDeliveries) || 0,
        long_count: Number(longDeliveries) || 0,
        extra_short_deliveries: Number(extraShort) || 0,
        extra_long_deliveries: Number(extraLong) || 0,
        extra_short_reason: extraShortReason.trim() || null,
        extra_long_reason: extraLongReason.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Live delivery count updated.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const noStoresConfigured = locatedStores.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {/* ---------- Primary clock card ---------- */}
      <Card className="border-gold/30">
        <CardHeader>
          <div>
            <CardTitle>Today &mdash; {formatDDMMYYYY(new Date())}</CardTitle>
            <CardDescription>
              Cover shift — clock in when you arrive at the store you&apos;re covering.
            </CardDescription>
          </div>
        </CardHeader>

        {noStoresConfigured ? (
          <p className="text-sm text-danger">
            No store locations have been set up yet. Ask your manager to add the store
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
                        ? currentPhase === "out" || currentPhase === "done"
                          ? targetStore
                            ? `${targetDistance != null ? `${Math.round(targetDistance)}m from ` : "At "}${targetStore.name} · ±${Math.round(geo.accuracy)}m GPS accuracy`
                            : "Clocked-in store unavailable."
                          : inRange && targetStore
                            ? `You're at ${targetStore.name} · ${targetDistance != null ? `${Math.round(targetDistance)}m away · ` : ""}±${Math.round(geo.accuracy)}m GPS`
                            : targetStore
                              ? `${Math.round(targetDistance ?? 0)}m from ${targetStore.name} — move closer to clock in.`
                              : "No store nearby."
                        : geo.status === "denied" || geo.status === "error"
                          ? geo.message
                          : "Getting your location…"}
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

            {/* Big primary action */}
            {currentPhase === "done" ? (
              <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success">
                <div className="flex items-center justify-between gap-2 font-medium">
                  <span className="flex items-center gap-2">
                    <ClockIcon size={16} /> Shift complete for today
                  </span>
                  <span className="text-base font-semibold tabular-nums">
                    {todayWorkedHours.toFixed(2)}h
                  </span>
                </div>
                <p className="text-xs mt-1 text-success/80">
                  You worked {todayWorkedHours.toFixed(2)}h
                  {clockedStore ? ` at ${clockedStore.name}` : ""} — clocked in{" "}
                  {formatTimeOnly(todayClock?.clock_in_at)} · clocked out{" "}
                  {formatTimeOnly(todayClock?.clock_out_at)}
                </p>
                <p className="text-xs mt-1 text-success/80">
                  Today&apos;s pay {formatGBP(todayPay)} — your manager approves it before
                  it&apos;s paid.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {currentPhase === "out" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="number"
                        min="0"
                        label="Short deliveries *"
                        value={shortDeliveries}
                        onChange={(e) => setShortDeliveries(e.target.value)}
                        placeholder="0"
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Long deliveries *"
                        value={longDeliveries}
                        onChange={(e) => setLongDeliveries(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="number"
                        min="0"
                        label="Extra short (beyond round)"
                        value={extraShort}
                        onChange={(e) => setExtraShort(e.target.value)}
                        placeholder="0"
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Extra long (beyond round)"
                        value={extraLong}
                        onChange={(e) => setExtraLong(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                    {Number(extraShort) > 0 && (
                      <Input
                        label="Reason for extra short deliveries *"
                        value={extraShortReason}
                        onChange={(e) => setExtraShortReason(e.target.value)}
                        placeholder="e.g. covered a second area after a no-show"
                        maxLength={200}
                      />
                    )}
                    {Number(extraLong) > 0 && (
                      <Input
                        label="Reason for extra long deliveries *"
                        value={extraLongReason}
                        onChange={(e) => setExtraLongReason(e.target.value)}
                        placeholder="e.g. out-of-area drop-off"
                        maxLength={200}
                      />
                    )}
                  </>
                )}

                <Button
                  size="lg"
                  className="w-full text-base h-14"
                  variant={currentPhase === "out" ? "secondary" : "primary"}
                  onClick={currentPhase === "out" ? doClockOut : doClockIn}
                  loading={busy}
                  disabled={!inRange || busy}
                  iconLeft={<ClockIcon size={18} />}
                >
                  {currentPhase === "out"
                    ? `Clock Out${targetStore ? ` — ${targetStore.name}` : " Now"}`
                    : `Clock In${inRange && targetStore ? ` at ${targetStore.name}` : " Now"}`}
                </Button>

                {!inRange && geo.status === "ok" && (
                  <p className="text-xs text-danger text-center">
                    {currentPhase === "out"
                      ? `You're too far from ${targetStore?.name ?? "the store"} to clock out.`
                      : "You're not within range of any store. Move closer to the store you're covering."}
                  </p>
                )}
                {geo.status === "ok" && (
                  <p className="text-[11px] text-text-muted text-center">
                    {currentPhase === "out"
                      ? `Clocked in at ${formatTimeOnly(todayClock?.clock_in_at)}${clockedStore ? ` · ${clockedStore.name}` : ""}.`
                      : "Tip: tap Refresh if you've just arrived and you're showing out of range."}
                  </p>
                )}
              </div>
            )}

            {/* Live count during the shift */}
            {clockedIn && (
              <div className="rounded-xl border border-border p-4">
                <div className="text-sm font-medium mb-1">Live delivery count</div>
                <p className="text-xs text-text-muted">
                  Update during your shift so your manager sees the running total.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    min="0"
                    label="Short so far"
                    value={shortDeliveries}
                    onChange={(e) => setShortDeliveries(e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    label="Long so far"
                    value={longDeliveries}
                    onChange={(e) => setLongDeliveries(e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    label="Extra short"
                    value={extraShort}
                    onChange={(e) => setExtraShort(e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    label="Extra long"
                    value={extraLong}
                    onChange={(e) => setExtraLong(e.target.value)}
                  />
                </div>
                {Number(extraShort) > 0 && (
                  <Input
                    label="Reason for extra short deliveries *"
                    value={extraShortReason}
                    onChange={(e) => setExtraShortReason(e.target.value)}
                    placeholder="e.g. covered a second area after a no-show"
                    maxLength={200}
                    containerClassName="mt-2"
                  />
                )}
                {Number(extraLong) > 0 && (
                  <Input
                    label="Reason for extra long deliveries *"
                    value={extraLongReason}
                    onChange={(e) => setExtraLongReason(e.target.value)}
                    placeholder="e.g. out-of-area drop-off"
                    maxLength={200}
                    containerClassName="mt-2"
                  />
                )}
                <Button onClick={saveLiveDeliveries} loading={busy} className="mt-3 w-full">
                  Update
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ---------- This week's cover shifts ---------- */}
      <Card className="p-0 overflow-hidden">
        <CardHeader className="px-5 pt-5 mb-0">
          <CardTitle>Your week</CardTitle>
          <CardDescription>
            {formatDDMMYYYY(weekStart)} – {formatDDMMYYYY(addDays(weekStart, 6))}. Days you
            covered and the hours you worked.
          </CardDescription>
        </CardHeader>
        <div className="border-t border-border">
          {Array.from({ length: 7 }, (_, i) => {
            const date = addDays(weekStart, i);
            const dateIso = toISODate(date);
            const clk = clockByDate.get(dateIso);
            const worked = clk?.clock_out_at
              ? clockedHours(clk.clock_in_at, clk.clock_out_at)
              : 0;
            const isToday = dateIso === today;
            return (
              <div
                key={dateIso}
                className={
                  "px-5 py-3 border-b border-border last:border-0 flex items-center justify-between " +
                  (isToday ? "bg-gold/5" : "")
                }
              >
                <div className="text-sm font-medium">
                  {WEEKDAY_LONG[i]}{" "}
                  <span className="text-text-muted text-xs ml-1">{formatDDMMYYYY(date)}</span>
                </div>
                <div className="text-sm text-right">
                  {clk?.clock_in_at ? (
                    clk.clock_out_at ? (
                      <span className="text-[11px]">
                        <span className="text-text-muted">
                          Worked {formatTimeOnly(clk.clock_in_at)}–
                          {formatTimeOnly(clk.clock_out_at)}
                        </span>{" "}
                        <span className="text-success font-medium">{worked.toFixed(2)}h</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-success">
                        On shift since {formatTimeOnly(clk.clock_in_at)}
                      </span>
                    )
                  ) : (
                    <span className="text-text-muted text-xs">No cover shift</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
