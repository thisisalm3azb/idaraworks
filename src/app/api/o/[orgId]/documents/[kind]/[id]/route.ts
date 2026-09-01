/**
 * The document itself (H22.0). GET returns the rendered document as HTML, or as
 * a PDF with `?format=pdf`.
 *
 * Both formats come from ONE render model, so the preview a user reads and the
 * PDF they send a customer cannot disagree. Tenant-scoped through resolveCtx →
 * withCtx RLS, and permission-checked inside documentModel() by the record's own
 * view action: a viewer who may not open an invoice may not print one either.
 */
import { NextResponse } from "next/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  renderDocument,
  isRenderFailure,
  renderUnavailable,
  renderingPdf,
} from "@/platform/documents";
import { DOCUMENT_KINDS, documentModel, type DocumentKind } from "@/modules/documents/service";
import { logger } from "@/platform/logger";

export const dynamic = "force-dynamic";
/** Chromium needs room to start on a cold serverless container. */
export const maxDuration = 60;

const isKind = (v: string): v is DocumentKind => (DOCUMENT_KINDS as readonly string[]).includes(v);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; kind: string; id: string }> },
): Promise<NextResponse> {
  const { orgId, kind, id } = await params;
  if (!isKind(kind)) {
    return NextResponse.json({ error: "unknown document kind" }, { status: 404 });
  }
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const wantsPdf = url.searchParams.get("format") === "pdf";
  const autoPrint = url.searchParams.get("print") === "1";
  const language = url.searchParams.get("lang") === "ar" ? "ar" : "en";

  try {
    const model = await documentModel(resolved.ctx, resolved.archetype, {
      kind,
      id,
      language,
    });

    if (!wantsPdf) {
      // Served for reading and printing. Font faces travel as same-origin URLs
      // so a browser caches them across documents.
      // `?print=1` opens the print dialog once the document (and its fonts)
      // have loaded. Printing before the font is ready would print a
      // fallback face, which for Arabic means the wrong shapes entirely.
      const html = renderDocument(model);
      const body = autoPrint
        ? html.replace(
            "</body>",
            `<script>document.fonts.ready.then(()=>window.print())</script></body>`,
          )
        : html;
      return new NextResponse(body, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // A document may contain prices and customer names: never store it in
          // a shared cache, and never let a stale copy stand in for a revision.
          "cache-control": "private, no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    // The PDF path loads the document through setContent(), which has no base
    // URL, so the font must travel WITH it or Arabic silently falls back to
    // whatever the container has — which on Linux is nothing.
    /*
     * Wrapped, so the answer does not depend on recognising the message. By
     * here the caller is authorized and the model has loaded: the document
     * exists, and anything that fails from now on is the renderer.
     */
    const pdf = await renderingPdf(async () => {
      const { renderPdf, embeddedDocumentFonts } = await import("@/platform/documents");
      const html = renderDocument(model, {
        delivery: "embed",
        embedded: await embeddedDocumentFonts(),
      });
      return renderPdf(html, { pageNumbers: true, rtl: model.language !== "en" });
    });
    const filename = `${model.reference.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf`;
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    /*
     * A document that cannot be PRINTED is not a document that does not EXIST.
     *
     * Every failure here used to collapse into 404 "not found". So when the
     * renderer could not start — which in production it could not, because the
     * browser binary was never traced into the function — somebody looking at an
     * invoice was told the invoice was not there, and would reasonably conclude
     * their data had gone.
     *
     * A rendering failure now gets its own answer, and names the thing that does
     * still work: the same document as HTML, which the browser can print itself.
     */
    if (wantsPdf && isRenderFailure(err)) {
      return renderUnavailable(
        err,
        `${url.pathname}?print=1&lang=${language}`,
        request.headers.get("accept"),
      );
    }

    // A missing record and a record in another organization are the same
    // response: nothing here confirms that an id exists elsewhere. It is logged
    // either way — a 404 nobody records is how the render defect stayed hidden.
    logger.error(
      { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), wantsPdf },
      "document request failed",
    );
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
