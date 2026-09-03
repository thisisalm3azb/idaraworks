import { Icon } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { offeredLocales } from "@/platform/i18n/offered";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import { setActiveLocaleAction } from "./actions";

/**
 * Pre-org language switcher (adversarial review): before U12 the bare AppShell
 * surfaces (login / signup / onboarding wizard) had NO way to change language —
 * the switcher only existed inside an org shell. Mounts in the AppShell
 * `actions` slot and posts the EXISTING setActiveLocaleAction (cookie-only —
 * the profile persistence path stays the account page's changeLanguageAction).
 * Server component, no client JS.
 *
 * H29 turned this from a two-way toggle into a list, because a toggle stops
 * being meaningful the moment a third language exists: with EN/AR/ES a single
 * button cannot say where it takes you. Each language is named in itself, and
 * only the languages this deployment offers appear.
 */
export async function LanguageToggle() {
  const locale = await getServerLocale();
  const t = await getT();
  const others = offeredLocales().filter((candidate) => candidate !== locale);
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={t("nav.switch_language")}>
      <Icon name="globe" size={18} aria-hidden className="text-ink-secondary" />
      {others.map((candidate) => (
        <form key={candidate} action={setActiveLocaleAction.bind(null, candidate)}>
          <button
            type="submit"
            lang={candidate}
            className="flex min-h-11 items-center rounded-md px-2 text-sm text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            {LOCALE_NATIVE_NAME[candidate]}
          </button>
        </form>
      ))}
    </div>
  );
}
