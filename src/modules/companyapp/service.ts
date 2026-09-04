/**
 * H31 — the company app module's only public door.
 *
 * Reads and writes the installed-application identity and the host registry,
 * and builds the manifest a browser installs from. Everything outside this
 * module goes through here.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan, can } from "@/platform/authz";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";
import { isReservedSlug } from "@/platform/tenanthost/reserved";
import { normalizeSlug, TENANT_PARENT, classifyHost } from "@/platform/tenanthost/resolve";
import {
  decideBackgroundColor,
  decideBrandColor,
  type ColorDecision,
} from "@/platform/tenanthost/contrast";
import { truncateGraphemes } from "@/platform/tenanthost/text";

// The pre-authentication reads live in public.ts; the app layer reaches them
// through this barrel like everything else (BUILD_BIBLE 3.3).
export { publicAppIdentity, resolveHostToOrg, type PublicAppIdentity } from "./public";
export { truncateGraphemes };

export class CompanyAppError extends Error {
  constructor(
    message: string,
    /** A message key the UI renders. The English text is a developer aid only. */
    public readonly messageKey: string,
  ) {
    super(message);
    this.name = "CompanyAppError";
  }
}

export type AppIdentity = {
  orgId: string;
  /** Always present: falls back to the organisation's own name. */
  name: string;
  shortName: string;
  description: string | null;
  iconFileId: string | null;
  brand: ColorDecision;
  background: ColorDecision;
  locale: "en" | "ar" | "es";
  dir: "ltr" | "rtl";
  /** Warnings a settings screen should show, as message keys. Never prose. */
  warnings: string[];
};

/**
 * Read the installed-app identity for an organisation.
 *
 * Never throws for missing branding. An organisation that has configured
 * nothing gets a complete, valid identity built from its name and the platform
 * palette — which is the rule that stops an incomplete logo from making a
 * workspace unusable.
 */
export async function getAppIdentity(ctx: Ctx): Promise<AppIdentity> {
  const [row] = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select
          o.name as org_name,
          o.languages[1] as first_language,
          b.app_name, b.app_short_name, b.app_description,
          b.icon_file_id::text as icon_file_id,
          b.brand_color, b.background_color, b.default_locale,
          ob.accent_color, ob.display_name
        from public.org o
        left join public.org_app_brand b on b.org_id = o.id
        left join public.org_branding ob on ob.org_id = o.id
        where o.id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string | null>>,
  );

  const orgName = row?.org_name ?? "IdaraWorks";
  // The organisation's own display name is honoured before its legal name: a
  // company that set one did so because it is what they call themselves.
  const displayName = row?.display_name?.trim() || orgName;
  const name = row?.app_name?.trim() || displayName;

  /*
   * The short name must fit a home screen. Truncating on a grapheme boundary
   * rather than a code unit keeps Arabic and emoji whole; cutting mid-grapheme
   * produces a replacement character on the customer's phone.
   */
  const shortSource = row?.app_short_name?.trim() || name;
  const shortName = truncateGraphemes(shortSource, 12);

  /*
   * The brand colour falls back through the organisation's EXISTING accent
   * colour before reaching the platform default, so a company that set an
   * accent in H27 branding already has a themed app without touching anything.
   */
  const brand = decideBrandColor(row?.brand_color ?? row?.accent_color ?? null);
  const background = decideBackgroundColor(row?.background_color ?? null);

  const locale = normalizeAppLocale(row?.default_locale ?? row?.first_language ?? "en");

  const warnings: string[] = [];
  if (brand.warningKey) warnings.push(brand.warningKey);
  if (background.warningKey) warnings.push(background.warningKey);
  if (!row?.icon_file_id) warnings.push("app.brand.icon_generated");

  return {
    orgId: ctx.orgId,
    name,
    shortName,
    description: row?.app_description?.trim() || null,
    iconFileId: row?.icon_file_id ?? null,
    brand,
    background,
    locale,
    dir: locale === "ar" ? "rtl" : "ltr",
    warnings,
  };
}

function normalizeAppLocale(raw: string | null): "en" | "ar" | "es" {
  return raw === "ar" || raw === "es" ? raw : "en";
}

// ── Host registry ───────────────────────────────────────────────────────────

export type TenantHostRow = {
  id: string;
  host: string;
  kind: "subdomain" | "custom";
  status: "pending" | "active" | "failed" | "released";
  verifiedAt: string | null;
  failedReason: string | null;
};

