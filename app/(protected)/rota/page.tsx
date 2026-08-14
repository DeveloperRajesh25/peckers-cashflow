import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireUser } from "@/lib/supabase-server";
import { RotaView } from "@/components/rota/RotaView";
import { getAppSettings } from "@/app/actions/settings";
import {
  addDays,
  parseISODate,
  resolveRotaRange,
  startOfISOWeek,
  toISODate,
  todayISO,
} from "@/lib/utils";
import type {
  AllowedUser,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  RotaEmployee,
  EmployeeScheduleDay,
  ManagerClockEvent,
  ManagerShift,
  RotaHistoryShift,
  RotaShift,
  Store,
  ClockEvent,
  WeeklyDelivery,
} from "@/lib/types";
import {
  COVER_SCHEDULE_COLUMNS,
  ROTA_CLOCK_COLUMNS,
  ROTA_EMPLOYEE_COLUMNS,
  ROTA_HISTORY_SHIFT_COLUMNS,
  ROTA_SHIFT_COLUMNS,
  SCHEDULE_COLUMNS,
} from "@/lib/rota-columns";

export const dynamic = "force-dynamic";

export default async function RotaPage({
  searchParams,
}: {
  searchParams: { start?: string; end?: string };
}) {
  const user = await requireUser();
  const supabase = createServerSupabase();
  const settings = await getAppSettings();

  // Visible range — defaults to the current ISO week, fully customizable via
  // ?start=&end= query params set by the calendar picker.
  const { startIso, endIso } = resolveRotaRange(searchParams.start, searchParams.end);
  // Weekly deliveries stay anchored to the ISO week containing the range start.
  const weekStartIso = toISODate(startOfISOWeek(parseISODate(startIso)));

  // For 4-week rolling avg we also fetch the prior 4 weeks of shifts
  const fourWeeksBack = toISODate(addDays(parseISODate(weekStartIso), -28));
  const dayBeforeRange = toISODate(addDays(parseISODate(startIso), -1));
  // No clock cell exists outside the visible range, and none can exist after
  // today — anything else the query returns is thrown away client-side.
  const clockEndIso = endIso < todayISO() ? endIso : todayISO();

  const [
    storesRes,
    employeesRes,
    shiftsRes,
    shiftHistoryRes,
    clocksRes,
    deliveriesRes,
    schedulesRes,
    managersRes,
    managerShiftsRes,
    managerClocksRes,
    coverDriversRes,
    coverShiftsRes,
    coverSchedulesRes,
    coverClocksRes,
  ] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("employees")
      .select(ROTA_EMPLOYEE_COLUMNS)
      .neq("employment_status", "left")
      .order("name"),
    supabase
      .from("rota_shifts")
      .select(ROTA_SHIFT_COLUMNS)
      .gte("shift_date", startIso)
      .lte("shift_date", endIso)
      .order("shift_date"),
    supabase
      .from("rota_shifts")
      .select(ROTA_HISTORY_SHIFT_COLUMNS)
      .gte("shift_date", fourWeeksBack)
      .lte("shift_date", dayBeforeRange)
      .order("shift_date"),
    supabase
      .from("clock_events")
      .select(ROTA_CLOCK_COLUMNS)
      .gte("event_date", startIso)
      .lte("event_date", clockEndIso),
    supabase
      .from("weekly_deliveries")
      .select("*")
      .eq("week_start_date", weekStartIso),
    supabase.from("employee_schedules").select(SCHEDULE_COLUMNS),
    supabase.from("allowed_users").select("*").eq("role", "manager"),
    supabase
      .from("manager_shifts")
      .select("*")
      .gte("shift_date", startIso)
      .lte("shift_date", endIso),
    supabase
      .from("manager_clock_events")
      .select("*")
      .gte("event_date", startIso)
      .lte("event_date", clockEndIso),
    supabase.from("cover_drivers").select("*").eq("is_active", true),
    supabase
      .from("cover_driver_shifts")
      .select("*")
      .gte("shift_date", startIso)
      .lte("shift_date", endIso),
    supabase.from("cover_driver_schedules").select(COVER_SCHEDULE_COLUMNS),
    supabase
      .from("cover_driver_clock_events")
      .select("*")
      .gte("event_date", startIso)
      .lte("event_date", clockEndIso),
  ]);

  return (
    <>
      <PageHeader
        title="Rota Management"
        description="Weekly staff scheduling. Hours and wages are auto-calculated. NI = first 20h, cash = remainder."
      />
      <RotaView
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as RotaEmployee[]}
        shifts={(shiftsRes.data ?? []) as RotaShift[]}
        historyShifts={(shiftHistoryRes.data ?? []) as RotaHistoryShift[]}
        clocks={(clocksRes.data ?? []) as ClockEvent[]}
        weeklyDeliveries={(deliveriesRes.data ?? []) as WeeklyDelivery[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        managers={(managersRes.data ?? []) as AllowedUser[]}
        managerShifts={(managerShiftsRes.data ?? []) as ManagerShift[]}
        managerClocks={(managerClocksRes.data ?? []) as ManagerClockEvent[]}
        coverDrivers={(coverDriversRes.data ?? []) as CoverDriver[]}
        coverDriverShifts={(coverShiftsRes.data ?? []) as CoverDriverShift[]}
        coverDriverSchedules={(coverSchedulesRes.data ?? []) as CoverDriverScheduleDay[]}
        coverDriverClocks={(coverClocksRes.data ?? []) as CoverDriverClockEvent[]}
        minWageBands={settings.min_wage_bands}
        shiftTimes={settings.shift_times}
        rangeStartIso={startIso}
        rangeEndIso={endIso}
        userRole={user.allowed?.role ?? "manager"}
        userStoreId={user.allowed?.store_id ?? null}
      />
    </>
  );
}
