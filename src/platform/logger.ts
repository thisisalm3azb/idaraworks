import pino from "pino";

/**
 * Structured logger (BUILD_BIBLE §8.5, §15.1).
 * Every request-scoped log line carries org_id / user_id / request_id via child().
 * LAW: no tenant business values (names, amounts) at info level or above —
 * identifiers only. Reviewer checklist item §18.9.
 */
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  base: { app: "idaraworks", env: process.env.APP_ENV ?? "dev" },
  redact: {
    // Defence-in-depth: known-sensitive keys never serialize (review finding #8b —
    // pino wildcards match one level; cover two levels for the common shapes).
    paths: [
      "password",
      "token",
      "secret",
      "apiKey",
      "authorization",
      "phone",
      "email",
      "*.password",
      "*.token",
      "*.secret",
      "*.apiKey",
      "*.authorization",
      "*.phone",
      "*.email",
      "req.headers.cookie",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
});

export type RequestLogContext = {
  requestId: string;
  orgId?: string;
  userId?: string;
};

/** Child logger bound to a request context — the only logger request code should use. */
export function requestLogger(ctx: RequestLogContext) {
  return logger.child({
    request_id: ctx.requestId,
    ...(ctx.orgId ? { org_id: ctx.orgId } : {}),
    ...(ctx.userId ? { user_id: ctx.userId } : {}),
  });
}
