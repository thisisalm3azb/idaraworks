/**
 * S9 upgrade/downgrade (integration). Upgrade applies immediately; downgrade is scheduled to period
 * end and NEVER deletes data (v1 §13). Driven through the fake provider→webhook round-trip.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { emitFakeSignal, changePlan, readSubscription } from "@/modules/subscription/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";
const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s9-plan-test",
});
async function planCols(): Promise<{ plan: string; scheduled: string | null; state: string }> {
  const r = (await owner`select plan_key, scheduled_plan_key, billing_state
    from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
    plan_key: string;
    scheduled_plan_key: string | null;
    billing_state: string;
  }>;
  return { plan: r[0]!.plan_key, scheduled: r[0]!.scheduled_plan_key, state: r[0]!.billing_state };
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s9pc-${run}@example.com`}, '{"full_name":"S9PC"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "S9 PC Org",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`update public.org_plan_state
    set provider = 'fake', provider_customer_id = ${`fake_cus_${orgId}`} where org_id = ${orgId}`;
  await emitFakeSignal(orgId, "activated", { providerEventId: "pc-act" }); // trialing → active (growth)
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("upgrade / downgrade", () => {
  it("upgrade (growth→business) applies immediately", async () => {
    expect((await planCols()).plan).toBe("growth");
    const r = await changePlan(ctx(), "owner", "business");
    expect(r.mode).toBe("immediate");
    const p = await planCols();
    expect(p.plan).toBe("business");
    expect(p.scheduled).toBeNull();
    expect(p.state).toBe("active"); // plan change never moves state
  });

  it("downgrade (business→starter) is scheduled to period end, data untouched", async () => {
    const r = await changePlan(ctx(), "owner", "starter");
    expect(r.mode).toBe("scheduled");
    const p = await planCols();
    expect(p.plan).toBe("business"); // still on business until period end (never-delete)
    expect(p.scheduled).toBe("starter");
    expect(p.state).toBe("active");
    const view = await readSubscription(ctx(), "owner");
    expect(view.scheduledPlanKey).toBe("starter");

    // Period end: the provider emits an immediate plan_changed applying the scheduled plan.
    await emitFakeSignal(orgId, "plan_changed", {
      providerEventId: "pc-apply",
      planKey: "starter",
      planChangeMode: "immediate",
    });
    const after = await planCols();
    expect(after.plan).toBe("starter");
    expect(after.scheduled).toBeNull(); // cleared
    expect(after.state).toBe("active");
  });

  it("rejects a no-op change to the current plan", async () => {
    await expect(changePlan(ctx(), "owner", "starter")).rejects.toThrow(/already on that plan/);
  });

  it("a non-owner cannot change plan (billing.manage is owner-only)", async () => {
    await expect(changePlan(ctx(), "manager", "growth")).rejects.toThrow();
  });
});
