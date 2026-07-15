/**
 * PTA8 demo — template catalogue + deterministic onboarding + add-on commercial model,
 * demonstrated end-to-end against the hosted DB with numbered PASS/FAIL assertions.
 *
 * Mirrors tooling/scripts/s11-pilot-sim.ts: owner connection on DIRECT_URL for
 * arrange/inspect, real services for every act, self-cleanup registered BEFORE seeding
 * (runs even on failure), protected-org before/after byte-identical check, final
 * numbered summary, non-zero exit on any failure.
 *
 * HARD RULES honoured:
 *  - NEVER touches Alpha Marine (d22b2098…) or TESTING (9fcaa697…) — verified byte-identical.
 *  - Every synthetic org/user is prefixed PTA8-DEMO- / pta8-demo- and wiped at the end.
 *  - No real payments: BILLING_PROVIDER=fake in THIS process only (dev default is fake anyway).
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser, inviteMember, SeatLimitError } from "@/platform/auth/identity";
import { TEMPLATES, TEMPLATE_CATALOGUE } from "@/platform/config";
import {
  classifyBusiness,
  GENERIC_TEMPLATE_KEY,
  MIN_LEAD,
} from "@/modules/onboarding/classify";
import { selectTemplate } from "@/modules/onboarding/provider";
import { OnboardingIntakeSchema } from "@/modules/onboarding/proposal";
import {
  startOnboarding,
  getOnboardingSession,
  applyOnboarding,
} from "@/modules/onboarding/service";
import {
  changeAddons,
  changePlan,
  emitFakeSignal,
  BillingProviderDisabledError,
} from "@/modules/subscription/service";
import { sweepLifecycle } from "@/workers/functions/subscription-worker";
import {
  resolveEntitlements,
  invalidateEntitlements,
  BUNDLES,
  getAddon,
  getBundle,
} from "@/platform/entitlements";
import { getBillingProvider } from "@/platform/billing/adapter";
import { createCustomer } from "@/modules/masters/service";

// Fake provider for THIS process only (dev default is fake anyway; explicit per the brief).
process.env.BILLING_PROVIDER = "fake";

const PROTECTED = {
  alphaMarine: "d22b2098-2e09-436d-ab9e-ee26c8719cd5",
  testing: "9fcaa697-becd-41ec-97d4-6ce2851ead36",
};

const owner = postgres(process.env.DIRECT_URL!, { max: 2, onnotice: () => {} });
const run = randomUUID().slice(0, 8);

type Org = { id: string; user: string; name: string };
const orgs: Org[] = []; // registered BEFORE any further seeding → mid-seed failures still clean

let n = 0;
let passCount = 0;
const results: string[] = [];
function assert(label: string, cond: boolean, evidence?: string) {
  n++;
  const line = `${cond ? "PASS" : "FAIL"}  #${String(n).padStart(2, "0")}  ${label}`;
  console.log(line + (evidence ? `\n        evidence: ${evidence}` : ""));
  results.push(line);
  if (!cond) throw new Error(`PTA8 assertion #${n} failed: ${label}`);
  passCount++;
}
function step(title: string) {
  console.log(`\n━━ ${title} ━━`);
}

const ctx = (o: Org): Ctx => ({
  orgId: o.id,
  userId: o.user,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "pta8-demo",
});

async function seedOrg(label: string): Promise<Org> {
  const user = randomUUID();
  await owner`insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`pta8-demo-${run}-${label.toLowerCase()}@example.com`},
            '{"full_name":"PTA8-DEMO Synthetic Owner"}'::jsonb, now(), now())`;
  const name = `PTA8-DEMO-${label}-${run}`;
  const id = await createOrgForUser(user, { name, country: "AE", baseCurrency: "AED" });
  const o: Org = { id, user, name };
  orgs.push(o);
  return o;
}

function intakeFor(o: Org, description: string, templateKey?: string) {
  return {
    business_name: o.name,
    business_description: description,
    ...(templateKey ? { template_key: templateKey } : {}),
    country: "AE" as const,
    base_currency: "AED",
    languages: ["en", "ar"],
    six_day_week: true,
    vat_registered: false,
    approval_auto_approve_below: {},
    requested_features: [],
  };
}

async function installedTemplateKey(orgId: string): Promise<string | null> {
  const rows = (await owner`select value from public.app_settings
    where org_id = ${orgId} and key = 'config.template'`) as unknown as Array<{
    value: { key?: string } | null;
  }>;
  if (rows.length === 0) return null;
  return rows[0]!.value?.key ?? null;
}

async function dbStageNames(orgId: string): Promise<string[]> {
  const rows = (await owner`select value from public.app_settings
    where org_id = ${orgId} and key = 'config.stage_template'`) as unknown as Array<{
    value: { stages?: Array<{ names?: { en?: string } }> } | null;
  }>;
  return (rows[0]?.value?.stages ?? []).map((s) => s.names?.en ?? "");
}

const DOMAIN_TABLES = ["job", "customer", "supplier", "invoice", "payment", "expense"] as const;
async function domainCounts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of DOMAIN_TABLES) {
    const r = (await owner.unsafe(
      `select count(*)::int as n from public.${t} where org_id = $1`,
      [orgId],
    )) as unknown as Array<{ n: number }>;
    out[t] = Number(r[0]!.n);
  }
  return out;
}

async function addonRow(
  orgId: string,
  key: string,
): Promise<{ status: string; quantity: number; source: string } | undefined> {
  const rows = (await owner`select status, quantity::int as quantity, source
    from public.org_addon where org_id = ${orgId} and addon_key = ${key}`) as unknown as Array<{
    status: string;
    quantity: number;
    source: string;
  }>;
  return rows[0];
}

async function planState(orgId: string): Promise<{
  plan_key: string;
  billing_state: string;
  scheduled_plan_key: string | null;
}> {
  const rows = (await owner`select plan_key, billing_state, scheduled_plan_key
    from public.org_plan_state where org_id = ${orgId}`) as unknown as Array<{
    plan_key: string;
    billing_state: string;
    scheduled_plan_key: string | null;
  }>;
  return rows[0]!;
}

/** Canonical protected-org snapshot: the FULL org_plan_state row as server-rendered JSON text. */
async function protectedSnapshot(): Promise<string> {
  const rows = (await owner`
    select o.name, row_to_json(ops)::text as row
    from public.org_plan_state ops join public.org o on o.id = ops.org_id
    where ops.org_id in (${PROTECTED.alphaMarine}::uuid, ${PROTECTED.testing}::uuid)
    order by ops.org_id`) as unknown as Array<{ name: string; row: string }>;
  return rows.map((r) => `[${r.name}] ${r.row}`).join("\n");
}

