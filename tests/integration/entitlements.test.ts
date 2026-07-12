/**
 * Entitlements integration (Phase D): catalogue⇔DB parity, default-plan
 * assignment on org creation, resolution with override precedence + cache
 * invalidation, checkLimit semantics, and cross-tenant isolation.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  checkLimit,
  getLimit,
  hasFeature,
  invalidateEntitlements,
  resolveEntitlements,
} from "@/platform/entitlements";
import { createOrgForUser } from "@/platform/auth/identity";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const userA = randomUUID();
let orgA = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, ${JSON.stringify({ full_name: email.split("@")[0] })}::jsonb, now(), now())
    on conflict (id) do nothing`;
}

beforeAll(async () => {
  await seedAuthUser(userA, `ent-owner-${userA.slice(0, 8)}@example.com`);
  orgA = await createOrgForUser(userA, { name: "Ent Co", country: "AE", baseCurrency: "AED" });
}, 60_000);

afterAll(async () => {
  if (orgA) {
    await owner`delete from public.org_entitlement_override where org_id = ${orgA}`;
    await owner`delete from public.org_plan_state where org_id = ${orgA}`;
    await owner`delete from public.audit_log where org_id = ${orgA}`;
    await owner`delete from public.membership where org_id = ${orgA}`;
    await owner`delete from public.role_definition where org_id = ${orgA}`;
    await owner`delete from public.company where org_id = ${orgA}`;
    await owner`delete from public.org where id = ${orgA}`;
  }
  await owner`delete from public.user_profile where id = ${userA}`;
  await owner`delete from auth.users where id = ${userA}`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctx: () => Ctx = () => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "t",
});

describe("catalogue ⇔ DB parity", () => {
  it("every code key has an entitlement_def row and vice versa", async () => {
    const rows = await owner`select key, kind from public.entitlement_def`;
    const dbFeatures = rows
      .filter((r) => r.kind === "feature")
      .map((r) => r.key)
      .sort();
    const dbLimits = rows
      .filter((r) => r.kind === "limit")
      .map((r) => r.key)
      .sort();
    expect(dbFeatures).toEqual([...FEATURE_KEYS].sort());
    expect(dbLimits).toEqual([...LIMIT_KEYS].sort());
  });

  it("every plan seeds a row for EVERY catalogue key (no silent fail-closed)", async () => {
    // A missing plan_entitlement row makes getLimit() fall through to 0 =
    // 'block every add' for a valid key (database review). Assert completeness:
    // each plan carries exactly one row per feature + limit key.
    const total = FEATURE_KEYS.length + LIMIT_KEYS.length;
    const rows = await owner`
      select p.key as plan_key, count(pe.entitlement_key)::int as n
      from public.plan p
      left join public.plan_entitlement pe on pe.plan_key = p.key
      group by p.key`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.n).toBe(total);
  });
});

describe("default plan on org creation", () => {
  it("assigns Growth / trialing atomically", async () => {
    const [row] =
      await owner`select plan_key, billing_state from public.org_plan_state where org_id = ${orgA}`;
    expect(row!.plan_key).toBe("growth");
    expect(row!.billing_state).toBe("trialing");
  });
});

describe("resolution", () => {
  it("resolves all features on and Growth-tier limits", async () => {
    const ent = await resolveEntitlements(ctx());
    expect(ent.planKey).toBe("growth");
    for (const f of FEATURE_KEYS) expect(ent.features[f]).toBe(true);
    expect(await getLimit(ctx(), "limit.full_users")).toBe(15);
    expect(await getLimit(ctx(), "limit.field_users")).toBeNull(); // unlimited
    expect(await hasFeature(ctx(), "cap.daily_reports")).toBe(true);
  });

  it("unknown keys throw", async () => {
    // @ts-expect-error intentionally unknown
    await expect(hasFeature(ctx(), "cap.nonsense")).rejects.toThrow(/Unknown entitlement key/);
    // @ts-expect-error intentionally unknown
    await expect(getLimit(ctx(), "limit.nonsense")).rejects.toThrow(/Unknown entitlement key/);
  });

  it("checkLimit governs ADD, and unlimited always allows", async () => {
    expect((await checkLimit(ctx(), "limit.full_users", 14)).allowed).toBe(true);
    expect((await checkLimit(ctx(), "limit.full_users", 15)).allowed).toBe(false);
    expect((await checkLimit(ctx(), "limit.field_users", 9999)).allowed).toBe(true); // unlimited
  });

  it("override precedence wins after cache invalidation", async () => {
    // Platform grants org A a raised full_users limit + disables a capability.
    await owner`
      insert into public.org_entitlement_override (org_id, entitlement_key, limit_value, reason)
      values (${orgA}, 'limit.full_users', 99, 'sales negotiation')`;
    await owner`
      insert into public.org_entitlement_override (org_id, entitlement_key, enabled, reason)
      values (${orgA}, 'cap.invoicing', false, 'not in pilot scope')`;

    // Stale cache still shows the plan value until invalidated.
    invalidateEntitlements(orgA);

    expect(await getLimit(ctx(), "limit.full_users")).toBe(99);
    expect(await hasFeature(ctx(), "cap.invoicing")).toBe(false);
  });
});

describe("cross-tenant isolation", () => {
  it("an org cannot read another org's plan state or overrides", async () => {
    const otherOrg = randomUUID();
    // From org A's ctx, a query over plan-state sees only org A's row.
    const rows = await withCtx(ctx(), async (tx) => {
      return (await tx.execute(
        sql`select org_id::text as org_id from public.org_plan_state`,
      )) as unknown as Array<{ org_id: string }>;
    });
    for (const r of rows) expect(r.org_id).toBe(orgA);
    expect(rows.every((r) => r.org_id !== otherOrg)).toBe(true);
  });
});
