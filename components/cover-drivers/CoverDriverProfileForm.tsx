"use client";

import * as React from "react";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import type { CoverDriver, Store } from "@/lib/types";

// Shared by the Add and Edit modals so the two can't drift on which fields
// exist or how they validate. Deliberately has NO NI rate and no bank details:
// cover drivers are paid cash only.

export type CoverDriverFormState = {
  name: string;
  store_id: string;
  phone: string;
  date_of_birth: string;
  hourly_cash_rate: string;
  short_delivery_rate: string;
  long_delivery_rate: string;
  notes: string;
};

export type CoverDriverFormErrors = { [K in keyof CoverDriverFormState]?: string };

export function emptyCoverDriverForm(storeId?: string | null): CoverDriverFormState {
  return {
    name: "",
    store_id: storeId ?? "",
    phone: "",
    date_of_birth: "",
    hourly_cash_rate: "",
    short_delivery_rate: "",
    long_delivery_rate: "",
    notes: "",
  };
}

export function coverDriverFormFrom(driver: CoverDriver): CoverDriverFormState {
  return {
    name: driver.name,
    store_id: driver.store_id,
    phone: driver.phone ?? "",
    date_of_birth: driver.date_of_birth ?? "",
    hourly_cash_rate: String(driver.hourly_cash_rate ?? ""),
    short_delivery_rate:
      driver.short_delivery_rate != null ? String(driver.short_delivery_rate) : "",
    long_delivery_rate:
      driver.long_delivery_rate != null ? String(driver.long_delivery_rate) : "",
    notes: driver.notes ?? "",
  };
}

export function validateCoverDriverForm(
  form: CoverDriverFormState,
): CoverDriverFormErrors {
  const errs: CoverDriverFormErrors = {};
  if (!form.name.trim()) errs.name = "Enter the driver's name";
  if (!form.store_id) errs.store_id = "Pick a store";
  const rate = parseFloat(form.hourly_cash_rate);
  if (!form.hourly_cash_rate.trim() || isNaN(rate) || rate <= 0) {
    errs.hourly_cash_rate = "Enter a positive hourly cash rate";
  }
  return errs;
}

export function CoverDriverProfileForm({
  form,
  setForm,
  errors,
  stores,
  lockStore,
}: {
  form: CoverDriverFormState;
  setForm: React.Dispatch<React.SetStateAction<CoverDriverFormState>>;
  errors: CoverDriverFormErrors;
  stores: Store[];
  /** Manager portal: store is fixed to the manager's store. */
  lockStore?: boolean;
}) {
  function set<K extends keyof CoverDriverFormState>(
    key: K,
    value: CoverDriverFormState[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const lockedStoreName =
    stores.find((s) => s.id === form.store_id)?.name ?? stores[0]?.name ?? "—";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Input
        label="Driver Name *"
        placeholder="e.g. John Smith"
        value={form.name}
        onChange={(e) => set("name", e.target.value)}
        error={errors.name}
        maxLength={120}
      />

      {lockStore ? (
        <Input label="Store" value={lockedStoreName} disabled readOnly />
      ) : (
        <Select
          label="Store *"
          value={form.store_id}
          onChange={(e) => set("store_id", e.target.value)}
          error={errors.store_id}
        >
          <option value="">Select a store…</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}

      <Input
        label="Phone"
        placeholder="Optional"
        value={form.phone}
        onChange={(e) => set("phone", e.target.value)}
        maxLength={40}
      />

      <DatePicker
        label="Date of Birth"
        value={form.date_of_birth}
        onChange={(v) => set("date_of_birth", v)}
      />

      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        label="Hourly Rate (cash) *"
        prefix="£"
        placeholder="e.g. 12.50"
        value={form.hourly_cash_rate}
        onChange={(e) => set("hourly_cash_rate", e.target.value)}
        error={errors.hourly_cash_rate}
      />

      <div className="hidden sm:block" />

      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        label="Short Delivery Rate"
        prefix="£"
        placeholder="Optional — per short delivery"
        value={form.short_delivery_rate}
        onChange={(e) => set("short_delivery_rate", e.target.value)}
      />

      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        label="Long Delivery Rate"
        prefix="£"
        placeholder="Optional — per long delivery"
        value={form.long_delivery_rate}
        onChange={(e) => set("long_delivery_rate", e.target.value)}
      />

      <Input
        label="Notes"
        placeholder="Optional"
        value={form.notes}
        onChange={(e) => set("notes", e.target.value)}
        maxLength={300}
        containerClassName="sm:col-span-2"
      />

      <p className="sm:col-span-2 text-xs text-text-muted rounded-xl border border-border bg-bg px-3 py-2.5">
        Cover drivers are paid <span className="text-text-primary">cash only</span> — total
        pay is hours × rate, plus delivery pay if rates are set. They have their own section
        on the Rota and Live board, and are excluded from the NI report and payout sheet.
      </p>
    </div>
  );
}
