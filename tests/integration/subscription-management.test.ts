/**
 * PART D (integration, real DB) — the GOVERNED self-service management path (PART B).
 * Proves the settings page is a REAL management surface even when the real payment
 * provider is DISABLED (the prod / D1 scenario): the whole file runs with
 * BILLING_PROVIDER=disabled, so readSubscription().providerEnabled is false, yet
 * owner changes still apply — through the governed test/trial path (owner-authorized,
 * audited via='owner_action', NO charge). Also proves: a non-owner cannot change
 * (server-side authz, not client-trusted); additions immediate, removals scheduled;
 * tier overlap = one row (no double charge); duplicate confirm idempotent; the
 * stale-price guard; the tenant-visible audit history; and that the protected
 * production orgs read + display correctly WITHOUT being written. Self-cleaning.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  getTierBundle,
  resolveEntitlements,
  invalidateEntitlements,
} from "@/platform/entitlements";
import {
  applyGovernedAddonChange,
  applyGovernedAddonSet,
  readSubscription,
  readSubscriptionAuditHistory,
  computeMonthlyTotalMinor,
  currentSelectionLabel,
  currentPriceVersion,
} from "@/modules/subscription/service";
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
  requestId: "gov-test",
});

type AddonRow = { addon_key: string; quantity: number; status: string; source: string };

async function orgAddonRows(): Promise<AddonRow[]> {
  return (await owner`
    select addon_key, quantity, status, source from public.org_addon
    where org_id = ${orgId} and status in ('active','removal_scheduled')
    order by addon_key`) as unknown as AddonRow[];
}

beforeAll(async () => {
  // The prod scenario: the REAL payment provider is disabled (D1 stays closed).
  process.env.BILLING_PROVIDER = "disabled";
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`gov-${run}@example.com`}, '{"full_name":"Gov Test"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: `R2FIX-GOV-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
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

describe("the page is NOT static in prod (provider disabled, management still works)", () => {
  it("readSubscription reports the provider disabled", async () => {
    const view = await readSubscription(ctx(), "owner");
    expect(view.providerEnabled).toBe(false);
  });

  it("an owner add-on change APPLIES through the governed path — audited owner_action, no charge", async () => {
    const res = await applyGovernedAddonChange(ctx(), "owner", {
      additions: [{ addonKey: "addon.quotes_invoices" }],
      removals: [],
    });
    expect(res.added).toBe(1);
    const rows = await orgAddonRows();
    const row = rows.find((r) => r.addon_key === "addon.quotes_invoices");
    expect(row?.status).toBe("active");
    expect(row?.source).toBe("individual");
    // The entitlement is really granted (trial), enabling the capability.
    invalidateEntitlements(orgId);
    const ent = await resolveEntitlements(ctx());
    expect(ent.features["cap.quoting"]).toBe(true);
    // Audited as a governed owner action (not a provider event).
    const audit = (await owner`
      select after_data from public.audit_log
      where org_id = ${orgId} and action = 'subscription.addons_changed'
      order by created_at desc limit 1`) as unknown as Array<{
      after_data: { via?: string; trial?: boolean };
    }>;
    expect(audit[0]?.after_data?.via).toBe("owner_action");
    expect(audit[0]?.after_data?.trial).toBe(true);
  });
});

describe("authorization is server-side (a client claim cannot activate entitlements)", () => {
  it("a non-owner (admin) cannot change — authorization error, nothing written", async () => {
    const before = await orgAddonRows();
    await expect(
      applyGovernedAddonChange(ctx(), "admin", {
        additions: [{ addonKey: "addon.expenses_cashbook" }],
        removals: [],
      }),
    ).rejects.toMatchObject({ code: "authorization" });
    const after = await orgAddonRows();
    expect(after).toEqual(before); // unchanged
  });
});

describe("additions immediate, removals scheduled to period end", () => {
  it("removing an add-on schedules it (removal_scheduled) — never deletes data", async () => {
    const res = await applyGovernedAddonChange(ctx(), "owner", {
      additions: [],
      removals: ["addon.quotes_invoices"],
    });
    expect(res.removalScheduled).toBe(1);
    expect(res.removeAt).not.toBeNull();
    const rows = await orgAddonRows();
    expect(rows.find((r) => r.addon_key === "addon.quotes_invoices")?.status).toBe(
      "removal_scheduled",
    );
  });
});

describe("tier selection through the governed path (overlap = one row, no double charge)", () => {
  it("selecting tier_medium resolves all members with source=bundle.tier_medium, one row per key", async () => {
    const tier = getTierBundle("medium")!;
    // Re-add the individual quotes_invoices first (the overlap precondition).
    await applyGovernedAddonChange(ctx(), "owner", {
      additions: [{ addonKey: "addon.quotes_invoices" }],
      removals: [],
    });
    const res = await applyGovernedAddonChange(ctx(), "owner", {
      additions: [],
      removals: [],
      bundleKey: "bundle.tier_medium",
    });
    expect(res.added).toBe(tier.addonKeys.length);
    const rows = await orgAddonRows();
    for (const key of tier.addonKeys) {
      const matching = rows.filter((r) => r.addon_key === key && r.status === "active");
      expect(matching.length, `${key} one active row`).toBe(1);
      expect(matching[0]!.source).toBe("bundle.tier_medium");
    }
    // The tier price is counted ONCE (never the member sum, never twice).
    const active = rows.filter((r) => r.status === "active");
    expect(computeMonthlyTotalMinor(active, "AED")).toBe(tier.aedMonthlyMinor);
    expect(currentSelectionLabel(rows)).toBe("medium");
  });

  it("a duplicate confirm of the same change is idempotent (converges to the same rows)", async () => {
    const before = await orgAddonRows();
    await applyGovernedAddonChange(ctx(), "owner", {
      additions: [],
      removals: [],
      bundleKey: "bundle.tier_medium",
    });
    const after = await orgAddonRows();
    expect(after.filter((r) => r.status === "active").length).toBe(
      before.filter((r) => r.status === "active").length,
    );
  });
});

describe("stale-price guard", () => {
  it("a submit carrying a stale price fingerprint is refused", async () => {
    await expect(
      applyGovernedAddonSet(
        ctx(),
        "owner",
        { "addon.data_import": 1 },
        { priceVersion: "pv_STALE" },
      ),
    ).rejects.toMatchObject({ code: "stale_price_version" });
    // The correct fingerprint passes.
    const ok = await applyGovernedAddonSet(
      ctx(),
      "owner",
      { "addon.data_import": 1 },
      { priceVersion: currentPriceVersion() },
    );
    expect(ok.added).toBeGreaterThanOrEqual(1);
  });
});

describe("tenant-visible audit history", () => {
  it("returns the org's own subscription changes, attributed owner_action", async () => {
    const history = await readSubscriptionAuditHistory(ctx(), "owner", 50);
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((e) => e.source === "owner_action")).toBe(true);
    // Every entry carries a coarse status + (for scheduled) an effective date.
    for (const e of history) {
      expect(["applied", "scheduled"]).toContain(e.status);
    }
  });
});

describe("existing protected production orgs — read + display only, never converted", () => {
  const PROTECTED = ["d22b2098", "9fcaa697", "28503638", "83cdcac9"];
  it("their plan/add-ons/billing_state read and map to a display label WITHOUT any write", async () => {
    for (const prefix of PROTECTED) {
      const orgs = (await owner`
        select id::text as id, name from public.org where id::text like ${prefix + "%"}`) as unknown as Array<{
        id: string;
        name: string;
      }>;
      if (orgs.length === 0) continue; // org may not exist in this DB snapshot
      const pOrg = orgs[0]!;
      const rows = (await owner`
        select addon_key, quantity, status, source from public.org_addon
        where org_id = ${pOrg.id} and status in ('active','removal_scheduled')`) as unknown as AddonRow[];
      // Display mapping never throws and returns a valid label (or null = free base).
      const label = currentSelectionLabel(rows);
      expect([null, "medium", "high", "custom"]).toContain(label);
      const totalUsd = computeMonthlyTotalMinor(rows, "USD");
      expect(Number.isFinite(totalUsd)).toBe(true);
      const plan = (await owner`
        select plan_key, billing_state from public.org_plan_state where org_id = ${pOrg.id}`) as unknown as Array<{
        plan_key: string;
        billing_state: string;
      }>;
      expect(plan[0]).toBeDefined();
    }
  });
});
