/**
 * Inbound billing-provider webhook (S9). The ONLY ingress that can change subscription state.
 *
 * Security (v1 §13 + doc 10 closed gaps): the raw body is read verbatim (signature is computed over
 * bytes, not a re-serialized object); the processor verifies the HMAC signature and drops anything
 * unverified BEFORE touching state; every outcome returns 200 so the provider does not retry a
 * duplicate/unresolved event into a storm. No secret is ever logged. While the provider is disabled
 * (pre-D1) the disabled adapter's verifySignature returns false, so this endpoint accepts nothing.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { processSubscriptionWebhook } from "@/modules/subscription/service";
import { rateLimit } from "@/platform/http/rateLimit";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-idara-billing-signature";
const MAX_BODY_BYTES = 64 * 1024; // a billing event is small; anything larger is abuse

export async function POST(request: Request): Promise<NextResponse> {
  // S10: bound the unauthenticated ingress. Per-IP rate limit + a hard body-size cap BEFORE any
  // signature-verify / org-resolve DB work (both were previously unbounded on this public route).
  const ip = clientIpFromHeaders(await headers());
  const limited = await rateLimit("webhook", ip);
  if (!limited.allowed) return NextResponse.json({ ok: false }, { status: 429 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
  const signature = request.headers.get(SIGNATURE_HEADER) ?? "";
  try {
    const outcome = await processSubscriptionWebhook(rawBody, signature);
    // 200 for every governed outcome (processed / duplicate / ignored / unverified / unresolved):
    // an error status would make the provider retry, and a duplicate is not a failure.
    return NextResponse.json({ ok: true, status: outcome.status }, { status: 200 });
  } catch (err) {
    // A genuine processing fault: log WITHOUT the body/signature (may carry sensitive data) and
    // return 200 so a poison event can't wedge the provider's retry queue; the inbox row + Sentry
    // capture it for manual reconciliation.
    logger.error({ err: (err as Error).message }, "billing webhook processing error");
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
