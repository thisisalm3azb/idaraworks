/**
 * Client instrumentation (Phase I). Sentry browser init, ENV-GATED on
 * NEXT_PUBLIC_SENTRY_DSN: when unset (the pre-provisioning state, OA-4) the
 * dynamic import never runs, so the Sentry client bundle costs nothing.
 * Same PII law as the server channel: no default PII, no request bodies.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_APP_ENV ?? "prod",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });
}

/** Next requires this export when the file exists; no-op without Sentry. */
export const onRouterTransitionStart = (): void => {};
