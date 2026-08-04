"use client";

import * as React from "react";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { HoursMinsDisplay } from "@/components/ui/HoursMinsDisplay";
import { HoursMinsInput } from "@/components/ui/HoursMinsInput";
import { logEmployeeHours } from "@/app/actions/employees";
import type { Employee, EmployeeHoursComputed } from "@/lib/types";
import { formatINR, formatGBP, parseHoursMinsInput, startOfISOWeek, toISODate } from "@/lib/utils";

const BANK_LIMIT = 20;

export function LogHoursForm({
  employees,
  onLogged,
}: {
  employees: Employee[];
  onLogged: (freshHours: EmployeeHoursComputed[]) => void;
}) {
  const toast = useToast();
  const [empId, setEmpId] = React.useState<string>(employees[0]?.id ?? "");
  const [weekStart, setWeekStart] = React.useState(toISODate(startOfISOWeek(new Date())));
  const [hours, setHours] = React.useState<string>("");
  const [notes, setNotes] = React.useState("");
  const [errors, setErrors] = React.useState<{ [k: string]: string }>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!empId && employees.length > 0) setEmpId(employees[0].id);
  }, [employees, empId]);

  function onDateChange(value: string) {
    if (!value) { setWeekStart(""); return; }
    const d = new Date(value + "T00:00:00");
    setWeekStart(toISODate(startOfISOWeek(d)));
  }

  const employee = employees.find((e) => e.id === empId);
  // Typed as H.MM (minutes, not a decimal fraction) — "28.30" means 28h 30m,
  // matching how it's shown everywhere else. An invalid value (e.g. minutes
  // above 59) reads as 0 here, same as an unparseable number did before; the
  // submit-time check below is what actually blocks saving it.
  const totalHours = parseHoursMinsInput(hours) ?? 0;
  const bankHours = Math.min(totalHours, BANK_LIMIT);
  const cashHours = Math.max(totalHours - BANK_LIMIT, 0);
  const rate = employee ? Number(employee.hourly_ni_rate ?? employee.hourly_rate ?? 0) : 0;
  const cashAmount = cashHours * rate;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!empId) errs.emp = "Pick an employee";
    if (!weekStart) errs.week = "Select a week";
    // Require a valid, positive H.MM value — empty, unparseable, an
    // out-of-range minute count, or 0 are all rejected.
    const parsed = parseHoursMinsInput(hours);
    if (!hours.trim() || parsed === null || parsed <= 0)
      errs.hours = "Enter hours.minutes, e.g. 28.30 for 28h 30m";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (parsed === null) return; // narrows for TS; errs already caught this case

    setBusy(true);
    try {
      const result = await logEmployeeHours({
        employee_id: empId,
        week_start_date: weekStart,
        total_hours_worked: parsed,
        notes: notes || null,
      });
      toast.success(
        `Hours saved — ${employee?.name ?? ""} · week of ${weekStart.split("-").reverse().join("/")}`,
      );
      setHours("");
      setNotes("");
      // Pass the fresh hours list back so EmployeesView can update state instantly
      onLogged(result.hours);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save hours");
    } finally {
      setBusy(false);
    }
  }

  if (employees.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Add at least one active employee before logging hours.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Select
        label="Employee"
        value={empId}
        onChange={(e) => setEmpId(e.target.value)}
        error={errors.emp}
      >
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} · {formatGBP(e.hourly_ni_rate ?? e.hourly_rate)}/hr
          </option>
        ))}
      </Select>

      <DatePicker
        label="Week Start (Mon)"
        value={weekStart}
        onChange={onDateChange}
        hint="Auto-snaps to Monday of the chosen week."
        error={errors.week}
      />

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-subtle">Total Hours This Week</label>
        <HoursMinsInput
          value={hours}
          onChange={setHours}
          invalid={!!errors.hours}
          hourAriaLabel="Total hours this week"
          minAriaLabel="Total minutes this week"
        />
        {errors.hours && <p className="text-xs text-danger">{errors.hours}</p>}
      </div>

      <Input
        label="Notes"
        placeholder="(optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={140}
      />

      <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-bg border border-border px-4 py-3 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-text-muted">Bank hours</span>
          <span className="text-sm font-semibold">
            {totalHours > 0 ? <HoursMinsDisplay hours={bankHours} /> : "—"}
          </span>
        </div>
        <div className="rounded-xl bg-bg border border-border px-4 py-3 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-text-muted">Cash hours</span>
          <span className="text-sm font-semibold">
            {totalHours > 0 ? <HoursMinsDisplay hours={cashHours} /> : "—"}
          </span>
        </div>
        <div className="rounded-xl bg-gold/10 border border-gold/30 px-4 py-3 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-gold/80">Cash due</span>
          <span className="text-sm font-semibold text-gold">
            {totalHours > 0 ? formatINR(cashAmount) : "—"}
          </span>
        </div>
      </div>

      <div className="sm:col-span-2 flex justify-end">
        <Button type="submit" loading={busy} disabled={!hours.trim()}>
          Save Hours
        </Button>
      </div>
    </form>
  );
}
