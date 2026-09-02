import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { PayoutHistoryView } from "@/components/cash-flow/PayoutHistoryView";
import {
  PAYOUT_HISTORY_MAX_ROWS,
  PAYOUT_HISTORY_SELECT,
  PAYOUT_HISTORY_STATUS,
  mapPayoutHeaders,
} from "@/lib/payout-history-paging";
import type { Store } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ManagerCashFlowHistoryPage() {
  const user = await requireRole(["manager"]);
  const storeId = resolveActiveStoreId(user.allowed);

  if (!storeId) {
    return (
      <>
        <PageHeader title="Weekly Payout Summaries" />
        <Card>
          <p className="text-sm text-text-muted">No store assigned to your account.</p>
        </Card>
      </>
    );
  }

  const supabase = createServerSupabase();
  // Headers and line counts only — the lines load when a card is opened.
  const [storesRes, payoutsRes] = await Promise.all([
    supabase.from("stores").select("*").eq("id", storeId),
    supabase
      .from("cash_payouts")
      .select(PAYOUT_HISTORY_SELECT)
      .eq("status", PAYOUT_HISTORY_STATUS)
      .eq("store_id", storeId)
      .order("week_start_date", { ascending: false })
      .order("store_id")
      .order("id")
      .limit(PAYOUT_HISTORY_MAX_ROWS),
  ]);

  const payouts = mapPayoutHeaders(payoutsRes.data ?? []);

  return (
    <>
      <PageHeader
        title="Weekly Payout Summaries"
        description="Permanent record of confirmed cash wage payments. Searchable and exportable."
      />
      <PayoutHistoryView
        initialPayouts={payouts}
        stores={(storesRes.data ?? []) as Store[]}
        isAdmin={false}
        loadError={payoutsRes.error?.message ?? null}
      />
    </>
  );
}
