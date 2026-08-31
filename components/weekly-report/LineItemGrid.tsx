"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { deleteReportLine, saveReportLine } from "@/app/actions/weekly-report";
import { NumberCell, useDeferredSync } from "@/components/weekly-report/NumberCell";
import {
  expenseVat,
  num,
  round2,
  type SectionDef,
  type WeeklyReportLine,
} from "@/lib/weekly-report";

/** Blank VAT means the standard rate, so an untouched line behaves as before. */
function draftVat(d: Draft, amount: number): number {
  return d.vat === "" ? expenseVat(amount) : round2(num(d.vat));
}

const cell =
  "w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text-primary focus:border-gold focus:outline-none disabled:opacity-60";
const cellNum = `${cell} text-right font-mono`;

type Draft = {
  id: string | null;
  label: string;
  qty: string;
  unit_rate: string;
  amount: string;
  vat: string;
  entry_date: string;
  note: string;
  /** Client-only key so a row that has never been saved still has React identity. */
  key: string;
};

function toDraft(l: WeeklyReportLine): Draft {
  return {
    id: l.id,
    label: l.label,
    qty: l.qty == null ? "" : String(num(l.qty)),
    unit_rate: l.unit_rate == null ? "" : String(num(l.unit_rate)),
    amount: l.amount == null ? "" : String(num(l.amount)),
    vat: l.vat_amount == null ? "" : String(num(l.vat_amount)),
    entry_date: l.entry_date ?? "",
    note: l.note ?? "",
    key: l.id,
  };
}

function draftAmount(d: Draft, shape: SectionDef["shape"]): number {
  if (shape === "qty_rate") return round2(num(d.qty) * num(d.unit_rate));
  return num(d.amount);
}

/**
 * The spreadsheet-style grid every section but Labour uses.
 *
 * Edits save on blur — a per-row Save button on a fifteen-supplier sheet is a
 * fifteen-click ritual nobody would keep up. A row with no label is never sent:
 * the server refuses it, and an empty new row is simply a row the manager
 * started and abandoned.
 */
