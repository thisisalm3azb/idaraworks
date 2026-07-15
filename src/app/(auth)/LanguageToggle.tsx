import { Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { setActiveLocaleAction } from "./actions";

/**
 * Pre-org EN/العربية switcher (adversarial review): before U12 the bare
 * AppShell surfaces (login / signup / onboarding wizard) had NO way to change
 * language — the switcher only existed inside an org shell. Mounts in the
 * AppShell `actions` slot and posts the EXISTING setActiveLocaleAction
 * (cookie-only — the profile persistence path stays the account page's
 * changeLanguageAction). Server component, no client JS.
 */
export async function LanguageToggle() {
  const locale = await getServerLocale();
  const t = await getT();
  const otherLocale = locale === "ar" ? "en" : "ar";
  return (
    <form action={setActiveLocaleAction.bind(null, otherLocale)}>
      <button
        type="submit"
        className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
        aria-label={t("nav.switch_language")}
      >
        <Icon name="globe" size={18} aria-hidden />
        <span>{otherLocale === "ar" ? "العربية" : "English"}</span>
      </button>
    </form>
  );
}
