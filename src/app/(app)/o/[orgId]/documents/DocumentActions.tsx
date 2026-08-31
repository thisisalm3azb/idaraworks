/**
 * The document actions a record's detail page offers (H22.0).
 *
 * Every control here works. Preview opens the rendered document, Print opens it
 * and asks the browser to print, and Download PDF returns a real file. Sharing
 * is a separate panel (ShareSection) because it needs permission the other three
 * do not, and because it has state of its own to show.
 *
 * Preview, Print and the Arabic view are plain links rather than scripted
 * buttons, so they work with middle-click, with the keyboard, and when opened
 * into a new tab. Print adds one query parameter that the document reads to call
 * print() once its fonts have loaded.
 */
import Link from "next/link";
import { getT } from "@/platform/i18n/server";
import type { DocumentKind } from "@/modules/documents/service";

const LINK =
  "inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-3 text-sm font-medium text-ink hover:bg-sunken";

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
  const base = `/api/o/${orgId}/documents/${kind}/${id}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={base} target="_blank" rel="noopener" className={LINK}>
        {t("documents.preview")}
      </Link>
      <Link href={`${base}?print=1`} target="_blank" rel="noopener" className={LINK}>
        {t("documents.print")}
      </Link>
      <Link href={`${base}?format=pdf`} className={LINK}>
        {t("documents.download_pdf")}
      </Link>
      <Link
        href={`${base}?lang=ar`}
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-ink-secondary hover:bg-sunken"
        lang="ar"
      >
        العربية
      </Link>
    </div>
  );
}
