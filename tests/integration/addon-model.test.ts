/**
 * Add-on model (integration, real DB) — the post-MVP modular subscription layer end-to-end:
 * catalogue ⇔ DB parity (0065), free-plan + add-on + bundle entitlement resolution, the
 * provider→webhook round-trip as the SOLE org_addon writer (idempotent, signature-gated),
 * purchasability honesty (deferred/credential_gated refused at BOTH the service and DB layers),
 * seat limits (field seats never limited), FR-9 read-only supremacy over granted capabilities,
 * period-end sweeps (add-on removal, scheduled downgrade, trial → free landing), downgrades
 * never deleting data, and the protected production orgs staying untouched by every sweep.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser, inviteMember, SeatLimitError } from "@/platform/auth/identity";
import {
  ADDONS,
  BUNDLES,
  getAddon,
  resolveEntitlements,
  invalidateEntitlements,
  BillingReadOnlyError,
  CapabilityRequiredError,
  TRIAL_LANDING_PLAN,
} from "@/platform/entitlements";
import {
  processSubscriptionWebhook,
  emitFakeSignal,
  changeAddons,
  AddonUnavailableError,
} from "@/modules/subscription/service";
import { sweepLifecycle } from "@/workers/functions/subscription-worker";
import { createExpense } from "@/modules/expenses/service";
import { createCustomer } from "@/modules/masters/service";
import { fakeBillingProvider } from "@/platform/billing/adapter";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";

const PROTECTED = {
  alphaMarine: "d22b2098-2e09-436d-ab9e-ee26c8719cd5",
  testing: "9fcaa697-becd-41ec-97d4-6ce2851ead36",
};

const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "addon-test",
});

async function planState(): Promise<{ plan_key: string; billing_state: string }> {
  const rows = (await owner`
    select plan_key, billing_state from public.org_plan_state
    where org_id = ${orgId}`) as unknown as Array<{ plan_key: string; billing_state: string }>;
  return rows[0]!;
}

async function addonRow(key: string): Promise<{ status: string; quantity: number } | undefined> {
  const rows = (await owner`
    select status, quantity from public.org_addon
    where org_id = ${orgId} and addon_key = ${key}`) as unknown as Array<{
    status: string;
    quantity: number;
  }>;
  return rows[0];
}

/** Arrange-only: grant/flip an add-on through the DEFINER writer (owner conn = platform path). */
async function setAddon(
  key: string,
  status: string,
  quantity = 1,
  removeAt: string | null = null,
  source = "individual",
): Promise<void> {
  await owner`select app.set_org_addon(${orgId}::uuid, ${key}, ${quantity}, ${status},
    ${removeAt}, ${source})`;
  invalidateEntitlements(orgId);
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`addon-${run}@example.com`}, '{"full_name":"Addon Test"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: `ADDON-TEST-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  // Fake-provider linkage (s9 idiom) + land on the free base plan for the gate tests.
  await owner`update public.org_plan_state
    set provider = 'fake', provider_customer_id = ${`fake_cus_${orgId}`},
        provider_subscription_id = ${`fake_sub_${orgId}`},
        plan_key = 'free', billing_state = 'active'
    where org_id = ${orgId}`;
  invalidateEntitlements(orgId);
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await wipeOrgs(owner, [orgId], [ownerUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("catalogue ⇔ DB parity (0065)", () => {
  it("addon_def rows match ADDONS exactly; bundles + members match BUNDLES", async () => {
    const dbAddons = (await owner`
      select key, availability from public.addon_def`) as unknown as Array<{
      key: string;
      availability: string;
    }>;
    expect(new Set(dbAddons.map((r) => r.key))).toEqual(new Set(ADDONS.map((a) => a.key)));
    for (const a of ADDONS) {
      expect(dbAddons.find((r) => r.key === a.key)?.availability).toBe(a.availability);
    }
    const dbBundles = (await owner`select key from public.bundle_def`) as unknown as Array<{
      key: string;
    }>;
    expect(new Set(dbBundles.map((r) => r.key))).toEqual(new Set(BUNDLES.map((b) => b.key)));
    for (const b of BUNDLES) {
      const members = (await owner`
        select addon_key from public.bundle_addon where bundle_key = ${b.key}`) as unknown as Array<{
        addon_key: string;
      }>;
      expect(new Set(members.map((m) => m.addon_key))).toEqual(new Set(b.addonKeys));
    }
  });

  it("every purchasable/gated add-on carries USD+AED month prices; deferred carries none", async () => {
    for (const a of ADDONS) {
      const prices = (await owner`
        select currency, billing_interval from public.addon_price
        where addon_key = ${a.key} and active`) as unknown as Array<{
        currency: string;
        billing_interval: string;
      }>;
      if (a.availability === "deferred") {
        expect(prices.length).toBe(0);
      } else {
        const combos = new Set(prices.map((p) => `${p.currency}:${p.billing_interval}`));
        expect(combos.has("USD:month")).toBe(true);
        expect(combos.has("AED:month")).toBe(true);
      }
    }
  });
});

describe("free-plan + add-on entitlement resolution", () => {
  it("free base: operational caps on, money caps off, 3 full seats", async () => {
    const ent = await resolveEntitlements(ctx());
    expect(ent.planKey).toBe("free");
    expect(ent.features["cap.jobs"]).toBe(true);
    expect(ent.features["cap.daily_reports"]).toBe(true);
    expect(ent.features["cap.customers"]).toBe(true);
    expect(ent.features["cap.quoting"]).toBe(false);
    expect(ent.features["cap.invoicing"]).toBe(false);
    expect(ent.features["cap.payments"]).toBe(false);
    expect(ent.features["cap.expenses"]).toBe(false);
    expect(ent.limits["limit.full_users"]).toBe(3);
  });

  it("the DB writer refuses deferred add-ons outright", async () => {
    const deferred = ADDONS.find((a) => a.availability === "deferred")!;
    await expect(
      owner`select app.set_org_addon(${orgId}::uuid, ${deferred.key}, 1, 'active', null, 'individual')`,
    ).rejects.toThrow(/deferred/);
  });

  it("add-on grants OR features; seat packs ADD limit deltas × quantity; removed drops both", async () => {
    await setAddon("addon.quotes_invoices", "active");
    await setAddon("addon.members_10", "active", 2);
    let ent = await resolveEntitlements(ctx());
    expect(ent.features["cap.quoting"]).toBe(true);
    expect(ent.limits["limit.full_users"]).toBe(3 + 10 * 2);
    // removal_scheduled still counts — paid through period end.
    await setAddon("addon.quotes_invoices", "removal_scheduled", 1, new Date().toISOString());
    ent = await resolveEntitlements(ctx());
    expect(ent.features["cap.quoting"]).toBe(true);
    // removed drops the grant; the row is retained (never deleted).
    await setAddon("addon.quotes_invoices", "removed");
    await setAddon("addon.members_10", "removed", 2);
    ent = await resolveEntitlements(ctx());
    expect(ent.features["cap.quoting"]).toBe(false);
    expect(ent.limits["limit.full_users"]).toBe(3);
    expect((await addonRow("addon.quotes_invoices"))?.status).toBe("removed");
  });
});

describe("webhook round-trip: sole writer, idempotent, signature-gated", () => {
  it("addon_changed activates once; the duplicate delivery is a no-op", async () => {
    const first = await emitFakeSignal(orgId, "addon_changed", {
      providerEventId: "addon-evt-1",
      addonChange: {
        addon_key: "addon.payments_ar",
        quantity: 1,
        status: "active",
        remove_at: null,
        source: "individual",
      },
    });
    expect(first.status).toBe("processed");
    const dup = await emitFakeSignal(orgId, "addon_changed", {
      providerEventId: "addon-evt-1",
      addonChange: {
        addon_key: "addon.payments_ar",
        quantity: 1,
        status: "active",
        remove_at: null,
        source: "individual",
      },
    });
    expect(dup.status).toBe("duplicate");
    const rows = (await owner`
      select count(*)::int as n from public.org_addon
      where org_id = ${orgId} and addon_key = 'addon.payments_ar'`) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBe(1);
    invalidateEntitlements(orgId);
    expect((await resolveEntitlements(ctx())).features["cap.payments"]).toBe(true);
  });

  it("an unverified signature never writes", async () => {
    const evt = {
      eventType: "fake.addon_changed",
      signal: "addon_changed",
      providerEventId: `forged_${run}`,
      providerCustomerId: `fake_cus_${orgId}`,
      providerSubscriptionId: `fake_sub_${orgId}`,
      planKey: null,
      billingInterval: null,
      billingCurrency: null,
      addonChange: {
        addon_key: "addon.approvals_advanced",
        quantity: 1,
        status: "active",
        remove_at: null,
        source: "individual",
      },
    };
    const { body } = fakeBillingProvider.signEvent(evt as never);
    const out = await processSubscriptionWebhook(body, "sig_forged");
    expect(out.status).toBe("unverified");
    expect(await addonRow("addon.approvals_advanced")).toBeUndefined();
  });

  it("every add-on change lands in the tenant's own audit log", async () => {
    const rows = (await owner`
      select count(*)::int as n from public.audit_log
      where org_id = ${orgId} and action = 'subscription.addons_changed'`) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });
});

describe("changeAddons (tenant action → provider → webhook)", () => {
  it("activates a purchasable add-on end-to-end and gates the CREATE it unlocks", async () => {
    // Gate first: cap.expenses is off — the CREATE refuses before input validation.
    await expect(createExpense(ctx(), "owner", {})).rejects.toThrow(CapabilityRequiredError);
    const res = await changeAddons(ctx(), "owner", {
      additions: [{ addonKey: "addon.expenses_cashbook" }],
      removals: [],
    });
    expect(res.added).toBe(1);
    invalidateEntitlements(orgId);
    expect((await resolveEntitlements(ctx())).features["cap.expenses"]).toBe(true);
    expect((await addonRow("addon.expenses_cashbook"))?.status).toBe("active");
  });

  it("refuses deferred and credential-gated additions with the availability class", async () => {
    const deferred = ADDONS.find((a) => a.availability === "deferred")!;
    const gated = ADDONS.find((a) => a.availability === "credential_gated")!;
    for (const key of [deferred.key, gated.key]) {
      await expect(
        changeAddons(ctx(), "owner", { additions: [{ addonKey: key }], removals: [] }),
      ).rejects.toThrow(AddonUnavailableError);
      expect(await addonRow(key)).toBeUndefined();
    }
  });

  it("a bundle expands to member add-ons (same keys, bundle source); overlap never duplicates", async () => {
    const res = await changeAddons(ctx(), "owner", {
      additions: [{ addonKey: "addon.expenses_cashbook" }], // overlaps bundle.finance
      removals: [],
      bundleKey: "bundle.finance",
    });
    const finance = BUNDLES.find((b) => b.key === "bundle.finance")!;
    expect(res.added).toBe(finance.addonKeys.length); // deduped: overlap collapses to the bundle row
    for (const key of finance.addonKeys) {
      const row = (await owner`
        select count(*)::int as n, min(source) as source from public.org_addon
        where org_id = ${orgId} and addon_key = ${key}`) as unknown as Array<{
        n: number;
        source: string;
      }>;
      expect(row[0]!.n).toBe(1); // one row per key — never a duplicate entitlement/charge
      expect(row[0]!.source).toBe("bundle.finance");
    }
  });

  it("removal schedules to period end and deletes NOTHING", async () => {
    const customer = await createCustomer(ctx(), "owner", { name: `Cust ${run}` });
    const res = await changeAddons(ctx(), "owner", {
      additions: [],
      removals: ["addon.expenses_cashbook"],
    });
    expect(res.removalScheduled).toBe(1);
    expect(res.removeAt).not.toBeNull();
    expect(Date.parse(res.removeAt!)).toBeGreaterThan(Date.now());
    expect((await addonRow("addon.expenses_cashbook"))?.status).toBe("removal_scheduled");
    // Data survives the downgrade path.
    const kept = (await owner`
      select count(*)::int as n from public.customer
      where org_id = ${orgId} and id = ${customer.id}`) as unknown as Array<{ n: number }>;
    expect(kept[0]!.n).toBe(1);
  });
});

describe("seat limits (free plan: 3 full seats; field seats never limited)", () => {
  it("enforces limit.full_users across memberships + pending invites; foreman always admits", async () => {
    // Owner membership occupies seat 1; two invites reach the cap of 3.
    await inviteMember(ctx(), "owner", { email: `m1-${run}@example.com`, roleKey: "manager" });
    await inviteMember(ctx(), "owner", { email: `m2-${run}@example.com`, roleKey: "manager" });
    await expect(
      inviteMember(ctx(), "owner", { email: `m3-${run}@example.com`, roleKey: "manager" }),
    ).rejects.toThrow(SeatLimitError);
    // Field seats are free by product law — a foreman invite never hits the wall.
    const foreman = await inviteMember(ctx(), "owner", {
      email: `f1-${run}@example.com`,
      roleKey: "foreman",
    });
    expect(foreman.inviteId).toBeTruthy();
    // A seat pack lifts the wall.
    await setAddon("addon.members_10", "active");
    const afterPack = await inviteMember(ctx(), "owner", {
      email: `m4-${run}@example.com`,
      roleKey: "manager",
    });
    expect(afterPack.inviteId).toBeTruthy();
  });
});

describe("FR-9: read-only billing states outrank granted capabilities", () => {
  it("a suspended org's granted CREATE is still refused; recovery restores it", async () => {
    await owner`update public.org_plan_state set billing_state = 'suspended'
      where org_id = ${orgId}`;
    invalidateEntitlements(orgId);
    await expect(createCustomer(ctx(), "owner", { name: `Blocked ${run}` })).rejects.toThrow(
      BillingReadOnlyError,
    );
    await owner`update public.org_plan_state set billing_state = 'active'
      where org_id = ${orgId}`;
    invalidateEntitlements(orgId);
    const ok = await createCustomer(ctx(), "owner", { name: `Recovered ${run}` });
    expect(ok.id).toBeTruthy();
  });
});

describe("lifecycle sweeps (period-end removal, scheduled downgrade, trial landing)", () => {
  it("flips a due scheduled removal to removed and drops the grant", async () => {
    await owner`update public.org_addon
      set remove_at = now() - interval '1 hour'
      where org_id = ${orgId} and addon_key = 'addon.expenses_cashbook'`;
    const res = await sweepLifecycle(Date.now());
    expect(res.addonsRemoved).toBeGreaterThanOrEqual(1);
    expect((await addonRow("addon.expenses_cashbook"))?.status).toBe("removed");
    invalidateEntitlements(orgId);
    expect((await resolveEntitlements(ctx())).features["cap.expenses"]).toBe(false);
  });

  it("applies a scheduled plan downgrade at the period boundary and clears the sentinel", async () => {
    // The 0067 trigger stamps scheduled_plan_at = now() on the transition; backdate it explicitly
    // (an explicit value wins over the stamp) so the period boundary is already behind us.
    await owner`update public.org_plan_state
      set plan_key = 'growth', scheduled_plan_key = 'free',
          period_start = now() - interval '65 days',
          scheduled_plan_at = now() - interval '40 days'
      where org_id = ${orgId}`;
    const res = await sweepLifecycle(Date.now());
    expect(res.plansApplied).toBeGreaterThanOrEqual(1);
    const st = (await owner`
      select plan_key, scheduled_plan_key from public.org_plan_state
      where org_id = ${orgId}`) as unknown as Array<{
      plan_key: string;
      scheduled_plan_key: string | null;
    }>;
    expect(st[0]!.plan_key).toBe("free");
    expect(st[0]!.scheduled_plan_key).toBeNull();
  });

  it("an expired trial lands on the free base plan, ACTIVE — never suspended", async () => {
    await owner`update public.org_plan_state
      set plan_key = 'growth', billing_state = 'trialing', trial_end = now() - interval '1 day'
      where org_id = ${orgId}`;
    const res = await sweepLifecycle(Date.now());
    expect(res.transitioned).toBeGreaterThanOrEqual(1);
    const st = await planState();
    expect(st.plan_key).toBe(TRIAL_LANDING_PLAN);
    expect(st.billing_state).toBe("active");
  });

  it("trial_end NULL means NO deadline — the sweep never touches such an org (0068 contract)", async () => {
    // Regression for the CRITICAL review finding: the old period_start+14d fallback manufactured
    // a deadline for trial_end-NULL orgs (the protected production orgs' exact shape).
    await owner`update public.org_plan_state
      set plan_key = 'growth', billing_state = 'trialing', trial_end = null,
          period_start = now() - interval '400 days'
      where org_id = ${orgId}`;
    invalidateEntitlements(orgId);
    await sweepLifecycle(Date.now());
    const st = await planState();
    expect(st.plan_key).toBe("growth");
    expect(st.billing_state).toBe("trialing");
  });

  it("every sweep left the protected production orgs untouched", async () => {
    const rows = (await owner`
      select org_id::text as id, plan_key, billing_state, trial_end, scheduled_plan_key
      from public.org_plan_state
      where org_id in (${PROTECTED.alphaMarine}::uuid, ${PROTECTED.testing}::uuid)
      order by org_id`) as unknown as Array<{
      id: string;
      plan_key: string;
      billing_state: string;
      trial_end: string | null;
      scheduled_plan_key: string | null;
    }>;
    if (rows.length === 0) {
      // Ephemeral stack (CI local supabase): the hosted production orgs don't exist here.
      // The invariant itself is pinned by the trial_end-NULL regression test above.
      console.info("protected-org assertion skipped: hosted rows absent (local stack)");
      return;
    }
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.plan_key).toBe("growth");
      expect(r.billing_state).toBe("trialing");
      // trial_end NULL = NO deadline by the 0068 contract (explicit deadlines only; the old
      // period_start fallback was removed) — so the sweep is a no-op for them BY INVARIANT,
      // not by timing.
      expect(r.trial_end).toBeNull();
      expect(r.scheduled_plan_key).toBeNull();
    }
    const addons = (await owner`
      select count(*)::int as n from public.org_addon
      where org_id in (${PROTECTED.alphaMarine}::uuid, ${PROTECTED.testing}::uuid)`) as unknown as Array<{
      n: number;
    }>;
    expect(addons[0]!.n).toBe(0);
  });
});
