/**
 * DEFECT-3 — master-data creation (suppliers / customers / items) against a
 * TEMPLATE-APPLIED org (construction_v1), the exact configuration the founder
 * hit. Proves the SERVICE succeeds across the whole input matrix (so the reported
 * "Something went wrong" was the action swallowing a specific, recoverable error),
 * and that the classifier maps each failure class to the right safe code.
 *
 * Hosted DB, self-cleaning, never touches the protected production orgs — every
 * org is a synthetic "R2FIX-" org wiped in afterAll.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { startOnboarding, applyOnboarding } from "@/modules/onboarding/service";
import {
  createSupplier,
  listSuppliers,
  createCustomer,
  listCustomers,
  updateCustomer,
  createItem,
  listItems,
} from "@/modules/masters/service";
import { emitFakeSignal } from "@/modules/subscription/service";
import { ForbiddenError } from "@/platform/authz";
import { BillingReadOnlyError } from "@/platform/entitlements";
import { classifyMasterDataError } from "@/platform/http/actionError";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const otherUser = randomUUID();
const orgIds: string[] = [];
let mainOrg = "";
let otherOrg = "";

const ctxFor = (orgId: string, userId: string = ownerUser): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `r2fix-${run}`,
});

async function seedUser(id: string, tag: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`r2fix-${tag}-${run}@example.com`}, '{"full_name":"R2FIX"}'::jsonb, now(), now())`;
}

/** Create an org and apply the construction template through the governed pipeline. */
async function makeConstructionOrg(userId: string, name: string): Promise<string> {
  const orgId = await createOrgForUser(userId, { name, country: "AE", baseCurrency: "AED" });
  orgIds.push(orgId);
  const started = await startOnboarding(ctxFor(orgId, userId), "owner", {
    business_name: name,
    business_description: "fit-out contractor in dubai doing office renovations",
    template_key: "construction_v1",
    country: "AE",
    base_currency: "AED",
    languages: ["en", "ar"],
    six_day_week: true,
    vat_registered: true,
    requested_features: [],
  });
  await applyOnboarding(ctxFor(orgId, userId), "owner", started.sessionId);
  return orgId;
}

beforeAll(async () => {
  process.env.BILLING_PROVIDER = "fake";
  await seedUser(ownerUser, "owner");
  await seedUser(otherUser, "other");
  mainOrg = await makeConstructionOrg(ownerUser, "R2FIX Construction Main");
  otherOrg = await makeConstructionOrg(otherUser, "R2FIX Construction Other");
}, 180_000);

