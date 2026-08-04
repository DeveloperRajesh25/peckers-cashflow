"use client";

// =============================================================
// "Hours you worked" — an employee's own past-week attendance.
//
// Everything else on /employee/shifts is the ROTA: what the manager planned.
// This block is the opposite — what actually happened, read from clock_events
// and the clock_sessions beneath them. The two are deliberately separated in
// the UI because they disagree often and for legitimate reasons (covering a
// shift, running late, a split day), and blending them into one row invites
// "why don't these match" questions that this feature exists to avoid.
//
// Hours come from resolvedDayHours, the SAME function payroll uses. If a
// manager corrected a mis-clocked day during approval, the employee sees the
// corrected figure — never the raw clock delta the manager already overruled.
// =============================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
} from "@/components/ui/icons";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import {
  WEEKDAY_LONG,
  addDays,
  formatDDMMYYYY,
  formatTimeOnly,
  parseISODate,
  resolvedDayHours,
  toISODate,
} from "@/lib/utils";
import type { ClockEvent, ClockSession } from "@/lib/types";

type Props = {
  /** Monday of the week being shown, YYYY-MM-DD. */
  weekStartIso: string;
  /** Monday of the earliest week that can be browsed to. */
  minWeekStartIso: string;
  /** Monday of the latest week that can be browsed to (the week before this one). */
  maxWeekStartIso: string;
  clocks: ClockEvent[];
  sessions: ClockSession[];
  /**
   * Set when the week's attendance could not be read. An empty list and a
   * failed query look identical on screen, and "you worked 0h last week" is a
   * far worse lie than "we couldn't load this" — so failures are surfaced.
   */
  loadError?: string | null;
};

