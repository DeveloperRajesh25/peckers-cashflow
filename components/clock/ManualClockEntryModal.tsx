"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import {
  listOpenShiftsForDate,
  upsertManualClockEntry,
  type OpenShiftOnDay,
} from "@/app/actions/clock";
import { upsertManualCoverDriverClockEntry } from "@/app/actions/cover-driver-clock";
import {
  listOpenManagerShiftsForDate,
  upsertManualManagerClockEntry,
} from "@/app/actions/manager-clock";
import {
  addDays,
  formatDDMMYYYY,
  londonHHMM,
  londonISODate,
  parseISODate,
  shiftHours,
  timeToMinutes,
  toISODate,
} from "@/lib/utils";

// One modal for every timed entry point: employee / cover driver / manager ×
// Live board (same day, clock-out optional) / Daily Approval (yesterday, both
// required).
//
// The MANAGER mode records real times for a manager who worked and forgot to
// clock. It is not ManagerDeliveryEntryModal, which records drops for a day a
// manager was never on site and deliberately writes no times at all — see
// migration 037.

/** A person who can be picked, plus the shift time used to pre-fill. */
export type ManualEntryCandidate = {
  id: string;
  name: string;
  /** "HH:MM" scheduled start, if known — pre-fills the clock-in box. */
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  /**
   * Shifts already recorded for them that day. Non-zero means this entry ADDS
   * another shift rather than recording a missed one — a day can hold several
   * (migration 029), so they stay pickable, just labelled.
   */
  existing_shifts?: number;
  /**
   * Only a Driver earns a per-drop allowance, so only their card offers the
   * delivery boxes. Cover drivers are drivers by definition and the modal
   * treats every one of them as such regardless of this flag.
   */
  is_driver?: boolean;
  /** Their HOME store — what the store picker defaults to. */
  store_id?: string | null;
  /** Store of the shifts already recorded that day, for the mixed-day warning. */
  existing_store_id?: string | null;
};

const REASON_PRESETS = [
  "Forgot to clock in",
  "Phone / app issue",
  "Arrived before opening",
] as const;

