/**
 * H27A — the Revenue Studio foundation on the TEST project: the default
 * pipeline materialises and adopts the H20 stages; stage requirements refuse
 * a move until the facts exist; a governed move records who/why/how long and
 * refuses a stale row version; a discount routes through the shared approvals
 * engine and the decision lands back on the opportunity; activities log,
 * complete with outcomes and recur; the customer's revenue 360 shows an
 * evidence-based health score and consent/suppression; a viewer reads only;
 * another organisation sees nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import { createCustomer, addCustomerContact } from "@/modules/masters/service";
import {
  addProductLine,
  addStakeholder,
  boardPage,
  completeActivity,
  createOpportunity,
  gatherDealRoom,
  gatherRevenue360,
  getOpportunity,
  listActivities,
  listDiscounts,
  listPipelines,
  listStageSettings,
  logActivity,
  moveStage,
  myCommercialQueue,
  recordSignal,
  requestDiscount,
  scoreHealth,
  unmetRequirements,
  updateCommercial,
  updateCustomerCrm,
  updateStageSettings,
} from "@/modules/crm/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
const userV = randomUUID();
let orgA = "";
let orgB = "";
const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h27a",
});
const A = () => ctxOf(orgA, userA);
const V = () => ctxOf(orgA, userV);
const B = () => ctxOf(orgB, userB);
const today = new Date().toISOString().slice(0, 10);
const plus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userB, "Other"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h27a-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H27A A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H27A B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h27a", run);
  await markFixtureOrg(owner, orgB, "h27a", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB, userV]);
  await owner.end();
  await closeAppDb();
});

describe("pure rules", () => {
  it("unmet requirements and health scoring are explainable", () => {
    expect(
      unmetRequirements(["value", "close_date", "stakeholder"], {
        valueMinor: 0,
        closeDate: today,
        customerId: null,
        contactCount: 0,
        stakeholderCount: 1,
        nextAction: null,
        productCount: 0,
        quoteId: null,
        decisionCriteria: null,
      }),
    ).toEqual(["value"]);
    const h = scoreHealth([
      { key: "a", label: "A", weight: 1, value: 1, evidence: "" },
      { key: "b", label: "B", weight: 1, value: null, evidence: "" },
    ]);
    expect(h.score).toBe(100);
    expect(h.knownSignals).toBe(1);
    expect(scoreHealth([]).band).toBe("unknown");
  });
});

describe("pipelines and governed moves", () => {
  let customerId = "";
  let oppId = "";
  let rowVersion = 1;

  it("the default pipeline materialises and adopts the stages; requirements gate a move", async () => {
    const c = await createCustomer(A(), "owner", { name: `Marina ${run}`, country: "AE" });
    customerId = c.id;
    const opp = await createOpportunity(A(), "owner", {
      name: `Refit ${run}`,
      customerId,
      estimatedValueMinor: 0,
    });
    oppId = opp.id;
    await updateStageSettings(A(), "owner", {
      stageKey: "proposal",
      requirements: ["value", "stakeholder"],
      defaultProbability: 50,
      maxAgeDays: 30,
    });
    const pipelines = await listPipelines(A(), "owner");
    expect(pipelines.length).toBe(1);
    expect(pipelines[0]!.isDefault).toBe(true);
    const stages = await listStageSettings(A(), "owner", pipelines[0]!.id);
    expect(stages.every((s) => s.pipelineId === pipelines[0]!.id)).toBe(true);
    expect(stages.find((s) => s.key === "proposal")?.requirements).toEqual([
      "value",
      "stakeholder",
    ]);
    const detail = await getOpportunity(A(), "owner", oppId);
    rowVersion = 1;
    await expect(
      moveStage(A(), "owner", { id: oppId, stageKey: "proposal", rowVersion }),
    ).rejects.toMatchObject({ code: "requirements", details: ["value", "stakeholder"] });
    expect(detail?.stageKey).not.toBe("proposal");
    await expect(
      updateStageSettings(V(), "viewer", { stageKey: "proposal", requirements: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("products set the value, a stakeholder satisfies coverage, the move is recorded with who/why/age; stale versions conflict", async () => {
    await addProductLine(A(), "owner", {
      opportunityId: oppId,
      description: "Hull refit",
      qty: 1,
      unitPriceMinor: 12_000_000,
      vatRate: 5,
      unitCostMinor: 8_000_000,
    });
    await addStakeholder(A(), "owner", {
      opportunityId: oppId,
      name: "Captain Rashid",
      roleKind: "decision_maker",
      influence: 5,
      sentiment: "supporter",
    });
    const room = await gatherDealRoom(A(), "owner", oppId);
    expect(room.totals.netMinor).toBe(12_000_000);
    expect(room.totals.vatMinor).toBe(600_000);
    expect(room.totals.marginMinor).toBe(4_000_000);
    expect(room.coverage.decisionMaker).toBe(true);
    const moved = await moveStage(A(), "owner", {
      id: oppId,
      stageKey: "proposal",
      rowVersion,
      reason: "Scope agreed on site",
    });
    expect(moved.moved).toBe(true);
    expect(moved.rowVersion).toBe(rowVersion + 1);
    rowVersion = moved.rowVersion;
    await expect(
      moveStage(A(), "owner", { id: oppId, stageKey: "negotiation", rowVersion: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    const after = await gatherDealRoom(A(), "owner", oppId);
    expect(after.stageHistory.length).toBe(1);
    expect(after.stageHistory[0]!.to).toBe("proposal");
    expect(after.stageHistory[0]!.reason).toBe("Scope agreed on site");
    expect(after.stageHistory[0]!.ageDays).toBe(0);
    // The board aggregates across the full result, with weighted value from the stage default.
    const board = await boardPage(A(), "owner", { status: "open" });
    const stage = board.stages.find((s) => s.stageKey === "proposal");
    expect(stage?.count).toBe(1);
    expect(stage?.valueMinor).toBe(12_000_000);
    expect(stage?.weightedMinor).toBe(6_000_000);
    expect(board.totals.count).toBe(board.total);
    // Money is redacted for a non-price-privileged reader.
    const blind = await boardPage({ ...A(), pricePrivileged: false }, "owner", { status: "open" });
    expect(blind.totals.valueMinor).toBeNull();
    expect(blind.rows[0]!.estimatedValueMinor).toBeNull();
  });

  it("a forecast category change is recorded; a discount routes through the approvals engine", async () => {
    const r = await updateCommercial(A(), "owner", {
      id: oppId,
      rowVersion,
      forecastCategory: "commit",
      expectedCloseDate: plus(20),
      decisionCriteria: "Price and delivery date",
    });
    rowVersion = r.rowVersion;
    const room = await gatherDealRoom(A(), "owner", oppId);
    expect(room.forecastHistory.map((f) => f.to)).toEqual(["commit"]);
    const d = await requestDiscount(A(), "owner", {
      opportunityId: oppId,
      requestedPct: 12,
      listTotalMinor: 12_000_000,
      currency: "AED",
      reason: "Repeat customer",
    });
    expect(d.status).toBe("pending");
    expect(d.discountedTotalMinor).toBe(10_560_000);
    await expect(
      requestDiscount(A(), "owner", {
        opportunityId: oppId,
        requestedPct: 5,
        listTotalMinor: 12_000_000,
        currency: "AED",
        reason: "again",
      }),
    ).rejects.toThrow(/already pending/);
    // Decide through the engine as a second person would (the owner is also the requester, so
    // the engine escalates the assignment; decide as owner archetype via the approval id).
    const pending = await listInbox(A(), "owner");
    const mine = pending.find((p) => p.subjectType === "crm_discount" && p.subjectId === d.id);
    expect(mine).toBeTruthy();
    await decideApproval(A(), "owner", { approvalId: mine!.id, decision: "approved", note: "ok" });
    const after = await listDiscounts(A(), "owner", oppId);
    expect(after[0]!.status).toBe("approved");
    expect(after[0]!.decidedAt).not.toBeNull();
    const room2 = await gatherDealRoom(A(), "owner", oppId);
    expect(room2.discounts[0]!.status).toBe("approved");
  });

  it("activities log, complete with an outcome, recur, and feed the queue", async () => {
    const call = await logActivity(A(), "owner", {
      opportunityId: oppId,
      kind: "call",
      title: "Intro call",
      outcome: "positive",
      completed: true,
      participants: [{ kind: "external", name: "Captain Rashid" }],
      templateKey: "discovery_call",
    });
    expect(call.outcome).toBe("positive");
    const list = await listActivities(A(), "owner", { opportunityId: oppId });
    // The completed template call spawned its follow-up.
    expect(list.rows.some((a) => a.kind === "follow_up" && a.meta.spawnedBy === call.id)).toBe(
      true,
    );
    const task = await logActivity(A(), "owner", {
      customerId,
      kind: "task",
      title: "Send brochure",
      dueDate: plus(-1),
      recurrenceDays: 7,
    });
    const q = await myCommercialQueue(A(), "owner", today);
    expect(q.overdue.some((a) => a.id === task.id)).toBe(true);
    const done = await completeActivity(A(), "owner", {
      id: task.id,
      outcome: "completed",
      note: "Sent",
    });
    expect(done.nextId).not.toBeNull();
    await expect(completeActivity(A(), "owner", { id: task.id })).rejects.toMatchObject({
      code: "state",
    });
    await expect(
      logActivity(V(), "viewer", { customerId, kind: "note", body: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the revenue 360 shows ownership, contacts with roles, consent, signals and an explained health score; other orgs see nothing", async () => {
    await updateCustomerCrm(A(), "owner", {
      customerId,
      ownerUserId: userA,
      tags: ["vip", "marina"],
      segment: "marine",
    });
    await addCustomerContact(A(), "owner", customerId, {
      name: "Salma",
      email: "salma@example.invalid",
    });
    await recordSignal(A(), "owner", { customerId, kind: "satisfaction", score: 4 });
    await owner`
      insert into public.crm_suppression (org_id, channel, address, reason) values (${orgA}, 'email', 'salma@example.invalid', 'unsubscribe')`;
    const x = await gatherRevenue360(A(), "owner", customerId);
    expect(x.crm.ownerUserId).toBe(userA);
    expect(x.crm.tags).toEqual(["vip", "marina"]);
    expect(x.contacts[0]!.consent.email).toBe("suppressed");
    expect(x.health.score).not.toBeNull();
    expect(x.health.signals.find((s) => s.key === "satisfaction")?.value).toBe(0.5);
    expect(x.health.signals.every((s) => s.evidence.length > 0)).toBe(true);
    // Least privilege: a viewer holds no customers.view lane at all.
    await expect(gatherRevenue360(V(), "viewer", customerId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(gatherRevenue360(B(), "owner", customerId)).rejects.toThrow(/not found/);
    expect((await boardPage(B(), "owner", { status: "all" })).total).toBe(0);
    await expect(gatherDealRoom(B(), "owner", oppId)).resolves.toMatchObject({ stakeholders: [] });
  });
});
