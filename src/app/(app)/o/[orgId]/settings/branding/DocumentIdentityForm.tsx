"use client";

/**
 * Legal identity & document details form (003B.1 — Brand & Documents).
 * Writes the CANONICAL legal issuer fields onto the org's default company row
 * via saveDocumentIdentityAction (config.manage + service validation).
 * Client component with a typed-result action: nothing is ever lost on a
 * validation failure. Phone-first (min-h-11), logical properties only.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field } from "@/platform/ui";
import type { BrandingActionResult } from "./actions";

export type DocumentIdentityDict = {
  title: string;
  subtitle: string;
  legal_name: string;
  legal_name_hint: string;
  trn: string;
  license: string;
  address_en: string;
  address_ar: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  signatory_name: string;
  signatory_title: string;
  payment_instructions: string;
  payment_instructions_hint: string;
  doc_language: string;
  doc_language_en: string;
  doc_language_ar: string;
  doc_language_bilingual: string;
  save: string;
  saved: string;
  reference: string;
  errors: Record<string, string>;
};

export type DocumentIdentityInitial = {
  legalName: string | null;
  taxRegNo: string | null;
  tradeLicenseNo: string | null;
  addressEn: string | null;
  addressAr: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  paymentInstructions: string | null;
  docLanguage: "en" | "ar" | "bilingual";
};

export function DocumentIdentityForm({
  initial,
  dict,
  saveAction,
}: {
  initial: DocumentIdentityInitial;
  dict: DocumentIdentityDict;
  saveAction: (formData: FormData) => Promise<BrandingActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ msg: string; ref?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  function onSave(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveAction(formData);
      if (res.error) {
        setError({
          msg: dict.errors[res.error] ?? dict.errors.failed!,
          ref: res.correlationId,
        });
      } else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <form action={onSave}>
      <Card>
        <CardHeader title={dict.title} />
        <p className="mb-3 text-sm text-ink-secondary">{dict.subtitle}</p>
        {error ? (
          <p role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {error.msg}
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
        {saved ? (
          <p role="status" className="mb-3 rounded-md bg-success-soft p-3 text-sm text-success">
            {dict.saved}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <Field
            label={dict.legal_name}
            name="legal_name"
            defaultValue={initial.legalName ?? ""}
            hint={dict.legal_name_hint}
            maxLength={200}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={dict.trn}
              name="tax_reg_no"
              defaultValue={initial.taxRegNo ?? ""}
              maxLength={50}
              dir="ltr"
            />
            <Field
              label={dict.license}
              name="trade_license_no"
              defaultValue={initial.tradeLicenseNo ?? ""}
              maxLength={100}
              dir="ltr"
            />
          </div>
          <Field
            label={dict.address_en}
            name="address_en"
            defaultValue={initial.addressEn ?? ""}
            maxLength={400}
            dir="ltr"
          />
          <Field
            label={dict.address_ar}
            name="address_ar"
            defaultValue={initial.addressAr ?? ""}
            maxLength={400}
            dir="rtl"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={dict.city}
              name="city"
              defaultValue={initial.city ?? ""}
              maxLength={120}
            />
            <Field
              label={dict.region}
              name="region"
              defaultValue={initial.region ?? ""}
              maxLength={120}
            />
            <Field
              label={dict.postal_code}
              name="postal_code"
              defaultValue={initial.postalCode ?? ""}
              maxLength={20}
              dir="ltr"
            />
            <Field
              label={dict.country}
              name="country"
              defaultValue={initial.country ?? ""}
              maxLength={120}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={dict.phone}
              name="phone"
              type="tel"
              defaultValue={initial.phone ?? ""}
              maxLength={50}
              dir="ltr"
            />
            <Field
              label={dict.email}
              name="email"
              type="email"
              defaultValue={initial.email ?? ""}
              maxLength={254}
              dir="ltr"
            />
          </div>
          <Field
            label={dict.website}
            name="website"
            defaultValue={initial.website ?? ""}
            maxLength={200}
            dir="ltr"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={dict.signatory_name}
              name="signatory_name"
              defaultValue={initial.signatoryName ?? ""}
              maxLength={160}
            />
            <Field
              label={dict.signatory_title}
              name="signatory_title"
              defaultValue={initial.signatoryTitle ?? ""}
              maxLength={160}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="payment_instructions" className="text-sm font-medium text-ink">
              {dict.payment_instructions}
            </label>
            <textarea
              id="payment_instructions"
              name="payment_instructions"
              defaultValue={initial.paymentInstructions ?? ""}
              maxLength={1000}
              rows={3}
              className="min-h-11 rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink placeholder:text-ink-muted"
            />
            <p className="text-sm text-ink-muted">{dict.payment_instructions_hint}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="doc_language" className="text-sm font-medium text-ink">
              {dict.doc_language}
            </label>
            <select
              id="doc_language"
              name="doc_language"
              defaultValue={initial.docLanguage}
              className="min-h-11 rounded-md border border-line-strong bg-card px-3 text-base text-ink"
            >
              <option value="bilingual">{dict.doc_language_bilingual}</option>
              <option value="ar">{dict.doc_language_ar}</option>
              <option value="en">{dict.doc_language_en}</option>
            </select>
          </div>
          <Button type="submit" disabled={pending} className="self-start">
            {dict.save}
          </Button>
        </div>
      </Card>
    </form>
  );
}
