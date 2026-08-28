import { Icon, type IconName } from "@/platform/ui";

/**
 * H11: the Business OS section (the "#product" body). Establishes the
 * north-star positioning — one business, one system, built by managers for
 * managers — as one coherent operating-system visual: six business domains
 * ported into a single connected business record, each domain stating what
 * ships today (check) and where IdaraWorks is expanding (open marker), plus
 * a clearly PLANNED role-aware intelligence band.
 *
 * Truth rules (tested):
 *  - every "now" line is backed by shipped workspace surfaces (the same
 *    audited inventory as the H6 map: nav IA, routes, services);
 *  - every expansion line is future-facing wording from the north-star
 *    document, visually and semantically distinct (legend + open marker);
 *  - the agents band renders PLANNED wording only: no production AI exists
 *    (verified: no AI SDK in the codebase; provider seams are unimplemented),
 *    so AI_AGENTS_PRODUCTION_READY stays false and tests forbid "Powered by
 *    AI" style claims while it is false.
 *
 * Static server markup in the homepage's material language; ports mirror
 * under RTL via logical offsets; no fake controls; no motion.
 */

type TFn = (k: string) => string;

/**
 * The single switch that will later allow live agent wording. It may become
 * true ONLY when a real production agent exists behind a tested backend
 * capability (see docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md §7);
 * tests enforce that public "powered by AI" wording cannot render while this
 * is false, and that flipping it requires a real entitlement capability key.
 */
export const AI_AGENTS_PRODUCTION_READY = false as const;

type Domain = {
  key: string;
  icon: IconName;
  side: "start" | "end";
  row: 1 | 2 | 3;
};

const DOMAINS: Domain[] = [
  { key: "customers", icon: "users", side: "start", row: 1 },
  { key: "work", icon: "briefcase", side: "end", row: 1 },
  { key: "people", icon: "user", side: "start", row: 2 },
  { key: "supply", icon: "truck", side: "end", row: 2 },
  { key: "money", icon: "banknote", side: "start", row: 3 },
  { key: "planning", icon: "chart", side: "end", row: 3 },
];

/** Port from a domain plate toward the central record (mirrors under RTL). */
function Port({ side }: { side: "start" | "end" }) {
  return (
    <span
      aria-hidden="true"
      className={
        "absolute top-1/2 hidden -translate-y-1/2 items-center lg:flex " +
        (side === "start" ? "-end-12 flex-row" : "-start-12 flex-row-reverse")
      }
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

/** The open "expanding" marker: clearly not the shipped check. */
function OpenDot() {
  return (
    <span
      aria-hidden="true"
      className="mt-1 size-3 shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong"
    />
  );
}

function DomainPlate({ t, d }: { t: TFn; d: Domain }) {
  return (
    <div
      className="relative rounded-xl border border-line bg-card p-4"
      style={{
        boxShadow:
          "0 3px 0 color-mix(in srgb, var(--border-strong) 70%, var(--warning-soft)), var(--elevation-1)",
      }}
    >
      <Port side={d.side} />
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
          <Icon name={d.icon} size={16} aria-hidden />
        </span>
        <h3 className="text-base font-semibold text-ink">{t(`home.os.${d.key}.title`)}</h3>
      </div>
      <p className="mt-2.5 flex items-start gap-2 text-[13px] leading-relaxed text-ink">
        <Icon name="check" size={14} aria-hidden className="mt-0.5 shrink-0 text-brand" />
        {t(`home.os.${d.key}.now`)}
      </p>
      <p className="mt-1.5 flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted">
        <OpenDot />
        {t(`home.os.${d.key}.next`)}
      </p>
    </div>
  );
}

export function BusinessOS({ t }: { t: TFn }) {
  return (
    <div className="mx-auto mt-8 max-w-5xl">
      <p className="mx-auto max-w-2xl text-center text-base leading-relaxed text-ink-secondary">
        {t("home.os.support")}
      </p>

      {/* ── The operating system: six domains, one record ─────────────────── */}
      <div className="mt-8 flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_232px_minmax(0,1fr)] lg:gap-x-14 lg:gap-y-5">
        {/* The record: mobile first in the stack, desktop center column. */}
        <div
          className="relative overflow-hidden rounded-xl border px-4 py-4 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:flex lg:flex-col lg:justify-center lg:px-5"
          style={{
            borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
            background:
              "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
            boxShadow:
              "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden lg:block"
            style={{
              background:
                "repeating-linear-gradient(180deg, transparent 0 26px, rgb(28 28 26 / 0.03) 26px 27px)",
            }}
          />
          <span className="relative flex items-center gap-1.5" aria-hidden="true">
            {(["users", "briefcase", "user", "truck", "banknote", "chart"] as IconName[]).map(
              (n) => (
                <span
                  key={n}
                  className="flex size-6 items-center justify-center rounded-full text-ink-secondary"
                  style={{
                    background:
                      "color-mix(in srgb, var(--surface-sunken) 88%, var(--warning-soft))",
                    boxShadow:
                      "inset 0 1.5px 3px rgb(28 28 26 / 0.12), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)",
                  }}
                >
                  <Icon name={n} size={12} aria-hidden />
                </span>
              ),
            )}
          </span>
          <h3 className="relative mt-2.5 text-base font-semibold leading-snug text-ink">
            {t("home.os.record_title")}
          </h3>
          <p className="relative mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
            {t("home.os.record_note")}
          </p>
        </div>

        {DOMAINS.map((d) => (
          <div
            key={d.key}
            className={
              "contents lg:block " +
              (d.side === "start" ? "lg:col-start-1 " : "lg:col-start-3 ") +
              { 1: "lg:row-start-1", 2: "lg:row-start-2", 3: "lg:row-start-3" }[d.row]
            }
          >
            <DomainPlate t={t} d={d} />
          </div>
        ))}
      </div>

      {/* ── The status legend: shipped vs expanding, in text ──────────────── */}
      <div className="mx-auto mt-6 flex w-fit flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-medium text-ink">
          <Icon name="check" size={13} aria-hidden className="shrink-0 text-brand" />
          {t("home.os.legend_now")}
        </span>
        <span className="flex items-center gap-2 rounded-full border border-dashed border-line-strong bg-page px-3 py-1.5 text-xs font-medium text-ink-secondary">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong"
          />
          {t("home.os.legend_next")}
        </span>
      </div>

      {/* ── Role-aware intelligence: explicitly planned ───────────────────── */}
      <div className="mx-auto mt-8 max-w-3xl rounded-xl border border-dashed border-line-strong bg-page p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center rounded-full border border-line bg-card px-2.5 py-1 text-xs font-medium text-ink-secondary">
            {t("home.os.agents_label")}
          </span>
          <h3 className="text-base font-semibold text-ink">{t("home.os.agents_title")}</h3>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
          {t("home.os.agents_body")}
        </p>
        {/* The contract in miniature: the agent suggests, a person approves. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1.5">
            <Icon name="user" size={12} aria-hidden className="shrink-0 text-brand" />
            {t("home.os.agents_suggest")}
          </span>
          <svg
            width="14"
            height="10"
            viewBox="0 0 14 10"
            aria-hidden="true"
            className="shrink-0 text-ink-muted rtl:-scale-x-100"
          >
            <path
              d="M1 5h10.5M8 1.5 12 5l-4 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1.5">
            <Icon name="check" size={12} aria-hidden className="shrink-0 text-success" />
            {t("home.os.agents_approve")}
          </span>
        </div>
      </div>
    </div>
  );
}
