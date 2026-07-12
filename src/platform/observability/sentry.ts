/**
 * Sentry — error reporting channel (Phase I; S0 checklist §15 "Observability",
 * BUILD_BIBLE §15.4). ENV-GATED: without SENTRY_DSN every function here is a
 * clean no-op, so the platform runs identically before the owner provisions
 * Sentry (OA-4). Runtime-only integration — no build plugin, no sourcemap
 * upload (that needs SENTRY_AUTH_TOKEN in CI; owner item) — so the working
 * Vercel build pipeline is untouched.
 *
 * PII law (BUILD_BIBLE §5.9/§8.5): events carry identifiers only. beforeSend
 * scrubs cookies, request bodies, and all headers except the correlation id;
 * user context is reduced to the id. No tenant business values, ever.
 */
import * as Sentry from "@sentry/nextjs";

export function sentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

type SentryEvent = Sentry.ErrorEvent;

/** Query strings can carry tokens/emails (e.g. ?next=, invite links) — never ship them. */
export function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Exported for unit tests: the PII scrub applied to every outgoing event. */
export function scrubEvent<E extends SentryEvent>(event: E): E {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string; // review fix: ?next=/token params are PII-bearing
    event.request.url = stripQuery(event.request.url);
    const rid = event.request.headers?.["x-request-id"];
    event.request.headers = rid ? { "x-request-id": rid } : {};
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  // Breadcrumbs may echo console/query/DOM fragments — the identifiers-only law
  // keeps only the category/level/type skeleton: no data AND no free-form
  // message (review fix: console breadcrumbs put raw console args in message).
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      delete crumb.data;
      delete crumb.message;
    }
  }
  return event;
}

let initialized = false;

/** Server/edge init — called from instrumentation register() on every runtime. */
export function initSentryServer(): void {
  if (!sentryEnabled() || initialized) return;
  initialized = true;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? "dev",
    sendDefaultPii: false,
    // Error channel only in S0 — sampled tracing is a later-slice Bible §15.3 item.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
  });
}

/** Capture an unhandled request failure with correlation tags (§8.4). */
export function captureRequestError(
  err: unknown,
  tags: { requestId?: string; digest?: string; path?: string; method?: string },
): void {
  if (!sentryEnabled()) return;
  Sentry.withScope((scope) => {
    if (tags.requestId) scope.setTag("request_id", tags.requestId);
    if (tags.digest) scope.setTag("digest", tags.digest);
    if (tags.path) scope.setTag("path", tags.path);
    if (tags.method) scope.setTag("method", tags.method);
    Sentry.captureException(err);
  });
}

/** Worker failure — org/request tagged (identifiers only; Bible §8.7). */
export function captureWorkerError(
  err: unknown,
  tags: { functionId: string; orgId?: string; requestId?: string },
): void {
  if (!sentryEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("worker", tags.functionId);
    if (tags.orgId) scope.setTag("org_id", tags.orgId);
    if (tags.requestId) scope.setTag("request_id", tags.requestId);
    Sentry.captureException(err);
  });
}

/**
 * Dead-letter alert (Bible §15.4: queue dead-letters are PAGE-WORTHY). A
 * message-level event so it alerts even though the original error object
 * belongs to the failing consumer, not the relay.
 */
export function captureDeadLetter(sample: Array<{ id: string; name: string }>): void {
  if (!sentryEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("channel", "outbox_dead_letter");
    scope.setContext("dead_letter", {
      count: sample.length,
      ids: sample.map((s) => s.id),
      names: sample.map((s) => s.name),
    });
    Sentry.captureMessage("domain events dead-lettered", "error");
  });
}
