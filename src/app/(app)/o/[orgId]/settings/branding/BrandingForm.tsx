"use client";

/**
 * Branding settings form (U2) — phone-first (min-h-11 targets, one column):
 * drag-and-drop OR tap-to-choose logo upload with a transparent-checkerboard
 * contain preview, remove/replace, accent-colour swatches + hex input, and the
 * display/legal name + footer fields. All writes go through the server actions
 * (config.manage + the service validation matrix); errors surface inline with
 * helpful i18n messages.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Field, OrgAvatar } from "@/platform/ui";
import type { BrandingActionResult } from "./actions";

export type BrandingDict = {
  logo_title: string;
  logo_hint: string;
  logo_drop: string;
  logo_choose: string;
  logo_uploading: string;
  logo_remove: string;
  logo_replace: string;
  logo_empty: string;
  accent_title: string;
  accent_hex: string;
  identity_title: string;
  display_name: string;
  display_name_hint: string;
  legal_name: string;
  footer: string;
  footer_hint: string;
  save: string;
  saved: string;
  /** "Reference: {id}" — shown under the message on an unexpected server error. */
  reference: string;
  errors: Record<string, string>;
};

export type BrandingInitial = {
  accentColor: string | null;
  displayName: string | null;
  legalName: string | null;
  footerDetails: string | null;
};

const SWATCHES = [
  "#0f766e",
  "#1d4ed8",
  "#7c3aed",
  "#b91c1c",
  "#c2410c",
  "#a16207",
  "#166534",
  "#0f172a",
] as const;

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#d4d4d4 25%,transparent 25%)," +
    "linear-gradient(-45deg,#d4d4d4 25%,transparent 25%)," +
    "linear-gradient(45deg,transparent 75%,#d4d4d4 75%)," +
    "linear-gradient(-45deg,transparent 75%,#d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

export function BrandingForm({
  orgName,
  initial,
  logoUrl,
  dict,
  uploadAction,
  removeAction,
  saveAction,
}: {
  orgName: string;
  initial: BrandingInitial;
  logoUrl: string | null;
  dict: BrandingDict;
  uploadAction: (formData: FormData) => Promise<BrandingActionResult>;
  removeAction: () => Promise<BrandingActionResult>;
  saveAction: (formData: FormData) => Promise<BrandingActionResult>;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<{ msg: string; ref?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [accent, setAccent] = useState(initial.accentColor ?? "");

  function errMsg(code: string): string {
    return dict.errors[code] ?? dict.errors.failed!;
  }

  function submitFile(file: File | null | undefined) {
    if (!file || pending) return;
    setError(null);
    setSaved(false);
    const fd = new FormData();
    fd.set("logo", file);
    startTransition(async () => {
      const res = await uploadAction(fd);
      if (res.error) setError({ msg: errMsg(res.error), ref: res.correlationId });
      else router.refresh();
    });
  }

  function onRemove() {
    if (pending) return;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await removeAction();
      if (res.error) setError({ msg: errMsg(res.error), ref: res.correlationId });
      else router.refresh();
    });
  }

  function onSave(formData: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveAction(formData);
      if (res.error) setError({ msg: errMsg(res.error), ref: res.correlationId });
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
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
        <p role="status" className="rounded-md bg-success-soft p-3 text-sm text-success">
          {dict.saved}
        </p>
      ) : null}

      <Card>
        <CardHeader title={dict.logo_title} />
        <div className="flex flex-col gap-3">
          <div
            role="button"
            tabIndex={0}
            aria-label={dict.logo_choose}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              submitFile(e.dataTransfer.files?.[0]);
            }}
            className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center ${
              dragOver ? "border-brand bg-sunken" : "border-line-strong"
            }`}
          >
            <div
              className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border border-line"
              style={CHECKERBOARD}
            >
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                <img src={logoUrl} alt={orgName} className="max-h-full max-w-full object-contain" />
              ) : (
                <OrgAvatar
                  name={orgName}
                  accentColor={initial.accentColor}
                  className="h-12 w-12 text-base"
                />
              )}
            </div>
            <p className="text-sm text-ink-secondary">
              {pending ? dict.logo_uploading : dict.logo_drop}
            </p>
            <span className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink">
              {logoUrl ? dict.logo_replace : dict.logo_choose}
            </span>
            <p className="text-xs text-ink-muted">{dict.logo_hint}</p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              submitFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {logoUrl ? (
            <Button variant="secondary" onClick={onRemove} disabled={pending}>
              {dict.logo_remove}
            </Button>
          ) : (
            <p className="text-sm text-ink-muted">{dict.logo_empty}</p>
          )}
        </div>
      </Card>

      <form action={onSave}>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={dict.accent_title} />
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    aria-pressed={accent.toLowerCase() === c}
                    onClick={() => setAccent(c)}
                    className={`h-11 w-11 rounded-md border-2 ${
                      accent.toLowerCase() === c ? "border-ink" : "border-line"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <Field
                label={dict.accent_hex}
                name="accent_color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                placeholder="#0F766E"
                maxLength={7}
                dir="ltr"
              />
            </div>
          </Card>

          <Card>
            <CardHeader title={dict.identity_title} />
            <div className="flex flex-col gap-3">
              <Field
                label={dict.display_name}
                name="display_name"
                defaultValue={initial.displayName ?? ""}
                hint={dict.display_name_hint}
                maxLength={120}
              />
              <Field
                label={dict.legal_name}
                name="legal_name"
                defaultValue={initial.legalName ?? ""}
                maxLength={200}
              />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="footer_details" className="text-sm font-medium text-ink">
                  {dict.footer}
                </label>
                <textarea
                  id="footer_details"
                  name="footer_details"
                  defaultValue={initial.footerDetails ?? ""}
                  maxLength={500}
                  rows={3}
                  className="min-h-11 rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink placeholder:text-ink-muted"
                />
                <p className="text-sm text-ink-muted">{dict.footer_hint}</p>
              </div>
            </div>
          </Card>

          <Button type="submit" disabled={pending} className="self-start">
            {dict.save}
          </Button>
        </div>
      </form>
    </div>
  );
}
