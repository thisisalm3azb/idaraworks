import { Icon, type IconName } from "@/platform/ui";

/**
 * H6: the Operating Capability Map (the "#product" Capabilities section body).
 * Replaces the four-equal-card grid with one connected architecture: a stable
 * central foundation (the connected work record) with four capability layers
 * ported into it, an availability statement, and a closing line.
 *
 * Every displayed capability is backed by a usable workspace surface, audited
 * against the real navigation IA (src/platform/ui/nav/build.ts), routes and
 * services:
 *  - Commercial: customers, quotes, invoices, payments, outstanding balances
 *    (receivables view), branded printable documents (quote, tax invoice,
 *    purchase order templates with org identity).
 *  - Delivery: work with stages, daily reports + review, issues, approvals,
 *    weekly view, customer updates.
 *  - Supply and cost: items/materials, material requests, purchase orders,
 *    suppliers, attendance, expenses, per-work costing.
 *  - Visibility and control: owner overview (Today), CSV record exports
 *    (settings/export), data import, members and permissions, configuration
 *    history with undo.
 *
 * Availability truth: everything listed ships today; visibility follows role
 * permissions and some capabilities follow the plan (entitlement features) —
 * stated in plain text under the map. No planned module appears.
 *
 * Static server markup, no fake controls, no animation. The map mirrors under
 * RTL through the grid's logical column order and logical connector offsets
 * (the port stubs use inline start/end, so they keep pointing at the core).
 */

type TFn = (k: string) => string;

type Layer = {
  key: string;
  icon: IconName;
  items: string[]; // i18n key suffixes under home.caps.
  side: "start" | "end"; // which inline side of the core the layer sits on
};

const LAYERS: Layer[] = [
  {
    key: "commercial",
    icon: "banknote",
    side: "start",
    items: ["customers", "quotes", "invoices", "payments", "outstanding", "docs"],
  },
  {
    key: "delivery",
    icon: "briefcase",
    side: "end",
    items: ["work", "reports", "review", "issues", "approvals", "weekly", "updates"],
  },
  {
    key: "supply",
    icon: "truck",
    side: "start",
    items: ["items", "mr", "po", "suppliers", "attendance", "expenses", "costing"],
  },
  {
    key: "visibility",
    icon: "chart",
    side: "end",
    items: ["overview", "exports", "import", "members", "config"],
  },
];

/** The port: a short connector from a layer's center-facing edge to the core. */
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

function LayerPanel({ t, layer }: { t: TFn; layer: Layer }) {
  return (
    <div
      className="relative rounded-xl border border-line bg-card p-4"
      style={{
        boxShadow:
          "0 3px 0 color-mix(in srgb, var(--border-strong) 70%, var(--warning-soft)), var(--elevation-1)",
      }}
    >
      <Port side={layer.side} />
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
          <Icon name={layer.icon} size={16} aria-hidden />
        </span>
        <h3 className="text-base font-semibold text-ink">{t(`home.caps.${layer.key}.title`)}</h3>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
        {t(`home.caps.${layer.key}.desc`)}
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3">
        {layer.items.map((i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-xs font-medium leading-relaxed text-ink"
          >
            <span
              aria-hidden="true"
              className="mt-1.5 size-1 shrink-0 rounded-full"
              style={{ background: "color-mix(in srgb, var(--accent) 55%, var(--border-strong))" }}
            />
            {t(`home.caps.${layer.key}.${i}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CapabilityMap({ t }: { t: TFn }) {
  return (
    <div className="mx-auto mt-10 max-w-5xl">
      {/* The map: four capability layers ported into one central foundation. */}
      <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_232px_minmax(0,1fr)] lg:gap-x-14 lg:gap-y-6">
        {/* The connected foundation: mobile first in the stack, desktop center. */}
        <div
          className="relative overflow-hidden rounded-xl border px-4 py-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:flex lg:flex-col lg:justify-center lg:px-5"
          style={{
            borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
            background:
              "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
            boxShadow:
              "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
          }}
        >
          {/* Gentle material variation, echoing the hero surface. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden lg:block"
            style={{
              background:
                "repeating-linear-gradient(180deg, transparent 0 26px, rgb(28 28 26 / 0.03) 26px 27px)",
            }}
          />
          <span className="relative flex items-center gap-1.5" aria-hidden="true">
            {(["users", "briefcase", "clipboard", "receipt", "banknote"] as IconName[]).map((n) => (
              <span
                key={n}
                className="flex size-6 items-center justify-center rounded-full text-ink-secondary"
                style={{
                  background: "color-mix(in srgb, var(--surface-sunken) 88%, var(--warning-soft))",
                  boxShadow:
                    "inset 0 1.5px 3px rgb(28 28 26 / 0.12), inset 0 -1px 0 color-mix(in srgb, white 70%, transparent)",
                }}
              >
                <Icon name={n} size={12} aria-hidden />
              </span>
            ))}
          </span>
          <h3 className="mt-2.5 text-base font-semibold leading-snug text-ink">
            {t("home.caps.core_title")}
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
            {t("home.caps.core_note")}
          </p>
        </div>

        {LAYERS.map((layer, i) => (
          <div
            key={layer.key}
            className={
              "contents lg:block " +
              (layer.side === "start" ? "lg:col-start-1" : "lg:col-start-3") +
              (i < 2 ? " lg:row-start-1" : " lg:row-start-2")
            }
          >
            <VPort />
            <LayerPanel t={t} layer={layer} />
          </div>
        ))}
      </div>

      {/* Availability, stated in text; then breadth resolved into flexibility. */}
      <p className="mx-auto mt-8 flex w-fit items-start gap-2 rounded-full border border-line bg-page px-4 py-2 text-center text-sm text-ink-secondary">
        <Icon name="check" size={15} aria-hidden className="mt-0.5 shrink-0 text-brand" />
        {t("home.caps.avail")}
      </p>
      <p className="mx-auto mt-5 max-w-xl text-balance text-center text-lg font-medium leading-relaxed text-ink">
        {t("home.caps.close")}
      </p>
    </div>
  );
}
