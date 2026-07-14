/**
 * S9 subscription lifecycle (integration, real DB). Proves the v1 §13 machine end-to-end via the
 * FAKE provider: trial → active → past_due → grace → suspended → recovery; webhook idempotency
 * (duplicate delivery is a no-op); out-of-order/stale events don't corrupt state; an unverified
 * signature never transitions; the read-only enforcement (FR-9) blocks ADDs but not reads; the
 * cancellation → purge path; and that every change lands in the tenant's own audit log.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  processSubscriptionWebhook,
  emitFakeSignal,
  assertTenantWritable,
  readSubscription,
  SubscriptionReadOnlyError,
} from "@/modules/subscription/service";
import { fakeBillingProvider } from "@/platform/billing/adapter";
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
  requestId: "s9-test",
});

async function stateOf(): Promise<string> {
  const rows = (await owner`
    select billing_state from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
    billing_state: string;
  }>;
  return rows[0]!.billing_state;
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s9-${run}@example.com`}, '{"full_name":"S9"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, { name: "S9 Org", country: "AE", baseCurrency: "AED" });
  // Link the fake provider customer id so the webhook can resolve this org.
  await owner`update public.org_plan_state
    set provider = 'fake', provider_customer_id = ${`fake_cus_${orgId}`}, provider_subscription_id = ${`fake_sub_${orgId}`}
    where org_id = ${orgId}`;
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("subscription lifecycle (v1 §13, fake provider)", () => {
  it("starts trialing, activates on payment, and is idempotent on duplicate delivery", async () => {
    expect(await stateOf()).toBe("trialing");
    const first = await emitFakeSignal(orgId, "activated", { providerEventId: "evt-activate-1" });
    expect(first.status).toBe("processed");
    expect(first.to).toBe("active");
    expect(await stateOf()).toBe("active");
    // Exact same provider event id again → duplicate, no state change.
    const dup = await emitFakeSignal(orgId, "activated", { providerEventId: "evt-activate-1" });
    expect(dup.status).toBe("duplicate");
    expect(await stateOf()).toBe("active");
  });

  it("walks the dunning ladder active→past_due→grace→suspended, then recovers", async () => {
    expect((await emitFakeSignal(orgId, "payment_failed", { providerEventId: "f1" })).to).toBe(
      "past_due",
    );
    expect((await emitFakeSignal(orgId, "payment_failed", { providerEventId: "f2" })).to).toBe(
      "grace",
    );
    expect((await emitFakeSignal(orgId, "payment_failed", { providerEventId: "f3" })).to).toBe(
      "suspended",
    );
    expect(await stateOf()).toBe("suspended");
    // Recovery from read-only suspension.
    expect((await emitFakeSignal(orgId, "payment_recovered", { providerEventId: "r1" })).to).toBe(
      "active",
    );
    expect(await stateOf()).toBe("active");
  });

  it("read-only enforcement (FR-9): a suspended org blocks ADDs but reads still work", async () => {
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "sf1" }); // → past_due
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "sf2" }); // → grace
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "sf3" }); // → suspended
    expect(await stateOf()).toBe("suspended");
    // Write gate throws...
    await expect(assertTenantWritable(ctx())).rejects.toBeInstanceOf(SubscriptionReadOnlyError);
    // ...but reads (the subscription view itself) still work and report read-only.
    const view = await readSubscription(ctx(), "owner");
    expect(view.readOnly).toBe(true);
    expect(view.billingState).toBe("suspended");
    // Recover so later tests start clean.
    await emitFakeSignal(orgId, "payment_recovered", { providerEventId: "sr1" });
    await expect(assertTenantWritable(ctx())).resolves.toBeUndefined();
  });

  it("ignores a stale/out-of-order event without corrupting state", async () => {
    expect(await stateOf()).toBe("active");
    // A late 'trial_ended' after the org already converted → ignored no-op.
    const res = await emitFakeSignal(orgId, "trial_ended", { providerEventId: "stale-trial" });
    expect(res.status).toBe("ignored");
    expect(await stateOf()).toBe("active");
  });

  it("never transitions on an UNVERIFIED signature", async () => {
    const before = await stateOf();
    const evt = {
      providerEventId: `bad-sig-${run}`,
      eventType: "fake.canceled",
      signal: "canceled" as const,
      providerCustomerId: `fake_cus_${orgId}`,
      providerSubscriptionId: `fake_sub_${orgId}`,
      planKey: null,
      billingInterval: null,
      billingCurrency: null,
    };
    const body = JSON.stringify(evt);
    const out = await processSubscriptionWebhook(body, "deadbeef-not-a-valid-hmac");
    expect(out.status).toBe("unverified");
    expect(await stateOf()).toBe(before); // unchanged
  });

  it("cancels then schedules + executes purge; audit trail is tenant-visible", async () => {
    expect((await emitFakeSignal(orgId, "canceled", { providerEventId: "c1" })).to).toBe(
      "cancelled",
    );
    expect((await emitFakeSignal(orgId, "purge_due", { providerEventId: "pd1" })).to).toBe(
      "purge_pending",
    );
    expect((await emitFakeSignal(orgId, "purged", { providerEventId: "pg1" })).to).toBe("purged");
    // 'purged' is terminal — a further activate is rejected by advance_subscription (no-op signal here).
    // The tenant can see the subscription changes in its OWN audit log.
    const audit = await withCtx(ctx(), async (tx) => {
      const rows = (await tx.execute(sql`
        select action from public.audit_log
        where org_id = ${orgId} and entity_type = 'subscription' order by created_at`)) as unknown as Array<{
        action: string;
      }>;
      return rows.map((r) => r.action);
    });
    expect(audit).toContain("subscription.active");
    expect(audit).toContain("subscription.suspended");
    expect(audit).toContain("subscription.cancelled");
    expect(audit).toContain("subscription.purged");
  });

  it("the fake provider's signature genuinely gates the webhook", () => {
    const signed = fakeBillingProvider.signEvent({
      providerEventId: "x",
      eventType: "t",
      signal: "activated",
      providerCustomerId: null,
      providerSubscriptionId: null,
      planKey: null,
      billingInterval: null,
      billingCurrency: null,
    });
    expect(fakeBillingProvider.verifySignature(signed.body, signed.signature)).toBe(true);
    expect(fakeBillingProvider.verifySignature(signed.body, "nope")).toBe(false);
  });
});
