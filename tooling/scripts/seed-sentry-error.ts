/**
 * Seeded Sentry error (S0 checklist §15 "Observability" AC: "Sentry receives a
 * seeded error with request_id"). Run AFTER the owner provisions Sentry (OA-4)
 * with SENTRY_DSN present in .env.local:
 *
 *   pnpm tsx tooling/scripts/seed-sentry-error.ts
 *
 * It captures one deliberate exception through the SAME wrapper the app uses
 * (tags + PII scrub included), flushes, and prints the request_id to look up in
 * the Sentry UI. Exit 1 if SENTRY_DSN is missing — the AC cannot be met yet.
 */
import "./load-env"; // review fix: the runbook points at .env.local — load it
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { initSentryServer, captureRequestError, sentryEnabled } from "@/platform/observability";

async function main() {
  if (!sentryEnabled()) {
    console.error("SENTRY_DSN is not set — provision Sentry (OA-4) first. See runbooks.");
    process.exit(1);
  }
  initSentryServer();
  const requestId = randomUUID();
  captureRequestError(new Error("seeded observability verification error (S0 §15 AC)"), {
    requestId,
    path: "/tooling/seed-sentry-error",
    method: "SCRIPT",
  });
  const flushed = await Sentry.flush(5000);
  console.log(`seeded error sent (flushed=${flushed}). request_id tag: ${requestId}`);
  console.log("Verify in Sentry: the event carries tags request_id/path and no PII.");
}

void main();
