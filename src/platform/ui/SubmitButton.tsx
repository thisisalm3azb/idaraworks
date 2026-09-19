"use client";

/**
 * The one submit button for server-action forms.
 *
 * A plain `<Button type="submit">` inside a `<form action={serverAction}>` gives
 * the person nothing while the action runs: the page holds still for the
 * round trip, and on a slow connection "Save" looks like it did nothing (owner,
 * 2026-09-20: "Save and other buttons often appear to do nothing"). React's
 * `useFormStatus` knows exactly when the enclosing form is in flight, so this
 * button:
 *   - shows the pending verb ("Saving…") with a spinner,
 *   - disables itself so a second click cannot submit twice,
 *   - announces the state to assistive technology (aria-busy + a live region),
 *   - and never spins forever: after a bounded wait it says so and offers a
 *     reload, because a server action that hung is a fact the person needs,
 *     not one to hide behind a spinner.
 */
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

export type SubmitButtonProps = Omit<ButtonProps, "type"> & {
  /** Shown while the form is pending, e.g. "Saving…". Defaults to the label. */
  pendingLabel?: string;
  /** Shown once the wait becomes long (default 12 s), e.g. "Still working…". */
  slowLabel?: string;
  /** Shown once the wait is unreasonable (default 60 s), with a reload control. */
  stuckLabel?: string;
  reloadLabel?: string;
  slowAfterMs?: number;
  stuckAfterMs?: number;
};

const DEFAULT_SLOW_MS = 12_000;
const DEFAULT_STUCK_MS = 60_000;

type Phase = "pending" | "slow" | "stuck";

export function SubmitButton({
  pendingLabel,
  slowLabel,
  stuckLabel,
  reloadLabel,
  slowAfterMs = DEFAULT_SLOW_MS,
  stuckAfterMs = DEFAULT_STUCK_MS,
  children,
  disabled,
  className,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  // The phase only ever changes from timers (never synchronously in the effect),
  // and it is read together with `pending` so a stale value cannot show.
  const [phase, setPhase] = useState<Phase>("pending");

  useEffect(() => {
    if (!pending) return;
    const reset = setTimeout(() => setPhase("pending"), 0);
    const slow = setTimeout(() => setPhase("slow"), slowAfterMs);
    const stuck = setTimeout(() => setPhase("stuck"), stuckAfterMs);
    return () => {
      clearTimeout(reset);
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, [pending, slowAfterMs, stuckAfterMs]);

  const showing: "idle" | Phase = pending ? phase : "idle";
  const label =
    showing === "idle"
      ? children
      : showing === "slow" && slowLabel
        ? slowLabel
        : showing === "stuck" && stuckLabel
          ? stuckLabel
          : (pendingLabel ?? children);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="submit"
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        aria-disabled={disabled || pending || undefined}
        data-pending={pending ? "true" : undefined}
        className={className}
        {...props}
      >
        {pending ? (
          <span
            aria-hidden
            className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : null}
        <span>{label}</span>
      </Button>
      {/* One polite live region per button: screen readers hear the verb change once. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending && typeof label === "string" ? label : ""}
      </span>
      {showing === "stuck" && reloadLabel ? (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-xs text-ink-secondary underline"
        >
          {reloadLabel}
        </button>
      ) : null}
    </span>
  );
}
