"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { PlusIcon } from "@/components/ui/icons";
import { EmployeeCard } from "./EmployeeCard";
import { EmployeeDetailModal } from "./EmployeeDetailModal";
import { AddEmployeeModal } from "./AddEmployeeModal";
import { EditEmployeeModal } from "./EditEmployeeModal";
import { ScheduleEditModal } from "./ScheduleEditModal";
import { LogHoursForm } from "./LogHoursForm";
import { HoursTable } from "./HoursTable";
<<<<<<< HEAD
import { DailyHoursApproval } from "./DailyHoursApproval";
import { CoverDriversCard } from "./CoverDriversCard";
=======
import { CoverDriversCard } from "@/components/cover-drivers/CoverDriversCard";
import { CoverDriverHoursTable } from "@/components/cover-drivers/CoverDriverHoursTable";
>>>>>>> 0e709a7 (added cover drivers module)
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { UsersIcon } from "@/components/ui/icons";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Select } from "@/components/ui/Input";
<<<<<<< HEAD
import {
  approveDailyHours,
  approveDailyHoursForDate,
  unapproveDailyHours,
} from "@/app/actions/employees";
import type {
  ClockDailySummary,
  ClockWeeklySummary,
  CoverDriverRecord,
=======
import type {
  ClockWeeklySummary,
  CoverDriver,
  CoverDriverDaySummary,
  CoverDriverHoursComputed,
>>>>>>> 0e709a7 (added cover drivers module)
  Employee,
  EmployeeHoursComputed,
  Store,
} from "@/lib/types";
import type { MinWageBands } from "@/lib/settings";

type Props = {
  initialEmployees: Employee[];
  initialHours: EmployeeHoursComputed[];
  /** Cover drivers are a separate module — they share this page, nothing else. */
  coverDrivers?: CoverDriver[];
  coverDriverDays?: CoverDriverDaySummary[];
  coverDriverHours?: CoverDriverHoursComputed[];
  clockSummaries?: ClockWeeklySummary[];
  clockDailySummaries?: ClockDailySummary[];
  /** Server's "today" as YYYY-MM-DD (avoids client/server timezone drift). */
  todayISO: string;
  stores: Store[];
  defaultStoreId?: string | null;
  minWageBands?: MinWageBands;
  /** Manager portal: lock everything to a single store, hide cross-store UI. */
  lockToStore?: boolean;
  /**
   * Whether the manual weekly-hours log form is shown. Managers approve clocked
   * hours instead of logging them, so this is false in the manager portal.
   */
  canManualLog?: boolean;
  /**
   * Whether an existing employee's password-reset email can be changed here.
   * False in the manager portal: controlling that address means being able to
   * request a reset link and sign in as that person, which is admin-only
   * (see writeContactEmail in app/actions/employees.ts). Managers still set it
   * when CREATING crew, where they already see the generated password anyway.
   */
  canEditContactEmail?: boolean;
};

type TabId = "daily" | "people" | "weekly";

export function EmployeesView({
  initialEmployees,
  initialHours,
  coverDrivers = [],
  coverDriverDays = [],
  coverDriverHours = [],
  clockSummaries = [],
  clockDailySummaries = [],
  todayISO,
  stores,
  defaultStoreId,
  minWageBands,
  lockToStore = false,
  canManualLog = true,
  canEditContactEmail = true,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = React.useState<TabId>("daily");
  const [showAdd, setShowAdd] = React.useState(false);
  const [viewing, setViewing] = React.useState<Employee | null>(null);
  const [editing, setEditing] = React.useState<Employee | null>(null);
  const [scheduling, setScheduling] = React.useState<Employee | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [storeFilter, setStoreFilter] = React.useState<string>(
    lockToStore && defaultStoreId ? defaultStoreId : defaultStoreId ?? "all",
  );

  // Store hours in state so we can update it instantly on save/delete without
  // relying on router.refresh() (which is async and can hit the router cache).
  const [hours, setHours] = React.useState<EmployeeHoursComputed[]>(initialHours);
  React.useEffect(() => {
    setHours(initialHours);
  }, [initialHours]);

<<<<<<< HEAD
  // Per-day clocked hours, kept in state so approve/undo updates instantly.
  const [daily, setDaily] =
    React.useState<ClockDailySummary[]>(clockDailySummaries);
  React.useEffect(() => {
    setDaily(clockDailySummaries);
  }, [clockDailySummaries]);

  // Cover-driver records — kept in state so add/delete updates instantly.
  const [coverDrivers, setCoverDrivers] =
    React.useState<CoverDriverRecord[]>(initialCoverDrivers);
=======
  // Approved cover-driver days — kept in state so approve/delete updates
  // instantly without waiting on the router cache, same as employee hours.
  const [coverHours, setCoverHours] =
    React.useState<CoverDriverHoursComputed[]>(coverDriverHours);
>>>>>>> 0e709a7 (added cover drivers module)
  React.useEffect(() => {
    setCoverHours(coverDriverHours);
  }, [coverDriverHours]);

  const employees = initialEmployees;

  const filtered = employees.filter((e) => {
    if (!showArchived && (e.employment_status === "left" || !e.is_active))
      return false;
    if (storeFilter !== "all" && e.store_id !== storeFilter) return false;
    return true;
  });

  const activeCount = employees.filter(
    (e) => e.employment_status === "active",
  ).length;

  // Called after a manual hours save — the action returns fresh rows so we can
  // update state immediately instead of waiting for the router cache.
  function handleLogged(freshHours: EmployeeHoursComputed[]) {
    setHours(freshHours);
    router.refresh(); // sync everything else (employee cards, analytics)
  }

  function handleDeleted(deletedId: string) {
    setHours((prev) => prev.filter((r) => r.id !== deletedId));
    router.refresh();
  }

<<<<<<< HEAD
  // ---- Daily approval handlers (server action + optimistic local patch) ----
  const patchDaily = (
    match: (d: ClockDailySummary) => boolean,
    next: Partial<ClockDailySummary>,
  ) => setDaily((prev) => prev.map((d) => (match(d) ? { ...d, ...next } : d)));

  async function handleApproveDay(
    employee_id: string,
    event_date: string,
    override_hours?: number,
  ) {
    const res = await approveDailyHours({ employee_id, event_date, override_hours });
    setHours(res.hours);
    patchDaily(
      (d) => d.employee_id === employee_id && d.event_date === event_date,
      {
        hours_approved: true,
        approved_hours:
          override_hours != null
            ? Number(override_hours)
            : daily.find(
                (d) =>
                  d.employee_id === employee_id && d.event_date === event_date,
              )?.clocked_hours ?? null,
      },
    );
    router.refresh();
  }

  async function handleApproveDate(event_date: string, employee_ids: string[]) {
    const res = await approveDailyHoursForDate({ event_date, employee_ids });
    setHours(res.hours);
    const ids = new Set(employee_ids);
    setDaily((prev) =>
      prev.map((d) =>
        d.event_date === event_date && ids.has(d.employee_id) && !d.hours_approved
          ? { ...d, hours_approved: true, approved_hours: d.clocked_hours }
          : d,
      ),
    );
    router.refresh();
  }

  async function handleUnapproveDay(employee_id: string, event_date: string) {
    const res = await unapproveDailyHours({ employee_id, event_date });
    setHours(res.hours);
    patchDaily(
      (d) => d.employee_id === employee_id && d.event_date === event_date,
      { hours_approved: false, approved_hours: null },
    );
    router.refresh();
  }

  function handleCoverDriverCreated(record: CoverDriverRecord) {
    setCoverDrivers((prev) => [record, ...prev]);
=======
  function handleCoverHoursApproved(fresh: CoverDriverHoursComputed[]) {
    setCoverHours(fresh);
>>>>>>> 0e709a7 (added cover drivers module)
    router.refresh();
  }

  function handleCoverHoursDeleted(deletedId: string) {
    setCoverHours((prev) => prev.filter((r) => r.id !== deletedId));
    router.refresh();
  }

<<<<<<< HEAD
  const visibleCoverDrivers = coverDrivers.filter(
    (r) => storeFilter === "all" || r.store_id === storeFilter,
  );
=======
  // Admin can view all stores; scope the cover-driver data to the active filter.
  const inStore = (storeId: string) => storeFilter === "all" || storeId === storeFilter;
  const visibleCoverDrivers = coverDrivers.filter((d) => inStore(d.store_id));
  const visibleCoverDays = coverDriverDays.filter((d) => inStore(d.store_id));
  const visibleCoverHours = coverHours.filter((h) => inStore(h.store_id));
>>>>>>> 0e709a7 (added cover drivers module)

  const refresh = () => router.refresh();

  // Daily view: scope to the selected store and count what still needs approval.
  const visibleDaily = daily.filter(
    (d) => storeFilter === "all" || d.store_id === storeFilter,
  );
  const dailyPending = visibleDaily.filter(
    (d) => !d.hours_approved && d.clocked_hours > 0,
  ).length;
  const showStore =
    !lockToStore && storeFilter === "all" && stores.length > 1;

  const tabs: TabItem[] = [
    { id: "daily", label: "Daily Approval", badge: dailyPending },
    { id: "people", label: "Employees" },
    { id: "weekly", label: "Weekly Log" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Top bar: tabs + (admin) store scope */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={(id) => setTab(id as TabId)}
        />
        {!lockToStore && (
          <div className="w-44">
            <Select
              value={storeFilter}
              onChange={(e) => setStoreFilter(e.target.value)}
              aria-label="Filter by store"
            >
              <option value="all">All stores</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* ---------------- DAILY APPROVAL ---------------- */}
      {tab === "daily" && (
        <DailyHoursApproval
          summaries={visibleDaily}
          stores={stores}
          todayISO={todayISO}
          showStore={showStore}
          onApprove={handleApproveDay}
          onApproveDate={handleApproveDate}
          onUnapprove={handleUnapproveDay}
        />
      )}

      {/* ---------------- EMPLOYEES (cards) ---------------- */}
      {tab === "people" && (
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-text-muted">
                {activeCount} active employee{activeCount === 1 ? "" : "s"}
              </p>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className="text-xs text-gold hover:underline"
              >
                {showArchived ? "Hide archived/left" : "Show archived/left"}
              </button>
            </div>
            <Button
              onClick={() => setShowAdd(true)}
              iconLeft={<PlusIcon size={16} />}
            >
              Add Employee
            </Button>
          </div>

          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<UsersIcon />}
                title="No employees"
                description="Add your first employee to start scheduling shifts and tracking hours."
                action={
                  <Button
                    onClick={() => setShowAdd(true)}
                    iconLeft={<PlusIcon size={16} />}
                  >
                    Add Employee
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map((emp) => (
                <EmployeeCard
                  key={emp.id}
                  employee={emp}
                  stores={stores}
                  onView={() => setViewing(emp)}
                  onEdit={() => setEditing(emp)}
                  onSchedule={() => setScheduling(emp)}
                  onChanged={refresh}
                  minWageBands={minWageBands}
                />
              ))}
            </div>
          )}

          <CoverDriversCard
            records={visibleCoverDrivers}
            stores={stores}
            defaultStoreId={
              storeFilter !== "all" ? storeFilter : defaultStoreId
            }
            lockToStore={lockToStore}
            showStoreColumn={!lockToStore && storeFilter === "all"}
            onCreated={handleCoverDriverCreated}
            onDeleted={handleCoverDriverDeleted}
          />
        </div>
      )}

      {/* ---------------- WEEKLY LOG ---------------- */}
      {tab === "weekly" && (
        <div className="flex flex-col gap-6">
          {canManualLog && (
            <Card>
              <CardHeader>
                <CardTitle>Log Weekly Hours (admin correction)</CardTitle>
                <CardDescription>
                  Manual override for a single employee/week. Day-to-day approval
                  happens in the Daily Approval tab.
                </CardDescription>
              </CardHeader>
              <LogHoursForm
                employees={employees.filter(
                  (e) => e.employment_status === "active",
                )}
                onLogged={handleLogged}
              />
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Weekly Hours Log</CardTitle>
              <CardDescription>
                Rolled-up weekly totals with the bank vs cash split that feeds
                payroll. Approve hours day-by-day in the Daily Approval tab.
              </CardDescription>
            </CardHeader>
            <HoursTable
              employees={employees}
              rows={hours}
              clockSummaries={clockSummaries}
              onDeleted={handleDeleted}
              onApproved={handleLogged}
              hideApprove
            />
          </Card>
        </div>
      )}

<<<<<<< HEAD
      {/* ---------------- Modals (any tab) ---------------- */}
=======
      <Card>
        <CardHeader>
          <CardTitle>Hours &amp; Approvals</CardTitle>
          <CardDescription>
            Approve the hours each employee clocked. Approved hours feed payroll.
          </CardDescription>
        </CardHeader>
        <HoursTable
          employees={employees}
          rows={hours}
          clockSummaries={clockSummaries}
          onDeleted={handleDeleted}
          onApproved={handleLogged}
        />
      </Card>

      <CoverDriversCard
        drivers={visibleCoverDrivers}
        days={visibleCoverDays}
        stores={stores}
        defaultStoreId={storeFilter !== "all" ? storeFilter : defaultStoreId}
        lockToStore={lockToStore}
        showStoreColumn={!lockToStore && storeFilter === "all"}
        onChanged={refresh}
      />

      <Card>
        <CardHeader>
          <CardTitle>Cover Drivers — Hours &amp; Approvals</CardTitle>
          <CardDescription>
            Approve each cover shift a driver clocked. Approved cash pay is hours × rate
            plus delivery pay.
          </CardDescription>
        </CardHeader>
        <CoverDriverHoursTable
          drivers={visibleCoverDrivers}
          days={visibleCoverDays}
          approvedRows={visibleCoverHours}
          onApproved={handleCoverHoursApproved}
          onDeleted={handleCoverHoursDeleted}
        />
      </Card>

>>>>>>> 0e709a7 (added cover drivers module)
      {viewing && (
        <EmployeeDetailModal
          employee={viewing}
          stores={stores}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setViewing(null);
            setEditing(viewing);
          }}
          onSchedule={() => {
            setViewing(null);
            setScheduling(viewing);
          }}
          minWageBands={minWageBands}
        />
      )}
      {showAdd && (
        <AddEmployeeModal
          stores={stores}
          defaultStoreId={defaultStoreId}
          lockStore={lockToStore}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditEmployeeModal
          employee={editing}
          stores={stores}
          canEditContactEmail={canEditContactEmail}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {scheduling && (
        <ScheduleEditModal
          employee={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
