"use client";

import * as React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { updateCoverDriver } from "@/app/actions/cover-drivers";
import {
  CoverDriverProfileForm,
  coverDriverFormFrom,
  validateCoverDriverForm,
  type CoverDriverFormErrors,
  type CoverDriverFormState,
} from "./CoverDriverProfileForm";
import type { CoverDriver, Store } from "@/lib/types";

export function EditCoverDriverModal({
  driver,
  stores,
  lockStore,
  onClose,
  onSaved,
}: {
  driver: CoverDriver;
  stores: Store[];
  /** Manager portal: store is fixed to the manager's store. */
  lockStore?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState<CoverDriverFormState>(() =>
    coverDriverFormFrom(driver),
  );
  const [errors, setErrors] = React.useState<CoverDriverFormErrors>({});
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const errs = validateCoverDriverForm(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error("Please fix the highlighted fields.");
      return;
    }

    setBusy(true);
    try {
      await updateCoverDriver({
        id: driver.id,
        name: form.name,
        store_id: form.store_id,
        phone: form.phone || null,
        date_of_birth: form.date_of_birth || null,
        hourly_cash_rate: Number(form.hourly_cash_rate),
        short_delivery_rate: form.short_delivery_rate
          ? Number(form.short_delivery_rate)
          : null,
        long_delivery_rate: form.long_delivery_rate ? Number(form.long_delivery_rate) : null,
        notes: form.notes || null,
      });
      toast.success("Cover driver updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${driver.name}`}
      description="Rates apply to future shifts only — already-approved days keep the rate they were approved at."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Save changes
          </Button>
        </>
      }
    >
      <CoverDriverProfileForm
        form={form}
        setForm={setForm}
        errors={errors}
        stores={stores}
        lockStore={lockStore}
      />
    </Modal>
  );
}
