/**
 * The document actions a record's detail page offers (H22.0).
 *
 * Every control here works. Preview opens the rendered document, Print opens it
 * and asks the browser to print, and Download PDF returns a real file. Sharing
 * is a separate panel (ShareSection) because it needs permission the other three
 * do not, and because it has state of its own to show.
 *
 * Preview, Print and the alternate language are plain links rather than scripted
 * buttons, so they work with middle-click, with the keyboard, and when opened
 * into a new tab. Print adds one query parameter that the document reads to call
 * print() once its fonts have loaded.
 *
 * ── H30 LB-6 ────────────────────────────────────────────────────────────────
 * None of these links used to carry a language, and the route defaults to
 * English. So an Arabic-speaking user reading an Arabic invoice pressed Download
 * PDF and received an English document — silently, with no indication that the
 * language had changed. Preview and Print behaved the same way, and only the
 * separate Arabic link produced Arabic, and only as HTML: there was no route to
 * an Arabic PDF at all from this component.
 *
 * Every link now carries the reader's own language, and the alternate offers the
 * other one by name. The alternate is derived rather than hard-coded to Arabic,
 * because a hard-coded "العربية" button is useless to a reader already in
 * Arabic — it silently reloads the same document.
 *
 * Documents render in English or Arabic only. A reader in any other product
 * language gets English, which the route decides; passing the locale through
 * keeps that decision in one place rather than making it here as well.
 */
import Link from "next/link";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import type { DocumentKind } from "@/modules/documents/service";

const LINK =
  "inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-3 text-sm font-medium text-ink hover:bg-sunken";

/** The languages a rendered document is actually produced in. */
type DocumentLanguage = "en" | "ar";

export async function DocumentActions({
  orgId,
  kind,
  id,
}: {
  orgId: string;
  kind: DocumentKind;
  id: string;
}) {
  const t = await getT();
  const locale = await getServerLocale();
  const language: DocumentLanguage = locale === "ar" ? "ar" : "en";
  const alternate: DocumentLanguage = language === "ar" ? "en" : "ar";

  const base = `/api/o/${orgId}/documents/${kind}/${id}`;
  const withLang = (extra?: string) => `${base}?lang=${language}${extra ? `&${extra}` : ""}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={withLang()} target="_blank" rel="noopener" className={LINK}>
        {t("documents.preview")}
      </Link>
      <Link href={withLang("print=1")} target="_blank" rel="noopener" className={LINK}>
        {t("documents.print")}
      </Link>
      <Link href={withLang("format=pdf")} className={LINK}>
        {t("documents.download_pdf")}
      </Link>
      <Link
        href={`${base}?lang=${alternate}`}
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-ink-secondary hover:bg-sunken"
        lang={alternate}
      >
        {LOCALE_NATIVE_NAME[alternate]}
      </Link>
    </div>
  );
}
