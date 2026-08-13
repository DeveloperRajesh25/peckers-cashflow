import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { AlertsView } from "@/components/alerts/AlertsView";
import { listAlerts } from "@/app/actions/alerts";
import type { Employee, Store } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ManagerAlertsPage() {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed) ?? "";
  const supabase = createServerSupabase();

  const [firstPage, storesRes, employeesRes] = await Promise.all([
    listAlerts({ page: 1, storeId, includeResolved: false }),
    supabase.from("stores").select("*").eq("id", storeId),
    supabase
      .from("employees")
      .select("id, name, position, store_id")
      .eq("store_id", storeId)
      .limit(500),
  ]);

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Warnings for your store: hours variance, deliveries, late or missing clock-ins."
      />
      <AlertsView
        initialPage={firstPage}
        stores={(storesRes.data ?? []) as Store[]}
        employees={(employeesRes.data ?? []) as Employee[]}
      />
    </>
  );
}
