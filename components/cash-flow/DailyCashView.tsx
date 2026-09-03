"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  TrashIcon,
  PencilIcon,
} from "@/components/ui/icons";
import { upsertDailyCashEntry, deleteDailyCashEntry } from "@/app/actions/cash-flow";
import { runningBalanceRows } from "@/lib/cash-flow";
import {
  addDays,
  formatDDMMYYYY,
  formatGBP,
  todayISO,
  weekLabel,
  parseISODate,
  startOfISOWeek,
  toISODate,
} from "@/lib/utils";
import type { DailyCashEntry } from "@/lib/types";

type StoreOpt = { id: string; name: string };

export function DailyCashView({
  stores,
  entries,
  recentEntries = [],
  weekStart,
  prevWeek,
  nextWeek,
  openingByStore,
  isAdmin,
  basePath,
  defaultStoreId,
}: {
  stores: StoreOpt[];
  entries: DailyCashEntry[];
  /** Entries for the last 3 days (any week) so the quick form can pre-fill. */
  recentEntries?: DailyCashEntry[];
  weekStart: string;
  prevWeek: string;
  nextWeek: string;
  openingByStore: Record<string, number>;
  isAdmin: boolean;
  basePath: string;
  defaultStoreId: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [storeId, setStoreId] = React.useState<string>(defaultStoreId);
  const weekEndDate = new Date(parseISODate(weekStart).getTime() + 6 * 86400000);
  const weekEnd = formatDDMMYYYY(weekEndDate);

  const inWeek = (iso: string) => iso >= weekStart && iso <= toISODate(weekEndDate);

  const today = todayISO();
  // The only three dates an entry may be recorded for: today, yesterday, and
  // the day before. Shown as quick buttons (no free calendar).
  const dateOptions = React.useMemo(
    () =>
      [0, 1, 2].map((d) => {
        const iso = toISODate(addDays(parseISODate(today), -d));
        return {
          iso,
          label: d === 0 ? "Today" : d === 1 ? "Yesterday" : "Day before",
          short: formatDDMMYYYY(iso).slice(0, 5),
        };
      }),
    [today],
  );

  const [date, setDate] = React.useState<string>(today);
  const [vita, setVita] = React.useState("");
  const [supermarket, setSupermarket] = React.useState("");
  const [envelope, setEnvelope] = React.useState("");
  // Whether the user has manually overridden the auto-computed envelope.
  const [envelopeTouched, setEnvelopeTouched] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Picking a date outside the loaded week jumps to that week so the log + any
  // existing entry line up (prefill also works via recentEntries).
  function pickDate(next: string) {
    setDate(next);
    if (!inWeek(next)) {
      const wk = toISODate(startOfISOWeek(parseISODate(next)));
      router.push(`${basePath}/daily?week=${wk}`);
    }
  }

  const storeEntries = React.useMemo(
    () => entries.filter((e) => e.store_id === storeId),
    [entries, storeId],
  );

  // Existing entry for the chosen store+date — look in the loaded week first,
  // then in the recent-3-days set (covers dates in the previous week).
  const existing = React.useMemo(
    () =>
      storeEntries.find((e) => e.entry_date === date) ??
      recentEntries.find((e) => e.store_id === storeId && e.entry_date === date) ??
      null,
    [storeEntries, recentEntries, storeId, date],
  );

  const vitaNum = Number(vita) || 0;
  const superNum = Number(supermarket) || 0;
  // The envelope is expected to equal sales − supermarket expenses.
  const expectedEnvelope = Math.max(0, Math.round((vitaNum - superNum) * 100) / 100);
  const envNum = envelopeTouched ? Number(envelope) || 0 : expectedEnvelope;
  const overridden = envelopeTouched && Math.abs(envNum - expectedEnvelope) > 0.001;

  React.useEffect(() => {
    if (existing) {
      const exp = Math.max(
        0,
        Math.round(
          (Number(existing.vita_mojo_sales) - Number(existing.supermarket_expenses || 0)) * 100,
        ) / 100,
      );
      const wasOverridden = Math.abs(Number(existing.envelope_amount) - exp) > 0.001;
      setVita(String(existing.vita_mojo_sales));
      setSupermarket(existing.supermarket_expenses ? String(existing.supermarket_expenses) : "");
      setEnvelope(String(existing.envelope_amount));
      setEnvelopeTouched(wasOverridden);
      setReason(existing.reason ?? "");
    } else {
      setVita("");
      setSupermarket("");
      setEnvelope("");
      setEnvelopeTouched(false);
      setReason("");
    }
  }, [existing]);

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
      const res = await upsertDailyCashEntry({
        store_id: storeId,
        entry_date: date,
        vita_mojo_sales: vitaNum,
        envelope_amount: envNum,
        supermarket_expenses: superNum,
        reason: overridden ? reason.trim() || null : null,
      });
      toast.success(
        res.is_late
          ? "Saved (flagged as a late submission)"
          : existing
            ? "Entry updated"
            : "Entry saved",
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this cash entry? This is logged and cannot be undone.")) return;
    setDeletingId(id);
    try {
      await deleteDailyCashEntry({ id });
      toast.success("Entry deleted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setDeletingId(null);
    }
  }

  const opening = openingByStore[storeId] ?? 0;
  const rows = runningBalanceRows(storeEntries, opening);
  const runningBalance = rows.length ? rows[rows.length - 1].running_balance : opening;
  const vitaTotal = rows.reduce((s, r) => s + r.vita_mojo_sales, 0);
  const envTotal = rows.reduce((s, r) => s + r.envelope_amount, 0);
  const diffTotal = Math.round((vitaTotal - envTotal) * 100) / 100;

  return (
    <div className="flex flex-col gap-5">
      {/* Week navigation + store selector */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={`${basePath}/daily?week=${prevWeek}`}>
            <Button variant="secondary" size="icon" aria-label="Previous week">
              <ChevronLeftIcon size={16} />
            </Button>
          </Link>
          <span className="text-sm font-medium text-text-primary min-w-0 sm:min-w-[180px] text-center">
            {weekLabel(parseISODate(weekStart))}
          </span>
          <Link href={`${basePath}/daily?week=${nextWeek}`}>
            <Button variant="secondary" size="icon" aria-label="Next week">
              <ChevronRightIcon size={16} />
            </Button>
          </Link>
        </div>
        {isAdmin && stores.length > 1 && (
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5">
        {/* Entry form */}
        <Card>
          <CardHeader
            action={
              existing ? (
                <Badge variant={existing.is_late ? "warning" : "gold"}>
                  {existing.is_late ? "Late" : "Logged"}
                </Badge>
              ) : null
            }
          >
            <CardTitle>Daily Cash Entry</CardTitle>
            <CardDescription>
              Record the Vita Mojo cash sales. The envelope auto-fills as sales −
              supermarket expenses.
            </CardDescription>
          </CardHeader>

          <form onSubmit={submit} className="flex flex-col gap-4">
            {/* Date — today / yesterday / day before only */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Date</label>
              <div className="grid grid-cols-3 gap-2">
                {dateOptions.map((opt) => {
                  const active = date === opt.iso;
                  return (
                    <button
                      key={opt.iso}
                      type="button"
                      onClick={() => pickDate(opt.iso)}
                      className={
                        "h-12 rounded-xl border text-sm font-medium transition-colors flex flex-col items-center justify-center " +
                        (active
                          ? "bg-gold text-black border-gold"
                          : "bg-surface text-text-primary border-border hover:bg-surface-hover")
                      }
                    >
                      <span>{opt.label}</span>
                      <span className={active ? "text-[11px] text-black/70" : "text-[11px] text-text-muted"}>
                        {opt.short}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              label="Vita Mojo cash sales *"
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
            <div>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                label="Cash placed in envelope"
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

            <Button type="submit" loading={busy} className="w-full mt-1">
              {existing ? "Update Entry" : "Save Entry"}
            </Button>
          </form>
        </Card>

        {/* Weekly log */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-text-primary">This Week&apos;s Cash Log</h3>
              <p className="text-sm text-text-muted mt-0.5">
                {formatDDMMYYYY(weekStart)} – {weekEnd}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-text-muted">Running balance</p>
              <p className="text-lg font-semibold text-gold tabular-nums">
                {formatGBP(runningBalance)}
              </p>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-12">
              No entries this week yet. Add today&apos;s entry on the left.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-stack w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium text-right">Vita Mojo</th>
                    <th className="px-4 py-3 font-medium text-right">Envelope</th>
                    <th className="px-4 py-3 font-medium text-right">Diff</th>
                    <th className="px-4 py-3 font-medium">Reason / Status</th>
                    <th className="px-4 py-3 font-medium text-right">Balance</th>
                    {isAdmin && <th className="px-4 py-3"></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const entry = storeEntries.find((e) => e.entry_date === r.entry_date)!;
                    const balanced = Math.abs(r.difference) < 0.001;
                    return (
                      <tr
                        key={r.entry_date}
                        className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}
                      >
                        <td className="px-4 py-3 whitespace-nowrap" data-label="">
                          <button
                            className="hover:text-gold"
                            onClick={() => pickDate(r.entry_date)}
                            title="Edit this day"
                          >
                            {formatDDMMYYYY(r.entry_date)}
                          </button>
                          {r.is_late && (
                            <Badge variant="warning" className="ml-2 text-[10px] py-0 px-1.5">
                              Late
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums" data-label="Vita Mojo">{formatGBP(r.vita_mojo_sales)}</td>
                        <td className="px-4 py-3 text-right tabular-nums" data-label="Envelope">{formatGBP(r.envelope_amount)}</td>
                        <td
                          data-label="Diff"
                          className={`px-4 py-3 text-right tabular-nums ${
                            balanced ? "text-text-muted" : r.difference > 0 ? "text-danger" : "text-warning"
                          }`}
                        >
                          {formatGBP(r.difference)}
                        </td>
                        <td className="px-4 py-3 sm:max-w-[220px]" data-label="Reason / Status">
                          {r.reason ? (
                            <span className="text-text-subtle truncate block" title={r.reason}>
                              {r.reason}
                            </span>
                          ) : (
                            <Badge variant="success">Supermarket</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium" data-label="Balance">
                          {formatGBP(r.running_balance)}
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3 text-right whitespace-nowrap" data-label="">
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => pickDate(r.entry_date)}
                                aria-label="Edit"
                                className="text-text-muted hover:text-text-primary"
                              >
                                <PencilIcon size={16} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(entry.id)}
                                loading={deletingId === entry.id}
                                aria-label="Delete"
                                className="text-text-muted hover:text-danger"
                              >
                                <TrashIcon size={16} />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-bg/60 font-semibold">
                    <td className="px-4 py-3" data-label="">Weekly total</td>
                    <td className="px-4 py-3 text-right tabular-nums" data-label="Vita Mojo">{formatGBP(vitaTotal)}</td>
                    <td className="px-4 py-3 text-right tabular-nums" data-label="Envelope">{formatGBP(envTotal)}</td>
                    <td data-label="Diff" className={`px-4 py-3 text-right tabular-nums ${diffTotal > 0 ? "text-danger" : "text-text-muted"}`}>
                      {formatGBP(diffTotal)}
                    </td>
                    <td className="px-4 py-3 text-text-muted" data-label="Opening">
                      {opening > 0 ? `Opening ${formatGBP(opening)}` : ""}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gold" data-label="Balance">{formatGBP(runningBalance)}</td>
                    {isAdmin && <td></td>}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
