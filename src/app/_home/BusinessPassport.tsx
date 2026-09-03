import { Icon } from "@/platform/ui";
import type { Locale } from "@/platform/registries";

/**
 * H7: the Business Passport (the "#international" section body). Replaces the
 * four-card grid with one demonstration: a single business identity shaping
 * two genuinely mirrored outputs, plus a market-readiness ledger.
 *
 * Grounded in the audited implementation:
 *  - Identity: the issuer identity that document rendering actually consumes
 *    (legal name, trading name, address in both languages, tax registration,
 *    logo, currency, terminology) lives in workspace settings
 *    (src/platform/documents/issuer.ts, branding + company settings).
 *  - Language: English and Arabic ship across every screen with complete RTL;
 *    the locale persists via cookie. Only shipped languages are shown (H13
 *    removed the customer-facing roadmap-status labels).
 *  - Documents: quote, tax invoice and purchase order print templates carry
 *    the identity, and each document can be issued in English, Arabic or
 *    bilingual (DOC_LANGUAGES).
 *  - Currency: a workspace base currency, and each quote and invoice carries
 *    its own currency and rate (no FX conversion is claimed).
 *
 * The mirrored pair is the RTL proof: the SAME markup rendered twice, once
 * with lang="en" dir="ltr" and once with lang="ar" dir="rtl", so the logo
 * slot, status chip, alignment and total row flip through real logical
 * layout, not manual reversal. Field values everywhere are abstract bars,
 * never invented business data. Static server markup, no fake controls.
 */

type TFn = (k: string) => string;

/** An abstract value bar: shows where real data lives without inventing any. */
function Bar({ w }: { w: string }) {
  return <span className={`block h-1.5 rounded-full bg-line-strong/70 ${w}`} aria-hidden="true" />;
}

/** The port connecting an output surface back to the identity passport. */
function Port() {
  return (
    <span
      aria-hidden="true"
      className="absolute -start-12 top-1/2 hidden -translate-y-1/2 flex-row-reverse items-center lg:flex"
    >
      <span
        className="h-0.5 w-10 rounded-full"
        style={{ background: "color-mix(in srgb, var(--accent) 45%, var(--border-strong))" }}
      />
      <span
        className="size-1.5 rounded-full"
        style={{ background: "color-mix(in srgb, var(--accent) 70%, var(--border-strong))" }}
      />
    </span>
  );
}

/** A short vertical connector for the mobile stack. */
function VPort() {
  return (
    <span className="flex justify-center lg:hidden" aria-hidden="true">
      <span
        className="h-5 w-[3px] rounded-full"
        style={{
          background: "color-mix(in srgb, var(--accent) 40%, var(--surface-sunken))",
          boxShadow: "inset 0 1px 2px rgb(28 28 26 / 0.25)",
        }}
      />
    </span>
  );
}

/** One mirrored output: the same document structure in a given language and
 * direction. The labels are fixed in the surface's own language (they are the
 * proof), and the layout mirrors purely through dir + logical properties. */
function MiniDoc({ lang }: { lang: Locale }) {
  const L =
    lang === "en"
      ? { tag: "English", dir: "Left to right", doc: "Quote", status: "Accepted", total: "Total" }
      : {
          tag: "العربية",
          dir: "من اليمين إلى اليسار",
          doc: "عرض سعر",
          status: "مقبول",
          total: "الإجمالي",
        };
  return (
    <div className="relative">
      {/* The port stays in page direction so it always faces the passport. */}
      <Port />
      <div lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
        <p className="flex items-center gap-2 text-xs font-semibold text-ink">
          {L.tag}
          <span className="font-normal text-ink-muted">{L.dir}</span>
        </p>
        <div
          className="mt-2 rounded-xl border border-line bg-card p-3.5"
          style={{
            boxShadow:
              "0 3px 0 color-mix(in srgb, var(--border-strong) 70%, var(--warning-soft)), var(--elevation-1)",
          }}
        >
          {/* Document header: logo at the reading start, identity at the end. */}
          <div className="flex items-start justify-between gap-3">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-muted"
              aria-hidden="true"
            >
              <Icon name="grid" size={13} aria-hidden />
            </span>
            <span className="flex flex-col items-end gap-1.5" aria-hidden="true">
              <Bar w="w-24" />
              <Bar w="w-16" />
              <Bar w="w-20" />
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
            <span className="text-sm font-semibold text-ink">{L.doc}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
              <Icon name="check" size={10} aria-hidden />
              {L.status}
            </span>
          </div>
          <div className="mt-2.5 flex flex-col gap-1.5" aria-hidden="true">
            <Bar w="w-full" />
            <Bar w="w-3/4" />
            <Bar w="w-5/6" />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
            <span className="text-xs font-medium text-ink-secondary">{L.total}</span>
            <Bar w="w-14" />
          </div>
        </div>
      </div>
    </div>
  );
}

const FIELDS: { key: string; bar: string }[] = [
  { key: "f_legal", bar: "w-28" },
  { key: "f_trade", bar: "w-20" },
  { key: "f_address", bar: "w-24" },
  { key: "f_tax", bar: "w-16" },
  { key: "f_currency", bar: "w-10" },
  { key: "f_terms", bar: "w-20" },
];

export function BusinessPassport({ t }: { t: TFn }) {
  return (
    <div className="mx-auto mt-10 max-w-5xl">
      <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-x-14 lg:gap-y-5">
        {/* The passport: one identity, recorded once in workspace settings. */}
        <div
          className="relative overflow-hidden rounded-xl border px-4 py-4 lg:row-span-2 lg:px-5"
          style={{
            borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
            background:
              "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
            boxShadow:
              "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">{t("home.gcc.passport_title")}</h3>
            {/* The logo slot: a place for identity, never an invented mark. */}
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary"
              aria-hidden="true"
              style={{
                background: "color-mix(in srgb, var(--surface-sunken) 88%, var(--warning-soft))",
                boxShadow:
                  "inset 0 1.5px 3px rgb(28 28 26 / 0.12), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)",
              }}
            >
              <Icon name="building" size={14} aria-hidden />
            </span>
          </div>
          <ul className="mt-3 flex flex-col">
            {FIELDS.map(({ key, bar }, i) => (
              <li
                key={key}
                className={
                  "flex items-center justify-between gap-3 py-2 " +
                  (i > 0 ? "border-t border-line/70" : "")
                }
              >
                <span className="text-xs font-medium text-ink-secondary">
                  {t(`home.gcc.${key}`)}
                </span>
                <Bar w={bar} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
            {t("home.gcc.passport_note")}
          </p>
        </div>

        {/* The mirrored outputs: the same identity, both directions. */}
        <VPort />
        <MiniDoc lang="en" />
        <VPort />
        <MiniDoc lang="ar" />
      </div>

      <p className="mx-auto mt-5 w-fit text-center text-sm text-ink-secondary">
        {t("home.gcc.docnote")}
      </p>

      {/* Market readiness (H13: one confident ledger). */}
      <div className="mt-6 rounded-lg border border-line bg-card p-4 shadow-card">
        <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {(["n1", "n2", "n3", "n4", "n5"] as const).map((k) => (
            <li key={k} className="flex items-start gap-1.5 text-sm text-ink">
              <Icon name="check" size={13} aria-hidden className="mt-1 shrink-0 text-brand" />
              {t(`home.gcc.${k}`)}
            </li>
          ))}
        </ul>
      </div>

      <p className="mx-auto mt-8 max-w-xl text-balance text-center text-lg font-medium leading-relaxed text-ink">
        {t("home.gcc.close")}
      </p>
    </div>
  );
}
