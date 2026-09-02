import { redirect } from "next/navigation";
import { resolveCtx } from "@/platform/auth/resolve";
import { can, type Action } from "@/platform/authz";
import { getT, getServerLocale, type Translator } from "@/platform/i18n/server";
import type { RevenueTabKey } from "./RevenueTabs";

/** Resolve the acting person for a Revenue Studio page; a missing lane goes home. */
export async function resolveRevenue(orgId: string, action: Action) {
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, action)) redirect(`/o/${orgId}`);
  const t = await getT();
  const locale = await getServerLocale();
  return { resolved, t, locale };
}

export type LocaleText = { en?: string; ar?: string } | null | undefined;

export function localeText(v: LocaleText, locale: string, fallback = ""): string {
  const s = locale === "ar" ? v?.ar || v?.en : v?.en || v?.ar;
  return s || fallback;
}

/** Page offset from a `?page=` search param (1-based in the URL). */
export function pageOffset(
  page: string | undefined,
  limit: number,
): { page: number; offset: number } {
  const p = Math.max(1, Number(page) || 1);
  return { page: p, offset: (p - 1) * limit };
}

/** Rebuild a query string, replacing one key (dropping it when the value is empty). */
export function withParam(
  base: Record<string, string | undefined>,
  key: string,
  value: string | number | undefined,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v && k !== key) q.set(k, v);
  if (value !== undefined && value !== "" && value !== 0) q.set(key, String(value));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Honest section loading: a failed section is reported, never rendered as empty. */
export async function section<T>(
  load: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    return { ok: true, data: await load() };
  } catch {
    return { ok: false };
  }
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Math.round(n)}%`;
}

export type T = Translator;

export function tabLabels(t: T): Record<RevenueTabKey, string> {
  return {
    hub: t("revenue.tab.hub"),
    pipeline: t("revenue.tab.pipeline"),
    leads: t("revenue.tab.leads"),
    forecast: t("revenue.tab.forecast"),
    campaigns: t("revenue.tab.campaigns"),
    targets: t("revenue.tab.targets"),
    success: t("revenue.tab.success"),
    automations: t("revenue.tab.automations"),
    reports: t("revenue.tab.reports"),
    settings: t("revenue.tab.settings"),
  };
}
