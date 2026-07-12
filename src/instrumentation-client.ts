/**
 * Client instrumentation (Phase I). Sentry browser init, ENV-GATED on
 * NEXT_PUBLIC_SENTRY_DSN: when unset (the pre-provisioning state, OA-4) the
 * dynamic import never runs, so the Sentry client bundle costs nothing.
 *
 * PII law (review fix): sendDefaultPii:false does NOT cover the browser SDK's
 * default breadcrumbs (console args, fetch/XHR URLs, DOM click/keypress target
 * text) or the page URL — so the client registers its own scrub: URLs are
 * stripped of query strings, breadcrumbs keep only their category/level/type
 * skeleton, and request/user data is reduced exactly like the server channel.
 * (This beforeSend also covers boundary captures from sentry.client.ts —
 * hooks registered at init apply to every event from this client.)
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

if (dsn) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn,
      // Mirrors the server default ("dev") — production must set
      // NEXT_PUBLIC_APP_ENV=prod (runbooks/sentry-provisioning.md).
      environment: process.env.NEXT_PUBLIC_APP_ENV ?? "dev",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend(event) {
        if (event.request) {
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          event.request.url = stripQuery(event.request.url);
          delete event.request.headers;
        }
        if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
        if (event.breadcrumbs) {
          for (const crumb of event.breadcrumbs) {
            delete crumb.data;
            delete crumb.message;
          }
        }
        return event;
      },
      beforeBreadcrumb(crumb) {
        // Identifiers-only at the source: keep the skeleton, drop free-form
        // payloads (console args, fetched URLs' query strings, DOM text).
        delete crumb.message;
        if (crumb.data) {
          const url = typeof crumb.data.url === "string" ? stripQuery(crumb.data.url) : undefined;
          crumb.data = url ? { url } : {};
        }
        return crumb;
      },
    });
  });
}

/** Next requires this export when the file exists; no-op without Sentry. */
export const onRouterTransitionStart = (): void => {};
