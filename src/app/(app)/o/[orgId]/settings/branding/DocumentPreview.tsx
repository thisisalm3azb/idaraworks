/**
 * Brand & Documents sample preview (003B.1). Renders the branded document
 * shell with the org's CURRENT profile into a sandboxed iframe (srcDoc — the
 * document's own print styles cannot leak into the app, and the app's styles
 * cannot distort the document). Explicitly labelled as a SAMPLE and rendered
 * with the SAMPLE watermark — it is never a real invoice or quote.
 * Server component; the shell is a pure string renderer (no browser DB access).
 */
import { Card, CardHeader } from "@/platform/ui";
import { renderDocumentShell, esc } from "@/platform/documents";
import type { DocumentProfile } from "@/modules/branding/service";

export type DocumentPreviewDict = {
  title: string;
  sample_note: string;
  frame_title: string;
  sample_title_ar: string;
  sample_title_en: string;
  sample_body: string;
};

export function DocumentPreview({
  profile,
  dateText,
  dict,
}: {
  profile: DocumentProfile;
  /** Pre-formatted "generated" date (the page formats it in org locale). */
  dateText: string;
  dict: DocumentPreviewDict;
}) {
  const html = renderDocumentShell({
    issuer: {
      tradingName: profile.identity.tradingName,
      legalName: profile.identity.legalName,
      trn: profile.identity.trn,
      licenseNo: profile.identity.licenseNo,
      addressLineEn: profile.addressLineEn,
      addressLineAr: profile.addressLineAr,
      phone: profile.identity.phone,
      email: profile.identity.email,
      website: profile.identity.website,
      footer: profile.identity.footer,
      signatoryName: profile.identity.signatoryName,
      signatoryTitle: profile.identity.signatoryTitle,
      paymentInstructions: profile.identity.paymentInstructions,
      logoDataUri: profile.logoDataUri,
    },
    titleAr: dict.sample_title_ar,
    titleEn: dict.sample_title_en,
    reference: "SMP-0001",
    dateText,
    watermark: "sample",
    language: profile.identity.docLanguage,
    bodyHtml: `<p style="color:#444">${esc(dict.sample_body)}</p>`,
    accentColor: profile.accentColor,
    showSignatory: true,
    showPaymentInstructions: false,
  });

  return (
    <Card>
      <CardHeader title={dict.title} />
      <p className="mb-3 text-sm text-ink-muted">{dict.sample_note}</p>
      <iframe
        srcDoc={html}
        title={dict.frame_title}
        sandbox=""
        className="h-[420px] w-full rounded-md border border-line bg-white"
      />
    </Card>
  );
}
