"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ListIcon,
  PencilIcon,
  TrashIcon,
} from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { deleteCashEntry } from "@/app/actions/entries";
import { EditEntryModal } from "./EditEntryModal";
import {
  downloadCSV,
  formatDDMMYYYY,
  formatINR,
  formatINRPlain,
  toCSV,
} from "@/lib/utils";

type Entry = {
  id: string;
  user_id: string | null;
  user_email: string | null;
  entry_date: string;
  cash_sales: number;
  supermarket_expenses: number;
  notes: string | null;
  manager_name: string;
  created_at: string;
  updated_at: string;
};

const PAGE_SIZE = 10;

export function EntriesView({
  initialEntries,
  managers,
  currentUserId,
  currentUserEmail,
  isAdmin,
}: {
  initialEntries: Entry[];
  managers: { email: string; name: string }[];
  currentUserId: string;
  currentUserEmail: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [manager, setManager] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<Entry | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    return initialEntries.filter((r) => {
      if (from && r.entry_date < from) return false;
      if (to && r.entry_date > to) return false;
      if (manager && (r.user_email?.toLowerCase() ?? "") !== manager.toLowerCase()) return false;
      return true;
    });
  }, [initialEntries, from, to, manager]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  React.useEffect(() => {
    setPage(1);
  }, [from, to, manager]);

  function exportCSV() {
    const headers = ["Date", "Manager", "Sales (£)", "Expenses (£)", "Net (£)", "Notes"];
    const rows = filtered.map((r) => {
      const net = Number(r.cash_sales) - Number(r.supermarket_expenses);
      return [
        formatDDMMYYYY(r.entry_date),
        r.manager_name,
        formatINRPlain(r.cash_sales),
        formatINRPlain(r.supermarket_expenses),
        formatINRPlain(net),
        r.notes ?? "",
      ];
    });
    const csv = toCSV(headers, rows);
    const filename = `peckers-cash-entries-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCSV(filename, csv);
    toast.success("CSV downloaded");
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this entry? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await deleteCashEntry(id);
      toast.success("Entry deleted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setDeletingId(null);
    }
  }

  function canModify(r: Entry) {
    return isAdmin || r.user_id === currentUserId;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <DatePicker
            label="From"
            value={from}
            onChange={setFrom}
          />
          <DatePicker
            label="To"
            value={to}
            onChange={setTo}
          />
          <Select
            label="Manager"
            value={manager}
            onChange={(e) => setManager(e.target.value)}
          >
            <option value="">All managers</option>
            {managers.map((m) => (
              <option key={m.email} value={m.email}>
                {m.name}
              </option>
            ))}
          </Select>
          <div className="flex items-end">
            <Button
              variant="secondary"
              onClick={exportCSV}
              iconLeft={<DownloadIcon size={16} />}
              className="w-full"
              disabled={filtered.length === 0}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<ListIcon />}
            title="No entries found"
            description="Try adjusting the filters or log new cash entries from the Dashboard."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table-stack w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-text-muted bg-bg/50">
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Manager</th>
                    <th className="px-4 py-3 font-medium text-right">Sales</th>
                    <th className="px-4 py-3 font-medium text-right">Expenses</th>
                    <th className="px-4 py-3 font-medium text-right">Net</th>
                    <th className="px-4 py-3 font-medium">Notes</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    const net = Number(r.cash_sales) - Number(r.supermarket_expenses);
                    return (
                      <tr
                        key={r.id}
                        className={`${i % 2 === 0 ? "" : "bg-bg/40"} border-t border-border/60`}
                      >
                        <td className="px-4 py-3 whitespace-nowrap" data-label="">
                          {formatDDMMYYYY(r.entry_date)}
                        </td>
                        <td className="px-4 py-3" data-label="Manager">
                          <div className="flex items-center gap-2">
                            <span className="truncate max-w-[180px]">{r.manager_name}</span>
                            {r.user_id === currentUserId && (
                              <Badge variant="gold" className="text-[10px] py-0 px-1.5">
                                You
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums" data-label="Sales">
                          {formatINR(r.cash_sales)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums" data-label="Expenses">
                          {formatINR(r.supermarket_expenses)}
                        </td>
                        <td
                          data-label="Net"
                          className={`px-4 py-3 text-right tabular-nums font-medium ${
                            net >= 0 ? "text-success" : "text-danger"
                          }`}
                        >
                          {formatINR(net)}
                        </td>
                        <td className="px-4 py-3 text-text-muted sm:max-w-[280px] sm:truncate" data-label="Notes">
                          {r.notes ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap" data-label="">
                          {canModify(r) ? (
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setEditing(r)}
                                aria-label="Edit"
                                className="text-text-muted hover:text-text-primary"
                              >
                                <PencilIcon size={16} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(r.id)}
                                loading={deletingId === r.id}
                                aria-label="Delete"
                                className="text-text-muted hover:text-danger"
                              >
                                <TrashIcon size={16} />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-text-muted">view</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-3 border-t border-border/60 text-sm">
              <span className="text-text-muted">
                {filtered.length} entr{filtered.length === 1 ? "y" : "ies"} ·
                page {safePage} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="icon"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeftIcon size={16} />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRightIcon size={16} />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {editing && (
        <EditEntryModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
