"use client";

// =============================================================
// Early clock-in authorisations on the Live board (migration 043).
//
// An employee trying to start before their booked shift is refused until they
// type a code. This is where the manager reads that code off — so it renders
// for ANY logged-in manager or admin, with no dependence on their own clock
// row, their own shift, or their own geofence. The call often comes while the
// manager is at home; gating the panel on being on shift would make the whole
// feature unusable exactly when it is needed.
// =============================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cancelEarlyClockInRequest } from "@/app/actions/early-clock-in";
import { minutesEarly } from "@/lib/early-clock-in";
import { formatTimeOnly, londonHHMM, timeToMinutes } from "@/lib/utils";
import type { EarlyClockInRequest } from "@/lib/types";

type Props = {
  requests: EarlyClockInRequest[];
  /** Admin sees every store at once, so each row has to say which. */
  showStore?: boolean;
};

/** "17:00:00" from a `time` column — the seconds are never meaningful here. */
function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : "—";
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function EarlyClockInOtpPanel({ requests, showStore = false }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [denying, setDenying] = React.useState<string | null>(null);
  // Null until mounted: a seconds-granularity countdown rendered on the server
  // never matches the one the browser computes a moment later.
  const [now, setNow] = React.useState<number | null>(null);

  const pending = requests.filter((r) => r.status === "pending");
  const started = requests.filter((r) => r.status === "used");

  // Only while somebody is actually waiting — the "started early" log doesn't
  // move, and a second-by-second tick over a static list is waste.
  const hasPending = pending.length > 0;
  React.useEffect(() => {
    if (!hasPending) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [hasPending]);

  if (pending.length === 0 && started.length === 0) return null;

  async function deny(requestId: string) {
    setDenying(requestId);
    try {
      const res = await cancelEarlyClockInRequest({ requestId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Early start denied.");
      router.refresh();
    } finally {
      setDenying(null);
    }
  }

  return (
    <Card className="border-gold/40 p-0 overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <h2 className="text-sm font-semibold tracking-wide text-gold">
          Early clock-in requests
        </h2>
        <p className="text-xs text-text-muted mt-0.5">
          Read the code out to the employee only if you asked them to start early.
        </p>
      </div>

      {pending.length > 0 && (
        <div className="flex flex-col">
          {pending.map((r) => (
            <div
              key={r.id}
              className="px-5 py-3 border-b border-border last:border-0 flex items-center justify-between gap-4 flex-wrap bg-gold/5"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-text-primary">
                  {r.employee_name}
                  {showStore && r.store_name && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-muted">
                      {r.store_name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5 tabular-nums">
                  Booked {hhmm(r.scheduled_start)} · asked at{" "}
                  {formatTimeOnly(r.requested_at)}
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <div className="font-mono text-2xl font-bold tracking-[0.3em] text-gold tabular-nums">
                    {r.otp_code}
                  </div>
                  <div className="text-[11px] text-text-muted tabular-nums">
                    {now == null
                      ? " "
                      : `expires in ${countdown(new Date(r.expires_at).getTime() - now)}`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => deny(r.id)}
                  loading={denying === r.id}
                  disabled={!!denying}
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {started.length > 0 && (
        <div className="border-t border-border">
          <div className="px-5 py-2 bg-surface-hover text-[10px] uppercase tracking-wider text-text-muted">
            Started early today · {started.length}
          </div>
          {started.map((r) => {
            const early =
              r.scheduled_start && r.actual_clock_in_at
                ? minutesEarly(
                    timeToMinutes(londonHHMM(new Date(r.actual_clock_in_at))),
                    timeToMinutes(r.scheduled_start),
                  )
                : null;
            return (
              <div
                key={r.id}
                className="px-5 py-2.5 border-b border-border last:border-0 flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-text-primary truncate">
                  {r.employee_name}
                  {showStore && r.store_name && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-muted">
                      {r.store_name}
                    </span>
                  )}
                </span>
                <span className="text-xs text-text-muted tabular-nums shrink-0">
                  Booked {hhmm(r.scheduled_start)} · in{" "}
                  {formatTimeOnly(r.actual_clock_in_at)}
                  {early != null && early > 0 && (
                    <span className="ml-1.5 text-warning font-medium">
                      {early} min early
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
