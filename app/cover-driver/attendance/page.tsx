import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { findCoverDriverForUser } from "@/lib/cover-driver-lookup";
import { CoverDriverClockApp } from "@/components/cover-drivers/CoverDriverClockApp";
import { endOfISOWeek, startOfISOWeek, toISODate, todayISO } from "@/lib/utils";
import type { CoverDriver, CoverDriverClockEvent, Store } from "@/lib/types";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";

export default async function CoverDriverAttendancePage() {
  const user = await requireRole(["cover_driver"]);
  const supabase = createServerSupabase();

  const driver = await findCoverDriverForUser(supabase, user.id, user.email);

  if (!driver) {
    return (
      <>
        <PageHeader title="Clock In/Out" description="Log the start and end of your cover shift." />
        <Card>
          <p className="text-sm text-text-muted">
            Your login isn&apos;t linked to a cover driver profile yet. Please ask
            your manager to check your account.
          </p>
        </Card>
      </>
    );
  }

  const today = todayISO();
  const weekStart = startOfISOWeek(new Date());
  const weekEnd = endOfISOWeek(new Date());

  const [storesRes, weekClocksRes] = await Promise.all([
    // All stores — a cover driver may be called to whichever one needs them.
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("cover_driver_clock_events")
      .select("*")
      .eq("cover_driver_id", driver.id)
      .gte("event_date", toISODate(weekStart))
      .lte("event_date", toISODate(weekEnd)),
  ]);

  const weekClocks = (weekClocksRes.data ?? []) as CoverDriverClockEvent[];
  const todayClock = weekClocks.find((c) => c.event_date === today) ?? null;

  return (
    <>
      <PageHeader
        title={`Hi ${driver.name.split(" ")[0]}`}
        description="Clock in & out. Location is required — you must be at the store."
      />
      <CoverDriverClockApp
        driver={driver as CoverDriver}
        stores={(storesRes.data ?? []) as Store[]}
        todayClock={todayClock}
        weekClocks={weekClocks}
      />
    </>
  );
}
