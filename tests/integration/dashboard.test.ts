/**
 * H17 — adaptive dashboard against the real database: owner vs restricted
 * member on the same live records, cross-organization denial, applied
 * blueprint revision change flowing into composition, disabled capability,
 * real attention conditions (overdue job + pending approval + open
 * exception), drill-down count accuracy, partial source failure, and the
 * legacy organization (no blueprint) law. Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  createBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  applyBlueprintRevision,
  getAppliedWorkspaceShape,
  disabledModulesOf,
} from "@/platform/workspace";
import { resolveEntitlements } from "@/platform/entitlements";
import {
  composeAdaptiveDashboard,
  gatherDashboardData,
  orgToday,
  type ComposeContext,
} from "@/modules/dashboard/service";
import { makeBlueprint, scenarioContractor } from "../unit/workspace-fixtures";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = ""; // blueprint org
let orgB = ""; // legacy org (no blueprint, separate tenant)

const ctxOf = (orgId: string, userId: string, priv: boolean): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "h17-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const opts = { asOf, computedAt: new Date().toISOString() };

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h17-${label}-${run}@example.com`}, '{"full_name":"H17 Test"}'::jsonb, now(), now())`;
}

async function applyFixtureBlueprint(ctx: Ctx, blueprint: ReturnType<typeof makeBlueprint>) {
  const draft = await createBlueprintDraft(ctx, "owner", {
    blueprint,
    source: "onboarding_answer",
    reason: "H17 dashboard test",
  });
  const v = await validateBlueprintRevision(ctx, "owner", draft.id);
  expect(v.ok).toBe(true);
  await approveBlueprintRevision(ctx, "owner", draft.id, { expectedHash: draft.blueprintHash });
  const applied = await applyBlueprintRevision(ctx, "owner", draft.id);
  expect(applied.applied).toBe(true);
  return draft.id;
}

async function composeFor(ctx: Ctx, archetype: "owner" | "viewer" | "manager") {
  const shape = await getAppliedWorkspaceShape(ctx);
  expect(shape).not.toBeNull();
  const ent = await resolveEntitlements(ctx);
  const cx: ComposeContext = {
    orgId: ctx.orgId,
    archetype,
    seesPrice: ctx.pricePrivileged,
    features: ent.features,
    disabledModules: disabledModulesOf(shape!.compiled),
    compiledDashboard: shape!.compiled.dashboards[archetype] ?? null,
    asOf,
  };
  const data = await gatherDashboardData(ctx, archetype, opts);
  return { view: composeAdaptiveDashboard(cx, data), data, shape: shape!, cx };
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H17 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H17 B", country: "AE", baseCurrency: "AED" });
  await applyFixtureBlueprint(ctxOf(orgA, userA, true), scenarioContractor());

  // Real attention conditions in org A: one overdue job, one pending
  // approval, one open blocking-issue exception.
  const overdueJob = randomUUID();
  await owner`
    insert into public.job (id, org_id, reference, name, status_key, status_category, created_by, due_date)
    values (${overdueJob}, ${orgA}, 'J-OVD', 'Overdue villa', 'active', 'active', ${userA},
            (${asOf}::date - 3))`;
  await owner`
    insert into public.approval (id, org_id, subject_type, subject_id, subject_summary, requested_by, assigned_role, state)
    values (${randomUUID()}, ${orgA}, 'material_request', ${randomUUID()}, '{"title":"Steel"}'::jsonb,
            ${userA}, 'owner', 'pending')`;
  await owner`
    insert into public.exception (org_id, rule_key, severity, job_id, subject_type, subject_id,
                                  evidence_refs, audience_roles, dedup_key, raised_at, last_evaluated_at)
    values (${orgA}, 'blocking_issue', 'critical', ${overdueJob}, null, null,
            '[]'::jsonb, array['owner','admin','manager']::text[], ${"h17-blk-" + run}, now(), now())`;
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("H17 — real attention conditions and drill-down accuracy", () => {
  it("the owner sees the seeded conditions with accurate counts", async () => {
    const { view } = await composeFor(ctxOf(orgA, userA, true), "owner");
    const byKey = new Map(view.attention.map((i) => [i.key, i]));
    expect(byKey.get("blockers")?.count).toBe(1);
    expect(byKey.get("needs_decision")?.count).toBe(1);
    // Drill-down accuracy: the composed overdue count equals the DB truth.
    const dbOverdue = (await owner`
      select count(*)::int as n from public.job
      where org_id = ${orgA} and status_category in ('active','on_hold')
        and archived = false and due_date is not null and due_date < ${asOf}::date`) as unknown as Array<{
      n: number;
    }>;
    expect(byKey.get("overdue_jobs")?.count).toBe(dbOverdue[0]!.n);
    // The critical blocker outranks everything else on the board.
    expect(view.attention[0]!.key).toBe("blockers");
    expect(view.allClear).toBe(false);
  });

  it("a restricted member (viewer) sees none of it", async () => {
    const { view, data } = await composeFor(ctxOf(orgA, userA, false), "viewer");
    expect(view.attention).toHaveLength(0);
    expect(view.next).toHaveLength(0);
    expect(view.pulse.every((m) => !m.money)).toBe(true);
    // The gatherer never even fetched restricted sources (no data, no leak).
    expect(data.exceptions).toBeNull();
    expect(data.inbox).toBeNull();
    expect(data.ar).toBeNull();
  });
});

describe("H17 — cross-organization denial", () => {
  it("org B's gather never returns org A's records", async () => {
    const data = await gatherDashboardData(ctxOf(orgB, userB, true), "owner", opts);
    expect(data.exceptions ?? []).toHaveLength(0);
    expect(data.inbox ?? []).toHaveLength(0);
    expect(data.extras?.jobs?.overdue ?? 0).toBe(0);
  });
});

describe("H17 — blueprint composition", () => {
  it("a disabled capability stays out of the composition", async () => {
    const { cx } = await composeFor(ctxOf(orgA, userA, true), "owner");
    // scenarioContractor leaves cap.customer_updates off → configuration layer.
    expect(cx.disabledModules.has("cap.customer_updates")).toBe(true);
  });

  it("an entitlement change removes card content immediately (live layer)", async () => {
    const { cx: cx0, data } = await composeFor(ctxOf(orgA, userA, true), "owner");
    const cx = { ...cx0, features: { ...cx0.features, "cap.material_requests": true } };
    const withMr = composeAdaptiveDashboard(cx, {
      ...data,
      extras: data.extras ? { ...data.extras, mrOpen: { submitted: 0, approved: 2 } } : data.extras,
    });
    const without = composeAdaptiveDashboard(
      { ...cx, features: { ...cx.features, "cap.material_requests": false } },
      {
        ...data,
        extras: data.extras
          ? { ...data.extras, mrOpen: { submitted: 0, approved: 2 } }
          : data.extras,
      },
    );
    expect(withMr.attention.some((i) => i.cardKey === "approved_mrs")).toBe(true);
    expect(without.attention.some((i) => i.cardKey === "approved_mrs")).toBe(false);
  });

  it("an applied revision change flows into the next composition", async () => {
    const before = await composeFor(ctxOf(orgA, userA, true), "owner");
    expect(before.view.horizonDays).toBe(2); // contractor owner horizon: today
    const monthly = makeBlueprint({
      capabilities: scenarioContractor().capabilities,
      dashboards: [
        {
          ...scenarioContractor().dashboards[0]!,
          timeHorizon: "this_month" as const,
        },
      ],
    });
    await applyFixtureBlueprint(ctxOf(orgA, userA, true), monthly);
    const after = await composeFor(ctxOf(orgA, userA, true), "owner");
    expect(after.shape.revisionNo).toBeGreaterThan(before.shape.revisionNo);
    expect(after.view.horizonDays).toBe(30);
  });
});

describe("H17 — resilience and the legacy law", () => {
  it("a failing source degrades honestly instead of failing the dashboard", async () => {
    // A syntactically valid but non-existent org id: RLS yields empty reads
    // (not errors), so force failure with a malformed ctx org id instead.
    const broken = ctxOf(orgA, userA, true);
    const data = await gatherDashboardData({ ...broken, orgId: "not-a-uuid" }, "owner", opts);
    expect(data.failed.length).toBeGreaterThan(0);
    expect(data.extras).toBeNull();
    const { view } = {
      view: composeAdaptiveDashboard(
        {
          orgId: "x",
          archetype: "owner",
          seesPrice: true,
          features: {},
          disabledModules: new Set(),
          compiledDashboard: null,
          asOf,
        },
        data,
      ),
    };
    expect(view.unavailable.length).toBeGreaterThan(0);
    expect(view.allClear).toBe(false);
  });

  it("a legacy organization has no applied shape (the pre-H17 path renders)", async () => {
    const shape = await getAppliedWorkspaceShape(ctxOf(orgB, userB, true));
    expect(shape).toBeNull();
    // Its data still gathers cleanly for the legacy screens' primitives.
    const data = await gatherDashboardData(ctxOf(orgB, userB, true), "owner", opts);
    expect(data.failed).toHaveLength(0);
  });
});
