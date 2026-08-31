"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { deleteReportLine, saveReportLine } from "@/app/actions/weekly-report";
import { NumberCell, useDeferredSync } from "@/components/weekly-report/NumberCell";
import {
  MAX_INVOICE_COLUMNS,
  groupSupplierLines,
  invoiceColumnCount,
  lineAmount,
  num,
  round2,
  type SectionDef,
  type WeeklyReportLine,
} from "@/lib/weekly-report";

const cell =
  "w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text-primary focus:border-gold focus:outline-none disabled:opacity-60";
const cellNum = `${cell} text-right font-mono`;

type InvoiceCell = {
  id: string | null;
  amount: string;
  /** Preserved, never edited here — the column header is the invoice's name now. */
  note: string | null;
};

type SupplierDraft = {
  key: string;
  label: string;
  invoices: InvoiceCell[];
};

function toDrafts(lines: WeeklyReportLine[]): SupplierDraft[] {
  return groupSupplierLines(lines).map((g) => ({
    key: g.key,
    label: g.label,
    invoices: g.invoices.map((l) => ({
      id: l.id,
      amount: String(lineAmount(l)),
      note: l.note,
    })),
  }));
}

function draftTotal(d: SupplierDraft): number {
  return round2(d.invoices.reduce((t, i) => t + (i.amount === "" ? 0 : num(i.amount)), 0));
}

/**
 * Cost of Goods, in the shape of the sheet it replaces: ONE ROW PER SUPPLIER
 * with a column per invoice and the supplier's week total on the right.
 *
 * The rows underneath are still one per invoice — that is what the P&L sums —
 * so this grid groups them on the supplier name and writes each cell back to
 * its own row. Typing a supplier three times to enter three invoices was the
 * spreadsheet turned inside out.
 */
