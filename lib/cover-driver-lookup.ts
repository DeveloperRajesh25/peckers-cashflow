// =============================================================
// Resolve the cover_drivers row for a logged-in user.
//
// Same deterministic tie-break as lib/employee-lookup.ts: an admin who
// re-provisions someone can leave an old inactive duplicate whose email still
// matches, and picking that row arbitrarily would refuse clock-in with
// "account not active". Prefer the auth_user_id match, then prefer active.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoverDriver } from "./types";

export async function findCoverDriverForUser(
  supabase: SupabaseClient,
  userId: string,
  userEmail: string,
): Promise<CoverDriver | null> {
  const { data } = await supabase
    .from("cover_drivers")
    .select("*")
    .or(`auth_user_id.eq.${userId},email.eq.${userEmail.toLowerCase()}`);

  const rows = (data ?? []) as CoverDriver[];
  if (rows.length <= 1) return rows[0] ?? null;

  const score = (d: CoverDriver) =>
    (d.auth_user_id === userId ? 2 : 0) + (d.is_active ? 1 : 0);
  return rows.sort((a, b) => score(b) - score(a))[0];
}
