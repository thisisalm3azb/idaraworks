/**
 * H22E — the asset register: identity, custody, maintenance, disposal.
 *
 * The tests that matter most are the ones about what an asset system is FOR.
 * Anyone can store a row called "asset"; the value is in the questions it can
 * answer afterwards — who had the drill in March, why it was written off and who
 * agreed, whether the machine that broke was under warranty — and every one of
 * those is a question an editable field cannot answer. So the history here is
 * append-only and these tests check that it stays that way.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { ForbiddenError } from "@/platform/authz";
import {
  createAssetCategory,
  registerAsset,
  setAssetStatus,
  assignAsset,
  returnAsset,
  transferAsset,
  correctAssignment,
  listAssets,
  getAsset,
  recordInspection,
  createMaintenancePlan,
  recordMaintenance,
  startDowntime,
  endDowntime,
  requestDisposal,
  completeDisposal,
  resubmitDisposal,
  cancelDisposal,
  listMaintenanceDue,
  assetDowntime,
  AssetError,
  AssetStateError,
} from "@/modules/assets/service";
import { createApprovalRule, decideApproval, withdrawApproval } from "@/modules/approvals/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const mgrUser = randomUUID();
const foremanUser = randomUUID();
const outsiderUser = randomUUID();
let orgA = "";
let orgB = "";
let whA = "";
let binA = "";
let binB = "";
let supplierA = "";
let categoryA = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22e",
});
const ownerCtx = () => ctxOf(orgA, userA);
const mgrCtx = () => ctxOf(orgA, mgrUser);
const foremanCtx = () => ctxOf(orgA, foremanUser);

let today = "";
const soon = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22e-${label}-${run}@example.com`}, '{"full_name":"H22E"}'::jsonb, now(), now())`;
}

/**
 * The whole error chain as one string.
 *
 * The driver wraps a PostgresError inside a "Failed query" Error, so asserting
 * on .message alone tests the wrapper and not the refusal. Flattening the chain
 * is what lets a test name the constraint it is relying on.
 */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected that to be refused, and it was not");
}
/** A canonical H21 job. Created directly: these tests are about the LINK. */
async function aJob(name: string) {
  const id = randomUUID();
  await owner`
    insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
    values (${id}, ${orgA}, ${"J-" + randomUUID().slice(0, 8)}, ${name}, 'active', 'active',
            ${userA})`;
  return { id };
}

/** A task on that job, in the canonical table. */
async function aTask(jobId: string, title: string) {
  const id = randomUUID();
  await owner`
    insert into public.task (id, org_id, job_id, title, status, created_by)
    values (${id}, ${orgA}, ${jobId}, ${title}, 'pending', ${userA})`;
  return id;
}
/** A registered asset, in service, with nothing else assumed. */
async function anAsset(overrides: Record<string, unknown> = {}) {
  const { id } = await registerAsset(ownerCtx(), "owner", {
    nameEn: "Compressor",
    categoryId: categoryA,
    acquisitionCostMinor: 500_000,
    currency: "AED",
    acquiredOn: soon(-400),
    ...overrides,
  });
  await setAssetStatus(ownerCtx(), "owner", id, "in_service");
  return id;
}

