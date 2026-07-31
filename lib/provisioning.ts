// =============================================================
// Server-only credential generation for provisioned logins.
//
// Extracted verbatim from app/actions/accounts.ts so employee, manager and
// cover-driver provisioning share ONE implementation — a second copy would let
// the username-uniqueness rules drift apart and start issuing colliding logins.
//
// Not pure (queries allowed_users), so this must never be imported by a client
// component. Pure helpers live in lib/credentials.ts.
// =============================================================

import { createServerSupabase } from "./supabase-server";
import { usernameStemFromName } from "./credentials";

// Ambiguous glyphs (0/O, 1/l/I) omitted — these passwords get read aloud and
// copied by hand off a screen.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(len = 10): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PASSWORD_ALPHABET[Math.floor(Math.random() * PASSWORD_ALPHABET.length)];
  }
  return out;
}

/**
 * The account already using a reset address, if any.
 *
 * Checked BEFORE provisioning starts. The address is unique across every account
 * (migration 019), so without this the clash only surfaces as a constraint
 * violation after an auth user and a profile row have already been written and
 * have to be rolled back — and the person is told nothing useful.
 *
 * Matched with eq(), not ilike(): addresses are stored normalised (lowercased),
 * and ilike would treat an underscore in a real address as a wildcard. A legacy
 * mixed-case row would slip past this, which is why the unique index remains the
 * backstop rather than the only check.
 */
export async function findAccountByContactEmail(
  contactEmail: string,
): Promise<{ name: string | null; role: string } | null> {
  const supabase = createServerSupabase();
  const { data } = await supabase
    .from("allowed_users")
    .select("name, role")
    .eq("contact_email", contactEmail)
    .limit(1)
    .maybeSingle();
  return (data as { name: string | null; role: string } | null) ?? null;
}

/** Find a free username based on a name stem, checking existing accounts. */
export async function uniqueUsername(name: string): Promise<string> {
  const supabase = createServerSupabase();
  const stem = usernameStemFromName(name);
  const { data } = await supabase
    .from("allowed_users")
    .select("username")
    .ilike("username", `${stem}%`);
  const taken = new Set(
    (data ?? []).map((r: { username: string | null }) => (r.username ?? "").toLowerCase()),
  );
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely fallback.
  return `${stem}${Date.now()}`;
}
