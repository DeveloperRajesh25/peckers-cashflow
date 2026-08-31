"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { NumberCell, useDeferredSync } from "@/components/weekly-report/NumberCell";
import {
  deleteLabourLine,
  prefillLabour,
  saveLabourLine,
} from "@/app/actions/weekly-report";
import {
  labourLineTotals,
  labourTotal,
  num,
  round2,
  type WeeklyReportLabourLine,
} from "@/lib/weekly-report";

const cellNum =
  "w-20 rounded-md border border-border bg-bg px-2 py-1.5 text-right font-mono text-sm text-text-primary focus:border-gold focus:outline-none disabled:opacity-60";
const cellText =
  "w-full min-w-[9rem] rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text-primary focus:border-gold focus:outline-none disabled:opacity-60";

const SOURCE_LABEL: Record<string, string> = {
  employee: "Employee",
  cover_driver: "Cover driver",
  manager: "Manager",
  adhoc: "Ad hoc",
};

type Draft = Record<string, string>;

/**
 * The Labour Cost sheet.
 *
 * The figure this produces is the FULL cost — NI hours + cash hours +
 * deliveries + a manager's fixed daily wage. It is deliberately NOT the Tuesday
 * payout's total, which excludes NI/bank hours because they go through PAYE.
 *
 * Prefill WRITES ROWS, which the manager then corrects; it is not a live join.
 * Re-running it replaces the prefilled rows and leaves ad-hoc ones untouched.
 */
