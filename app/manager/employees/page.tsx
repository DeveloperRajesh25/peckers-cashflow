import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { hasRole, resolveActiveStoreId } from "@/lib/types";
import { EmployeesView } from "@/components/employees/EmployeesView";
import { getAppSettings } from "@/app/actions/settings";
import { addDays, groupClockEventsByWeek, mapClockEventsToDaily, startOfISOWeek, toISODate, todayISO } from "@/lib/utils";
import { summariseCoverDriverDays } from "@/lib/cover-driver-hours";
import { mapManagerDaysToApproval } from "@/lib/manager-clock-sessions";
import type {
  CoverDriver,
  CoverDriverClockEvent,
  Employee,
  EmployeeSummary,
  EntryEmployeeDay,
  ManagerClockEvent,
} from "@/lib/types";

type EntryEmployee = Pick<Employee, "id" | "name" | "position" | "store_id">;

export const dynamic = "force-dynamic";

// Daily Approval and the Weekly Log need identity, store and rates — nothing
// else. The full profile is loaded by the Employees tab that renders it.
const APPROVAL_EMPLOYEE_COLUMNS =
  "id, name, position, store_id, employment_status, is_active, hourly_rate, hourly_ni_rate";

export default async function ManagerEmployeesPage() {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed) ?? "";
  const supabase = createServerSupabase();
  const settings = await getAppSettings();

  const eightWeeksBack = toISODate(addDays(startOfISOWeek(new Date()), -56));

  const [
    empRes,
    entryEmpRes,
    entryDaysRes,
    storesRes,
    allStoresRes,
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
      .select(APPROVAL_EMPLOYEE_COLUMNS)
      .eq("store_id", storeId)
      .order("employment_status")
      .order("name"),
    // The whole estate's staff. Two things need it. The missed-entry picker
    // must reach someone based at the other store who covered a shift here, and
    // the approval/weekly rows must be able to NAME and RATE them — a clock row
    // is filed under the store the shift happened at, so a visitor's day lands
    // on this screen while they are absent from the roster above. Display stays
    // scoped to storeId; only the identity lookup is estate-wide.
    supabase
      .from("employees")
      .select(APPROVAL_EMPLOYEE_COLUMNS)
      .order("name"),
    // The days those people already have recorded at their OWN store, over the
    // same window this screen navigates. Without them a visiting employee reads
    // as having worked nothing that day, and the modal cannot warn that saving
    // here moves the WHOLE day onto this store's payout. Non-sensitive columns
    // only — no hours, no rates, no delivery counts.
    supabase
      .from("clock_events")
      .select("employee_id, event_date, store_id, session_count, clock_in_at")
      .neq("store_id", storeId)
      .gte("event_date", eightWeeksBack),
    supabase.from("stores").select("*").eq("id", storeId),
    // Names only, so the missed-entry modal can say which store a visitor is
    // based at. Kept apart from `stores` above, which scopes the rest of the page.
    supabase.from("stores").select("id, name").order("name"),
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
      .select(
        "id, clock_event_id, seq, clock_in_at, clock_out_at, auto_clocked_out, manual_entry, hours_approved, approved_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries",
      )
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
    // Managers at THIS store, and their clocked days. A manager may sign off a
    // peer's drops as well as their own — the client's explicit call, since the
    // people covering a busy night are the ones who saw it happen.
    supabase.from("allowed_users").select("id, name").eq("role", "manager"),
    supabase
      .from("manager_clock_events")
      .select("*")
      .eq("store_id", storeId)
      .gte("event_date", eightWeeksBack)
      .order("event_date", { ascending: false }),
  ]);

  const employees = (empRes.data ?? []) as unknown as EmployeeSummary[];
  const estateEmployees = (entryEmpRes.data ?? []) as unknown as EmployeeSummary[];
  // Keyed over the ESTATE, not this store's roster. A miss here doesn't just
  // blank the name — it also loses `is_driver`, so the row renders with no
  // delivery inputs, and the rates, so the Weekly Log splits at zero.
  const empMap = new Map(
    estateEmployees.map((e) => ({
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

  // Active staff only, projected back to the four columns the picker needs —
  // the rates the map above uses are server-side and stay there.
  const entryPickerEmployees: EntryEmployee[] = estateEmployees
    .filter((e) => e.employment_status === "active")
    .map((e) => ({
      id: e.id,
      name: e.name,
      position: e.position,
      store_id: e.store_id,
    }));

  const managerAccounts = (managersRes.data ?? []).map((m) => ({
    id: m.id as string,
    name: (m.name as string) ?? "Manager",
  }));
  const managerNames = new Map(managerAccounts.map((m) => [m.id, m.name]));
  const managerDaily = mapManagerDaysToApproval(
    (managerClocksRes.data ?? []) as ManagerClockEvent[],
    managerNames,
  );

  return (
    <>
      <PageHeader
        title="Employees"
        description="Your store's staff. New employees get an auto-generated crew login."
      />
      <EmployeesView
        initialEmployees={employees}
        coverDrivers={coverDrivers}
        coverDriverDays={coverDriverDays}
        coverDriverHours={(coverHoursRes.data ?? []) as any[]}
        clockSummaries={clockSummaries}
        clockDailySummaries={clockDailySummaries}
        managerDaily={managerDaily}
        managers={managerAccounts}
        loadError={clocksRes.error?.message ?? null}
        todayISO={todayISO()}
        stores={storesRes.data ?? []}
        entryStores={allStoresRes.data ?? []}
        entryEmployees={entryPickerEmployees}
        entryEmployeeDays={(entryDaysRes.data ?? []) as EntryEmployeeDay[]}
        defaultStoreId={storeId || null}
        minWageBands={settings.min_wage_bands}
        lockToStore
        canManualLog={false}
        canEditContactEmail={false}
      />
    </>
  );
}
