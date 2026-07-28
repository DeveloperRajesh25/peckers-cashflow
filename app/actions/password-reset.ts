"use server";

// =============================================================
// Self-service password reset — the whole flow.
//
// PUBLIC BY DESIGN: every action here runs for a signed-OUT caller (someone who
// can't log in is the entire point), so none of them check a session. What
// authorises the password change is possession of a single-use token we emailed
// to an address already on the account. Guard rails, in order:
//
//   • requestPasswordReset never reveals whether an address matches an account —
//     it returns the same "check your inbox" either way. Otherwise the form
//     becomes an oracle for which staff emails are real.
//   • Tokens are 256-bit random, stored only as a sha256 hash, single-use, and
//     dead after an hour.
//   • Requesting a reset issues a new token AND burns any outstanding ones, so a
//     link forwarded/leaked earlier stops working.
//   • Max 3 sends per account per hour, so the form can't mail-bomb a colleague.
//
// The service-role client is used throughout: allowed_users writes are
// admin-only under RLS and password_reset_tokens is unreachable under RLS by
// design, so an anon client could do none of this. Every use below is scoped to
// a row the token itself identified.
// =============================================================

import { headers } from "next/headers";
import {
  createAdminClient,
  findAuthUserByEmail,
  isProvisioningConfigured,
} from "@/lib/supabase-admin";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { isValidEmail, normalizeContactEmail } from "@/lib/credentials";
import {
  MAX_RESET_REQUESTS_PER_HOUR,
  MIN_PASSWORD_LENGTH,
  buildResetEmail,
  buildResetUrl,
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
  resolveAppUrl,
} from "@/lib/password-reset";
import { PORTAL_LOGIN, type AllowedUserRole, type Portal } from "@/lib/types";

const PORTAL_LABEL: Record<AllowedUserRole, string> = {
  admin: "Admin",
  manager: "Manager",
  employee: "Crew",
  cover_driver: "Cover Driver",
};

/** Best-effort audit row via the service-role client (the caller has no session). */
async function auditReset(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    action: string;
    entity_id: string | null;
    actor_email?: string | null;
    changes?: Record<string, unknown> | null;
  },
) {
  try {
    await admin.from("audit_log").insert({
      actor_id: null,
      actor_email: input.actor_email ?? null,
      action: input.action,
      entity: "allowed_user",
      entity_id: input.entity_id,
      changes: input.changes ?? null,
    });
  } catch (err) {
    console.error("[password-reset] audit write failed:", err);
  }
}

/** Caller IP, for forensics only — never trusted for any decision. */
function requestIp(): string | null {
  const h = headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return h.get("x-real-ip");
}

export type ResetRequestResult = { ok: boolean; error?: string };

/**
 * Step 1 — someone enters their email on /forgot-password.
 *
 * Returns ok:true whether or not the address matches an account. The only
 * failures surfaced are ones that are TRUE FOR EVERYONE (bad address format,
 * email/service-role not configured): those leak nothing about who has an
 * account, and staying silent about them would leave a user waiting on a mail
 * that was never going to arrive.
 */