export function ManualClockEntryModal({
  mode,
  candidates,
  eventDate,
  requireClockOut = false,
  title,
  stores,
  defaultStoreId,
  onClose,
  onSaved,
}: {
  mode: "employee" | "cover_driver" | "manager";
  candidates: ManualEntryCandidate[];
  eventDate: string;
  /** Daily Approval: the day is over, so both times are needed. */
  requireClockOut?: boolean;
  title?: string;
  /**
   * Offers the "store worked" picker. Passed only where the actor may choose —
   * admins on Daily Approval. A manager is held to their own store server-side,
   * and the Live board is already scoped to the store being looked at, so
   * neither gets a picker. Cover drivers belong to one store and never do.
   */
  stores?: Array<{ id: string; name: string }>;
  /**
   * Fixes the store the entry is recorded against, replacing the picker. The
   * Live board's cards are each one store, so an entry opened from a card
   * belongs to THAT store — not to the person's home store, which is what the
   * server would otherwise default an admin to for someone covering elsewhere.
   */
  defaultStoreId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [personId, setPersonId] = React.useState("");
  const [storeId, setStoreId] = React.useState("");
  const [inTime, setInTime] = React.useState("");
  const [outTime, setOutTime] = React.useState("");
  const [preset, setPreset] = React.useState<string>(REASON_PRESETS[0]);
  const [otherReason, setOtherReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Drops for the shift being recorded. Blank stays blank: an untouched box
  // records nothing rather than an explicit zero, which is what the "No
  // deliveries" warning on Daily Approval is there to catch.
  const [shortDrops, setShortDrops] = React.useState("");
  const [longDrops, setLongDrops] = React.useState("");
  const [extraShort, setExtraShort] = React.useState("");
  const [extraLong, setExtraLong] = React.useState("");
  const [extraShortReason, setExtraShortReason] = React.useState("");
  const [extraLongReason, setExtraLongReason] = React.useState("");
  // Shifts still running on this day, keyed by person. Fetched rather than
  // passed in: a day with an open shift has no header clock-out, so it never
  // reaches Daily Approval's summaries and no screen holds its times.
  const [openShifts, setOpenShifts] = React.useState<Map<string, OpenShiftOnDay>>(
    new Map(),
  );
  const [openLookupFailed, setOpenLookupFailed] = React.useState(false);

  React.useEffect(() => {
    // Cover drivers work a single shift a day, so there is never one running to
    // be offered for closing.
    if (mode === "cover_driver") return;
    let cancelled = false;
    const lookup =
      mode === "manager"
        ? listOpenManagerShiftsForDate(eventDate).then((res) =>
            res.ok
              ? {
                  ok: true as const,
                  shifts: res.shifts.map((s) => ({ ...s, employee_id: s.manager_id })),
                }
              : res,
          )
        : listOpenShiftsForDate(eventDate);
    lookup.then((res) => {
      if (cancelled) return;
      if (!res.ok) return setOpenLookupFailed(true);
      setOpenLookupFailed(false);
      setOpenShifts(new Map(res.shifts.map((s) => [s.employee_id, s])));
    });
    return () => {
      cancelled = true;
    };
  }, [mode, eventDate]);

  const selected = candidates.find((c) => c.id === personId) ?? null;
  const openForSelected = selected ? openShifts.get(selected.id) ?? null : null;
  // A shift that is already running can only be completed, never left open —
  // the server refuses a second open shift for the same person.
  const mustClockOut = requireClockOut || !!openForSelected;
  // Cover drivers all drive; employees only if their position says so. NEVER a
  // manager: their clock entry records times only, and their drops go through
  // "Add manager entry" on Daily Approval.
  const showDeliveries = mode === "cover_driver" || !!selected?.is_driver;

  const extraShortNeedsReason = (Number(extraShort) || 0) > 0 && !extraShortReason.trim();
  const extraLongNeedsReason = (Number(extraLong) || 0) > 0 && !extraLongReason.trim();
  const anyDrop =
    !!shortDrops.trim() || !!longDrops.trim() || !!extraShort.trim() || !!extraLong.trim();

  // Pre-fill from the shift already running, else from the scheduled one, so
  // the common case is pick → save. A running shift wins: its clock-in is a
  // recorded fact, and the only thing missing is when they finished. It stays
  // editable — the manager may be correcting a start time that was wrong.
  React.useEffect(() => {
    if (!selected) return;
    const open = openShifts.get(selected.id) ?? null;
    setInTime(open?.clock_in_time ?? selected.scheduled_start?.slice(0, 5) ?? "");
    setOutTime(open || !requireClockOut ? "" : selected.scheduled_end?.slice(0, 5) ?? "");
    // The store the open shift was recorded against, else the one the caller is
    // acting on, else their home store or wherever the day's existing shifts
    // already sit — covering elsewhere is the exception, so it stays a
    // deliberate change.
    setStoreId(
      open?.store_id ??
        defaultStoreId ??
        selected.existing_store_id ??
        selected.store_id ??
        "",
    );
    // Deliberately not keyed on `openShifts` itself: it lands after the modal
    // opens, and re-running on every change would wipe a clock-out already
    // typed. Keying on the open shift's id re-fills only when one is found for
    // the person currently picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, openForSelected?.session_id, requireClockOut]);

  // A fixed store leaves nothing to choose, so `stores` is then only the name
  // lookup the warnings below read.
  const showStorePicker =
    mode === "employee" && !!stores && stores.length > 1 && !defaultStoreId;
  const awayFromHome =
    mode === "employee" &&
    !!storeId &&
    !!selected?.store_id &&
    storeId !== selected.store_id;
  // A day carries ONE store (deriveDayHeader takes the latest shift's), and the
  // payout bills the whole day to it. So adding a shift at another store does
  // not split the day — it moves all of it, including hours already recorded.
  const movesExistingDay =
    mode === "employee" &&
    !!storeId &&
    !!selected?.existing_shifts &&
    !!selected.existing_store_id &&
    selected.existing_store_id !== storeId;
  const storeNameOf = (id: string | null | undefined) =>
    stores?.find((s) => s.id === id)?.name ?? "another store";

  const reason = preset === "Other" ? otherReason.trim() : preset;

  // A clock-out at or before the clock-in crossed midnight (14:00 → 00:00 is a
  // ten-hour shift). Shown before saving so the next-day end isn't a surprise.
  const bothTimes = !!inTime && !!outTime;
  const sameTime = bothTimes && timeToMinutes(inTime) === timeToMinutes(outTime);
  const overnight = bothTimes && !sameTime && timeToMinutes(outTime) < timeToMinutes(inTime);
  const workedHours = bothTimes && !sameTime ? shiftHours(inTime, outTime) : null;
  // The server closes the running shift only when the submitted window COVERS
  // it; a window that ends before it started is a different shift entirely and
  // is added beside it, leaving the person still clocked in. Rare, but silent —
  // so it is said out loud before saving.
  const missesOpenShift =
    !!openForSelected &&
    bothTimes &&
    !sameTime &&
    !overnight &&
    timeToMinutes(outTime) <= timeToMinutes(openForSelected.clock_in_time);
  const endDate = overnight
    ? toISODate(addDays(parseISODate(eventDate), 1))
    : eventDate;

  // Hours nobody has worked yet can't be recorded, and the server refuses them.
  // Compared in UK wall clock rather than instants: the person filling this in
  // may be in another timezone, where their own midnight is a different moment.
  const now = new Date();
  const londonNow = londonISODate(now);
  const notYetWorked =
    bothTimes &&
    !sameTime &&
    (endDate > londonNow ||
      (endDate === londonNow && timeToMinutes(outTime) > timeToMinutes(londonHHMM(now))));

  const canSave =
    !!personId &&
    !!inTime &&
    (!showStorePicker || !!storeId) &&
    (mode !== "employee" || !defaultStoreId || !!storeId) &&
    (!mustClockOut || !!outTime) &&
    !sameTime &&
    !notYetWorked &&
    !!reason &&
    !(showDeliveries && (extraShortNeedsReason || extraLongNeedsReason)) &&
    !busy;

  /** Omitted entirely when nothing was typed, so the server writes no counts. */
  function deliveryPayload() {
    if (!showDeliveries || !anyDrop) return undefined;
    return {
      short_deliveries_count: Number(shortDrops) || 0,
      long_deliveries_count: Number(longDrops) || 0,
      extra_short_deliveries: Number(extraShort) || 0,
      extra_long_deliveries: Number(extraLong) || 0,
      extra_short_reason: extraShortReason.trim() || null,
      extra_long_reason: extraLongReason.trim() || null,
    };
  }

  async function save() {
    setError(null);
    if (!personId) return setError("Pick who this is for.");
    if (mode === "employee" && !storeId && (showStorePicker || defaultStoreId)) {
      return setError("Pick the store they worked at.");
    }
    if (!inTime) return setError("Enter the clock-in time.");
    if (mustClockOut && !outTime) {
      return setError(
        openForSelected
          ? "Enter when they finished — a shift that's still running can't be left open."
          : "Enter the clock-out time.",
      );
    }
    if (!reason) return setError("Give a reason.");
    if (showDeliveries && extraShortNeedsReason) {
      return setError("Give a reason for the extra short deliveries.");
    }
    if (showDeliveries && extraLongNeedsReason) {
      return setError("Give a reason for the extra long deliveries.");
    }

    setBusy(true);
    try {
      const deliveries = deliveryPayload();
      const res =
        mode === "employee"
          ? await upsertManualClockEntry({
              employee_id: personId,
              event_date: eventDate,
              clock_in_time: inTime,
              clock_out_time: outTime || null,
              reason,
              deliveries,
              // Omitted only where the UI knows no store at all, which leaves
              // the server on its existing default rather than asserting one.
              store_id: showStorePicker || defaultStoreId ? storeId : undefined,
            })
          : mode === "manager"
            ? await upsertManualManagerClockEntry({
                manager_id: personId,
                event_date: eventDate,
                clock_in_time: inTime,
                clock_out_time: outTime || null,
                reason,
                // The open shift's own store when one is being closed, else
                // the card's — never the manager's home store.
                store_id: storeId || defaultStoreId || undefined,
              })
            : await upsertManualCoverDriverClockEntry({
                cover_driver_id: personId,
                event_date: eventDate,
                clock_in_time: inTime,
                clock_out_time: outTime || null,
                reason,
                deliveries,
              });

      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(
        openForSelected
          ? `Clock-out recorded for ${selected?.name ?? "them"}`
          : `Clock-in recorded for ${selected?.name ?? "them"}`,
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const label =
    mode === "employee" ? "Employee" : mode === "manager" ? "Manager" : "Cover driver";

  return (
    <Modal
      open
      onClose={onClose}
      title={title ?? `Add ${label.toLowerCase()} clock-in`}
      description={`${formatDDMMYYYY(eventDate)} — records hours without a location check, so it's logged as a manual entry.`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!canSave}>
            {openForSelected ? "Save clock-out" : "Save clock-in"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {candidates.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nobody available to record right now — everyone {mode === "employee" ? "on shift" : "working"}{" "}
            is either currently clocked in or not attached to this store today.
          </p>
        ) : (
          <>
            <Select
              label={`${label} *`}
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
            >
              <option value="">Select…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {/* One child, not two: React joins multiple option children
                      with a comma, which rendered names as "Harish,". */}
                  {openShifts.has(c.id)
                    ? `${c.name} — still clocked in from ${openShifts.get(c.id)!.clock_in_time}`
                    : c.existing_shifts
                      ? `${c.name} — ${c.existing_shifts} shift${c.existing_shifts > 1 ? "s" : ""} already today`
                      : c.scheduled_start
                        ? `${c.name} — scheduled ${c.scheduled_start.slice(0, 5)}`
                        : c.name}
                </option>
              ))}
            </Select>

            {openForSelected && (
              <p className="text-xs text-text-primary bg-gold/10 border border-gold/30 rounded-xl px-3 py-2 -mt-1">
                {selected?.name} is still clocked in from{" "}
                <span className="font-medium">{openForSelected.clock_in_time}</span> on
                this day. Enter when they finished and this{" "}
                <span className="font-medium">closes that shift</span> rather than adding
                a second one. Correct the clock-in above if it was recorded wrong.
              </p>
            )}

            {!!selected?.existing_shifts && !openForSelected && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                {selected.name} already has {selected.existing_shifts} shift
                {selected.existing_shifts > 1 ? "s" : ""} recorded that day. This adds
                another — the times must not overlap one already recorded.
              </p>
            )}

            {openLookupFailed && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                Couldn&apos;t check who is still clocked in on that day, so the clock-in
                box isn&apos;t pre-filled. Times already recorded are still protected —
                the save is refused if they overlap.
              </p>
            )}

            {/* Staff cover across stores, so where they worked is a fact only
                the person recording it knows — and it decides which store's
                Tuesday payout pays the day. */}
            {showStorePicker && (
              <Select
                label="Store worked *"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                disabled={!selected}
              >
                <option value="">Select…</option>
                {stores!.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id === selected?.store_id ? `${s.name} — home store` : s.name}
                  </option>
                ))}
              </Select>
            )}

            {/* Shown with or without the picker — a fixed store still decides
                which sheet pays the day, and that is the surprise. */}
            {awayFromHome && (
              <p className="text-xs text-text-muted bg-bg border border-border rounded-xl px-3 py-2 -mt-1">
                {selected?.name} is based at {storeNameOf(selected?.store_id)}, so this
                day is <span className="text-text-primary">covering</span>. It goes on{" "}
                {storeNameOf(storeId)}&apos;s Tuesday payout, and every hour is paid in
                cash — hours away from the home store don&apos;t count towards their
                weekly NI allowance.
              </p>
            )}

            {movesExistingDay && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                That day already has shifts recorded at{" "}
                {storeNameOf(selected?.existing_store_id)}. A day can only belong to one
                store, so saving this will move the WHOLE day — including the hours
                already there — onto {storeNameOf(storeId)}&apos;s payout. Record it at{" "}
                {storeNameOf(selected?.existing_store_id)} instead if that isn&apos;t
                what you want.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input
                type="time"
                label="Clock-in *"
                value={inTime}
                onChange={(e) => setInTime(e.target.value)}
              />
              <Input
                type="time"
                label={mustClockOut ? "Clock-out *" : "Clock-out"}
                value={outTime}
                onChange={(e) => setOutTime(e.target.value)}
              />
            </div>

            {sameTime && (
              <p className="text-xs text-danger -mt-1">
                Clock-out can&apos;t be the same time as clock-in.
              </p>
            )}

            {missesOpenShift && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                These times finish before the shift that&apos;s running started (
                {openForSelected!.clock_in_time}), so they&apos;ll be recorded as a
                separate shift and {selected?.name} will still be clocked in. Set the
                clock-out after {openForSelected!.clock_in_time} to close that shift
                instead.
              </p>
            )}

            {workedHours != null && (
              <p className="text-xs text-text-muted -mt-1 flex items-center gap-1 flex-wrap">
                <HoursMinsDisplay hours={workedHours} />
                <span>
                  {overnight
                    ? `— overnight, finishing ${outTime} on ${formatDDMMYYYY(endDate)}.`
                    : "."}
                </span>
              </p>
            )}

            {notYetWorked && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                That shift ends at {outTime} on {formatDDMMYYYY(endDate)}, which hasn&apos;t
                happened yet, so the hours can&apos;t be recorded.{" "}
                {mustClockOut
                  ? "Come back once the shift has finished."
                  : "Leave clock-out blank if they're still working — they can clock out themselves."}
              </p>
            )}

            {!mustClockOut && (
              <p className="text-xs text-text-muted -mt-1">
                Leave clock-out blank if they&apos;re still working — they can clock out
                themselves as normal.
              </p>
            )}

            {/* A manager's fixed daily wage turns on their clock-in existing, so
                this is only for a shift they actually worked. The drops-only
                path on Daily Approval is the one for a day they weren't in. */}
            {mode === "manager" && (
              <p className="text-xs text-text-muted bg-bg border border-border rounded-xl px-3 py-2 -mt-1">
                Times only. Recording them marks {selected?.name ?? "them"} as having
                worked that day, so their fixed daily wage counts towards the
                store&apos;s wage bill on this board. Deliveries they covered go on{" "}
                <span className="text-text-primary">Add manager entry</span> on Daily
                Approval.
              </p>
            )}

            <Select
              label="Reason *"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
            >
              {REASON_PRESETS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="Other">Other…</option>
            </Select>

            {preset === "Other" && (
              <Input
                label="Reason *"
                placeholder="What happened?"
                value={otherReason}
                onChange={(e) => setOtherReason(e.target.value)}
                maxLength={200}
              />
            )}

            {/* Drops for the shift being recorded. Without these a manually
                entered day paid the hours but zero deliveries, which for a
                driver is most of their money — the manager had to go and
                correct it on Daily Approval afterwards, if they remembered. */}
            {showDeliveries && (
              <div className="rounded-xl border border-border bg-bg px-3 py-3 flex flex-col gap-3">
                <p className="text-xs font-medium text-text-primary">
                  Deliveries for this shift
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    label="Short (SD)"
                    value={shortDrops}
                    onChange={(e) => setShortDrops(e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    label="Long (LD)"
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

                {(Number(extraShort) || 0) > 0 && (
                  <Input
                    label="Reason for extra short *"
                    placeholder="Why were these beyond the round?"
                    value={extraShortReason}
                    onChange={(e) => setExtraShortReason(e.target.value)}
                    maxLength={200}
                  />
                )}
                {(Number(extraLong) || 0) > 0 && (
                  <Input
                    label="Reason for extra long *"
                    placeholder="Why were these beyond the round?"
                    value={extraLongReason}
                    onChange={(e) => setExtraLongReason(e.target.value)}
                    maxLength={200}
                  />
                )}

                <p className="text-[11px] text-text-muted">
                  Leave blank if you don&apos;t know the counts — the day is flagged
                  “No deliveries” on Daily Approval so they can be filled in there.
                  MS / ML are drops beyond the normal round, paid at the same rate.
                </p>
              </div>
            )}

            {error && (
              <p className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-xl px-3 py-2">
                {error}
              </p>
            )}

            <p className="text-xs text-text-muted rounded-xl border border-border bg-bg px-3 py-2.5">
              This is recorded against your account and shown as{" "}
              <span className="text-text-primary">Manual</span> wherever the day appears.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
