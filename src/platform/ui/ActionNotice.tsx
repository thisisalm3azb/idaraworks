"use client";

/**
 * The shared answer to "did that work?" for server-action forms.
 *
 * Actions in this app finish with a redirect, and the redirect can carry
 * `?ok=<code>` or `?error=<code>`. Pages used to read those themselves, most
 * did not, and the rest each invented their own banner. This component reads
 * them once for a whole layout, so a redirect with a code is enough for the
 * person to see a confirmation or a failure with a way to retry.
 *
 *   - `ok`    → polite status, green, focused once so keyboard and screen-reader
 *               users land on it; dismissable; cleared from the URL on dismiss.
 *   - `error` → assertive alert, red, stays until dismissed.
 *
 * The copy comes from the server (translated), keyed by code. A code that is
 * not in the registry renders nothing here: a page that shows richer feedback
 * of its own uses codes outside the registry, so the two never say the same
 * thing twice.
 */
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type ActionNoticeMessages = {
  ok: Record<string, string>;
  error: Record<string, string>;
  dismiss: string;
};

export function ActionNotice({
  messages,
  /** Codes handled by the page itself; the shared notice stays quiet for them. */
  except = [],
}: {
  messages: ActionNoticeMessages;
  except?: string[];
}) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const ok = sp.get("ok");
  const error = sp.get("error");
  const kind: "ok" | "error" | null = error ? "error" : ok ? "ok" : null;
  const code = error ?? ok;
  const ref = useRef<HTMLDivElement>(null);
  const registered = kind === "ok" ? messages.ok[code ?? ""] : messages.error[code ?? ""];
  const silent = !kind || !code || except.includes(code) || !registered;

  useEffect(() => {
    if (!silent) ref.current?.focus();
  }, [silent, kind, code]);

  if (silent) return null;

  const text = registered as string;

  function dismiss() {
    const next = new URLSearchParams(sp.toString());
    next.delete("ok");
    next.delete("error");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      data-action-notice={kind}
      className={
        kind === "error"
          ? "mb-4 flex items-start justify-between gap-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger outline-none"
          : "mb-4 flex items-start justify-between gap-3 rounded-md border border-success/40 bg-success-soft px-3 py-2 text-sm text-success outline-none"
      }
    >
      <span>{text}</span>
      <button
        type="button"
        onClick={dismiss}
        className="min-h-8 shrink-0 rounded px-2 text-xs font-medium underline"
      >
        {messages.dismiss}
      </button>
    </div>
  );
}
