"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { DatePicker } from "@/components/ui/DatePicker";
import { useToast } from "@/components/ui/Toast";
import { createCoverDriverWithAccount } from "@/app/actions/cover-drivers";
import { CredentialsModal, type Credentials } from "@/components/accounts/CredentialsModal";
import type { Store } from "@/lib/types";

type FormState = {
  name: string;
  store_id: string;
  phone: string;
  date_of_birth: string;
  hourly_cash_rate: string;
  short_delivery_rate: string;
  long_delivery_rate: string;
  notes: string;
};

export function AddCoverDriverModal({
  stores,
  defaultStoreId,
  lockStore,
  onClose,
  onCreated,
}: {
  stores: Store[];
  defaultStoreId?: string | null;
  /** Manager portal: store is fixed to the manager's store. */
  lockStore?: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState<FormState>({
    name: "",
    store_id: defaultStoreId ?? stores[0]?.id ?? "",
    phone: "",
    date_of_birth: "",
    hourly_cash_rate: "",
    short_delivery_rate: "",
    long_delivery_rate: "",
    notes: "",
  });
  const [errors, setErrors] = React.useState<{ [k: string]: string }>({});
  const [busy, setBusy] = React.useState(false);
  const [creds, setCreds] = React.useState<Credentials | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    const errs: typeof errors = {};
    if (!form.name.trim()) errs.name = "Enter the driver's name";
    if (!form.store_id) errs.store_id = "Pick a store";
    const rate = parseFloat(form.hourly_cash_rate);
    if (!form.hourly_cash_rate.trim() || isNaN(rate) || rate <= 0) {
      errs.hourly_cash_rate = "Enter a positive hourly cash rate";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error("Please fix the highlighted fields.");
      return;
    }

    setBusy(true);
    try {
      const res = await createCoverDriverWithAccount({
        name: form.name,
        store_id: form.store_id,
        phone: form.phone || null,
        date_of_birth: form.date_of_birth || null,
        hourly_cash_rate: rate,
        short_delivery_rate: form.short_delivery_rate
          ? Number(form.short_delivery_rate)
          : null,
        long_delivery_rate: form.long_delivery_rate ? Number(form.long_delivery_rate) : null,
        notes: form.notes || null,
      });
      setCreds({
        username: res.username,
        password: res.password,
        loginUrl: res.loginUrl,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (creds) {
    return (
      <CredentialsModal
        open
        onClose={() => {
          setCreds(null);
          onCreated();
        }}
        title={`${form.name.trim()} added`}
        subtitle="Cover driver login created. Share these with them — the password is shown once."
        credentials={creds}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Cover Driver"
      description="Part-time cover driver + auto-generated login. Paid in cash only — no NI and no bank details."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Create cover driver &amp; login
          </Button>
        </>
      }
    >
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
          <Input label="Store" value={stores[0]?.name ?? "—"} disabled readOnly />
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
          pay is hours × rate, plus delivery pay if rates are set. They do not appear on the
          rota, NI report or payout sheet.
        </p>
      </div>
    </Modal>
  );
}
