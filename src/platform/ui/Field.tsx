import { cn } from "@/lib/cn";
import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

/**
 * Labelled input field. RTL-first: logical properties only (BUILD_BIBLE §9.2) —
 * text alignment and spacing follow the document direction automatically.
 */
export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
};

export function Field({ label, hint, error, className, id, ...props }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "min-h-11 rounded-md border bg-card px-3 text-base text-ink",
          "placeholder:text-ink-muted",
          error ? "border-danger" : "border-line-strong",
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
