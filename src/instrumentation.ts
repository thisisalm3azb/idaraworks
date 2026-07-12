/**
 * Next.js instrumentation (Phase I; BUILD_BIBLE §15).
 *
 * `onRequestError` is the single hook that observes EVERY server-side request
 * failure (render, server action, route handler). Each failure is logged
 * structured with the middleware-minted request id and Next's error digest —
 * the digest is what the user-facing error boundary shows, so a support report
 * quoting either id lands on this log line (§8.4: every 5xx carries request_id).
 */
import type { Instrumentation } from "next";
import { logger } from "@/platform/logger";
import { REQUEST_ID_HEADER } from "@/platform/observability/requestId";

export async function register(): Promise<void> {
  // Sentry (env-gated) initializes here — see observability/sentry.
  const { initSentryServer } = await import("@/platform/observability/sentry");
  initSentryServer();
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const rawRid = headers[REQUEST_ID_HEADER];
  const requestId = Array.isArray(rawRid) ? rawRid[0] : rawRid;
  const digest =
    typeof err === "object" && err !== null && "digest" in err
      ? String((err as { digest?: unknown }).digest)
      : undefined;

  // LAW (§5.9/§8.5): identifiers only — never request bodies or tenant values.
  logger.error(
    {
      request_id: requestId,
      digest,
      path: request.path,
      method: request.method,
      router_kind: context.routerKind,
      route_path: context.routePath,
      route_type: context.routeType,
      err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
    },
    "unhandled request error",
  );

  const { captureRequestError } = await import("@/platform/observability/sentry");
  captureRequestError(err, { requestId, digest, path: request.path, method: request.method });
};
