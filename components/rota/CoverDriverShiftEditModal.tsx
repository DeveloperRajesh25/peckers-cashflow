"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Input, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  upsertCoverDriverShift,
  deleteCoverDriverShift,
} from "@/app/actions/cover-driver-rota";
import { formatDDMMYYYY, formatGBP, shiftHours } from "@/lib/utils";
import type { CoverDriver, CoverDriverShift } from "@/lib/types";

type Props = {
  driver: CoverDriver;
  storeId: string;
  shiftDate: string;
  existing: CoverDriverShift | null;
  /** The driver's usual availability for this weekday, used to pre-fill. */
  prefill?: { start: string; end: string } | null;
  onClose: () => void;
  onSaved: () => void;
};

type Mode = "working" | "day_off";

export function CoverDriverShiftEditModal({
  driver,
  storeId,
  shiftDate,
  existing,
  prefill = null,
  onClose,
  onSaved,
}: Props) {
  const toast = useToast();

  const [mode, setMode] = React.useState<Mode>(
    existing?.is_day_off ? "day_off" : "working",
  );
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
      await upsertCoverDriverShift({
        cover_driver_id: driver.id,
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
    if (!confirm("Clear this shift? The day falls back to their usual availability.")) return;
    setBusy(true);
    try {
      await deleteCoverDriverShift(existing.id);
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
      title={`${driver.name} — ${formatDDMMYYYY(shiftDate)}`}
      description="Cover driver — this sets the expected shift for this date only. Pay still comes from what they actually clock."
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
                Pre-filled from their usual availability — adjust if needed.
              </p>
            )}
          </>
        )}

        {calculated > 0 && (
          <p className="text-xs text-text-muted">
            Scheduled hours:{" "}
            <span className="text-text-primary font-medium">{calculated.toFixed(2)}h</span>
            {" · "}approx{" "}
            <span className="text-text-primary font-medium">
              {formatGBP(calculated * Number(driver.hourly_cash_rate ?? 0))}
            </span>{" "}
            cash
          </p>
        )}

        <Textarea
          label="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. covering the Saturday evening rush"
        />
      </div>
    </Modal>
  );
}
