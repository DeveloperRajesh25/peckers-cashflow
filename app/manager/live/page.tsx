import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { LiveDashboard } from "@/components/live/LiveDashboard";
import { ManagerQuickEntry } from "@/components/manager/ManagerQuickEntry";
import { ManagerClockCard } from "@/components/manager/ManagerClockCard";
import { ClockReminderOptIn } from "@/components/crew/ClockReminderOptIn";
import {
  saveManagerPushSubscription,
  deleteManagerPushSubscription,
  sendManagerTestPush,
} from "@/app/actions/manager-push";
import { todayISO } from "@/lib/utils";
import type {
  ClockEvent,
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  DailyCashEntry,
  EmployeeScheduleDay,
  LiveClockSession,
  LiveEmployee,
  ManagerClockEvent,
  ManagerClockSession,
  RotaShift,
  Store,
} from "@/lib/types";
import {
  COVER_SCHEDULE_COLUMNS,
  EARLY_CLOCK_IN_COLUMNS,
  LIVE_CLOCK_SESSION_COLUMNS,
  LIVE_EMPLOYEE_COLUMNS,
  SCHEDULE_COLUMNS,
  mapEarlyClockInRows,
} from "@/lib/rota-columns";

export const dynamic = "force-dynamic";

export default async function ManagerLivePage() {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed);
  const supabase = createServerSupabase();
  const today = todayISO();

  // Staff aren't locked to one store, so the board loads the whole estate's
  // active roster and today's rows for it — the same set the admin board reads.
  // Two things need it. The board itself must resolve a visiting worker to the
  // store they actually clocked in at, and the manual clock-in picker must be
  // able to reach someone based at the OTHER store who covered a shift here and
  // has no clock row or rota cell to be found by. Display is still scoped: the
  // cards below render `visibleStores`, which is this manager's store alone.
  const [
    storesRes,
    employeesRes,
    clocksRes,
    sessionsRes,
    shiftsRes,
    schedulesRes,
    cashRes,
    managerClockRes,
    managerSessionsRes,
    coverDriversRes,
    coverClocksRes,
    coverShiftsRes,
    coverSchedulesRes,
    earlyClockInsRes,
  ] = await Promise.all([
    // All stores — the clock card needs every store's geofence to detect which
    // one the manager is physically at (and nudge them to switch if needed).
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("employees")
      .select(LIVE_EMPLOYEE_COLUMNS)
      .neq("employment_status", "left"),
    supabase.from("clock_events").select("*").eq("event_date", today),
    // The day's individual shifts — the clock row above is only its header.
    supabase
      .from("clock_sessions")
      .select(LIVE_CLOCK_SESSION_COLUMNS)
      .eq("event_date", today)
      .order("clock_in_at", { ascending: true }),
    supabase.from("rota_shifts").select("*").eq("shift_date", today),
    supabase.from("employee_schedules").select(SCHEDULE_COLUMNS),
    storeId
      ? supabase
          .from("daily_cash_entries")
          .select("*")
          .eq("store_id", storeId)
          .eq("entry_date", today)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // The manager's OWN clock row for today. Filtered on manager_id explicitly:
    // migration 034 widened these policies to the whole store so peers can be
    // approved, so RLS alone no longer narrows this to one person — and without
    // the filter maybeSingle() would break the moment two managers worked the
    // same day.
    supabase
      .from("manager_clock_events")
      .select("*")
      .eq("manager_id", user.allowed!.id)
      .eq("event_date", today)
      .maybeSingle(),
    // Their day's individual shifts — the clock row above is only its header.
    supabase
      .from("manager_clock_sessions")
      .select("*")
      .eq("manager_id", user.allowed!.id)
      .eq("event_date", today)
      .order("clock_in_at", { ascending: true }),
    // Cover drivers are scoped to this store — unlike employees they aren't
    // shared between stores, so there's no "visiting cover driver" case to
    // resolve across the estate.
    supabase
      .from("cover_drivers")
      .select("*")
      .eq("store_id", storeId ?? "")
      .eq("is_active", true),
    supabase
      .from("cover_driver_clock_events")
      .select("*")
      .eq("event_date", today)
      .eq("store_id", storeId ?? ""),
    supabase
      .from("cover_driver_shifts")
      .select("*")
      .eq("shift_date", today)
      .eq("store_id", storeId ?? ""),
    supabase.from("cover_driver_schedules").select(COVER_SCHEDULE_COLUMNS),
    // Scoped to the store the manager is RUNNING, never their home store — a
    // manager covering the other store answers that store's phone.
    supabase
      .from("early_clock_in_requests")
      .select(EARLY_CLOCK_IN_COLUMNS)
      .eq("event_date", today)
      .eq("store_id", storeId ?? "")
      .in("status", ["pending", "used"])
      .order("requested_at", { ascending: false }),
  ]);

  const todayEntry = (cashRes.data ?? null) as DailyCashEntry | null;
  const stores = (storesRes.data ?? []) as Store[];
  const myStore = stores.find((s) => s.id === storeId) ?? stores[0] ?? null;
  const managerClock = (managerClockRes.data ?? null) as ManagerClockEvent | null;
  const managerSessions = (managerSessionsRes.data ?? []) as ManagerClockSession[];

  return (
    <>
      <PageHeader
        title="Live Dashboard"
        description="Real-time staffing for your store today. Refreshes every 30 seconds."
      />
      <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ManagerClockCard
          managerName={user.allowed?.name ?? "Manager"}
          store={myStore}
          allStores={stores}
          todayClock={managerClock}
          todaySessions={managerSessions}
        />
        {storeId && (
          <ManagerQuickEntry storeId={storeId} today={today} existing={todayEntry} />
        )}
      </div>
      <div className="mb-6">
        <ClockReminderOptIn
          saveSubscription={saveManagerPushSubscription}
          deleteSubscription={deleteManagerPushSubscription}
          sendTest={sendManagerTestPush}
        />
      </div>
      <LiveDashboard
        stores={stores}
        employees={(employeesRes.data ?? []) as LiveEmployee[]}
        shifts={(shiftsRes.data ?? []) as RotaShift[]}
        clocks={(clocksRes.data ?? []) as ClockEvent[]}
        clockSessions={(sessionsRes.data ?? []) as LiveClockSession[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        coverDrivers={(coverDriversRes.data ?? []) as CoverDriver[]}
        coverDriverClocks={(coverClocksRes.data ?? []) as CoverDriverClockEvent[]}
        coverDriverShifts={(coverShiftsRes.data ?? []) as CoverDriverShift[]}
        coverDriverSchedules={(coverSchedulesRes.data ?? []) as CoverDriverScheduleDay[]}
        earlyClockIns={mapEarlyClockInRows(earlyClockInsRes.data)}
        canAddClockIn
        todayISO={today}
        userRole="manager"
        userStoreId={storeId}
      />
    </>
  );
}
