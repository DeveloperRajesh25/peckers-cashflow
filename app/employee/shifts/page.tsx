import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { findEmployeeForUser } from "@/lib/employee-lookup";
import { PastWeekHours } from "@/components/crew/PastWeekHours";
import {
  WEEKDAY_LONG,
  addDays,
  formatDDMMYYYY,
  formatShiftRange,
  parseISODate,
  shiftHours,
  startOfISOWeek,
  toISODate,
  todayISO,
  weekLabel,
} from "@/lib/utils";
import type {
  ClockEvent,
  ClockSession,
  EmployeeScheduleDay,
  RotaShift,
} from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * How far back crew can browse their own hours. Bounded so a hand-edited URL
 * can't ask for an unbounded range, and because attendance older than a quarter
 * is a payroll question for a manager, not a self-service one.
 */
const MAX_HISTORY_WEEKS = 12;

/**
 * Resolve the past week to display from the `?week=` param: the Monday of that
 * week, clamped to [12 weeks back, last week]. Anything missing or unparseable
 * falls back to LAST week, which is the default this feature exists to serve.
 */
function resolvePastWeek(
  raw: string | undefined,
  thisWeekStart: Date,
): { weekStart: Date; minWeekStart: Date; maxWeekStart: Date } {
  // The newest browsable week is the one that has finished — never this week,
  // which the block above already shows and which is still accruing hours.
  const maxWeekStart = addDays(thisWeekStart, -7);
  const minWeekStart = addDays(thisWeekStart, -7 * MAX_HISTORY_WEEKS);

  let weekStart = maxWeekStart;
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = parseISODate(raw);
    if (!isNaN(parsed.getTime())) weekStart = startOfISOWeek(parsed);
  }
  if (weekStart.getTime() < minWeekStart.getTime()) weekStart = minWeekStart;
  if (weekStart.getTime() > maxWeekStart.getTime()) weekStart = maxWeekStart;

  return { weekStart, minWeekStart, maxWeekStart };
}

