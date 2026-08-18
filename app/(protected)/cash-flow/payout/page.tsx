import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { payWeekOf, resolveWeek } from "@/lib/cash-flow";
import { getDeliveryOrdersForWeek } from "@/lib/vm-analytics/queries";
import { getPrePaymentSummary, getPayoutForWeek } from "@/app/actions/payouts";
import { PrePaymentView } from "@/components/cash-flow/PrePaymentView";

export const dynamic = "force-dynamic";

export default async function CashFlowPayoutPage({
  searchParams,
}: {
  searchParams: { week?: string; store?: string };
}) {
  await requireRole(["admin"]);
  const supabase = createServerSupabase();
  const { weekStart, prevWeek, nextWeek } = resolveWeek(searchParams.week);
  const { data: stores } = await supabase.from("stores").select("id, name").order("name");
  const storeList = stores ?? [];
  const store = storeList.find((s) => s.id === searchParams.store) ?? storeList[0];

  if (!store) {
    return (
      <>
        <PageHeader title="Tuesday Payout" />
        <p className="text-sm text-text-muted">No stores configured.</p>
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
        stores={storeList}
        weekStart={weekStart}
        vmDeliveryOrders={vmDeliveryOrders}
        prevWeek={prevWeek}
        nextWeek={nextWeek}
        isAdmin
        basePath="/cash-flow"
      />
    </>
  );
}
