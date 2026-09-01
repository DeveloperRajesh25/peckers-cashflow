"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { saveReportHeader } from "@/app/actions/weekly-report";
import { useSelectOnFocus } from "@/components/weekly-report/NumberCell";
import { num, type WeeklyReport } from "@/lib/weekly-report";

/**
 * The figures the workbook keeps as single hand-typed numbers, plus the two
 * budget targets. Everything else on the summary is a roll-up of a sub-page.
 *
 * The COGS transfer used to be typed here too. It is the transfer tab's own
 * total, so it is now read from there and this card no longer asks for it.
 */
export function HeaderInputsCard({
  report,
  readOnly,
  showMeppershall,
}: {
  report: WeeklyReport;
  readOnly: boolean;
  /** Only the store that supplies Meppershall carries the figure — migration 051. */
  showMeppershall: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({
    packaging_costs: report.packaging_costs == null ? "" : String(num(report.packaging_costs)),
    marketing: report.marketing == null ? "" : String(num(report.marketing)),
    meppershall: report.meppershall == null ? "" : String(num(report.meppershall)),
    // Stored as a decimal, edited as a whole number.
    gross_margin_budget_pct:
      report.gross_margin_budget_pct == null
        ? ""
        : String(round1(num(report.gross_margin_budget_pct) * 100)),
    labour_budget_pct:
      report.labour_budget_pct == null
        ? ""
        : String(round1(num(report.labour_budget_pct) * 100)),
  });

  async function save() {
    setBusy(true);
    try {
      await saveReportHeader({
        report_id: report.id,
        packaging_costs: form.packaging_costs === "" ? null : num(form.packaging_costs),
        marketing: form.marketing === "" ? null : num(form.marketing),
        ...(showMeppershall
          ? { meppershall: form.meppershall === "" ? null : num(form.meppershall) }
          : {}),
        gross_margin_budget_pct:
          form.gross_margin_budget_pct === "" ? null : num(form.gross_margin_budget_pct),
        labour_budget_pct: form.labour_budget_pct === "" ? null : num(form.labour_budget_pct),
      });
      toast.success("Saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const select = useSelectOnFocus();

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="vm-card p-5">
      <h3 className="text-sm font-semibold text-text-primary">Typed-in figures</h3>
      <p className="mt-1 text-xs text-text-muted">
        The workbook keeps these as single numbers with no supporting sheet.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          type="number"
          step="0.01"
          label="Packaging costs"
          prefix="£"
          value={form.packaging_costs}
          disabled={readOnly}
          {...select}
          onChange={set("packaging_costs")}
        />
        <Input
          type="number"
          step="0.01"
          label="Marketing"
          prefix="£"
          value={form.marketing}
          disabled={readOnly}
          {...select}
          onChange={set("marketing")}
          hint="Informational — not deducted anywhere"
        />
        {showMeppershall && (
          <Input
            type="number"
            step="0.01"
            label="Meppershall"
            prefix="£"
            value={form.meppershall}
            disabled={readOnly}
            {...select}
            onChange={set("meppershall")}
            hint="Credited back into gross margin"
          />
        )}
        <Input
          type="number"
          step="0.1"
          min="0"
          max="100"
          label="Gross margin budget %"
          value={form.gross_margin_budget_pct}
          disabled={readOnly}
          {...select}
          onChange={set("gross_margin_budget_pct")}
          hint="Whole number, e.g. 65"
        />
        <Input
          type="number"
          step="0.1"
          min="0"
          max="100"
          label="Labour budget %"
          value={form.labour_budget_pct}
          disabled={readOnly}
          {...select}
          onChange={set("labour_budget_pct")}
          hint="Whole number, e.g. 26"
        />
      </div>

      {!readOnly && (
        <div className="mt-4 flex justify-end">
          <Button onClick={save} loading={busy}>
            Save figures
          </Button>
        </div>
      )}
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
