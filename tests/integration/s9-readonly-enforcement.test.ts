/**
 * S9 read-only enforcement (integration) — the REAL fix for the review finding: a suspended /
 * cancelled org must be blocked from ANY audited mutation (FR-9 "block ADD, never reads"), enforced
 * at the command() chokepoint — not merely by a guard the demo calls by hand. Drives an org to
 * suspended via the subscription state machine, then proves a genuine createCustomer (which flows
 * through command()) is rejected while a READ still works, and that recovery restores writes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createCustomer, listCustomers } from "@/modules/masters/service";
import { emitFakeSignal } from "@/modules/subscription/service";
import { BillingReadOnlyError } from "@/platform/entitlements";
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
  requestId: "s9-ro-test",
});

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s9ro-${run}@example.com`}, '{"full_name":"S9RO"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "S9 RO Org",
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`update public.org_plan_state set provider = 'fake',
    provider_customer_id = ${`fake_cus_${orgId}`} where org_id = ${orgId}`;
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("read-only enforcement at the command() chokepoint (FR-9)", () => {
  it("blocks a real audited mutation when suspended, still allows reads, and restores on recovery", async () => {
    // Trialing (not read-only): a genuine command()-based create succeeds.
    const first = await createCustomer(ctx(), "owner", { name: "قبل التعليق" });
    expect(first.id).toBeTruthy();

    // Convert the trial (activate), then drive to suspended via the dunning ladder.
    await emitFakeSignal(orgId, "activated", { providerEventId: "ro-act" });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "ro-f1" });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "ro-f2" });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: "ro-f3" });
    const [st] =
      (await owner`select billing_state from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
        billing_state: string;
      }>;
    expect(st!.billing_state).toBe("suspended");

    // The ADD is now rejected at command() — NOT a hand-called guard.
    await expect(createCustomer(ctx(), "owner", { name: "أثناء التعليق" })).rejects.toBeInstanceOf(
      BillingReadOnlyError,
    );
    // …but the READ still works (FR-9 never blocks reads/exports).
    const seen = await listCustomers(ctx(), "owner");
    expect(seen.some((c) => c.id === first.id)).toBe(true);

    // Recovery → active → writes restored.
    await emitFakeSignal(orgId, "payment_recovered", { providerEventId: "ro-r1" });
    const second = await createCustomer(ctx(), "owner", { name: "بعد الاسترداد" });
    expect(second.id).toBeTruthy();
  });
});
