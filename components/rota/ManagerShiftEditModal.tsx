"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Input, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { upsertManagerShift, deleteManagerShift } from "@/app/actions/manager-rota";
import { formatDDMMYYYY, formatHoursMins, shiftHours } from "@/lib/utils";
import type { AllowedUser, ManagerShift } from "@/lib/types";

type Props = {
  manager: AllowedUser;
  storeId: string;
  shiftDate: string;
  existing: ManagerShift | null;
  /** Previous day's times, used to pre-fill a brand-new shift. */
  prefill?: { start: string; end: string } | null;
  onClose: () => void;
  onSaved: () => void;
};

type Mode = "working" | "day_off";

export function ManagerShiftEditModal({
  manager,
  storeId,
  shiftDate,
  existing,
  prefill = null,
  onClose,
  onSaved,
}: Props) {
  const toast = useToast();

  const [mode, setMode] = React.useState<Mode>(existing?.is_day_off ? "day_off" : "working");
  const [start, setStart] = React.useState(
    existing?.start_time?.slice(0, 5) ?? prefill?.start ?? "",
  );
  const [end, setEnd] = React.useState(
    existing?.end_time?.slice(0, 5) ?? prefill?.end ?? "",
  );
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [busy, setBusy] = React.useState(false);

  const isDayOff = mode === "day_off";
  const calculated = !isDayOff && start && end ? shiftHours(start, end) : 0;
  const canSave = isDayOff || (!!start && !!end);

  async function save() {
    setBusy(true);
    try {
      await upsertManagerShift({
        manager_id: manager.id,
        store_id: storeId,
        shift_date: shiftDate,
        is_day_off: isDayOff,
        start_time: isDayOff ? null : start,
        end_time: isDayOff ? null : end,
        notes: notes || null,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return onClose();
    if (!confirm("Clear this shift?")) return;
    setBusy(true);
    try {
      await deleteManagerShift(existing.id);
      toast.success("Shift cleared");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${manager.name || manager.username || "Manager"} — ${formatDDMMYYYY(shiftDate)}`}
      description="Fixed daily wage — this schedules & tracks attendance only, it doesn't affect pay."
      size="md"
      footer={
        <>
          {existing && (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Clear
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!canSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Mode selector */}
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { key: "working", label: "Working" },
              { key: "day_off", label: "Day Off" },
            ] as { key: Mode; label: string }[]
          ).map((m) => {
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className={
                  "h-11 rounded-xl border text-sm font-medium transition-colors " +
                  (active
                    ? m.key === "day_off"
                      ? "bg-danger/15 border-danger/50 text-danger"
                      : "bg-gold text-black border-gold"
                    : "bg-surface border-border text-text-primary hover:bg-surface-hover")
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {mode === "working" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="time"
                label="Start"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
              <Input
                type="time"
                label="End"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            {!existing && prefill && (
              <p className="text-xs text-gold">
                Pre-filled from the previous day — adjust if needed.
              </p>
            )}
          </>
        )}

        {calculated > 0 && (
          <p className="text-xs text-text-muted">
            Scheduled hours:{" "}
            <span className="text-text-primary font-medium">{formatHoursMins(calculated)}h</span>
          </p>
        )}

        <Textarea
          label="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. covering the evening shift"
        />
      </div>
    </Modal>
  );
}
