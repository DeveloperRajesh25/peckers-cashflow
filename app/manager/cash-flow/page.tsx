import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { resolveWeek } from "@/lib/cash-flow";
import { buildDashboardViews } from "@/lib/cash-flow-data";
import { CashFlowDashboard } from "@/components/cash-flow/CashFlowDashboard";

export const dynamic = "force-dynamic";

export default async function ManagerCashFlowPage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed);

  if (!storeId) {
    return (
      <>
        <PageHeader title="Cash Flow" />
        <Card>
          <p className="text-sm text-text-muted">
            No store is assigned to your account. Ask an admin to assign you to a store.
          </p>
        </Card>
      </>
    );
  }

  const supabase = createServerSupabase();
  const { weekStart } = resolveWeek(searchParams.week);
  const { data: store } = await supabase
    .from("stores")
    .select("id, name")
    .eq("id", storeId)
    .maybeSingle();
  const views = store ? await buildDashboardViews([store], weekStart) : [];

  return (
    <>
      <PageHeader
        title="Cash Flow"
        description="Daily reconciliation, running balance, and Tuesday wage forecast."
      />
      <CashFlowDashboard
        stores={store ? [store] : []}
        views={views}
        weekStart={weekStart}
        basePath="/manager/cash-flow"
      />
    </>
  );
}
