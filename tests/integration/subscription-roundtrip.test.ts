/**
 * Subscription round-trip integrity (integration, real DB, fake provider) — the review fixes:
 *
 *  • an org created through the NORMAL app path (createOrgForUser, no manual provider linkage)
 *    can change add-ons end-to-end — the fake-provider path establishes the org↔provider linkage
 *    itself (the exact review scenario: it used to round-trip to 'unresolved' and REPORT SUCCESS);
 *  • a genuinely unresolvable round-trip THROWS SubscriptionActionError (existing linkage is
 *    never overwritten, so a foreign linkage stays broken and surfaces loudly);
 *  • non-stackable add-ons are forced to quantity 1; a stackable quantity DECREASE never applies
 *    immediately (period-end law); quantities are bounded 1..99;
 *  • the webhook wall refuses ACTIVATING a non-purchasable (credential_gated) add-on even on a
 *    correctly-signed provider event — failed inbox status, no org_addon row;
 *  • removeBundleKey schedules period-end removal of every bundle-sourced row.
 *
 * Self-cleaning: every org/user created here is wiped in afterAll (plus the org-scoped
 * null-org subscription_event rows the unresolved case leaves behind).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { BUNDLES } from "@/platform/entitlements";
import {
  changeAddons,
  emitFakeSignal,
  SubscriptionActionError,
} from "@/modules/subscription/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgA = ""; // normally created — NO manual linkage (the review scenario)
let orgB = ""; // deliberately FOREIGN linkage — round-trips must stay unresolvable

const ctxFor = (orgId: string): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "subscription-roundtrip-test",
});

async function addonRow(
  orgId: string,
  key: string,
): Promise<{ status: string; quantity: number; source: string } | undefined> {
  const rows = (await owner`
    select status, quantity, source from public.org_addon
    where org_id = ${orgId} and addon_key = ${key}`) as unknown as Array<{
    status: string;
    quantity: number;
    source: string;
  }>;
  return rows[0];
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`roundtrip-${run}@example.com`}, '{"full_name":"Roundtrip Test"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(ownerUser, {
    name: `RT-A-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(ownerUser, {
    name: `RT-B-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  // orgB: a non-null MISMATCHING linkage. The auto-linkage only fills a NULL
  // provider_customer_id, so this org's fake round-trips can never resolve.
  await owner`update public.org_plan_state
    set provider = 'fake', provider_customer_id = ${`fake_cus_foreign_${run}`}
    where org_id = ${orgB}`;
}, 180_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  // The unresolved case records inbox rows with org_id NULL (that is the point) — wipeOrgs can't
  // reach them by org_id, so reap them by the org-scoped fake event-id prefix first.
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await owner`delete from public.subscription_event
      where org_id is null and provider_event_id like ${`fake_${orgId}_%`}`;
  }
  await wipeOrgs(owner, [orgA, orgB], [ownerUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("round-trip integrity for normally-created orgs (the review scenario)", () => {
  it("changeAddons succeeds end-to-end with NO manual linkage — linkage is auto-established", async () => {
    // Pre-condition: org creation never set the provider linkage.
    const before = (await owner`
      select provider_customer_id from public.org_plan_state
      where org_id = ${orgA}`) as unknown as Array<{ provider_customer_id: string | null }>;
    expect(before[0]!.provider_customer_id).toBeNull();

    const res = await changeAddons(ctxFor(orgA), "owner", {
      additions: [{ addonKey: "addon.expenses_cashbook" }],
      removals: [],
    });
    expect(res.added).toBe(1);

    const row = await addonRow(orgA, "addon.expenses_cashbook");
    expect(row?.status).toBe("active");
    expect(Number(row?.quantity)).toBe(1);

    const after = (await owner`
      select provider, provider_customer_id from public.org_plan_state
      where org_id = ${orgA}`) as unknown as Array<{
      provider: string;
      provider_customer_id: string;
    }>;
    expect(after[0]!.provider).toBe("fake");
    expect(after[0]!.provider_customer_id).toBe(`fake_cus_${orgA}`);
  });

  it("an unresolvable round-trip THROWS — never a silent success (and never clobbers linkage)", async () => {
    await expect(
      changeAddons(ctxFor(orgB), "owner", {
        additions: [{ addonKey: "addon.quotes_invoices" }],
        removals: [],
      }),
    ).rejects.toThrow(SubscriptionActionError);
    await expect(
      changeAddons(ctxFor(orgB), "owner", {
        additions: [{ addonKey: "addon.quotes_invoices" }],
        removals: [],
      }),
    ).rejects.toThrow(/unresolved/);
    expect(await addonRow(orgB, "addon.quotes_invoices")).toBeUndefined();
    // The deliberately-foreign linkage was NOT overwritten by the auto-linkage.
    const st = (await owner`
      select provider_customer_id from public.org_plan_state
      where org_id = ${orgB}`) as unknown as Array<{ provider_customer_id: string }>;
    expect(st[0]!.provider_customer_id).toBe(`fake_cus_foreign_${run}`);
  });
});

describe("quantity laws", () => {
  it("a non-stackable add-on is forced to quantity 1 regardless of the request", async () => {
    await changeAddons(ctxFor(orgA), "owner", {
      additions: [{ addonKey: "addon.quotes_invoices", quantity: 5 }],
      removals: [],
    });
    const row = await addonRow(orgA, "addon.quotes_invoices");
    expect(row?.status).toBe("active");
    expect(Number(row?.quantity)).toBe(1);
  });

  it("a stackable quantity DECREASE never applies immediately (period-end law)", async () => {
    await changeAddons(ctxFor(orgA), "owner", {
      additions: [{ addonKey: "addon.members_10", quantity: 3 }],
      removals: [],
    });
    expect(Number((await addonRow(orgA, "addon.members_10"))?.quantity)).toBe(3);

    await expect(
      changeAddons(ctxFor(orgA), "owner", {
        additions: [{ addonKey: "addon.members_10", quantity: 1 }],
        removals: [],
      }),
    ).rejects.toThrow(/period end/);
    // Unchanged: still the paid-through quantity, still active.
    const row = await addonRow(orgA, "addon.members_10");
    expect(row?.status).toBe("active");
    expect(Number(row?.quantity)).toBe(3);
  });

  it("quantities outside 1..99 are refused outright", async () => {
    for (const quantity of [0, -2, 100]) {
      await expect(
        changeAddons(ctxFor(orgA), "owner", {
          additions: [{ addonKey: "addon.storage_25gb", quantity }],
          removals: [],
        }),
      ).rejects.toThrow(/between 1 and 99/);
    }
    expect(await addonRow(orgA, "addon.storage_25gb")).toBeUndefined();
  });
});

describe("webhook wall honesty (applyAddonChange)", () => {
  it("refuses ACTIVATING a credential_gated add-on on a correctly-signed event", async () => {
    const out = await emitFakeSignal(orgA, "addon_changed", {
      providerEventId: `gated-${run}`,
      addonChange: {
        addon_key: "addon.ai_pack", // credential_gated — never purchasable today
        quantity: 1,
        status: "active",
        remove_at: null,
        source: "individual",
      },
    });
    expect(out.status).toBe("ignored"); // 200-worthy to the provider, but NOT applied
    const inbox = (await owner`
      select status, error from public.subscription_event
      where provider = 'fake'
        and provider_event_id = ${`fake_${orgA}_addon_changed_gated-${run}`}`) as unknown as Array<{
      status: string;
      error: string | null;
    }>;
    expect(inbox[0]!.status).toBe("failed");
    expect(inbox[0]!.error).toMatch(/not purchasable/);
    expect(await addonRow(orgA, "addon.ai_pack")).toBeUndefined();
  });
});

describe("bundle removal (period-end, all bundle-sourced rows)", () => {
  it("removeBundleKey schedules removal of every member row; an inactive bundle refuses", async () => {
    const finance = BUNDLES.find((b) => b.key === "bundle.finance")!;
    await changeAddons(ctxFor(orgA), "owner", {
      additions: [],
      removals: [],
      bundleKey: "bundle.finance",
    });
    const res = await changeAddons(ctxFor(orgA), "owner", {
      additions: [],
      removals: [],
      removeBundleKey: "bundle.finance",
    });
    expect(res.removalScheduled).toBe(finance.addonKeys.length);
    expect(res.removeAt).not.toBeNull();
    for (const key of finance.addonKeys) {
      const row = await addonRow(orgA, key);
      expect(row?.status).toBe("removal_scheduled");
      expect(row?.source).toBe("bundle.finance");
    }
    await expect(
      changeAddons(ctxFor(orgA), "owner", {
        additions: [],
        removals: [],
        removeBundleKey: "bundle.procurement",
      }),
    ).rejects.toThrow(/not active/);
  });
});
