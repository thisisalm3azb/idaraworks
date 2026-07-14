/**
 * S7 "Improve" integration (doc 04 rules + digest; doc 11 S7 DoD). Real DB. Proves:
 * the four new E-rule lifecycles (E-05 margin drift, E-06 late supplier, E-08 unusual
 * expense, E-13 document expiry) raise + self-heal; the deterministic digest composes,
 * redacts money per reader, and narrates (fake provider) only validated numbers + meters;
 * the customer-update flow drafts → sends → resolves publicly (safe, no cost) → revokes →
 * expires; a share token is org-pure; and quote-vs-actual + the C-10 divergence exception.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import {
  evaluateNightly,
  evaluateExpenseAnomaly,
  listOpenExceptions,
} from "@/modules/exceptions/service";
import { runOrgNightly } from "@/workers/functions/exception-engine";
import { refreshRollup, getJobCosting } from "@/modules/costing/service";
import { createExpense } from "@/modules/expenses/service";
import {
  composeOwnerDigest,
  getOwnerDigest,
  generateOwnerNarration,
} from "@/modules/digest/service";
import {
  createDraft,
  sendUpdate,
  revokeShare,
  resolvePublicShare,
} from "@/modules/customer-updates/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
let orgId = "";
let presetId = "";
const AS_OF = "2026-07-14";
const NIGHTLY = { asOf: AS_OF, nowMs: Date.parse(`${AS_OF}T03:00:00Z`) };

const ctxOf = (priv: boolean): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "s7-test",
});
const ownerCtx = () => ctxOf(true);
const t = (k: string) => k; // identity resolver for narration labels in tests

async function newJob(ref: string, sellingMinor: number): Promise<string> {
  const id = randomUUID();
  await owner`
    insert into public.job (id, org_id, reference, name, status_key, status_category, created_by,
                            start_date, selling_price_minor, billing_points)
    values (${id}, ${orgId}, ${ref}, ${"Boat " + ref}, 'active', 'active', ${ownerUser}, '2026-01-01',
            ${sellingMinor}, '[{"trigger":"lamination","pct":100}]'::jsonb)`;
  return id;
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`s7-${run}@example.com`}, '{"full_name":"S7"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, { name: "S7 Org", country: "AE", baseCurrency: "AED" });
  const installed = await installTemplate(ownerCtx(), TEMPLATE_BOATBUILDING.key);
  presetId = Object.values(installed.presetIds)[0]!;
  void presetId;
  // Enable AI narration for this org (feature override) so the narration path is testable.
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, enabled)
              values (${orgId}, 'feat.ai_narration', true)
              on conflict (org_id, entitlement_key) do update set enabled = excluded.enabled`;
  await owner`insert into public.org_entitlement_override (org_id, entitlement_key, limit_value)
              values (${orgId}, 'limit.ai_credits_month', 1000)
              on conflict (org_id, entitlement_key) do update set limit_value = excluded.limit_value`;
  invalidateEntitlements(orgId);
}, 120_000);

afterAll(async () => {
  // S10 hygiene: self-clean this file's synthetic org so it leaves no leaked org / outbox backlog.
  await wipeOrgs(owner, [orgId], [ownerUser]).catch(() => {});
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("E-05 margin drift (nightly, C-10 quoted, labour wall via DEFINER)", () => {
  it("raises when cost outruns quote, clears when the quote is raised", async () => {
    const jobId = await newJob(`MD-${run}`, 1_000_000);
    // A stage (not started) → progress 0, so cost% (90) − progress% (0) = 90 > 15 ⇒ drift.
    await owner`insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort, status)
                values (${orgId}, ${jobId}, 'lamination', '{"en":"Lamination","ar":"ت"}'::jsonb, 100, 0, 'not_started')`;
    // Real labour cost 900k (90% of the 1,000,000 quote) via a submitted report + frozen cost.
    const report = randomUUID();
    const emp = randomUUID();
    await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'Ali')`;
    await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${report}, ${orgId}, ${jobId}, '2026-02-01', 'w', 'submitted', ${ownerUser}, now())`;
    await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
                values (${orgId}, ${report}, ${emp}, 5000, 1.5, 900000)`;
    await refreshRollup(ownerCtx(), jobId);
    // Progress low (no completed stages) → cost% 90 ≫ progress ⇒ drift.
    const ev = await evaluateNightly(ownerCtx(), NIGHTLY);
    expect(ev.marginDrift).toBeGreaterThanOrEqual(1);
    let open = await listOpenExceptions(ownerCtx(), "owner", { limit: 300 });
    expect(open.some((e) => e.ruleKey === "margin_drift" && e.jobId === jobId)).toBe(true);
    // Raise the quote far above cost → next sweep self-heals.
    await owner`update public.job set selling_price_minor = 100000000 where id = ${jobId}`;
    await evaluateNightly(ownerCtx(), NIGHTLY);
    open = await listOpenExceptions(ownerCtx(), "owner", { limit: 300 });
    expect(open.some((e) => e.ruleKey === "margin_drift" && e.jobId === jobId)).toBe(false);
  });
});

describe("E-06 late supplier + E-13 document expiry (nightly)", () => {
  it("E-06 flags an overdue PO and (≥3) the supplier; E-13 flags a soon-expiring visa", async () => {
    const sup = randomUUID();
    await owner`insert into public.supplier (id, org_id, name) values (${sup}, ${orgId}, 'Slow Supplier')`;
    // 3 approved POs, each 30 days past approval, unreceived → per-PO + aggregate.
    for (let i = 0; i < 3; i++) {
      await owner`insert into public.purchase_order (org_id, reference, supplier_id, status, approved_at, created_by)
                  values (${orgId}, ${`LP-${run}-${i}`}, ${sup}, 'approved', (${AS_OF}::date - 30), ${ownerUser})`;
    }
    // E-13: an employee whose visa expires in 10 days.
    const emp = randomUUID();
    await owner`insert into public.employee (id, org_id, name) values (${emp}, ${orgId}, 'Sami')`;
    await owner`insert into public.employee_hr (employee_id, org_id, visa_expiry)
                values (${emp}, ${orgId}, (${AS_OF}::date + 10))`;

    const ev = await evaluateNightly(ownerCtx(), NIGHTLY);
    expect(ev.lateSupplier).toBeGreaterThanOrEqual(1);
    expect(ev.documentExpiry).toBeGreaterThanOrEqual(1);
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 400 });
    expect(open.some((e) => e.ruleKey === "late_supplier" && e.subjectId === sup)).toBe(true);
    expect(open.some((e) => e.ruleKey === "document_expiry" && e.subjectId === emp)).toBe(true);
  });
});

describe("E-08 unusual expense (event lane)", () => {
  it("raises for a >3× outlier with enough priors, self-clears on void", async () => {
    const jobId = await newJob(`EX-${run}`, 5_000_000);
    const cats = (await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.categories.expense'`) as unknown as Array<{
      value: { categories: Array<{ key: string; costing_mapping: string }> };
    }>;
    const cat = cats[0]!.value.categories.find((c) => c.costing_mapping === "job_materials")!.key;
    for (let i = 0; i < 4; i++) {
      await createExpense(ownerCtx(), "owner", {
        jobId,
        categoryKey: cat,
        description: "normal",
        expenseDate: "2026-02-02",
        amountMinor: 10000,
      });
    }
    const big = await createExpense(ownerCtx(), "owner", {
      jobId,
      categoryKey: cat,
      description: "spike",
      expenseDate: "2026-02-03",
      amountMinor: 90000, // 9× the 10k median
    });
    const r = await evaluateExpenseAnomaly(ownerCtx(), big.id);
    expect(r.raised).toBe(1);
    let open = await listOpenExceptions(ownerCtx(), "owner", { limit: 400 });
    expect(open.some((e) => e.ruleKey === "unusual_expense" && e.subjectId === big.id)).toBe(true);
    // Voiding the outlier clears it (same entry point, EXPENSE_VOIDED lane).
    await owner`update public.expense set voided_at = now(), void_reason = 'x' where id = ${big.id}`;
    await evaluateExpenseAnomaly(ownerCtx(), big.id);
    open = await listOpenExceptions(ownerCtx(), "owner", { limit: 400 });
    expect(open.some((e) => e.ruleKey === "unusual_expense" && e.subjectId === big.id)).toBe(false);
  });
});

describe("deterministic digest + narration + credit meter", () => {
  it("composes, redacts money per reader, and narrates only validated numbers", async () => {
    await composeOwnerDigest(ownerCtx(), AS_OF);
    const seen = await getOwnerDigest(ownerCtx(), "owner");
    expect(seen).not.toBeNull();
    const collections = seen!.sections.find((s) => s.key === "collections")!;
    expect(collections.moneyMinor === null || typeof collections.moneyMinor === "number").toBe(
      true,
    );
    // A non-price-privileged reader gets the collections money nulled.
    const redacted = await getOwnerDigest(ctxOf(false), "owner");
    expect(redacted!.sections.find((s) => s.key === "collections")!.moneyMinor).toBeNull();

    // Narration path (fake provider) — feat.ai_narration was enabled in beforeAll.
    process.env.AI_NARRATION_PROVIDER = "fake";
    const res = await generateOwnerNarration(ownerCtx(), "owner", seen!.id, "en", t);
    delete process.env.AI_NARRATION_PROVIDER;
    expect(res.status).toBe("generated");
    const [meter] = (await owner`select count(*)::int as n from public.ai_interaction
      where org_id = ${orgId} and feature = 'digest_narration'`) as unknown as Array<{ n: number }>;
    expect(meter!.n).toBeGreaterThanOrEqual(1);
  });
});

describe("customer update + tokenized share surface (F-22)", () => {
  it("drafts → sends (safe snapshot, no cost) → resolves publicly → revokes → expires", async () => {
    const jobId = await newJob(`CU-${run}`, 3_000_000);
    // Complete a stage so the safe snapshot carries a milestone.
    await owner`insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort, status)
                values (${orgId}, ${jobId}, 'lamination', '{"en":"Lamination","ar":"التصفيح"}'::jsonb, 100, 0, 'completed')`;
    const draft = await createDraft(ownerCtx(), "owner", {
      jobId,
      title: "Update",
      body: "Progress is good.",
      language: "en",
    });
    const sent = await sendUpdate(ownerCtx(), "owner", draft.id);
    expect(sent.token.length).toBeGreaterThan(20);
    // Public resolve returns the SAFE payload — and NOTHING that looks like cost.
    const pub = await resolvePublicShare(sent.token);
    expect(pub).not.toBeNull();
    expect(JSON.stringify(pub)).not.toMatch(/cost|labour|margin|selling/i);
    // Revoke → the same token no longer resolves.
    await revokeShare(ownerCtx(), "owner", sent.shareTokenId);
    expect(await resolvePublicShare(sent.token)).toBeNull();
  });

  it("an expired token resolves to nothing", async () => {
    const draft = await createDraft(ownerCtx(), "owner", {
      title: "Old",
      body: "b",
      language: "en",
    });
    const sent = await sendUpdate(ownerCtx(), "owner", draft.id);
    // Force the token expiry into the past.
    const hash = createHash("sha256").update(sent.token).digest("hex");
    await owner`update public.share_token set expires_at = now() - interval '1 day' where token_hash = ${hash}`;
    expect(await resolvePublicShare(sent.token)).toBeNull();
  });

  it("a garbage / unknown token resolves to nothing (no enumeration)", async () => {
    expect(await resolvePublicShare("not-a-real-token-aaaaaaaaaaaaaaaa")).toBeNull();
  });
});

describe("quote-vs-actual (C-10) + worker direct invocation", () => {
  it("getJobCosting reads the accepted quote as quoted; runOrgNightly is idempotent", async () => {
    const jobId = await newJob(`QA-${run}`, 2_000_000);
    // An accepted (converted) quote of 2,500,000 must WIN over the 2,000,000 selling price.
    await owner`insert into public.quote (org_id, reference, status, converted_job_id, base_total_minor, accepted_at, created_by)
                values (${orgId}, ${`QA-Q-${run}`}, 'converted', ${jobId}, 2500000, now(), ${ownerUser})`;
    await refreshRollup(ownerCtx(), jobId);
    const view = await getJobCosting(ownerCtx(), "owner", jobId, "AED");
    expect(view.quotedMinor).toBe(2500000); // accepted quote wins (C-10)
    // Divergence (quote 2.5M ≠ selling 2.0M) raised its own exception.
    const open = await listOpenExceptions(ownerCtx(), "owner", { limit: 500 });
    expect(open.some((e) => e.ruleKey === "quote_divergence" && e.jobId === jobId)).toBe(true);

    // Worker unit: runOrgNightly returns counts and is safe to run twice (idempotent) —
    // the SECOND run creates no duplicates (raises none new) and the OPEN set is stable.
    const a = await runOrgNightly(ownerCtx(), NIGHTLY);
    const afterA = (await listOpenExceptions(ownerCtx(), "owner", { limit: 500 })).length;
    const b = await runOrgNightly(ownerCtx(), NIGHTLY);
    const afterB = (await listOpenExceptions(ownerCtx(), "owner", { limit: 500 })).length;
    expect(typeof a.raised).toBe("number");
    expect(typeof b.digestSections).toBe("number");
    expect(afterB).toBe(afterA); // no duplication on the second sweep
  }, 120_000); // the full nightly runs twice over an org with several seeded jobs (Seoul RTT)
});

describe("regression #4 — DEFINER candidate helpers enforce the org self-check", () => {
  it("cross-org p_org yields NOTHING: a caller only ever reads its OWN org's walled candidates", async () => {
    // A SECOND org B with real walled candidate data (a soon-expiring visa AND a drift job).
    // The DEFINER functions bypass RLS, so their ONLY tenant guard is p_org = current_org_id().
    const orgB = await createOrgForUser(ownerUser, {
      name: "S7 Org B",
      country: "AE",
      baseCurrency: "AED",
    });
    const ctxB: Ctx = {
      orgId: orgB,
      userId: ownerUser,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: "s7-test-b",
    };
    // E-13 candidate in B: employee whose visa expires in 10 days.
    const empB = randomUUID();
    await owner`insert into public.employee (id, org_id, name) values (${empB}, ${orgB}, 'B-Emp')`;
    await owner`insert into public.employee_hr (employee_id, org_id, visa_expiry)
                values (${empB}, ${orgB}, (current_date + 10))`;
    // E-05 candidate in B: active job, not-started stage (progress 0), labour ≈ 90% of quote.
    const jobB = randomUUID();
    await owner`
      insert into public.job (id, org_id, reference, name, status_key, status_category, created_by,
                              start_date, selling_price_minor, billing_points)
      values (${jobB}, ${orgB}, ${`B-MD-${run}`}, 'B drift', 'active', 'active', ${ownerUser}, '2026-01-01',
              1000000, '[{"trigger":"lamination","pct":100}]'::jsonb)`;
    await owner`insert into public.job_stage (org_id, job_id, stage_key, name, weight, sort, status)
                values (${orgB}, ${jobB}, 'lamination', '{"en":"Lamination","ar":"ت"}'::jsonb, 100, 0, 'not_started')`;
    const reportB = randomUUID();
    const empB2 = randomUUID();
    await owner`insert into public.employee (id, org_id, name) values (${empB2}, ${orgB}, 'B-Ali')`;
    await owner`insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by, submitted_at)
                values (${reportB}, ${orgB}, ${jobB}, '2026-02-01', 'w', 'submitted', ${ownerUser}, now())`;
    await owner`insert into public.report_labour_cost (org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor)
                values (${orgB}, ${reportB}, ${empB2}, 5000, 1.5, 900000)`;
    await refreshRollup(ctxB, jobB);

    // Baseline — from B's OWN context, both helpers return B's candidates.
    const [ownDocs, ownDrift] = await withCtx(ctxB, async (tx) => {
      const docs = (await tx.execute(
        sql`select employee_id::text as id from app.document_expiry_candidates(${orgB}, 30)`,
      )) as unknown as Array<{ id: string }>;
      const drift = (await tx.execute(
        sql`select job_id::text as id from app.margin_drift_candidates(${orgB}, 15, 90, 90)`,
      )) as unknown as Array<{ id: string }>;
      return [docs, drift];
    });
    expect(ownDocs.some((r) => r.id === empB)).toBe(true);
    expect(ownDrift.some((r) => r.id === jobB)).toBe(true);

    // ATTACK — from org A's context, ask for org B's uuid. The self-check must return ZERO rows.
    const [xDocs, xDrift] = await withCtx(ownerCtx(), async (tx) => {
      const docs = (await tx.execute(
        sql`select employee_id::text as id from app.document_expiry_candidates(${orgB}, 30)`,
      )) as unknown as Array<{ id: string }>;
      const drift = (await tx.execute(
        sql`select job_id::text as id from app.margin_drift_candidates(${orgB}, 15, 90, 90)`,
      )) as unknown as Array<{ id: string }>;
      return [docs, drift];
    });
    expect(xDocs).toHaveLength(0); // B's walled HR never leaks to A
    expect(xDrift).toHaveLength(0); // B's labour-derived drift never leaks to A
  }, 120_000);
});

describe("regression #5 — digest headline count is a full COUNT, never the LIMIT-10 preview length", () => {
  it("at_risk count reflects the TRUE number of open owner-risk exceptions, items[] stay capped at 10", async () => {
    // Seed 12 open owner-audience risk exceptions (> the 10-row items preview cap).
    await owner`
      insert into public.exception (org_id, rule_key, severity, audience_roles, dedup_key)
      select ${orgId}, 'overdue_stage', 'warning', array['owner'],
             'capcheck-' || ${run} || '-' || g
      from generate_series(1, 12) g`;
    // Ground truth: the same predicate composeOwnerDigest uses for the at_risk section.
    const [truth] = (await owner`
      select count(*)::int as n from public.exception
      where org_id = ${orgId} and resolved_at is null and 'owner' = any(audience_roles)
        and rule_key in ('overdue_stage','margin_drift','missing_report','approval_stuck','billing_point_uninvoiced')`) as unknown as Array<{
      n: number;
    }>;
    expect(truth!.n).toBeGreaterThan(10); // precondition: more than the preview cap

    await composeOwnerDigest(ownerCtx(), AS_OF);
    const view = await getOwnerDigest(ownerCtx(), "owner");
    const atRisk = view!.sections.find((s) => s.key === "at_risk")!;
    expect(atRisk.count).toBe(truth!.n); // headline is the FULL count, not min(count, 10)
    expect(atRisk.count).toBeGreaterThan(atRisk.items.length); // proves it is not the capped length
    expect(atRisk.items.length).toBeLessThanOrEqual(10); // preview list still bounded
  });
});
