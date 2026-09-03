import "server-only";
/**
 * Server-side locale binding. Server components call `const t = await getT()`
 * to get a translator bound to the request's active locale (the `locale`
 * cookie), instead of threading the locale through every t() call. Keeps t()
 * itself pure + client-usable.
 */
import { cookies } from "next/headers";
import type { Locale } from "@/platform/registries";
import { t as baseT, type TVars } from "./t";
import { LOCALE_COOKIE } from "./locale";
import { resolveOfferedLocale } from "./offered";

/**
 * H29: resolves against the languages this deployment OFFERS, not merely the
 * ones it has a catalogue for. A stale cookie naming a withdrawn language falls
 * back to the default instead of rendering a language the deployment has
 * deliberately taken off the switcher.
 */
export async function getServerLocale(): Promise<Locale> {
  return resolveOfferedLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

export type Translator = (key: string, vars?: TVars) => string;

/** A translator bound to the request locale. */
export async function getT(): Promise<Translator> {
  const locale = await getServerLocale();
  return (key, vars) => baseT(key, vars, locale);
}
