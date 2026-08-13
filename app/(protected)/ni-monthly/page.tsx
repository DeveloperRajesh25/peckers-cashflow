import { PageHeader } from "@/components/layout/PageHeader";
import { createServerSupabase, requireRole } from "@/lib/supabase-server";
import { loadManualNiRows, loadNiRows } from "@/lib/ni-data";
import { NiMonthlyView } from "@/components/ni/NiMonthlyView";

export const dynamic = "force-dynamic";

export default async function NiMonthlyPage() {
  await requireRole(["admin"]);
  const supabase = createServerSupabase();

  const { data: stores } = await supabase.from("stores").select("id, name").order("name");
  // Only the tab that opens first — NiMonthlyView fetches the other stores on switch.
  const firstStoreId = stores?.[0]?.id ?? null;
  const [rows, manualRows] = firstStoreId
    ? await Promise.all([loadNiRows(firstStoreId), loadManualNiRows(firstStoreId)])
    : [[], []];

  return (
    <>
      <PageHeader
        title="NI — Monthly Summary"
        description="National Insurance (PAYE) wages grouped by calendar month, per store. NI is paid monthly; cash is paid weekly on the Tuesday payout."
      />
      <NiMonthlyView rows={rows} manualRows={manualRows} stores={stores ?? []} isAdmin />
    </>
  );
}
