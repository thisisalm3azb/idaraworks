import { Icon } from "@/platform/ui";
import { getServerLocale } from "@/platform/i18n/server";
import { setActiveLocaleAction } from "@/app/(auth)/actions";

/**
 * Public EN/العربية switch (005A). Posts the existing cookie-only
 * setActiveLocaleAction and re-renders the current route in the other
 * language — no client JS. The label always shows the language you switch TO,
 * in that language's own script.
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
