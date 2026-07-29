import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
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
  CoverDriver,
  CoverDriverClockEvent,
  CoverDriverScheduleDay,
  CoverDriverShift,
  Employee,
  EmployeeScheduleDay,
  RotaShift,
  Store,
  ClockEvent,
  WeeklyDelivery,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// The rota needs each employee's identity, store, rates and DOB (for min-wage
// checks) — but never their bank details. Managers load every store's staff (to
// schedule visitors), so we deliberately omit the sensitive payment columns.
const ROTA_EMPLOYEE_COLUMNS =
  "id, name, hourly_rate, bank_weekly_hours_limit, is_active, joined_date, date_of_birth, gender, position, employment_start_date, hourly_ni_rate, hourly_cash_rate, store_id, employment_status, short_delivery_rate, long_delivery_rate";

export default async function ManagerRotaPage({
  searchParams,
}: {
  searchParams: { start?: string; end?: string };
}) {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed) ?? "";
  const supabase = createServerSupabase();
  const settings = await getAppSettings();

  const { startIso, endIso } = resolveRotaRange(searchParams.start, searchParams.end);
  // Weekly deliveries stay anchored to the ISO week containing the range start.
  const weekStartIso = toISODate(startOfISOWeek(parseISODate(startIso)));
  // Fetch 4 prior weeks (from the range start) so the rolling avg has history.
  const fourWeeksBack = toISODate(addDays(parseISODate(weekStartIso), -28));

  // Staff aren't locked to one store: a manager can schedule anyone onto their
  // store's rota, and needs to see when their own staff are working elsewhere.
  // So we load ALL active staff and ALL shifts/clocks in range (RotaView scopes
  // display to the active store). Only the non-sensitive employee columns are
  // fetched — the rota never needs bank details, so other stores' payment info
  // is not pulled into the page.
  const [
    storesRes,
    employeesRes,
    shiftsRes,
    clocksRes,
    deliveriesRes,
    schedulesRes,
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
        .select("*")
        .gte("shift_date", fourWeeksBack)
        .lte("shift_date", endIso),
      supabase
        .from("clock_events")
        .select("*")
        .gte("event_date", fourWeeksBack)
        .lte("event_date", todayISO()),
      supabase
        .from("weekly_deliveries")
        .select("*")
        .eq("store_id", storeId)
        .eq("week_start_date", weekStartIso),
      supabase.from("employee_schedules").select("*"),
      // Cover drivers belong to one store and aren't loaned out, so unlike
      // staff these are scoped to this store rather than loaded estate-wide.
      supabase
        .from("cover_drivers")
        .select("*")
        .eq("store_id", storeId)
        .eq("is_active", true),
      supabase
        .from("cover_driver_shifts")
        .select("*")
        .eq("store_id", storeId)
        .gte("shift_date", startIso)
        .lte("shift_date", endIso),
      supabase.from("cover_driver_schedules").select("*"),
      supabase
        .from("cover_driver_clock_events")
        .select("*")
        .eq("store_id", storeId)
        .gte("event_date", startIso)
        .lte("event_date", todayISO()),
    ]);

  return (
    <>
      <PageHeader
        title="Rota Management"
        description="Weekly scheduling for your store. NI = first 20h, cash = remainder."
      />
      <RotaView
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as Employee[]}
        shifts={(shiftsRes.data ?? []) as RotaShift[]}
        clocks={(clocksRes.data ?? []) as ClockEvent[]}
        weeklyDeliveries={(deliveriesRes.data ?? []) as WeeklyDelivery[]}
        schedules={(schedulesRes.data ?? []) as EmployeeScheduleDay[]}
        coverDrivers={(coverDriversRes.data ?? []) as CoverDriver[]}
        coverDriverShifts={(coverShiftsRes.data ?? []) as CoverDriverShift[]}
        coverDriverSchedules={(coverSchedulesRes.data ?? []) as CoverDriverScheduleDay[]}
        coverDriverClocks={(coverClocksRes.data ?? []) as CoverDriverClockEvent[]}
        minWageBands={settings.min_wage_bands}
        shiftTimes={settings.shift_times}
        rangeStartIso={startIso}
        rangeEndIso={endIso}
        userRole="manager"
        userStoreId={storeId || null}
      />
    </>
  );
}
