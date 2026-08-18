import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { payWeekOf, resolveWeek } from "@/lib/cash-flow";
import { getDeliveryOrdersForWeek } from "@/lib/vm-analytics/queries";
import { getPrePaymentSummary, getPayoutForWeek } from "@/app/actions/payouts";
import { PrePaymentView } from "@/components/cash-flow/PrePaymentView";

export const dynamic = "force-dynamic";

export default async function ManagerCashFlowPayoutPage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed);

  if (!storeId) {
    return (
      <>
        <PageHeader title="Tuesday Payout" />
        <Card>
          <p className="text-sm text-text-muted">No store assigned to your account.</p>
        </Card>
      </>
    );
  }

  const supabase = createServerSupabase();
  const { weekStart, prevWeek, nextWeek } = resolveWeek(searchParams.week);
  const { data: store } = await supabase
    .from("stores")
    .select("id, name")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) {
    return (
      <>
        <PageHeader title="Tuesday Payout" />
        <Card>
          <p className="text-sm text-text-muted">Store not found.</p>
        </Card>
      </>
    );
  }

  const [summary, payout, vmDeliveryOrders] = await Promise.all([
    getPrePaymentSummary({ store_id: store.id, week_start: weekStart }),
    getPayoutForWeek({ store_id: store.id, week_start: weekStart }),
    // VM Analytics lives in a separate database; a missing config or a week it
    // hasn't imported must leave the payout sheet working, so it degrades to null.
    getDeliveryOrdersForWeek(payWeekOf(weekStart).start, store.name).catch(() => null),
  ]);

  return (
    <>
      <PageHeader
        title="Tuesday Cash &amp; Delivery Wages"
        description="Pre-payment summary, Post Office draw, and per-employee wage confirmation."
      />
      <PrePaymentView
        summary={summary}
        payout={payout}
        store={store}
        stores={[store]}
        weekStart={weekStart}
        vmDeliveryOrders={vmDeliveryOrders}
        prevWeek={prevWeek}
        nextWeek={nextWeek}
        isAdmin={false}
        basePath="/manager/cash-flow"
      />
    </>
  );
}
