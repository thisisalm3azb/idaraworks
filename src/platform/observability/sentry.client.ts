"use client";

/**
 * Client-side error capture for React error boundaries (Phase I). ENV-GATED on
 * NEXT_PUBLIC_SENTRY_DSN via dynamic import — zero bundle cost and a clean
 * no-op until Sentry is provisioned (OA-4). The digest tag pairs the client
 * event with the server-side `unhandled request error` log line.
 */
export function captureBoundaryError(error: Error & { digest?: string }): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.withScope((scope) => {
      if (error.digest) scope.setTag("digest", error.digest);
      scope.setTag("boundary", "react_error_boundary");
      Sentry.captureException(error);
    });
  });
}
