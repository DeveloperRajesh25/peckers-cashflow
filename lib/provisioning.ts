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
