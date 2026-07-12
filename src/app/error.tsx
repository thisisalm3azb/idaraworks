"use client";

/**
 * Route error boundary (Phase I; BUILD_BIBLE §8.4): user-facing message is
 * translated and SAFE — no internals, no stack, no tenant values. The only
 * technical detail shown is Next's error digest, which pairs with the
 * server-side `unhandled request error` log line (instrumentation.ts) and the
 * response's x-request-id for support correlation. Rendered inside the root
 * layout, so lang/dir and app CSS apply; copy is bilingual because client
 * boundaries have no server t() and the failure may pre-date locale resolution.
 */
import { useEffect } from "react";
import { captureBoundaryError } from "@/platform/observability/sentry.client";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureBoundaryError(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold text-ink">
        Something went wrong <span aria-hidden>·</span> حدث خطأ ما
      </h1>
      <p className="text-sm text-ink-muted">
        The error has been recorded. Please try again — if it persists, contact support and quote
        the code below.
        <br />
        تم تسجيل الخطأ. حاول مرة أخرى — وإن استمر، تواصل مع الدعم مع ذكر الرمز أدناه.
      </p>
      {error.digest ? (
        <code className="rounded bg-sunken px-2 py-1 font-mono text-xs text-ink-muted">
          {error.digest}
        </code>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-ink-inverse"
      >
        Try again · إعادة المحاولة
      </button>
    </main>
  );
}
