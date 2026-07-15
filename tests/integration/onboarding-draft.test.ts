/**
 * U4 pre-org onboarding flow integration (real hosted DB; self-cleaning).
 * Proves, against migration 0073 + the confirm chain:
 *  - draft save/resume round-trip under USER ctx (withUserCtx; no org GUC);
 *  - user-scoped RLS: user A can neither read nor write user B's draft;
 *  - the FULL confirm chain as functions: fresh user → complete draft →
 *    runConfirmChain → org exists, the template is applied ONLY at confirm
 *    (config.template absent before), the tier selection is recorded in
 *    app_settings (a choice — NO org_addon rows), branding saved through the
 *    real service, draft completed, and NO seeded domain rows (0 customers /
 *    0 jobs / 0 suppliers / 0 employees — templates configure structure only);
 *  - idempotent double-confirm (same org, no duplicates);
 *  - honest mid-chain resume: org created but template not applied → the next
 *    confirm finishes into the SAME org (no second org, no re-create).
 * Never touches the protected production orgs; wipeOrgs + explicit draft
 * deletes (onboarding_draft is user-keyed, so wipeOrgs alone can't reach it).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withUserCtx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  DraftDataSchema,
  getDraft,
  runConfirmChain,
  saveDraft,
  ConfirmChainError,
  TIER_SETTING_KEY,
  type DraftData,
} from "@/modules/onboarding/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
const orgIds: string[] = [];

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"U4 Flow Test"}'::jsonb, now(), now())`;
}

function completeDraftData(name: string): DraftData {
  return DraftDataSchema.parse({
    answers: {
      business_name: name,
      legal_name: `${name} LLC`,
      industry: "field_services",
      business_description: "AC maintenance and repair callouts for villas",
      country: "AE",
      timezone: "Asia/Dubai",
      base_currency: "AED",
      preferred_language: "en",
      employees_band: "6-20",
      users_band: "4-10",
      locations_band: "1",
      departments: ["operations", "field_teams"],
      work_patterns: ["service"],
      work_intake: ["phone_whatsapp"],
      workflow_description: "customer calls, we visit, quote, fix, invoice",
      capabilities: ["quotes", "invoices", "daily_reports"],
      device: "both",
      customer_sharing: true,
      main_problem: "updates scattered across chats",
    },
    template: { selected_key: "service_business_v1", recommended_key: "service_business_v1" },
    terms: { job_term_en: "Callout" }, // typed term → terminology override applies
    tier: { mode: "tier_medium" },
    branding: { accent_color: "#0f766e", display_name: name },
  });
}

beforeAll(async () => {
  await seedAuthUser(userA, `u4a-${run}@example.com`);
  await seedAuthUser(userB, `u4b-${run}@example.com`);
}, 120_000);

afterAll(async () => {
  // onboarding_draft is USER-keyed — wipeOrgs (org_id sweep) can't reach it.
  await owner`delete from public.onboarding_draft where user_id in (${userA}, ${userB})`;
  await wipeOrgs(owner, orgIds, [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("draft save/resume round-trip under user ctx", () => {
  it("upserts, resumes to the saved step, and survives re-save", async () => {
    expect(await getDraft(userA)).toBeNull();
    const partial = DraftDataSchema.parse({
      answers: { business_name: `Resume ${run}`, industry: "field_services" },
    });
    await saveDraft(userA, { data: partial, step: "region" });
    const loaded = await getDraft(userA);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("active");
    expect(loaded!.step).toBe("region"); // resume lands here after refresh/login
    expect(loaded!.data.answers.business_name).toBe(`Resume ${run}`);

    // Autosave on a later step overwrites data + step (no data loss on refresh).
    const fuller = DraftDataSchema.parse({
      ...loaded!.data,
      answers: { ...loaded!.data.answers, country: "AE" },
    });
    await saveDraft(userA, { data: fuller, step: "scale" });
    const again = await getDraft(userA);
    expect(again!.step).toBe("scale");
    expect(again!.data.answers.country).toBe("AE");
  }, 60_000);

  it("RLS: user B cannot read or write user A's draft", async () => {
    // Direct SELECT under B's user ctx sees nothing of A's row.
    const rows = (await withUserCtx(userB, (tx) =>
      tx.execute(sql`select user_id from public.onboarding_draft where user_id = ${userA}`),
    )) as unknown as Array<{ user_id: string }>;
    expect(rows.length).toBe(0);
    // Service read under B is B's own (null — B has no draft yet).
    expect(await getDraft(userB)).toBeNull();
    // An UPDATE aimed at A's row from B's ctx hits zero rows.
    await withUserCtx(userB, (tx) =>
      tx.execute(sql`update public.onboarding_draft set step = 'welcome' where user_id = ${userA}`),
    );
    const after = await getDraft(userA);
    expect(after!.step).toBe("scale"); // untouched
    // The row is really there (owner bypasses RLS) — so the empty read was policy.
    const ownerRows = await owner`
      select user_id from public.onboarding_draft where user_id = ${userA}`;
    expect(ownerRows.length).toBe(1);
  }, 60_000);
});

describe("full confirm chain (functions, no HTTP)", () => {
  it("creates the org, applies the template ONLY at confirm, records tier + branding, completes the draft, seeds NOTHING", async () => {
    await saveDraft(userA, { data: completeDraftData(`U4 Flow ${run}`), step: "review" });

    // BEFORE confirm: no org for the user at all — nothing was created or applied.
    const orgsBefore = await owner`
      select org_id from public.membership where user_id = ${userA}`;
    expect(orgsBefore.length).toBe(0);

    const { orgId, alreadyCompleted } = await runConfirmChain(userA);
    orgIds.push(orgId);
    expect(alreadyCompleted).toBe(false);

    // Org exists with the questionnaire's identity.
    const [org] = await owner`
      select name, country, base_currency, timezone from public.org where id = ${orgId}`;
    expect(org!.name).toBe(`U4 Flow ${run}`);
    expect(org!.country).toBe("AE");
    expect(org!.base_currency).toBe("AED");
    expect(org!.timezone).toBe("Asia/Dubai");

    // Template applied (the ONLY application — at confirm): install marker set,
    // session applied, and the typed job term landed as a terminology override.
    const [tpl] = await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.template'`;
    expect(tpl).toBeTruthy();
    const [session] = await owner`
      select status, template_key from public.onboarding_session where org_id = ${orgId}`;
    expect(session!.status).toBe("applied");
    expect(session!.template_key).toBe("service_business_v1");
    const [termRow] = await owner`
      select value from public.app_settings
      where org_id = ${orgId} and key = 'terminology.overrides'`;
    expect(JSON.stringify(termRow?.value ?? "")).toContain("Callout");

    // Tier selection RECORDED in app_settings — and NOT an entitlement change.
    const [tier] = await owner`
      select value from public.app_settings
      where org_id = ${orgId} and key = ${TIER_SETTING_KEY}`;
    expect(tier).toBeTruthy();
    const tierValue = tier!.value as Record<string, unknown>;
    expect(tierValue.mode).toBe("tier_medium");
    expect(tierValue.recorded_choice_only).toBe(true);
    expect(tierValue.source).toBe("onboarding");
    const addonRows = await owner`
      select addon_key from public.org_addon where org_id = ${orgId}`;
    expect(addonRows.length).toBe(0); // no org_addon writes, no plan change

    // Branding saved through the real service.
    const [branding] = await owner`
      select accent_color, display_name from public.org_branding where org_id = ${orgId}`;
    expect(branding!.accent_color).toBe("#0f766e");
    expect(branding!.display_name).toBe(`U4 Flow ${run}`);

    // Draft completed, confirm progress stashed.
    const draft = await getDraft(userA);
    expect(draft!.status).toBe("completed");
    expect(draft!.data.confirm.org_id).toBe(orgId);
    expect(draft!.data.confirm.applied).toBe(true);

    // Templates configure STRUCTURE only — zero seeded domain rows.
    for (const table of ["customer", "job", "supplier", "employee"] as const) {
      const rows = (await owner.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1`,
        [orgId],
      )) as unknown as Array<{ n: number }>;
      expect(Number(rows[0]!.n)).toBe(0);
    }
  }, 120_000);

  it("double-confirm is idempotent: same org, no duplicates", async () => {
    const first = await getDraft(userA);
    const { orgId, alreadyCompleted } = await runConfirmChain(userA);
    expect(alreadyCompleted).toBe(true);
    expect(orgId).toBe(first!.data.confirm.org_id);
    // Still exactly one membership, one org, one onboarding session.
    const memberships = await owner`
      select org_id from public.membership where user_id = ${userA}`;
    expect(memberships.length).toBe(1);
    const sessions = await owner`
      select id from public.onboarding_session where org_id = ${orgId}`;
    expect(sessions.length).toBe(1);
  }, 120_000);

  it("an incomplete draft can never confirm", async () => {
    const partial = DraftDataSchema.parse({
      answers: { business_name: `Incomplete ${run}` },
    });
    await saveDraft(userB, { data: partial, step: "business" });
    await expect(runConfirmChain(userB)).rejects.toBeInstanceOf(ConfirmChainError);
    await expect(runConfirmChain(userB)).rejects.toMatchObject({ code: "incomplete" });
    // Nothing happened: no org, draft still active.
    const orgs = await owner`select org_id from public.membership where user_id = ${userB}`;
    expect(orgs.length).toBe(0);
    expect((await getDraft(userB))!.status).toBe("active");
  }, 60_000);

  it("mid-chain resume: org created but template NOT applied → next confirm finishes into the SAME org", async () => {
    // Simulate a chain that died right after org creation (the stash carries
    // the org id; nothing else ran). config.template must be ABSENT here.
    const name = `U4 Resume ${run}`;
    const data = completeDraftData(name);
    const orgId = await createOrgForUser(userB, {
      name,
      country: "AE",
      baseCurrency: "AED",
      timezone: "Asia/Dubai",
      languages: ["en", "ar"],
      sixDayWeek: false,
    });
    orgIds.push(orgId);
    const withProgress = DraftDataSchema.parse({
      ...data,
      confirm: { org_id: orgId },
    });
    await saveDraft(userB, { data: withProgress, step: "review" });

    const before = await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.template'`;
    expect(before.length).toBe(0); // template applied ONLY after confirm

    const res = await runConfirmChain(userB);
    expect(res.orgId).toBe(orgId); // resumed — never a second org
    const orgs = await owner`select org_id from public.membership where user_id = ${userB}`;
    expect(orgs.length).toBe(1);
    const [tpl] = await owner`
      select value from public.app_settings where org_id = ${orgId} and key = 'config.template'`;
    expect(tpl).toBeTruthy();
    const [tier] = await owner`
      select value from public.app_settings
      where org_id = ${orgId} and key = ${TIER_SETTING_KEY}`;
    expect(tier).toBeTruthy();
    expect((await getDraft(userB))!.status).toBe("completed");
  }, 120_000);
});
