"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { clockIn, clockOut, updateDeliveryCount } from "@/app/actions/clock";
import {
  cancelEarlyClockInRequest,
  clockInWithEarlyOtp,
  getEarlyClockInStatus,
  requestEarlyClockInOtp,
} from "@/app/actions/early-clock-in";
import { bookableStartMinutes, isEarlyClockIn } from "@/lib/early-clock-in";
import {
  WEEKDAY_LONG,
  addDays,
  formatDDMMYYYY,
  formatHoursMinsWords,
  formatShiftRange,
  formatTimeOnly,
  liveDayWorkedHours,
  londonHHMM,
  resolvedDayHours,
  startOfISOWeek,
  timeToMinutes,
  toISODate,
  todayISO,
  weekdayIndex,
} from "@/lib/utils";
import { rankStoresByDistance, useGeoFix } from "@/lib/use-geo-fix";
import { ClockReminderOptIn } from "@/components/crew/ClockReminderOptIn";
import { savePushSubscription, deletePushSubscription, sendTestPush } from "@/app/actions/push";
import { ClockIcon } from "@/components/ui/icons";
import type {
  ClockEvent,
  ClockSession,
  Employee,
  EmployeeScheduleDay,
  RotaShift,
  Store,
} from "@/lib/types";
import { hasRole } from "@/lib/types";

type Props = {
  employee: Employee;
  /** All stores — staff can clock in at whichever one they're physically at. */
  stores: Store[];
  weekShifts: RotaShift[];
  schedules?: EmployeeScheduleDay[];
  todayClock: ClockEvent | null;
  /** This week's clock events (Mon–Sun) — drives the worked-hours history. */
  weekClocks?: ClockEvent[];
  /** The individual shifts inside those days — a day can hold several. */
  weekSessions?: ClockSession[];
};

/**
 * How soon after clocking out a second clock-in asks for confirmation. Clocking
 * back in is one tap by design, which also makes it one mis-tap — and a
 * phantom shift on a payroll record is worth a moment's friction.
 */
const RECLOCK_CONFIRM_WINDOW_MS = 5 * 60_000;

/** How often the waiting employee asks whether the manager has denied them. */
const OTP_POLL_MS = 15_000;