async function orgInventory(): Promise<string> {
  const rows = (await owner`select id::text as id, name from public.org order by id`) as unknown as Array<{
    id: string;
    name: string;
  }>;
  return rows.map((r) => `${r.id}  ${r.name}`).join("\n");
}

// Recorded up-front for step 13/14 verification.
let protectedBefore = "";
let inventoryBefore = "";

// Full intake→proposal→apply path for one org; returns the sessionId.
async function onboardOrg(o: Org, description: string, expectKey: string): Promise<void> {
  const start = await startOnboarding(ctx(o), "owner", intakeFor(o, description));
  if (start.proposal.template_key !== expectKey) {
    throw new Error(
      `onboarding proposal for ${o.name} recommended ${start.proposal.template_key}, expected ${expectKey}`,
    );
  }
  await applyOnboarding(ctx(o), "owner", start.sessionId);
}

async function main() {
  // ── STEP 13 (arrange half): protected-org snapshot + org inventory BEFORE anything ──
  protectedBefore = await protectedSnapshot();
  inventoryBefore = await orgInventory();
  console.log("PROTECTED ORGS — BEFORE (verbatim org_plan_state rows):");
  console.log(protectedBefore);
  console.log(`\norg inventory before demo: ${inventoryBefore.split("\n").length} org(s)`);

  // ═══ 1. TEMPLATE CATALOGUE ═══
  step("STEP 1 — TEMPLATE CATALOGUE (8 templates, unique keys)");
  for (const e of TEMPLATE_CATALOGUE) {
    console.log(`  ${e.key.padEnd(28)} EN: ${e.names.en}  |  AR: ${e.names.ar}`);
  }
  const keys = TEMPLATE_CATALOGUE.map((e) => e.key);
  assert(
    "template catalogue registers exactly 8 templates",
    TEMPLATE_CATALOGUE.length === 8,
    `count=${TEMPLATE_CATALOGUE.length}`,
  );
  assert(
    "catalogue keys are unique and every key has an installable manifest",
    new Set(keys).size === 8 && keys.every((k) => TEMPLATES[k] !== undefined),
    keys.join(", "),
  );

  // ═══ 2. DETERMINISTIC RECOMMENDATION ═══
  step("STEP 2 — DETERMINISTIC CLASSIFICATION (8 canonical + Arabic + ambiguous)");
  const CASES: Array<{ label: string; desc: string; expect: string }> = [
    {
      label: "boatyard",
      desc: "We run a boatyard on the creek building fiberglass boats — hull lamination, fit out and marine repair work",
      expect: "boatbuilding_marine_v1",
    },
    {
      label: "metal fabrication",
      desc: "Steel fabrication workshop doing custom metalwork, welding and sheet metal jobs for industrial clients",
      expect: "manufacturing_workshop_v1",
    },
    {
      label: "restaurant",
      desc: "We operate a restaurant and catering kitchen preparing daily meals and event food",
      expect: "food_beverage_v1",
    },
    {
      label: "electronics e-commerce",
      desc: "An e-commerce online store selling electronics and mobile phones with order fulfilment from our own warehouse",
      expect: "online_store_v1",
    },
    {
      label: "maintenance company",
      desc: "A maintenance and repair company — each technician handles AC service call visits and installation work",
      expect: "service_business_v1",
    },
    {
      label: "building contractor",
      desc: "We are a building contractor for construction, fit-out and renovation works with subcontractor crews",
      expect: "construction_v1",
    },
    {
      label: "crop farm",
      desc: "Our farm grows vegetable crops under greenhouse cover and drip irrigation with a seasonal harvest",
      expect: "agriculture_v1",
    },
    {
      label: "ambiguous small business",
      desc: "We have a small family business",
      expect: GENERIC_TEMPLATE_KEY,
    },
  ];
  for (const c of CASES) {
    const r = classifyBusiness(c.desc);
    const top = r.ranked.find((m) => m.key === r.recommendedKey);
    const signals = top ? [...top.matchedKeywords, ...top.matchedPhrases] : [];
    console.log(
      `  [${c.label}] → ${r.recommendedKey} (score=${top?.score ?? 0}, confident=${r.confident})` +
        `\n        reason signals: ${signals.length ? signals.join(", ") : "(none — generic fallback)"}`,
    );
    assert(
      `classifier: ${c.label} → ${c.expect}`,
      r.recommendedKey === c.expect,
      `got ${r.recommendedKey} score=${top?.score ?? 0}`,
    );
  }
  // Arabic description.
  const arDesc = "مطعم ومقهى يقدم وجبات وحلويات للمناسبات";
  const arRes = classifyBusiness(arDesc);
  const arTop = arRes.ranked.find((m) => m.key === arRes.recommendedKey);
  console.log(
    `  [arabic: ${arDesc}] → ${arRes.recommendedKey} (score=${arTop?.score}, ` +
      `signals: ${[...(arTop?.matchedKeywords ?? [])].join(", ")})`,
  );
  assert(
    "Arabic description (مطعم ومقهى …) → food_beverage_v1",
    arRes.recommendedKey === "food_beverage_v1",
    `score=${arTop?.score}`,
  );
  // Mixed/ambiguous: signals for two different templates → honest ambiguity surface.
  const ambDesc = "We are a workshop doing repair work";
  const amb = classifyBusiness(ambDesc);
  const nonGeneric = amb.ranked.filter((m) => m.key !== GENERIC_TEMPLATE_KEY);
  const lead = nonGeneric[0]!.score - (nonGeneric[1]?.score ?? 0);
  console.log(
    `  [mixed: "${ambDesc}"] top=${nonGeneric[0]!.key}(${nonGeneric[0]!.score}) ` +
      `runner-up=${nonGeneric[1]!.key}(${nonGeneric[1]!.score}) lead=${lead} confident=${amb.confident}`,
  );
  const ambIntake = OnboardingIntakeSchema.parse(
    intakeFor({ id: "", user: "", name: "PTA8 Probe" } as Org, ambDesc),
  );
  const ambSel = selectTemplate(ambIntake);
  assert(
    "mixed description is honestly AMBIGUOUS: confident=false, lead < MIN_LEAD, alternatives surfaced",
    amb.confident === false && lead < MIN_LEAD && ambSel.confident === false &&
      ambSel.alternatives.length === TEMPLATE_CATALOGUE.length - 1,
    `lead=${lead} (< ${MIN_LEAD}); ${ambSel.alternatives.length} scored alternatives surfaced`,
  );

  // ═══ 3. MANUAL OVERRIDE ═══
  step("STEP 3 — MANUAL OVERRIDE (explicit template_key beats the classifier)");
  const restDesc = CASES[2]!.desc; // clearly a restaurant
  const overrideIntake = OnboardingIntakeSchema.parse(
    intakeFor({ id: "", user: "", name: "PTA8 Probe" } as Org, restDesc, "construction_v1"),
  );
  const overridden = selectTemplate(overrideIntake);
  console.log(
    `  same restaurant description + template_key=construction_v1 → ${overridden.key}` +
      `\n        reason: "${overridden.reasonEn}"`,
  );
  assert(
    "explicit template_key wins over the classifier (restaurant text → construction_v1)",
    overridden.key === "construction_v1" &&
      overridden.reasonEn === "You selected this template yourself." &&
      overridden.confident === true,
    `key=${overridden.key}`,
  );

  // ═══ 4. EXPLICIT CONFIRMATION (org #1) ═══
  step("STEP 4 — EXPLICIT CONFIRMATION: propose ≠ install; only apply installs (org #1)");
  const org1 = await seedOrg("ORG1-FAB");
  const st1 = await planState(org1.id);
  console.log(`  org #1 ${org1.name} (${org1.id}) created — plan=${st1.plan_key}/${st1.billing_state}`);
  assert(
    "org #1 created on the growth trial default",
    st1.plan_key === "growth" && st1.billing_state === "trialing",
    `${st1.plan_key}/${st1.billing_state}`,
  );
  const start1 = await startOnboarding(ctx(org1), "owner", intakeFor(org1, CASES[1]!.desc));
  const sess1 = await getOnboardingSession(ctx(org1), "owner", start1.sessionId);
  console.log(
    `  proposal generated: session=${start1.sessionId} status=${sess1?.status} ` +
      `template=${start1.proposal.template_key}\n        summary: ${start1.proposal.intake_summary_en}`,
  );
  assert(
    "startOnboarding leaves the session 'proposed' (manufacturing recommended)",
    sess1?.status === "proposed" && start1.proposal.template_key === "manufacturing_workshop_v1",
    `status=${sess1?.status} template=${start1.proposal.template_key}`,
  );
  const preInstall = await installedTemplateKey(org1.id);
  assert(
    "NO template installed at the proposal stage (config.template absent)",
    preInstall === null,
    `config.template=${JSON.stringify(preInstall)}`,
  );
  const applied1 = await applyOnboarding(ctx(org1), "owner", start1.sessionId);
  const post1 = await installedTemplateKey(org1.id);
  const sess1b = await getOnboardingSession(ctx(org1), "owner", start1.sessionId);
  console.log(
    `  applyOnboarding → installed=${applied1.installed}, ${applied1.revisionIds.length} config revisions, ` +
      `session=${sess1b?.status}, config.template=${post1}`,
  );
  assert(
    "applyOnboarding is what installs: config.template now manufacturing_workshop_v1, session 'applied'",
    applied1.installed === true && post1 === "manufacturing_workshop_v1" && sess1b?.status === "applied",
    `installed=${applied1.installed} key=${post1}`,
  );

  // ═══ 5. THREE DIFFERENT TEMPLATES ON THREE ORGS ═══
  step("STEP 5 — THREE TEMPLATES, THREE ORGS (real intake→proposal→apply each)");
  const org2 = await seedOrg("ORG2-FNB");
  const org3 = await seedOrg("ORG3-SVC");
  await onboardOrg(org2, CASES[2]!.desc, "food_beverage_v1"); // restaurant
  await onboardOrg(org3, CASES[4]!.desc, "service_business_v1"); // maintenance
  const EXPECT: Array<{ o: Org; key: string; stage: string }> = [
    { o: org1, key: "manufacturing_workshop_v1", stage: "Fabrication" },
    { o: org2, key: "food_beverage_v1", stage: "Ingredient Prep" },
    { o: org3, key: "service_business_v1", stage: "On Site / In Service" },
  ];
  for (const e of EXPECT) {
    const key = await installedTemplateKey(e.o.id);
    const stages = await dbStageNames(e.o.id);
    const manifestStages = TEMPLATES[e.key]!.stage_template.stages.map((s) => s.names.en);
    const counts = await domainCounts(e.o.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(
      `  ${e.o.name}: template=${key}\n        stages: ${stages.join(" → ")}` +
        `\n        domain rows: ${JSON.stringify(counts)}`,
    );
    assert(
      `${e.o.name} installed ${e.key} with its own stages (incl. "${e.stage}")`,
      key === e.key &&
        stages.includes(e.stage) &&
        JSON.stringify(stages) === JSON.stringify(manifestStages),
      `stage set matches the manifest exactly`,
    );
    assert(
      `${e.o.name}: templates configure, never seed — 0 jobs/customers/suppliers/transactions`,
      total === 0,
      JSON.stringify(counts),
    );
  }

  // ═══ 6. FREE ENTITLEMENTS (org #2) ═══
  step("STEP 6 — FREE BASE PLAN entitlements (org #2 flipped to free)");
  await owner`update public.org_plan_state set plan_key = 'free', billing_state = 'active'
    where org_id = ${org2.id}`;
  invalidateEntitlements(org2.id);
  const entFree = await resolveEntitlements(ctx(org2));
  console.log(
    `  free plan resolution: cap.jobs=${entFree.features["cap.jobs"]} cap.daily_reports=${entFree.features["cap.daily_reports"]} ` +
      `cap.quoting=${entFree.features["cap.quoting"]} cap.payments=${entFree.features["cap.payments"]} ` +
      `limit.full_users=${entFree.limits["limit.full_users"]}`,
  );
  assert(
    "free plan: operational caps ON, money caps OFF, 3 full seats",
    entFree.planKey === "free" &&
      entFree.features["cap.jobs"] === true &&
      entFree.features["cap.daily_reports"] === true &&
      entFree.features["cap.quoting"] === false &&
      entFree.features["cap.payments"] === false &&
      entFree.limits["limit.full_users"] === 3,
  );

  // ═══ 7. INDIVIDUAL ADD-ON (org #2) ═══
  step("STEP 7 — INDIVIDUAL ADD-ON: addon.quotes_invoices via changeAddons (fake provider)");
  const add7 = await changeAddons(ctx(org2), "owner", {
    additions: [{ addonKey: "addon.quotes_invoices" }],
    removals: [],
  });
  const row7 = await addonRow(org2.id, "addon.quotes_invoices");
  invalidateEntitlements(org2.id);
  const ent7 = await resolveEntitlements(ctx(org2));
  console.log(
    `  changeAddons added=${add7.added}; org_addon row: ${JSON.stringify(row7)}; cap.quoting=${ent7.features["cap.quoting"]}`,
  );
  assert(
    "individual add-on activates through the provider→webhook round-trip; cap.quoting flips true",
    add7.added === 1 &&
      row7?.status === "active" &&
      row7.quantity === 1 &&
      row7.source === "individual" &&
      ent7.features["cap.quoting"] === true,
  );

  // ═══ 8. BUNDLE (org #2) ═══
  step("STEP 8 — BUNDLE: bundle.finance via changeAddons");
  const finance = BUNDLES.find((b) => b.key === "bundle.finance")!;
  console.log(`  bundle.finance members: ${finance.addonKeys.join(", ")}`);
  assert(
    "catalogue honesty: addon.quotes_invoices is NOT a bundle.finance member (no overlap here; " +
      "overlap-dedup is pinned by tests/integration/addon-model.test.ts)",
    !finance.addonKeys.includes("addon.quotes_invoices"),
  );
  const add8 = await changeAddons(ctx(org2), "owner", {
    additions: [],
    removals: [],
    bundleKey: "bundle.finance",
  });
  let allBundleSourced = true;
  for (const key of finance.addonKeys) {
    const r = await addonRow(org2.id, key);
    console.log(`  ${key}: ${JSON.stringify(r)}`);
    if (!(r?.status === "active" && r.source === "bundle.finance")) allBundleSourced = false;
  }
  const row7b = await addonRow(org2.id, "addon.quotes_invoices");
  invalidateEntitlements(org2.id);
  const ent8 = await resolveEntitlements(ctx(org2));
  assert(
    "bundle activation: every member row active with source='bundle.finance'; the pre-existing " +
      "individual quotes_invoices row is untouched",
    add8.added === finance.addonKeys.length &&
      allBundleSourced &&
      row7b?.source === "individual" &&
      ent8.features["cap.payments"] === true &&
      ent8.features["cap.expenses"] === true,
    `added=${add8.added}/${finance.addonKeys.length}`,
  );

  // ═══ 9. MONTHLY TOTAL (pricing-page algorithm, USD) ═══
  step("STEP 9 — MONTHLY TOTAL (bundle price once + individual price × qty)");
  const addonRows = (await owner`select addon_key, quantity::int as quantity, status, source
    from public.org_addon where org_id = ${org2.id} and status in ('active','removal_scheduled')
    order by addon_key`) as unknown as Array<{
    addon_key: string;
    quantity: number;
    status: string;
    source: string;
  }>;
  const countedBundles = new Set<string>();
  let monthlyTotalMinor = 0;
  for (const row of addonRows) {
    const bundle = row.source !== "individual" ? getBundle(row.source) : undefined;
    if (bundle) {
      if (!countedBundles.has(bundle.key)) {
        countedBundles.add(bundle.key);
        monthlyTotalMinor += bundle.usdMonthlyMinor;
      }
      continue;
    }
    const def = getAddon(row.addon_key);
    if (def) monthlyTotalMinor += def.usdMonthlyMinor * Math.max(1, Number(row.quantity) || 1);
  }
  const expectedMinor =
    getBundle("bundle.finance")!.usdMonthlyMinor + getAddon("addon.quotes_invoices")!.usdMonthlyMinor;
  console.log(
    `  active rows: ${addonRows.map((r) => `${r.addon_key}(${r.source})`).join(", ")}` +
      `\n  monthly total = $${(monthlyTotalMinor / 100).toFixed(2)} USD/month ` +
      `(tax-exclusive, indicative) — bundle.finance $${(finance.usdMonthlyMinor / 100).toFixed(2)} once ` +
      `+ quotes_invoices $${(getAddon("addon.quotes_invoices")!.usdMonthlyMinor / 100).toFixed(2)} × 1`,
  );
  assert(
    "monthly total equals the exact sum of the activated items ($9.00 bundle + $5.00 individual = $14.00)",
    monthlyTotalMinor === expectedMinor && monthlyTotalMinor === 1400,
    `computed=${monthlyTotalMinor} expected=${expectedMinor}`,
  );

  // ═══ 10. UPGRADE + SCHEDULED DOWNGRADE (org #3) ═══
  step("STEP 10 — PLAN UPGRADE (immediate) + SCHEDULED DOWNGRADE (period end; never deletes)");
  const cust3 = await createCustomer(ctx(org3), "owner", {
    name: `PTA8-DEMO Customer ${run}`,
    country: "AE",
  });
  const up = await changePlan(ctx(org3), "owner", "business");
  const stUp = await planState(org3.id);
  console.log(`  changePlan growth→business: mode=${up.mode}; state=${JSON.stringify(stUp)}`);
  assert(
    "upgrade growth→business applies immediately",
    up.mode === "immediate" && stUp.plan_key === "business" && stUp.scheduled_plan_key === null,
  );
  // Downgrade to the free base plan: the provider-driven plan path (changePlan's
  // public type covers only the paid tiers; 'free' arrives exactly like a provider
  // would deliver it — a signed plan_changed webhook in 'scheduled' mode).
  const down = await emitFakeSignal(org3.id, "plan_changed", {
    providerEventId: `pta8-downgrade-${run}`,
    planKey: "free",
    planChangeMode: "scheduled",
  });
  const stSched = await planState(org3.id);
  console.log(`  scheduled downgrade → ${down.status}; state=${JSON.stringify(stSched)}`);
  assert(
    "downgrade to free is SCHEDULED: sentinel set, plan unchanged",
    down.status === "processed" &&
      stSched.plan_key === "business" &&
      stSched.scheduled_plan_key === "free",
  );
  // Backdate the anchors so the period boundary is behind us, then run the real sweep.
  await owner`update public.org_plan_state
    set period_start = now() - interval '65 days', scheduled_plan_at = now() - interval '40 days'
    where org_id = ${org3.id}`;
  const sweep = await sweepLifecycle(Date.now());
  const stAfter = await planState(org3.id);
  const keptTemplate = await installedTemplateKey(org3.id);
  const keptCustomer = (await owner`select count(*)::int as c from public.customer
    where org_id = ${org3.id} and id = ${cust3.id}`) as unknown as Array<{ c: number }>;
  const keptPresets = (await owner`select count(*)::int as c from public.job_preset
    where org_id = ${org3.id}`) as unknown as Array<{ c: number }>;
  console.log(
    `  sweepLifecycle: ${JSON.stringify(sweep)}\n  after sweep: ${JSON.stringify(stAfter)}; ` +
      `template=${keptTemplate}, customer rows=${keptCustomer[0]!.c}, presets=${keptPresets[0]!.c}`,
  );
  assert(
    "sweep applies the due downgrade: plan=free, sentinel cleared",
    sweep.plansApplied >= 1 && stAfter.plan_key === "free" && stAfter.scheduled_plan_key === null,
  );
  assert(
    "downgrades never delete data: installed template, customer and presets all survive",
    keptTemplate === "service_business_v1" &&
      Number(keptCustomer[0]!.c) === 1 &&
      Number(keptPresets[0]!.c) > 0,
  );

  // ═══ 11. SEAT LIMIT (org #2, free plan) ═══
  step("STEP 11 — SEAT LIMIT: free plan walls the 3rd invite; foreman is free; a pack lifts it");
  const m1 = await inviteMember(ctx(org2), "owner", {
    email: `pta8-demo-m1-${run}@example.com`,
    roleKey: "manager",
  });
  const m2 = await inviteMember(ctx(org2), "owner", {
    email: `pta8-demo-m2-${run}@example.com`,
    roleKey: "manager",
  });
  let seatErr: unknown;
  try {
    await inviteMember(ctx(org2), "owner", {
      email: `pta8-demo-m3-${run}@example.com`,
      roleKey: "manager",
    });
  } catch (e) {
    seatErr = e;
  }
  console.log(
    `  owner + 2 manager invites fill the cap of 3; 3rd manager → ${(seatErr as Error)?.name}: ${(seatErr as Error)?.message}`,
  );
  assert(
    "the 4th full seat (owner + 2 invites + 1) hits SeatLimitError(limit.full_users=3)",
    Boolean(m1.inviteId && m2.inviteId) &&
      seatErr instanceof SeatLimitError &&
      seatErr.limitKey === "limit.full_users" &&
      seatErr.limit === 3,
  );
  const foreman = await inviteMember(ctx(org2), "owner", {
    email: `pta8-demo-f1-${run}@example.com`,
    roleKey: "foreman",
  });
  assert(
    "a foreman (field seat) invite passes at the cap — field seats are never limited",
    Boolean(foreman.inviteId),
  );
  await changeAddons(ctx(org2), "owner", {
    additions: [{ addonKey: "addon.members_10" }],
    removals: [],
  });
  invalidateEntitlements(org2.id);
  const lifted = await resolveEntitlements(ctx(org2));
  const m4 = await inviteMember(ctx(org2), "owner", {
    email: `pta8-demo-m4-${run}@example.com`,
    roleKey: "manager",
  });
  console.log(`  addon.members_10 → limit.full_users=${lifted.limits["limit.full_users"]}; 4th manager invite ok`);
  assert(
    "addon.members_10 lifts the wall (3 → 13) and the blocked manager invite now succeeds",
    lifted.limits["limit.full_users"] === 13 && Boolean(m4.inviteId),
  );

  // ═══ 12. PROVIDER-DISABLED CHECKOUT ═══
  step("STEP 12 — PROVIDER DISABLED (prod default without credentials)");
  // Method: IN-PROCESS env flip — getBillingProvider (src/platform/billing/adapter.ts) reads
  // process.env.BILLING_PROVIDER and isProd() reads process.env.APP_ENV PER CALL (no module-load
  // caching), so no subprocess is needed.
  const savedAppEnv = process.env.APP_ENV;
  const savedBilling = process.env.BILLING_PROVIDER;
  process.env.APP_ENV = "prod";
  delete process.env.BILLING_PROVIDER;
  let disabledEnabled: boolean | null = null;
  let disabledErr: unknown;
  try {
    disabledEnabled = getBillingProvider().enabled;
    try {
      await changeAddons(ctx(org2), "owner", {
        additions: [{ addonKey: "addon.storage_25gb" }],
        removals: [],
      });
    } catch (e) {
      disabledErr = e;
    }
  } finally {
    if (savedAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedAppEnv;
    if (savedBilling === undefined) delete process.env.BILLING_PROVIDER;
    else process.env.BILLING_PROVIDER = savedBilling;
  }
  console.log(
    `  method: in-process env flip (adapter reads env per call). enabled=${disabledEnabled}; ` +
      `changeAddons → ${(disabledErr as Error)?.name}: ${(disabledErr as Error)?.message}`,
  );
  assert(
    "APP_ENV=prod without BILLING_PROVIDER: provider disabled AND changeAddons throws BillingProviderDisabledError",
    disabledEnabled === false && disabledErr instanceof BillingProviderDisabledError,
  );
  const restored = getBillingProvider().enabled;
  assert("env restored: the fake provider resolves again for the rest of the run", restored === true);

  // ═══ 13. PROTECTED ORGS (verify half) ═══
  step("STEP 13 — PROTECTED ORGS byte-identical AFTER all steps and sweeps");
  const protectedAfter = await protectedSnapshot();
  console.log("PROTECTED ORGS — AFTER (verbatim org_plan_state rows):");
  console.log(protectedAfter);
  assert(
    "Alpha Marine + TESTING org_plan_state rows are byte-identical before/after (incl. every sweep)",
    protectedAfter === protectedBefore && protectedBefore.length > 0,
    `${protectedBefore.split("\n").length} rows compared as server-rendered JSON text`,
  );
  const protAddons = (await owner`select count(*)::int as c from public.org_addon
    where org_id in (${PROTECTED.alphaMarine}::uuid, ${PROTECTED.testing}::uuid)`) as unknown as Array<{
    c: number;
  }>;
  assert("protected orgs gained zero org_addon rows", Number(protAddons[0]!.c) === 0);
}

// ── STEP 14: cleanup (dry-run print → wipe → verify) ─────────────────────────
async function cleanup(): Promise<void> {
  if (orgs.length === 0) return;
  step("STEP 14 — CLEANUP (dry-run, then wipe)");
  console.log("  WOULD DELETE (dry-run):");
  for (const o of orgs) console.log(`    org  ${o.id}  ${o.name}\n    user ${o.user} (auth.users)`);
  console.log(`    + all org_id-scoped rows in every public table, user_profile rows,`);
  console.log(`    + null-org subscription_event rows with provider_event_id like 'fake_<orgId>_%'`);

  const ids = orgs.map((o) => o.id);
  const users = orgs.map((o) => o.user);
  // Null-org subscription_event rows are unreachable by org_id — reap by the org-scoped
  // fake event-id prefix (mirrors subscription-roundtrip.test.ts afterAll).
  for (const orgId of ids) {
    await owner`delete from public.subscription_event
      where org_id is null and provider_event_id like ${`fake_${orgId}_%`}`;
  }
  const tbls = (await owner`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tbls) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [users]);
    await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [users]);
    await tx.unsafe("set local session_replication_role = default");
  });
  console.log("  wipe complete.");
}

async function verifyResidue(): Promise<void> {
  const inventoryAfter = await orgInventory();
  assert(
    "org inventory after cleanup exactly matches the before-demo inventory",
    inventoryAfter === inventoryBefore,
    `${inventoryAfter.split("\n").length} org(s), unchanged`,
  );
  const residue = (await owner`
    select
      (select count(*) from public.org where name like 'PTA8-DEMO-%')::int as orgs,
      (select count(*) from auth.users where email like 'pta8-demo-%')::int as users,
      (select count(*) from public.user_profile where id = any(${orgs.map((o) => o.user)}::uuid[]))::int as profiles
  `) as unknown as Array<{ orgs: number; users: number; profiles: number }>;
  let subEvents = 0;
  for (const o of orgs) {
    const r = (await owner`select count(*)::int as c from public.subscription_event
      where provider_event_id like ${`fake_${o.id}_%`}`) as unknown as Array<{ c: number }>;
    subEvents += Number(r[0]!.c);
  }
  console.log(
    `  residue scan: orgs=${residue[0]!.orgs} auth.users=${residue[0]!.users} ` +
      `user_profiles=${residue[0]!.profiles} subscription_events=${subEvents}`,
  );
  assert(
    "zero PTA8-DEMO residue anywhere (org, auth.users, user_profile, subscription_event)",
    Number(residue[0]!.orgs) === 0 &&
      Number(residue[0]!.users) === 0 &&
      Number(residue[0]!.profiles) === 0 &&
      subEvents === 0,
  );
  const protectedFinal = await protectedSnapshot();
  assert(
    "protected orgs STILL byte-identical after cleanup (final check)",
    protectedFinal === protectedBefore,
  );
}

function summary() {
  console.log(`\n════ PTA8 DEMO SUMMARY ════`);
  for (const line of results) console.log(line);
  console.log(`\nPTA8 DEMO: ${passCount}/${n} PASS`);
}

main()
  .then(cleanup)
  .then(verifyResidue)
  .then(async () => {
    summary();
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(passCount === n && n > 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(`\nPTA8 DEMO FAILED: ${(e as Error).message}`);
    await cleanup().catch((c) => console.error("cleanup error:", (c as Error).message));
    // Even on failure, report what the cleanup left behind.
    await verifyResidue().catch((c) => console.error("residue verify error:", (c as Error).message));
    summary();
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
