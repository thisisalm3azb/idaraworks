import Link from "next/link";
import { Icon } from "@/platform/ui";
import { getServerLocale } from "@/platform/i18n/server";
import { formatDate } from "@/platform/format";
import { legalDoc, LEGAL_EFFECTIVE_DATE, type LegalDoc } from "./content";

/**
 * Shared renderer for the public legal pages (005B). Server-rendered, bilingual
 * (locale-driven via the root layout's lang/dir), readable long-form prose. A
 * minimal header links back to the homepage; the effective/updated date is
 * shown. Uses the homepage design tokens.
 */
export async function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const locale = await getServerLocale();
  const doc: LegalDoc = legalDoc(kind, locale === "ar" ? "ar" : "en");
  const updated = formatDate(`${LEGAL_EFFECTIVE_DATE}T00:00:00Z`, { locale });

  return (
    <div className="flex min-h-dvh flex-col bg-page text-ink">
      <header className="border-b border-line bg-page">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center justify-between gap-4 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
            <span
              aria-hidden
              className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse"
            >
              <Icon name="grid" size={16} />
            </span>
            <span>IdaraWorks</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">{doc.title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {doc.updatedLabel}: <span dir="ltr">{updated}</span>
        </p>
        <p className="mt-5 text-pretty leading-relaxed text-ink-secondary">{doc.intro}</p>

        <div className="mt-8 flex flex-col gap-8">
          {doc.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-lg font-semibold text-ink">{s.heading}</h2>
              <div className="mt-2 flex flex-col gap-3">
                {s.paragraphs.map((p, i) => (
                  <p key={i} className="text-pretty leading-relaxed text-ink-secondary">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-10 border-t border-line pt-6">
          <Link href="/" className="text-sm font-medium text-brand hover:underline">
            ← IdaraWorks
          </Link>
        </div>
      </main>
    </div>
  );
}
