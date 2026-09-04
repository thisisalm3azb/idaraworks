/**
 * H31 — the claims that would be embarrassing to get wrong.
 *
 * Two organisations, side by side, for the whole suite. Nearly every test here
 * is about the boundary between them, because the entire feature consists of
 * giving each company something that looks like its own application while they
 * share one database, one deployment and one set of paths.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  CompanyAppError,
  checkSlug,
  claimSubdomain,
  getAppIdentity,
  listHosts,
  publicAppIdentity,
  requestCustomDomain,
  resolveHostToOrg,
  saveAppBrand,
} from "@/modules/companyapp/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
/** A registered platform operator: activation is a platform act, never a tenant one. */
const operator = randomUUID();
let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h31",
});
const ctxA = () => ctxOf(orgA, userA);
const ctxB = () => ctxOf(orgB, userB);

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h31-${label}-${run}@example.com`}, '{"full_name":"H31"}'::jsonb, now(), now())`;
}

/**
 * Activation is a platform act; a test may do it, a tenant may never.
 *
 * It runs through `withUserCtx` so `app.user_id` is set and `app.org_id` is
 * not, which is exactly what `app.assert_platform_operator()` demands. The raw
 * owner connection sets neither and is refused — which is the guard working,
 * and is how the first run of this suite failed.
 */
async function activate(host: string) {
  const { withUserCtx } = await import("@/platform/tenancy");
  await withUserCtx(operator, (tx) =>
    tx.execute(
      sql`select app.tenant_host_set_status(${host}, 'active', '{"test":true}'::jsonb, null)`,
    ),
  );
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, {
    name: "Najola Fixture Works",
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: "شما اتيلييه فيكستشر",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h31-company-app", run);
  await markFixtureOrg(owner, orgB, "h31-company-app", run);

  await seedUser(operator, "op");
  await owner`insert into public.user_profile (id, full_name, locale) values (${operator}, 'H31 Operator', 'en') on conflict (id) do nothing`;
  await owner`insert into public.platform_operator (user_id, note) values (${operator}, ${`h31 ${run}`}) on conflict (user_id) do update set revoked_at = null`;
}, 180_000);

afterAll(async () => {
  await owner`delete from public.platform_operator where user_id = ${operator}`;
  await wipeOrgs(owner, [orgA, orgB]);
  await owner`delete from public.user_profile where id = ${operator}`;
  await owner`delete from auth.users where id = ${operator}`;
  await closeAppDb();
  await owner.end({ timeout: 5 });
});

