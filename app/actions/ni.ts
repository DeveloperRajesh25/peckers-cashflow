"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveActiveStoreId } from "@/lib/types";
import { loadManualNiRows, loadNiRows } from "@/lib/ni-data";
import type { ManualNiRow, NiRow } from "@/components/ni/NiMonthlyView";
import { writeAudit } from "./audit";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

async function requireStaff(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !user.allowed) throw new Error("Not authorised");
  if (user.allowed.role !== "admin" && user.allowed.role !== "manager") {
    throw new Error("Only managers and admins can manage NI records.");
  }
  return user;
}

function assertStoreAccess(user: SessionUser, storeId: string) {
  if (user.allowed!.role === "manager") {
    const activeStore = resolveActiveStoreId(user.allowed);
    if (!activeStore) throw new Error("No store assigned to your account.");
    if (storeId !== activeStore) {
      throw new Error("You can only manage NI records for the store you're managing.");
    }
  }
}

function revalidateNi() {
  revalidatePath("/ni-monthly");
  revalidatePath("/manager/ni-monthly");
}

/**
 * One store's NI slice, fetched on demand when an admin switches store tabs so
 * the page only pays for the store it opens on.
 */
export async function loadNiForStore(
  storeId: string,
): Promise<{ rows: NiRow[]; manualRows: ManualNiRow[] }> {
  const user = await requireStaff();
  if (!storeId) throw new Error("Store is required");
  assertStoreAccess(user, storeId);

  const [rows, manualRows] = await Promise.all([
    loadNiRows(storeId),
    loadManualNiRows(storeId),
  ]);
  return { rows, manualRows };
}

/**
 * Add an off-system NI line to the monthly summary. Persisted per store + month
 * so it survives refreshes and shows for every admin and the store's managers.
 */
export async function addManualNiRecord(input: {
  store_id: string;
  month: string;
  employee_name: string;
  ni_hours: number;
  ni_wages: number;
}): Promise<{ ok: true; id: string }> {
  const user = await requireStaff();
  if (!input.store_id) throw new Error("Store is required");
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new Error("Invalid month");
  if (!input.employee_name?.trim()) throw new Error("Employee name is required");
  assertStoreAccess(user, input.store_id);

  const supabase = createServerSupabase();
  const payload = {
    store_id: input.store_id,
    month: input.month,
    employee_name: input.employee_name.trim(),
    ni_hours: Number(input.ni_hours) || 0,
    ni_wages: Number(input.ni_wages) || 0,
    created_by: user.id,
    created_by_name: user.allowed!.name ?? user.email,
  };

  const { data, error } = await supabase
    .from("manual_ni_records")
    .insert(payload)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "Failed to add NI record");

  await writeAudit({
    action: "create",
    entity: "manual_ni_record",
    entity_id: data.id,
    changes: payload,
  });

  revalidateNi();
  return { ok: true, id: data.id };
}

/** Remove a manual NI line (staff, scoped to the record's store). */
export async function deleteManualNiRecord(id: string): Promise<{ ok: true }> {
  const user = await requireStaff();
  const supabase = createServerSupabase();

  const { data: rec } = await supabase
    .from("manual_ni_records")
    .select("id, store_id")
    .eq("id", id)
    .maybeSingle();
  if (!rec) throw new Error("NI record not found");
  assertStoreAccess(user, rec.store_id);

  const { error } = await supabase.from("manual_ni_records").delete().eq("id", id);
  if (error) throw new Error(error.message);

  await writeAudit({ action: "delete", entity: "manual_ni_record", entity_id: id });
  revalidateNi();
  return { ok: true };
}
