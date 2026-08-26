"use client";

/**
 * Customer edit form (003C): client-owned state with a typed action result —
 * validation failures keep every value, errors land on their field, sensitive
 * values never travel through URLs, and Cancel is a plain link back that
 * changes nothing. Lifecycle (archive/reactivate) is deliberately NOT here.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field } from "@/platform/ui";
import type { CustomerActionResult } from "../../actions";

export type CustomerEditDict = {
  name: string;
  contact_name: string;
  country: string;
  phone: string;
  email: string;
  tax_no: string;
  notes: string;
  save: string;
  cancel: string;
  saved: string;
  reference: string;
  errors: Record<string, string>;
};

export type CustomerEditInitial = {
  name: string;
  contactName: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  taxRegNo: string | null;
  notes: string | null;
};

export function CustomerEditForm({
  initial,
  dict,
  cancelHref,
  saveAction,
}: {
  initial: CustomerEditInitial;
  dict: CustomerEditDict;
  cancelHref: string;
  saveAction: (formData: FormData) => Promise<CustomerActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ code: string; field?: string; ref?: string } | null>(null);

  const errMsg = (code: string) => dict.errors[code] ?? dict.errors.server_error!;
  const fieldError = (field: string) => (error?.field === field ? errMsg(error.code) : undefined);

  function onSave(formData: FormData) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await saveAction(formData);
      if (!res.ok) {
        setError({ code: res.error, field: res.field, ref: res.correlationId });
        return; // uncontrolled inputs keep their values — nothing is lost
      }
      router.push(cancelHref); // predictable landing: back to the detail page
      router.refresh();
    });
  }

  return (
    <form action={onSave} className="flex flex-col gap-4">
      {error && !error.field ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {errMsg(error.code)}
          {error.ref ? (
            <span className="mt-1 block text-xs text-danger/80">
              {dict.reference}{" "}
              <span dir="ltr" className="font-mono">
                {error.ref}
              </span>
            </span>
          ) : null}
        </p>
      ) : null}
      <Field
        label={dict.name}
        name="name"
        required
        maxLength={160}
        defaultValue={initial.name}
        error={fieldError("name")}
      />
      <Field
        label={dict.contact_name}
        name="contact_name"
        maxLength={120}
        defaultValue={initial.contactName ?? ""}
      />
      <Field
        label={dict.country}
        name="country"
        maxLength={2}
        placeholder="AE"
        defaultValue={initial.country ?? ""}
        error={fieldError("country")}
      />
      <Field
        label={dict.phone}
        name="phone"
        type="tel"
        dir="ltr"
        maxLength={32}
        defaultValue={initial.phone ?? ""}
        error={fieldError("phone")}
      />
      <Field
        label={dict.email}
        name="email"
        type="email"
        dir="ltr"
        maxLength={254}
        defaultValue={initial.email ?? ""}
        error={fieldError("email")}
      />
      <Field
        label={dict.tax_no}
        name="tax_reg_no"
        dir="ltr"
        maxLength={64}
        defaultValue={initial.taxRegNo ?? ""}
        error={fieldError("taxRegNo")}
      />
      <Field label={dict.notes} name="notes" maxLength={2000} defaultValue={initial.notes ?? ""} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {dict.save}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push(cancelHref)}
          disabled={pending}
        >
          {dict.cancel}
        </Button>
      </div>
    </form>
  );
}
