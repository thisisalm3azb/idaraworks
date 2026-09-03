import { Icon } from "@/platform/ui";
import { getServerLocale } from "@/platform/i18n/server";
import { offeredLocales } from "@/platform/i18n/offered";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import { setActiveLocaleAction } from "@/app/(auth)/actions";

/**
 * Public language switch (005A). Posts the existing cookie-only
 * setActiveLocaleAction and re-renders the current ROUTE in the chosen
 * language — no client JS, so it works before hydration. Each label is the
 * language's own name in its own script (text, not an icon alone), on a 44px
 * target.
 *
 * Known limitation (H2, documented rather than worked around): the URL
 * fragment (#pricing etc.) never reaches the server, so a server-action
 * re-render cannot preserve the reader's SECTION — only the route. Restoring
 * the fragment would require client JS that this island deliberately avoids.
 *
 * H29 replaced the EN/AR toggle with a list of the languages this deployment
 * offers. Spanish appears here only once FEATURE_LOCALE_ES is set, which is the
 * same gate the rest of the product uses — the marketing site and the workspace
 * can never disagree about which languages exist.
 */
export async function LanguageSwitch({ ariaLabel }: { ariaLabel: string }) {
  const locale = await getServerLocale();
  const others = offeredLocales().filter((candidate) => candidate !== locale);
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={ariaLabel}>
      <Icon name="globe" size={18} aria-hidden className="text-ink-secondary" />
      {others.map((candidate) => (
        <form key={candidate} action={setActiveLocaleAction.bind(null, candidate)}>
          <button
            type="submit"
            lang={candidate}
            className="flex min-h-11 items-center rounded-md px-2.5 text-sm font-medium text-ink-secondary hover:bg-sunken hover:text-ink"
          >
            {LOCALE_NATIVE_NAME[candidate]}
          </button>
        </form>
      ))}
    </div>
  );
}
