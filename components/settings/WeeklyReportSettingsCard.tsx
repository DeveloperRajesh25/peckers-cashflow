"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { updateSettings } from "@/app/actions/settings";
import type { AppSettings } from "@/lib/settings";

function parseList(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

export function WeeklyReportSettingsCard({ initial }: { initial: AppSettings }) {
  const router = useRouter();
  const toast = useToast();
  const [recipients, setRecipients] = React.useState(initial.weekly_report.recipients.join("\n"));
  const [cc, setCc] = React.useState(initial.weekly_report.cc.join("\n"));
  const [requireLock, setRequireLock] = React.useState(
    initial.weekly_report.require_lock_to_send,
  );
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      await updateSettings({
        weekly_report: {
          recipients: parseList(recipients),
          cc: parseList(cc),
          require_lock_to_send: requireLock,
        },
      });
      toast.success("Weekly report settings saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly Report</CardTitle>
        <CardDescription>
          Who the locked weekly P&amp;L is emailed to, and whether a draft may be sent.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Textarea
            rows={3}
            label="Recipients"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            hint="One address per line. An empty list makes the send button refuse rather than silently reach nobody."
          />
          <Textarea
            rows={3}
            label="CC"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            hint="Optional — also emailed."
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireLock}
            onChange={(e) => setRequireLock(e.target.checked)}
            className="h-4 w-4 accent-gold"
          />
          <span>
            Require the report to be locked before it can be sent (a draft can still change under
            the reader)
          </span>
        </label>

        <div className="flex justify-end">
          <Button onClick={save} loading={busy}>
            Save weekly report settings
          </Button>
        </div>
      </div>
    </Card>
  );
}