export function LabourGrid({
  reportId,
  lines,
  readOnly,
}: {
  reportId: string;
  lines: WeeklyReportLabourLine[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [edits, setEdits] = React.useState<Record<string, Draft>>({});
  const [busy, setBusy] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");

  const signature = lines
    .map((l) => `${l.id}:${l.ni_hours}:${l.ni_rate}:${l.cash_hours}:${l.cash_rate}:${l.delivery_pay}`)
    .join("|");
  const sync = useDeferredSync(signature, () => setEdits({}));

  function fieldValue(line: WeeklyReportLabourLine, field: keyof WeeklyReportLabourLine): string {
    const edit = edits[line.id]?.[field as string];
    if (edit !== undefined) return edit;
    const v = line[field];
    return v == null ? "" : String(num(v));
  }

  function merged(line: WeeklyReportLabourLine): WeeklyReportLabourLine {
    const e = edits[line.id];
    if (!e) return line;
    return {
      ...line,
      ni_hours: e.ni_hours !== undefined ? num(e.ni_hours) : line.ni_hours,
      ni_rate: e.ni_rate !== undefined ? num(e.ni_rate) : line.ni_rate,
      cash_hours: e.cash_hours !== undefined ? num(e.cash_hours) : line.cash_hours,
      cash_rate: e.cash_rate !== undefined ? num(e.cash_rate) : line.cash_rate,
      delivery_pay: e.delivery_pay !== undefined ? num(e.delivery_pay) : line.delivery_pay,
      person_name: e.person_name !== undefined ? e.person_name : line.person_name,
    };
  }

  async function commit(line: WeeklyReportLabourLine) {
    if (readOnly || !edits[line.id]) return;
    const m = merged(line);
    setBusy(true);
    try {
      await saveLabourLine({
        report_id: reportId,
        id: line.id,
        person_name: m.person_name,
        source: m.source,
        hours: round2(num(m.ni_hours) + num(m.cash_hours)),
        ni_hours: num(m.ni_hours),
        ni_rate: num(m.ni_rate),
        cash_hours: num(m.cash_hours),
        cash_rate: num(m.cash_rate),
        deliveries: m.deliveries,
        delivery_pay: num(m.delivery_pay),
        sort_order: m.sort_order,
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that line");
    } finally {
      setBusy(false);
    }
  }

  async function runPrefill() {
    setBusy(true);
    try {
      const res = await prefillLabour({ report_id: reportId });
      toast.success(
        `Prefilled ${res.lines} ${res.lines === 1 ? "person" : "people"} from approved hours`,
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Prefill failed");
    } finally {
      setBusy(false);
    }
  }

  async function addAdhoc() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await saveLabourLine({
        report_id: reportId,
        person_name: name,
        source: "adhoc",
        sort_order: lines.length,
      });
      setNewName("");
      setAdding(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that person");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteLabourLine({ report_id: reportId, id });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that line");
    } finally {
      setBusy(false);
    }
  }

  const mergedLines = lines.map(merged);
  const total = labourTotal(mergedLines);

  return (
    <div className="flex flex-col gap-4">
      <div className="vm-card overflow-hidden" ref={sync.ref} onBlurCapture={sync.onBlurCapture}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Labour Cost</h3>
            <p className="text-xs text-text-muted">
              → Weekly Summary, Labour. Full cost: NI + cash + deliveries — not the Tuesday payout
              total, which pays cash only. A manager&apos;s fixed daily wage is prefilled as their
              effective hourly rate over the hours they clocked.
            </p>
          </div>
          {!readOnly && (
            <Button size="sm" variant="secondary" onClick={runPrefill} loading={busy}>
              Prefill from approved hours
            </Button>
          )}
        </div>

        <div className="table-scroll overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-hover text-xs uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2 text-left font-semibold">Person</th>
                <th className="px-3 py-2 text-right font-semibold">Hours worked</th>
                <th className="px-3 py-2 text-right font-semibold">NI hrs</th>
                <th className="px-3 py-2 text-right font-semibold">NI rate</th>
                <th className="px-3 py-2 text-right font-semibold">NI total</th>
                <th className="px-3 py-2 text-right font-semibold">Cash hrs</th>
                <th className="px-3 py-2 text-right font-semibold">Cash rate</th>
                <th className="px-3 py-2 text-right font-semibold">Cash total</th>
                <th className="px-3 py-2 text-right font-semibold">Deliveries</th>
                <th className="px-3 py-2 text-right font-semibold">Delivery pay</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                {!readOnly && <th className="w-10 px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const m = merged(line);
                const t = labourLineTotals(m);
                const numField = (field: keyof WeeklyReportLabourLine, step = "0.01") => (
                  <NumberCell
                    step={step}
                    min="0"
                    className={cellNum}
                    value={fieldValue(line, field)}
                    disabled={readOnly}
                    onValueChange={(v) =>
                      setEdits((p) => ({
                        ...p,
                        [line.id]: { ...p[line.id], [field]: v },
                      }))
                    }
                    onCommit={() => commit(line)}
                  />
                );
                return (
                  <tr key={line.id} className="border-b border-border">
                    <td className="px-3 py-1.5">
                      {line.source === "adhoc" ? (
                        <input
                          className={cellText}
                          value={
                            edits[line.id]?.person_name !== undefined
                              ? edits[line.id].person_name
                              : line.person_name
                          }
                          disabled={readOnly}
                          onChange={(e) =>
                            setEdits((p) => ({
                              ...p,
                              [line.id]: { ...p[line.id], person_name: e.target.value },
                            }))
                          }
                          onBlur={() => commit(line)}
                        />
                      ) : (
                        <div className="text-text-primary">
                          {line.person_name}
                          <span className="ml-2 text-xs text-text-muted">
                            {SOURCE_LABEL[line.source]}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-secondary">
                      {t.hours.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right">{numField("ni_hours")}</td>
                    <td className="px-3 py-1.5 text-right">{numField("ni_rate", "any")}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-secondary">
                      £{t.ni_total.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right">{numField("cash_hours")}</td>
                    <td className="px-3 py-1.5 text-right">{numField("cash_rate", "any")}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-secondary">
                      £{t.cash_total.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-muted">
                      {line.deliveries ?? 0}
                    </td>
                    <td className="px-3 py-1.5 text-right">{numField("delivery_pay")}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-text-primary">
                      £{t.total_pay.toFixed(2)}
                    </td>
                    {!readOnly && (
                      <td className="px-2 py-1.5 text-center">
                        <button
                          type="button"
                          onClick={() => remove(line.id)}
                          aria-label={`Remove ${line.person_name}`}
                          className="rounded px-2 py-1 text-text-muted transition hover:bg-surface-hover hover:text-red-500"
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-6 text-center text-sm text-text-muted">
                    Nobody costed yet. Prefill from approved hours to start.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-surface-hover font-semibold">
                <td className="px-3 py-2 text-text-primary" colSpan={10}>
                  Total labour cost
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
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            {adding ? (
              <>
                <input
                  autoFocus
                  className={cellText}
                  placeholder="Name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addAdhoc()}
                />
                <Button size="sm" onClick={addAdhoc} loading={busy}>
                  Add
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                Add Employee Pay
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
