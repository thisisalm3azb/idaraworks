import { Icon, type IconName } from "@/platform/ui";

/**
 * H11/H13: the Business OS section (the "#product" body). One complete
 * operating system: seven business domains ported into a single connected
 * business record, with role-aware intelligence presented as a core layer of
 * the same system (H13 removed the roadmap-status labels per founder
 * direction; the engineering roadmap stays truthful in
 * docs/product/IDARAWORKS_BUSINESS_OS_NORTH_STAR.md).
 *
 * The intelligence layer keeps the product laws visible: recommendations are
 * grounded in records, and consequential actions wait for human approval.
 * Static server markup; ports mirror under RTL via logical offsets.
 */

type TFn = (k: string) => string;

/**
 * The switch that will later allow live agent wording such as "powered by
 * role-aware AI agents". It may become true ONLY when a real production
 * agent exists behind a tested backend capability (see
 * docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md §7); tests enforce that
 * such wording cannot render while this is false.
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
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-secondary">
        {t(`home.os.${d.key}.line`)}
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

      {/* ── The operating system: the domains around one record ───────────── */}
      <div className="mt-8 flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_232px_minmax(0,1fr)] lg:gap-x-14 lg:gap-y-5">
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

      {/* Documents, approvals and administration span the whole system. */}
      <div
        className="mt-2.5 rounded-xl border border-line bg-card p-4 lg:mt-5"
        style={{
          boxShadow:
            "0 3px 0 color-mix(in srgb, var(--border-strong) 70%, var(--warning-soft)), var(--elevation-1)",
        }}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
            <Icon name="clipboard" size={16} aria-hidden />
          </span>
          <h3 className="text-base font-semibold text-ink">{t("home.os.admin.title")}</h3>
          <p className="w-full text-[13px] leading-relaxed text-ink-secondary sm:ms-auto sm:w-auto">
            {t("home.os.admin.line")}
          </p>
        </div>
      </div>

      {/* Role-aware intelligence: a core layer of the same system. */}
      <div
        className="mt-2.5 rounded-xl border px-4 py-4 lg:mt-5"
        style={{
          borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border-strong))",
          background: "color-mix(in srgb, var(--accent) 4%, var(--surface-card))",
          boxShadow: "var(--elevation-1)",
        }}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand text-ink-inverse">
            <Icon name="grid" size={15} aria-hidden />
          </span>
          <h3 className="text-base font-semibold text-ink">{t("home.os.intel_title")}</h3>
          <p className="w-full text-[13px] leading-relaxed text-ink-secondary sm:ms-auto sm:w-auto">
            {t("home.os.intel_line")}
          </p>
        </div>
      </div>
    </div>
  );
}
