import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { findEmployeeForUser } from "@/lib/employee-lookup";
import { CrewClockApp } from "@/components/crew/CrewClockApp";
import {
  endOfISOWeek,
  startOfISOWeek,
  toISODate,
  todayISO,
} from "@/lib/utils";
import type {
  ClockEvent,
  ClockSession,
  Employee,
  EmployeeScheduleDay,
  RotaShift,
  Store,
} from "@/lib/types";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function AttendancePage() {
  const user = await requireRole(["employee"]);
  const supabase = createServerSupabase();

  const employee = await findEmployeeForUser(supabase, user.id, user.email);

  if (!employee) {
    return (
      <>
        <PageHeader title="Clock In/Out" description="Log the start and end of your shift." />
        <Card>
          <p className="text-sm text-text-muted">
            Your login isn&apos;t linked to a crew profile yet. Please ask your
            manager to check your account.
          </p>
        </Card>
      </>
    );
  }

  const today = todayISO();
  const weekStart = startOfISOWeek(new Date());
  const weekEnd = endOfISOWeek(new Date());

  const [storesRes, shiftsRes, weekClocksRes, weekSessionsRes, schedulesRes] =
    await Promise.all([
    // All stores — staff can clock in at whichever one they're physically at,
    // not only their home store.
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("rota_shifts")
      .select("*")
      .eq("employee_id", employee.id)
      .gte("shift_date", toISODate(weekStart))
      .lte("shift_date", toISODate(weekEnd))
      .order("shift_date"),
    // Whole week of clock events so the crew screen can show worked hours per
    // day + a weekly total. Today's row is derived from this set.
    supabase
      .from("clock_events")
      .select("*")
      .eq("employee_id", employee.id)
      .gte("event_date", toISODate(weekStart))
      .lte("event_date", toISODate(weekEnd)),
    // A day can hold several shifts, so the individual in/out pairs come from
    // clock_sessions — the clock_events row above is only the day's header.
    supabase
      .from("clock_sessions")
      .select("*")
      .eq("employee_id", employee.id)
      .gte("event_date", toISODate(weekStart))
      .lte("event_date", toISODate(weekEnd))
      .order("clock_in_at", { ascending: true }),
    supabase
      .from("employee_schedules")
      .select("*")
      .eq("employee_id", employee.id),
  ]);

  const weekClocks = (weekClocksRes.data ?? []) as ClockEvent[];
  const todayClock = weekClocks.find((c) => c.event_date === today) ?? null;

  return (
    <>
      <PageHeader
        title={`Hi ${employee.name.split(" ")[0]}`}
        description="Clock in & out. Location is required — you must be at your store."
      />
      <CrewClockApp
        employee={employee as Employee}
        stores={(storesRes.data ?? []) as Store[]}
        weekShifts={(shiftsRes.data ?? []) as RotaShift[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        todayClock={todayClock}
        weekClocks={weekClocks}
        weekSessions={(weekSessionsRes.data ?? []) as ClockSession[]}
      />
    </>
  );
}
