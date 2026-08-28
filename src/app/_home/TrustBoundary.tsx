import Link from "next/link";
import { Icon } from "@/platform/ui";

/**
 * H8: the Trust Boundary (the "#trust" section body). One calm composition,
 * not security-card marketing: editorial copy plus a single workspace-boundary
 * visual, closing with real links to the privacy and terms pages.
 *
 * Every public statement is backed by verified implementation:
 *  - Boundary: org-scoped records behind Row Level Security (the app's
 *    database user cannot bypass it) and org-scoped storage with signed
 *    reads. Stated as: records kept inside the workspace boundary.
 *  - Permissions: the central role/permission matrix decides every surface
 *    and action. Stated as: roles decide what each person sees and does.
 *  - Redaction: cost and price figures are removed server-side for roles
 *    without the privilege, on screens and in CSV exports (F-23). Stated
 *    narrowly as: money figures follow permission rules.
 *  - History: configuration changes write full before/after revisions plus
 *    an audit summary, and supported changes can be undone. Stated as:
 *    recorded with history, can be undone.
 *  - Guardrail: configuration writes only governed artifact keys; it has no
 *    path to code, schema, permissions or security rules.
 *
 * No certification, uptime, encryption or breach-prevention claim is made,
 * and no internal identifier is exposed. The member chips and record bars are
 * abstract (no names, no data). Static server markup; the one directional
 * undo glyph flips under RTL.
 */

type TFn = (k: string) => string;

/** A run of "what this member can see" dots; masked ones read as withheld. */
function SurfaceDots({ masked }: { masked: number }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={
            "size-1.5 rounded-full " +
            (i < 4 - masked
              ? "bg-brand/70"
              : "border border-dashed border-line-strong bg-transparent")
          }
        />
      ))}
    </span>
  );
}

/** One proof row inside the boundary: icon, statement, small abstract visual. */
function ProofRow({
  icon,
  text,
  children,
  last,
}: {
  icon: "users" | "wallet" | "clock";
  text: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <li
      className={
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 " +
        (last ? "" : "border-b border-line/70")
      }
    >
      <span className="flex min-w-0 flex-1 items-start gap-2.5 text-[13px] leading-relaxed text-ink">
        <Icon name={icon} size={15} aria-hidden className="mt-0.5 shrink-0 text-brand" />
        {text}
      </span>
      <span className="shrink-0">{children}</span>
    </li>
  );
}

export function TrustBoundary({ t }: { t: TFn }) {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
      {/* ── Editorial copy + the real legal routes ───────────────────────── */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {t("home.trust.eyebrow")}
        </p>
        <h2 className="mt-2 text-balance text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-[2.1rem]">
          {t("home.trust.title")}
        </h2>
        <p className="mt-3 max-w-xl text-pretty text-base leading-relaxed text-ink-secondary">
          {t("home.trust.body")}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/privacy"
            className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
          >
            {t("home.trust.privacy")}
          </Link>
          <Link
            href="/terms"
            className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            {t("home.trust.terms")}
          </Link>
        </div>
      </div>

      {/* ── The workspace boundary: one contained, permissioned, recorded
             space. A boundary ring wraps the material panel. ──────────────── */}
      <div className="rounded-2xl border border-line-strong/60 p-2">
        <div
          className="relative overflow-hidden rounded-xl border px-4 py-4 sm:px-5"
          style={{
            borderColor: "color-mix(in srgb, var(--border-strong) 70%, transparent)",
            background:
              "linear-gradient(178deg, color-mix(in srgb, var(--surface-card) 72%, var(--warning-soft)) 0%, color-mix(in srgb, var(--surface-sunken) 78%, var(--warning-soft)) 100%)",
            boxShadow:
              "inset 0 1px 0 color-mix(in srgb, white 75%, transparent), 0 7px 0 -2px color-mix(in srgb, var(--border-strong) 85%, var(--warning-soft)), 0 18px 26px -20px rgb(28 28 26 / 0.28)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
              <Icon name="lock" size={15} aria-hidden className="text-brand" />
              {t("home.trust.boundary_title")}
            </h3>
            <span className="flex items-center gap-1.5" aria-hidden="true">
              {(["users", "briefcase", "clipboard", "receipt", "banknote"] as const).map((n) => (
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
              ))}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            {t("home.trust.boundary_note")}
          </p>

          <ul className="mt-2 flex flex-col">
            {/* Different people, different allowed surfaces. */}
            <ProofRow icon="users" text={t("home.trust.p1")}>
              <span className="flex flex-col gap-1.5" aria-hidden="true">
                <span className="flex items-center gap-2">
                  <span className="flex size-5 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Icon name="user" size={11} aria-hidden />
                  </span>
                  <SurfaceDots masked={0} />
                </span>
                <span className="flex items-center gap-2">
                  <span className="flex size-5 items-center justify-center rounded-full border border-line bg-page text-ink-secondary">
                    <Icon name="user" size={11} aria-hidden />
                  </span>
                  <SurfaceDots masked={2} />
                </span>
              </span>
            </ProofRow>

            {/* Money figures masked for roles without the privilege. */}
            <ProofRow icon="wallet" text={t("home.trust.p2")}>
              <span className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-1.5 w-10 rounded-full bg-line-strong/70" />
                <span className="rounded-md border border-dashed border-line-strong px-1.5 py-0.5 font-mono text-[9px] leading-none text-ink-muted">
                  •••
                </span>
              </span>
            </ProofRow>

            {/* Recorded, reversible configuration history. */}
            <ProofRow icon="clock" text={t("home.trust.p3")} last>
              <span className="flex items-center gap-1.5" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-3 w-1 rounded-full bg-brand/50" />
                ))}
                <svg
                  width="16"
                  height="12"
                  viewBox="0 0 16 12"
                  aria-hidden="true"
                  className="text-ink-secondary rtl:-scale-x-100"
                >
                  <path
                    d="M14 9c0-3-2.5-5-5.5-5H3M6 1 2.5 4 6 7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </ProofRow>
          </ul>

          {/* The guardrail: configuration stops at the security boundary. */}
          <p className="mt-1 flex items-start gap-2 rounded-md bg-sunken/80 p-2.5 text-xs leading-relaxed text-ink-secondary">
            <Icon name="lock" size={13} aria-hidden className="mt-0.5 shrink-0" />
            {t("home.trust.guard")}
          </p>
        </div>
      </div>
    </div>
  );
}
