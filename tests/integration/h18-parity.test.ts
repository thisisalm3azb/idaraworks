/**
 * H18 — drill-down parity and workflow stage adoption against the real DB:
 * dashboard counts equal destination lists for the same context (overdue
 * work, review queue, missing-today, receivables with credit-note and
 * allocated-payment rules), restricted-member filtering, cross-organization
 * denial, blueprint stage snapshots on manual and quote-conversion creation
 * with event provenance, legacy creation behavior, revision-change forward
 * adoption with historical safety, duplicate-creation retries, and
 * transaction rollback on stage failure. Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import {
  createBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  applyBlueprintRevision,
} from "@/platform/workspace";
import { createJobFromPreset, listActivePresets, listJobs } from "@/modules/jobs/service";
import { acceptQuote } from "@/modules/quotes/service";
import {
  countMissingToday,
  countReviewQueue,
  listJobsMissingToday,
  listReviewQueue,
} from "@/modules/reports/service";
import { computeAR, listOutstandingInvoices } from "@/modules/invoices/service";
import { jobIsOverdue, orgToday } from "@/modules/dashboard/service";
import { makeBlueprint, scenarioContractor } from "../unit/workspace-fixtures";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = ""; // blueprint org (template installed + applied blueprint)
let orgB = ""; // legacy org (template installed, NO blueprint)
let presetA = "";
let presetB = "";
let appliedRevisionId = "";

const ctxOf = (orgId: string, userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "h18-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const FIXTURE_STAGES = scenarioContractor().workflows[0]!.stages;

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h18-${label}-${run}@example.com`}, '{"full_name":"H18 Test"}'::jsonb, now(), now())`;
}

async function applyBlueprint(ctx: Ctx, bp: ReturnType<typeof makeBlueprint>): Promise<string> {
  const draft = await createBlueprintDraft(ctx, "owner", {
    blueprint: bp,
    source: "onboarding_answer",
    reason: "H18 stage adoption test",
  });
  const v = await validateBlueprintRevision(ctx, "owner", draft.id);
  expect(v.ok).toBe(true);
  await approveBlueprintRevision(ctx, "owner", draft.id, { expectedHash: draft.blueprintHash });
  const applied = await applyBlueprintRevision(ctx, "owner", draft.id);
  expect(applied.applied).toBe(true);
  return draft.id;
}

async function jobStages(jobId: string) {
  return (await owner`
    select stage_key, name, weight, sort, status from public.job_stage
    where job_id = ${jobId} order by sort`) as unknown as Array<{
    stage_key: string;
    name: { en: string; ar: string };
    weight: number;
    sort: number;
    status: string;
  }>;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H18 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H18 B", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  await installTemplate(ctxOf(orgB, userB), "generic_operations_v1");
  appliedRevisionId = await applyBlueprint(ctxOf(orgA, userA), scenarioContractor());
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
  presetB = (await listActivePresets(ctxOf(orgB, userB), "owner"))[0]!.id;
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("H18 — workflow stage adoption", () => {
  it("manual creation in a blueprint org snapshots the approved workflow", async () => {
    const { id } = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Blueprint villa",
    });
    const stages = await jobStages(id);
    expect(stages.map((s) => s.stage_key)).toEqual(FIXTURE_STAGES.map((s) => s.key));
    expect(stages.map((s) => s.name.en)).toEqual(FIXTURE_STAGES.map((s) => s.name.en));
    expect(stages.map((s) => s.name.ar)).toEqual(FIXTURE_STAGES.map((s) => s.name.ar));
    expect(stages.map((s) => s.weight)).toEqual(FIXTURE_STAGES.map((s) => s.weight));
    expect(stages.map((s) => s.sort)).toEqual(FIXTURE_STAGES.map((_, i) => i));
    // current stage = first non-skipped snapshot stage
    const cur = (await owner`
      select cs.stage_key from public.job j
      join public.job_stage cs on cs.id = j.current_stage_id
      where j.id = ${id}`) as unknown as Array<{ stage_key: string }>;
    expect(cur[0]!.stage_key).toBe(FIXTURE_STAGES[0]!.key);
    // provenance: the outbox event records the applied revision (safe
    // existing metadata location)
    const ev = (await owner`
      select payload from public.domain_event
      where org_id = ${orgA} and name = 'job/created'
        and payload->>'jobId' = ${id}`) as unknown as Array<{
      payload: { blueprintRevisionId?: string | null };
    }>;
    expect(ev[0]?.payload.blueprintRevisionId).toBe(appliedRevisionId);
  });

  it("legacy org creation keeps the template path, byte-identical", async () => {
    const { id } = await createJobFromPreset(ctxOf(orgB, userB), "owner", {
      presetId: presetB,
      name: "Legacy villa",
    });
    const tmpl = (await owner`
      select value from public.app_settings
      where org_id = ${orgB} and key = 'config.stage_template'`) as unknown as Array<{
      value: { stages: Array<{ stage_key: string; weight: number }> };
    }>;
    const stages = await jobStages(id);
    expect(stages.map((s) => s.stage_key)).toEqual(tmpl[0]!.value.stages.map((s) => s.stage_key));
    const ev = (await owner`
      select payload from public.domain_event
      where org_id = ${orgB} and name = 'job/created'
        and payload->>'jobId' = ${id}`) as unknown as Array<{
      payload: { blueprintRevisionId?: string | null };
    }>;
    expect(ev[0]?.payload.blueprintRevisionId ?? null).toBeNull();
  });

  it("quote conversion adopts the same blueprint stages (shared creation path)", async () => {
    const quoteId = randomUUID();
    await owner`
      insert into public.quote (id, org_id, reference, preset_id, status, created_by)
      values (${quoteId}, ${orgA}, ${"QT-h18-" + run}, ${presetA}, 'sent', ${userA})`;
    const { jobId } = await acceptQuote(ctxOf(orgA, userA), "owner", quoteId, {
      jobName: "Converted villa",
    });
    const stages = await jobStages(jobId);
    expect(stages.map((s) => s.stage_key)).toEqual(FIXTURE_STAGES.map((s) => s.key));
  });

  it("a new applied revision changes FUTURE work only (historical safety)", async () => {
    const before = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Before revision",
    });
    const beforeStages = await jobStages(before.id);
    const twoStage = makeBlueprint({
      capabilities: scenarioContractor().capabilities,
      workflows: [
        {
          ...scenarioContractor().workflows[0]!,
          stages: [
            {
              key: "build",
              name: { en: "Build", ar: "بناء" },
              weight: 70,
              phaseSemantic: "production" as const,
            },
            {
              key: "handover_new",
              name: { en: "Handover", ar: "تسليم" },
              weight: 30,
              phaseSemantic: "handover" as const,
            },
          ],
          transitions: [{ from: "build", to: "handover_new" }],
          requiredApprovals: [],
          responsibilities: [],
          exceptionPaths: [],
        },
      ],
      dashboards: scenarioContractor().dashboards,
    });
    await applyBlueprint(ctxOf(orgA, userA), twoStage);
    const after = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "After revision",
    });
    const afterStages = await jobStages(after.id);
    expect(afterStages.map((s) => s.stage_key)).toEqual(["build", "handover_new"]);
    // The pre-revision job's snapshot is untouched.
    const beforeAgain = await jobStages(before.id);
    expect(beforeAgain).toEqual(beforeStages);
  });

  it("duplicate creation retries produce independent complete snapshots", async () => {
    const a = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Retry one",
    });
    const b = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
      presetId: presetA,
      name: "Retry one",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.reference).not.toBe(b.reference);
    const sa = await jobStages(a.id);
    const sb = await jobStages(b.id);
    expect(sa.map((s) => s.stage_key)).toEqual(sb.map((s) => s.stage_key));
  });

  it("a stage insert failure rolls back the whole creation (no partial work)", async () => {
    // Corrupt the LEGACY org's template with an out-of-range weight: the
    // job_stage check constraint fires mid-snapshot and the single command
    // transaction must roll back the job row too.
    const good = (await owner`
      select value from public.app_settings
      where org_id = ${orgB} and key = 'config.stage_template'`) as unknown as Array<{
      value: { stages: Array<Record<string, unknown>> };
    }>;
    const bad = structuredClone(good[0]!.value);
    (bad.stages[0]! as { weight: number }).weight = 101;
    await owner`
      update public.app_settings set value = ${owner.json(bad as unknown as Parameters<typeof owner.json>[0])}
      where org_id = ${orgB} and key = 'config.stage_template'`;
    const verify = (await owner`
      select value->'stages'->0->>'weight' as w from public.app_settings
      where org_id = ${orgB} and key = 'config.stage_template'`) as unknown as Array<{
      w: string | null;
    }>;
    expect(verify[0]?.w, "the corruption actually landed").toBe("101");
    const beforeCount = (await owner`
      select count(*)::int as n from public.job where org_id = ${orgB}`) as unknown as Array<{
      n: number;
    }>;
    await expect(
      createJobFromPreset(ctxOf(orgB, userB), "owner", { presetId: presetB, name: "Doomed" }),
    ).rejects.toThrow();
    const afterCount = (await owner`
      select count(*)::int as n from public.job where org_id = ${orgB}`) as unknown as Array<{
      n: number;
    }>;
    expect(afterCount[0]!.n).toBe(beforeCount[0]!.n); // rolled back, no orphan
    await owner`
      update public.app_settings set value = ${owner.json(good[0]!.value as unknown as Parameters<typeof owner.json>[0])}
      where org_id = ${orgB} and key = 'config.stage_template'`;
  });
});

describe("H18 — count-to-record parity", () => {
  it("overdue work: aggregate equals the filtered destination list", async () => {
    await owner`
      insert into public.job (org_id, reference, name, status_key, status_category, created_by, due_date)
      values (${orgA}, 'J-OVD-1', 'Overdue one', 'active', 'active', ${userA}, (${asOf}::date - 4)),
             (${orgA}, 'J-OVD-2', 'Overdue two', 'on_hold', 'on_hold', ${userA}, (${asOf}::date - 1))`;
    const ctx = ctxOf(orgA, userA);
    const agg = (await owner`
      select count(*)::int as n from public.job
      where org_id = ${orgA} and archived = false
        and status_category in ('active','on_hold')
        and due_date is not null and due_date < ${asOf}::date`) as unknown as Array<{ n: number }>;
    const list = (await listJobs(ctx, "owner")).filter((j) => jobIsOverdue(j, asOf));
    expect(list.length).toBe(agg[0]!.n);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Every listed record satisfies the signal condition.
    for (const j of list) expect(jobIsOverdue(j, asOf)).toBe(true);
  });

  it("review queue and missing-today: counts equal lists, same scope", async () => {
    const ctx = ctxOf(orgA, userA);
    const jobs = await listJobs(ctx, "owner");
    const someJob = jobs.find((j) => j.statusCategory === "active")!;
    await owner`
      insert into public.daily_report (org_id, job_id, report_date, summary, status, submitted_by)
      values (${orgA}, ${someJob.id}, (${asOf}::date - 1), 'H18 parity report', 'submitted', ${userA})`;
    const [qCount, qList, mCount, mList] = await Promise.all([
      countReviewQueue(ctx, "owner"),
      listReviewQueue(ctx, "owner"),
      countMissingToday(ctx, "owner", asOf),
      listJobsMissingToday(ctx, "owner", asOf),
    ]);
    expect(qList.length).toBe(qCount);
    expect(qCount).toBeGreaterThanOrEqual(1);
    expect(mList.length).toBe(mCount);
    // The submitted report's job still has no report FOR TODAY → it may
    // appear in missing-today; every listed job must lack a report >= asOf.
    for (const m of mList) {
      const has = (await owner`
        select count(*)::int as n from public.daily_report
        where job_id = ${m.jobId} and status in ('submitted','reviewed')
          and report_date >= ${asOf}::date`) as unknown as Array<{ n: number }>;
      expect(has[0]!.n).toBe(0);
    }
  });

  it("receivables: summary buckets equal the invoice list under credit-note and payment rules", async () => {
    const inv1 = randomUUID(); // 1000, due 100 days ago, credit note 100 → 900 over90
    const inv2 = randomUUID(); // 500, due 10 days ago, payment 200 → 300 in 1-30
    await owner`
      insert into public.invoice (id, org_id, reference, kind, status, subtotal_minor, vat_amount_minor,
                                  total_minor, base_total_minor, due_date, issued_at, created_by)
      values (${inv1}, ${orgA}, 'INV-h18-1', 'invoice', 'issued', 1000, 0, 1000, 1000,
              (${asOf}::date - 100), now() - interval '101 days', ${userA}),
             (${inv2}, ${orgA}, 'INV-h18-2', 'invoice', 'partially_paid', 500, 0, 500, 500,
              (${asOf}::date - 10), now() - interval '11 days', ${userA})`;
    await owner`
      insert into public.invoice (id, org_id, reference, kind, status, subtotal_minor, vat_amount_minor,
                                  total_minor, base_total_minor, issued_at, corrects_invoice_id, created_by)
      values (${randomUUID()}, ${orgA}, 'CN-h18-1', 'credit_note', 'issued', 100, 0, 100, 100, now(), ${inv1}, ${userA})`;
    await owner`
      insert into public.payment (org_id, reference, invoice_id, amount_minor, base_amount_minor, status,
                                  payment_date, method, created_by)
      values (${orgA}, 'PAY-h18-1', ${inv2}, 200, 200, 'recorded', ${asOf}::date, 'bank_transfer', ${userA})`;

    const ctx = ctxOf(orgA, userA);
    const [ar, all, overdue, over90] = await Promise.all([
      computeAR(ctx, "owner", asOf),
      listOutstandingInvoices(ctx, "owner", asOf, "all"),
      listOutstandingInvoices(ctx, "owner", asOf, "overdue"),
      listOutstandingInvoices(ctx, "owner", asOf, "over90"),
    ]);
    const sum = (rows: Array<{ balanceMinor: number }> | null) =>
      (rows ?? []).reduce((n, r) => n + r.balanceMinor, 0);
    expect(sum(all)).toBe(ar.outstandingMinor);
    expect(sum(over90)).toBe(ar.over90);
    expect(ar.over90).toBe(900); // credit note applied to inv1 only
    expect(ar.d1_30).toBe(300); // partial payment allocated to inv2 only
    expect(sum(overdue)).toBe(
      (ar.d1_30 ?? 0) + (ar.d31_60 ?? 0) + (ar.d61_90 ?? 0) + (ar.over90 ?? 0),
    );
    expect(overdue!.every((r) => r.ageDays >= 1)).toBe(true);
    expect(over90!.every((r) => r.ageDays > 90)).toBe(true);
  });

  it("restricted access: price redaction and role scoping hold on the drill-downs", async () => {
    // Non-price-privileged: the list is null (redacted), never zeros.
    const redacted = await listOutstandingInvoices(ctxOf(orgA, userA, false), "owner", asOf, "all");
    expect(redacted).toBeNull();
    // A viewer cannot reach the review queue at all.
    await expect(listReviewQueue(ctxOf(orgA, userA), "viewer")).rejects.toThrow();
  });

  it("cross-organization denial: org B sees none of org A's drill-down records", async () => {
    const ctx = ctxOf(orgB, userB);
    const ar = await computeAR(ctx, "owner", asOf);
    expect(ar.outstandingMinor).toBe(0);
    const list = await listOutstandingInvoices(ctx, "owner", asOf, "all");
    expect(list).toEqual([]);
    const overdue = (await listJobs(ctx, "owner")).filter((j) => jobIsOverdue(j, asOf));
    expect(overdue).toEqual([]);
  });

  it("forged workflow: another organization's blueprint can never reach a creation", async () => {
    // org B has no applied revision; the in-tx read is org-filtered, so even
    // with org A's revision applied, B's creation stays on the template path.
    const rows = (await withCtx(ctxOf(orgB, userB), (tx) =>
      tx.execute(sql`
        select count(*)::int as n from public.workspace_blueprint_revision
        where status = 'applied'
      `),
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0); // RLS: B cannot even see A's applied revision
  });
});
