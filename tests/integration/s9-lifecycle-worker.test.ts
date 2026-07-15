/**
 * S9 lifecycle workers (integration, real DB): the deadline-driven sweep (trial expiry, dunning
 * ladder by elapsed window, purge scheduling) + dunning-reminder recording + provider reconciliation
 * drift. The sweep is platform-wide; each test drives ITS org's windows via owner SQL and asserts on
 * that org only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { sweepLifecycle, runReconciliation } from "@/workers/functions/subscription-worker";
import { setFakeProviderState } from "@/platform/billing/adapter";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";

async function setState(patch: string): Promise<void> {
  await owner.unsafe(`update public.org_plan_state set ${patch} where org_id = $1`, [orgId]);
}
async function stateOf(): Promise<string> {
  const r =
    (await owner`select billing_state from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
      billing_state: string;
    }>;
  return r[0]!.billing_state;
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s9wk-${run}@example.com`}, '{"full_name":"S9WK"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "S9 Wk Org",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`update public.org_plan_state
    set provider = 'fake', provider_customer_id = ${`fake_cus_${orgId}`} where org_id = ${orgId}`;
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  setFakeProviderState(`fake_cus_${orgId}`, null);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("lifecycle sweep + dunning + reconciliation", () => {
  it("lands an over-run trial on the free base plan, active (add-on model)", async () => {
    await setState("billing_state = 'trialing', trial_end = now() - interval '1 day'");
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("active"); // trial_ended → free base plan, never suspension
    const p = (await owner`select plan_key from public.org_plan_state
      where org_id = ${orgId}`) as unknown as Array<{ plan_key: string }>;
    expect(p[0]!.plan_key).toBe("free");
  });

  it("records a dunning reminder while past_due, without transitioning yet", async () => {
    // Dunning window still open (grace deadline in the future) → reminder recorded, state stays.
    await setState("billing_state = 'past_due', grace_until = now() + interval '3 days'");
    const res = await sweepLifecycle(Date.now());
    expect(res.dunned).toBeGreaterThanOrEqual(1);
    expect(await stateOf()).toBe("past_due");
    const d = (await owner`select count(*)::int as n from public.dunning_attempt
      where org_id = ${orgId}`) as unknown as Array<{ n: number }>;
    expect(d[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("walks past_due→grace→suspended as each window elapses", async () => {
    await setState("billing_state = 'past_due', grace_until = now() - interval '1 hour'");
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("grace"); // dunning exhausted
    await setState("suspend_at = now() - interval '1 hour'");
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("suspended"); // grace elapsed → read-only
  });

  it("schedules purge from a read-only state, and legal hold blocks the actual purge", async () => {
    await setState("billing_state = 'suspended', purge_at = now() - interval '1 hour'");
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("purge_pending"); // read-only window elapsed
    // Under legal hold, the purge is refused by the DB sole-writer (state stays purge_pending).
    await setState(
      "legal_hold = true, purge_at = now() - interval '30 days'", // warn lead elapsed too
    );
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("purge_pending"); // legal hold suspends purge
    // Lift the hold → the next sweep purges.
    await setState("legal_hold = false");
    await sweepLifecycle(Date.now());
    expect(await stateOf()).toBe("purged");
  });

  it("reconciliation records provider↔local drift (local active, provider cancelled)", async () => {
    await setState("billing_state = 'active'");
    setFakeProviderState(`fake_cus_${orgId}`, { billingState: "cancelled", planKey: "growth" });
    const res = await runReconciliation();
    expect(res.findings).toBeGreaterThanOrEqual(1);
    const f = (await owner`select count(*)::int as n from public.reconciliation
      where org_id = ${orgId} and kind = 'local_active_provider_cancelled' and resolved_at is null`) as unknown as Array<{
      n: number;
    }>;
    expect(f[0]!.n).toBe(1);
  });
});
