import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase } from "@/lib/supabase-server";
import { AlertsView } from "@/components/alerts/AlertsView";
import { listAlerts } from "@/app/actions/alerts";
import type { Employee, Store } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const supabase = createServerSupabase();

  const [firstPage, storesRes, employeesRes] = await Promise.all([
    listAlerts({ page: 1, includeResolved: false }),
    supabase.from("stores").select("*").order("name"),
    supabase.from("employees").select("id, name, position, store_id").limit(500),
  ]);

  return (
    <>
      <PageHeader
        title="Alerts"
        description="System-generated warnings for hours variance, deliveries, and late or missing clock-ins."
      />
      <AlertsView
        initialPage={firstPage}
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as Employee[]}
      />
    </>
  );
}
