import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import {
  H_ALLOWED,
  H_USER_EMAIL,
  H_USER_ID,
  encodeIdentity,
} from "./lib/auth-headers";

// Login pages (one per portal) + access-denied are reachable without a session.
// So is the password-reset flow: someone who can't sign in is exactly who needs
// it. Both entries are prefix-matched below, which covers /reset-password/<token>.
const PUBLIC_PATHS = [
  "/login",
  "/manager/login",
  "/employee/login",
  "/cover-driver/login",
  "/access-denied",
  "/forgot-password",
  "/reset-password",
];

const PORTAL_HOME = {
  admin: "/dashboard",
  manager: "/manager/live",
  employee: "/employee/attendance",
  cover_driver: "/cover-driver/attendance",
} as const;

function loginPathForArea(pathname: string): string {
  if (pathname.startsWith("/manager")) return "/manager/login";
  if (pathname.startsWith("/employee")) return "/employee/login";
  if (pathname.startsWith("/cover-driver")) return "/cover-driver/login";
  return "/login";
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Email out of an access token's payload WITHOUT verifying the signature.
 *
 * Used only to start the allowed_users lookup early so it overlaps signature
 * verification instead of queueing behind it. The result is discarded unless
 * the verified claims name the same address — see the check in `middleware`.
 * Never treat this as an identity.
 */
function unverifiedEmailFromToken(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const email = JSON.parse(atob(padded))?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  // Clone the incoming headers and ALWAYS strip the identity headers, so a
  // client can never forge them — only the validated values we set below
  // (further down) reach the page.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(H_USER_ID);
  requestHeaders.delete(H_USER_EMAIL);
  requestHeaders.delete(H_ALLOWED);

  // Cookies Supabase wants to write (session refresh) are collected here and
  // applied to whichever response we return, so the refreshed token survives
  // both pass-throughs and redirects.
  const pendingCookies: { name: string; value: string; options: CookieOptions }[] = [];
  const applyCookies = <T extends NextResponse>(res: T): T => {
    for (const c of pendingCookies) {
      res.cookies.set({ name: c.name, value: c.value, ...c.options });
    }
    return res;
  };
  const passThrough = () =>
    applyCookies(NextResponse.next({ request: { headers: requestHeaders } }));
  const redirectTo = (pathname: string) => {
    const url = req.nextUrl.clone();
    url.pathname = pathname;
    return applyCookies(NextResponse.redirect(url));
  };

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("[Middleware] Missing Supabase environment variables");
      return redirectTo("/login");
    }

    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          pendingCookies.push({ name, value, options });
        },
        remove(name: string, options: CookieOptions) {
          pendingCookies.push({ name, value: "", options });
        },
      },
    });

    const fetchAllowed = async (email: string) => {
      const { data, error } = await supabase
        .from("allowed_users")
        .select("*")
        .ilike("email", email)
        .maybeSingle();
      if (error) {
        console.error("[Middleware] allowed_users query error:", error.message);
      }
      return (data ?? null) as Record<string, unknown> | null;
    };

    const { pathname } = req.nextUrl;
    const isPublic = isPublicPath(pathname);
    const notSignedIn = () =>
      isPublic ? passThrough() : redirectTo(loginPathForArea(pathname));

    // Reads (and refreshes, when due) the session from the cookie — no Auth
    // round-trip of its own. The session's own user object is NOT trusted here;
    // only the token string is used, and only the verified claims below decide
    // who this is.
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) return notSignedIn();

    // getClaims() verifies the token's signature locally against the project's
    // public JWKS via WebCrypto — no /auth/v1/user round-trip. The key set is
    // cached process-wide by the SDK, so after the first request this is pure
    // CPU. (On a project still signing with a symmetric HS* key the SDK falls
    // back to a getUser() call, which is exactly the old behaviour.)
    //
    // Firing the whitelist read alongside it turns the two round-trips this
    // middleware used to make on EVERY request — including all the router
    // prefetches — into one.
    const speculativeEmail = unverifiedEmailFromToken(session.access_token);
    const [claims, speculativeAllowed] = await Promise.all([
      // A bad signature comes back as an error, but an EXPIRED token throws a
      // plain Error out of getClaims(). Both mean the same thing here, and both
      // must land on the portal's own login page — letting the throw reach the
      // outer catch would send an employee to the admin /login instead, and
      // would bounce anyone sitting on a public page.
      supabase.auth
        .getClaims(session.access_token)
        .then((r) => (r.error ? null : (r.data?.claims ?? null)))
        .catch(() => null),
      speculativeEmail ? fetchAllowed(speculativeEmail) : Promise.resolve(null),
    ]);

    if (!claims) return notSignedIn();

    const userId = typeof claims.sub === "string" ? claims.sub : null;
    const userEmail = typeof claims.email === "string" ? claims.email : null;
    if (!userId) return notSignedIn();

    // ---- signed in: resolve whitelist + role ----
    let role: "admin" | "manager" | "employee" | "cover_driver" | null = null;
    let allowed: Record<string, unknown> | null = null;
    if (userEmail) {
      // The speculative read only counts if the verified claims name the same
      // address it was issued for; otherwise redo it against the real one.
      allowed =
        speculativeEmail && speculativeEmail.toLowerCase() === userEmail.toLowerCase()
          ? speculativeAllowed
          : await fetchAllowed(userEmail);
      if (!allowed) {
        await supabase.auth.signOut();
        if (pathname !== "/access-denied") {
          return redirectTo("/access-denied");
        }
        return passThrough();
      }
      role = (allowed.role as typeof role) ?? null;
    }

    const home = role ? PORTAL_HOME[role] : "/login";
    const onChangePw = pathname === "/change-password";
    const mustChange = allowed?.must_change_password === true;

    // A reset link is authorised by its TOKEN, not by whoever happens to be
    // signed in on the device. Shared tablets are normal in-store, so bouncing
    // this to a colleague's dashboard (or to their forced-change screen, where
    // they'd end up changing the WRONG account's password) would strand the
    // person the link was actually sent to. The action itself only ever touches
    // the account the token names, so letting it render is safe.
    const onResetPassword =
      pathname === "/reset-password" || pathname.startsWith("/reset-password/");

    // ---- forced password change ----
    // A user still on an admin-shared temp password is funnelled to a single
    // change-password screen (isolation-exempt, reachable by any role) until
    // they set their own. /access-denied stays reachable so a just-removed user
    // isn't trapped.
    if (mustChange && !onChangePw && !onResetPassword && pathname !== "/access-denied") {
      return redirectTo("/change-password");
    }
    if (onChangePw && !mustChange) {
      // Nothing to change (or already done) — bounce to their portal home.
      return redirectTo(home);
    }

    // ---- on a login page or root while signed in -> go to portal home ----
    if (isPublic || pathname === "/") {
      // /access-denied stays reachable (e.g. just-removed users); only bounce login/root.
      if (pathname === "/access-denied") return passThrough();
      if (onResetPassword) return passThrough();
      return redirectTo(home);
    }

    // ---- portal isolation (skip for the shared change-password screen) ----
    if (!onChangePw) {
      const inManager = pathname === "/manager" || pathname.startsWith("/manager/");
      const inEmployee = pathname === "/employee" || pathname.startsWith("/employee/");
      const inCoverDriver =
        pathname === "/cover-driver" || pathname.startsWith("/cover-driver/");

      if (role === "employee" && !inEmployee) {
        return redirectTo(PORTAL_HOME.employee);
      }
      if (role === "cover_driver" && !inCoverDriver) {
        return redirectTo(PORTAL_HOME.cover_driver);
      }
      if (role === "manager" && !inManager) {
        return redirectTo(PORTAL_HOME.manager);
      }
      if (role === "admin" && (inManager || inEmployee || inCoverDriver)) {
        return redirectTo(PORTAL_HOME.admin);
      }
    }

    // ---- authenticated, whitelisted, correct portal ----
    // Hand the validated identity to the page so it doesn't repeat the
    // verification + allowed_users lookup. (Stripped above, so these values are
    // trustworthy on every matched route.)
    if (userEmail && allowed) {
      requestHeaders.set(H_USER_ID, userId);
      requestHeaders.set(H_USER_EMAIL, userEmail);
      requestHeaders.set(H_ALLOWED, encodeIdentity(allowed));
    }
    return passThrough();
  } catch (err) {
    console.error("[Middleware] Error:", err instanceof Error ? err.message : String(err));
    return redirectTo("/login");
  }
}

export const config = {
  matcher: [
    // Exclude Next internals, static assets, and machine endpoints that do their
    // own auth: the service worker + manifest (must be served as-is, not
    // redirected to a login page), and the secret-guarded cron + external
    // machine-to-machine routes.
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/cron|api/external|sw.js|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
