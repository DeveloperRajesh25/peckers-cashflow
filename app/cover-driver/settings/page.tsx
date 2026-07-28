import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LogoutIcon } from "@/components/ui/icons";
import { requireRole } from "@/lib/supabase-server";
import { signOutAction } from "@/app/actions/auth";
import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { ChangePasswordCard } from "@/components/employee/ChangePasswordCard";

export const dynamic = "force-dynamic";

export default async function CoverDriverSettingsPage() {
  const user = await requireRole(["cover_driver"]);

  return (
    <>
      <PageHeader title="Settings" description="Your password and preferences." />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <AppearanceCard />
          <Card>
            <CardHeader>
              <CardTitle>Your Account</CardTitle>
              <CardDescription>Signed-in as</CardDescription>
            </CardHeader>
            <dl className="grid grid-cols-3 gap-y-3 text-sm">
              <dt className="text-text-muted">Name</dt>
              <dd className="col-span-2 text-text-primary">{user.allowed?.name || "—"}</dd>
              <dt className="text-text-muted">Username</dt>
              <dd className="col-span-2 text-text-primary">{user.allowed?.username || "—"}</dd>
            </dl>
            <form action={signOutAction} className="mt-6">
              <input type="hidden" name="portal" value="cover_driver" />
              <Button
                type="submit"
                variant="danger"
                iconLeft={<LogoutIcon size={16} />}
                className="w-full sm:w-auto"
              >
                Sign Out
              </Button>
            </form>
          </Card>
        </div>
        <ChangePasswordCard />
      </div>
    </>
  );
}
