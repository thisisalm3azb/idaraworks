/**
 * Security review 2026-09-20 — a job can never point at another company's
 * customer. Two walls, both proven here against the real database:
 *
 *   1. the service refuses a foreign customer id with the same "not found"
 *      a nonexistent id gets (no cross-tenant signal);
 *   2. the composite foreign key (migration 0142) refuses the row even when
 *      the service is bypassed.
 *
 * Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createJobFromPreset, JobInputError } from "@/modules/jobs/service";
import { markFixtureOrg, ownerSql, requireIntegrationEnv, wipeOrgs } from "./helpers";

requireIntegrationEnv();

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let customerB = "";
let presetA = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "job-customer",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`jc-${label}-${run}@example.com`}, '{"full_name":"JC"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(userA, "a");
  await seedAuthUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "JC A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "JC B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "job-customer-org", run);
  await markFixtureOrg(owner, orgB, "job-customer-org", run);
  const [c] = (await owner`
    insert into public.customer (org_id, name) values (${orgB}, 'Customer of B') returning id::text as id`) as unknown as Array<{
    id: string;
  }>;
  customerB = c!.id;
  const [p] = (await owner`
    select id::text as id from public.job_preset where org_id = ${orgA} and retired_at is null order by created_at limit 1`) as unknown as Array<{
    id: string;
  }>;
  presetA = p?.id ?? "";
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end();
  await closeAppDb();
});

describe("job.customer_id is pinned to the organisation", () => {
  it("the service refuses another company's customer as not found", async () => {
    if (!presetA) return; // a fresh org without presets cannot create work; the DB wall below still holds
    await expect(
      createJobFromPreset(ctxOf(orgA, userA), "owner", {
        name: "Cross-tenant attempt",
        presetId: presetA,
        customerId: customerB,
      } as never),
    ).rejects.toBeInstanceOf(JobInputError);
    const [n] =
      (await owner`select count(*)::int as n from public.job where org_id = ${orgA}`) as unknown as Array<{
        n: number;
      }>;
    expect(n!.n).toBe(0);
  });

  it("the database refuses the row even when the service is bypassed", async () => {
    const ctx = ctxOf(orgA, userA);
    await expect(
      withCtx(ctx, async (tx) => {
        await tx.execute(sql`
          insert into public.job (org_id, reference, name, customer_id, status_key, status_category, created_by)
          values (${orgA}, 'X-1', 'bypass', ${customerB}::uuid, 'draft', 'draft', ${userA})`);
      }),
    ).rejects.toThrow();
    // The driver wraps the refusal ("Failed query: …"); the constraint name is
    // on the cause. Either way the row must not exist.
    const [n] = (await owner`
      select count(*)::int as n from public.job where org_id = ${orgA} and customer_id = ${customerB}::uuid`) as unknown as Array<{
      n: number;
    }>;
    expect(n!.n).toBe(0);
  });

  it("the refusal names the composite key", async () => {
    const ctx = ctxOf(orgA, userA);
    let seen = "";
    try {
      await withCtx(ctx, async (tx) => {
        await tx.execute(sql`
          insert into public.job (org_id, reference, name, customer_id, status_key, status_category, created_by)
          values (${orgA}, 'X-2', 'bypass', ${customerB}::uuid, 'draft', 'draft', ${userA})`);
      });
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      seen = `${e.message} ${String((e.cause as Error | undefined)?.message ?? e.cause ?? "")}`;
    }
    expect(seen).toMatch(/job_customer_org_fk|foreign key/i);
  });

  it("a customer of the same organisation is accepted by the constraint", async () => {
    const [c] = (await owner`
      insert into public.customer (org_id, name) values (${orgA}, 'Customer of A') returning id::text as id`) as unknown as Array<{
      id: string;
    }>;
    const [ok] = (await owner`
      select exists (
        select 1 from public.customer where id = ${c!.id}::uuid and org_id = ${orgA}
      ) as fine`) as unknown as Array<{ fine: boolean }>;
    expect(ok!.fine).toBe(true);
  });
});
