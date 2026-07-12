/**
 * Inngest serve endpoint (S0 checklist §7 item 1). Signature verification is
 * enforced automatically when INNGEST_SIGNING_KEY is set (required in
 * production before pilots — owner item); without it the SDK only accepts
 * dev-mode traffic.
 *
 * Phase I: in a DEPLOYED environment (preview/prod) with no signing key, the
 * SDK would 500 on every request ("In cloud mode but no signing key found").
 * That state is the documented pre-provisioning owner action, not a defect —
 * report it explicitly as 503 `inngest_unconfigured` instead of a generic 500.
 * When the key IS present the serve handlers run untouched, signature
 * enforcement included; dev-mode (local, APP_ENV=dev) is also untouched. This
 * guard never weakens verification — it only replaces the SDK's crash path.
 */
import { NextResponse } from "next/server";
import { serve } from "inngest/next";
import { inngest } from "@/platform/events";
import { workerFunctions } from "@/workers";
import { inngestStatus } from "@/platform/observability/health";
import { newRequestId, REQUEST_ID_HEADER } from "@/platform/observability/requestId";

const handlers = serve({
  client: inngest,
  functions: workerFunctions,
});

const deployed = process.env.APP_ENV === "prod" || process.env.APP_ENV === "preview";

function unconfigured(): NextResponse {
  const requestId = newRequestId();
  return NextResponse.json(
    { ...inngestStatus(), status: "inngest_unconfigured", request_id: requestId },
    { status: 503, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

// Review fix: keyed to the SAME predicate health reports (both keys present) —
// a partially-configured deploy (signing key without event key) is still a
// misconfiguration and must say so rather than half-work.
const guard = deployed && !inngestStatus().configured;

export const GET = guard ? unconfigured : handlers.GET;
export const POST = guard ? unconfigured : handlers.POST;
export const PUT = guard ? unconfigured : handlers.PUT;