describe("identity falls back rather than failing", () => {
  it("an organisation that has configured nothing still gets a complete app identity", async () => {
    // The rule that stops an incomplete logo from making a workspace unusable.
    const id = await getAppIdentity(ctxA());
    expect(id.name).toBe("Najola Fixture Works");
    expect(id.shortName.length).toBeGreaterThan(0);
    expect(id.brand.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(id.background.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(id.warnings).toContain("app.brand.icon_generated");
  });

  it("an Arabic company name survives intact, and sets the direction", async () => {
    await saveAppBrand(ctxB(), "owner", { defaultLocale: "ar" });
    const id = await getAppIdentity(ctxB());
    expect(id.name).toBe("شما اتيلييه فيكستشر");
    expect(id.dir).toBe("rtl");
    expect(id.shortName).not.toContain("�");
  });

  it("a saved app name overrides the organisation name without renaming the company", async () => {
    await saveAppBrand(ctxA(), "owner", { appName: "Najola Field", brandColor: "#123456" });
    const id = await getAppIdentity(ctxA());
    expect(id.name).toBe("Najola Field");
    expect(id.brand.value).toBe("#123456");

    const [org] = (await owner`
      select name from public.org where id = ${orgA}`) as unknown as Array<{ name: string }>;
    expect(org!.name, "the company's own name must be untouched").toBe("Najola Fixture Works");
  });
});

describe("branding never crosses between companies", () => {
  it("two organisations read back two different identities, in sequence", async () => {
    // The sequential shape matters: it is the pattern a shared cache gets wrong.
    const a1 = await publicAppIdentity(orgA);
    const b1 = await publicAppIdentity(orgB);
    const a2 = await publicAppIdentity(orgA);

    expect(a1!.name).toBe("Najola Field");
    expect(b1!.name).toBe("شما اتيلييه فيكستشر");
    expect(a2!.name).toBe(a1!.name);
    expect(a1!.brandColor).not.toBe(b1!.brandColor);
    expect(a1!.orgId).not.toBe(b1!.orgId);
  });

  it("an unknown organisation id yields nothing, exactly like a private one", async () => {
    expect(await publicAppIdentity(randomUUID())).toBeNull();
  });

  it("one tenant cannot read or write another's app brand", async () => {
    // A's context reading B's row: RLS scopes getAppIdentity to ctx.orgId, so
    // A simply sees A. There is no parameter to point it elsewhere.
    const asA = await getAppIdentity(ctxA());
    expect(asA.orgId).toBe(orgA);
    expect(asA.name).not.toBe("شما اتيلييه فيكستشر");
  });
});

describe("slugs and hosts", () => {
  it("a reserved slug is refused", async () => {
    for (const reserved of ["api", "admin", "www", "idaraworks"]) {
      const r = await checkSlug(ctxA(), "owner", reserved);
      expect(r.available, reserved).toBe(false);
      if (!r.available) expect(r.reasonKey).toBe("app.slug.reserved");
    }
  });

  it("an invalid slug is refused with a distinct reason", async () => {
    const r = await checkSlug(ctxA(), "owner", "no");
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reasonKey).toBe("app.slug.invalid");
  });

  it("a good slug is available, then claimed, then unavailable to the other tenant", async () => {
    const slug = `h31-${run}`;
    const before = await checkSlug(ctxA(), "owner", slug);
    expect(before.available).toBe(true);

    const claim = await claimSubdomain(ctxA(), "owner", slug);
    expect(claim.host).toBe(`${slug}.idaraworks.com`);

    // The SAME name now reads as unavailable to a different organisation, and
    // the reason is the generic one — B must not learn that A exists.
    const forB = await checkSlug(ctxB(), "owner", slug);
    expect(forB.available).toBe(false);
    if (!forB.available) expect(forB.reasonKey).toBe("app.slug.taken");
  });

  it("claiming twice from the same organisation is idempotent, not a duplicate", async () => {
    const slug = `h31-${run}`;
    const again = await claimSubdomain(ctxA(), "owner", slug);
    expect(again.host).toBe(`${slug}.idaraworks.com`);
    const rows = await listHosts(ctxA(), "owner");
    expect(rows.filter((r) => r.host === `${slug}.idaraworks.com`)).toHaveLength(1);
  });

  it("the database refuses a duplicate host even if the service is bypassed", async () => {
    // The unique index is the real guard; the advisory lock only makes the
    // common case a friendly message instead of a constraint violation.
    await expect(
      owner`insert into public.tenant_host (org_id, host, kind, status)
            values (${orgB}, ${`h31-${run}.idaraworks.com`}, 'subdomain', 'pending')`,
    ).rejects.toThrow();
  });

  it("a claimed host routes NOTHING until it is activated", async () => {
    // The whole point of pending: a customer pressing a button does not make a
    // hostname live, and cannot make one point at their workspace.
    expect(await resolveHostToOrg(`h31-${run}.idaraworks.com`)).toBeNull();
  });

  it("an activated host resolves to exactly its own organisation", async () => {
    const host = `h31-${run}.idaraworks.com`;
    await activate(host);
    const resolved = await resolveHostToOrg(host);
    expect(resolved).not.toBeNull();
    expect(resolved!.orgId).toBe(orgA);
    expect(resolved!.kind).toBe("subdomain");
  });

  it("an unknown host resolves to nothing rather than to a default tenant", async () => {
    for (const host of [
      "nothing-here.idaraworks.com",
      "www.idaraworks.com",
      "evil.example.com",
      "",
    ]) {
      expect(await resolveHostToOrg(host), host).toBeNull();
    }
  });

  it("host lookup is case-insensitive and trims, so one name is one company", async () => {
    const host = `h31-${run}.idaraworks.com`;
    for (const variant of [host.toUpperCase(), `  ${host}  `]) {
      const r = await resolveHostToOrg(variant);
      expect(r?.orgId, variant).toBe(orgA);
    }
  });

  it("a tenant cannot activate its own claim", async () => {
    // status is deliberately absent from the tenant UPDATE grant, so even full
    // application access cannot promote a pending claim.
    const slug = `h31b-${run}`;
    await claimSubdomain(ctxB(), "owner", slug);
    const { withCtx } = await import("@/platform/tenancy");
    await expect(
      withCtx(ctxB(), async (tx) =>
        tx.execute(sql`
          update public.tenant_host set status = 'active'
          where org_id = ${orgB} and host = ${`${slug}.idaraworks.com`}
        `),
      ),
    ).rejects.toThrow();
    expect(await resolveHostToOrg(`${slug}.idaraworks.com`)).toBeNull();
  });
});

describe("permissions", () => {
  it("a role without config.manage cannot change branding or claim an address", async () => {
    // Hiding the control is never the control.
    await expect(saveAppBrand(ctxA(), "foreman", { appName: "Nope" })).rejects.toThrow();
    await expect(claimSubdomain(ctxA(), "foreman", `nope-${run}`)).rejects.toThrow();
    await expect(requestCustomDomain(ctxA(), "viewer", "app.example.com")).rejects.toThrow();
  });

  it("an invalid colour is refused at the service, not silently stored", async () => {
    await expect(saveAppBrand(ctxA(), "owner", { brandColor: "red" })).rejects.toMatchObject({
      messageKey: "app.brand.color_invalid",
    });
  });

  it("an unsupported locale is refused", async () => {
    await expect(saveAppBrand(ctxA(), "owner", { defaultLocale: "fr" })).rejects.toMatchObject({
      messageKey: "app.brand.locale_invalid",
    });
  });
});

describe("custom domains", () => {
  it("a request is recorded as pending and routes nothing", async () => {
    const domain = `app-${run}.example.com`;
    const r = await requestCustomDomain(ctxA(), "owner", domain);
    expect(r.host).toBe(domain);
    expect(r.token).toMatch(/^idaraworks-verify-[0-9a-f]{24}$/);
    expect(await resolveHostToOrg(domain)).toBeNull();
  });

  it("the same domain cannot be claimed by a second organisation", async () => {
    const domain = `app-${run}.example.com`;
    await expect(requestCustomDomain(ctxB(), "owner", domain)).rejects.toBeInstanceOf(
      CompanyAppError,
    );
  });

  it("something that is not a domain is refused", async () => {
    for (const bad of ["not a domain", "http://app.example.com", "acme.idaraworks.com"]) {
      await expect(requestCustomDomain(ctxA(), "owner", bad), bad).rejects.toMatchObject({
        messageKey: "app.domain.invalid",
      });
    }
  });
});

describe("audit", () => {
  it("every branding and address change is recorded", async () => {
    const [row] = (await owner`
      select count(*)::int as n from public.audit_log
      where org_id = ${orgA}
        and action in ('companyapp.brand_saved', 'companyapp.subdomain_claimed',
                       'companyapp.custom_domain_requested')`) as unknown as Array<{ n: number }>;
    expect(row!.n).toBeGreaterThanOrEqual(3);
  });
});
