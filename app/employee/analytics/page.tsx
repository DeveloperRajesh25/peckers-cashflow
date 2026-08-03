import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { findEmployeeForUser } from "@/lib/employee-lookup";
import { EmployeeAnalyticsView } from "@/components/crew/EmployeeAnalytics";
import {
  analyticsFetchRange,
  buildEmployeeAnalytics,
  resolveSelection,
} from "@/lib/employee-analytics";
import type { AnalyticsClockRow } from "@/lib/employee-analytics";

export const dynamic = "force-dynamic";

/** Each panel owns one param: w = weeks chart, m = months chart,
 *  d + dn = deliveries window and its span, p = working pattern. */
type SearchParams = {
  w?: string;
  m?: string;
  d?: string;
  dn?: string;
  p?: string;
};

export default async function EmployeeAnalyticsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const user = await requireRole(["employee"]);
  const supabase = createServerSupabase();

  const employee = await findEmployeeForUser(supabase, user.id, user.email);

  if (!employee) {
    return (
      <>
        <PageHeader title="My Analytics" description="Your hours at a glance." />
        <Card>
          <p className="text-sm text-text-muted">
            Your login isn&apos;t linked to a crew profile yet. Please ask your
            manager to check your account.
          </p>
        </Card>
      </>
    );
  }

  const now = new Date();
  // Clamped server-side, so a hand-edited URL can't ask for an unbounded scan.
  const selection = resolveSelection(searchParams ?? {}, now);
  const range = analyticsFetchRange(selection, now);

  // Scoped to this employee explicitly as well as by RLS — the belt-and-braces
  // filter means a future policy change can't quietly widen what crew see of
  // each other. store_id is needed as well as the hours: the NI/cash split
  // depends on whether the day was worked at their home store or a cover shift
  // somewhere else.
  const clocksRes = await supabase
    .from("clock_events")
    .select(
      "event_date, store_id, clock_in_at, clock_out_at, worked_hours, hours_approved, approved_hours, short_deliveries_count, long_deliveries_count, extra_short_deliveries, extra_long_deliveries",
    )
    .eq("employee_id", employee.id)
    .gte("event_date", range.start)
    .lte("event_date", range.end)
    .order("event_date");

  // A failed query and a genuinely empty history render identically, and
  // "you've worked nothing" is a far worse lie than an error.
  const loadError = clocksRes.error
    ? "We couldn't load your hours right now. Pull to refresh, or try again shortly."
    : null;

  const data = buildEmployeeAnalytics(
    (clocksRes.data ?? []) as AnalyticsClockRow[],
    employee,
    selection,
    now,
  );

  return (
    <>
      <PageHeader
        title="My Analytics"
        description={`Hi ${employee.name.split(" ")[0]} — here's how your hours and earnings are adding up.`}
      />
      <EmployeeAnalyticsView data={data} loadError={loadError} />
    </>
  );
}
