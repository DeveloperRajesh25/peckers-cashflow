import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { validateResetToken } from "@/app/actions/password-reset";
import { PORTAL_LOGIN, type Portal } from "@/lib/types";

export const metadata = {
  title: "Set a new password · Peckers",
};

// The token must be checked against the DB on every hit, never cached or
// prerendered — a spent link has to render as spent.
export const dynamic = "force-dynamic";

const PORTAL_BADGE: Record<Portal, string> = {
  admin: "Admin Portal",
  manager: "Manager Portal",
  employee: "Crew Portal",
  cover_driver: "Cover Driver Portal",
};

export default async function ResetPasswordPage({
  params,
}: {
  params: { token: string };
}) {
  const check = await validateResetToken(params.token);

  if (!check.valid) {
    return (
      <AuthShell
        badge="Password reset"
        title="This link doesn't work"
        subtitle="Reset links last 1 hour and can only be used once. Requesting a new one also cancels any older link."
        otherPortals={[
          { href: "/employee/login", label: "Crew login" },
          { href: "/manager/login", label: "Manager login" },
          { href: "/login", label: "Admin login" },
        ]}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Request a fresh link, or ask your admin to reset your password for you.
          </p>
          <Link
            href="/forgot-password"
            className="btn-base outline-none bg-gold text-black hover:bg-gold-300 h-12 px-5 text-base w-full"
          >
            Request a new link
          </Link>
        </div>
      </AuthShell>
    );
  }

  const portal = check.portal ?? "employee";

  return (
    <AuthShell
      badge={PORTAL_BADGE[portal]}
      title="Set a new password"
      subtitle={
        check.name
          ? `Hi ${check.name} — choose a new password for your account.`
          : "Choose a new password for your account."
      }
      otherPortals={[{ href: PORTAL_LOGIN[portal], label: "Back to sign in" }]}
    >
      <ResetPasswordForm token={params.token} username={check.username} />
    </AuthShell>
  );
}
