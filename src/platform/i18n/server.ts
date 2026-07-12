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
import { LOCALE_COOKIE, normalizeLocale } from "./locale";

export async function getServerLocale(): Promise<Locale> {
  return normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

export type Translator = (key: string, vars?: TVars) => string;

/** A translator bound to the request locale. */
export async function getT(): Promise<Translator> {
  const locale = await getServerLocale();
  return (key, vars) => baseT(key, vars, locale);
}
