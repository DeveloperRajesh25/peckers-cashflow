"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  getCoverDriverSchedule,
  saveCoverDriverSchedule,
  type CoverDriverScheduleInput,
} from "@/app/actions/cover-driver-schedule";
import { WEEKDAY_LONG, formatHoursMins, shiftHours } from "@/lib/utils";
import type { CoverDriver } from "@/lib/types";

type DayState = { is_working: boolean; start_time: string; end_time: string };

const EMPTY: DayState = { is_working: false, start_time: "", end_time: "" };

export function CoverDriverScheduleModal({
  driver,
  onClose,
  onSaved,
}: {
  driver: CoverDriver;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const [days, setDays] = React.useState<DayState[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getCoverDriverSchedule(driver.id)
      .then((rows) => {
        if (!active) return;
        setDays(
          Array.from({ length: 7 }, (_, wd) => {
            const r = rows.find((x) => x.weekday === wd);
            return {
              is_working: r?.is_working ?? false,
              start_time: r?.start_time?.slice(0, 5) ?? "",
              end_time: r?.end_time?.slice(0, 5) ?? "",
            };
          }),
        );
      })
      .catch(() => {
        if (active) setDays(Array.from({ length: 7 }, () => ({ ...EMPTY })));
      });
    return () => {
      active = false;
    };
  }, [driver.id]);

  function setDay(wd: number, patch: Partial<DayState>) {
    setDays((prev) =>
      prev ? prev.map((d, i) => (i === wd ? { ...d, ...patch } : d)) : prev,
    );
  }

  async function save() {
    if (!days) return;
    for (let wd = 0; wd < 7; wd++) {
      const d = days[wd];
      if (d.is_working && (!d.start_time || !d.end_time)) {
        toast.error(`Enter start & end time for ${WEEKDAY_LONG[wd]}, or mark it off.`);
        return;
      }
    }
    setBusy(true);
    try {
      const payload: CoverDriverScheduleInput[] = days.map((d, wd) => ({
        weekday: wd,
        is_working: d.is_working,
        start_time: d.start_time || null,
        end_time: d.end_time || null,
      }));
      await saveCoverDriverSchedule(driver.id, payload);
      toast.success("Availability saved");
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const totalHours = days
    ? days.reduce(
        (s, d) =>
          d.is_working && d.start_time && d.end_time
            ? s + shiftHours(d.start_time, d.end_time)
            : s,
        0,
      )
    : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Weekly schedule — ${driver.name}`}
      description="The days this cover driver is usually available. This is a guide, not a booking — it pre-fills their Rota cells, but you still book each date on the Rota."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!days}>
            Save schedule
          </Button>
        </>
      }
    >
      {!days ? (
        <p className="text-sm text-text-muted py-6 text-center">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {days.map((d, wd) => (
            <div
              key={wd}
              className="flex items-center gap-3 rounded-xl border border-border p-3"
            >
              <label className="flex items-center gap-2 w-28 sm:w-32 shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={d.is_working}
                  onChange={(e) => setDay(wd, { is_working: e.target.checked })}
                  className="h-4 w-4 accent-gold"
                />
                <span className="text-sm font-medium">{WEEKDAY_LONG[wd]}</span>
              </label>
              {d.is_working ? (
                <div className="flex items-center gap-2 flex-1">
                  <Input
                    type="time"
                    value={d.start_time}
                    onChange={(e) => setDay(wd, { start_time: e.target.value })}
                    containerClassName="flex-1"
                  />
                  <span className="text-text-muted">–</span>
                  <Input
                    type="time"
                    value={d.end_time}
                    onChange={(e) => setDay(wd, { end_time: e.target.value })}
                    containerClassName="flex-1"
                  />
                </div>
              ) : (
                <span className="text-sm text-text-muted flex-1">Not available</span>
              )}
            </div>
          ))}
          <p className="text-xs text-text-muted mt-1">
            Total available:{" "}
            <span className="text-text-primary font-medium">
              {formatHoursMins(totalHours)}h/week
            </span>
          </p>
        </div>
      )}
    </Modal>
  );
}