/** The live authorisation the employee is waiting on. Never carries the code. */
type OtpFlow = {
  requestId?: string;
  expiresAt: string;
  scheduledStart: string;
  storeName: string;
};

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function CrewClockApp({
  employee,
  stores,
  weekShifts,
  schedules = [],
  todayClock,
  weekClocks = [],
  weekSessions = [],
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  // Delivery counts belong to the shift being worked, not the day (migration
  // 033), so these seed from the OPEN SESSION — never from the day header,
  // which is the sum of every shift. Seeding from the header is exactly what
  // made a driver's second clock-out overwrite their morning's drops.
  const openSessionForSeed = weekSessions.find((s) => !s.clock_out_at) ?? null;
  const [shortDeliveries, setShortDeliveries] = React.useState<string>(
    openSessionForSeed?.short_deliveries_count?.toString() ?? "",
  );
  const [longDeliveries, setLongDeliveries] = React.useState<string>(
    openSessionForSeed?.long_deliveries_count?.toString() ?? "",
  );
  const [extraShort, setExtraShort] = React.useState<string>(
    openSessionForSeed?.extra_short_deliveries
      ? String(openSessionForSeed.extra_short_deliveries)
      : "",
  );
  const [extraLong, setExtraLong] = React.useState<string>(
    openSessionForSeed?.extra_long_deliveries
      ? String(openSessionForSeed.extra_long_deliveries)
      : "",
  );
  const [extraShortReason, setExtraShortReason] = React.useState<string>(
    openSessionForSeed?.extra_short_reason ?? "",
  );
  const [extraLongReason, setExtraLongReason] = React.useState<string>(
    openSessionForSeed?.extra_long_reason ?? "",
  );

  const today = todayISO();
  const isDriver = hasRole(employee.position, "Driver");
  const weekStart = startOfISOWeek(new Date());

  // Stores that can actually be clocked at (coordinates configured).
  const locatedStores = React.useMemo(
    () => stores.filter((s) => s.latitude != null && s.longitude != null),
    [stores],
  );

  const scheduleByWeekday = React.useMemo(() => {
    const m = new Map<number, EmployeeScheduleDay>();
    for (const s of schedules) m.set(s.weekday, s);
    return m;
  }, [schedules]);

  // Clock events keyed by date, plus the week's worked-hours total (completed
  // shifts only — an in-progress shift is shown per-day but not yet summed).
  const clockByDate = React.useMemo(() => {
    const m = new Map<string, ClockEvent>();
    for (const c of weekClocks) m.set(c.event_date, c);
    return m;
  }, [weekClocks]);

  // The day's individual shifts. A day can hold several — morning in, out,
  // evening back in — and each is its own session row.
  const sessionsByDate = React.useMemo(() => {
    const m = new Map<string, ClockSession[]>();
    for (const s of weekSessions) {
      const arr = m.get(s.event_date) ?? [];
      arr.push(s);
      m.set(s.event_date, arr);
    }
    // By clock time, not seq — a shift recorded by a manager after the fact can
    // carry a higher seq than one that happened earlier in the day.
    for (const arr of m.values()) arr.sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at));
    return m;
  }, [weekSessions]);

  const todaySessions = sessionsByDate.get(today) ?? [];
  const openSession = todaySessions.find((s) => !s.clock_out_at) ?? null;

  // resolvedDayHours is the same function payroll uses: a manager's approval
  // override wins, else the SUM of the day's shifts (never last-out minus
  // first-in, which counts the gap between them).
  const weekWorkedHours = React.useMemo(
    () => weekClocks.reduce((sum, c) => sum + resolvedDayHours(c), 0),
    [weekClocks],
  );

  // Includes the shift currently running, so the figure keeps up during the day.
  const todayWorkedHours = todayClock
    ? todayClock.hours_approved && todayClock.approved_hours != null
      ? Number(todayClock.approved_hours)
      : liveDayWorkedHours(todayClock, todaySessions)
    : 0;

  // Drops already banked on EARLIER shifts today. Shown next to the entry boxes
  // so a driver on their second shift can see the morning's round is safe and
  // enters only what they've just done — the ambiguity that used to cost them
  // the earlier count.
  const earlierDropsToday = React.useMemo(() => {
    let short = 0;
    let long = 0;
    for (const s of todaySessions) {
      if (openSession && s.id === openSession.id) continue;
      short += (Number(s.short_deliveries_count) || 0) + (Number(s.extra_short_deliveries) || 0);
      long += (Number(s.long_deliveries_count) || 0) + (Number(s.extra_long_deliveries) || 0);
    }
    return { short, long, any: short > 0 || long > 0 };
  }, [todaySessions, openSession]);

  const completedTodayCount = todaySessions.filter((s) => s.clock_out_at).length;
  const lastClockOutAt = todaySessions
    .filter((s) => s.clock_out_at)
    .reduce<string | null>(
      (latest, s) =>
        !latest || new Date(s.clock_out_at!).getTime() > new Date(latest).getTime()
          ? s.clock_out_at!
          : latest,
      todayClock?.clock_out_at ?? null,
    );

  /** "09:00–13:00, 17:00–21:00" — the day's shifts, for the summary line. */
  const todayShiftLabel = todaySessions
    .map(
      (s) =>
        `${formatTimeOnly(s.clock_in_at)}–${s.clock_out_at ? formatTimeOnly(s.clock_out_at) : "now"}`,
    )
    .join(", ");

  // Effective shift(s) for a date: published rota rows first (a day can hold
  // several — split shifts), else the employee's recurring schedule template
  // for that weekday.
  function effFor(dateIso: string, weekdayIdx: number) {
    const real = weekShifts.filter((s) => s.shift_date === dateIso);
    if (real.length > 0) {
      const working = real.filter((s) => !s.is_day_off);
      return {
        is_day_off: working.length === 0,
        // "09:00–13:00, 17:00–21:00" when the day has more than one shift.
        label: working
          .map((s) => formatShiftRange(false, s.start_time, s.end_time))
          .join(", "),
        reason: real.map((s) => s.same_day_edit_reason).find(Boolean) ?? null,
        fromTemplate: false,
      };
    }
    const tmpl = scheduleByWeekday.get(weekdayIdx);
    if (tmpl && tmpl.is_working && tmpl.start_time)
      return {
        is_day_off: false,
        label: formatShiftRange(false, tmpl.start_time, tmpl.end_time),
        reason: null,
        fromTemplate: true,
      };
    return null;
  }

  const todayEff = effFor(today, weekdayIndex(new Date()));

  // On shift = a session is open. Pre-029 days have no sessions, so fall back
  // to the header's "clocked in, not yet out".
  const clockedIn = openSession
    ? true
    : todaySessions.length === 0 && !!todayClock?.clock_in_at && !todayClock?.clock_out_at;

  // Only two states now. A finished shift no longer ends the day — the button
  // goes back to Clock In so a second shift needs no new gesture, and the day's
  // completed work is summarised in the card above it.
  const currentPhase: "in" | "out" = clockedIn ? "out" : "in";
  const finishedShiftToday = !clockedIn && (completedTodayCount > 0 || !!todayClock?.clock_out_at);

  // The booked start today's clock-in is measured against, in London wall-clock
  // minutes. Only a BOOKING counts — `weekShifts` is rota_shifts, and the
  // recurring `schedules` template above is availability, which never creates
  // one. Earliest booked shift of the day, matching what findShiftForClockIn
  // resolves to server-side.
  const todayBookedStartMinutes = React.useMemo(() => {
    const booked = weekShifts
      .filter((s) => s.shift_date === today && !s.is_day_off && s.start_time)
      .sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""))[0];
    return bookableStartMinutes(booked ?? null);
  }, [weekShifts, today]);

  const [otpFlow, setOtpFlow] = React.useState<OtpFlow | null>(null);
  const [otpCode, setOtpCode] = React.useState("");
  const [otpLocked, setOtpLocked] = React.useState(false);
  const [otpNow, setOtpNow] = React.useState(() => Date.now());

  const { geo, refresh: requestLocation, acquireForSubmit } = useGeoFix({
    enabled: locatedStores.length > 0,
    // Nothing to submit while they're on the phone to their manager, and a
    // resume-triggered refresh would remount this card and wipe the code
    // they're half way through typing.
    suspended: !!otpFlow,
    // A tab backgrounded overnight renders yesterday's date, shift and hours
    // until the server data is re-fetched. Skipped mid-submit so a refresh can't
    // land on top of a clock action.
    onResume: () => {
      if (!busy && !otpFlow) router.refresh();
    },
  });

  const otpExpiresAt = otpFlow ? new Date(otpFlow.expiresAt).getTime() : 0;
  const otpExpired = !!otpFlow && otpNow >= otpExpiresAt;
  const otpDead = otpExpired || otpLocked;

  // Countdown tick. Only while the panel is up — a second-by-second re-render
  // of the whole card the rest of the time would be pure waste.
  React.useEffect(() => {
    if (!otpFlow) return;
    const t = setInterval(() => setOtpNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [otpFlow]);

  // A manager denying the request has to reach the person standing outside, and
  // they have no other reason to re-render.
  React.useEffect(() => {
    if (!otpFlow) return;
    const t = setInterval(async () => {
      const res = await getEarlyClockInStatus();
      if (!res.ok) return;
      if (res.status === "cancelled") {
        setOtpFlow(null);
        setOtpCode("");
        setOtpLocked(false);
        requestLocation();
        toast.error("Your manager declined the early start.");
      } else if (res.status === "used") {
        setOtpFlow(null);
        setOtpCode("");
        router.refresh();
      } else if (res.status === "locked") {
        setOtpLocked(true);
      }
    }, OTP_POLL_MS);
    return () => clearInterval(t);
  }, [otpFlow, requestLocation, router, toast]);

  // Distance to every clockable store from the current position, nearest first.
  const storeDistances = React.useMemo(
    () => (geo.status === "ok" ? rankStoresByDistance(locatedStores, geo) : []),
    [geo, locatedStores],
  );

  // The store this clock action applies to:
  //  - clocking out: the store they clocked IN at (fixed for the shift).
  //  - clocking in: auto-detected — the nearest store they're within range of.
  const clockedStore =
    todayClock?.store_id ? stores.find((s) => s.id === todayClock.store_id) ?? null : null;

  let targetStore: Store | null;
  let targetDistance: number | null;
  let inRange: boolean;
  /** Set only when they're standing in a store OTHER than the shift's. */
  let elsewhereStore: Store | null = null;
  if (currentPhase === "out") {
    const atClocked = storeDistances.find((sd) => sd.store.id === clockedStore?.id) ?? null;
    // Being at ANY store signs the shift off, mirroring the server: staff cover
    // across stores, and a shift recorded against the wrong one must not leave
    // them unable to clock out from where they're actually standing.
    const anyStore = storeDistances.find((sd) => sd.inRange) ?? null;
    const at = atClocked?.inRange ? atClocked : anyStore;
    targetStore = clockedStore ?? at?.store ?? null;
    targetDistance = atClocked?.distance ?? at?.distance ?? null;
    inRange = !!at;
    if (at && at.store.id !== clockedStore?.id) elsewhereStore = at.store;
  } else {
    const detected = storeDistances.find((sd) => sd.inRange) ?? null;
    // Fall back to the nearest store purely for the "you're Xm away" message.
    targetStore = detected?.store ?? storeDistances[0]?.store ?? null;
    targetDistance = detected?.distance ?? storeDistances[0]?.distance ?? null;
    inRange = !!detected;
  }

  async function doClockIn() {
    if (geo.status !== "ok") {
      toast.error("Capture your location first.");
      return;
    }
    // Clocking back in is one tap, which also makes it one mis-tap. Only asks
    // when the clock-out was moments ago — a genuine second shift starts hours
    // later and is never interrupted. Asked BEFORE the fix is taken: a blocking
    // dialog left sitting open would age the position out from under us.
    if (
      lastClockOutAt &&
      Date.now() - new Date(lastClockOutAt).getTime() < RECLOCK_CONFIRM_WINDOW_MS &&
      !window.confirm(
        `You clocked out at ${formatTimeOnly(lastClockOutAt)}. Start another shift?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      // The position submitted is captured HERE, not when the page opened. A tab
      // reopened the next morning at a different store must not clock in on the
      // fix it took at the last one — which is exactly how a Hitchin shift once
      // landed on Stevenage.
      const fix = await acquireForSubmit();
      const detected = rankStoresByDistance(locatedStores, fix).find((s) => s.inRange);
      if (!detected) {
        toast.error("You're not within range of a store. Move closer and try again.");
        return;
      }

      // Starting before the booked shift needs the manager's authorisation, so
      // that press goes to the OTP action instead. Decided from props already
      // on this screen: an ON-TIME clock-in makes exactly the one server call
      // it always did. The server re-checks either way — this only routes.
      const early = isEarlyClockIn({
        nowMinutes: timeToMinutes(londonHHMM(new Date())),
        scheduledStartMinutes: todayBookedStartMinutes,
        hasSessionToday: todaySessions.length > 0,
      });
      if (early && (await startOtpFlow(fix))) return;

      const res = await clockIn({
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy,
        fix_age_ms: fix.ageMs,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Clocked in at ${detected.store.name}. Have a good shift!`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask for a code against a fix taken at the press. Returns true when the OTP
   * panel took over; false means the server judged the clock-in on time after
   * all and the caller should carry on as normal.
   */
  async function startOtpFlow(fix: Awaited<ReturnType<typeof acquireForSubmit>>) {
    const res = await requestEarlyClockInOtp({
      latitude: fix.lat,
      longitude: fix.lng,
      accuracy: fix.accuracy,
      fix_age_ms: fix.ageMs,
    });
    if (!res.ok) {
      toast.error(res.error);
      return true;
    }
    if (!res.otp_required) return false;
    setOtpFlow({
      requestId: res.request_id,
      expiresAt: res.expires_at,
      scheduledStart: res.scheduled_start ?? "",
      storeName: res.store_name,
    });
    setOtpCode("");
    setOtpLocked(false);
    setOtpNow(Date.now());
    return true;
  }

  async function submitOtp() {
    if (!/^\d{4}$/.test(otpCode)) {
      toast.error("Enter the 4-digit code your manager gave you.");
      return;
    }
    setBusy(true);
    try {
      const res = await clockInWithEarlyOtp({ otp: otpCode });
      if (!res.ok) {
        toast.error(res.error);
        setOtpCode("");
        return;
      }
      const storeName = otpFlow?.storeName;
      setOtpFlow(null);
      setOtpCode("");
      setOtpLocked(false);
      toast.success(
        storeName ? `Clocked in at ${storeName}. Have a good shift!` : "Clocked in.",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancelOtp() {
    const requestId = otpFlow?.requestId;
    setOtpFlow(null);
    setOtpCode("");
    setOtpLocked(false);
    // The hook stopped refreshing the fix while the panel was up, so get a
    // current one back before the button is live again.
    requestLocation();
    if (requestId) await cancelEarlyClockInRequest({ requestId });
  }

  /** Expired or locked — start again with a fresh fix and a fresh code. */
  async function requestNewOtp() {
    setBusy(true);
    try {
      const fix = await acquireForSubmit();
      if (await startOtpFlow(fix)) return;
      // No longer early (they waited past their start time), so this is just a
      // clock-in now.
      setOtpFlow(null);
      const res = await clockIn({
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy,
        fix_age_ms: fix.ageMs,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Clocked in. Have a good shift!");
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
    if (isDriver && !shortDeliveries.trim() && !longDeliveries.trim()) {
      toast.error("Enter your short and long delivery counts before clocking out.");
      return;
    }
    if (isDriver && Number(extraShort) > 0 && !extraShortReason.trim()) {
      toast.error("Please give a reason for the extra short deliveries.");
      return;
    }
    if (isDriver && Number(extraLong) > 0 && !extraLongReason.trim()) {
      toast.error("Please give a reason for the extra long deliveries.");
      return;
    }
    setBusy(true);
    try {
      // Same rule as clocking in: the fix that decides where this shift is
      // signed off is taken at the press, not at page load.
      const fix = await acquireForSubmit();
      const res = await clockOut({
        latitude: fix.lat,
        longitude: fix.lng,
        accuracy: fix.accuracy,
        fix_age_ms: fix.ageMs,
        short_deliveries_count: isDriver ? Number(shortDeliveries) || 0 : null,
        long_deliveries_count: isDriver ? Number(longDeliveries) || 0 : null,
        extra_short_deliveries: isDriver ? Number(extraShort) || 0 : null,
        extra_long_deliveries: isDriver ? Number(extraLong) || 0 : null,
        extra_short_reason: isDriver ? extraShortReason.trim() || null : null,
        extra_long_reason: isDriver ? extraLongReason.trim() || null : null,
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
      const res = await updateDeliveryCount({
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
      {/* ---------- Primary clock card (always visible, in focus) ---------- */}
      <Card className="border-gold/30">
        <CardHeader>
          <div>
            <CardTitle>Today &mdash; {formatDDMMYYYY(new Date())}</CardTitle>
            <CardDescription>
              {todayEff
                ? todayEff.is_day_off
                  ? "Marked as Day Off — clock in only if you're covering."
                  : `Scheduled ${todayEff.label}${todayEff.fromTemplate ? " (your default schedule)" : ""}`
                : "No shift scheduled today. You can still clock in if you're working."}
            </CardDescription>
          </div>
        </CardHeader>

        {noStoresConfigured ? (
          <p className="text-sm text-danger">
            No store locations have been set up yet. Ask your admin to add the store
            coordinates before you can clock in.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Status row */}
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
                        ? currentPhase === "out"
                          ? elsewhereStore
                            ? `You're at ${elsewhereStore.name} — your shift is recorded at ${targetStore?.name ?? "another store"} · ±${Math.round(geo.accuracy)}m GPS`
                            : targetStore
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

            {/* What's been worked today. Shown once a shift is finished, and
                again alongside the Clock In button when a second one starts —
                a day can hold several shifts, so this is a running total
                rather than a full stop. */}
            {finishedShiftToday && (
              <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success">
                <div className="flex items-center justify-between gap-2 font-medium">
                  <span className="flex items-center gap-2">
                    <ClockIcon size={16} />
                    {completedTodayCount > 1
                      ? `${completedTodayCount} shifts done today`
                      : "Shift complete for today"}
                  </span>
                  <span className="text-base font-semibold tabular-nums">
                    <HoursMinsDisplay hours={todayWorkedHours} />
                  </span>
                </div>
                <p className="text-xs mt-1 text-success/80">
                  You worked {formatHoursMinsWords(todayWorkedHours)}
                  {clockedStore ? ` at ${clockedStore.name}` : ""} —{" "}
                  {todayShiftLabel ||
                    `clocked in ${formatTimeOnly(todayClock?.clock_in_at)} · clocked out ${formatTimeOnly(todayClock?.clock_out_at)}`}
                </p>
                <p className="text-[11px] mt-1 text-success/70">
                  Back later today? Just clock in again below.
                </p>
              </div>
            )}

            {/* Early start — waiting on the manager's code. Replaces the clock
                button entirely: there is nothing else to press until this is
                resolved one way or the other. */}
            {otpFlow && (
              <div className="rounded-xl border border-gold/40 bg-gold/5 p-4 flex flex-col gap-3">
                <div>
                  <div className="text-sm font-semibold text-gold">
                    You&apos;re starting your shift early. Ask your manager for an OTP
                    to clock in.
                  </div>
                  {otpFlow.scheduledStart && (
                    <p className="text-xs text-text-muted mt-1">
                      Your shift is booked to start at{" "}
                      <span className="tabular-nums font-medium text-text-primary">
                        {otpFlow.scheduledStart.slice(0, 5)}
                      </span>
                      .
                    </p>
                  )}
                  <p className="text-xs text-text-muted mt-0.5">
                    Your manager can see the code on their Live board at{" "}
                    {otpFlow.storeName}.
                  </p>
                </div>

                {otpDead ? (
                  <>
                    <p className="text-sm text-danger">
                      {otpLocked
                        ? "Too many wrong codes — ask your manager for a new one."
                        : "OTP expired — ask your manager for a new one."}
                    </p>
                    <Button onClick={requestNewOtp} loading={busy} className="w-full">
                      Request new OTP
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-text-muted tabular-nums">
                      Expires in {formatCountdown(otpExpiresAt - otpNow)}
                    </p>
                    <Input
                      label="4-digit OTP"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={4}
                      value={otpCode}
                      onChange={(e) =>
                        setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 4))
                      }
                      placeholder="0000"
                    />
                    <Button
                      onClick={submitOtp}
                      loading={busy}
                      disabled={busy || otpCode.length !== 4}
                      className="w-full"
                    >
                      Submit &amp; clock in
                    </Button>
                  </>
                )}
                <Button variant="outline" onClick={cancelOtp} disabled={busy} className="w-full">
                  Cancel
                </Button>
              </div>
            )}

            {/* Big primary action */}
            {!otpFlow && (
              <div className="flex flex-col gap-3">
                {/* Drivers enter short + long deliveries before clocking out */}
                {currentPhase === "out" && isDriver && (
                  <>
                    {earlierDropsToday.any && (
                      <p className="text-[11px] text-gold">
                        Earlier today you already logged {earlierDropsToday.short} short ·{" "}
                        {earlierDropsToday.long} long. Those are saved — enter only
                        what you did on THIS shift.
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="number"
                        min="0"
                        label="Short deliveries this shift *"
                        value={shortDeliveries}
                        onChange={(e) => setShortDeliveries(e.target.value)}
                        placeholder="0"
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Long deliveries this shift *"
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
                    : finishedShiftToday
                      ? `Start Another Shift${inRange && targetStore ? ` at ${targetStore.name}` : ""}`
                      : `Clock In${inRange && targetStore ? ` at ${targetStore.name}` : " Now"}`}
                </Button>

                {!inRange && geo.status === "ok" && (
                  <p className="text-xs text-danger text-center">
                    {currentPhase === "out"
                      ? "You're not within range of any store. Move closer to the store you're working at to clock out."
                      : "You're not within range of any store. Move closer to the store you're working at."}
                  </p>
                )}
                {geo.status === "ok" && (
                  <p className="text-[11px] text-text-muted text-center">
                    {currentPhase === "out"
                      ? `Clocked in at ${formatTimeOnly(openSession?.clock_in_at ?? todayClock?.clock_in_at)}${clockedStore ? ` · ${clockedStore.name}` : ""}.`
                      : "Tip: tap Refresh if you've just arrived and you're showing out of range."}
                  </p>
                )}
              </div>
            )}

            {/* Driver live-count refresh (during shift) */}
            {isDriver && clockedIn && (
              <div className="rounded-xl border border-border p-4">
                <div className="text-sm font-medium mb-1">Live delivery count</div>
                <p className="text-xs text-text-muted">
                  Update during your shift &mdash; cross-checked against Vita Mojo by your
                  manager.
                </p>
                {earlierDropsToday.any && (
                  <p className="text-[11px] text-gold mt-1">
                    Earlier today: {earlierDropsToday.short} short · {earlierDropsToday.long}{" "}
                    long, already saved. Count only this shift below.
                  </p>
                )}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    min="0"
                    label="Short this shift"
                    value={shortDeliveries}
                    onChange={(e) => setShortDeliveries(e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    label="Long this shift"
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

      {/* ---------- Reminder opt-in ---------- */}
      <ClockReminderOptIn
        saveSubscription={savePushSubscription}
        deleteSubscription={deletePushSubscription}
        sendTest={sendTestPush}
      />

      {/* ---------- Week shifts ---------- */}
      <Card className="p-0 overflow-hidden">
        <CardHeader
          className="px-5 pt-5 mb-0"
          action={
            <div className="text-right shrink-0">
              <div className="text-[10px] uppercase tracking-wider text-text-muted">
                Worked this week
              </div>
              <div className="text-lg font-semibold text-gold tabular-nums">
                <HoursMinsDisplay hours={weekWorkedHours} size="md" />
              </div>
            </div>
          }
        >
          <CardTitle>Your week</CardTitle>
          <CardDescription>
            {formatDDMMYYYY(weekStart)} – {formatDDMMYYYY(addDays(weekStart, 6))}. Your scheduled shift and the hours you actually worked.
          </CardDescription>
        </CardHeader>
        <div className="border-t border-border">
          {Array.from({ length: 7 }, (_, i) => {
            const date = addDays(weekStart, i);
            const dateIso = toISODate(date);
            const eff = effFor(dateIso, i);
            const clk = clockByDate.get(dateIso);
            const daySessions = sessionsByDate.get(dateIso) ?? [];
            const worked = clk ? resolvedDayHours(clk) : 0;
            const openToday = daySessions.some((s) => !s.clock_out_at);
            const isToday = dateIso === today;
            return (
              <div
                key={dateIso}
                className={
                  "px-5 py-3 border-b border-border last:border-0 flex items-center justify-between " +
                  (isToday ? "bg-gold/5" : "")
                }
              >
                <div>
                  <div className="text-sm font-medium">
                    {WEEKDAY_LONG[i]}{" "}
                    <span className="text-text-muted text-xs ml-1">
                      {formatDDMMYYYY(date)}
                    </span>
                  </div>
                </div>
                <div className="text-sm text-text-subtle text-right">
                  {eff
                    ? eff.is_day_off
                      ? <span className="text-danger">Day Off</span>
                      : <>
                          {eff.label}
                          {eff.reason && (
                            <span className="block text-[10px] text-warning mt-0.5">
                              {eff.reason}
                            </span>
                          )}
                          {eff.fromTemplate && (
                            <span className="block text-[10px] text-text-muted mt-0.5">
                              default schedule
                            </span>
                          )}
                        </>
                    : <span className="text-text-muted">No shift</span>}
                  {clk?.clock_in_at && (
                    <span className="block text-[11px] mt-0.5">
                      <span className="text-text-muted">
                        {/* Every shift of the day, so a split day reads as two
                            windows rather than one long one that never happened. */}
                        Worked{" "}
                        {daySessions.length > 0
                          ? daySessions
                              .map(
                                (s) =>
                                  `${formatTimeOnly(s.clock_in_at)}–${s.clock_out_at ? formatTimeOnly(s.clock_out_at) : "now"}`,
                              )
                              .join(", ")
                          : `${formatTimeOnly(clk.clock_in_at)}–${clk.clock_out_at ? formatTimeOnly(clk.clock_out_at) : "now"}`}
                      </span>{" "}
                      {worked > 0 && (
                        <span className="text-success font-medium">{formatHoursMinsWords(worked)}</span>
                      )}
                      {daySessions.length > 1 && (
                        <span className="text-text-muted"> · {daySessions.length} shifts</span>
                      )}
                      {openToday && (
                        <span className="block text-[10px] text-success">
                          On shift now
                        </span>
                      )}
                      {clk.auto_clocked_out && (
                        <span
                          className="block text-[10px] text-warning"
                          title="You didn't clock out — your scheduled shift end was used. Tell your manager if that's wrong."
                        >
                          auto clock-out (shift end used)
                        </span>
                      )}
                    </span>
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
