/**
 * H26 — the authored document itself. GET returns the rendered document as
 * HTML (preview / print) or as a PDF with `?format=pdf`.
 *
 * ONE renderer serves the builder preview, the print page and the PDF. An
 * issued document renders from its immutable snapshot (frozen values, frozen
 * issuer identity) — never from live records — so the PDF a counterparty
 * downloads years later is the document that was issued. A draft renders
 * from a revision with bindings resolved live under the reader's own
 * permissions. `?rev=<revisionId>` previews a specific revision of a draft.
 *
 * The path sits under /api/o/**\/documents/** so the Chromium payload is
 * traced into this function exactly as for the record prints (next.config).
 */
import { NextResponse } from "next/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import {
  isRenderFailure,
  renderUnavailable,
  renderingPdf,
  shellIssuerFromIdentity,
  shellIssuerFromSnapshot,
} from "@/platform/documents";
import { getT } from "@/platform/i18n/server";
import { formatDate } from "@/platform/format";
import { logger } from "@/platform/logger";
import { getDocumentProfile } from "@/modules/branding/service";
import {
  DocError,
  factsOf,
  getDocument,
  getRevision,
  listSignaturesForRender,
  renderDocumentHtml,
  resolveValues,
  type RenderInput,
} from "@/modules/docstudio/service";

export const dynamic = "force-dynamic";
/** Chromium needs room to start on a cold serverless container. */
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; id: string }> },
): Promise<NextResponse> {
  if (!documentStudioEnabled()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { orgId, id } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const wantsPdf = url.searchParams.get("format") === "pdf";
  const autoPrint = url.searchParams.get("print") === "1";
  const revParam = url.searchParams.get("rev");
  const t = await getT();

  try {
    const detail = await getDocument(resolved.ctx, resolved.archetype, id);
    const d = detail.document;
    const lang = d.language as "en" | "ar" | "bilingual";
    const dateLocale = lang === "ar" ? "ar" : "en";
    const statusText = t(`docstudio.status.${d.effectiveStatus}`);
    let input: RenderInput;

    if (detail.snapshot && !revParam) {
      const s = detail.snapshot.snapshot;
      const profile = await getDocumentProfile(resolved.ctx);
      // The logo is frozen by FILE id; files are never deleted, and the
      // current profile resolves it when it is still the same file.
      const logo =
        profile.identity.logoFileId && profile.identity.logoFileId === s.branding.logoFileId
          ? profile.logoDataUri
          : null;
      const signatures = await listSignaturesForRender(resolved.ctx, resolved.archetype, d.id);
      input = {
        language: lang,
        body: s.body,
        settings: s.settings,
        values: s.values,
        issuer: shellIssuerFromSnapshot(s.issuer, logo),
        reference: d.reference,
        title: d.title,
        dateText: formatDate(s.issuedAt, { locale: dateLocale }),
        statusText,
        revisionText: `${t("docstudio.snapshot")} ${detail.snapshot.contentHash.slice(0, 12)}`,
        watermark:
          d.effectiveStatus === "terminated" || d.effectiveStatus === "superseded"
            ? "void"
            : d.effectiveStatus === "expired"
              ? "void"
              : null,
        accentColor: s.branding.accentColor,
        signatures: signatures.rows,
        evidence: {
          contentHash: detail.snapshot.contentHash,
          lines: [
            `${t("docstudio.evidence.issued_at")}: ${s.issuedAt}`,
            ...signatures.evidenceLines,
            t("docstudio.evidence.disclaimer"),
          ],
        },
      };
    } else {
      const revisionId =
        revParam ?? d.workingRevisionId ?? detail.revisions[detail.revisions.length - 1]?.id;
      if (!revisionId) throw new DocError("document has no content", "state");
      const rev = await getRevision(resolved.ctx, resolved.archetype, revisionId, d.id);
      const profile = await getDocumentProfile(resolved.ctx);
      const values = await resolveValues(
        resolved.ctx,
        resolved.archetype,
        factsOf(d),
        rev.body,
        rev.variables,
        profile,
      );
      input = {
        language: lang,
        body: rev.body,
        settings: rev.settings,
        values,
        issuer: shellIssuerFromIdentity(profile.identity, profile.logoDataUri),
        reference: d.reference,
        title: d.title,
        dateText: formatDate(new Date(), { locale: dateLocale }),
        statusText,
        revisionText: `${t("docstudio.revision")} ${rev.revisionNo}`,
        watermark: "draft",
        accentColor: profile.accentColor,
      };
    }

    if (!wantsPdf) {
      const html = renderDocumentHtml(input, { delivery: "url" });
      const body = autoPrint
        ? html.replace(
            "</body>",
            `<script>document.fonts.ready.then(()=>window.print())</script></body>`,
          )
        : html;
      return new NextResponse(body, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    const pdf = await renderingPdf(async () => {
      const { renderPdf, embeddedDocumentFonts } = await import("@/platform/documents");
      const html = renderDocumentHtml(input, {
        delivery: "embed",
        embedded: await embeddedDocumentFonts(),
      });
      return renderPdf(html, {
        pageNumbers: input.settings.footer.showPageNumbers,
        rtl: lang !== "en",
      });
    });
    const suffix = detail.snapshot && !revParam ? "" : `-draft`;
    const filename = `${d.reference.replace(/[^A-Za-z0-9._-]/g, "-")}${suffix}.pdf`;
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex, nofollow",
        "x-document-hash": detail.snapshot && !revParam ? detail.snapshot.contentHash : "draft",
      },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (wantsPdf && isRenderFailure(err)) {
      return renderUnavailable(err, `${url.pathname}?print=1`, request.headers.get("accept"));
    }
    logger.error(
      { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), wantsPdf },
      "document studio request failed",
    );
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
