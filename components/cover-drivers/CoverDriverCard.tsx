"use client";

import * as React from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { archiveCoverDriver } from "@/app/actions/cover-drivers";
import {
  ArchiveIcon,
  CalendarIcon,
  PencilIcon,
  PhoneIcon,
} from "@/components/ui/icons";
import { formatGBP } from "@/lib/utils";
import type { CoverDriver, Store } from "@/lib/types";

// Mirrors components/employees/EmployeeCard so the two read the same on the
// page: badge row for store + status, three icon actions top-right, rates and
// contact below. The rate columns differ because cover drivers are cash-only.
export function CoverDriverCard({
  driver,
  stores,
  onEdit,
  onSchedule,
  onChanged,
}: {
  driver: CoverDriver;
  stores: Store[];
  onEdit: () => void;
  onSchedule: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  const store = stores.find((s) => s.id === driver.store_id);

  async function toggleArchive() {
    if (
      driver.is_active &&
      !confirm(
        `Deactivate ${driver.name}? They keep their history but can no longer clock in.`,
      )
    )
      return;
    setBusy(true);
    try {
      await archiveCoverDriver(driver.id, driver.is_active);
      toast.success(driver.is_active ? "Cover driver archived" : "Cover driver restored");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold tracking-wide text-text-primary truncate">
            {driver.name}
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="gold">Cover Driver</Badge>
            {store && <Badge variant="neutral">{store.name}</Badge>}
            {driver.is_active ? (
              <Badge variant="success">Active</Badge>
            ) : (
              <Badge variant="warning">Inactive</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={onSchedule}
            aria-label="Edit weekly schedule"
            title="Weekly schedule"
            className="text-text-muted hover:text-text-primary"
          >
            <CalendarIcon size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label="Edit"
            title="Edit"
            className="text-text-muted hover:text-text-primary"
          >
            <PencilIcon size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleArchive}
            loading={busy}
            aria-label={driver.is_active ? "Archive" : "Restore"}
            title={driver.is_active ? "Archive" : "Restore"}
            className="text-text-muted hover:text-text-primary"
          >
            <ArchiveIcon size={16} />
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-text-muted">Cash rate</div>
            <div className="text-text-primary font-medium">
              {formatGBP(driver.hourly_cash_rate)}/h
            </div>
          </div>
          <div>
            <div className="text-text-muted">Delivery rates</div>
            <div className="text-text-primary font-medium">
              {driver.short_delivery_rate == null && driver.long_delivery_rate == null
                ? "—"
                : [
                    driver.short_delivery_rate != null
                      ? `S ${formatGBP(driver.short_delivery_rate)}`
                      : null,
                    driver.long_delivery_rate != null
                      ? `L ${formatGBP(driver.long_delivery_rate)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </div>
          </div>
        </div>

        {driver.phone && (
          <div className="flex items-center gap-2 mt-3 text-sm text-text-muted">
            <PhoneIcon size={14} />
            <span>{driver.phone}</span>
          </div>
        )}

        {driver.notes && (
          <p className="text-sm text-text-muted mt-3 line-clamp-2">{driver.notes}</p>
        )}
      </div>
    </Card>
  );
}
