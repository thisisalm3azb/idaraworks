/**
 * H20 — sales CRM against the real database: lead lifecycle, idempotent
 * conversion with evidence, pipeline stage configuration safety (rename,
 * reassign-then-deactivate, terminal protection), stage moves with activity
 * history, quotation linking, quotation ACCEPTANCE winning the opportunity
 * atomically (and only acceptance — never create or send), loss reasons,
 * follow-ups, overview parity, price redaction, role denial and
 * cross-organization isolation. Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import {
  createBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  applyBlueprintRevision,
} from "@/platform/workspace";
import { createCustomer } from "@/modules/masters/service";
import { createQuote, acceptQuote } from "@/modules/quotes/service";
import { listActivePresets } from "@/modules/jobs/service";
import {
  addSalesActivity,
  completeFollowUp,
  convertLead,
  countOverdueFollowUps,
  createLead,
  createOpportunity,
  deactivatePipelineStage,
  getLead,
  getOpportunity,
  listLeads,
  listOpportunities,
  listOverdueFollowUps,
  listPipelineStages,
  listSalesActivities,
  loseOpportunity,
  moveOpportunityStage,
  salesDashboardCounts,
  salesOverview,
  setLeadStatus,
  setLeadArchived,
  StageNotEmptyError,
  updatePipelineStage,
  winOpportunity,
} from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { scenarioContractor } from "../unit/workspace-fixtures";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let presetA = "";
let custId = "";

const ctxOf = (orgId: string, userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "h20-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const daysAgo = (n: number) => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h20-${label}-${run}@example.com`}, '{"full_name":"H20 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H20 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H20 B", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  const draft = await createBlueprintDraft(ctxOf(orgA, userA), "owner", {
    blueprint: scenarioContractor(),
    source: "onboarding_answer",
    reason: "H20 sales test",
  });
  await validateBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  await approveBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id, {
    expectedHash: draft.blueprintHash,
  });
  await applyBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
  ({ id: custId } = await createCustomer(ctxOf(orgA, userA), "owner", {
    name: "Harbour Marine Services",
    email: "ops@harbour.example",
    phone: "+971 4 555 0100",
  }));
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("H20 — lead lifecycle", () => {
  let leadId = "";

  it("creates, lists with server-side filters, and transitions status", async () => {
    ({ id: leadId } = await createLead(ctxOf(orgA, userA), "owner", {
      name: "Pearl Diving Tours",
      contactName: "Saif",
      phone: "050 111 2233",
      email: "saif@pearl.example",
      source: "referral",
    }));
    const all = await listLeads(ctxOf(orgA, userA), "owner", {});
    expect(all.some((l) => l.id === leadId && l.status === "new")).toBe(true);
    const byQ = await listLeads(ctxOf(orgA, userA), "owner", { q: "pearl" });
    expect(byQ.some((l) => l.id === leadId)).toBe(true);
    const bySource = await listLeads(ctxOf(orgA, userA), "owner", { source: "referral" });
    expect(bySource.some((l) => l.id === leadId)).toBe(true);
    await setLeadStatus(ctxOf(orgA, userA), "owner", leadId, "contacted");
    const contacted = await listLeads(ctxOf(orgA, userA), "owner", { status: "contacted" });
    expect(contacted.some((l) => l.id === leadId)).toBe(true);
    expect(
      (await listLeads(ctxOf(orgA, userA), "owner", { status: "new" })).some(
        (l) => l.id === leadId,
      ),
    ).toBe(false);
  });

  it("overdue follow-ups surface, count, and complete", async () => {
    const { id: activityId } = await addSalesActivity(
      ctxOf(orgA, userA),
      "owner",
      { leadId },
      { kind: "follow_up", body: "Call Saif back", dueDate: daysAgo(3) },
    );
    const overdueLeads = await listLeads(ctxOf(orgA, userA), "owner", { overdueFollowUp: asOf });
    expect(overdueLeads.some((l) => l.id === leadId)).toBe(true);
    expect(overdueLeads.find((l) => l.id === leadId)!.nextFollowUpDue).toBe(daysAgo(3));
    const overdue = await listOverdueFollowUps(ctxOf(orgA, userA), "owner", asOf);
    expect(overdue.some((a) => a.id === activityId && a.leadName === "Pearl Diving Tours")).toBe(
      true,
    );
    expect(await countOverdueFollowUps(ctxOf(orgA, userA), "owner", asOf)).toBeGreaterThanOrEqual(
      1,
    );
    await completeFollowUp(ctxOf(orgA, userA), "owner", activityId);
    expect(
      (await listOverdueFollowUps(ctxOf(orgA, userA), "owner", asOf)).some(
        (a) => a.id === activityId,
      ),
    ).toBe(false);
    // A follow-up without a due date is refused.
    await expect(
      addSalesActivity(ctxOf(orgA, userA), "owner", { leadId }, { kind: "follow_up" }),
    ).rejects.toThrow();
  });

  it("conversion is idempotent, evidence-preserving, and can create the customer", async () => {
    const first = await convertLead(ctxOf(orgA, userA), "owner", leadId, {
      createCustomer: true,
      estimatedValueMinor: 250000,
      expectedCloseDate: asOf,
    });
    expect(first.deduped).toBe(false);
    expect(first.customerId).toBeTruthy();
    const opp = await getOpportunity(ctxOf(orgA, userA), "owner", first.opportunityId);
    expect(opp!.stageKey).toBe("qualified");
    expect(opp!.status).toBe("open");
    expect(opp!.leadId).toBe(leadId);
    expect(opp!.estimatedValueMinor).toBe(250000);
    // The lead SURVIVES with its identity and carries conversion evidence.
    const lead = await getLead(ctxOf(orgA, userA), "owner", leadId);
    expect(lead!.status).toBe("converted");
    expect(lead!.name).toBe("Pearl Diving Tours");
    expect(lead!.convertedOpportunityId).toBe(first.opportunityId);
    expect(lead!.convertedCustomerId).toBe(first.customerId);
    // Idempotent: the second call returns the SAME conversion, creates nothing.
    const second = await convertLead(ctxOf(orgA, userA), "owner", leadId, {
      createCustomer: true,
    });
    expect(second.deduped).toBe(true);
    expect(second.opportunityId).toBe(first.opportunityId);
    expect(second.customerId).toBe(first.customerId);
    const opps = await listOpportunities(ctxOf(orgA, userA), "owner", {});
    expect(opps.filter((o) => o.leadId === leadId).length).toBe(1);
  });

  it("a disqualified lead refuses conversion; archived leads stay readable", async () => {
    const { id: dq } = await createLead(ctxOf(orgA, userA), "owner", { name: "Cold Call Co" });
    await setLeadStatus(ctxOf(orgA, userA), "owner", dq, "disqualified");
    await expect(convertLead(ctxOf(orgA, userA), "owner", dq, {})).rejects.toThrow(/disqualified/);
    await setLeadArchived(ctxOf(orgA, userA), "owner", dq, true);
    expect(
      (await listLeads(ctxOf(orgA, userA), "owner", { archived: true })).some((l) => l.id === dq),
    ).toBe(true);
    expect((await listLeads(ctxOf(orgA, userA), "owner", {})).some((l) => l.id === dq)).toBe(false);
  });
});

describe("H20 — pipeline configuration safety", () => {
  it("reads serve code defaults before any write materializes rows", async () => {
    const stages = await listPipelineStages(ctxOf(orgB, userB), "owner");
    expect(stages.map((s) => s.key)).toContain("negotiation");
    const rows = await owner`
      select count(*)::int as n from public.pipeline_stage where org_id = ${orgB}`;
    expect(Number((rows as unknown as Array<{ n: number }>)[0]!.n)).toBe(0);
  });

  it("renames labels without touching keys or records", async () => {
    await updatePipelineStage(ctxOf(orgA, userA), "owner", "proposal", {
      labelEn: "Offer sent",
      labelAr: "أرسل العرض",
    });
    const stages = await listPipelineStages(ctxOf(orgA, userA), "owner");
    const proposal = stages.find((s) => s.key === "proposal");
    expect(proposal!.label.en).toBe("Offer sent");
    expect(proposal!.category).toBe("open");
  });

  it("deactivation refuses while opportunities sit in the stage, then moves them", async () => {
    const { id } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Stage safety probe",
      stageKey: "proposal",
    });
    await expect(deactivatePipelineStage(ctxOf(orgA, userA), "owner", "proposal")).rejects.toThrow(
      StageNotEmptyError,
    );
    await deactivatePipelineStage(ctxOf(orgA, userA), "owner", "proposal", {
      reassignTo: "negotiation",
    });
    const moved = await getOpportunity(ctxOf(orgA, userA), "owner", id);
    expect(moved!.stageKey).toBe("negotiation");
    const stages = await listPipelineStages(ctxOf(orgA, userA), "owner");
    expect(stages.find((s) => s.key === "proposal")!.active).toBe(false);
    // Terminal stages can never be deactivated.
    await expect(deactivatePipelineStage(ctxOf(orgA, userA), "owner", "won")).rejects.toThrow(
      /terminal/,
    );
  });

  it("stage moves validate the target, record history, and no-op on same stage", async () => {
    const { id } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Board move probe",
    });
    const moved = await moveOpportunityStage(ctxOf(orgA, userA), "owner", id, "contacted");
    expect(moved.moved).toBe(true);
    const again = await moveOpportunityStage(ctxOf(orgA, userA), "owner", id, "contacted");
    expect(again.moved).toBe(false);
    await expect(
      moveOpportunityStage(ctxOf(orgA, userA), "owner", id, "no_such_stage"),
    ).rejects.toThrow(/invalid stage/);
    // The deactivated stage is refused as a move target too.
    await expect(moveOpportunityStage(ctxOf(orgA, userA), "owner", id, "proposal")).rejects.toThrow(
      /invalid stage/,
    );
    const acts = await listSalesActivities(ctxOf(orgA, userA), "owner", { opportunityId: id });
    const change = acts.find((a) => a.kind === "stage_change");
    expect(change!.body).toBe("new|contacted");
  });
});

describe("H20 — quotation contracts (link, accepted → won, loss)", () => {
  let oppId = "";
  let quoteId = "";

  it("creating a quotation with an opportunity links it and records the activity", async () => {
    ({ id: oppId } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Harbour refit",
      customerId: custId,
      estimatedValueMinor: 900000,
    }));
    const q = await createQuote(ctxOf(orgA, userA), "owner", {
      customerId: custId,
      presetId: presetA,
      opportunityId: oppId,
      lines: [{ description: "Refit phase one", qty: 1, unit: "lot", unitPriceMinor: 750000 }],
    });
    quoteId = q.id;
    const opp = await getOpportunity(ctxOf(orgA, userA), "owner", oppId);
    expect(opp!.quoteId).toBe(quoteId);
    // Creation NEVER wins: the opportunity stays open in its stage.
    expect(opp!.status).toBe("open");
    const acts = await listSalesActivities(ctxOf(orgA, userA), "owner", { opportunityId: oppId });
    expect(acts.some((a) => a.kind === "quote_created")).toBe(true);
    expect(acts.some((a) => a.kind === "won")).toBe(false);
  });

  it("acceptance wins the opportunity atomically; repeat wins are no-ops", async () => {
    await owner`update public.quote set status = 'sent', updated_at = now()
                where id = ${quoteId} and org_id = ${orgA}`;
    const { jobId } = await acceptQuote(ctxOf(orgA, userA), "owner", quoteId, {
      jobName: "Harbour refit job",
    });
    expect(jobId).toBeTruthy();
    const opp = await getOpportunity(ctxOf(orgA, userA), "owner", oppId);
    expect(opp!.status).toBe("won");
    expect(opp!.stageKey).toBe("won");
    expect(opp!.wonAt).toBeTruthy();
    const acts = await listSalesActivities(ctxOf(orgA, userA), "owner", { opportunityId: oppId });
    expect(acts.filter((a) => a.kind === "won").length).toBe(1);
    // Idempotent: an explicit win on an already-closed opportunity changes nothing.
    const again = await winOpportunity(ctxOf(orgA, userA), "owner", oppId);
    expect(again.changed).toBe(false);
    expect(
      (await listSalesActivities(ctxOf(orgA, userA), "owner", { opportunityId: oppId })).filter(
        (a) => a.kind === "won",
      ).length,
    ).toBe(1);
  });

  it("a closed opportunity refuses new quotation links", async () => {
    await expect(
      createQuote(ctxOf(orgA, userA), "owner", {
        customerId: custId,
        opportunityId: oppId,
        lines: [{ description: "Late line", qty: 1, unit: "lot", unitPriceMinor: 100 }],
      }),
    ).rejects.toThrow(/opportunity not open/);
  });

  it("losing requires an approved reason and is idempotent", async () => {
    const { id } = await createOpportunity(ctxOf(orgA, userA), "owner", {
      name: "Lost cause",
      estimatedValueMinor: 50000,
    });
    await expect(
      loseOpportunity(ctxOf(orgA, userA), "owner", id, { reason: "vibes" }),
    ).rejects.toThrow();
    const lost = await loseOpportunity(ctxOf(orgA, userA), "owner", id, {
      reason: "price",
      note: "Budget cut in half",
    });
    expect(lost.changed).toBe(true);
    const opp = await getOpportunity(ctxOf(orgA, userA), "owner", id);
    expect(opp!.status).toBe("lost");
    expect(opp!.lossReason).toBe("price");
    expect(opp!.lostAt).toBeTruthy();
    expect(
      (await loseOpportunity(ctxOf(orgA, userA), "owner", id, { reason: "other" })).changed,
    ).toBe(false);
    expect((await getOpportunity(ctxOf(orgA, userA), "owner", id))!.lossReason).toBe("price");
  });
});

describe("H20 — overview parity, redaction, isolation, roles", () => {
  it("overview and dashboard counts agree with the lists they drill into", async () => {
    const ctx = ctxOf(orgA, userA);
    const [overview, counts, openList] = await Promise.all([
      salesOverview(ctx, "owner", { asOf, days: 30 }),
      salesDashboardCounts(ctx, "owner", { asOf, horizonDays: 30 }),
      listOpportunities(ctx, "owner", { status: "open" }),
    ]);
    const openByStageTotal = overview.openByStage.reduce((a, s) => a + s.count, 0);
    expect(openByStageTotal).toBe(openList.length);
    expect(counts.openPipelineCount).toBe(openList.length);
    const closing = await listOpportunities(ctx, "owner", {
      closingWithinDays: { asOf, days: 30 },
    });
    expect(counts.closingSoon).toBe(closing.length);
    expect(overview.wonCount).toBeGreaterThanOrEqual(1);
    expect(overview.lostCount).toBeGreaterThanOrEqual(1);
    expect(overview.lossReasons.some((r) => r.reason === "price")).toBe(true);
    expect(overview.leadsCreated).toBeGreaterThanOrEqual(1);
    expect(overview.leadsConverted).toBeGreaterThanOrEqual(1);
  });

  it("without price privilege every forecast value is null, never zero", async () => {
    const noPrice = ctxOf(orgA, userA, false);
    const opps = await listOpportunities(noPrice, "owner", {});
    expect(opps.length).toBeGreaterThan(0);
    expect(opps.every((o) => o.estimatedValueMinor === null)).toBe(true);
    const overview = await salesOverview(noPrice, "owner", { asOf, days: 30 });
    expect(overview.openByStage.every((s) => s.forecastMinor === null)).toBe(true);
    expect(overview.wonForecastMinor).toBeNull();
    const counts = await salesDashboardCounts(noPrice, "owner", { asOf, horizonDays: 30 });
    expect(counts.openPipelineMinor).toBeNull();
    expect(counts.openPipelineCount).toBeGreaterThan(0); // counts stay real
  });

  it("cross-organization isolation: org B reads and moves nothing of org A", async () => {
    const leadsA = await listLeads(ctxOf(orgA, userA), "owner", {});
    const oppsA = await listOpportunities(ctxOf(orgA, userA), "owner", { status: "all" });
    expect(leadsA.length).toBeGreaterThan(0);
    const bLeads = await listLeads(ctxOf(orgB, userB), "owner", {});
    expect(bLeads.some((l) => leadsA.some((a) => a.id === l.id))).toBe(false);
    expect(await getLead(ctxOf(orgB, userB), "owner", leadsA[0]!.id)).toBeNull();
    expect(await getOpportunity(ctxOf(orgB, userB), "owner", oppsA[0]!.id)).toBeNull();
    const foreign = await moveOpportunityStage(
      ctxOf(orgB, userB),
      "owner",
      oppsA.find((o) => o.status === "open")!.id,
      "contacted",
    );
    expect(foreign.moved).toBe(false); // matches zero rows, changes nothing
  });

  it("roles: viewer cannot read leads; accounts sees opportunities but cannot manage", async () => {
    await expect(listLeads(ctxOf(orgA, userA), "viewer", {})).rejects.toThrow();
    await expect(
      createOpportunity(ctxOf(orgA, userA), "accounts", { name: "Nope" }),
    ).rejects.toThrow();
    const seen = await listOpportunities(ctxOf(orgA, userA, false), "accounts", {});
    expect(Array.isArray(seen)).toBe(true);
    await expect(
      updatePipelineStage(ctxOf(orgA, userA), "manager", "new", { labelEn: "X" }),
    ).rejects.toThrow(); // pipeline.configure is owner/admin only
  });
});