export function LineItemGrid({
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
  const [drafts, setDrafts] = React.useState<Draft[]>(() => lines.map(toDraft));
  const [busy, setBusy] = React.useState(false);
  const newKey = React.useRef(0);

  // Server data wins whenever it changes underneath us (a prefill, a lock, a
  // carry-forward seed) — the grid is a view of the rows, not their owner.
  const signature = lines
    .map((l) => `${l.id}:${l.label}:${l.amount}:${l.vat_amount}:${l.qty}:${l.unit_rate}`)
    .join("|");
  const sync = useDeferredSync(signature, () => setDrafts(lines.map(toDraft)));

  const isQtyRate = def.shape === "qty_rate";
  const isDated = def.shape === "dated";

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  async function commit(key: string) {
    const draft = drafts.find((d) => d.key === key);
    if (!draft || readOnly) return;
    if (!draft.label.trim()) return;

    setBusy(true);
    try {
      const res = await saveReportLine({
        report_id: reportId,
        id: draft.id,
        section: def.key,
        label: draft.label,
        sort_order: drafts.findIndex((d) => d.key === key),
        entry_date: isDated ? draft.entry_date || null : null,
        qty: isQtyRate ? num(draft.qty) : null,
        unit_rate: isQtyRate ? num(draft.unit_rate) : null,
        amount: draftAmount(draft, def.shape),
        vat_amount: isDated && draft.vat !== "" ? round2(num(draft.vat)) : null,
        note: draft.note || null,
      });
      if (!draft.id) update(key, { id: res.id });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that line");
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    const draft = drafts.find((d) => d.key === key);
    if (!draft || readOnly) return;
    setDrafts((prev) => prev.filter((d) => d.key !== key));
    if (!draft.id) return;
    setBusy(true);
    try {
      await deleteReportLine({ report_id: reportId, id: draft.id });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that line");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function addRow() {
    newKey.current += 1;
    setDrafts((prev) => [
      ...prev,
      {
        id: null,
        label: "",
        qty: "",
        unit_rate: def.defaultUnitRate != null ? String(def.defaultUnitRate) : "",
        amount: "",
        vat: "",
        entry_date: "",
        note: "",
        key: `new-${newKey.current}`,
      },
    ]);
  }

  const total = round2(drafts.reduce((t, d) => t + draftAmount(d, def.shape), 0));
  const vatTotal = round2(
    drafts.reduce((t, d) => t + draftVat(d, draftAmount(d, def.shape)), 0),
  );

  return (
    <div className="vm-card overflow-hidden" ref={sync.ref} onBlurCapture={sync.onBlurCapture}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">{def.title}</h3>
        <span className="text-xs text-text-muted">
          {def.feeds ? `→ Weekly Summary, ${def.feeds}` : "Record only — does not affect the P&L"}
        </span>
      </div>

      <div className="table-scroll overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-hover text-xs uppercase tracking-wide text-text-muted">
              {isDated && <th className="px-3 py-2 text-left font-semibold">Date</th>}
              <th className="px-3 py-2 text-left font-semibold">{def.labelHeading}</th>
              {isQtyRate && <th className="px-3 py-2 text-right font-semibold">Qty</th>}
              {isQtyRate && <th className="px-3 py-2 text-right font-semibold">£ / unit</th>}
              <th className="px-3 py-2 text-right font-semibold">Amount</th>
              {isDated && <th className="px-3 py-2 text-right font-semibold">VAT</th>}
              <th className="px-3 py-2 text-left font-semibold">
                {isDated ? "Paid by" : "Note"}
              </th>
              {!readOnly && <th className="w-10 px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => {
              const amount = draftAmount(d, def.shape);
              return (
                <tr key={d.key} className="border-b border-border">
                  {isDated && (
                    <td className="px-3 py-1.5">
                      <input
                        type="date"
                        className={cell}
                        value={d.entry_date}
                        disabled={readOnly}
                        onChange={(e) => update(d.key, { entry_date: e.target.value })}
                        onBlur={() => commit(d.key)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    <input
                      className={cell}
                      value={d.label}
                      placeholder={def.labelHeading}
                      disabled={readOnly}
                      onChange={(e) => update(d.key, { label: e.target.value })}
                      onBlur={() => commit(d.key)}
                    />
                  </td>
                  {isQtyRate && (
                    <td className="px-3 py-1.5">
                      <NumberCell
                        step="0.001"
                        min="0"
                        className={cellNum}
                        value={d.qty}
                        disabled={readOnly}
                        onValueChange={(v) => update(d.key, { qty: v })}
                        onCommit={() => commit(d.key)}
                      />
                    </td>
                  )}
                  {isQtyRate && (
                    <td className="px-3 py-1.5">
                      <NumberCell
                        step="0.01"
                        min="0"
                        className={cellNum}
                        value={d.unit_rate}
                        disabled={readOnly}
                        onValueChange={(v) => update(d.key, { unit_rate: v })}
                        onCommit={() => commit(d.key)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    {isQtyRate ? (
                      <div className="px-2 py-1.5 text-right font-mono text-text-primary">
                        £{amount.toFixed(2)}
                      </div>
                    ) : (
                      <NumberCell
                        step="0.01"
                        className={cellNum}
                        value={d.amount}
                        disabled={readOnly}
                        onValueChange={(v) => update(d.key, { amount: v })}
                        onCommit={() => commit(d.key)}
                      />
                    )}
                  </td>
                  {isDated && (
                    <td className="px-3 py-1.5">
                      <NumberCell
                        step="0.01"
                        className={cellNum}
                        value={d.vat}
                        placeholder={expenseVat(amount).toFixed(2)}
                        disabled={readOnly}
                        onValueChange={(v) => update(d.key, { vat: v })}
                        onCommit={() => commit(d.key)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-1.5">
                    <input
                      className={cell}
                      value={d.note}
                      placeholder={isDated ? "Cash / card" : "Invoice ref"}
                      disabled={readOnly}
                      onChange={(e) => update(d.key, { note: e.target.value })}
                      onBlur={() => commit(d.key)}
                    />
                  </td>
                  {!readOnly && (
                    <td className="px-2 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => remove(d.key)}
                        aria-label={`Remove ${d.label || "line"}`}
                        className="rounded px-2 py-1 text-text-muted transition hover:bg-surface-hover hover:text-red-500"
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {drafts.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-sm text-text-muted"
                >
                  No lines yet.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-surface-hover font-semibold">
              <td
                className="px-3 py-2 text-text-primary"
                colSpan={(isDated ? 2 : 1) + (isQtyRate ? 2 : 0)}
              >
                Total
              </td>
              <td className="px-3 py-2 text-right font-mono text-text-primary">
                £{total.toFixed(2)}
              </td>
              {isDated && (
                <td className="px-3 py-2 text-right font-mono text-text-muted">
                  £{vatTotal.toFixed(2)}
                </td>
              )}
              <td className="px-3 py-2" />
              {!readOnly && <td className="px-2 py-2" />}
            </tr>
          </tfoot>
        </table>
      </div>

      {!readOnly && (
        <div className="border-t border-border px-4 py-3">
          <Button size="sm" variant="secondary" onClick={addRow} disabled={busy}>
            Add line
          </Button>
        </div>
      )}
    </div>
  );
}
