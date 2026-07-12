"use client";

/**
 * One-handed mobile-first upload control (BUILD_BIBLE §9.2: 44px targets;
 * design rules: capture from camera on phones). All user-facing strings arrive
 * via props — no hardcoded domain nouns (terminology law).
 */
import { useId, useRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "../Button";
import { useFileUpload, type UseFileUploadArgs, type UploadState } from "./useFileUpload";

export type FileUploadLabels = {
  idle: string;
  compressing: string;
  signing: string;
  uploading: string;
  confirming: string;
  done: string;
  retry: string;
  quotaWarn: string;
};

export type FileUploadButtonProps = UseFileUploadArgs & {
  labels: FileUploadLabels;
  accept?: string;
  /** capture="environment" opens the rear camera directly on phones. */
  capture?: boolean;
  className?: string;
};

function phaseLabel(state: UploadState, labels: FileUploadLabels): string {
  switch (state.phase) {
    case "compressing":
      return labels.compressing;
    case "signing":
      return labels.signing;
    case "uploading":
      return `${labels.uploading} ${Math.round(state.progress * 100)}%`;
    case "confirming":
      return labels.confirming;
    case "done":
      return labels.done;
    default:
      return labels.idle;
  }
}

export function FileUploadButton({
  labels,
  accept = "image/*",
  capture = false,
  className,
  ...hookArgs
}: FileUploadButtonProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, upload, reset } = useFileUpload(hookArgs);
  const inFlight =
    state.phase === "compressing" ||
    state.phase === "signing" ||
    state.phase === "uploading" ||
    state.phase === "confirming";

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        capture={capture ? "environment" : undefined}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // same file can be re-picked after an error
          if (file) void upload(file);
        }}
      />
      <Button
        variant={state.phase === "error" ? "danger" : "primary"}
        disabled={inFlight}
        aria-busy={inFlight}
        onClick={() => {
          if (state.phase === "error") reset();
          inputRef.current?.click();
        }}
      >
        {state.phase === "error" ? labels.retry : phaseLabel(state, labels)}
      </Button>
      {state.phase === "uploading" && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.progress * 100)}
        >
          {/* logical direction: fills from the start edge in LTR and RTL alike */}
          <div className="h-full bg-brand" style={{ width: `${state.progress * 100}%` }} />
        </div>
      )}
      {state.quotaWarn && <p className="text-xs text-warning">{labels.quotaWarn}</p>}
      {state.phase === "error" && state.errorMessage && (
        <p className="text-xs text-danger">{state.errorMessage}</p>
      )}
    </div>
  );
}
