import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireUser } from "@/lib/supabase-server";
import { EmployeesView } from "@/components/employees/EmployeesView";
import { getAppSettings } from "@/app/actions/settings";
import { addDays, groupClockEventsByWeek, startOfISOWeek, toISODate } from "@/lib/utils";
import { summariseCoverDriverDays } from "@/lib/cover-driver-hours";
import type { CoverDriver, CoverDriverClockEvent, Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  const user = await requireUser();
  const supabase = createServerSupabase();
  const settings = await getAppSettings();

  const eightWeeksBack = toISODate(addDays(startOfISOWeek(new Date()), -56));

  const [
    empRes,
    hoursRes,
    storesRes,
    clocksRes,
    coverDriversRes,
    coverClocksRes,
    coverHoursRes,
  ] = await Promise.all([
    supabase
      .from("employees")
      .select("*")
      .order("employment_status")
      .order("name"),
    supabase
      .from("employee_hours_computed")
      .select("*")
      .order("week_start_date", { ascending: false })
      .limit(500),
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("clock_events")
      .select("employee_id, event_date, clock_in_at, clock_out_at")
      .gte("event_date", eightWeeksBack)
      .not("clock_out_at", "is", null)
      .order("event_date", { ascending: false }),
    supabase.from("cover_drivers").select("*").order("name"),
    supabase
      .from("cover_driver_clock_events")
      .select("*")
      .gte("event_date", eightWeeksBack)
      .not("clock_out_at", "is", null)
      .order("event_date", { ascending: false }),
    supabase
      .from("cover_driver_hours_computed")
      .select("*")
      .order("work_date", { ascending: false })
      .limit(500),
  ]);

  const employees = (empRes.data ?? []) as Employee[];
  const empMap = new Map(
    employees.map((e) => ({
      id: e.id,
      name: e.name,
      hourly_ni_rate: e.hourly_ni_rate,
      hourly_rate: e.hourly_rate,
    })).map((e) => [e.id, e]),
  );
  const clockSummaries = groupClockEventsByWeek(clocksRes.data ?? [], empMap);

  // Cover drivers are summarised per DAY, not per week — each cover shift is a
  // discrete engagement that is approved and paid on its own.
  const coverDrivers = (coverDriversRes.data ?? []) as CoverDriver[];
  const coverDriverDays = summariseCoverDriverDays(
    (coverClocksRes.data ?? []) as CoverDriverClockEvent[],
    coverDrivers,
  );

  return (
    <>
      <PageHeader
        title="Employees"
        description="Full profile, pay rates, bank details, store assignment. Required for payroll & rota."
      />
      <EmployeesView
        initialEmployees={employees}
        initialHours={(hoursRes.data ?? []) as any[]}
        coverDrivers={coverDrivers}
        coverDriverDays={coverDriverDays}
        coverDriverHours={(coverHoursRes.data ?? []) as any[]}
        clockSummaries={clockSummaries}
        stores={storesRes.data ?? []}
        defaultStoreId={user.allowed?.store_id ?? null}
        minWageBands={settings.min_wage_bands}
      />
    </>
  );
}
