"use client";

/**
 * Dialog — the ONE reusable accessible modal primitive (003C).
 *
 * Built on the native <dialog> element, which gives us for free: top-layer
 * rendering, Escape close (the `cancel` event), focus containment, and focus
 * RETURN to the opener on close. This component adds: labelled title +
 * optional description (aria-labelledby / aria-describedby), an accessible
 * close control, backdrop-click close, a destructive-confirmation tone, a
 * mobile sheet presentation, RTL-safe logical styling and motion-safe
 * transitions. No dependency; no domain knowledge — platform owns the
 * interaction, callers own content and rules (form errors render as ordinary
 * children).
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

export type DialogProps = {
  open: boolean;
  /** Called for every close path: Escape, backdrop, the close control. */
  onClose: () => void;
  title: string;
  description?: string;
  /** "danger" = destructive confirmation styling on the title block. */
  tone?: "default" | "danger";
  /** Accessible name for the close button (translated by the caller). */
  closeLabel: string;
  children: ReactNode;
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  tone = "default",
  closeLabel,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        // Native Escape — route through the caller so state stays in sync.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop targets the <dialog> element itself.
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-full max-w-lg rounded-lg border border-line bg-card p-0 text-ink shadow-pop",
        "backdrop:bg-ink/40",
        // Mobile: bottom-sheet presentation.
        "max-sm:mb-0 max-sm:mt-auto max-sm:max-w-full max-sm:rounded-b-none",
        "motion-safe:transition-opacity motion-safe:duration-150",
      )}
    >
      {/* Render children only while open so form state resets between uses
          is the CALLER's decision (children stay mounted while open). */}
      <div className="flex items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <h2
            id={titleId}
            className={cn(
              "text-base font-semibold leading-snug",
              tone === "danger" ? "text-danger" : "text-ink",
            )}
          >
            {title}
          </h2>
          {description ? (
            <p id={descId} className="mt-1 text-sm leading-relaxed text-ink-secondary">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-sunken"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
