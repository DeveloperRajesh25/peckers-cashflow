"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { CheckIcon } from "@/components/ui/icons";
import { upsertDailyCashEntry } from "@/app/actions/cash-flow";
import { formatGBP } from "@/lib/utils";
import type { DailyCashEntry } from "@/lib/types";

/**
 * Compact "quick entry" card for managers on the live dashboard — logs today's
 * cash reconciliation for their store. The full form (back-dating, history)
 * lives at /manager/cash-flow/daily.
 */
export function ManagerQuickEntry({
  storeId,
  today,
  existing,
}: {
  storeId: string;
  today: string;
  existing: DailyCashEntry | null;
}) {
  const router = useRouter();
  const toast = useToast();

  const initialExp = existing
    ? Math.max(
        0,
        Math.round(
          (Number(existing.vita_mojo_sales) - Number(existing.supermarket_expenses || 0)) * 100,
        ) / 100,
      )
    : 0;
  const [vita, setVita] = React.useState(existing ? String(existing.vita_mojo_sales) : "");
  const [supermarket, setSupermarket] = React.useState(
    existing?.supermarket_expenses ? String(existing.supermarket_expenses) : "",
  );
  const [envelope, setEnvelope] = React.useState(
    existing ? String(existing.envelope_amount) : "",
  );
  const [envelopeTouched, setEnvelopeTouched] = React.useState(
    existing ? Math.abs(Number(existing.envelope_amount) - initialExp) > 0.001 : false,
  );
  const [reason, setReason] = React.useState(existing?.reason ?? "");
  const [busy, setBusy] = React.useState(false);

  const vitaNum = Number(vita) || 0;
  const superNum = Number(supermarket) || 0;
  // The envelope is expected to equal sales − supermarket expenses.
  const expectedEnvelope = Math.max(0, Math.round((vitaNum - superNum) * 100) / 100);
  const envNum = envelopeTouched ? Number(envelope) || 0 : expectedEnvelope;
  const overridden = envelopeTouched && Math.abs(envNum - expectedEnvelope) > 0.001;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (vita === "") {
      toast.error("Vita Mojo cash sales is required.");
      return;
    }
    if (overridden && !reason.trim()) {
      toast.error("Give a reason — the envelope differs from sales − supermarket expenses.");
      return;
    }
    setBusy(true);
    try {
      await upsertDailyCashEntry({
        store_id: storeId,
        entry_date: today,
        vita_mojo_sales: vitaNum,
        envelope_amount: envNum,
        supermarket_expenses: superNum,
        reason: overridden ? reason.trim() || null : null,
      });
      toast.success(existing ? "Today's entry updated" : "Today's entry saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        action={
          existing ? (
            <Badge variant="gold">
              <CheckIcon size={12} /> Today logged
            </Badge>
          ) : null
        }
      >
        <CardTitle>Quick Cash Entry</CardTitle>
        <CardDescription>Log today&apos;s cash for your store.</CardDescription>
      </CardHeader>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            label="Vita Mojo sales *"
            prefix="£"
            placeholder="0.00"
            value={vita}
            onChange={(e) => setVita(e.target.value)}
          />
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            label="Supermarket expenses"
            prefix="£"
            placeholder="0.00"
            value={supermarket}
            onChange={(e) => setSupermarket(e.target.value)}
          />
        </div>
        <div>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            label="Cash in envelope"
            prefix="£"
            placeholder="0.00"
            value={envelopeTouched ? envelope : String(expectedEnvelope.toFixed(2))}
            onChange={(e) => {
              setEnvelopeTouched(true);
              setEnvelope(e.target.value);
            }}
          />
          <div className="flex items-center justify-between gap-2 flex-wrap mt-1.5">
            <span className="text-[11px] text-text-muted">
              Auto = sales − supermarket = {formatGBP(expectedEnvelope)}
            </span>
            {envelopeTouched && (
              <button
                type="button"
                onClick={() => {
                  setEnvelopeTouched(false);
                  setReason("");
                }}
                className="text-[11px] text-gold hover:underline"
              >
                Reset to auto
              </button>
            )}
          </div>
        </div>

        {overridden && (
          <Input
            label="Reason for overriding the envelope *"
            placeholder="e.g. £10 float left in till overnight"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
          />
        )}

        <div className="flex items-center gap-2">
          <Button type="submit" loading={busy} className="flex-1">
            {existing ? "Update" : "Save"}
          </Button>
          <Link
            href="/manager/cash-flow/daily"
            className="btn-base outline-none bg-surface text-text-primary border border-border hover:bg-surface-hover min-h-11 px-4 py-2 text-sm shrink-0 whitespace-nowrap"
          >
            Full form
          </Link>
        </div>
      </form>
    </Card>
  );
}
