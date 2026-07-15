"use client";

/**
 * Branding-step logo picker (U4): tap-to-choose / drag-drop upload into the
 * DRAFT (validated + re-encoded server-side; only the 512px PNG is stashed —
 * the real storage upload happens at confirm). Mirrors the wave-1 BrandingForm
 * interaction: checkerboard contain preview, remove/replace, inline errors.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/platform/ui";

export type LogoPickerLabels = {
  drop: string;
  choose: string;
  replace: string;
  remove: string;
  uploading: string;
  hint: string;
  errors: Record<string, string>;
};

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#d4d4d4 25%,transparent 25%)," +
    "linear-gradient(-45deg,#d4d4d4 25%,transparent 25%)," +
    "linear-gradient(45deg,transparent 75%,#d4d4d4 75%)," +
    "linear-gradient(-45deg,transparent 75%,#d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

export function LogoPicker({
  logoDataUri,
  labels,
  uploadAction,
  removeAction,
}: {
  logoDataUri: string | null;
  labels: LogoPickerLabels;
  uploadAction: (formData: FormData) => Promise<{ error: string | null }>;
  removeAction: () => Promise<{ error: string | null }>;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function errMsg(code: string): string {
    return labels.errors[code] ?? labels.errors.failed ?? code;
  }

  function submitFile(file: File | null | undefined) {
    if (!file || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("logo", file);
    startTransition(async () => {
      const res = await uploadAction(fd);
      if (res.error) setError(errMsg(res.error));
      else router.refresh();
    });
  }

  function onRemove() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await removeAction();
      if (res.error) setError(errMsg(res.error));
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={labels.choose}
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
          {logoDataUri ? (
            // eslint-disable-next-line @next/next/no-img-element -- draft data URI preview
            <img src={logoDataUri} alt="" className="max-h-full max-w-full object-contain" />
          ) : null}
        </div>
        <p className="text-sm text-ink-secondary">{pending ? labels.uploading : labels.drop}</p>
        <span className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink">
          {logoDataUri ? labels.replace : labels.choose}
        </span>
        <p className="text-xs text-ink-muted">{labels.hint}</p>
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
      {logoDataUri ? (
        <Button variant="secondary" onClick={onRemove} disabled={pending} className="self-start">
          {labels.remove}
        </Button>
      ) : null}
    </div>
  );
}
