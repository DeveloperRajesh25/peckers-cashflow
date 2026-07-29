"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlusIcon, ClockIcon } from "@/components/ui/icons";
import { AddCoverDriverModal } from "./AddCoverDriverModal";
import { EditCoverDriverModal } from "./EditCoverDriverModal";
import { CoverDriverScheduleModal } from "./CoverDriverScheduleModal";
import { CoverDriverCard } from "./CoverDriverCard";
import { formatDDMMYYYY, formatGBP } from "@/lib/utils";
import type { CoverDriver, CoverDriverDaySummary, Store } from "@/lib/types";

export function CoverDriversCard({
  drivers,
  days,
  stores,
  defaultStoreId,
  lockToStore = false,
  showStoreColumn = false,
  onChanged,
}: {
  drivers: CoverDriver[];
  /** One row per completed clock day, newest first. */
  days: CoverDriverDaySummary[];
  stores: Store[];
  defaultStoreId?: string | null;
  lockToStore?: boolean;
  /** Admin (all-stores view): show which store each row belongs to. */
  showStoreColumn?: boolean;
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = React.useState(false);
  const [editing, setEditing] = React.useState<CoverDriver | null>(null);
  const [scheduling, setScheduling] = React.useState<CoverDriver | null>(null);
  const [showInactive, setShowInactive] = React.useState(false);

  const storeName = React.useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [stores]);

  const visibleDrivers = drivers.filter((d) => showInactive || d.is_active);
  const inactiveCount = drivers.length - drivers.filter((d) => d.is_active).length;

  return (
    <Card>
      <CardHeader
        action={
          <Button size="sm" onClick={() => setShowAdd(true)} iconLeft={<PlusIcon size={16} />}>
            Add Cover Driver
          </Button>
        }
      >
        <CardTitle>Cover Drivers</CardTitle>
        <CardDescription>
          Part-time drivers with their own login. Paid cash only — hours × rate plus delivery
          pay. They have their own Rota section, and are excluded from the NI report and
          payout sheet.
        </CardDescription>
      </CardHeader>

      {/* ---- Registered drivers ---- */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <p className="text-sm text-text-muted">
          {drivers.filter((d) => d.is_active).length} active cover driver
          {drivers.filter((d) => d.is_active).length === 1 ? "" : "s"}
        </p>
        {inactiveCount > 0 && (
          <button
            onClick={() => setShowInactive((v) => !v)}
            className="text-xs text-gold hover:underline"
          >
            {showInactive ? "Hide inactive" : `Show inactive (${inactiveCount})`}
          </button>
        )}
      </div>

      {visibleDrivers.length === 0 ? (
        <EmptyState
          icon={<ClockIcon />}
          title="No cover drivers yet"
          description="Use “Add Cover Driver” to register one and generate their login."
          action={
            <Button onClick={() => setShowAdd(true)} iconLeft={<PlusIcon size={16} />}>
              Add Cover Driver
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleDrivers.map((d) => (
            <CoverDriverCard
              key={d.id}
              driver={d}
              stores={stores}
              onEdit={() => setEditing(d)}
              onSchedule={() => setScheduling(d)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {/* ---- Clocked cover shifts ---- */}
      <div className="mt-6">
        <h4 className="text-sm font-medium mb-1">Cover shifts</h4>
        <p className="text-xs text-text-muted mb-3">
          Every completed clock-in/out. Total pay = hours × rate + deliveries × their rate.
        </p>

        {days.length === 0 ? (
          <EmptyState
            icon={<ClockIcon />}
            title="No cover shifts recorded"
            description="Rows appear here once a cover driver clocks in and out at a store."
          />
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border">
                  <th className="px-3 py-2 font-medium">Driver</th>
                  {showStoreColumn && <th className="px-3 py-2 font-medium">Store</th>}
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium text-right">Hours</th>
                  <th className="px-3 py-2 font-medium text-right">Rate</th>
                  <th className="px-3 py-2 font-medium text-right">Total pay</th>
                </tr>
              </thead>
              <tbody>
                {days.map((r, i) => (
                  <tr
                    key={`${r.cover_driver_id}:${r.work_date}`}
                    className={`${i % 2 === 0 ? "" : "bg-bg/50"} border-t border-border/60`}
                  >
                    <td className="px-3 py-3 whitespace-nowrap font-medium">
                      {r.driver_name}
                    </td>
                    {showStoreColumn && (
                      <td className="px-3 py-3 whitespace-nowrap text-text-muted">
                        {storeName(r.store_id)}
                      </td>
                    )}
                    <td className="px-3 py-3 whitespace-nowrap">
                      {formatDDMMYYYY(r.work_date)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {r.total_hours.toFixed(2)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatGBP(r.hourly_cash_rate)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <Badge variant="gold">{formatGBP(r.total_pay)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && (
        <AddCoverDriverModal
          stores={stores}
          defaultStoreId={defaultStoreId}
          lockStore={lockToStore}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            onChanged();
          }}
        />
      )}
      {editing && (
        <EditCoverDriverModal
          driver={editing}
          stores={stores}
          lockStore={lockToStore}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
      {scheduling && (
        <CoverDriverScheduleModal
          driver={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={onChanged}
        />
      )}
    </Card>
  );
}
