import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { PayoutHistoryView } from "@/components/cash-flow/PayoutHistoryView";
import {
  PAYOUT_HISTORY_MAX_ROWS,
  PAYOUT_HISTORY_SELECT,
  mapPayoutHeaders,
} from "@/lib/payout-history-paging";
import type { Store } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CashFlowHistoryPage() {
  await requireRole(["admin"]);
  const supabase = createServerSupabase();

  // Headers and line COUNTS only. The lines themselves load when a card is
  // opened — every card is collapsed by default, and shipping ~15 lines per
  // payout for up to 500 payouts was the largest payload in the app.
  const [storesRes, payoutsRes] = await Promise.all([
    supabase.from("stores").select("*").order("name"),
    supabase
      .from("cash_payouts")
      .select(PAYOUT_HISTORY_SELECT)
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
        description="Permanent record of cash wages paid each week. Searchable and exportable."
      />
      <PayoutHistoryView
        initialPayouts={payouts}
        stores={(storesRes.data ?? []) as Store[]}
        isAdmin
        loadError={payoutsRes.error?.message ?? null}
      />
    </>
  );
}
