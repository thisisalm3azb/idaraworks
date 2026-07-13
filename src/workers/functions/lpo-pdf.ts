/**
 * LPO PDF renderer (S4 "Arabic PDF pipeline v1", doc 11). On purchase_order/approved,
 * build the bilingual/bidi LPO HTML for the PO. The RENDER (HTML→PDF via headless
 * Chromium) + STORE (files pipeline, class financial_doc) is a SEAM — the doc's
 * explicit "fallback to a render microservice (same seam)". The prod render runtime
 * (bundled Chromium vs a render microservice) is an owner/infra decision, and these
 * workers do not fire in prod until Inngest is provisioned; so when no renderer is
 * configured this logs the gated owner action and no-ops. The HTML template itself
 * (the substantive v1 deliverable) is bidi-snapshot-tested; a real PDF for the
 * Arabic-native review AC is produced by the demo via Playwright's chromium.
 */
import { PURCHASE_ORDER_APPROVED } from "@/platform/events";
import type { Ctx } from "@/platform/tenancy";
import { buildLpoHtmlForPo } from "@/modules/supply/service";
import { logger } from "@/platform/logger";
import { defineOrgFunction } from "../harness";

export type LpoRenderResult =
  { outcome: "built"; htmlChars: number } | { outcome: "skipped"; reason: string };

/** Plain function (shared by the Inngest wrapper + tests): build the LPO HTML. */
export async function buildLpoForPo(ctx: Ctx, purchaseOrderId: string): Promise<LpoRenderResult> {
  const html = await buildLpoHtmlForPo(ctx, purchaseOrderId);
  if (!html) return { outcome: "skipped", reason: "PO not visible in org context" };
  // Render + store seam (gated): a configured renderer/microservice + Inngest turn
  // this into a stored financial_doc PDF + purchase_order.pdf_file_id. Until then
  // the HTML is built and the gated step is logged (owner action).
  logger.info(
    { orgId: ctx.orgId, purchaseOrderId, htmlChars: html.length, requestId: ctx.requestId },
    "LPO HTML built — PDF render+store gated on render runtime + Inngest (owner action)",
  );
  return { outcome: "built", htmlChars: html.length };
}

export const lpoPdfRenderer = defineOrgFunction(
  { id: "lpo-pdf-renderer", event: PURCHASE_ORDER_APPROVED, retries: 3 },
  ({ payload, ctx }) => buildLpoForPo(ctx, payload.purchaseOrderId),
);