beforeAll(async () => {
  const [clock] = (await owner`select current_date::text as d`) as unknown as Array<{ d: string }>;
  today = clock!.d;

  for (const [id, label] of [
    [userA, "owner"],
    [mgrUser, "mgr"],
    [foremanUser, "fore"],
    [outsiderUser, "out"],
  ] as const) {
    await seedUser(id, label);
  }
  orgA = await createOrgForUser(userA, { name: "H22E A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(outsiderUser, {
    name: "H22E B",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h22e", run);
  await markFixtureOrg(owner, orgB, "h22e-b", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${mgrUser}, ${orgA}, 'manager'), (${foremanUser}, ${orgA}, 'foreman')`;
  await createApprovalRule(ownerCtx(), "owner", {
    subjectType: "asset_disposal",
    conditionKind: "always",
    assignedRole: "owner",
  });

  whA = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${whA}, ${orgA}, 'MAIN', 'Main', ${userA})`;
  binA = randomUUID();
  binB = randomUUID();
  await owner`
    insert into public.stock_location (id, org_id, warehouse_id, code, name_en, kind)
    values (${binA}, ${orgA}, ${whA}, 'STORE', 'Store', 'storage'),
           (${binB}, ${orgA}, ${whA}, 'SITE', 'Site bay', 'storage')`;
  supplierA = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierA}, ${orgA}, 'Supplier')`;

  categoryA = (
    await createAssetCategory(ownerCtx(), "owner", {
      code: "PLANT",
      nameEn: "Plant and machinery",
      nameAr: "آلات ومعدات",
      defaultUsefulLifeMonths: 60,
      defaultResidualPct: 10,
    })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, mgrUser, foremanUser, outsiderUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 300_000);

describe("registering", () => {
  it("gives every asset a number and a scannable identity", { timeout: 240_000 }, async () => {
    const a = await registerAsset(ownerCtx(), "owner", {
      nameEn: "Generator",
      nameAr: "مولد",
      categoryId: categoryA,
      serialNo: "SN-GEN-1",
      barcode: "1234567890123",
      codeKind: "internal",
      acquisitionCostMinor: 1_000_000,
      currency: "AED",
    });
    expect(a.assetNo).toMatch(/^AST-\d{3}$/);
    // The QR key is NOT the asset number: a label encoding a sequence tells any
    // reader how many assets the business owns.
    expect(a.qrKey).toMatch(/^AQR-[0-9A-F]{20}$/);
    expect(a.qrKey).not.toContain(a.assetNo);

    const { asset } = await getAsset(ownerCtx(), "owner", a.id);
    expect(asset!.name_ar).toBe("مولد");
    expect(asset!.status).toBe("draft");
    expect(asset!.code_kind, "declared, never inferred from the digits").toBe("internal");
  });

  it(
    "inherits the category's life and residual, resolved to an amount",
    { timeout: 240_000 },
    async () => {
      const a = await registerAsset(ownerCtx(), "owner", {
        nameEn: "Mixer",
        categoryId: categoryA,
        acquisitionCostMinor: 200_000,
        currency: "AED",
      });
      const { asset } = await getAsset(ownerCtx(), "owner", a.id);
      expect(Number(asset!.useful_life_months)).toBe(60);
      // 10% of 200000, resolved NOW — storing the percentage would restate every
      // asset the day somebody edits the category.
      expect(Number(asset!.residual_value_minor)).toBe(20_000);
    },
  );

  it("records H24's inputs and computes no depreciation", { timeout: 240_000 }, async () => {
    const a = await registerAsset(ownerCtx(), "owner", {
      nameEn: "Van",
      acquisitionCostMinor: 900_000,
      currency: "AED",
      residualValueMinor: 90_000,
      usefulLifeMonths: 48,
      depreciationStartOn: soon(-30),
    });
    const { asset } = await getAsset(ownerCtx(), "owner", a.id);
    expect(Number(asset!.residual_value_minor)).toBe(90_000);
    expect(Number(asset!.useful_life_months)).toBe(48);
    // Nothing in H22 turns those into a charge, and no column claims to hold one.
    const [cols] = (await owner`
      select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'asset'
        and (column_name like '%depreciat%accum%' or column_name like '%book_value%'
             or column_name like '%net_book%')`) as unknown as Array<{ n: number }>;
    expect(cols!.n, "no accumulated depreciation, no net book value").toBe(0);
  });

  it("refuses a residual worth more than the thing cost", { timeout: 240_000 }, async () => {
    expect(
      await refusal(() =>
        registerAsset(ownerCtx(), "owner", {
          nameEn: "Impossible",
          acquisitionCostMinor: 1000,
          residualValueMinor: 5000,
        }),
      ),
    ).toMatch(/asset_residual_ck/i);
  });

  it("refuses a warranty that ends before it starts", { timeout: 240_000 }, async () => {
    await expect(
      registerAsset(ownerCtx(), "owner", {
        nameEn: "Backwards",
        warrantyStartOn: soon(100),
        warrantyEndOn: soon(10),
      }),
    ).rejects.toBeInstanceOf(AssetError);
  });

  it("one barcode identifies one asset", { timeout: 240_000 }, async () => {
    await registerAsset(ownerCtx(), "owner", { nameEn: "First", barcode: "DUP-CODE-1" });
    expect(
      await refusal(() =>
        registerAsset(ownerCtx(), "owner", { nameEn: "Second", barcode: "DUP-CODE-1" }),
      ),
    ).toMatch(/asset_barcode_uq/i);
  });
});

describe("an asset received through inventory keeps its history", () => {
  it(
    "links the unit, the delivery and the order, and touches none of them",
    { timeout: 300_000 },
    async () => {
      // A serialised unit that came in through the ordinary receiving path.
      const unit = randomUUID();
      const item = randomUUID();
      const serial = randomUUID();
      await owner`
      insert into public.unit_of_measure
        (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
      values (${unit}, ${orgA}, 'EA', 'Each', 'حبة', 'count', 1, true)`;
      await owner`
      insert into public.item (id, org_id, sku, name, category_key, unit, item_type,
                               base_unit_id, tracking)
      values (${item}, ${orgA}, ${"AS-" + randomUUID().slice(0, 8)}, 'Serialised plant',
              'general', 'ea', 'asset', ${unit}, 'serial')`;
      await owner`
      insert into public.stock_serial
        (id, org_id, item_id, serial_no, status, warehouse_id, location_id, created_by)
      values (${serial}, ${orgA}, ${item}, 'PLANT-0007', 'in_stock', ${whA}, ${binA}, ${userA})`;

      const a = await registerAsset(ownerCtx(), "owner", {
        nameEn: "Received plant",
        stockSerialId: serial,
        supplierId: supplierA,
        acquisitionCostMinor: 750_000,
        currency: "AED",
      });

      const { asset } = await getAsset(ownerCtx(), "owner", a.id);
      expect(asset!.stock_serial_id, "the unit it IS").toBe(serial);
      // Copied from inventory rather than retyped.
      expect(asset!.serial_no).toBe("PLANT-0007");
      expect(asset!.location_id).toBe(binA);

      // And the inventory record is exactly as it was.
      const [stillThere] = (await owner`
      select status, location_id::text as location_id from public.stock_serial
      where id = ${serial}`) as unknown as Array<Record<string, string>>;
      expect(stillThere!.status, "registering an asset removes nothing").toBe("in_stock");
      expect(stillThere!.location_id).toBe(binA);
    },
  );

  it("one serialised unit becomes at most one asset", { timeout: 300_000 }, async () => {
    const unit = randomUUID();
    const item = randomUUID();
    const serial = randomUUID();
    await owner`
      insert into public.unit_of_measure
        (id, org_id, code, name_en, name_ar, dimension, factor_to_base)
      values (${unit}, ${orgA}, ${"U" + randomUUID().slice(0, 6)}, 'Each', 'حبة', 'count', 1)`;
    await owner`
      insert into public.item (id, org_id, sku, name, category_key, unit, item_type,
                               base_unit_id, tracking)
      values (${item}, ${orgA}, ${"AS-" + randomUUID().slice(0, 8)}, 'Plant', 'general', 'ea',
              'asset', ${unit}, 'serial')`;
    await owner`
      insert into public.stock_serial
        (id, org_id, item_id, serial_no, status, warehouse_id, location_id, created_by)
      values (${serial}, ${orgA}, ${item}, 'ONCE-1', 'in_stock', ${whA}, ${binA}, ${userA})`;

    await registerAsset(ownerCtx(), "owner", { nameEn: "One", stockSerialId: serial });
    expect(
      await refusal(() =>
        registerAsset(ownerCtx(), "owner", { nameEn: "Two", stockSerialId: serial }),
      ),
    ).toMatch(/asset_serial_once_uq/i);
  });
});

describe("custody is a trail, not a field", () => {
  it(
    "records every hand-over and keeps the current answer in step",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();

      await assignAsset(foremanCtx(), "foreman", {
        assetId: id,
        toUserId: mgrUser,
        toLocationId: binB,
        reason: "site work",
      });
      let read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.custodian_user_id).toBe(mgrUser);
      expect(read.asset!.location_id).toBe(binB);

      await returnAsset(foremanCtx(), "foreman", {
        assetId: id,
        toLocationId: binA,
        conditionAtEvent: "fair",
        reason: "job finished",
      });
      read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.custodian_user_id, "nobody holds it now").toBeNull();
      expect(read.asset!.condition, "and it came back worse").toBe("fair");

      // The trail answers the question the field cannot.
      expect(read.custody.map((c) => c.event)).toEqual(["returned", "assigned"]);
      const assigned = read.custody.find((c) => c.event === "assigned")!;
      expect(assigned.to_user_id).toBe(mgrUser);
    },
  );

  it(
    "a transfer moves it without necessarily changing who holds it",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      await assignAsset(foremanCtx(), "foreman", { assetId: id, toUserId: mgrUser });

      // Moved to another bay; the same person is still responsible for it.
      await transferAsset(foremanCtx(), "foreman", {
        assetId: id,
        toLocationId: binB,
        reason: "moved to the site bay",
      });
      let read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.location_id).toBe(binB);
      expect(read.asset!.custodian_user_id, "custody did not change").toBe(mgrUser);

      // Now handed on as part of the move.
      await transferAsset(foremanCtx(), "foreman", {
        assetId: id,
        toLocationId: binA,
        toUserId: foremanUser,
        reason: "handed to the yard",
      });
      read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.custodian_user_id).toBe(foremanUser);
      expect(read.custody.filter((c) => c.event === "transferred")).toHaveLength(2);
    },
  );

  it("a transfer that moves nothing is refused", { timeout: 240_000 }, async () => {
    const id = await anAsset();
    await expect(
      transferAsset(foremanCtx(), "foreman", { assetId: id, reason: "nowhere" }),
    ).rejects.toBeInstanceOf(AssetError);
  });

  it("custody events cannot be edited or deleted", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    const { eventId } = await assignAsset(foremanCtx(), "foreman", {
      assetId: id,
      toUserId: mgrUser,
    });
    await expect(
      owner`update public.asset_assignment set to_user_id = ${userA} where id = ${eventId}`,
    ).rejects.toThrow();
    await expect(
      owner`delete from public.asset_assignment where id = ${eventId}`,
    ).rejects.toThrow();
  });

  it(
    "a mistake is corrected by a further event, naming the original",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      const { eventId } = await assignAsset(foremanCtx(), "foreman", {
        assetId: id,
        toUserId: mgrUser,
        reason: "wrong person",
      });
      const { eventId: fix } = await correctAssignment(
        foremanCtx(),
        "foreman",
        eventId,
        "handed to the wrong person",
      );
      const read = await getAsset(ownerCtx(), "owner", id);
      const correction = read.custody.find((c) => c.id === fix)!;
      expect(correction.event).toBe("correction");
      expect(correction.corrects_id, "the original is named, not overwritten").toBe(eventId);
      expect(
        read.custody.some((c) => c.id === eventId),
        "and it is still there",
      ).toBe(true);
    },
  );

  it(
    "only an active member of THIS organization may hold an asset",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      // outsiderUser owns org B and has no membership in org A.
      expect(
        await refusal(() =>
          assignAsset(ownerCtx(), "owner", { assetId: id, toUserId: outsiderUser }),
        ),
      ).toMatch(/active member of this organization/i);
    },
  );

  it("a retired asset cannot be handed out", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await setAssetStatus(ownerCtx(), "owner", id, "retired", "end of life");
    await expect(
      assignAsset(foremanCtx(), "foreman", { assetId: id, toUserId: mgrUser }),
    ).rejects.toBeInstanceOf(AssetStateError);
  });
});

describe("the lifecycle is enforced by the database", () => {
  it("allows the transitions that make sense", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await setAssetStatus(ownerCtx(), "owner", id, "under_maintenance");
    await setAssetStatus(ownerCtx(), "owner", id, "in_service");
    await setAssetStatus(ownerCtx(), "owner", id, "in_storage");
    const { asset } = await getAsset(ownerCtx(), "owner", id);
    expect(asset!.status).toBe("in_storage");
  });

  it("refuses one that does not, whoever asks", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await setAssetStatus(ownerCtx(), "owner", id, "retired", "done");
    // Retired may come back or be disposed of — it may not go straight to maintenance.
    expect(
      await refusal(
        () => owner`update public.asset set status = 'under_maintenance' where id = ${id}`,
      ),
    ).toMatch(/cannot go from retired to under_maintenance/i);
  });

  it("retiring needs a reason", { timeout: 240_000 }, async () => {
    const id = await anAsset();
    await expect(setAssetStatus(ownerCtx(), "owner", id, "retired")).rejects.toBeInstanceOf(
      AssetStateError,
    );
  });

  it("nobody can set an asset to disposed directly", { timeout: 240_000 }, async () => {
    const id = await anAsset();
    await expect(
      // @ts-expect-error — 'disposed' is deliberately outside the callable set.
      setAssetStatus(ownerCtx(), "owner", id, "disposed"),
    ).rejects.toBeInstanceOf(AssetStateError);
  });
});

describe("inspections and maintenance ride on the canonical work engine", () => {
  it(
    "an inspection updates the condition and can raise a real job",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      const job = await aJob("Fix the compressor");

      await recordInspection(foremanCtx(), "foreman", {
        assetId: id,
        inspectedOn: today,
        kind: "safety",
        passed: false,
        conditionFound: "poor",
        findings: "seal leaking",
        nextDueOn: soon(90),
        jobId: job.id,
      });
      const { asset } = await getAsset(ownerCtx(), "owner", id);
      expect(asset!.condition, "what the inspector found IS the condition").toBe("poor");
    },
  );

  it(
    "maintenance names the canonical job, and refuses a task from another one",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      const jobOne = await aJob("Service A");
      const jobTwo = await aJob("Service B");
      const strayTask = await aTask(jobTwo.id, "Belongs to B");

      await expect(
        recordMaintenance(foremanCtx(), "foreman", {
          assetId: id,
          performedOn: today,
          jobId: jobOne.id,
          taskId: strayTask,
        }),
      ).rejects.toBeInstanceOf(AssetError);

      // The right pairing is accepted, and the work stays where work lives.
      const ownTask = await aTask(jobOne.id, "Belongs to A");
      const ev = await recordMaintenance(foremanCtx(), "foreman", {
        assetId: id,
        performedOn: today,
        jobId: jobOne.id,
        taskId: ownTask,
        costMinor: 25_000,
        currency: "AED",
      });
      expect(ev.id).toBeTruthy();
    },
  );

  it(
    "a completed service rolls its schedule forward from the day it was done",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset();
      const plan = await createMaintenancePlan(foremanCtx(), "foreman", {
        assetId: id,
        nameEn: "500-hour service",
        intervalDays: 90,
        nextDueOn: soon(-5),
      });
      // Done five days late. The clock resets from when it HAPPENED.
      const doneOn = soon(-2);
      const result = await recordMaintenance(foremanCtx(), "foreman", {
        assetId: id,
        planId: plan.id,
        kind: "preventive",
        performedOn: doneOn,
      });
      expect(result.nextDueOn).toBe(soon(88));
    },
  );

  it("lists what is due, and excludes retired assets", { timeout: 300_000 }, async () => {
    const live = await anAsset();
    const dead = await anAsset();
    await createMaintenancePlan(foremanCtx(), "foreman", {
      assetId: live,
      nameEn: "Due soon",
      intervalDays: 30,
      nextDueOn: soon(3),
    });
    await createMaintenancePlan(foremanCtx(), "foreman", {
      assetId: dead,
      nameEn: "Never again",
      intervalDays: 30,
      nextDueOn: soon(3),
    });
    await setAssetStatus(ownerCtx(), "owner", dead, "retired", "scrapped");

    const due = await listMaintenanceDue(ownerCtx(), "owner", { withinDays: 10 });
    expect(due.some((d) => d.assetId === live)).toBe(true);
    expect(
      due.some((d) => d.assetId === dead),
      "a retired asset needs no service",
    ).toBe(false);
  });

  it("a schedule needs an interval", { timeout: 240_000 }, async () => {
    const id = await anAsset();
    await expect(
      createMaintenancePlan(foremanCtx(), "foreman", { assetId: id, nameEn: "Nothing" }),
    ).rejects.toThrow();
  });
});

describe("downtime is not the same as maintenance", () => {
  it("measures the whole spell, not just the repair", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    const started = new Date(Date.parse(`${today}T06:00:00Z`) - 3 * 86_400_000).toISOString();
    await startDowntime(foremanCtx(), "foreman", {
      assetId: id,
      startedAt: started,
      reason: "awaiting_parts",
      detail: "seal on order",
    });
    const closed = await endDowntime(foremanCtx(), "foreman", id, {
      endedAt: `${today}T06:00:00Z`,
    });
    expect(closed.minutes, "three days, not the two hours of work").toBe(3 * 24 * 60);

    const report = await assetDowntime(ownerCtx(), "owner", id);
    expect(report.totalMinutes).toBe(3 * 24 * 60);
  });

  it("an asset already down cannot break again", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await startDowntime(foremanCtx(), "foreman", { assetId: id, reason: "breakdown" });
    await expect(
      startDowntime(foremanCtx(), "foreman", { assetId: id, reason: "breakdown" }),
    ).rejects.toBeInstanceOf(AssetStateError);
  });

  it("closing when nothing is open is refused", { timeout: 240_000 }, async () => {
    const id = await anAsset();
    await expect(endDowntime(foremanCtx(), "foreman", id)).rejects.toBeInstanceOf(AssetStateError);
  });
});

describe("disposal is proposed, approved, then done", () => {
  it("takes three acts and two people", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    // The manager proposes.
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "sale",
      reason: "replaced by a larger unit",
      proposedProceedsMinor: 120_000,
      currency: "AED",
    });
    expect(request.reference).toMatch(/^ADP-\d{3}$/);

    // Not disposed yet, and not completable yet.
    await expect(
      completeDisposal(ownerCtx(), "owner", {
        disposalId: request.id,
        disposedOn: today,
        actualProceedsMinor: 100_000,
      }),
    ).rejects.toBeInstanceOf(AssetStateError);

    // The owner decides — a different person, through the ordinary engine.
    await decideApproval(ownerCtx(), "owner", {
      approvalId: request.approvalId,
      decision: "approved",
    });

    const done = await completeDisposal(ownerCtx(), "owner", {
      disposalId: request.id,
      disposedOn: today,
      actualProceedsMinor: 100_000,
      buyerName: "A buyer",
    });
    expect(done.assetId).toBe(id);

    const { asset } = await getAsset(ownerCtx(), "owner", id);
    expect(asset!.status).toBe("disposed");
    expect(asset!.disposed_at).toBeTruthy();
    expect(asset!.retired_at, "disposal retires it on the way past").toBeTruthy();
  });

  it("a sale has to say what it actually fetched", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "sale",
      reason: "surplus",
    });
    await decideApproval(ownerCtx(), "owner", {
      approvalId: request.approvalId,
      decision: "approved",
    });
    await expect(
      completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today }),
    ).rejects.toBeInstanceOf(AssetError);
  });

  it("cannot be completed twice", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "scrap",
      reason: "beyond repair",
    });
    await decideApproval(ownerCtx(), "owner", {
      approvalId: request.approvalId,
      decision: "approved",
    });
    await completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today });
    await expect(
      completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today }),
    ).rejects.toBeInstanceOf(AssetStateError);
  });

  it("a rejected request leaves the asset alone", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "write_off",
      reason: "cannot find it",
    });
    await decideApproval(ownerCtx(), "owner", {
      approvalId: request.approvalId,
      decision: "rejected",
      note: "look again",
    });
    const { asset } = await getAsset(ownerCtx(), "owner", id);
    expect(asset!.status, "still in service").toBe("in_service");
  });

  it("two people cannot dispose of the same asset at once", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "scrap",
      reason: "first request",
    });
    expect(
      await refusal(() =>
        requestDisposal(mgrCtx(), "admin", {
          assetId: id,
          method: "sale",
          reason: "second request",
        }),
      ),
    ).toMatch(/asset_disposal_open_uq/i);
  });

  it(
    "a withdrawn request can be put again, not left as a dead end",
    { timeout: 600_000 },
    async () => {
      /*
       * The approval engine parks a withdrawn disposal back at 'draft'. When a
       * draft counted as a live request and nothing could resubmit or cancel it,
       * withdrawing once made the asset permanently undisposable — and each retry
       * burned a reference number against a unique violation.
       */
      const id = await anAsset();
      const first = await requestDisposal(mgrCtx(), "admin", {
        assetId: id,
        method: "scrap",
        reason: "beyond repair",
      });
      await withdrawApproval(mgrCtx(), "admin", first.approvalId);

      // A draft holds no claim: a fresh request is accepted.
      const second = await requestDisposal(mgrCtx(), "admin", {
        assetId: id,
        method: "sale",
        reason: "actually worth selling",
        proposedProceedsMinor: 5_000,
      });
      expect(second.reference).not.toBe(first.reference);

      // And the parked one can be abandoned, or put again if it had been the keeper.
      await cancelDisposal(mgrCtx(), "admin", first.id, "superseded by the sale");
      const [parked] = (await owner`
      select status from public.asset_disposal where id = ${first.id}`) as unknown as Array<{
        status: string;
      }>;
      expect(parked!.status).toBe("cancelled");
    },
  );

  it("a resubmitted request goes back through approval", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "scrap",
      reason: "worn out",
    });
    await withdrawApproval(mgrCtx(), "admin", request.approvalId);

    const again = await resubmitDisposal(mgrCtx(), "admin", request.id, "still worn out");
    expect(again.approvalId).not.toBe(request.approvalId);
    await decideApproval(ownerCtx(), "owner", {
      approvalId: again.approvalId,
      decision: "approved",
    });
    await completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today });
    const { asset } = await getAsset(ownerCtx(), "owner", id);
    expect(asset!.status).toBe("disposed");
  });

  it("a disposed asset stays readable and stops being editable", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    const request = await requestDisposal(mgrCtx(), "admin", {
      assetId: id,
      method: "donation",
      reason: "given to a school",
    });
    await decideApproval(ownerCtx(), "owner", {
      approvalId: request.approvalId,
      decision: "approved",
    });
    await completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today });

    // Readable forever — the whole point of not deleting it.
    const { asset, custody } = await getAsset(ownerCtx(), "owner", id);
    expect(asset!.asset_no).toBeTruthy();
    expect(Array.isArray(custody)).toBe(true);

    expect(
      await refusal(() => owner`update public.asset set name_en = 'renamed' where id = ${id}`),
    ).toMatch(/has been disposed of/i);
  });
});

describe("permissions", () => {
  it("a foreman may hand out and maintain, but not register", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await assignAsset(foremanCtx(), "foreman", { assetId: id, toUserId: mgrUser });
    await recordInspection(foremanCtx(), "foreman", {
      assetId: id,
      inspectedOn: today,
      passed: true,
      conditionFound: "good",
    });
    await expect(
      registerAsset(foremanCtx(), "foreman", { nameEn: "Not allowed" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only owner and admin may propose a disposal", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await expect(
      requestDisposal(foremanCtx(), "foreman", {
        assetId: id,
        method: "scrap",
        reason: "not mine to decide",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      requestDisposal(mgrCtx(), "manager", { assetId: id, method: "scrap", reason: "nor mine" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a viewer cannot change anything", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    await expect(
      setAssetStatus(ctxOf(orgA, mgrUser), "viewer", id, "in_storage"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      assignAsset(ctxOf(orgA, mgrUser), "viewer", { assetId: id, toUserId: mgrUser }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("tenancy", () => {
  it(
    "another organization's asset is invisible and untouchable",
    { timeout: 300_000 },
    async () => {
      const mine = await anAsset();
      const outsider = ctxOf(orgB, outsiderUser);

      const list = await listAssets(outsider, "owner", {});
      expect(
        list.rows.some((r) => r.id === mine),
        "not in their register",
      ).toBe(false);

      const read = await getAsset(outsider, "owner", mine);
      expect(read.asset, "not readable").toBeNull();

      await expect(setAssetStatus(outsider, "owner", mine, "in_storage")).rejects.toBeInstanceOf(
        AssetError,
      );
      await expect(
        assignAsset(outsider, "owner", { assetId: mine, toUserId: outsiderUser }),
      ).rejects.toBeInstanceOf(AssetError);
    },
  );
});

describe("reading the register", () => {
  it("pages without skipping, and says when there is more", { timeout: 600_000 }, async () => {
    for (let i = 0; i < 5; i++) {
      await registerAsset(ownerCtx(), "owner", { nameEn: `Paged ${i}`, categoryId: categoryA });
    }
    const first = await listAssets(ownerCtx(), "owner", { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBeGreaterThan(2);

    const second = await listAssets(ownerCtx(), "owner", { limit: 2, cursor: first.nextCursor! });
    expect(second.rows).toHaveLength(2);
    // A cursor walks past what was read; an offset would skip rows as the
    // register grows underneath it.
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(seen.size).toBe(4);
  });

  it("finds an asset by number, name, serial or barcode", { timeout: 300_000 }, async () => {
    const a = await registerAsset(ownerCtx(), "owner", {
      nameEn: "Findable excavator",
      serialNo: "FIND-SN-9",
      barcode: "FIND-BC-9",
    });
    for (const term of ["Findable", "FIND-SN-9", "FIND-BC-9"]) {
      const found = await listAssets(ownerCtx(), "owner", { search: term });
      expect(
        found.rows.some((r) => r.id === a.id),
        `search: ${term}`,
      ).toBe(true);
    }
  });

  it("filters by custodian and by status", { timeout: 300_000 }, async () => {
    const held = await anAsset();
    await assignAsset(foremanCtx(), "foreman", { assetId: held, toUserId: foremanUser });

    const byHolder = await listAssets(ownerCtx(), "owner", { custodianUserId: foremanUser });
    expect(byHolder.rows.every((r) => r.custodianUserId === foremanUser)).toBe(true);
    expect(byHolder.rows.some((r) => r.id === held)).toBe(true);

    const inService = await listAssets(ownerCtx(), "owner", { status: "in_service" });
    expect(inService.rows.every((r) => r.status === "in_service")).toBe(true);
  });
});

describe("what the audit found and the tests had missed", () => {
  it("history refuses an edit even from the table OWNER", { timeout: 300_000 }, async () => {
    /*
     * 0091 called this append-only and enforced it by withholding an UPDATE
     * grant, which stops app_user and does not stop the connection that owns the
     * table — the same lesson H22B already wrote down. The original test used
     * that very connection and would have passed against nothing.
     */
    const id = await anAsset();
    const { eventId } = await assignAsset(foremanCtx(), "foreman", {
      assetId: id,
      toUserId: mgrUser,
    });
    expect(
      await refusal(
        () => owner`update public.asset_assignment set to_user_id = ${userA} where id = ${eventId}`,
      ),
    ).toMatch(/append-only/i);
    expect(
      await refusal(() => owner`delete from public.asset_assignment where id = ${eventId}`),
    ).toMatch(/append-only/i);
  });

  it("inspections and maintenance are history too", { timeout: 300_000 }, async () => {
    const id = await anAsset();
    const { id: inspection } = await recordInspection(foremanCtx(), "foreman", {
      assetId: id,
      inspectedOn: today,
      passed: false,
      conditionFound: "poor",
      findings: "cracked housing",
    });
    expect(
      await refusal(
        () => owner`update public.asset_inspection set passed = true where id = ${inspection}`,
      ),
    ).toMatch(/append-only/i);
  });

  it(
    "un-retiring clears the retirement, so it cannot be frozen later",
    { timeout: 600_000 },
    async () => {
      const id = await anAsset();
      await setAssetStatus(ownerCtx(), "owner", id, "retired", "thought it was finished");
      let read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.retired_at).toBeTruthy();

      // The retirement was a mistake, which the state machine explicitly allows.
      await setAssetStatus(ownerCtx(), "owner", id, "in_service");
      read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.retired_at, "a live asset is not a retired one").toBeNull();
      expect(read.asset!.retired_reason).toBeNull();

      // And a real disposal months later stamps the REAL date, not the old one.
      const request = await requestDisposal(mgrCtx(), "admin", {
        assetId: id,
        method: "scrap",
        reason: "finished for real this time",
      });
      await decideApproval(ownerCtx(), "owner", {
        approvalId: request.approvalId,
        decision: "approved",
      });
      await completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today });
      read = await getAsset(ownerCtx(), "owner", id);
      expect(read.asset!.retired_reason, "the stale reason did not survive").toBe("disposed");
    },
  );

  it(
    "a sale with no proceeds is refused in words, not by a constraint",
    { timeout: 600_000 },
    async () => {
      const id = await anAsset();
      const request = await requestDisposal(mgrCtx(), "admin", {
        assetId: id,
        method: "sale",
        reason: "surplus",
      });
      await decideApproval(ownerCtx(), "owner", {
        approvalId: request.approvalId,
        decision: "approved",
      });
      // Checked BEFORE the write, so the caller gets a sentence rather than 23514.
      await expect(
        completeDisposal(ownerCtx(), "owner", { disposalId: request.id, disposedOn: today }),
      ).rejects.toBeInstanceOf(AssetError);
      // And nothing was written: the disposal is still completable.
      const [still] = (await owner`
      select status from public.asset_disposal where id = ${request.id}`) as unknown as Array<{
        status: string;
      }>;
      expect(still!.status).toBe("approved");
    },
  );

  it(
    "acquisition cost follows the cost wall, not the view permission",
    { timeout: 300_000 },
    async () => {
      const id = await anAsset({ acquisitionCostMinor: 777_000 });
      const seen = { ...ownerCtx(), costPrivileged: true };
      const blind = { ...ownerCtx(), costPrivileged: false };

      const withCost = await listAssets(seen, "owner", { search: "Compressor" });
      expect(withCost.rows.some((r) => r.acquisitionCostMinor === 777_000)).toBe(true);

      const withoutCost = await listAssets(blind, "foreman", { search: "Compressor" });
      expect(
        withoutCost.rows.every((r) => r.acquisitionCostMinor === null),
        "a foreman sees the equipment, not what it cost",
      ).toBe(true);
      // Redacted, not hidden: the asset is still listed.
      expect(withoutCost.rows.some((r) => r.id === id)).toBe(true);

      const detail = await getAsset(blind, "foreman", id);
      expect(detail.asset!.acquisition_cost_minor).toBeNull();
      expect(detail.asset!.residual_value_minor).toBeNull();
    },
  );

  it("downtime totals cover every spell, not just the page", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    // Five one-hour spells, read back two at a time.
    for (let i = 0; i < 5; i++) {
      const from = new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 86_400_000);
      await startDowntime(foremanCtx(), "foreman", {
        assetId: id,
        startedAt: from.toISOString(),
        reason: "breakdown",
      });
      await endDowntime(foremanCtx(), "foreman", id, {
        endedAt: new Date(from.getTime() + 3_600_000).toISOString(),
      });
    }
    const page = await assetDowntime(ownerCtx(), "owner", id, { limit: 2 });
    expect(page.spells).toHaveLength(2);
    expect(page.totalSpells, "the count is of everything").toBe(5);
    expect(page.totalMinutes, "and so is the total: 5 hours, not 2").toBe(300);
    expect(page.truncated, "and it says the list is partial").toBe(true);
  });
});

describe("the audit trail", () => {
  it("records every act against the asset, by name", { timeout: 600_000 }, async () => {
    const id = await anAsset();
    await assignAsset(foremanCtx(), "foreman", { assetId: id, toUserId: mgrUser });
    await returnAsset(foremanCtx(), "foreman", { assetId: id });
    await recordInspection(foremanCtx(), "foreman", {
      assetId: id,
      inspectedOn: today,
      passed: true,
      conditionFound: "good",
    });

    const rows = (await owner`
      select action from public.audit_log
      where org_id = ${orgA} and entity_type = 'asset' and entity_id = ${id}
      order by created_at`) as unknown as Array<{ action: string }>;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("asset.status_changed");
    expect(actions).toContain("asset.assigned");
    expect(actions).toContain("asset.returned");
    expect(actions).toContain("asset.inspected");
  });
});
