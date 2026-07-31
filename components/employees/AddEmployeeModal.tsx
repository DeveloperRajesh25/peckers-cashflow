"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createEmployeeWithAccount } from "@/app/actions/accounts";
import {
  CredentialsModal,
  type Credentials,
} from "@/components/accounts/CredentialsModal";
import {
  EmployeeProfileForm,
  emptyEmployeeForm,
  validateEmployeeForm,
  type EmployeeFormState,
  type FormErrors,
} from "./EmployeeProfileForm";
import type { EmployeePosition, Store } from "@/lib/types";

export function AddEmployeeModal({
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
  const [form, setForm] = React.useState<EmployeeFormState>(() => ({
    ...emptyEmployeeForm(),
    store_id: defaultStoreId ?? "",
  }));
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [busy, setBusy] = React.useState(false);
  const [creds, setCreds] = React.useState<Credentials | null>(null);
  // Shown inline rather than as a toast: these are things the person has to go
  // back and change (a duplicate email, a taken login name), so the message has
  // to stay on screen while they fix the field.
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    const errs = validateEmployeeForm(form, { requireContactEmail: true });
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      const res = await createEmployeeWithAccount({
        name: form.name,
        contact_email: form.contact_email,
        phone: form.phone || null,
        date_of_birth: form.date_of_birth || null,
        gender: form.gender || null,
        position: form.position as EmployeePosition,
        employment_start_date: form.employment_start_date || null,
        hourly_ni_rate: Number(form.hourly_ni_rate || 0),
        hourly_cash_rate: form.hourly_cash_rate ? Number(form.hourly_cash_rate) : null,
        short_delivery_rate: form.short_delivery_rate ? Number(form.short_delivery_rate) : null,
        long_delivery_rate: form.long_delivery_rate ? Number(form.long_delivery_rate) : null,
        store_id: form.store_id,
        bank_account_name: form.bank_account_name || null,
        bank_name: form.bank_name || null,
        account_number: form.account_number || null,
        sort_code: form.sort_code || null,
        notes: form.notes || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setCreds({
        username: res.username,
        password: res.password,
        loginUrl: res.loginUrl,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  // After the admin closes the credentials modal, refresh the list.
  if (creds) {
    return (
      <CredentialsModal
        open
        onClose={() => {
          setCreds(null);
          onCreated();
        }}
        title={`${form.name.trim()} added`}
        subtitle="Crew login created. Share these with them — the password is shown once."
        credentials={creds}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Employee"
      description="Full profile + auto-generated crew login. Bank details required for payroll."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Create employee &amp; login
          </Button>
        </>
      }
    >
      {error && (
        <p className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-xl px-3 py-2 mb-4">
          {error}
        </p>
      )}
      <EmployeeProfileForm
        form={form}
        setForm={setForm}
        errors={errors}
        stores={stores}
        lockStore={lockStore}
        requireContactEmail
      />
    </Modal>
  );
}
