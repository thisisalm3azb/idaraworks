/**
 * Minimal t() shim (Phase C). Full next-intl + terminology resolution arrives
 * in Phase F (S0 checklist §2); call sites are written against this signature
 * NOW so Phase F swaps the implementation without touching them
 * (BUILD_BIBLE §9.11 — every user-facing string goes through t()).
 */
import en from "./messages/en.json";

type Messages = Record<string, string>;

const catalogs: Record<string, Messages> = { en: en as Messages };

export function t(key: string, vars?: Record<string, string | number>, locale = "en"): string {
  const template = catalogs[locale]?.[key] ?? catalogs.en?.[key];
  if (!template) {
    // Never render a raw key silently in prod paths — fall back loudly in dev.
    return `⟦${key}⟧`;
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
}
