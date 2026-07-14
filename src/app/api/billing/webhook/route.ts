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
import { processSubscriptionWebhook } from "@/modules/subscription/service";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-idara-billing-signature";

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
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