function WeekBlock({
  weekStart,
  shifts,
  schedules,
}: {
  weekStart: Date;
  shifts: RotaShift[];
  schedules: EmployeeScheduleDay[];
}) {
  const today = todayISO();
  const byDate = new Map(shifts.map((s) => [s.shift_date, s]));
  const tmplByWeekday = new Map(schedules.map((s) => [s.weekday, s]));

  // Resolve each day: published rota row first, else the recurring template.
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    const iso = toISODate(date);
    const shift = byDate.get(iso);
    if (shift) {
      return {
        iso,
        date,
        label: WEEKDAY_LONG[i],
        kind: shift.is_day_off ? ("off" as const) : ("shift" as const),
        start: shift.start_time,
        end: shift.end_time,
        reason: shift.same_day_edit_reason,
        hours: shift.is_day_off ? 0 : shiftHours(shift.start_time, shift.end_time),
      };
    }
    const tmpl = tmplByWeekday.get(i);
    if (tmpl && tmpl.is_working && tmpl.start_time) {
      return {
        iso,
        date,
        label: WEEKDAY_LONG[i],
        kind: "default" as const,
        start: tmpl.start_time,
        end: tmpl.end_time,
        reason: null,
        hours: shiftHours(tmpl.start_time, tmpl.end_time),
      };
    }
    return {
      iso,
      date,
      label: WEEKDAY_LONG[i],
      kind: "none" as const,
      start: null,
      end: null,
      reason: null,
      hours: 0,
    };
  });

  const total = days.reduce((sum, d) => sum + d.hours, 0);

  return (
    <Card className="p-0 overflow-hidden">
      <CardHeader className="px-5 pt-5 flex-row items-center justify-between">
        <CardTitle>{weekLabel(weekStart)}</CardTitle>
        <Badge variant="gold">{total.toFixed(1)}h</Badge>
      </CardHeader>
      <div className="border-t border-border">
        {days.map((d) => {
          const isToday = d.iso === today;
          return (
            <div
              key={d.iso}
              className={
                "px-5 py-3 border-b border-border last:border-0 flex items-center justify-between " +
                (isToday ? "bg-gold/5" : "")
              }
            >
              <div className="text-sm font-medium">
                {d.label}{" "}
                <span className="text-text-muted text-xs ml-1">
                  {formatDDMMYYYY(d.date)}
                </span>
              </div>
              <div className="text-sm text-text-subtle text-right">
                {d.kind === "off" ? (
                  <span className="text-danger">Day Off</span>
                ) : d.kind === "shift" ? (
                  <>
                    {formatShiftRange(false, d.start, d.end)}
                    {d.reason && (
                      <span className="block text-[10px] text-warning mt-0.5">
                        {d.reason}
                      </span>
                    )}
                  </>
                ) : d.kind === "default" ? (
                  <>
                    {formatShiftRange(false, d.start, d.end)}
                    <span className="block text-[10px] text-text-muted mt-0.5">
                      default schedule
                    </span>
                  </>
                ) : (
                  <span className="text-text-muted">No shift</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams?: { week?: string };
}) {
  const user = await requireRole(["employee"]);
  const supabase = createServerSupabase();

  const employee = await findEmployeeForUser(supabase, user.id, user.email);

  const thisWeek = startOfISOWeek(new Date());
  const nextWeek = addDays(thisWeek, 7);
  const rangeStart = toISODate(thisWeek);
  const rangeEnd = toISODate(addDays(nextWeek, 6));

  const { weekStart: pastWeek, minWeekStart, maxWeekStart } = resolvePastWeek(
    searchParams?.week,
    thisWeek,
  );
  const pastStart = toISODate(pastWeek);
  const pastEnd = toISODate(addDays(pastWeek, 6));

  const [shiftsData, schedulesData, pastClocksRes, pastSessionsRes] = employee
    ? await Promise.all([
        supabase
          .from("rota_shifts")
          .select("*")
          .eq("employee_id", employee.id)
          .gte("shift_date", rangeStart)
          .lte("shift_date", rangeEnd)
          .order("shift_date"),
        supabase
          .from("employee_schedules")
          .select("*")
          .eq("employee_id", employee.id),
        // What actually happened that week. Scoped to this employee explicitly
        // as well as by RLS — the belt-and-braces filter means a future policy
        // change can't quietly widen what crew see of each other.
        supabase
          .from("clock_events")
          .select("*")
          .eq("employee_id", employee.id)
          .gte("event_date", pastStart)
          .lte("event_date", pastEnd),
        // The day's individual shifts; the clock_events row is only the header.
        supabase
          .from("clock_sessions")
          .select("*")
          .eq("employee_id", employee.id)
          .gte("event_date", pastStart)
          .lte("event_date", pastEnd)
          .order("clock_in_at", { ascending: true }),
      ])
    : [{ data: [] }, { data: [] }, { data: [], error: null }, { data: [], error: null }];

  const shifts = (shiftsData.data ?? []) as RotaShift[];
  const schedules = (schedulesData.data ?? []) as EmployeeScheduleDay[];

  // A failed query and a week with no work look identical once rendered, and
  // "you worked 0h" is a far more damaging thing to show wrongly than an error.
  const pastLoadError =
    ("error" in pastClocksRes && pastClocksRes.error) ||
    ("error" in pastSessionsRes && pastSessionsRes.error)
      ? "We couldn't load your hours for this week. Pull to refresh, or try again shortly."
      : null;

  const thisWeekShifts = shifts.filter((s) => s.shift_date < toISODate(nextWeek));
  const nextWeekShifts = shifts.filter((s) => s.shift_date >= toISODate(nextWeek));

  return (
    <>
      <PageHeader
        title="My Shifts"
        description="Your rota for this week and next, plus the hours you've already worked. Days shown as “default schedule” come from your standard weekly pattern until the manager publishes the rota."
      />
      <div className="flex flex-col gap-5">
        <WeekBlock weekStart={thisWeek} shifts={thisWeekShifts} schedules={schedules} />
        <WeekBlock weekStart={nextWeek} shifts={nextWeekShifts} schedules={schedules} />
        {employee && (
          <PastWeekHours
            weekStartIso={pastStart}
            minWeekStartIso={toISODate(minWeekStart)}
            maxWeekStartIso={toISODate(maxWeekStart)}
            clocks={(pastClocksRes.data ?? []) as ClockEvent[]}
            sessions={(pastSessionsRes.data ?? []) as ClockSession[]}
            loadError={pastLoadError}
          />
        )}
      </div>
    </>
  );
}
