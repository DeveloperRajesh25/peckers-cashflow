import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireUser } from "@/lib/supabase-server";
import { LiveDashboard } from "@/components/live/LiveDashboard";
import { todayISO } from "@/lib/utils";
import type {
  AllowedUser,
  ClockEvent,
  LiveClockSession,
  LiveEmployee,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  Employee,
  EmployeeScheduleDay,
  ManagerClockEvent,
  ManagerClockSession,
  ManagerShift,
  RotaShift,
  Store,
} from "@/lib/types";
import {
  COVER_SCHEDULE_COLUMNS,
  LIVE_CLOCK_SESSION_COLUMNS,
  LIVE_EMPLOYEE_COLUMNS,
  SCHEDULE_COLUMNS,
} from "@/lib/rota-columns";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const user = await requireUser();
  const supabase = createServerSupabase();
  const today = todayISO();

  const [
    storesRes,
    employeesRes,
    shiftsRes,
    clocksRes,
    sessionsRes,
    schedulesRes,
    managersRes,
    managerClocksRes,
    managerSessionsRes,
    managerShiftsRes,
    coverDriversRes,
    coverClocksRes,
    coverShiftsRes,
    coverSchedulesRes,
  ] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase.from("employees").select(LIVE_EMPLOYEE_COLUMNS).neq("employment_status", "left"),
    supabase.from("rota_shifts").select("*").eq("shift_date", today),
    supabase.from("clock_events").select("*").eq("event_date", today),
    // The day's individual shifts — the clock row above is only its header.
    supabase
      .from("clock_sessions")
      .select(LIVE_CLOCK_SESSION_COLUMNS)
      .eq("event_date", today)
      .order("clock_in_at", { ascending: true }),
    supabase.from("employee_schedules").select(SCHEDULE_COLUMNS),
    supabase.from("allowed_users").select("*").eq("role", "manager"),
    supabase.from("manager_clock_events").select("*").eq("event_date", today),
    // A manager's day can hold several shifts — the clock row above is only its
    // header, so hours have to be summed from these or a split day would count
    // the gap between shifts.
    supabase
      .from("manager_clock_sessions")
      .select("*")
      .eq("event_date", today)
      .order("clock_in_at", { ascending: true }),
    supabase.from("manager_shifts").select("*").eq("shift_date", today),
    supabase.from("cover_drivers").select("*").eq("is_active", true),
    supabase.from("cover_driver_clock_events").select("*").eq("event_date", today),
    supabase.from("cover_driver_shifts").select("*").eq("shift_date", today),
    supabase.from("cover_driver_schedules").select(COVER_SCHEDULE_COLUMNS),
  ]);

  return (
    <>
      <PageHeader
        title="Live Daily Dashboard"
        description="Real-time staffing for today across both stores. Refreshes every 30 seconds."
      />
      <LiveDashboard
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as LiveEmployee[]}
        shifts={(shiftsRes.data ?? []) as RotaShift[]}
        clocks={(clocksRes.data ?? []) as ClockEvent[]}
        clockSessions={(sessionsRes.data ?? []) as LiveClockSession[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        managers={(managersRes.data ?? []) as AllowedUser[]}
        managerClocks={(managerClocksRes.data ?? []) as ManagerClockEvent[]}
        managerClockSessions={(managerSessionsRes.data ?? []) as ManagerClockSession[]}
        managerShifts={(managerShiftsRes.data ?? []) as ManagerShift[]}
        coverDrivers={(coverDriversRes.data ?? []) as CoverDriver[]}
        coverDriverClocks={(coverClocksRes.data ?? []) as CoverDriverClockEvent[]}
        coverDriverShifts={(coverShiftsRes.data ?? []) as CoverDriverShift[]}
        coverDriverSchedules={(coverSchedulesRes.data ?? []) as CoverDriverScheduleDay[]}
        userRole={user.allowed?.role ?? "manager"}
        userStoreId={user.allowed?.store_id ?? null}
      />
    </>
  );
}
