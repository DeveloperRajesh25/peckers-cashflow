"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { DownloadIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { addManualNiRecord, deleteManualNiRecord } from "@/app/actions/ni";
import { downloadCSV, formatGBP, formatGBPPlain, toCSV } from "@/lib/utils";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";

export type NiRow = {
  /** Present only for persisted manual rows (the manual_ni_records id). */
  id?: string;
  store_id: string | null;
  /** YYYY-MM month key (month of the week's Monday). */
  month: string;
  employee_id: string;
  employee_name: string;
  ni_hours: number;
  ni_wages: number;
  /** True for rows added by hand on this page (persisted, print/export only). */
  manual?: boolean;
};

/** A persisted hand-added NI line (always has a database id). */
export type ManualNiRow = NiRow & { id: string; manual: true };

type StoreOpt = { id: string; name: string };

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

/**
 * NI (PAYE) wages grouped by calendar month. NI is paid monthly; cash weekly.
 * Admins toggle between stores (each store's figures stay fully separate);
 * managers see only their own store. Exportable as CSV or PDF (print).
 */
export function NiMonthlyView({
  rows,
  manualRows,
  stores,
  isAdmin,
}: {
  rows: NiRow[];
  /** Persisted hand-added NI lines (synced across admin + manager dashboards). */
  manualRows: ManualNiRow[];
  stores: StoreOpt[];
  isAdmin: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [activeStoreId, setActiveStoreId] = React.useState(stores[0]?.id ?? "");
  const activeStore = stores.find((s) => s.id === activeStoreId) ?? stores[0];

  // Hand-added rows for an off-system NI line in the summary. These are now
  // persisted (manual_ni_records) so they survive refreshes and show for every
  // admin and the store's managers. They don't affect any computed figures.
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const storeRows = React.useMemo(
    () => [...rows, ...manualRows].filter((r) => r.store_id === activeStore?.id),
    [rows, manualRows, activeStore?.id],
  );

  async function addManualRow(input: {
    month: string;
    employee_name: string;
    ni_hours: number;
    ni_wages: number;
  }) {
    if (!activeStore) return;
    setBusy(true);
    try {
      await addManualNiRecord({ store_id: activeStore.id, ...input });
      setAdding(false);
      toast.success("Manual NI record saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save record");
    } finally {
      setBusy(false);
    }
  }

  async function removeManualRow(id: string) {
    setBusy(true);
    try {
      await deleteManualNiRecord(id);
      toast.success("Manual NI record removed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove record");
    } finally {
      setBusy(false);
    }
  }

  // month -> employee -> aggregated totals
  const byMonth = React.useMemo(() => {
    const m = new Map<string, Map<string, NiRow>>();
    for (const r of storeRows) {
      if (!m.has(r.month)) m.set(r.month, new Map());
      const emp = m.get(r.month)!;
      const existing = emp.get(r.employee_id);
      if (existing) {
        existing.ni_hours += r.ni_hours;
        existing.ni_wages += r.ni_wages;
      } else {
        emp.set(r.employee_id, { ...r });
      }
    }
    return m;
  }, [storeRows]);

  const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));

  function exportCSV() {
    const headers = ["Month", "Store", "Employee", "NI hours", "NI wages (PAYE)"];
    const out: (string | number)[][] = [];
    for (const mk of months) {
      for (const e of Array.from(byMonth.get(mk)!.values()).sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name),
      )) {
        out.push([
          monthLabel(mk),
          activeStore?.name ?? "",
          e.employee_name,
          e.ni_hours.toFixed(2),
          formatGBPPlain(e.ni_wages),
        ]);
      }
    }
    downloadCSV(
      `peckers-ni-monthly-${(activeStore?.name ?? "store").toLowerCase().replace(/\s+/g, "-")}.csv`,
      toCSV(headers, out),
    );
  }

  if (!activeStore) {
    return (
      <Card>
        <p className="text-sm text-text-muted">No stores configured.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Store toggle (admin) + export actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
        <div className="flex gap-2 flex-wrap">
          {isAdmin && stores.length > 1 ? (
            stores.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveStoreId(s.id)}
                className={
                  "px-4 h-10 rounded-xl border text-sm font-medium transition-colors " +
                  (s.id === activeStore.id
                    ? "bg-gold text-black border-gold"
                    : "bg-surface text-text-primary border-border hover:bg-surface-hover")
                }
              >
                {s.name}
              </button>
            ))
          ) : (
            <p className="text-sm text-text-muted self-center">{activeStore.name}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setAdding(true)}
            iconLeft={<PlusIcon size={16} />}
          >
            Add manual record
          </Button>
          <Button
            variant="secondary"
            onClick={exportCSV}
            iconLeft={<DownloadIcon size={16} />}
            disabled={months.length === 0}
          >
            CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => window.print()}
            disabled={months.length === 0}
          >
            PDF
          </Button>
        </div>
      </div>

      {months.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            No approved hours for {activeStore.name} yet. Approve clocked hours on the
            Employees page and they will appear here.
          </p>
        </Card>
      ) : (
        months.map((mk) => {
          const emps = Array.from(byMonth.get(mk)!.values()).sort((a, b) =>
            a.employee_name.localeCompare(b.employee_name),
          );
          const hoursTotal = emps.reduce((s, e) => s + e.ni_hours, 0);
          const niTotal = emps.reduce((s, e) => s + e.ni_wages, 0);
          return (
            <Card key={mk} className="p-0 overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-text-primary">
                  {monthLabel(mk)} — {activeStore.name}
                </h2>
                <div className="text-right">
                  <p className="text-xs text-text-muted">NI (PAYE) total</p>
                  <p className="text-lg font-semibold text-gold tabular-nums">
                    {formatGBP(niTotal)}
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
                      <th className="px-4 py-2.5 font-medium">Employee</th>
                      <th className="px-4 py-2.5 font-medium text-right">NI hours</th>
                      <th className="px-4 py-2.5 font-medium text-right">NI wages</th>
                      <th className="px-4 py-2.5 w-10 print:hidden"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {emps.map((e, i) => (
                      <tr
                        key={e.employee_id}
                        className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}
                      >
                        <td className="px-4 py-2.5 font-medium">
                          {e.employee_name}
                          {e.manual && (
                            <Badge variant="gold" className="ml-2 text-[10px] py-0 px-1.5 print:hidden">
                              Manual
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          <HoursMinsDisplay hours={e.ni_hours} />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatGBP(e.ni_wages)}
                        </td>
                        <td className="px-2 py-2.5 text-right print:hidden">
                          {e.manual && e.id && (
                            <button
                              onClick={() => removeManualRow(e.id!)}
                              disabled={busy}
                              aria-label="Delete manual row"
                              title="Delete"
                              className="text-text-muted hover:text-danger transition-colors disabled:opacity-40"
                            >
                              <TrashIcon size={15} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border bg-bg/60 font-semibold">
                      <td className="px-4 py-2.5">Total</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <HoursMinsDisplay hours={hoursTotal} />
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gold">
                        {formatGBP(niTotal)}
                      </td>
                      <td className="print:hidden"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          );
        })
      )}

      {adding && (
        <ManualNiModal
          storeName={activeStore.name}
          busy={busy}
          onClose={() => setAdding(false)}
          onAdd={addManualRow}
        />
      )}
    </div>
  );
}

/** Manual NI line — collects a month, name, hours and wages (persisted). */
function ManualNiModal({
  storeName,
  busy,
  onClose,
  onAdd,
}: {
  storeName: string;
  busy: boolean;
  onClose: () => void;
  onAdd: (input: {
    month: string;
    employee_name: string;
    ni_hours: number;
    ni_wages: number;
  }) => void;
}) {
  // Last 12 months (current first) as YYYY-MM options.
  const monthOptions = React.useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return { key, label: monthLabel(key) };
    });
  }, []);

  const [month, setMonth] = React.useState(monthOptions[0].key);
  const [name, setName] = React.useState("");
  const [hours, setHours] = React.useState("");
  const [wages, setWages] = React.useState("");

  const canSave = name.trim() !== "" && wages !== "";

  function save() {
    if (!canSave) return;
    onAdd({
      month,
      employee_name: name.trim(),
      ni_hours: Number(hours) || 0,
      ni_wages: Number(wages) || 0,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add manual NI record"
      description={`Saved to the ${storeName} summary and shared across the admin and manager dashboards.`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave || busy} loading={busy}>
            Add row
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
          {monthOptions.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </Select>
        <Input
          label="Employee name *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sandeep Kumar"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            label="NI hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="0.0"
          />
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            label="NI wages *"
            prefix="£"
            value={wages}
            onChange={(e) => setWages(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>
    </Modal>
  );
}
