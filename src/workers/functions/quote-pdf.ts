/**
 * Quote PDF renderer (U2 branding — mirrors the LPO PDF worker exactly). On
 * quote/accepted, build the bilingual/bidi quote HTML (branded header when
 * feat.branding_docs is on; org-name text fallback otherwise). The RENDER
 * (HTML→PDF) + STORE step is the SAME gated seam as the LPO worker: until the
 * render runtime + Inngest are provisioned (owner action) this builds the HTML
 * and logs the gated step — no new worker plumbing beyond registering the
 * function the way lpo-pdf does.
 */
import { QUOTE_ACCEPTED } from "@/platform/events";
import type { Ctx } from "@/platform/tenancy";
import { buildQuoteHtmlForQuote } from "@/modules/quotes/service";
import { logger } from "@/platform/logger";
import { defineOrgFunction } from "../harness";

export type QuoteRenderResult =
  { outcome: "built"; htmlChars: number } | { outcome: "skipped"; reason: string };

/** Plain function (shared by the Inngest wrapper + tests): build the quote HTML. */
export async function buildQuoteForAccept(ctx: Ctx, quoteId: string): Promise<QuoteRenderResult> {
  const html = await buildQuoteHtmlForQuote(ctx, quoteId);
  if (!html) return { outcome: "skipped", reason: "quote not visible in org context" };
  logger.info(
    { orgId: ctx.orgId, quoteId, htmlChars: html.length, requestId: ctx.requestId },
    "quote HTML built — PDF render+store gated on render runtime + Inngest (owner action)",
  );
  return { outcome: "built", htmlChars: html.length };
}

export const quotePdfRenderer = defineOrgFunction(
  { id: "quote-pdf-renderer", event: QUOTE_ACCEPTED, retries: 3 },
  ({ payload, ctx }) => buildQuoteForAccept(ctx, payload.quoteId),
);
