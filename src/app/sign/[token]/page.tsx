/**
 * PUBLIC signing page (H26). Whoever holds a live invitation token sees ONE
 * issued document and may sign or decline it. The token is resolved through
 * the SECURITY DEFINER resolver; unknown, expired, revoked and used tokens
 * all render the same "not available" page. No app shell, no sign-in.
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import { rateLimit } from "@/platform/http/rateLimit";
import { documentStudioEnabled } from "@/platform/flags";
import { formatDate } from "@/platform/format";
import { shellIssuerFromSnapshot } from "@/platform/documents";
import { withCtx } from "@/platform/tenancy";
import {
  CONSENT_TEXT,
  loadDocIn,
  loadSnapshotIn,
  markInvitationViewed,
  renderDocumentHtml,
  resolveSignerToken,
  signaturesForRenderIn,
  signerCtx,
} from "@/modules/docstudio/service";
import { ShadowHtml } from "./ShadowHtml";
import { SignForm } from "./SignForm";
import { declineAction, signAction } from "./actions";

export const dynamic = "force-dynamic";

const COPY = {
  en: {
    title: "Your signature is requested",
    unavailable: "This signing link is not available",
    unavailableHint: "It may have expired, been withdrawn, or already been used.",
    signedTitle: "Thank you, your signature was recorded",
    completedTitle: "Thank you, the document is now fully signed",
    declinedTitle: "You declined to sign",
    receipt: "Evidence receipt",
    party: "Signing as",
    expires: "Please sign by",
    other: "العربية",
    name: "Your name",
    signTitle: "Title (optional)",
    typed: "Type",
    drawn: "Draw",
    typedHint: "Type your name as your signature",
    drawHint: "Draw your signature with your finger or mouse",
    clear: "Clear",
    consent: "I agree",
    sign: "Sign document",
    decline: "Decline to sign",
    declineReason: "Reason",
    declineConfirm: "Confirm decline",
    cancel: "Cancel",
    disclaimer:
      "Electronic signature with an evidence record: your name as signed, the time from the server clock, your network address and the document's content hash are recorded. No digital certificate or qualified time stamp is applied.",
  },
  ar: {
    title: "مطلوب توقيعك",
    unavailable: "رابط التوقيع هذا غير متاح",
    unavailableHint: "ربما انتهت صلاحيته أو سُحب أو استُخدم بالفعل.",
    signedTitle: "شكراً، تم تسجيل توقيعك",
    completedTitle: "شكراً، اكتمل توقيع المستند",
    declinedTitle: "لقد رفضت التوقيع",
    receipt: "إيصال الإثبات",
    party: "التوقيع بصفة",
    expires: "يرجى التوقيع قبل",
    other: "English",
    name: "اسمك",
    signTitle: "المسمى (اختياري)",
    typed: "كتابة",
    drawn: "رسم",
    typedHint: "اكتب اسمك كتوقيع",
    drawHint: "ارسم توقيعك بإصبعك أو بالفأرة",
    clear: "مسح",
    consent: "أوافق",
    sign: "توقيع المستند",
    decline: "رفض التوقيع",
    declineReason: "السبب",
    declineConfirm: "تأكيد الرفض",
    cancel: "إلغاء",
    disclaimer:
      "توقيع إلكتروني مع سجل إثبات: يُسجَّل اسمك كما وقّعته ووقت الخادم وعنوان شبكتك وبصمة محتوى المستند. لا تُطبَّق شهادة رقمية ولا ختم زمني معتمد.",
  },
} as const;

export default async function SignPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string; outcome?: string; error?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { token } = await params;
  const sp = await searchParams;
  const lang: "en" | "ar" = sp.lang === "ar" ? "ar" : "en";
  const c = COPY[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const gate = await rateLimit("share", ip);
  const shell = (title: string, body: React.ReactNode) => (
    <html lang={lang} dir={dir}>
      <body
        style={{
          margin: 0,
          background: "#f6f5f1",
          color: "#1c2321",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 64px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: "8px 0" }}>{title}</h1>
            <a href={`?lang=${lang === "ar" ? "en" : "ar"}`} style={{ fontSize: 14 }}>
              {c.other}
            </a>
          </div>
          {body}
        </main>
      </body>
    </html>
  );

  if (!gate.allowed) return shell(c.unavailable, <p>{c.unavailableHint}</p>);

  // Outcome pages after an action (the token may now be dead; that is expected).
  if (sp.outcome === "signed" || sp.outcome === "completed") {
    return shell(
      sp.outcome === "completed" ? c.completedTitle : c.signedTitle,
      <p style={{ fontSize: 14, color: "#5b6660" }}>{c.disclaimer}</p>,
    );
  }
  if (sp.outcome === "declined") return shell(c.declinedTitle, null);

  const resolved = await resolveSignerToken(token);
  if (!resolved) return shell(c.unavailable, <p>{c.unavailableHint}</p>);
  await markInvitationViewed(resolved, { ip: ip || null, userAgent: h.get("user-agent") });

  const ctx = signerCtx(resolved);
  const html = await withCtx(ctx, async (tx) => {
    const d = await loadDocIn(tx, ctx, resolved.documentId);
    const snap = await loadSnapshotIn(tx, ctx, d.id);
    if (!snap) return null;
    const s = snap.snapshot;
    const signatures = await signaturesForRenderIn(tx, ctx, d.id, lang);
    return renderDocumentHtml(
      {
        language: d.language as "en" | "ar" | "bilingual",
        body: s.body,
        settings: s.settings,
        values: s.values,
        issuer: shellIssuerFromSnapshot(s.issuer, null),
        reference: d.reference,
        title: d.title,
        dateText: formatDate(s.issuedAt, { locale: lang }),
        statusText: lang === "ar" ? "بانتظار التوقيع" : "Awaiting signature",
        revisionText: `${snap.contentHash.slice(0, 12)}`,
        accentColor: s.branding.accentColor,
        signatures: signatures.rows,
        evidence: { contentHash: snap.contentHash, lines: signatures.evidenceLines },
      },
      { delivery: "url" },
    );
  });
  if (!html) return shell(c.unavailable, <p>{c.unavailableHint}</p>);

  const sign = signAction.bind(null, token, lang);
  const decline = declineAction.bind(null, token, lang);
  return shell(
    c.title,
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr", alignItems: "start" }}>
      <p style={{ fontSize: 14, margin: 0 }}>
        {c.party} <strong>{resolved.party}</strong> · {resolved.name}
        {" · "}
        {c.expires} {formatDate(resolved.requestExpiresAt, { locale: lang })}
      </p>
      {sp.error ? (
        <p
          style={{
            background: "#fde8e6",
            color: "#8a1c14",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 14,
          }}
        >
          {sp.error}
        </p>
      ) : null}
      <ShadowHtml html={html} />
      <section
        style={{ background: "#fff", border: "1px solid #d9d6cc", borderRadius: 8, padding: 16 }}
      >
        <SignForm
          action={sign}
          declineAction={decline}
          defaultName={resolved.name}
          consentText={CONSENT_TEXT[lang]}
          dir={dir}
          dict={{
            name: c.name,
            title: c.signTitle,
            typed: c.typed,
            drawn: c.drawn,
            typedHint: c.typedHint,
            drawHint: c.drawHint,
            clear: c.clear,
            consent: c.consent,
            sign: c.sign,
            decline: c.decline,
            declineReason: c.declineReason,
            declineConfirm: c.declineConfirm,
            cancel: c.cancel,
          }}
        />
        <p style={{ fontSize: 12, color: "#5b6660", marginTop: 12 }}>{c.disclaimer}</p>
      </section>
    </div>,
  );
}
