/**
 * H31 — the pre-authentication reads: manifest identity and host resolution.
 *
 * Both happen before a session exists, so neither can use `withCtx`. Both go
 * through a `security definer` function that returns a deliberately narrow
 * result (migration 0135), which is the same shape the document-share route
 * uses: one audited door rather than a general-purpose privileged connection.
 *
 * Nothing here authorises anything. `publicAppIdentity` returns what a login
 * page already shows; `resolveHostToOrg` returns a candidate organisation that
 * the caller must then prove membership of.
 */
import { sql } from "@/platform/tenancy";
import { decideBackgroundColor, decideBrandColor } from "@/platform/tenanthost/contrast";
import { truncateGraphemes } from "@/platform/tenanthost/text";

export type PublicAppIdentity = {
  orgId: string;
  name: string;
  shortName: string;
  description: string | null;
  brandColor: string;
  backgroundColor: string;
  locale: "en" | "ar" | "es";
  dir: "ltr" | "rtl";
  hasCustomIcon: boolean;
  /** Manifest shortcuts, as paths relative to the organisation's scope. */
  shortcuts: Array<{ name: string; shortName: string; path: string }>;
};

type Row = {
  org_name: string | null;
  display_name: string | null;
  app_name: string | null;
  app_short_name: string | null;
  app_description: string | null;
  brand_color: string | null;
  accent_color: string | null;
  background_color: string | null;
  default_locale: string | null;
  first_language: string | null;
  has_icon: boolean | null;
};

/** Shortcut destinations, chosen because every role can reach them. */
const SHORTCUT_PATHS = [
  { key: "today", path: "" },
  { key: "inbox", path: "/inbox" },
] as const;

const SHORTCUT_LABELS: Record<string, Record<string, string>> = {
  en: { today: "Today", inbox: "Inbox" },
  ar: { today: "اليوم", inbox: "الوارد" },
  es: { today: "Hoy", inbox: "Bandeja" },
};

export async function publicAppIdentity(orgId: string): Promise<PublicAppIdentity | null> {
  const { createAppDb } = await import("@/platform/tenancy");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select * from app.public_app_identity(${orgId}::uuid)
    `)) as unknown as Row[];
    const row = rows[0];
    if (!row || !row.org_name) return null;

    const displayName = row.display_name?.trim() || row.org_name;
    const name = row.app_name?.trim() || displayName;
    const shortName = truncateGraphemes(row.app_short_name?.trim() || name, 12);
    const locale =
      row.default_locale === "ar" || row.default_locale === "es"
        ? row.default_locale
        : row.first_language === "ar" || row.first_language === "es"
          ? row.first_language
          : "en";

    const labels = SHORTCUT_LABELS[locale] ?? SHORTCUT_LABELS.en!;
    return {
      orgId,
      name,
      shortName,
      description: row.app_description?.trim() || null,
      // The organisation's existing accent colour is honoured before the
      // platform default, so a company branded in H27 is already themed here.
      brandColor: decideBrandColor(row.brand_color ?? row.accent_color).value,
      backgroundColor: decideBackgroundColor(row.background_color).value,
      locale,
      dir: locale === "ar" ? "rtl" : "ltr",
      hasCustomIcon: row.has_icon === true,
      shortcuts: SHORTCUT_PATHS.map((s) => ({
        name: labels[s.key] ?? s.key,
        shortName: labels[s.key] ?? s.key,
        path: s.path,
      })),
    };
  } finally {
    await end();
  }
}

/**
 * Which organisation, if any, a hostname currently reaches.
 *
 * Only `active` rows resolve — a pending claim routes nothing. The return value
 * is a CANDIDATE: the caller must still establish that the signed-in user is a
 * member, which is what stops anyone from reaching another company's workspace
 * by typing its address.
 */
export async function resolveHostToOrg(
  host: string,
): Promise<{ orgId: string; kind: "subdomain" | "custom" } | null> {
  const { createAppDb } = await import("@/platform/tenancy");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select org_id::text as org_id, kind from app.resolve_tenant_host(${host})
    `)) as unknown as Array<{ org_id: string; kind: "subdomain" | "custom" }>;
    const row = rows[0];
    return row ? { orgId: row.org_id, kind: row.kind } : null;
  } finally {
    await end();
  }
}
