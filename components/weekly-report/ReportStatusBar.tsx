"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  ensureWeeklyReport,
  importLegacyWeeklyInputs,
  lockWeeklyReport,
  sendWeeklyReport,
  unlockWeeklyReport,
} from "@/app/actions/weekly-report";
import { formatDateTimeShort } from "@/lib/utils";
import type { WeeklyReport } from "@/lib/weekly-report";

/**
 * Status, and the three acts that change it.
 *
 * LOCK freezes the week — the manager owns it end to end, so lock and send are
 * both theirs. UNLOCK is the single admin-only act, matching how a confirmed
 * cash_payouts row needs a Super Admin to reopen.
 *
 * SEND is outward-facing, so it always confirms first and names exactly who
 * will receive it.
 */
export function ReportStatusBar({
  report,
  storeId,
  weekStart,
  canUnlock,
  recipients,
  requireLockToSend,
  hasLegacyInputs,
}: {
  report: WeeklyReport | null;
  storeId: string;
  weekStart: string;
  canUnlock: boolean;
  recipients: string[];
  requireLockToSend: boolean;
  hasLegacyInputs: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [confirmSend, setConfirmSend] = React.useState(false);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  if (!report) {
    return (
      <div className="vm-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">No report for this week yet.</p>
          <p className="text-xs text-text-muted">
            Starting from last week copies every supplier, occupancy line and unit rate across, with
            the amounts blank.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy}
            onClick={() =>
              run(
                () =>
                  ensureWeeklyReport({
                    store_id: storeId,
                    week_start: weekStart,
                    seed_from_previous: true,
                  }),
                "Started from last week",
              )
            }
          >
            Start from last week
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() =>
              run(
                () => ensureWeeklyReport({ store_id: storeId, week_start: weekStart }),
                "Blank report created",
              )
            }
          >
            Start blank
          </Button>
        </div>
      </div>
    );
  }

  const locked = report.status !== "draft";

  return (
    <>
      <div className="vm-card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={report.status === "draft" ? "gold" : "success"}>
            {report.status === "draft" ? "Draft" : report.status === "sent" ? "Sent" : "Locked"}
          </Badge>
          {report.locked_at && (
            <span className="text-xs text-text-muted">
              Frozen {formatDateTimeShort(report.locked_at)}
            </span>
          )}
          {report.sent_at && (
            <span className="text-xs text-text-muted">
              Last sent {formatDateTimeShort(report.sent_at)} to{" "}
              {(report.sent_to ?? []).join(", ") || "—"}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {hasLegacyInputs && !locked && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() =>
                run(
                  () => importLegacyWeeklyInputs({ report_id: report.id }),
                  "Imported the old figures",
                )
              }
            >
              Import old figures
            </Button>
          )}
          {!locked && (
            <Button
              size="sm"
              loading={busy}
              onClick={() => run(() => lockWeeklyReport({ report_id: report.id }), "Report locked")}
            >
              Lock report
            </Button>
          )}
          {locked && canUnlock && (
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() =>
                run(() => unlockWeeklyReport({ report_id: report.id }), "Report unlocked")
              }
            >
              Unlock
            </Button>
          )}
          {locked && !canUnlock && (
            <span className="self-center text-xs text-text-muted">
              An admin must unlock this to edit it.
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || (requireLockToSend && !locked)}
            onClick={() => setConfirmSend(true)}
          >
            Send
          </Button>
        </div>
      </div>

      <Modal
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        title="Send this report?"
        description={
          recipients.length > 0
            ? `It will be emailed to ${recipients.join(", ")}.`
            : "No recipients are configured yet — add them in Settings → Weekly Report."
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmSend(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={recipients.length === 0}
              onClick={async () => {
                await run(() => sendWeeklyReport({ report_id: report.id }), "Report sent");
                setConfirmSend(false);
              }}
            >
              Send
            </Button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          The figures sent are the ones frozen at lock, so they will not change if a rate is edited
          afterwards.
        </p>
      </Modal>
    </>
  );
}
