"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Input, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { upsertWeeklyDelivery } from "@/app/actions/rota";
import { setClockDeliveries } from "@/app/actions/clock";
import { formatDDMMYYYY } from "@/lib/utils";
import type { ClockEvent, RotaEmployee, WeeklyDelivery } from "@/lib/types";

type Props = {
  driver: RotaEmployee;
  storeId: string;
  weekStartIso: string;
  existing: WeeklyDelivery | null;
  /** ISO dates (Mon–Sun) of the displayed week. */
  weekDays?: string[];
  /** The driver's clock events for the displayed week. */
  events?: ClockEvent[];
  onClose: () => void;
  onSaved: () => void;
};

export function DeliveryEditModal({
  driver,
  storeId,
  weekStartIso,
  existing,
  weekDays = [],
  events = [],
  onClose,
  onSaved,
}: Props) {
  const toast = useToast();
  const router = useRouter();
  const [avg, setAvg] = React.useState(
    existing?.manager_avg_4wk?.toString() ?? "",
  );
  const [vita, setVita] = React.useState(
    existing?.vita_mojo_count?.toString() ?? "",
  );
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [reason, setReason] = React.useState(existing?.reason ?? "");
  const [busy, setBusy] = React.useState(false);

  // Per-day clocked deliveries (editable by manager/admin). All edits are
  // persisted together by the single Save button at the bottom of the modal.
  type DayEdit = {
    short: string;
    long: string;
    extraShort: string;
    extraLong: string;
    reasonShort: string;
    reasonLong: string;
  };
  const initialDayEdits = React.useMemo(() => {
    const init: Record<string, DayEdit> = {};
    for (const d of weekDays) {
      const ev = events.find((e) => e.event_date === d);
      init[d] = {
        short: ev?.short_deliveries_count != null ? String(ev.short_deliveries_count) : "",
        long: ev?.long_deliveries_count != null ? String(ev.long_deliveries_count) : "",
        extraShort: ev?.extra_short_deliveries ? String(ev.extra_short_deliveries) : "",
        extraLong: ev?.extra_long_deliveries ? String(ev.extra_long_deliveries) : "",
        reasonShort: ev?.extra_short_reason ?? "",
        reasonLong: ev?.extra_long_reason ?? "",
      };
    }
    return init;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [dayEdits, setDayEdits] = React.useState<Record<string, DayEdit>>(initialDayEdits);

  function setDay(date: string, patch: Partial<DayEdit>) {
    setDayEdits((prev) => ({ ...prev, [date]: { ...prev[date], ...patch } }));
  }

  function dayChanged(date: string): boolean {
    const a = dayEdits[date];
    const b = initialDayEdits[date];
    if (!a || !b) return false;
    return (
      a.short !== b.short ||
      a.long !== b.long ||
      a.extraShort !== b.extraShort ||
      a.extraLong !== b.extraLong ||
      a.reasonShort !== b.reasonShort ||
      a.reasonLong !== b.reasonLong
    );
  }

  const needsReason =
    Number(avg) > 0 &&
    Number(vita) > 0 &&
    Number(avg) > Number(vita);

  async function save() {
    if (needsReason && !reason.trim()) {
      toast.error("Reason required when live count exceeds Vita Mojo.");
      return;
    }
    const changedDays = weekDays.filter(dayChanged);
    for (const d of changedDays) {
      const edit = dayEdits[d];
      if (Number(edit.extraShort) > 0 && !edit.reasonShort.trim()) {
        toast.error(`Reason required for the extra short deliveries on ${formatDDMMYYYY(d)}.`);
        return;
      }
      if (Number(edit.extraLong) > 0 && !edit.reasonLong.trim()) {
        toast.error(`Reason required for the extra long deliveries on ${formatDDMMYYYY(d)}.`);
        return;
      }
    }
    setBusy(true);
    try {
      await upsertWeeklyDelivery({
        driver_id: driver.id,
        store_id: storeId,
        week_start_date: weekStartIso,
        manager_avg_4wk: avg ? Number(avg) : null,
        vita_mojo_count: vita ? Number(vita) : null,
        notes: notes || null,
        reason: reason || null,
      });
      // Persist every edited day's clocked deliveries in the same save.
      for (const d of changedDays) {
        const edit = dayEdits[d];
        const res = await setClockDeliveries({
          employee_id: driver.id,
          event_date: d,
          short_deliveries_count: Number(edit.short) || 0,
          long_deliveries_count: Number(edit.long) || 0,
          extra_short_deliveries: Number(edit.extraShort) || 0,
          extra_long_deliveries: Number(edit.extraLong) || 0,
          extra_short_reason: edit.reasonShort.trim() || null,
          extra_long_reason: edit.reasonLong.trim() || null,
        });
        if (!res.ok) throw new Error(res.error);
      }
      router.refresh();
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
      title={`${driver.name} — Deliveries`}
      description="Manager-entered 4-week average, cross-checked against Vita Mojo each morning."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          type="number"
          label="4-Week Average (manager entry)"
          value={avg}
          onChange={(e) => setAvg(e.target.value)}
          placeholder="0"
          min="0"
        />
        <Input
          type="number"
          label="Vita Mojo count (cross-check)"
          value={vita}
          onChange={(e) => setVita(e.target.value)}
          placeholder="0"
          min="0"
        />
        {needsReason && (
          <Textarea
            label="Reason for variance *"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. extra drop-offs not on Vita Mojo"
          />
        )}
        <Textarea
          label="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {weekDays.length > 0 && (
          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium text-text-primary">Clocked deliveries (per day)</p>
            <p className="text-xs text-text-muted mb-3">
              Drivers normally enter these at clock-out. You can correct the count or
              log extra deliveries (with a reason) — everything is saved together by
              the Save button below.
            </p>
            <div className="flex flex-col gap-3">
              {weekDays.map((d) => {
                const edit = dayEdits[d];
                return (
                  <div key={d} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs text-text-muted">
                        {formatDDMMYYYY(d)}
                      </span>
                      {dayChanged(d) && <span className="text-[10px] text-gold">edited</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="number"
                        min="0"
                        label="Short"
                        value={edit?.short ?? ""}
                        onChange={(e) => setDay(d, { short: e.target.value })}
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Long"
                        value={edit?.long ?? ""}
                        onChange={(e) => setDay(d, { long: e.target.value })}
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Extra short"
                        value={edit?.extraShort ?? ""}
                        onChange={(e) => setDay(d, { extraShort: e.target.value })}
                      />
                      <Input
                        type="number"
                        min="0"
                        label="Extra long"
                        value={edit?.extraLong ?? ""}
                        onChange={(e) => setDay(d, { extraLong: e.target.value })}
                      />
                    </div>
                    {Number(edit?.extraShort) > 0 && (
                      <Input
                        label="Reason for extra short *"
                        value={edit?.reasonShort ?? ""}
                        onChange={(e) => setDay(d, { reasonShort: e.target.value })}
                        placeholder="e.g. covered a second area"
                        maxLength={200}
                        containerClassName="mt-2"
                      />
                    )}
                    {Number(edit?.extraLong) > 0 && (
                      <Input
                        label="Reason for extra long *"
                        value={edit?.reasonLong ?? ""}
                        onChange={(e) => setDay(d, { reasonLong: e.target.value })}
                        placeholder="e.g. out-of-area drop-off"
                        maxLength={200}
                        containerClassName="mt-2"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
