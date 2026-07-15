/**
 * U3 tier selection (integration, real DB): selecting a TIER bundle through the
 * tenant changeAddons action resolves ALL its member add-ons via the
 * provider→webhook round-trip (source = 'bundle.tier_medium'), the resolved
 * entitlements enable the expected capabilities and seat delta, and OVERLAP
 * (an individual add-on already active + the tier) yields exactly ONE
 * org_addon row per key — never a double entitlement, and the selection-view
 * total counts it once. Self-cleaning (wipeOrgs); the protected production
 * orgs are never touched (synthetic org only).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  BUNDLES,
  getTierBundle,
  resolveEntitlements,
  invalidateEntitlements,
} from "@/platform/entitlements";
import { changeAddons, computeMonthlyTotalMinor } from "@/modules/subscription/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";

const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "tier-test",
});

type AddonRow = { addon_key: string; quantity: number; status: string; source: string };

async function orgAddonRows(): Promise<AddonRow[]> {
  return (await owner`
    select addon_key, quantity, status, source from public.org_addon
    where org_id = ${orgId} and status in ('active','removal_scheduled')
    order by addon_key`) as unknown as AddonRow[];
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`tier-${run}@example.com`}, '{"full_name":"Tier Test"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: `TIER-TEST-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  // Land on the free base (the four-path starting point); linkage is established
  // by changeAddons' fake-provider path itself.
  await owner`update public.org_plan_state
    set plan_key = 'free', billing_state = 'active'
    where org_id = ${orgId}`;
  invalidateEntitlements(orgId);
}, 120_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await wipeOrgs(owner, [orgId], [ownerUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("tier bundles exist in the DB catalogue (0072 parity)", () => {
  it("bundle_def + bundle_addon + prices match the code tier bundles", async () => {
    for (const tier of ["medium", "high"] as const) {
      const bundle = getTierBundle(tier)!;
      const members = (await owner`
        select addon_key from public.bundle_addon where bundle_key = ${bundle.key}`) as unknown as Array<{
        addon_key: string;
      }>;
      expect(new Set(members.map((m) => m.addon_key))).toEqual(new Set(bundle.addonKeys));
      const prices = (await owner`
        select currency, billing_interval, unit_amount_minor::text as amt, is_placeholder
        from public.bundle_price where bundle_key = ${bundle.key} and active`) as unknown as Array<{
        currency: string;
        billing_interval: string;
        amt: string;
        is_placeholder: boolean;
      }>;
      const usdMonth = prices.find((p) => p.currency === "USD" && p.billing_interval === "month");
      const usdYear = prices.find((p) => p.currency === "USD" && p.billing_interval === "year");
      const aedMonth = prices.find((p) => p.currency === "AED" && p.billing_interval === "month");
      expect(Number(usdMonth?.amt)).toBe(bundle.usdMonthlyMinor);
      expect(Number(usdYear?.amt)).toBe(bundle.usdMonthlyMinor * 10); // two months free
      expect(Number(aedMonth?.amt)).toBe(bundle.aedMonthlyMinor);
      expect(usdMonth?.is_placeholder).toBe(true); // owner has not ratified
    }
  });
});

describe("selecting tier_medium end-to-end (overlap included)", () => {
  it("an individual add-on activates first (the overlap precondition)", async () => {
    const res = await changeAddons(ctx(), "owner", {
      additions: [{ addonKey: "addon.quotes_invoices" }],
      removals: [],
    });
    expect(res.added).toBe(1);
    const rows = await orgAddonRows();
    expect(rows.find((r) => r.addon_key === "addon.quotes_invoices")?.source).toBe("individual");
  });

  it("tier_medium resolves ALL members with source='bundle.tier_medium'; overlap stays ONE row", async () => {
    const tier = BUNDLES.find((b) => b.key === "bundle.tier_medium")!;
    const res = await changeAddons(ctx(), "owner", {
      additions: [],
      removals: [],
      bundleKey: "bundle.tier_medium",
    });
    expect(res.added).toBe(tier.addonKeys.length);

    const rows = await orgAddonRows();
    for (const key of tier.addonKeys) {
      const matching = rows.filter((r) => r.addon_key === key);
      expect(matching.length, `${key} must have exactly ONE org_addon row`).toBe(1);
      expect(matching[0]!.status).toBe("active");
      expect(matching[0]!.source).toBe("bundle.tier_medium");
      expect(Number(matching[0]!.quantity)).toBe(1);
    }
    // The previously-individual quotes_invoices row was absorbed by the tier —
    // no duplicate entitlement, no double charge.
    expect(rows.filter((r) => r.addon_key === "addon.quotes_invoices").length).toBe(1);

    // Selection-view total: the tier price ONCE — never member sum, never twice.
    expect(computeMonthlyTotalMinor(rows, "USD")).toBe(tier.usdMonthlyMinor);
    expect(computeMonthlyTotalMinor(rows, "AED")).toBe(tier.aedMonthlyMinor);
  });

  it("resolved entitlements enable the tier's capabilities + the seat delta", async () => {
    invalidateEntitlements(orgId);
    const ent = await resolveEntitlements(ctx());
    expect(ent.planKey).toBe("free");
    // The six Medium members: billing, money, purchasing caps ON…
    expect(ent.features["cap.quoting"]).toBe(true);
    expect(ent.features["cap.invoicing"]).toBe(true);
    expect(ent.features["cap.payments"]).toBe(true);
    expect(ent.features["cap.expenses"]).toBe(true);
    expect(ent.features["cap.material_requests"]).toBe(true);
    expect(ent.features["cap.purchase_orders"]).toBe(true);
    // …capabilities NOT in Medium stay off (no accidental over-grant)…
    expect(ent.features["cap.costing"]).toBe(false);
    expect(ent.features["cap.goods_receipts"]).toBe(false);
    // …and members_10 adds its seat delta onto the free base (3 + 10).
    expect(ent.limits["limit.full_users"]).toBe(13);
    expect(ent.limits["limit.viewer_users"]).toBe(13);
  });
});