export function SupplierInvoiceGrid({
  reportId,
  def,
  lines,
  readOnly,
}: {
  reportId: string;
  def: SectionDef;
  lines: WeeklyReportLine[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [drafts, setDrafts] = React.useState<SupplierDraft[]>(() => toDrafts(lines));
  const [extraColumns, setExtraColumns] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const newKey = React.useRef(0);

  const signature = lines
    .map((l) => `${l.id}:${l.label}:${l.amount}`)
    .join("|");
  const sync = useDeferredSync(signature, () => setDrafts(toDrafts(lines)));

  const columns = Math.min(
    MAX_INVOICE_COLUMNS,
    invoiceColumnCount(groupSupplierLines(lines)) + extraColumns,
  );

  function update(key: string, patch: Partial<SupplierDraft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function setCell(key: string, column: number, value: string) {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.key !== key) return d;
        const invoices = [...d.invoices];
        while (invoices.length <= column) invoices.push({ id: null, amount: "", note: null });
        invoices[column] = { ...invoices[column], amount: value };
        return { ...d, invoices };
      }),
    );
  }

  /** One invoice cell → one stored row. Cleared with a row behind it deletes it. */
  async function commitCell(key: string, column: number) {
    if (readOnly) return;
    const index = drafts.findIndex((d) => d.key === key);
    const draft = drafts[index];
    if (!draft) return;
    const invoice = draft.invoices[column];
    if (!invoice) return;
    const label = draft.label.trim();
    if (!label) return;

    if (invoice.amount === "") {
      if (!invoice.id) return;
      await run(async () => {
        await deleteReportLine({ report_id: reportId, id: invoice.id! });
      });
      return;
    }

    await run(async () => {
      const res = await saveReportLine({
        report_id: reportId,
        id: invoice.id,
        section: def.key,
        label,
        // Suppliers are spaced apart so a supplier's invoices always order
        // together, whatever order the cells were typed in.
        sort_order: index * MAX_INVOICE_COLUMNS + column,
        amount: round2(num(invoice.amount)),
        note: invoice.note,
      });
      if (!invoice.id) {
        setDrafts((prev) =>
          prev.map((d) => {
            if (d.key !== key) return d;
            const invoices = [...d.invoices];
            invoices[column] = { ...invoices[column], id: res.id };
            return { ...d, invoices };
          }),
        );
      }
    });
  }

  /**
   * Renaming the row renames every invoice on it — they are one supplier. It
   * also writes any amount typed before the supplier was named, which is the
   * order a row filled left to right is actually entered in.
   */
  async function commitLabel(key: string) {
    if (readOnly) return;
    const index = drafts.findIndex((d) => d.key === key);
    const draft = drafts[index];
    if (!draft || !draft.label.trim()) return;
    if (!draft.invoices.some((i) => i.id || i.amount !== "")) return;

    await run(async () => {
      for (const [column, invoice] of draft.invoices.entries()) {
        if (invoice.amount === "") {
          if (invoice.id) await deleteReportLine({ report_id: reportId, id: invoice.id });
          continue;
        }
        await saveReportLine({
          report_id: reportId,
          id: invoice.id,
          section: def.key,
          label: draft.label.trim(),
          sort_order: index * MAX_INVOICE_COLUMNS + column,
          amount: round2(num(invoice.amount)),
          note: invoice.note,
        });
      }
    });
  }

  async function removeSupplier(key: string) {
    if (readOnly) return;
    const draft = drafts.find((d) => d.key === key);
    if (!draft) return;
    setDrafts((prev) => prev.filter((d) => d.key !== key));
    const ids = draft.invoices.map((i) => i.id).filter(Boolean) as string[];
    if (ids.length === 0) return;
    await run(async () => {
      for (const id of ids) await deleteReportLine({ report_id: reportId, id });
    });
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that line");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function addSupplier() {
    newKey.current += 1;
    setDrafts((prev) => [
      ...prev,
      { key: `new-${newKey.current}`, label: "", invoices: [] },
    ]);
  }

  const total = round2(drafts.reduce((t, d) => t + draftTotal(d), 0));
  const columnIndexes = Array.from({ length: columns }, (_, i) => i);

  return (
    <div className="vm-card overflow-hidden" ref={sync.ref} onBlurCapture={sync.onBlurCapture}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{def.title}</h3>
        <span className="text-xs text-text-muted">
          {def.feeds ? `→ Weekly Summary, ${def.feeds}` : "Record only — does not affect the P&L"}
        </span>
      </div>

      <div className="table-scroll overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-hover text-xs uppercase tracking-wide text-text-muted">
              <th className="px-3 py-2 text-left font-semibold">{def.labelHeading}</th>
              {columnIndexes.map((i) => (
                <th key={i} className="px-3 py-2 text-right font-semibold">
                  Invoice {i + 1}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-semibold">Total</th>
              {!readOnly && <th className="w-10 px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.key} className="border-b border-border">
                <td className="px-3 py-1.5">
                  <input
                    className={cell}
                    value={d.label}
                    placeholder={def.labelHeading}
                    disabled={readOnly}
                    onChange={(e) => update(d.key, { label: e.target.value })}
                    onBlur={() => commitLabel(d.key)}
                  />
                </td>
                {columnIndexes.map((i) => (
                  <td key={i} className="px-3 py-1.5">
                    <NumberCell
                      step="0.01"
                      className={cellNum}
                      placeholder="0.00"
                      value={d.invoices[i]?.amount ?? ""}
                      disabled={readOnly}
                      onValueChange={(v) => setCell(d.key, i, v)}
                      onCommit={() => commitCell(d.key, i)}
                    />
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-mono text-text-primary">
                  £{draftTotal(d).toFixed(2)}
                </td>
                {!readOnly && (
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => removeSupplier(d.key)}
                      aria-label={`Remove ${d.label || "supplier"}`}
                      className="rounded px-2 py-1 text-text-muted transition hover:bg-surface-hover hover:text-red-500"
                    >
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {drafts.length === 0 && (
              <tr>
                <td
                  colSpan={columns + 3}
                  className="px-3 py-6 text-center text-sm text-text-muted"
                >
                  No suppliers yet.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-surface-hover font-semibold">
              <td className="px-3 py-2 text-text-primary" colSpan={columns + 1}>
                Totals
              </td>
              <td className="px-3 py-2 text-right font-mono text-text-primary">
                £{total.toFixed(2)}
              </td>
              {!readOnly && <td className="px-2 py-2" />}
            </tr>
          </tfoot>
        </table>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="secondary" onClick={addSupplier} disabled={busy}>
            Add supplier
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExtraColumns((n) => n + 1)}
            disabled={busy || columns >= MAX_INVOICE_COLUMNS}
          >
            Add invoice column
          </Button>
        </div>
      )}
    </div>
  );
}
