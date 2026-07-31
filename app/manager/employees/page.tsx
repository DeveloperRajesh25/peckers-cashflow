import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { hasRole, resolveActiveStoreId } from "@/lib/types";
import { EmployeesView } from "@/components/employees/EmployeesView";
import { withContactEmails } from "@/lib/contact-email";
import { getAppSettings } from "@/app/actions/settings";
import { addDays, groupClockEventsByWeek, mapClockEventsToDaily, startOfISOWeek, toISODate, todayISO } from "@/lib/utils";
import { summariseCoverDriverDays } from "@/lib/cover-driver-hours";
import type { CoverDriver, CoverDriverClockEvent, Employee } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ManagerEmployeesPage() {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed) ?? "";
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
  ] = await Promise.all([
    supabase
      .from("employees")
      .select("*")
      .eq("store_id", storeId)
      .order("employment_status")
      .order("name"),
    supabase
      .from("employee_hours_computed")
      .select("*")
      .order("week_start_date", { ascending: false })
      .limit(500),
    supabase.from("stores").select("*").eq("id", storeId),
    supabase
      .from("clock_events")
      .select("id, employee_id, store_id, event_date, clock_in_at, clock_out_at, worked_hours, hours_approved, approved_hours, auto_clocked_out, manual_entry, manual_entry_reason, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries, extra_short_reason, extra_long_reason")
      .eq("store_id", storeId)
      .gte("event_date", eightWeeksBack)
      .not("clock_out_at", "is", null)
      .order("event_date", { ascending: false }),
    // The individual shifts inside those days. A day can hold several, and the
    // approval row lists them under the total it is signing off.
    supabase
      .from("clock_sessions")
      .select("clock_event_id, seq, clock_in_at, clock_out_at, auto_clocked_out, manual_entry")
      .eq("store_id", storeId)
      .gte("event_date", eightWeeksBack)
      .order("clock_in_at", { ascending: true }),
    supabase.from("cover_drivers").select("*").eq("store_id", storeId).order("name"),
    supabase
      .from("cover_driver_clock_events")
      .select("*")
      .eq("store_id", storeId)
      .gte("event_date", eightWeeksBack)
      .not("clock_out_at", "is", null)
      .order("event_date", { ascending: false }),
    supabase
      .from("cover_driver_hours_computed")
      .select("*")
      .eq("store_id", storeId)
      .order("work_date", { ascending: false })
      .limit(500),
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
    console.error("[manager/employees] clock_events query failed:", clocksRes.error.message);
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

  return (
    <>
      <PageHeader
        title="Employees"
        description="Your store's staff. New employees get an auto-generated crew login."
      />
      <EmployeesView
        initialEmployees={employees}
        initialHours={(hoursRes.data ?? []) as any[]}
        coverDrivers={coverDrivers}
        coverDriverDays={coverDriverDays}
        coverDriverHours={(coverHoursRes.data ?? []) as any[]}
        clockSummaries={clockSummaries}
        clockDailySummaries={clockDailySummaries}
        loadError={clocksRes.error?.message ?? null}
        todayISO={todayISO()}
        stores={storesRes.data ?? []}
        defaultStoreId={storeId || null}
        minWageBands={settings.min_wage_bands}
        lockToStore
        canManualLog={false}
        canEditContactEmail={false}
      />
    </>
  );
}
