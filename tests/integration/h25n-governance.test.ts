/**
 * H25C/I/J/K/M/N — the governance surfaces on the living model.
 *
 * Properties: a plan created from a built-in template is real (draft
 * elements, dependency edges, a schedule); a plan can be saved as an org
 * template and listed; saved views are private until shared and can be
 * retired by their owner; registers project typed elements with derived
 * scores; the KPI catalogue says "insufficient" where inputs are missing and
 * measures where they exist; the advisor names findings with next steps and
 * the narrative seam fails closed; the portfolio scores plans transparently.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  createPlanFromTemplate,
  saveAsTemplate,
  listTemplates,
  scheduleForPlan,
  saveView,
  listViews,
  updateView,
  listRegister,
  computeKpis,
  reviewPlan,
  draftReviewNarrative,
  portfolioSummary,
  captureBaseline,
  addNode,
} from "@/modules/studio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let planId = "";

const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h25n",
});
const A = () => ctxOf(userA);
const B = () => ctxOf(userB);

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userB, "Manager"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h25n-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H25N", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25n", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userB}, 'Manager', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userB}, ${orgA}, 'manager')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await owner.end();
  await closeAppDb();
});

describe("templates", () => {
  it("a built-in template becomes a real, schedulable plan of drafts", async () => {
    const r = await createPlanFromTemplate(A(), "owner", {
      templateKey: "builtin.refit",
      name: `Refit from template ${run}`,
    });
    planId = r.id;
    expect(r.nodes).toBe(6);
    expect(r.edges).toBe(6);
    const s = await scheduleForPlan(A(), "owner", { planId });
    // a→b→d→m is the long chain: 3 + 6 + 3 working days, milestone after.
    expect(s.result.ok).toBe(true);
    expect(s.byNode.size).toBe(5); // 4 tasks + milestone (the risk is not an activity)
    expect(s.result.projectDurationDays).toBe(12);
    expect(s.result.criticalPaths.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("a plan can be saved as an organisation template and listed", async () => {
    const saved = await saveAsTemplate(A(), "owner", {
      planId,
      key: `refit-${run}`,
      name: "Our refit",
    });
    expect(saved.nodes).toBe(6);
    const all = await listTemplates(A(), "owner");
    expect(all.some((t) => t.key === `refit-${run}` && !t.builtIn && t.nodes === 6)).toBe(true);
    expect(all.filter((t) => t.builtIn).length).toBe(3);
  });
});

describe("saved views", () => {
  it("private until shared; retired by the owner", async () => {
    const mine = await saveView(A(), "owner", {
      planId,
      name: "My critical chain",
      view: "gantt",
      config: { filters: { criticalOnly: true } },
    });
    expect((await listViews(B(), "manager", planId)).some((v) => v.id === mine.id)).toBe(false);
    await updateView(A(), "owner", { viewId: mine.id, isShared: true });
    const seen = (await listViews(B(), "manager", planId)).find((v) => v.id === mine.id);
    expect(seen?.isShared).toBe(true);
    expect(seen?.config.filters?.criticalOnly).toBe(true);
    expect(seen?.config.view).toBe("gantt");
    await updateView(A(), "owner", { viewId: mine.id, remove: true });
    expect((await listViews(A(), "owner", planId)).some((v) => v.id === mine.id)).toBe(false);
  });
});

describe("registers, indicators, advisor, portfolio", () => {
  it("the risk register scores from validated data and lists the unscored", async () => {
    await addNode(A(), "owner", { planId, nodeType: "risk", title: "Unscored one", x: 0, y: 0 });
    const reg = await listRegister(A(), "owner", { kind: "risk", planId, status: "open" });
    expect(reg.total).toBe(2);
    const scored = reg.rows.find((r) => r.title === "Hidden damage found")!;
    expect(scored.score).toBe(9);
    expect(reg.rows.find((r) => r.title === "Unscored one")!.score).toBeNull();
  });

  it("indicators measure what exists and refuse what does not", async () => {
    const before = await computeKpis(A(), "owner", { planId });
    const by = (k: string) => before.find((x) => x.key === k)!;
    expect(by("plan.duration_days")).toMatchObject({ status: "ok", value: 12 });
    expect(by("plan.finish_variance_days")).toMatchObject({
      status: "insufficient",
      reason: "no baseline captured",
    });
    expect(by("plan.confidence_p80")).toMatchObject({ status: "insufficient" });
    expect(by("register.unscored_risks")).toMatchObject({ status: "ok", value: 1 });
    expect(by("plan.estimate_coverage_pct")).toMatchObject({ status: "ok", value: 100 });
    await captureBaseline(A(), "owner", { planId, name: "B0" });
    const after = await computeKpis(A(), "owner", { planId, keys: ["plan.finish_variance_days"] });
    expect(after[0]).toMatchObject({ status: "ok", value: 0 });
  }, 120_000);

  it("the advisor names findings with a next step; the assistant seam fails closed", async () => {
    const { findings, basis } = await reviewPlan(A(), "owner", { planId });
    expect(basis[0]).toContain("scheduled elements");
    const keys = findings.map((f) => f.key);
    expect(keys).toContain("unscored_risks");
    expect(keys).toContain("unassigned");
    expect(keys).not.toContain("no_baseline"); // captured above
    for (const f of findings) expect(["high", "medium", "low"]).toContain(f.severity);
    const n = await draftReviewNarrative(A(), "owner", { planId, locale: "en" });
    expect(n).toEqual({ available: false, reason: "assistant not provisioned" });
  }, 120_000);

  it("the portfolio scores the plan from named components", async () => {
    const { rows } = await portfolioSummary(A(), "owner");
    const row = rows.find((r) => r.plan.id === planId)!;
    expect(row.scheduled).toBe(5);
    expect(row.durationDays).toBe(12);
    expect(row.openRisks).toBe(2);
    expect(row.unscoredRisks).toBe(1);
    expect(row.score).not.toBeNull();
    expect(row.components.map((c) => c.key)).toEqual(["schedule", "risk", "capacity"]);
    expect(row.components.reduce((s, c) => s + c.points, 0)).toBe(row.score);
    for (const c of row.components) expect(c.basis.length).toBeGreaterThan(0);
  }, 120_000);
});
