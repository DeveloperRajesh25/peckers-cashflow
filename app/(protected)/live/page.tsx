import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireUser } from "@/lib/supabase-server";
import { LiveDashboard } from "@/components/live/LiveDashboard";
import { todayISO } from "@/lib/utils";
import type {
  AllowedUser,
  ClockEvent,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  Employee,
  EmployeeScheduleDay,
  ManagerClockEvent,
  ManagerShift,
  RotaShift,
  Store,
} from "@/lib/types";

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
    schedulesRes,
    managersRes,
    managerClocksRes,
    managerShiftsRes,
    coverDriversRes,
    coverClocksRes,
    coverShiftsRes,
    coverSchedulesRes,
  ] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase.from("employees").select("*").neq("employment_status", "left"),
    supabase.from("rota_shifts").select("*").eq("shift_date", today),
    supabase.from("clock_events").select("*").eq("event_date", today),
    supabase.from("employee_schedules").select("*"),
    supabase.from("allowed_users").select("*").eq("role", "manager"),
    supabase.from("manager_clock_events").select("*").eq("event_date", today),
    supabase.from("manager_shifts").select("*").eq("shift_date", today),
    supabase.from("cover_drivers").select("*").eq("is_active", true),
    supabase.from("cover_driver_clock_events").select("*").eq("event_date", today),
    supabase.from("cover_driver_shifts").select("*").eq("shift_date", today),
    supabase.from("cover_driver_schedules").select("*"),
  ]);

  return (
    <>
      <PageHeader
        title="Live Daily Dashboard"
        description="Real-time staffing for today across both stores. Refreshes every 30 seconds."
      />
      <LiveDashboard
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as Employee[]}
        shifts={(shiftsRes.data ?? []) as RotaShift[]}
        clocks={(clocksRes.data ?? []) as ClockEvent[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        managers={(managersRes.data ?? []) as AllowedUser[]}
        managerClocks={(managerClocksRes.data ?? []) as ManagerClockEvent[]}
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
