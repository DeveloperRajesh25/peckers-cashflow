import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { PORTAL_LOGIN, type Portal } from "@/lib/types";

export const metadata = {
  title: "Forgot password · Peckers",
};

const PORTAL_BADGE: Record<Portal, string> = {
  admin: "Admin Portal",
  manager: "Manager Portal",
  employee: "Crew Portal",
  cover_driver: "Cover Driver Portal",
};

/**
 * One shared forgot-password screen for all three portals. The account is
 * identified by its email alone, so ?portal= only decides which login page we
 * send them back to — it never narrows the lookup.
 */
export default function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: { portal?: string };
}) {
  const raw = searchParams.portal;
  const portal: Portal =
    raw === "admin" || raw === "manager" || raw === "employee" ? raw : "employee";

  return (
    <AuthShell
      badge={PORTAL_BADGE[portal]}
      title="Forgot your password?"
      subtitle="Enter the email address saved on your account and we'll send you a link to set a new password."
      otherPortals={[{ href: PORTAL_LOGIN[portal], label: "Back to sign in" }]}
    >
      <ForgotPasswordForm portal={portal} />
    </AuthShell>
  );
}
