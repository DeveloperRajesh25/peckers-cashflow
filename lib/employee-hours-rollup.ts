// =============================================================
// The weekly employee_hours rollup.
//
// Managers approve one DAY at a time on clock_events; the weekly
// employee_hours row that payroll, NI and analytics read is a DERIVED sum of
// that week's approved days, not a separate truth (migration 016).
//
// Extracted from app/actions/employees.ts so the clock path can reuse it: when
// someone starts a second shift on a day a manager already signed off, the
// approval has to be revoked and the week re-rolled, or the day is paid at the
// figure it had before the extra shift existed.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, parseISODate, toISODate } from "@/lib/utils";

export async function employeeNiRate(
  supabase: SupabaseClient,
  employee_id: string,
): Promise<number> {
  const { data: emp } = await supabase
    .from("employees")
    .select("hourly_rate, hourly_ni_rate")
    .eq("id", employee_id)
    .maybeSingle();
  return Number(emp?.hourly_ni_rate ?? emp?.hourly_rate ?? 0);
}

/**
 * Recompute the weekly employee_hours rollup for one (employee, week) from the
 * approved clocked days. Removes the clocked rollup row if no day is approved.
 *
 * `userId` stamps who caused the recompute. Pass null when no staff member did
 * (an employee's own clock-in revoking an approval) — the existing row's
 * attribution is then preserved rather than being blamed on the employee.
 */
export async function rollupApprovedWeek(
  supabase: SupabaseClient,
  employee_id: string,
  week_start_date: string,
  rate: number,
  userId: string | null,
) {
  const weekEnd = toISODate(addDays(parseISODate(week_start_date), 6));
  // Keyed on approved_hours being present, NOT on hours_approved. Since
  // migration 035 a day can be PARTLY approved — one shift of two signed off —
  // and hours_approved only reads true once every shift is. Those partial hours
  // are payable, so the weekly rollup has to include them or it disagrees with
  // the Tuesday sheet.
  const { data: days } = await supabase
    .from("clock_events")
    .select("approved_hours")
    .eq("employee_id", employee_id)
    .not("approved_hours", "is", null)
    .gte("event_date", week_start_date)
    .lte("event_date", weekEnd);

  const total =
    Math.round(
      (days ?? []).reduce(
        (s, d) => s + (d.approved_hours != null ? Number(d.approved_hours) : 0),
        0,
      ) * 100,
    ) / 100;

  const { data: existing } = await supabase
    .from("employee_hours")
    .select("id, source, logged_by, approved_by")
    .eq("employee_id", employee_id)
    .eq("week_start_date", week_start_date)
    .maybeSingle();

  if (total <= 0) {
    // No approved days left this week — drop the clocked rollup row, but never
    // touch an admin's manual correction for the same week.
    if (existing && existing.source === "clocked") {
      await supabase.from("employee_hours").delete().eq("id", existing.id);
    }
    return;
  }

  const payload = {
    employee_id,
    week_start_date,
    total_hours_worked: total,
    hourly_rate_snapshot: rate,
    logged_by: userId ?? existing?.logged_by ?? null,
    source: "clocked" as const,
    approved: true,
    approved_by: userId ?? existing?.approved_by ?? null,
    approved_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabase
      .from("employee_hours")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("employee_hours").insert(payload);
    if (error) throw new Error(error.message);
  }
}