export function PastWeekHours({
  weekStartIso,
  minWeekStartIso,
  maxWeekStartIso,
  clocks,
  sessions,
  loadError = null,
}: Props) {
  const router = useRouter();
  // useTransition, not a boolean: the flag has to clear itself when the new
  // week's server render arrives, or the buttons stay disabled forever.
  const [pending, startTransition] = React.useTransition();

  const weekStart = parseISODate(weekStartIso);

  const clockByDate = React.useMemo(() => {
    const m = new Map<string, ClockEvent>();
    for (const c of clocks) m.set(c.event_date, c);
    return m;
  }, [clocks]);

  // A day can hold several shifts — morning in, out, evening back in.
  const sessionsByDate = React.useMemo(() => {
    const m = new Map<string, ClockSession[]>();
    for (const s of sessions) {
      const arr = m.get(s.event_date) ?? [];
      arr.push(s);
      m.set(s.event_date, arr);
    }
    // By clock time, not seq — a shift a manager recorded after the fact can
    // carry a higher seq than one that happened earlier in the day.
    for (const arr of m.values())
      arr.sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at));
    return m;
  }, [sessions]);

  const days = React.useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(weekStart, i);
        const iso = toISODate(date);
        const clock = clockByDate.get(iso) ?? null;
        return {
          iso,
          date,
          label: WEEKDAY_LONG[i],
          clock,
          shifts: sessionsByDate.get(iso) ?? [],
          hours: clock ? resolvedDayHours(clock) : 0,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekStartIso, clockByDate, sessionsByDate],
  );

  const totalHours = days.reduce((sum, d) => sum + d.hours, 0);
  const daysWorked = days.filter((d) => d.hours > 0).length;

  const canGoBack = weekStartIso > minWeekStartIso;
  const canGoForward = weekStartIso < maxWeekStartIso;

  // The week lives in the URL so the server can fetch it — a client-side week
  // switch would have no attendance data to show.
  function goToWeek(iso: string) {
    if (iso < minWeekStartIso || iso > maxWeekStartIso) return;
    startTransition(() => {
      router.push(`/employee/shifts?week=${iso}`, { scroll: false });
    });
  }

  // <input type="date"> rather than type="week": week inputs are unsupported in
  // Safari and Firefox, and crew are overwhelmingly on phones. Any date the
  // employee picks is snapped back to its Monday.
  function onPickDate(value: string) {
    if (!value) return;
    const picked = parseISODate(value);
    if (isNaN(picked.getTime())) return;
    const monday = addDays(picked, -((picked.getDay() + 6) % 7));
    goToWeek(toISODate(monday));
  }

  const weekEnd = addDays(weekStart, 6);
  // The picker accepts ANY day inside a browsable week, not just its Monday —
  // an employee looking for "the Wednesday I worked late" shouldn't have to
  // work out which Monday that belongs to. onPickDate snaps it back.
  const maxPickableIso = toISODate(addDays(parseISODate(maxWeekStartIso), 6));

  return (
    <Card className="p-0 overflow-hidden">
      <CardHeader
        className="px-5 pt-5 mb-0"
        action={
          <div className="text-right shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              Total worked
            </div>
            <div className="text-lg font-semibold text-gold tabular-nums">
              <HoursMinsDisplay hours={totalHours} size="md" />
            </div>
          </div>
        }
      >
        <CardTitle className="flex items-center gap-2">
          <ClockIcon size={16} /> Hours you worked
        </CardTitle>
        <CardDescription>
          {formatDDMMYYYY(weekStart)} – {formatDDMMYYYY(weekEnd)} ·{" "}
          {daysWorked === 0
            ? "no days worked"
            : `${daysWorked} day${daysWorked === 1 ? "" : "s"} worked`}
        </CardDescription>
      </CardHeader>

      {/* Week picker */}
      <div className="px-5 pb-4 flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() => goToWeek(toISODate(addDays(weekStart, -7)))}
          disabled={!canGoBack || pending}
          iconLeft={<ChevronLeftIcon size={14} />}
        >
          Earlier
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => goToWeek(toISODate(addDays(weekStart, 7)))}
          disabled={!canGoForward || pending}
          iconRight={<ChevronRightIcon size={14} />}
        >
          Later
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <CalendarIcon size={14} />
          <span className="hidden sm:inline">Pick a week</span>
          <input
            type="date"
            value={weekStartIso}
            min={minWeekStartIso}
            max={maxPickableIso}
            onChange={(e) => onPickDate(e.target.value)}
            disabled={pending}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text-primary"
            aria-label="Pick a week to view"
          />
        </label>
      </div>

      {loadError ? (
        <div className="border-t border-border px-5 py-6 text-sm text-danger">
          {loadError}
        </div>
      ) : (
        <>
          <div className="border-t border-border">
            {days.map((d) => {
              const worked = d.hours > 0;
              return (
                <div
                  key={d.iso}
                  className="px-5 py-3 border-b border-border last:border-0 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {d.label}{" "}
                      <span className="text-text-muted text-xs ml-1">
                        {formatDDMMYYYY(d.date)}
                      </span>
                    </div>
                    {worked && (
                      <div className="text-[11px] text-text-muted mt-0.5">
                        {/* Every shift of the day, so a split day reads as two
                            windows rather than one long one that never was. */}
                        {d.shifts.length > 0
                          ? d.shifts
                              .map(
                                (s) =>
                                  `${formatTimeOnly(s.clock_in_at)}–${s.clock_out_at ? formatTimeOnly(s.clock_out_at) : "…"}`,
                              )
                              .join(", ")
                          : `${formatTimeOnly(d.clock?.clock_in_at)}–${d.clock?.clock_out_at ? formatTimeOnly(d.clock.clock_out_at) : "…"}`}
                        {d.shifts.length > 1 && (
                          <span className="text-gold"> · {d.shifts.length} shifts</span>
                        )}
                      </div>
                    )}
                    {d.clock?.hours_approved && (
                      <div
                        className="text-[10px] text-success mt-0.5"
                        title="Your manager has checked and signed off these hours."
                      >
                        approved by your manager
                      </div>
                    )}
                    {d.clock?.auto_clocked_out && (
                      <div
                        className="text-[10px] text-warning mt-0.5"
                        title="You didn't clock out — your scheduled shift end was used. Tell your manager if that's wrong."
                      >
                        auto clock-out (shift end used)
                      </div>
                    )}
                    {d.clock?.manual_entry && (
                      <div
                        className="text-[10px] text-warning mt-0.5"
                        title={
                          d.clock.manual_entry_reason
                            ? `Recorded by your manager — ${d.clock.manual_entry_reason}`
                            : "Recorded by your manager."
                        }
                      >
                        entered by your manager
                      </div>
                    )}
                  </div>
                  <div className="text-sm text-right shrink-0 tabular-nums">
                    {worked ? (
                      <span className="font-semibold text-success">
                        <HoursMinsDisplay hours={d.hours} />
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="px-5 py-3 border-t border-border bg-surface-hover/50 flex items-center justify-between">
            <span className="text-sm font-medium">Week total</span>
            <Badge variant="gold">
              <HoursMinsDisplay hours={totalHours} size="sm" />
            </Badge>
          </div>

          {totalHours === 0 && (
            <p className="px-5 pb-4 text-xs text-text-muted">
              No clocked hours recorded for this week. If you worked and this
              looks wrong, speak to your manager — they can add the missing
              times.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
