import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireUser } from "@/lib/supabase-server";
import { EmployeesView } from "@/components/employees/EmployeesView";
import { withContactEmails } from "@/lib/contact-email";
import { getAppSettings } from "@/app/actions/settings";
import { addDays, groupClockEventsByWeek, mapClockEventsToDaily, startOfISOWeek, toISODate, todayISO } from "@/lib/utils";
import { summariseCoverDriverDays } from "@/lib/cover-driver-hours";
import { mapManagerDaysToApproval } from "@/lib/manager-clock-sessions";
import { hasRole } from "@/lib/types";
import type {
  CoverDriver,
  CoverDriverClockEvent,
  Employee,
  ManagerClockEvent,
} from "@/lib/types";

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
    sessionsRes,
    coverDriversRes,
    coverClocksRes,
    coverHoursRes,
    managersRes,
    managerClocksRes,
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
      .select("id, employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, hours_approved, approved_hours, auto_clocked_out, manual_entry, manual_entry_reason, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, extra_short_reason, extra_long_reason")
      .gte("event_date", eightWeeksBack)
      .not("clock_out_at", "is", null)
      .order("event_date", { ascending: false }),
    // The individual shifts inside those days. A day can hold several, and the
    // approval row lists them under the total it is signing off.
    supabase
      .from("clock_sessions")
      .select(
        "id, clock_event_id, seq, clock_in_at, clock_out_at, auto_clocked_out, manual_entry, hours_approved, approved_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries",
      )
      .gte("event_date", eightWeeksBack)
      .order("clock_in_at", { ascending: true }),
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
    // Managers can cover deliveries on a busy night (migration 034). Those
    // drops are paid, so they need signing off here like anyone else's.
    supabase.from("allowed_users").select("id, name").eq("role", "manager"),
    supabase
      .from("manager_clock_events")
      .select("*")
      .gte("event_date", eightWeeksBack)
      .order("event_date", { ascending: false }),
  ]);

  const employees = await withContactEmails(supabase, (empRes.data ?? []) as Employee[]);
  const empMap = new Map(
    employees.map((e) => ({
      id: e.id,
      name: e.name,
      hourly_ni_rate: e.hourly_ni_rate,
      hourly_rate: e.hourly_rate,
      // Only a Driver earns the per-delivery allowance, so only their approval
      // row offers delivery inputs.
      is_driver: hasRole(e.position, "Driver"),
    })).map((e) => [e.id, e]),
  );
  // A failed clock query must not read as "nobody worked" on a payroll screen.
  if (clocksRes.error) {
    console.error("[employees] clock_events query failed:", clocksRes.error.message);
  }
  const clockSummaries = groupClockEventsByWeek(clocksRes.data ?? [], empMap);
  // Shifts keyed by the day they belong to, so an approval row can show the
  // windows that make up its total.
  const sessionsByEvent = new Map<string, NonNullable<typeof sessionsRes.data>>();
  for (const s of sessionsRes.data ?? []) {
    const arr = sessionsByEvent.get(s.clock_event_id) ?? [];
    arr.push(s);
    sessionsByEvent.set(s.clock_event_id, arr);
  }
  const clockDailySummaries = mapClockEventsToDaily(
    clocksRes.data ?? [],
    empMap,
    sessionsByEvent,
  );

  // Cover drivers are summarised per DAY, not per week — each cover shift is a
  // discrete engagement that is approved and paid on its own.
  const coverDrivers = (coverDriversRes.data ?? []) as CoverDriver[];
  const coverDriverDays = summariseCoverDriverDays(
    (coverClocksRes.data ?? []) as CoverDriverClockEvent[],
    coverDrivers,
  );

  const managerNames = new Map(
    (managersRes.data ?? []).map((m) => [m.id as string, (m.name as string) ?? "Manager"]),
  );
  const managerDaily = mapManagerDaysToApproval(
    (managerClocksRes.data ?? []) as ManagerClockEvent[],
    managerNames,
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
        clockDailySummaries={clockDailySummaries}
        managerDaily={managerDaily}
        loadError={clocksRes.error?.message ?? null}
        todayISO={todayISO()}
        stores={storesRes.data ?? []}
        defaultStoreId={user.allowed?.store_id ?? null}
        minWageBands={settings.min_wage_bands}
      />
    </>
  );
}
