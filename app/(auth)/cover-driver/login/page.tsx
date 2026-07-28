import { LoginForm } from "@/components/auth/LoginForm";
import { AuthShell } from "@/components/auth/AuthShell";

export const metadata = {
  title: "Cover driver sign in · Peckers",
};

export default function CoverDriverLoginPage() {
  return (
    <AuthShell
      badge="Cover Driver"
      title="Cover driver sign in"
      subtitle="Sign in to clock in and out of your cover shift. Use the username and password your manager gave you."
      otherPortals={[
        { href: "/employee/login", label: "Crew login" },
        { href: "/manager/login", label: "Manager login" },
      ]}
    >
      <LoginForm portal="cover_driver" />
    </AuthShell>
  );
}
