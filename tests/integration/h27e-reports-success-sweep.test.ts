/**
 * H27E — reports, the success overview and the platform sweep on the TEST
 * project: funnel, win/loss and activity reports aggregate across the whole
 * organisation with their basis stated; the success overview scores every
 * active customer with evidence and counts bands across the full set; the
 * daily sweep discovers only organisations with enabled live automations,
 * applies each matching subject once, and a second sweep applies nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import {
  activityReport,
  boardPage,
  captureLead,
  computeForecast,
  listPipelines,
  listStageSettings,
  convertLeadSafely,
  createAutomation,
  funnelReport,
  listActivities,
  logActivity,
  recordSignal,
  successOverview,
  winLossReport,
} from "@/modules/crm/service";
import { sweepCrmAutomations } from "@/workers";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userV = randomUUID();
let orgA = "";
const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h27e",
});
const A = () => ctxOf(userA);
const V = () => ctxOf(userV);

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h27e-${name.toLowerCase()}-${run}@example.invalid`}, ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H27E", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h27e", run);
  await owner`insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en') on conflict (id) do nothing`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userV]);
  await owner.end();
  await closeAppDb();
});

describe("reports and success", () => {
  it("aggregate across the organisation with a stated basis and redact money by privilege", async () => {
    const good = await createCustomer(A(), "owner", { name: `Good Co ${run}`, country: "AE" });
    const risky = await createCustomer(A(), "owner", { name: `Risky Co ${run}`, country: "AE" });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const cap = await captureLead(A(), "owner", {
        name: `Lead ${i} ${run}`,
        sourceKind: i % 2 ? "referral" : "manual",
      });
      const conv = await convertLeadSafely(A(), "owner", {
        leadId: cap.lead.id,
        customerId: i % 2 ? risky.id : good.id,
        opportunityName: `Deal ${i} ${run}`,
        estimatedValueMinor: (i + 1) * 100000,
      });
      ids.push(conv.opportunityId);
    }
    await captureLead(A(), "owner", { name: `Unconverted ${run}`, sourceKind: "form" });
    await owner`update public.opportunity set status = 'won', stage_key = 'won', won_at = now() where id in (${ids[0]!}, ${ids[1]!})`;
    await owner`update public.opportunity set status = 'lost', stage_key = 'lost', lost_at = now(), loss_reason = 'price' where id = ${ids[2]!}`;
    await logActivity(A(), "owner", {
      customerId: good.id,
      kind: "call",
      title: "Check-in",
      outcome: "positive",
    });
    await logActivity(A(), "owner", {
      customerId: risky.id,
      kind: "task",
      title: "Chase",
      dueDate: "2020-01-01",
    });
    await recordSignal(A(), "owner", {
      customerId: risky.id,
      kind: "churn_risk",
      score: 80,
      status: "at_risk",
    });
    await recordSignal(A(), "owner", { customerId: good.id, kind: "satisfaction", score: 5 });

    const f = await funnelReport(A(), "owner", {});
    expect(f.leads.total).toBe(7);
    expect(f.leads.quarantined).toBe(1);
    expect(f.leads.bySource.referral).toBe(3);
    expect(f.opportunities.created).toBe(6);
    expect(f.opportunities.won.count).toBe(2);
    expect(f.opportunities.won.valueMinor).toBe(300000);
    expect(f.opportunities.lost.count).toBe(1);
    expect(f.opportunities.open).toBe(3);
    expect(f.conversion.opportunityToWonPct).toBeCloseTo(33.3, 0);
    expect(f.basis).toContain("creation date");
    const redacted = await funnelReport({ ...A(), pricePrivileged: false }, "owner", {});
    expect(redacted.opportunities.won.valueMinor).toBeNull();

    const w = await winLossReport(A(), "owner", {});
    expect(w.won.count).toBe(2);
    expect(w.lost.count).toBe(1);
    expect(w.winRatePct).toBeCloseTo(66.7, 0);
    expect(w.lossReasons).toEqual([{ reason: "price", count: 1 }]);
    const act = await activityReport(A(), "owner", {});
    expect(act.total).toBeGreaterThanOrEqual(2);
    expect(act.byKind.some((k) => k.kind === "call")).toBe(true);
    await expect(funnelReport(V(), "viewer", {})).rejects.toBeInstanceOf(ForbiddenError);

    const s = await successOverview(A(), "owner", { limit: 50 });
    expect(s.total).toBe(2);
    const r = s.rows.find((x) => x.id === risky.id)!;
    const g = s.rows.find((x) => x.id === good.id)!;
    expect(r.churnRisk).toBe(80);
    expect(g.satisfaction).toBe(5);
    // Same model as the 360: a churn record lowers the score with its evidence shown.
    expect(r.health.score!).toBeLessThan(g.health.score!);
    expect(r.health.signals.find((sig) => sig.key === "churn")?.value).toBeLessThan(0);
    expect(r.health.signals.find((sig) => sig.key === "churn")?.evidence).toContain("80/100");
    expect(r.health.signals.every((sig) => typeof sig.evidence === "string")).toBe(true);
    expect(s.counts.atRisk + s.counts.watch + s.counts.healthy + s.counts.unknown).toBe(2);
    const onlyBand = await successOverview(A(), "owner", { band: r.health.band });
    expect(onlyBand.rows.some((x) => x.id === risky.id)).toBe(true);
    expect(
      onlyBand.counts.healthy +
        onlyBand.counts.watch +
        onlyBand.counts.atRisk +
        onlyBand.counts.unknown,
    ).toBe(2); // counts stay full-set when filtered
  });
});

describe("the virtual default pipeline", () => {
  it("reads work before any write has materialised a pipeline row (empty id means all)", async () => {
    const pipelines = await listPipelines(A(), "owner");
    expect(pipelines.length).toBeGreaterThanOrEqual(1);
    const id = pipelines.find((p) => p.isDefault)?.id ?? "";
    const stages = await listStageSettings(A(), "owner", id);
    expect(stages.length).toBeGreaterThan(0);
    const board = await boardPage(A(), "owner", { pipelineId: id, status: "all", limit: 5 });
    expect(board.total).toBeGreaterThanOrEqual(0);
    const forecast = await computeForecast(A(), "owner", { pipelineId: id });
    expect(forecast.rows.length).toBeGreaterThanOrEqual(0);
  });
});

describe("the daily sweep", () => {
  it("discovers only organisations with enabled live automations and applies each subject once", async () => {
    const c = await createCustomer(A(), "owner", { name: `Sweep Co ${run}`, country: "AE" });
    const cap = await captureLead(A(), "owner", {
      name: `Sweep lead ${run}`,
      sourceKind: "manual",
    });
    const conv = await convertLeadSafely(A(), "owner", {
      leadId: cap.lead.id,
      customerId: c.id,
      opportunityName: `Sweep deal ${run}`,
      estimatedValueMinor: 50000,
    });
    await owner`update public.opportunity set stage_entered_at = now() - interval '40 days' where id = ${conv.opportunityId}`;
    const before =
      (await owner`select org_id::text as org_id from app.orgs_with_crm_automations()`) as unknown as Array<{
        org_id: string;
      }>;
    expect(before.some((r) => r.org_id === orgA)).toBe(false); // no live automation yet
    await createAutomation(A(), "owner", {
      name: `Sweep ageing ${run}`,
      trigger: "opportunity_stage_aged",
      conditions: { all: [{ key: "stage_age_days", op: "gte", value: 30 }] },
      actions: [{ kind: "create_task", title: "Sweep task", dueInDays: 1 }],
      enabled: true,
      dryRun: false,
    });
    const after =
      (await owner`select org_id::text as org_id from app.orgs_with_crm_automations()`) as unknown as Array<{
        org_id: string;
      }>;
    expect(after.some((r) => r.org_id === orgA)).toBe(true);
    const first = await sweepCrmAutomations(`h27e-${run}`);
    expect(first.orgs).toBeGreaterThanOrEqual(1);
    const tasks = await listActivities(A(), "owner", {
      opportunityId: conv.opportunityId,
      kinds: ["task"],
    });
    expect(tasks.total).toBe(1);
    const second = await sweepCrmAutomations(`h27e-${run}-again`);
    void second;
    const tasksAgain = await listActivities(A(), "owner", {
      opportunityId: conv.opportunityId,
      kinds: ["task"],
    });
    expect(tasksAgain.total).toBe(1); // idempotent per subject and occurrence
  });
});