export async function listHosts(ctx: Ctx, archetype: RoleArchetype): Promise<TenantHostRow[]> {
  assertCan(archetype, "config.view");
  return await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select id::text as id, host, kind, status,
               to_char(verified_at, 'YYYY-MM-DD HH24:MI') as "verifiedAt",
               failed_reason as "failedReason"
        from public.tenant_host
        where org_id = ${ctx.orgId} and status <> 'released'
        order by created_at
        limit 50
      `)) as unknown as TenantHostRow[],
  );
}

/** A slug suggestion derived from the organisation name. Never auto-claimed. */
export function suggestSlug(orgName: string): string {
  const ascii = orgName
    .normalize("NFKD")
    // Strip combining marks so "Café" suggests "cafe" rather than failing.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii.length >= 3 ? ascii : "";
}

export type SlugAvailability =
  { available: true; slug: string; host: string } | { available: false; reasonKey: string };

/**
 * Is this slug claimable?
 *
 * Reads the registry across ALL organisations, which is why it runs as a
 * platform read rather than a tenant one: a tenant must be told that a name is
 * taken without being able to see who took it. The answer is deliberately the
 * same — "not available" — whether the host belongs to somebody else, is
 * reserved, or is quarantined after release. Distinguishing them would let a
 * caller enumerate the customer base.
 */
export async function checkSlug(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: string,
): Promise<SlugAvailability> {
  assertCan(archetype, "config.view");
  const slug = normalizeSlug(raw);
  if (!slug) return { available: false, reasonKey: "app.slug.invalid" };
  if (isReservedSlug(slug)) return { available: false, reasonKey: "app.slug.reserved" };

  const host = `${slug}.${TENANT_PARENT}`;
  const [taken] = await withCtx(
    ctx,
    async (tx) =>
      (await tx.execute(sql`
        select
          exists(
            select 1 from public.tenant_host
            where host = ${host} and status in ('pending', 'active')
              and org_id <> ${ctx.orgId}
          ) as by_other,
          exists(
            select 1 from public.tenant_host
            where host = ${host} and status = 'released'
              and (claimable_after is null or claimable_after > now())
          ) as quarantined
      `)) as unknown as Array<{ by_other: boolean; quarantined: boolean }>,
  );

  if (taken?.by_other || taken?.quarantined) {
    return { available: false, reasonKey: "app.slug.taken" };
  }
  return { available: true, slug, host };
}

/**
 * Claim a standard subdomain.
 *
 * The row is created `pending`. It routes nothing and authorises nothing until
 * an operator verifies it — which, until the wildcard exists, means the owner
 * has added the CNAME and the Vercel domain. A customer pressing this button
 * does not make a hostname live, and the UI says so.
 */
export async function claimSubdomain(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: string,
): Promise<{ hostId: string; host: string }> {
  assertCan(archetype, "config.manage");
  const availability = await checkSlug(ctx, archetype, raw);
  if (!availability.available) {
    throw new CompanyAppError(`slug unavailable: ${raw}`, availability.reasonKey);
  }
  const { slug, host } = availability;

  return command<{ hostId: string; host: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "companyapp.subdomain_claimed",
        entityType: "tenant_host" as const,
        entityId: r.hostId,
        summary: `Claimed the company address ${r.host}`,
      }),
    },
    async (tx) => {
      /*
       * The unique index is the real guard against two organisations claiming
       * one hostname at the same instant. This advisory lock only keeps the
       * common case from surfacing as a constraint violation to a user.
       */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${host}, 0))`);
      const clash = (await tx.execute(sql`
        select 1 from public.tenant_host
        where host = ${host} and status in ('pending', 'active') and org_id <> ${ctx.orgId}
      `)) as unknown as unknown[];
      if (clash.length > 0) {
        throw new CompanyAppError(`host taken: ${host}`, "app.slug.taken");
      }
      // Re-claiming the organisation's own pending host is idempotent.
      const existing = (await tx.execute(sql`
        select id::text as id from public.tenant_host
        where host = ${host} and org_id = ${ctx.orgId} and status in ('pending', 'active')
      `)) as unknown as Array<{ id: string }>;
      if (existing[0]) return { hostId: existing[0].id, host };

      const [row] = (await tx.execute(sql`
        insert into public.tenant_host (org_id, host, kind, status, created_by)
        values (${ctx.orgId}, ${host}, 'subdomain', 'pending', ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      void slug;
      return { hostId: row!.id, host };
    },
  );
}

/**
 * Register a customer-owned domain as an unverified claim.
 *
 * Deliberately identical in effect to a subdomain claim: a row that routes
 * nothing. The difference is only which DNS record the customer is told to add.
 */
export async function requestCustomDomain(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: string,
): Promise<{ hostId: string; host: string; token: string }> {
  assertCan(archetype, "config.manage");
  const verdict = classifyHost(raw);
  if (verdict.kind !== "custom_domain") {
    throw new CompanyAppError(`not a custom domain: ${raw}`, "app.domain.invalid");
  }
  const host = verdict.host;
  // A token the customer publishes as a TXT record. Random, per claim, and
  // never derived from anything about the organisation.
  const token = `idaraworks-verify-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return command<{ hostId: string; host: string; token: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "companyapp.custom_domain_requested",
        entityType: "tenant_host" as const,
        entityId: r.hostId,
        summary: `Requested the custom domain ${r.host} (unverified)`,
      }),
    },
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${host}, 0))`);
      const clash = (await tx.execute(sql`
        select 1 from public.tenant_host
        where host = ${host} and status in ('pending', 'active') and org_id <> ${ctx.orgId}
      `)) as unknown as unknown[];
      if (clash.length > 0) throw new CompanyAppError(`host taken: ${host}`, "app.domain.taken");

      const [row] = (await tx.execute(sql`
        insert into public.tenant_host (org_id, host, kind, status, verification_token, created_by)
        values (${ctx.orgId}, ${host}, 'custom', 'pending', ${token}, ${ctx.userId})
        on conflict do nothing
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!row) throw new CompanyAppError(`host taken: ${host}`, "app.domain.taken");
      return { hostId: row.id, host, token };
    },
  );
}

