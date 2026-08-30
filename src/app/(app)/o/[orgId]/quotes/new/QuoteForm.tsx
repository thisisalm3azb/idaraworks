"use client";

/**
 * New Quote form (003C): a state-preserving client form. Same single-line
 * quote semantics as before (the multi-line workspace is a later slice) —
 * what changed is the INTERACTION: typed action result instead of a
 * destructive redirect (every entered value survives failure), specific error
 * messages where the service distinguishes causes, duplicate-submit
 * protection, and inline customer creation through the reusable
 * RelationshipField + Dialog (the parent form never navigates).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  RelationshipField,
  type RelationshipCreateResult,
  type RelationshipFieldLabels,
  type RelationshipOption,
} from "@/platform/ui";
import type { CreateQuoteResult } from "../actions";

const field = "flex flex-col gap-1 text-sm";
const input =
  "min-h-11 rounded-md border border-line bg-card px-3 py-2 text-ink focus:border-brand";

export type QuoteFormDict = {
  customer: string;
  customer_placeholder: string;
  preset: string;
  description: string;
  qty: string;
  unit: string;
  vat: string;
  unit_price: string;
  terms: string;
  submit: string;
  contact_name: string;
  phone: string;
  errors: Record<string, string>;
};

export function QuoteForm({
  orgId,
  customers,
  presets,
  defaultCustomerId,
  opportunityId,
  canCreateCustomer,
  createAction,
  submitAction,
  relationshipLabels,
  dict,
}: {
  orgId: string;
  customers: RelationshipOption[];
  presets: Array<{ id: string; name: string }>;
  defaultCustomerId?: string;
  /** H20: server-validated open opportunity to link the quotation to. */
  opportunityId?: string;
  canCreateCustomer: boolean;
  createAction: (formData: FormData) => Promise<RelationshipCreateResult>;
  submitAction: (formData: FormData) => Promise<CreateQuoteResult>;
  relationshipLabels: RelationshipFieldLabels;
  dict: QuoteFormDict;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    if (pending) return; // duplicate-submit protection
    setError(null);
    startTransition(async () => {
      const res = await submitAction(formData);
      if (!res.ok) {
        setError(dict.errors[res.error] ?? dict.errors.failed!);
        return; // client form: every value stays exactly as typed
      }
      router.push(`/o/${orgId}/quotes/${res.id}`);
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {opportunityId ? <input type="hidden" name="opportunity_id" value={opportunityId} /> : null}

      <RelationshipField
        label={dict.customer}
        name="customer_id"
        options={customers}
        defaultValue={defaultCustomerId}
        placeholder={dict.customer_placeholder}
        canCreate={canCreateCustomer}
        createAction={createAction}
        createFields={[
          { name: "name", label: dict.customer, required: true, maxLength: 160 },
          { name: "contact_name", label: dict.contact_name, maxLength: 120 },
          { name: "phone", label: dict.phone, type: "tel", dir: "ltr", maxLength: 32 },
        ]}
        labels={relationshipLabels}
      />

      <label className={field}>
        {dict.preset}
        <select name="preset_id" className={input}>
          <option value="">—</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {dict.description}
        <input name="description" required maxLength={300} className={input} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <label className={field}>
          {dict.qty}
          <input
            name="qty"
            type="number"
            min="0"
            step="0.001"
            defaultValue="1"
            dir="ltr"
            className={input}
          />
        </label>
        <label className={field}>
          {dict.unit}
          <input name="unit" defaultValue="unit" className={input} />
        </label>
        <label className={field}>
          {dict.vat}
          <input
            name="vat_rate"
            type="number"
            min="0"
            max="100"
            step="0.01"
            defaultValue="0"
            dir="ltr"
            className={input}
          />
        </label>
      </div>
      <label className={field}>
        {dict.unit_price}
        <input
          name="unit_price"
          type="number"
          min="0"
          step="0.01"
          required
          dir="ltr"
          className={input}
        />
      </label>
      <label className={field}>
        {dict.terms}
        <input name="terms" maxLength={2000} className={input} />
      </label>
      <Button type="submit" disabled={pending}>
        {dict.submit}
      </Button>
    </form>
  );
}