export async function requestPasswordReset(input: {
  email: string;
}): Promise<ResetRequestResult> {
  const email = normalizeContactEmail(input.email ?? "");
  if (!email) return { ok: false, error: "Enter your email address" };
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address" };

  // Checked up front, before any lookup: these are all-or-nothing server config,
  // so failing here reveals nothing about who does or doesn't have an account —
  // and it beats telling someone to watch an inbox nothing can arrive in.
  // The base URL is included: without it we cannot build a trustworthy link (see
  // resolveAppUrl), and guessing one from request headers is exactly the bug
  // that turns this feature into an account-takeover vector.
  //
  // The log names the specific missing var: the user-facing copy stays vague on
  // purpose, so without this the only symptom is "isn't set up yet" with no clue
  // which of three things is absent.
  const baseUrl = resolveAppUrl();
  const missing: string[] = [];
  if (!isProvisioningConfigured()) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!isEmailConfigured()) missing.push("RESEND_API_KEY");
  if (!baseUrl) missing.push("APP_URL (or VERCEL_PROJECT_PRODUCTION_URL)");

  // `!baseUrl` is already covered by `missing`; it's repeated here so the compiler
  // narrows baseUrl to a string for buildResetUrl below.
  if (missing.length > 0 || !baseUrl) {
    console.error(
      `[password-reset] refusing to send — missing server config: ${missing.join(", ")}`,
    );
    return {
      ok: false,
      error: "Password reset isn't set up yet. Please ask your admin to reset it for you.",
    };
  }

  // Same answer for a hit and a miss.
  const generic: ResetRequestResult = { ok: true };

  try {
    const admin = createAdminClient();

    // .eq, not .ilike: ilike would treat % and _ in an address as wildcards, so
    // `a_b@x.com` could match a different account. contact_email is always
    // stored normalised (trimmed + lowercased), so exact match is correct.
    const { data: account, error: lookupErr } = await admin
      .from("allowed_users")
      .select("id, name, username, role, email, contact_email")
      .eq("contact_email", email)
      .maybeSingle();

    if (lookupErr) {
      console.error("[password-reset] lookup failed:", lookupErr.message);
      return generic;
    }
    if (!account) return generic;

    // ---- rate limit: count BEFORE burning, so burnt rows still count ----
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("password_reset_tokens")
      .select("id", { count: "exact", head: true })
      .eq("user_id", account.id)
      .gte("created_at", oneHourAgo);

    if ((count ?? 0) >= MAX_RESET_REQUESTS_PER_HOUR) {
      // Silent: telling them they're rate-limited would confirm the account exists.
      console.warn(`[password-reset] rate limited for account ${account.id}`);
      return generic;
    }

    // Burn any live tokens: only the newest link should ever work. Marked used
    // rather than deleted so they still count toward the rate limit above.
    await admin
      .from("password_reset_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", account.id)
      .is("used_at", null);

    const token = generateResetToken();
    const { error: insErr } = await admin.from("password_reset_tokens").insert({
      user_id: account.id,
      token_hash: hashResetToken(token),
      expires_at: resetTokenExpiry().toISOString(),
      requested_ip: requestIp(),
    });
    if (insErr) {
      console.error("[password-reset] token insert failed:", insErr.message);
      return { ok: false, error: "Something went wrong. Please try again." };
    }

    const role = (account.role as AllowedUserRole) ?? "employee";
    const { subject, html, text } = buildResetEmail({
      name: account.name,
      username: account.username,
      resetUrl: buildResetUrl(baseUrl, token),
      portalLabel: PORTAL_LABEL[role] ?? "Staff",
    });

    const sent = await sendEmail({ recipients: [email], subject, html, text });
    if (!sent.sent) {
      // Delivery is a global concern (bad key, provider down), not a per-account
      // one, so surfacing it doesn't identify anyone — and silently claiming
      // success would strand them.
      console.error("[password-reset] send failed:", sent.reason);
      return { ok: false, error: "We couldn't send the email. Please try again shortly." };
    }

    await auditReset(admin, {
      action: "request_password_reset",
      entity_id: account.id,
      actor_email: email,
      changes: { role, username: account.username },
    });

    return generic;
  } catch (err) {
    console.error("[password-reset] request failed:", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export type ResetTokenCheck = {
  valid: boolean;
  name: string | null;
  username: string | null;
  portal: Portal | null;
};

const INVALID: ResetTokenCheck = { valid: false, name: null, username: null, portal: null };

/**
 * Step 2 — is this link still good? Used by the reset page to decide between the
 * form and an "expired link" screen. Returns no secrets: just enough to greet
 * the user and point them at the right portal.
 */
export async function validateResetToken(token: string): Promise<ResetTokenCheck> {
  if (!token || !isProvisioningConfigured()) return INVALID;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("password_reset_tokens")
      .select("id, expires_at, used_at, allowed_users!inner(name, username, role)")
      .eq("token_hash", hashResetToken(token))
      .maybeSingle();

    if (!data || data.used_at) return INVALID;
    if (new Date(data.expires_at).getTime() <= Date.now()) return INVALID;

    // PostgREST types an embedded row as an array here; it's a to-one join.
    const acct = (Array.isArray(data.allowed_users)
      ? data.allowed_users[0]
      : data.allowed_users) as
      | { name: string | null; username: string | null; role: AllowedUserRole }
      | undefined;
    if (!acct) return INVALID;

    return {
      valid: true,
      name: acct.name,
      username: acct.username,
      portal: (acct.role as Portal) ?? null,
    };
  } catch (err) {
    console.error("[password-reset] token validation failed:", err);
    return INVALID;
  }
}

export type CompleteResetResult = { ok: boolean; error?: string; loginUrl?: string };

/**
 * Step 3 — spend the token and set the new password.
 *
 * Re-checks the token here rather than trusting validateResetToken from the page
 * render: the link could have expired, been spent, or been superseded in the
 * minutes the form sat open.
 */
export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<CompleteResetResult> {
  const token = (input.token ?? "").trim();
  const password = input.password ?? "";

  if (!token) return { ok: false, error: "This reset link is invalid." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (!isProvisioningConfigured()) {
    return { ok: false, error: "Password reset isn't set up. Please ask your admin." };
  }

  try {
    const admin = createAdminClient();

    const { data: row } = await admin
      .from("password_reset_tokens")
      .select("id, user_id, expires_at, used_at, allowed_users!inner(id, email, role)")
      .eq("token_hash", hashResetToken(token))
      .maybeSingle();

    const expired =
      !row || row.used_at || new Date(row.expires_at).getTime() <= Date.now();
    if (expired) {
      return {
        ok: false,
        error: "This reset link has expired or already been used. Please request a new one.",
      };
    }

    const acct = (Array.isArray(row.allowed_users)
      ? row.allowed_users[0]
      : row.allowed_users) as
      | { id: string; email: string; role: AllowedUserRole }
      | undefined;
    if (!acct) return { ok: false, error: "This reset link is invalid." };

    // ---- spend the token FIRST ----
    // Conditional on used_at still being null, so two submits racing each other
    // can't both pass: the loser updates 0 rows and stops here. Doing this before
    // the password change means a crash mid-flight leaves a burnt token, not a
    // reusable one.
    const { data: claimed } = await admin
      .from("password_reset_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("used_at", null)
      .select("id");

    if (!claimed || claimed.length === 0) {
      return {
        ok: false,
        error: "This reset link has already been used. Please request a new one.",
      };
    }

    const authUser = await findAuthUserByEmail(admin, acct.email);
    if (!authUser) {
      console.error(`[password-reset] no auth user for ${acct.id}`);
      return { ok: false, error: "Something went wrong. Please ask your admin for help." };
    }

    const { error: pwErr } = await admin.auth.admin.updateUserById(authUser.id, {
      password,
    });
    if (pwErr) {
      // The token is already spent (burning it first is what makes the race
      // above safe), so this link is finished either way — say so, rather than
      // leaving them retrying a dead link.
      return {
        ok: false,
        error: `${pwErr.message}. Please request a new reset link and try again.`,
      };
    }

    // They own their password now: drop the admin-visible temp copy and release
    // them from the forced-change screen the middleware would otherwise pin them
    // to. Also burn any other live tokens for this account.
    await admin
      .from("allowed_users")
      .update({ must_change_password: false, temp_password: null })
      .eq("id", acct.id);

    await admin
      .from("password_reset_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", acct.id)
      .is("used_at", null);

    await auditReset(admin, {
      action: "complete_password_reset",
      entity_id: acct.id,
      changes: { role: acct.role },
    });

    const portal = (acct.role as Portal) ?? "employee";
    return { ok: true, loginUrl: PORTAL_LOGIN[portal] ?? "/login" };
  } catch (err) {
    console.error("[password-reset] complete failed:", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
