/**
 * PUBLIC document link (H22.0). No sign-in: whoever holds the token sees ONE
 * document and nothing else.
 *
 * The security model is the customer-update share's, followed deliberately
 * rather than reinvented:
 *   - the token is 32 random bytes, and only its SHA-256 is stored, so a
 *     database backup is not a set of working URLs;
 *   - expiry and revocation are applied inside a SECURITY DEFINER resolver, not
 *     by a policy an anonymous role could be granted around;
 *   - unknown, expired and revoked all return the SAME "not available" page, so
 *     a token cannot be probed for existence;
 *   - per-IP rate limiting, and noindex, so the link is neither crawled nor
 *     brute-forced.
 *
 * The document is rendered with the SERVICE role because there is no member
 * context to run RLS against — which is exactly why the resolver returns a
 * single subject and this route renders that subject only.
 */
import { headers } from "next/headers";
import { rateLimit } from "@/platform/http/rateLimit";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { resolveDocumentShare, documentModel } from "@/modules/documents/service";
import { renderDocument, isRenderFailure, pdfUnavailablePage } from "@/platform/documents";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";
/** Chromium needs room to start on a cold serverless container, as on the
 *  authenticated twin: the PDF path here launches the same browser. */
export const maxDuration = 60;

const NOT_AVAILABLE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" /><title>Document not available</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;
min-height:100vh;background:#fafafa;color:#1a1a1a}main{text-align:center;padding:24px}
h1{font-size:18px;font-weight:600;margin:0 0 6px}p{margin:0;color:#666;font-size:14px}</style>
</head><body><main><h1>This document is not available</h1>
<p>The link may have expired or been withdrawn.</p></main></body></html>`;

/** Inline, because the shared page carries no stylesheet of the app's. */
const SHARE_BTN =
  "display:inline-flex;align-items:center;min-height:40px;padding:0 12px;border:1px solid #ccc;" +
  "border-radius:6px;background:#fff;color:#1a1a1a;text-decoration:none;";

const notAvailable = () =>
  new Response(NOT_AVAILABLE, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const h = await headers();
  const url = new URL(request.url);
  const wantsPdf = url.searchParams.get("format") === "pdf";
  const ip = clientIpFromHeaders(h);
  // The PDF starts a headless browser, so it gets its own tighter budget on top
  // of the page budget rather than sharing the view allowance.
  const gate = await rateLimit(wantsPdf ? "share_pdf" : "share", ip);
  if (!gate.allowed) return notAvailable();

  const share = await resolveDocumentShare(token);
  if (!share) return notAvailable();

  try {
    const language = url.searchParams.get("lang") === "ar" ? "ar" : "en";
    // A share link carries the authority; there is no signed-in member to scope
    // to. The resolver has already limited this to one document in one org.
    const ctx = {
      orgId: share.orgId,
      userId: "00000000-0000-0000-0000-000000000000",
      costPrivileged: false,
      pricePrivileged: true,
      requestId: "document-share",
    };
    const model = await documentModel(ctx, "owner", {
      kind: share.kind,
      id: share.id,
      language,
    });
    if (wantsPdf) {
      const { renderPdf, embeddedDocumentFonts } = await import("@/platform/documents");
      const html = renderDocument(model, {
        delivery: "embed",
        embedded: await embeddedDocumentFonts(),
      });
      const pdf = await renderPdf(html, {
        pageNumbers: true,
        rtl: model.language !== "en",
      });
      const filename = `${model.reference.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf`;
      return new Response(Buffer.from(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    // The recipient is not signed in and has no app around the document, so the
    // controls travel with it. Hidden when printing, so they never appear on
    // paper.
    const other = language === "ar" ? "en" : "ar";
    const toolbar =
      `<div class="no-print" style="position:fixed;top:12px;inset-inline-end:12px;display:flex;` +
      `gap:8px;font-family:system-ui,sans-serif;font-size:13px;z-index:5;">` +
      `<a href="?format=pdf&lang=${language}" style="${SHARE_BTN}">${language === "ar" ? "تنزيل PDF" : "Download PDF"}</a>` +
      `<a href="?lang=${other}" style="${SHARE_BTN}">${other === "ar" ? "العربية" : "English"}</a>` +
      `</div>`;
    return new Response(renderDocument(model).replace("</body>", `${toolbar}</body>`), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    /*
     * A recipient outside the business gets the same distinction, and needs it
     * more: they have no support channel and no way to tell a broken link from
     * a broken renderer. "This link is not available" would send them back to
     * whoever sent it, for a document that is sitting right there.
     *
     * So a render failure keeps them on the document, in HTML, where their own
     * browser can print it.
     */
    if (wantsPdf && isRenderFailure(err)) {
      const back = url.pathname + "?lang=" + (url.searchParams.get("lang") === "ar" ? "ar" : "en");
      logger.error(
        { err: err instanceof Error ? err.name + ": " + err.message : String(err) },
        "shared document PDF render failed",
      );
      return new Response(pdfUnavailablePage(back), {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "60",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    return notAvailable();
  }
}
