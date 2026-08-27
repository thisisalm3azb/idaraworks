import { Icon } from "@/platform/ui";
import { getServerLocale } from "@/platform/i18n/server";
import { setActiveLocaleAction } from "@/app/(auth)/actions";

/**
 * Public EN/العربية switch (005A). Posts the existing cookie-only
 * setActiveLocaleAction and re-renders the current ROUTE in the other
 * language — no client JS, so it works before hydration. The label always
 * shows the language you switch TO, in that language's own script (text, not
 * an icon alone), on a 44px target.
 *
 * Known limitation (H2, documented rather than worked around): the URL
 * fragment (#pricing etc.) never reaches the server, so a server-action
 * re-render cannot preserve the reader's SECTION — only the route. Restoring
 * the fragment would require client JS that this island deliberately avoids.
 * Spanish is planned and intentionally NOT offered here yet.
 */
export async function LanguageSwitch({ ariaLabel }: { ariaLabel: string }) {
  const locale = await getServerLocale();
  const other = locale === "ar" ? "en" : "ar";
  return (
    <form action={setActiveLocaleAction.bind(null, other)}>
      <button
        type="submit"
        aria-label={ariaLabel}
        className="flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-secondary hover:bg-sunken hover:text-ink"
      >
        <Icon name="globe" size={18} aria-hidden />
        <span>{other === "ar" ? "العربية" : "English"}</span>
      </button>
    </form>
  );
}
