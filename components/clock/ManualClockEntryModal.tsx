"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { upsertManualClockEntry } from "@/app/actions/clock";
import { upsertManualCoverDriverClockEntry } from "@/app/actions/cover-driver-clock";
import {
  addDays,
  formatDDMMYYYY,
  formatHoursMins,
  londonHHMM,
  londonISODate,
  parseISODate,
  shiftHours,
  timeToMinutes,
  toISODate,
} from "@/lib/utils";

// One modal for all four entry points: employee / cover driver × Live board
// (same day, clock-out optional) / Daily Approval (yesterday, both required).

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
  onClose,
  onSaved,
}: {
  mode: "employee" | "cover_driver";
  candidates: ManualEntryCandidate[];
  eventDate: string;
  /** Daily Approval: the day is over, so both times are needed. */
  requireClockOut?: boolean;
  title?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [personId, setPersonId] = React.useState("");
  const [inTime, setInTime] = React.useState("");
  const [outTime, setOutTime] = React.useState("");
  const [preset, setPreset] = React.useState<string>(REASON_PRESETS[0]);
  const [otherReason, setOtherReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selected = candidates.find((c) => c.id === personId) ?? null;

  // Pre-fill from the scheduled shift so the common case is pick → save.
  React.useEffect(() => {
    if (!selected) return;
    setInTime(selected.scheduled_start?.slice(0, 5) ?? "");
    if (requireClockOut) setOutTime(selected.scheduled_end?.slice(0, 5) ?? "");
  }, [selected, requireClockOut]);

  const reason = preset === "Other" ? otherReason.trim() : preset;

  // A clock-out at or before the clock-in crossed midnight (14:00 → 00:00 is a
  // ten-hour shift). Shown before saving so the next-day end isn't a surprise.
  const bothTimes = !!inTime && !!outTime;
  const sameTime = bothTimes && timeToMinutes(inTime) === timeToMinutes(outTime);
  const overnight = bothTimes && !sameTime && timeToMinutes(outTime) < timeToMinutes(inTime);
  const workedHours = bothTimes && !sameTime ? shiftHours(inTime, outTime) : null;
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
    (!requireClockOut || !!outTime) &&
    !sameTime &&
    !notYetWorked &&
    !!reason &&
    !busy;

  async function save() {
    setError(null);
    if (!personId) return setError("Pick who this is for.");
    if (!inTime) return setError("Enter the clock-in time.");
    if (requireClockOut && !outTime) return setError("Enter the clock-out time.");
    if (!reason) return setError("Give a reason.");

    setBusy(true);
    try {
      const res =
        mode === "employee"
          ? await upsertManualClockEntry({
              employee_id: personId,
              event_date: eventDate,
              clock_in_time: inTime,
              clock_out_time: outTime || null,
              reason,
            })
          : await upsertManualCoverDriverClockEntry({
              cover_driver_id: personId,
              event_date: eventDate,
              clock_in_time: inTime,
              clock_out_time: outTime || null,
              reason,
            });

      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(`Clock-in recorded for ${selected?.name ?? "them"}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const label = mode === "employee" ? "Employee" : "Cover driver";

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
            Save clock-in
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
                  {c.existing_shifts
                    ? `${c.name} — ${c.existing_shifts} shift${c.existing_shifts > 1 ? "s" : ""} already today`
                    : c.scheduled_start
                      ? `${c.name} — scheduled ${c.scheduled_start.slice(0, 5)}`
                      : c.name}
                </option>
              ))}
            </Select>

            {!!selected?.existing_shifts && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                {selected.name} already has {selected.existing_shifts} shift
                {selected.existing_shifts > 1 ? "s" : ""} recorded that day. This adds
                another — the times must not overlap one already recorded.
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
                label={requireClockOut ? "Clock-out *" : "Clock-out"}
                value={outTime}
                onChange={(e) => setOutTime(e.target.value)}
              />
            </div>

            {sameTime && (
              <p className="text-xs text-danger -mt-1">
                Clock-out can&apos;t be the same time as clock-in.
              </p>
            )}

            {workedHours != null && (
              <p className="text-xs text-text-muted -mt-1">
                {formatHoursMins(workedHours)}h
                {overnight
                  ? ` — overnight, finishing ${outTime} on ${formatDDMMYYYY(endDate)}.`
                  : "."}
              </p>
            )}

            {notYetWorked && (
              <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-xl px-3 py-2 -mt-1">
                That shift ends at {outTime} on {formatDDMMYYYY(endDate)}, which hasn&apos;t
                happened yet, so the hours can&apos;t be recorded.{" "}
                {requireClockOut
                  ? "Come back once the shift has finished."
                  : "Leave clock-out blank if they're still working — they can clock out themselves."}
              </p>
            )}

            {!requireClockOut && (
              <p className="text-xs text-text-muted -mt-1">
                Leave clock-out blank if they&apos;re still working — they can clock out
                themselves as normal.
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
