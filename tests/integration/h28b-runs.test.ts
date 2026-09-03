/**
 * H28B — conversations, runs, delegation, actions and memory on the TEST
 * project with the deterministic provider: a run plans, reads through the
 * doors, records every step, answers with evidence and provenance; without a
 * provider it still answers with evidence only and the owner action; a
 * reversible action is proposed, previewed, confirmed once and never
 * replayed; a material action rides the approval engine, refuses drift and
 * self-approval; cancellation stops a run; memory is explicit and revocable;
 * another organisation sees nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { decideApproval } from "@/modules/approvals/service";
import { createCustomer } from "@/modules/masters/service";
import { createOpportunity, listStageSettings } from "@/modules/crm/service";
import {
  ActionStateError,
  cancelRun,
  confirmAction,
  conversationView,
  executeApprovedAction,
  executeRun,
  forget,
  getAction,
  getRun,
  listActions,
  listConversations,
  listMemory,
  listRuns,
  listSteps,
  remember,
  runGraph,
  startConversation,
  startRun,
  type RunDeps,
} from "@/modules/idara/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userM = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h28b",
});
const A = () => ctxOf(orgA, userA);
const M = () => ctxOf(orgA, userM);
const B = () => ctxOf(orgB, userB);
const withProvider: RunDeps = {
  gateway: { env: { APP_ENV: "test", AI_DETERMINISTIC_PROVIDER: "1" }, sleep: async () => {} },
};
const noProvider: RunDeps = { gateway: { env: { APP_ENV: "test" }, sleep: async () => {} } };
const origFlag = process.env.FEATURE_IDARA_INTELLIGENCE;
let customerId = "";
let opportunityId = "";

async function setPolicy(orgId: string, credits: number): Promise<void> {
  const v = (
    await owner`select coalesce(max(version), 0) + 1 as v from public.ai_entitlement where org_id = ${orgId}`
  )[0]!.v as number;
  await owner`insert into public.ai_entitlement (org_id, version, mode, monthly_credits, reason) values (${orgId}, ${v}, 'trial', ${credits}, 'h28b test')`;
}

beforeAll(async () => {
  process.env.FEATURE_IDARA_INTELLIGENCE = "1";
  for (const [id, name] of [
    [userA, "Owner"],
    [userM, "Manager"],
    [userB, "OwnerB"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h28b-${name.toLowerCase()}-${run}@example.invalid`}, ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H28B", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H28B-B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h28b", run);
  await markFixtureOrg(owner, orgB, "h28b", run);
  await owner`insert into public.user_profile (id, full_name, locale) values (${userM}, 'Manager', 'en') on conflict (id) do nothing`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${userM}, ${orgA}, 'admin')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await owner`insert into public.ai_price_book (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros, note)
    values ('deterministic', 'deterministic:fast', '2020-01-01T00:00:00Z', 'USD', 50000, 400000, 'h28b synthetic'),
           ('deterministic', 'deterministic:strong', '2020-01-01T00:00:00Z', 'USD', 3000000, 15000000, 'h28b synthetic')
    on conflict (model_key, effective_from) do nothing`;
  await setPolicy(orgA, 100000);
  const c = await createCustomer(A(), "owner", { name: `H28B Customer ${run}` });
  customerId = c.id;
  const o = await createOpportunity(A(), "owner", { name: `H28B Deal ${run}`, customerId });
  opportunityId = o.id;
}, 600_000);

afterAll(async () => {
  if (origFlag === undefined) delete process.env.FEATURE_IDARA_INTELLIGENCE;
  else process.env.FEATURE_IDARA_INTELLIGENCE = origFlag;
  await owner`delete from public.ai_price_book where model_key like 'deterministic:%' and note like 'h28b%'`;
  await wipeOrgs(owner, [orgA, orgB], [userA, userM, userB]);
  await owner.end();
  await closeAppDb();
});

describe("conversations and runs", () => {
  it("a run over a shared customer plans, reads through the doors, records steps and answers with evidence and provenance", async () => {
    const conv = await startConversation(A(), {
      kind: "session",
      contextRefs: [{ type: "customer", id: customerId, label: "Customer" }],
    });
    const r = await startRun(
      A(),
      "owner",
      "en",
      { conversationId: conv.id, input: "Summarise this customer and their open deals" },
      withProvider,
    );
    expect(r.status).toBe("completed");
    const view = await conversationView(A(), conv.id);
    expect(view!.messages.length).toBe(2);
    const answer = view!.messages[1]!;
    expect(answer.role).toBe("assistant");
    expect(answer.provenance.generated).toBe(true);
    expect(answer.provenance.provider).toBe("deterministic");
    expect(answer.blocks.some((b) => b.kind === "facts")).toBe(true);
    expect(answer.evidence.some((e) => e.type === "customer" && e.id === customerId)).toBe(true);
    const steps = await listSteps(A(), r.runId);
    expect(steps.map((s) => s.kind)).toEqual(
      expect.arrayContaining(["plan", "route", "tool", "model"]),
    );
    expect(
      steps.some(
        (s) => s.kind === "tool" && s.toolId === "customer.overview" && s.status === "completed",
      ),
    ).toBe(true);
    const row = await getRun(A(), r.runId);
    expect(row!.credits).toBeGreaterThan(0);
    const usage =
      await owner`select count(*)::int as n from public.ai_interaction where org_id = ${orgA} and run_id = ${r.runId}`;
    expect(Number(usage[0]!.n)).toBeGreaterThan(0);
  });

  it("a multi-domain request delegates to bounded children under the same authority and Idara merges with contributors", async () => {
    const conv = await startConversation(A(), { kind: "session" });
    const r = await startRun(
      A(),
      "owner",
      "en",
      {
        conversationId: conv.id,
        input: "Brief me on cash position, payroll runs and stock levels",
      },
      withProvider,
    );
    expect(r.status).toBe("completed");
    const graph = await runGraph(A(), r.runId);
    expect(graph.length).toBeGreaterThanOrEqual(2);
    expect(graph.length).toBeLessThanOrEqual(5);
    for (const g of graph) expect(g.depth).toBeLessThanOrEqual(1);
    const view = await conversationView(A(), conv.id);
    const answer = view!.messages[view!.messages.length - 1]!;
    expect(answer.provenance.answeredBy).toBe("idara");
    expect((answer.provenance.contributors ?? []).length).toBeGreaterThan(0);
    const steps = await listSteps(A(), r.runId);
    expect(steps.filter((s) => s.kind === "delegate").length).toBe(graph.length - 1);
  });

  it("without a provider the run still answers with evidence only, labelled, and names the owner action", async () => {
    const conv = await startConversation(A(), {
      kind: "quick",
      contextRefs: [{ type: "customer", id: customerId }],
    });
    const r = await startRun(
      A(),
      "owner",
      "en",
      { conversationId: conv.id, input: "What do we know about this customer?" },
      noProvider,
    );
    expect(r.status).toBe("completed");
    const view = await conversationView(A(), conv.id);
    const answer = view!.messages[1]!;
    expect(answer.provenance.generated).toBe(false);
    const notice = answer.blocks.find((b) => b.kind === "notice");
    expect(notice).toBeDefined();
    expect((notice as { ownerAction?: string }).ownerAction).toMatch(
      /AI_OPENAI_API_KEY|AI_ANTHROPIC_API_KEY/,
    );
    expect(answer.evidence.some((e) => e.id === customerId)).toBe(true);
    const usage =
      await owner`select count(*)::int as n from public.ai_interaction where org_id = ${orgA} and run_id = ${r.runId}`;
    expect(Number(usage[0]!.n)).toBe(0);
  });

  it("a background run queues, executes once, and a cancelled queued run never executes", async () => {
    const conv = await startConversation(A(), { kind: "task" });
    const q = await startRun(
      A(),
      "owner",
      "en",
      { conversationId: conv.id, input: "List open work", kind: "background" },
      withProvider,
    );
    expect(q.status).toBe("queued");
    const done = await executeRun(A(), "owner", "en", q.runId, withProvider);
    expect(done.status).toBe("completed");
    const again = await executeRun(A(), "owner", "en", q.runId, withProvider);
    expect(again.status).toBe("completed");
    expect((await listSteps(A(), q.runId)).filter((s) => s.kind === "plan").length).toBe(1);
    const q2 = await startRun(
      A(),
      "owner",
      "en",
      { conversationId: conv.id, input: "List open work again", kind: "background" },
      withProvider,
    );
    await cancelRun(A(), q2.runId);
    const c = await executeRun(A(), "owner", "en", q2.runId, withProvider);
    expect(c.status).toBe("cancelled");
    const runs = await listRuns(A(), { limit: 10, offset: 0 });
    expect(runs.total).toBeGreaterThanOrEqual(4);
  });
});

describe("actions", () => {
  it("a reversible action is proposed with a preview, executes once on confirmation, and a replay is refused", async () => {
    const conv = await startConversation(A(), {
      kind: "session",
      contextRefs: [{ type: "customer", id: customerId }],
    });
    const input = `[[call:crm__activity__log:${JSON.stringify({ customerId, kind: "note", title: "Idara note " + run })}]] log a note`;
    const r = await startRun(
      A(),
      "owner",
      "en",
      { conversationId: conv.id, input, agentId: "sales_crm" },
      withProvider,
    );
    expect(r.status).toBe("completed");
    const proposed = await listActions(A(), {
      status: "proposed",
      mine: true,
      limit: 10,
      offset: 0,
    });
    const action = proposed.rows.find((a) => a.toolId === "crm.activity.log");
    expect(action).toBeDefined();
    expect(action!.riskClass).toBe(3);
    expect(action!.preview.records[0]).toMatchObject({ type: "customer", id: customerId });
    expect(action!.preview.permission).toBe("customers.manage");
    const view = await conversationView(A(), conv.id);
    expect(view!.messages[1]!.blocks.some((b) => b.kind === "actions")).toBe(true);
    const executed = await confirmAction(A(), "owner", "en", { actionId: action!.id });
    expect(executed.status).toBe("executed");
    const activities =
      await owner`select count(*)::int as n from public.sales_activity where org_id = ${orgA} and title = ${"Idara note " + run}`;
    expect(Number(activities[0]!.n)).toBe(1);
    await expect(
      confirmAction(A(), "owner", "en", { actionId: action!.id }),
    ).rejects.toBeInstanceOf(ActionStateError);
    expect(
      Number(
        (
          await owner`select count(*)::int as n from public.sales_activity where org_id = ${orgA} and title = ${"Idara note " + run}`
        )[0]!.n,
      ),
    ).toBe(1);
  });

  it("a material action needs another person's approval, refuses self-approval, and refuses execution after drift", async () => {
    const stages = await listStageSettings(A(), "owner", null);
    const target =
      (stages as Array<{ key: string; category?: string }>).find(
        (s) => s.category === "open" && s.key !== "new",
      )?.key ?? (stages as Array<{ key: string }>)[1]!.key;
    const convM = await startConversation(M(), {
      kind: "session",
      contextRefs: [{ type: "opportunity", id: opportunityId }],
    });
    const input = `[[call:opportunity__move_stage:${JSON.stringify({ opportunityId, stageKey: target, reason: "test" })}]] move it`;
    await startRun(
      M(),
      "admin",
      "en",
      { conversationId: convM.id, input, agentId: "sales_crm" },
      withProvider,
    );
    const proposed = await listActions(M(), {
      status: "proposed",
      mine: true,
      limit: 10,
      offset: 0,
    });
    const action = proposed.rows.find((a) => a.toolId === "opportunity.move_stage");
    expect(action).toBeDefined();
    expect(action!.riskClass).toBe(4);
    expect(action!.recordVersions[0]).toMatchObject({ type: "opportunity", id: opportunityId });
    const waiting = await confirmAction(M(), "admin", "en", { actionId: action!.id });
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.approvalId).not.toBeNull();
    await expect(
      decideApproval(M(), "admin", { approvalId: waiting.approvalId!, decision: "approved" }),
    ).rejects.toThrow(/self/i);
    await decideApproval(A(), "owner", { approvalId: waiting.approvalId!, decision: "approved" });
    const approved = await getAction(M(), action!.id);
    expect(approved!.status).toBe("approved");
    // Drift: the opportunity changes before the requester executes.
    await owner`update public.opportunity set row_version = row_version + 1 where id = ${opportunityId} and org_id = ${orgA}`;
    const refused = await executeApprovedAction(M(), "admin", "en", { actionId: action!.id });
    expect(refused.status).toBe("refused_drift");
    expect(refused.error).toMatch(/changed since the preview/);
    const notified =
      await owner`select count(*)::int as n from public.notification where org_id = ${orgA} and user_id = ${userM} and kind = 'idara_action_waiting'`;
    expect(Number(notified[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it("a viewer cannot propose change tools and another organisation sees no conversations, runs or actions", async () => {
    await owner`insert into public.membership (user_id, org_id, role_key) values (${userB}, ${orgA}, 'viewer') on conflict do nothing`;
    const convV = await startConversation(ctxOf(orgA, userB), {
      kind: "quick",
      contextRefs: [{ type: "customer", id: customerId }],
    });
    const input = `[[call:crm__activity__log:${JSON.stringify({ customerId, kind: "note", title: "viewer note" })}]] log`;
    const r = await startRun(
      ctxOf(orgA, userB),
      "viewer",
      "en",
      { conversationId: convV.id, input },
      withProvider,
    );
    expect(r.status).toBe("completed");
    const steps = await listSteps(ctxOf(orgA, userB), r.runId);
    expect(steps.some((s) => s.kind === "action" && s.status === "completed")).toBe(false);
    expect(
      Number(
        (
          await owner`select count(*)::int as n from public.ai_action where org_id = ${orgA} and requested_by = ${userB}`
        )[0]!.n,
      ),
    ).toBe(0);
    const other = await listConversations(B(), { limit: 10, offset: 0 });
    expect(other.total).toBe(0);
    expect((await listActions(B(), { limit: 10, offset: 0 })).total).toBe(0);
    const cross = await withCtx(B(), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.ai_run`),
    );
    expect(Number((cross as unknown as Array<{ n: number }>)[0]!.n)).toBe(0);
  });
});

describe("memory", () => {
  it("is explicit, scoped, correctable and revocable; org knowledge needs an administrator", async () => {
    const m = await remember(A(), "owner", {
      scope: "user",
      kind: "preference",
      key: "answer.length",
      value: "short",
    });
    expect(m.value).toBe("short");
    const corrected = await remember(A(), "owner", {
      scope: "user",
      kind: "preference",
      key: "answer.length",
      value: "long",
    });
    expect(corrected.value).toBe("long");
    expect((await listMemory(A(), "user")).filter((x) => x.key === "answer.length").length).toBe(1);
    await expect(
      remember(ctxOf(orgA, userB), "viewer", {
        scope: "org",
        kind: "knowledge",
        key: "site.hours",
        value: "7-4",
      }),
    ).rejects.toThrow();
    const k = await remember(A(), "owner", {
      scope: "org",
      kind: "knowledge",
      key: "site.hours",
      value: "7 to 4",
    });
    expect((await listMemory(M(), "org")).some((x) => x.id === k.id)).toBe(true);
    await forget(A(), "owner", k.id);
    expect((await listMemory(A(), "org")).some((x) => x.id === k.id)).toBe(false);
    expect((await listMemory(B())).length).toBe(0);
  });
});
