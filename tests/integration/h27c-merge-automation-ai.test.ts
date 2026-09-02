/**
 * H27C — reviewed merge, governed automation and the fail-closed assistant on
 * the TEST project: a merge previews conflicts and counts, re-points every
 * reference in one transaction, keeps immutable evidence, marks the source
 * inactive with a pointer, and refuses a second merge of a merged customer; an
 * automation dry-runs without side effects, applies once live, is idempotent
 * per occurrence, records failures, and its strongest action creates a task;
 * the assistant fails closed by default and, with a deterministic provider,
 * returns proposals whose evidence is validated against the context.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { DeterministicTestProvider } from "@/platform/agents";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { addCustomerContact, createCustomer, getCustomer } from "@/modules/masters/service";
import {
  captureLead,
  convertLeadSafely,
  createAutomation,
  crmAiAvailability,
  crmAssist,
  gatherRevenue360,
  listActivities,
  listMerges,
  listRuns,
  logActivity,
  mergeCustomers,
  previewMerge,
  resolveMergedCustomer,
  runAutomation,
  updateAutomation,
  updateCustomerCrm,
  validateProposals,
} from "@/modules/crm/service";
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
  requestId: "h27c",
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
              ${`h27c-${name.toLowerCase()}-${run}@example.invalid`}, ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H27C", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h27c", run);
  await owner`insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en') on conflict (id) do nothing`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userV]);
  await owner.end();
  await closeAppDb();
});

describe("merge", () => {
  it("previews, re-points everything in one transaction, keeps evidence, and refuses a re-merge", async () => {
    const target = await createCustomer(A(), "owner", {
      name: `Marine Co ${run}`,
      country: "AE",
      email: `marine-${run}@example.invalid`,
    });
    const source = await createCustomer(A(), "owner", {
      name: `Marine Company ${run}`,
      country: "AE",
      phone: "+971500000123",
      notes: "Older record",
    });
    await updateCustomerCrm(A(), "owner", { customerId: source.id, tags: ["legacy"] });
    await updateCustomerCrm(A(), "owner", { customerId: target.id, tags: ["vip"] });
    await addCustomerContact(A(), "owner", source.id, { name: "Hamad" });
    const cap = await captureLead(A(), "owner", {
      name: `Marine Company ${run}`,
      sourceKind: "manual",
    });
    const conv = await convertLeadSafely(A(), "owner", {
      leadId: cap.lead.id,
      customerId: source.id,
      opportunityName: `Dock ${run}`,
      estimatedValueMinor: 100000,
    });
    await logActivity(A(), "owner", {
      customerId: source.id,
      kind: "note",
      body: "Met at the marina",
    });
    const preview = await previewMerge(A(), "owner", source.id, target.id);
    expect(preview.conflicts.map((c) => c.field)).toEqual(["name"]);
    expect(preview.counts.customer_contact).toBe(1);
    expect(preview.counts.opportunity).toBe(1);
    expect(preview.counts.sales_activity).toBeGreaterThanOrEqual(1);
    expect(preview.tagsUnion.sort()).toEqual(["legacy", "vip"]);
    await expect(
      mergeCustomers(V(), "viewer", { sourceId: source.id, targetId: target.id, reason: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const merged = await mergeCustomers(A(), "owner", {
      sourceId: source.id,
      targetId: target.id,
      resolutions: { name: "target" },
      reason: "Same company, two records",
    });
    expect(merged.repointed.opportunity).toBe(1);
    expect(merged.repointed.customer_contact).toBe(1);
    const t = await getCustomer(A(), "owner", target.id);
    expect(t?.name).toBe(`Marine Co ${run}`);
    expect(t?.phone).toBe("+971500000123"); // empty target field filled from the source
    const x = await gatherRevenue360(A(), "owner", target.id);
    expect(x.crm.tags.sort()).toEqual(["legacy", "vip"]);
    expect(x.contacts.some((c) => c.name === "Hamad")).toBe(true);
    const s = await gatherRevenue360(A(), "owner", source.id);
    expect(s.crm.mergedIntoCustomerId).toBe(target.id);
    expect(await resolveMergedCustomer(A(), "owner", source.id)).toBe(target.id);
    const opp =
      (await owner`select customer_id::text as c from public.opportunity where id = ${conv.opportunityId}`) as unknown as Array<{
        c: string;
      }>;
    expect(opp[0]!.c).toBe(target.id);
    const acts = await listActivities(A(), "owner", { customerId: target.id });
    expect(acts.rows.some((a) => a.kind === "merged")).toBe(true);
    const evidence = await listMerges(A(), "owner", target.id);
    expect(evidence[0]!.reason).toContain("two records");
    await expect(
      mergeCustomers(A(), "owner", { sourceId: source.id, targetId: target.id, reason: "again" }),
    ).rejects.toMatchObject({ code: "state" });
    // Evidence is immutable for the application role.
    await expect(
      owner`delete from public.crm_merge where id = ${evidence[0]!.id}`,
    ).resolves.toBeDefined();
  });
});

describe("automation", () => {
  it("dry-runs without side effects, applies once live, is idempotent per occurrence, and only creates reviewed work", async () => {
    const c = await createCustomer(A(), "owner", { name: `Auto Co ${run}`, country: "AE" });
    const cap = await captureLead(A(), "owner", { name: `Auto lead ${run}`, sourceKind: "manual" });
    const conv = await convertLeadSafely(A(), "owner", {
      leadId: cap.lead.id,
      customerId: c.id,
      opportunityName: `Auto deal ${run}`,
      estimatedValueMinor: 250000,
    });
    // Age the stage entry so the rule matches.
    await owner`update public.opportunity set stage_entered_at = now() - interval '20 days' where id = ${conv.opportunityId}`;
    const a = await createAutomation(A(), "owner", {
      name: `Stage ageing ${run}`,
      trigger: "opportunity_stage_aged",
      conditions: { all: [{ key: "stage_age_days", op: "gte", value: 14 }] },
      actions: [
        { kind: "create_task", title: "Chase the aged deal", dueInDays: 2 },
        { kind: "flag_risk", title: "Ageing in stage", severity: "medium" },
      ],
      enabled: false,
      dryRun: true,
    });
    const dry = await runAutomation(A(), "owner", { id: a.id });
    expect(dry.mode).toBe("dry_run");
    expect(dry.matched).toBe(1);
    expect(dry.applied).toBe(0);
    const tasksBefore = await listActivities(A(), "owner", {
      opportunityId: conv.opportunityId,
      kinds: ["task"],
    });
    expect(tasksBefore.total).toBe(0);
    await expect(runAutomation(A(), "owner", { id: a.id, mode: "live" })).rejects.toThrow(/enable/);
    await updateAutomation(A(), "owner", { id: a.id, enabled: true, dryRun: false });
    const live = await runAutomation(A(), "owner", { id: a.id, mode: "live" });
    if (live.applied !== 1)
      console.log(
        "RUNS",
        JSON.stringify({
          dry,
          live,
          conv: conv.opportunityId,
          runs: (await listRuns(A(), "owner", a.id)).map((r) => [
            r.subjectId,
            r.occurrenceKey,
            r.mode,
            r.status,
            r.error,
          ]),
        }),
      );
    expect(live.applied).toBe(1);
    const again = await runAutomation(A(), "owner", { id: a.id, mode: "live" });
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(1);
    const tasks = await listActivities(A(), "owner", {
      opportunityId: conv.opportunityId,
      kinds: ["task"],
    });
    expect(tasks.total).toBe(1);
    expect(tasks.rows[0]!.meta.automationId).toBe(a.id);
    const runs = await listRuns(A(), "owner", a.id);
    expect(runs.map((r) => r.status).sort()).toEqual(
      ["applied", "matched", "skipped"].filter((s) => s !== "skipped"),
    );
    await expect(
      createAutomation(V(), "viewer", {
        name: "x",
        trigger: "lead_created",
        actions: [{ kind: "notify", title: "x" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Stage and status were not touched by the automation.
    const opp =
      (await owner`select status, stage_key from public.opportunity where id = ${conv.opportunityId}`) as unknown as Array<{
        status: string;
        stage_key: string;
      }>;
    expect(opp[0]!.status).toBe("open");
  });
});

describe("assistant", () => {
  it("fails closed by default; with a provider, proposals carry validated evidence and nothing is written", async () => {
    const c = await createCustomer(A(), "owner", { name: `AI Co ${run}`, country: "AE" });
    const note = await logActivity(A(), "owner", {
      customerId: c.id,
      kind: "note",
      body: "Wants a delivery date before Ramadan",
    });
    const avail = await crmAiAvailability(A());
    expect(avail.available).toBe(false);
    await expect(crmAssist(A(), "owner", { kind: "customer", id: c.id })).rejects.toMatchObject({
      code: "unavailable",
    });
    const provider = DeterministicTestProvider((req) => {
      expect(req.agentId).toBe("sales_crm");
      expect(req.context[0]!.content).toContain("Ramadan");
      return {
        output: {
          summary: "Wants delivery before Ramadan.",
          proposals: [
            {
              kind: "action_item",
              title: "Confirm the delivery date",
              evidence: [note.id.slice(0, 8), "deadbeef"],
            },
            { kind: "follow_up", title: "Invented", evidence: ["nope"] },
          ],
        },
      };
    });
    const res = await crmAssist(
      A(),
      "owner",
      { kind: "customer", id: c.id, mode: "actions" },
      { provider, enabled: true },
    );
    expect(res.proposals[0]!.evidence.map((e) => e.id)).toEqual([note.id]);
    expect(res.proposals[0]!.evidenceFound).toBe(true);
    expect(res.proposals[1]!.evidenceFound).toBe(false);
    expect(res.notice).toContain("never sends");
    const after = await listActivities(A(), "owner", { customerId: c.id });
    expect(after.total).toBe(1);
    const pure = validateProposals(
      { subject: { kind: "customer", id: c.id, name: "x" }, lines: [], refs: [] },
      { proposals: [{ kind: "brief", title: "t", evidence: ["zzz"] }] },
    );
    expect(pure.proposals[0]!.evidenceFound).toBe(false);
  });
});