// ── Branding writes ─────────────────────────────────────────────────────────

export type SaveAppBrandInput = {
  appName?: string | null;
  appShortName?: string | null;
  appDescription?: string | null;
  brandColor?: string | null;
  backgroundColor?: string | null;
  defaultLocale?: string | null;
};

export async function saveAppBrand(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: SaveAppBrandInput,
): Promise<void> {
  assertCan(archetype, "config.manage");

  const text = (v: string | null | undefined, max: number): string | null => {
    const s = (v ?? "").trim();
    return s.length === 0 ? null : s.slice(0, max);
  };
  const color = (v: string | null | undefined): string | null => {
    const s = (v ?? "").trim();
    if (s.length === 0) return null;
    if (!/^#[0-9a-fA-F]{6}$/.test(s)) {
      throw new CompanyAppError(`invalid colour ${s}`, "app.brand.color_invalid");
    }
    return s.toLowerCase();
  };
  const locale = (v: string | null | undefined): string | null => {
    const s = (v ?? "").trim();
    if (s.length === 0) return null;
    if (!["en", "ar", "es"].includes(s)) {
      throw new CompanyAppError(`unknown locale ${s}`, "app.brand.locale_invalid");
    }
    return s;
  };

  const appName = text(input.appName, 60);
  const shortName = input.appShortName ? truncateGraphemes(input.appShortName.trim(), 12) : null;
  const description = text(input.appDescription, 300);
  const brandColor = color(input.brandColor);
  const backgroundColor = color(input.backgroundColor);
  const defaultLocale = locale(input.defaultLocale);

  await command<void>(
    ctx,
    {
      audit: () => ({
        action: "companyapp.brand_saved",
        entityType: "org" as const,
        entityId: ctx.orgId,
        summary: "Updated the company app identity",
      }),
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.org_app_brand
          (org_id, app_name, app_short_name, app_description, brand_color,
           background_color, default_locale)
        values (${ctx.orgId}, ${appName}, ${shortName}, ${description}, ${brandColor},
                ${backgroundColor}, ${defaultLocale})
        on conflict (org_id) do update set
          app_name = excluded.app_name,
          app_short_name = excluded.app_short_name,
          app_description = excluded.app_description,
          brand_color = excluded.brand_color,
          background_color = excluded.background_color,
          default_locale = excluded.default_locale,
          updated_at = now()
      `);
    },
  );
}

/** Whether this caller may change the company app at all. */
export function canManageCompanyApp(archetype: RoleArchetype): boolean {
  return can(archetype, "config.manage");
}
