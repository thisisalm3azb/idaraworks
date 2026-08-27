import Link from "next/link";
import { Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { directionFor } from "@/platform/i18n";
import { LanguageToggle } from "../../(auth)/LanguageToggle";

/**
 * Verification failure (005B.1) — a branded, recoverable state for an expired,
 * already-used, invalid or temporarily-failing verification link. Offers only
 * safe actions (request a new link by starting over, log in, get started); it
 * never reveals whether an unrelated email exists and never shows a token.
 */
const REASONS = new Set(["expired", "used", "invalid", "temporary"]);

export default async function VerifyErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason: raw } = await searchParams;
  const reason = raw && REASONS.has(raw) ? raw : "invalid";
  const t = await getT();
  const locale = await getServerLocale();
  const dir = directionFor(locale);
  // "used" (already verified) → the natural next step is signing in; the others
  // → start over. Both actions are always offered.
  const primary =
    reason === "used"
      ? { href: "/login", label: t("auth.verify.login") }
      : { href: "/signup", label: t("auth.verify.get_started") };
  const secondary =
    reason === "used"
      ? { href: "/signup", label: t("auth.verify.get_started") }
      : { href: "/login", label: t("auth.verify.login") };

  return (
    <div className="flex min-h-dvh flex-col bg-page text-ink" dir={dir}>
      <div className="flex min-h-14 items-center justify-between px-5 pt-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-md bg-brand text-ink-inverse"
          >
            <Icon name="grid" size={16} />
          </span>
          <span>IdaraWorks</span>
        </Link>
        <LanguageToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-5 py-8">
        <div className="w-full max-w-sm rounded-lg border border-line bg-card p-6 text-center shadow-card">
          <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-warning-soft text-warning">
            <Icon name="alert" size={22} aria-hidden />
          </span>
          <h1 className="mt-3 text-lg font-semibold text-ink">{t("auth.verify.title")}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
            {t(`auth.verify.${reason}`)}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link
              href={primary.href}
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-4 text-sm font-semibold text-ink-inverse hover:bg-brand-strong"
            >
              {primary.label}
            </Link>
            <Link
              href={secondary.href}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
            >
              {secondary.label}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
