import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { PORTAL_HOME, type AllowedUser, type AllowedUserRole, type SessionUser } from "./types";
import { H_ALLOWED, H_USER_EMAIL, H_USER_ID, decodeIdentity } from "./auth-headers";

// Connect/read timeout for Supabase HTTP calls. Default undici timeout is 10s,
// which is long enough to make every transient blip feel like a full hang in
// dev. We also retry once on connect-timeout so cold TLS handshakes don't
// crash a page render.
const FETCH_TIMEOUT_MS = 6000;
const RETRY_ON_CONNECT_ERR = true;

function isConnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = e.code ?? e.cause?.code;
  const name = e.name ?? e.cause?.name;
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    name === "ConnectTimeoutError" ||
    name === "AbortError"
  );
}

async function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(input, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (RETRY_ON_CONNECT_ERR && isConnectError(err)) {
      return await attempt();
    }
    throw err;
  }
}

export function createServerSupabase() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // called from a Server Component – safe to ignore.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // called from a Server Component – safe to ignore.
          }
        },
      },
      global: {
        fetch: timedFetch as typeof fetch,
      },
    }
  );
}

// React's cache() dedupes within a single request, so layout + page no longer
// double-call Supabase for the same session lookup. NOTE that a server action
// is its own request — the cache does NOT carry over from the page render that
// preceded it, so every action pays this in full. That is what makes the cost
// of the verification below worth caring about.
export const getSessionUser = cache(async () => {
  try {
    const supabase = createServerSupabase();

    // Reads (and refreshes, when due) the session from the cookie — no Auth
    // round-trip of its own. The session's own user object is NOT trusted here;
    // only the token string is used, and only the verified claims below decide
    // who this is.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return null;

    // getClaims() verifies the token's signature locally against the project's
    // public JWKS via WebCrypto — no /auth/v1/user round-trip. Measured against
    // this project in Update 104: the getUser() call this replaces costs
    // 205–403 ms, local verification 0.5–0.9 ms. The SDK caches the key set
    // process-wide, so after the first call this is pure CPU. (On a project
    // signing with a symmetric HS* key the SDK falls back to getUser(), which
    // is exactly the old behaviour — this can only be as slow as it was.)
    //
    // A bad signature comes back as an error, but an EXPIRED token throws a
    // plain Error out of getClaims(). Both mean "not signed in" here, and the
    // throw must not reach the outer catch, which reserves that path for
    // genuine connectivity failures.
    const claims = await supabase.auth
      .getClaims(session.access_token)
      .then((r) => (r.error ? null : (r.data?.claims ?? null)))
      .catch(() => null);
    if (!claims) return null;

    const id = typeof claims.sub === "string" ? claims.sub : null;
    const email = typeof claims.email === "string" ? claims.email : null;
    if (!id || !email) return null;

    const { data: allowed } = await supabase
      .from("allowed_users")
      .select("*")
      .ilike("email", email)
      .maybeSingle();

    return {
      id,
      email,
      allowed: allowed ?? null,
    };
  } catch (err) {
    if (isConnectError(err)) {
      console.warn("[getSessionUser] Supabase unreachable — treating as signed out.");
      return null;
    }
    throw err;
  }
});

// Fast path for PAGE/LAYOUT renders only: read the identity the middleware
// already validated this request and stashed in (forgery-proof) headers,
// avoiding a second auth.getUser() + allowed_users round-trip.
//
// Safe because: (1) middleware strips any client-supplied copies and re-sets
// these from the validated session on every matched route, and (2) all data
// access is RLS-gated by the real JWT in the cookie, not by these headers.
// Falls back to the authoritative lookup if the headers are absent, so nothing
// breaks on routes the middleware didn't run for.
//
// NOTE: server actions (writes / service-role provisioning) intentionally keep
// using getSessionUser() — they must not trust headers.
function sessionUserFromHeaders(): SessionUser | null {
  const h = headers();
  const id = h.get(H_USER_ID);
  const email = h.get(H_USER_EMAIL);
  if (!id || !email) return null;
  const allowed = decodeIdentity<AllowedUser>(h.get(H_ALLOWED));
  return { id, email, allowed };
}

// Use in protected pages. If the session lookup fails or returns no user, we
// redirect to /login instead of letting the page crash on a null assertion.
export async function requireUser() {
  const user = sessionUserFromHeaders() ?? (await getSessionUser());
  if (!user) redirect("/login");
  return user;
}

// Gate a portal to specific roles. Redirects:
//  - no session -> /login
//  - not whitelisted -> /access-denied
//  - wrong role -> that role's own portal home
// Returns the user plus a guaranteed non-null `role`.
export async function requireRole(allowedRoles: AllowedUserRole[]) {
  const user = sessionUserFromHeaders() ?? (await getSessionUser());
  if (!user) redirect("/login");
  const role = user.allowed?.role as AllowedUserRole | undefined;
  if (!role) redirect("/access-denied");
  if (!allowedRoles.includes(role)) redirect(PORTAL_HOME[role]);
  return { ...user, role };
}
