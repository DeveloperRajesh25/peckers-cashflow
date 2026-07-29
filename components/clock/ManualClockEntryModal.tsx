"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { upsertManualClockEntry } from "@/app/actions/clock";
import { upsertManualCoverDriverClockEntry } from "@/app/actions/cover-driver-clock";
import { formatDDMMYYYY } from "@/lib/utils";

// One modal for all four entry points: employee / cover driver × Live board
// (same day, clock-out optional) / Daily Approval (yesterday, both required).

/** A person who can be picked, plus the shift time used to pre-fill. */
export type ManualEntryCandidate = {
  id: string;
  name: string;
  /** "HH:MM" scheduled start, if known — pre-fills the clock-in box. */
  scheduled_start?: string | null;
  scheduled_end?: string | null;
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
  const canSave =
    !!personId && !!inTime && (!requireClockOut || !!outTime) && !!reason && !busy;

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
            Everyone {mode === "employee" ? "on shift" : "working"} that day already has a
            clock record — nothing to add.
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
                  {c.name}
                  {c.scheduled_start ? ` — scheduled ${c.scheduled_start.slice(0, 5)}` : ""}
                </option>
              ))}
            </Select>

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