afterAll(async () => {
  delete process.env.BILLING_PROVIDER;
  await wipeOrgs(owner, orgIds, [ownerUser, otherUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 60_000);

describe("supplier creation on a construction-template org", () => {
  it("creates across the full valid input matrix (name only → all fields, Arabic, long)", async () => {
    const ctx = ctxFor(mainOrg);
    const longName = "ق".repeat(160); // exactly the 160-char max
    const cases: Array<[string, Parameters<typeof createSupplier>[2]]> = [
      ["name only", { name: `Gulf Subs ${run}` }],
      ["+tax", { name: `Delta MEP ${run}`, taxRegNo: "100234567800003" }],
      ["+phone", { name: `Falcon Steel ${run}`, phone: "+971501234567" }],
      ["+email", { name: `Aster ${run}`, email: "sales@aster.example" }],
      [
        "all fields",
        {
          name: `Onyx ${run}`,
          taxRegNo: "100999888700003",
          phone: "+97143216789",
          email: "info@onyx.example",
        },
      ],
      ["arabic name", { name: `مقاول باطن الخليج ${run}` }],
      ["long (160)", { name: longName }],
    ];
    for (const [, input] of cases) {
      const r = await createSupplier(ctx, "owner", input);
      expect(r.id).toBeTruthy();
    }
    const list = await listSuppliers(ctx, "owner");
    expect(list.length).toBe(cases.length);
    expect(list.some((s) => s.name === `مقاول باطن الخليج ${run}`)).toBe(true);
  });

  it("rejects a bad email as invalid_email (specific code, not a generic failure)", async () => {
    try {
      await createSupplier(ctxFor(mainOrg), "owner", { name: `Bad Email ${run}`, email: "nope" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect(classifyMasterDataError(err).code).toBe("invalid_email");
      expect(classifyMasterDataError(err).field).toBe("email");
    }
  });

  it("rejects an over-length name as invalid_input", async () => {
    try {
      await createSupplier(ctxFor(mainOrg), "owner", { name: "x".repeat(161) });
      throw new Error("expected a rejection");
    } catch (err) {
      expect(classifyMasterDataError(err).code).toBe("invalid_input");
    }
  });

  it("blocks an unauthorized role (viewer) → unauthorized", async () => {
    try {
      await createSupplier(ctxFor(mainOrg), "viewer", { name: `Nope ${run}` });
      throw new Error("expected ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(classifyMasterDataError(err).code).toBe("unauthorized");
    }
  });

  it("allows duplicate supplier NAMES by design (no unique constraint on name)", async () => {
    const ctx = ctxFor(mainOrg);
    const dupName = `Twin Contractors ${run}`;
    const a = await createSupplier(ctx, "owner", { name: dupName });
    const b = await createSupplier(ctx, "owner", { name: dupName });
    expect(a.id).not.toBe(b.id); // both accepted
  });

  it("writes an audit row for each create (auditable)", async () => {
    const ctx = ctxFor(mainOrg);
    const uniq = `Audited ${run}`;
    const { id } = await createSupplier(ctx, "owner", { name: uniq });
    const rows = (await owner`
      select entity_id, action from public.audit_log
      where org_id = ${mainOrg} and action = 'supplier.create' and entity_id = ${id}`) as unknown as Array<{
      entity_id: string;
    }>;
    expect(rows.length).toBe(1);
  });

  it("is tenant-isolated (another org never sees these suppliers)", async () => {
    const mine = await listSuppliers(ctxFor(mainOrg), "owner");
    const theirs = await listSuppliers(ctxFor(otherOrg, otherUser), "owner");
    const myNames = new Set(mine.map((s) => s.name));
    expect(theirs.some((s) => myNames.has(s.name))).toBe(false);
  });
});

describe("customer creation + edit + retire on a construction-template org", () => {
  it("creates (incl Arabic), lists, edits, and retires without a hard delete", async () => {
    const ctx = ctxFor(mainOrg);
    const { id } = await createCustomer(ctx, "owner", {
      name: `عميل الإنشاءات ${run}`,
      country: "AE",
      email: "buyer@site.example",
    });
    expect((await listCustomers(ctx, "owner")).some((c) => c.id === id)).toBe(true);

    // Edit — rename.
    await updateCustomer(ctx, "owner", id, { name: `Renamed ${run}`, active: true });
    // Retire — deactivate (active:false); the row stays (no hard delete).
    await updateCustomer(ctx, "owner", id, { name: `Renamed ${run}`, active: false });
    const after = await listCustomers(ctx, "owner");
    const row = after.find((c) => c.id === id);
    expect(row?.active).toBe(false);
    expect(row?.name).toBe(`Renamed ${run}`);
  });

  it("rejects a bad customer email as invalid_email", async () => {
    try {
      await createCustomer(ctxFor(mainOrg), "owner", { name: `BadC ${run}`, email: "x@" });
      throw new Error("expected a rejection");
    } catch (err) {
      expect(classifyMasterDataError(err).code).toBe("invalid_email");
    }
  });

  it("blocks a viewer from creating a customer → unauthorized", async () => {
    try {
      await createCustomer(ctxFor(mainOrg), "viewer", { name: `NopeC ${run}` });
      throw new Error("expected ForbiddenError");
    } catch (err) {
      expect(classifyMasterDataError(err).code).toBe("unauthorized");
    }
  });
});

describe("item creation on a construction-template org (valid category required)", () => {
  it("creates with a template category and lists it", async () => {
    const ctx = ctxFor(mainOrg);
    const { id } = await createItem(ctx, "owner", {
      sku: `STEEL-${run}`,
      name: "Rebar 12mm",
      categoryKey: "steel_rebar", // from construction_v1 item categories
      unit: "ton",
      unitCostMinor: 250000,
    });
    expect((await listItems(ctx, "owner")).some((i) => i.id === id)).toBe(true);
  });

  it("rejects a duplicate SKU as duplicate/sku (org-unique constraint)", async () => {
    const ctx = ctxFor(mainOrg);
    const sku = `DUP-${run}`;
    await createItem(ctx, "owner", {
      sku,
      name: "First",
      categoryKey: "cement_aggregates",
      unit: "bag",
    });
    try {
      await createItem(ctx, "owner", {
        sku,
        name: "Second",
        categoryKey: "cement_aggregates",
        unit: "bag",
      });
      throw new Error("expected a duplicate rejection");
    } catch (err) {
      const c = classifyMasterDataError(err);
      expect(c.code).toBe("duplicate");
      expect(c.field).toBe("sku");
    }
  });

  it("blocks a viewer from creating an item → unauthorized", async () => {
    try {
      await createItem(ctxFor(mainOrg), "viewer", {
        sku: `V-${run}`,
        name: "x",
        categoryKey: "blockwork",
        unit: "pcs",
      });
      throw new Error("expected ForbiddenError");
    } catch (err) {
      expect(classifyMasterDataError(err).code).toBe("unauthorized");
    }
  });
});

describe("suspended org (FR-9): writes blocked, reads allowed", () => {
  it("blocks a supplier create while suspended but still lists existing rows", async () => {
    const suspendedUser = randomUUID();
    await seedUser(suspendedUser, "susp");
    const orgId = await createOrgForUser(suspendedUser, {
      name: "R2FIX Suspended",
      country: "AE",
      baseCurrency: "AED",
    });
    orgIds.push(orgId);
    await owner`update public.org_plan_state set provider = 'fake',
      provider_customer_id = ${`fake_cus_${orgId}`} where org_id = ${orgId}`;
    const ctx = ctxFor(orgId, suspendedUser);

    // Trialing: a create succeeds.
    const seeded = await createSupplier(ctx, "owner", { name: "Before Suspend" });
    expect(seeded.id).toBeTruthy();

    // Drive to suspended via the dunning ladder.
    await emitFakeSignal(orgId, "activated", { providerEventId: `act-${run}` });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: `f1-${run}` });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: `f2-${run}` });
    await emitFakeSignal(orgId, "payment_failed", { providerEventId: `f3-${run}` });
    const [st] =
      (await owner`select billing_state from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
        billing_state: string;
      }>;
    expect(st!.billing_state).toBe("suspended");

    // WRITE blocked at command() → read_only_billing.
    try {
      await createSupplier(ctx, "owner", { name: "During Suspend" });
      throw new Error("expected BillingReadOnlyError");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingReadOnlyError);
      expect(classifyMasterDataError(err).code).toBe("read_only_billing");
    }
    // READ still works.
    const seen = await listSuppliers(ctx, "owner");
    expect(seen.some((s) => s.id === seeded.id)).toBe(true);
  }, 60_000);
});
