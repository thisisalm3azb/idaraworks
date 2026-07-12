"use client";

/**
 * Root error boundary (Phase I; BUILD_BIBLE §8.4). Replaces the entire root
 * layout when even the layout fails, so it must render its own <html>/<body>
 * and cannot rely on app CSS — styles are inline. Same safety law as
 * error.tsx: translated, generic, digest-only; the digest pairs with the
 * `unhandled request error` server log line (instrumentation.ts).
 */
import { useEffect } from "react";
import { captureBoundaryError } from "@/platform/observability/sentry.client";

export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#fafaf9",
          color: "#1c1917",
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>
            Something went wrong <span aria-hidden>·</span> حدث خطأ ما
          </h1>
          <p style={{ fontSize: 14, color: "#57534e", lineHeight: 1.6 }}>
            The error has been recorded. Please try again — if it persists, contact support and
            quote the code below.
            <br />
            تم تسجيل الخطأ. حاول مرة أخرى — وإن استمر، تواصل مع الدعم مع ذكر الرمز أدناه.
          </p>
          {error.digest ? (
            <code
              style={{
                display: "inline-block",
                margin: "8px 0",
                padding: "4px 8px",
                borderRadius: 4,
                background: "#f5f5f4",
                fontSize: 12,
                color: "#57534e",
              }}
            >
              {error.digest}
            </code>
          ) : null}
          <div>
            <button
              type="button"
              onClick={reset}
              style={{
                marginTop: 8,
                padding: "8px 16px",
                borderRadius: 6,
                border: "none",
                background: "#166534",
                color: "#ffffff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again · إعادة المحاولة
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
