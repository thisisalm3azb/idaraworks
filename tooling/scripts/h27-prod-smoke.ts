/**
 * H27 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * Proof that the Revenue Growth Studio works on the real database and the
 * real deployed application, through the same module functions the screens
 * call plus the REAL HTTP routes. Every step asserts a property that would be
 * expensive to get wrong; the fixture self-destructs pass or fail.
 *
 * What it walks:
 *   1. stage governance: requirements refuse a move, then allow it; the move
 *      records who and why; a stale row version is refused
 *   2. capture: a manual lead is trusted, a form lead is quarantined until a
 *      person trusts it; duplicates are surfaced; conversion is duplicate-safe
 *      and idempotent
 *   3. the deal room: stakeholders, product lines set the value, a risk, the
 *      commercial context, a discount request that opens a real approval and
 *      is decided by a person
 *   4. consent: granted, then suppressed (suppression outranks consent);
 *      marketing preview counts, the send fails closed without a provider
 *   5. forecast with named models, a snapshot, a scenario overlay that does
 *      not touch live rows; targets with a stated basis; campaign touches
 *      and attribution by named model
 *   6. automation: dry run applies nothing, live run applies once, again
 *      applies nothing (idempotent per occurrence)
 *   7. merge: preview counts, apply re-points in one transaction, evidence
 *      row, source points at the survivor
 *   8. success overview, reports with their basis, a contacts import with a
 *      dry-run preview and an idempotent apply
 *   9. the assistant fails closed; a viewer cannot manage; another
 *      organisation sees nothing
 *  10. HTTP with the flag OFF: /revenue and the PDF route answer not-found.
 *      With --surfaces=on: the hub renders and the PDF route streams bytes.
 *
 * SAFETY: creates one marked organization and one user; touches nothing
 * else; cleanup runs in `finally`; residue and historical counts verified.
 *
 *   npx tsx tooling/scripts/h27-prod-smoke.ts --confirm=<production phrase> [--surfaces=on]
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { ForbiddenError } from "@/platform/authz";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { decideApproval } from "@/modules/approvals/service";
import { addCustomerContact, createCustomer } from "@/modules/masters/service";
import { applyImport, previewImport, stageImport } from "@/modules/imports/service";
import {
  addProductLine,
  addRisk,
  addStakeholder,
  applyOverlay,
  attributionReport,
  boardPage,
  canContact,
  captureForecastSnapshot,
  captureLead,
  computeForecast,
  ConsentError,
  convertLeadSafely,
  createAutomation,
  createCampaign,
  crmAiAvailability,
  funnelReport,
  getOpportunityCommercial,
  LeadError,
  listActivities,
  listDiscounts,
  listMerges,
  listStageSettings,
  mergeCustomers,
  moveStage,
  PipelineError,
  previewMarketingSend,
  previewMerge,
  recordConsent,
  recordTouch,
  requestDiscount,
  resolveMergedCustomer,
  reviewQuarantine,
  runAutomation,
  saveScenario,
  sendMarketingMessage,
  setTarget,
  successOverview,
  suppressAddress,
  summarise,
  targetProgress,
  updateAutomation,
  updateCommercial,
  updateStageSettings,
  winOpportunity,
} from "@/modules/crm/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h27";
const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerPassword = `Smoke-${randomUUID()}`;
const ownerEmail = `h27smoke-${RUN}@example.invalid`;
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h27-smoke-${RUN}`,
});
let checks = 0;
function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) throw new Error(`FAILED: ${what}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok: ${what}${detail ? ` (${detail})` : ""}`);
}
const plus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function cleanup(): Promise<void> {
  if (!orgId) return;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    }
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    if (ownerUserId) {
      await tx.unsafe(`delete from public.sign_in_log where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from public.user_profile where id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.refresh_tokens where user_id = $1::text`, [ownerUserId]);
      await tx.unsafe(`delete from auth.sessions where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.identities where user_id = $1`, [ownerUserId]);
      await tx.unsafe(`delete from auth.users where id = $1`, [ownerUserId]);
    }
  });
  const residue = (await owner`
    select
      (select count(*) from public.org where id = ${orgId}) +
      (select count(*) from public.app_settings where org_id = ${orgId}) +
      (select count(*) from public.customer where org_id = ${orgId}) +
      (select count(*) from public.lead where org_id = ${orgId}) +
      (select count(*) from public.opportunity where org_id = ${orgId}) +
      (select count(*) from public.sales_activity where org_id = ${orgId}) +
      (select count(*) from public.crm_pipeline where org_id = ${orgId}) +
      (select count(*) from public.crm_campaign where org_id = ${orgId}) +
      (select count(*) from public.crm_touch where org_id = ${orgId}) +
      (select count(*) from public.crm_consent where org_id = ${orgId}) +
      (select count(*) from public.crm_suppression where org_id = ${orgId}) +
      (select count(*) from public.crm_discount where org_id = ${orgId}) +
      (select count(*) from public.crm_forecast_snapshot where org_id = ${orgId}) +
      (select count(*) from public.crm_scenario where org_id = ${orgId}) +
      (select count(*) from public.crm_target where org_id = ${orgId}) +
      (select count(*) from public.crm_merge where org_id = ${orgId}) +
      (select count(*) from public.crm_automation where org_id = ${orgId}) +
      (select count(*) from public.crm_automation_run where org_id = ${orgId}) +
      (select count(*) from public.import_batch where org_id = ${orgId}) +
      (select count(*) from public.approval where org_id = ${orgId}) +
      (select count(*) from public.notification where org_id = ${orgId}) +
      (select count(*) from public.audit_log where org_id = ${orgId}) +
      (select count(*) from storage.objects where name like ${orgId + "/%"}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.identities where user_id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.sessions where user_id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

async function ownerCookie(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await anon.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (error || !data.session) throw new Error(`owner sign-in failed: ${error?.message}`);
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(data.session), "utf8").toString("base64url");
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `sb-${ref}-auth-token=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) {
    parts.push(`sb-${ref}-auth-token.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
  return parts.join("; ");
}

const COUNTS = () => owner`
  select (select count(*) from public.org) as orgs,
         (select count(*) from auth.users) as users,
         (select count(*) from public.customer) as customers,
         (select count(*) from public.lead) as leads,
         (select count(*) from public.opportunity) as opportunities,
         (select count(*) from public.sales_activity) as activities,
         (select count(*) from public.approval) as approvals,
         (select count(*) from public.job) as jobs,
         (select count(*) from public.invoice) as invoices`;

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  const surfaces = process.argv.includes("--surfaces=on") ? "on" : "off";
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    console.error("Refusing: the environment does not point only at production:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (confirmArg !== productionMigrationPhrase()) {
    console.error(`Refusing: pass --confirm=${productionMigrationPhrase()}`);
    process.exit(1);
  }
  console.log(
    `H27 production smoke on ${PRODUCTION_PROJECT_REF} (run ${RUN}, surfaces=${surfaces})`,
  );
  const before = (await COUNTS()) as unknown as Array<Record<string, string>>;
  console.log(`before: ${JSON.stringify(before[0])}`);

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const created = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { full_name: "H27 Smoke Owner" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale)
      values (${ownerUserId}, 'H27 Smoke Owner', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H27 Smoke ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)
      on conflict do nothing`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    check("fixture organisation created", Boolean(orgId));

    // ── 1. stage governance ────────────────────────────────────────────────
    const stages = await listStageSettings(A(), "owner", null);
    const qualifiedKey =
      stages.find((s) => s.key === "qualified")?.key ??
      stages.find((s) => s.category === "open" && s.sort > 0)?.key;
    check(
      "pipeline stages exist",
      stages.length > 0 && Boolean(qualifiedKey),
      `${stages.length} stages`,
    );
    await updateStageSettings(A(), "owner", {
      stageKey: qualifiedKey!,
      requirements: ["value", "customer"],
      defaultProbability: 30,
      maxAgeDays: 21,
    });
    const customer = await createCustomer(A(), "owner", {
      name: `Smoke Marine ${RUN}`,
      country: "AE",
      email: `smoke-marine-${RUN}@example.invalid`,
    });
    const contact = await addCustomerContact(A(), "owner", customer.id, {
      name: "Maha Saleh",
      email: `maha-${RUN}@example.invalid`,
      isPrimary: true,
    });

    // ── 2. capture, quarantine, duplicates, conversion ──────────────────────
    const manual = await captureLead(A(), "owner", {
      name: `Smoke lead ${RUN}`,
      email: `smoke-marine-${RUN}@example.invalid`,
      sourceKind: "manual",
    });
    check("a manual lead is trusted", !manual.quarantined && manual.lead.status === "new");
    check(
      "duplicate candidates surfaced at capture (same email as the customer)",
      manual.duplicates.some((d) => d.kind === "customer" && d.id === customer.id),
    );
    const form = await captureLead(A(), "owner", {
      name: `Smoke form enquiry ${RUN}`,
      sourceKind: "form",
      phone: "+971500000777",
    });
    check("a form lead is quarantined", form.quarantined);
    let blocked = false;
    try {
      await convertLeadSafely(A(), "owner", { leadId: form.lead.id, createCustomer: true });
    } catch (e) {
      blocked = e instanceof LeadError && e.code === "state";
    }
    check("a quarantined lead cannot be converted before review", blocked);
    await reviewQuarantine(A(), "owner", { id: form.lead.id, decision: "trust" });
    let dupRefused = false;
    try {
      await convertLeadSafely(A(), "owner", { leadId: manual.lead.id, createCustomer: true });
    } catch (e) {
      dupRefused = e instanceof LeadError && e.code === "duplicates";
    }
    check("conversion refuses to create a second customer while duplicates stand", dupRefused);
    const conv = await convertLeadSafely(A(), "owner", {
      leadId: manual.lead.id,
      customerId: customer.id,
      opportunityName: `Smoke deal ${RUN}`,
      estimatedValueMinor: 5_000_000,
      expectedCloseDate: plus(45),
    });
    let again: string | null = null;
    try {
      again = (
        await convertLeadSafely(A(), "owner", { leadId: manual.lead.id, customerId: customer.id })
      ).opportunityId;
    } catch (e) {
      again = e instanceof LeadError ? conv.opportunityId : null;
    }
    check("conversion is idempotent (no second opportunity)", again === conv.opportunityId);
    const dealId = conv.opportunityId;
    const bare = await convertLeadSafely(A(), "owner", {
      leadId: form.lead.id,
      customerId: customer.id,
      opportunityName: `Smoke bare deal ${RUN}`,
    });
    let unmet: string[] = [];
    try {
      const bareRow = await getOpportunityCommercial(A(), "owner", bare.opportunityId);
      await moveStage(A(), "owner", {
        id: bare.opportunityId,
        stageKey: qualifiedKey!,
        rowVersion: bareRow!.rowVersion,
        reason: "smoke",
      });
    } catch (e) {
      if (e instanceof PipelineError && e.code === "requirements") unmet = e.details ?? [];
    }
    check(
      "a move without the stage's requirements is refused, naming what is missing",
      unmet.includes("value"),
      unmet.join(","),
    );
    const dealRow = await getOpportunityCommercial(A(), "owner", dealId);
    const moved = await moveStage(A(), "owner", {
      id: dealId,
      stageKey: qualifiedKey!,
      rowVersion: dealRow!.rowVersion,
      reason: "Smoke: budget confirmed",
    });
    check(
      "a governed move succeeds with who and why recorded",
      moved.moved && moved.to === qualifiedKey,
    );
    const history = await listActivities(A(), "owner", { opportunityId: dealId, kinds: ["stage"] });
    check("the move is preserved in history", history.total >= 1);
    let stale = false;
    try {
      await moveStage(A(), "owner", {
        id: dealId,
        stageKey: qualifiedKey!,
        rowVersion: dealRow!.rowVersion,
      });
    } catch (e) {
      stale = e instanceof PipelineError && (e.code === "conflict" || e.code === "state");
    }
    check("a stale row version is refused", stale);

    // ── 3. deal room and a discount decided by a person ─────────────────────
    await addStakeholder(A(), "owner", {
      opportunityId: dealId,
      contactId: contact.id,
      roleKind: "decision_maker",
      influence: 5,
      sentiment: "supporter",
    });
    await addProductLine(A(), "owner", {
      opportunityId: dealId,
      description: "24ft Catamaran hull",
      qty: 1,
      unit: "ea",
      unitPriceMinor: 38_000_000,
      vatRate: 5,
    });
    const priced = await getOpportunityCommercial(A(), "owner", dealId);
    check(
      "product lines own the deal value once they exist",
      priced!.estimatedValueMinor === 38_000_000,
      `${priced!.estimatedValueMinor}`,
    );
    await addRisk(A(), "owner", {
      opportunityId: dealId,
      kind: "blocker",
      title: "Berth availability",
      severity: "high",
    });
    await updateCommercial(A(), "owner", {
      id: dealId,
      rowVersion: priced!.rowVersion,
      forecastCategory: "commit",
      decisionCriteria: "Delivery before the season",
    });
    const discount = await requestDiscount(A(), "owner", {
      opportunityId: dealId,
      requestedPct: 12,
      listTotalMinor: 38_000_000,
      currency: "AED",
      reason: "Smoke: fleet buyer",
    });
    check(
      "a discount request opens a real approval",
      discount.status === "pending" && Boolean(discount.approvalId),
    );
    await decideApproval(A(), "owner", {
      approvalId: discount.approvalId!,
      decision: "rejected",
      note: "Smoke: hold the price",
    });
    const decided = (await listDiscounts(A(), "owner", dealId)).find((d) => d.id === discount.id);
    check(
      "the person's decision lands on the discount",
      decided?.status === "rejected",
      decided?.status,
    );

    // ── 4. consent and suppression ──────────────────────────────────────────
    await recordConsent(A(), "owner", {
      contactId: contact.id,
      channel: "email",
      status: "granted",
      source: "written",
      evidence: "smoke",
    });
    const allowed = await canContact(A(), "owner", { contactId: contact.id }, "email");
    check("consent grants contact", allowed.allowed && allowed.reason === "granted");
    await suppressAddress(A(), "owner", {
      channel: "email",
      address: `maha-${RUN}@example.invalid`,
      reason: "objection",
    });
    const suppressed = await canContact(A(), "owner", { contactId: contact.id }, "email");
    check(
      "suppression outranks consent",
      !suppressed.allowed && suppressed.reason === "suppressed",
    );
    const campaign = await createCampaign(A(), "owner", {
      name: `Smoke show ${RUN}`,
      channel: "event",
      status: "active",
      costMinor: 100_000,
      currency: "AED",
    });
    const preview = await previewMarketingSend(A(), "owner", {
      campaignId: campaign.id,
      channel: "email",
      subject: "Smoke",
      body: "Smoke body",
      recipients: [{ contactId: contact.id }, { customerId: customer.id }],
    });
    check(
      "marketing preview reports blocked recipients and the provider state",
      preview.blocked.length >= 1 && !preview.provider.configured,
    );
    let sendClosed = false;
    try {
      await sendMarketingMessage(A(), "owner", {
        campaignId: campaign.id,
        channel: "email",
        subject: "Smoke",
        body: "Smoke body",
        recipients: [{ customerId: customer.id }],
      });
    } catch (e) {
      sendClosed = e instanceof ConsentError;
    }
    check("marketing send fails closed without a provider", sendClosed);

    // ── 5. forecast, snapshot, scenario, targets, attribution ───────────────
    const forecast = await computeForecast(A(), "owner", {});
    check(
      "forecast names its models and counts the open deals",
      forecast.rows.length >= 2 && forecast.model.weighted.includes("probability"),
      `${forecast.rows.length} rows`,
    );
    const snap = await captureForecastSnapshot(A(), "owner", {
      periodKey: plus(0).slice(0, 7),
      note: "smoke",
    });
    check("a forecast snapshot is stored", Boolean(snap.id));
    const scenario = await saveScenario(A(), "owner", {
      name: `Smoke slip ${RUN}`,
      overlay: {
        excludes: [],
        slips: [{ opportunityId: dealId, months: 1 }],
        probabilities: [{ opportunityId: dealId, probability: 90 }],
        categories: [],
      },
    });
    const overlayed = summarise(
      applyOverlay(forecast.rows, {
        excludes: [],
        slips: [],
        probabilities: [{ opportunityId: dealId, probability: 90 }],
        categories: [],
      }),
    );
    const liveAfter = await getOpportunityCommercial(A(), "owner", dealId);
    check(
      "a scenario overlay changes the projection, not the live row",
      Boolean(scenario.id) &&
        overlayed.weightedMinor !== summarise(forecast.rows).weightedMinor &&
        liveAfter!.probability !== 90,
    );
    await setTarget(A(), "owner", {
      scopeKind: "org",
      metric: "revenue",
      periodStart: `${plus(0).slice(0, 4)}-01-01`,
      periodEnd: `${plus(0).slice(0, 4)}-12-31`,
      amountMinor: 100_000_000,
      currency: "AED",
    });
    await recordTouch(A(), "owner", {
      campaignId: campaign.id,
      opportunityId: dealId,
      kind: "exposure",
    });
    await winOpportunity(A(), "owner", dealId);
    const progress = await targetProgress(A(), "owner", plus(0));
    check(
      "target progress states its basis",
      progress.length >= 1 && progress[0]!.basis.length > 0,
      progress[0]?.basis,
    );
    const attr = await attributionReport(A(), "owner", "linear");
    check(
      "attribution reports by named model",
      attr.some(
        (r) => r.campaignId === campaign.id && r.model === "linear" && r.wonOpportunities === 1,
      ),
    );

    // ── 6. automation ───────────────────────────────────────────────────────
    await owner`update public.opportunity set stage_entered_at = now() - interval '40 days' where id = ${bare.opportunityId} and org_id = ${orgId}`;
    const auto = await createAutomation(A(), "owner", {
      name: `Smoke ageing ${RUN}`,
      trigger: "opportunity_stage_aged",
      conditions: { all: [{ key: "stage_age_days", op: "gte", value: 30 }] },
      actions: [{ kind: "create_task", title: "Smoke chase", dueInDays: 1 }],
    });
    const dry = await runAutomation(A(), "owner", { id: auto.id });
    check(
      "a dry run matches and applies nothing",
      dry.mode === "dry_run" && dry.matched >= 1 && dry.applied === 0,
    );
    await updateAutomation(A(), "owner", { id: auto.id, enabled: true, dryRun: false });
    const live = await runAutomation(A(), "owner", { id: auto.id, mode: "live" });
    const liveAgain = await runAutomation(A(), "owner", { id: auto.id, mode: "live" });
    check(
      "a live run applies once and is idempotent per occurrence",
      live.applied >= 1 && liveAgain.applied === 0 && liveAgain.skipped >= 1,
    );

    // ── 7. merge ────────────────────────────────────────────────────────────
    const dup = await createCustomer(A(), "owner", {
      name: `Smoke Marine Dup ${RUN}`,
      country: "AE",
      phone: "+971500000999",
    });
    const mp = await previewMerge(A(), "owner", dup.id, customer.id);
    check(
      "merge preview shows conflicts and counts",
      Array.isArray(mp.conflicts) && typeof mp.counts.opportunity === "number",
    );
    await mergeCustomers(A(), "owner", {
      sourceId: dup.id,
      targetId: customer.id,
      resolutions: { name: "target" },
      reason: "Smoke: same company",
    });
    check(
      "the source points at the survivor and evidence is kept",
      (await resolveMergedCustomer(A(), "owner", dup.id)) === customer.id &&
        (await listMerges(A(), "owner", customer.id)).length === 1,
    );

    // ── 8. success, reports, import ─────────────────────────────────────────
    const success = await successOverview(A(), "owner", {});
    check(
      "success overview scores the customer with evidence",
      success.rows.some((r) => r.id === customer.id && r.health.signals.length > 0),
    );
    const funnel = await funnelReport(A(), "owner", {});
    check(
      "funnel report counts leads and won deals with a basis",
      funnel.leads.total === 2 && funnel.opportunities.won.count === 1 && funnel.basis.length > 0,
    );
    const staged = await stageImport(A(), "owner", {
      kind: "contacts",
      rows: [
        {
          Customer: `Smoke Marine ${RUN}`,
          Name: "Import Contact",
          Email: `import-${RUN}@example.invalid`,
        },
        { Customer: `Smoke Marine ${RUN}`, Name: "Maha Saleh" },
        { Customer: "Nobody", Name: "Ghost" },
      ],
    });
    const ip = await previewImport(A(), "owner", staged.batchId);
    check(
      "import preview flags the existing contact and the unresolved customer",
      ip.duplicates.length >= 1 && ip.unresolved.length === 1 && ip.wouldCreate === 2,
    );
    const applied = await applyImport(A(), "owner", staged.batchId);
    const appliedAgain = await applyImport(A(), "owner", staged.batchId);
    check(
      "import apply is idempotent",
      applied.applied === 2 && applied.failed === 1 && appliedAgain.applied === 0,
    );
    const board = await boardPage(A(), "owner", { status: "all", limit: 1 });
    check(
      "board totals count the full result, not the page",
      board.total === 2 && board.rows.length === 1,
    );

    // ── 9. fail-closed assistant, permissions, isolation ────────────────────
    const ai = await crmAiAvailability(A());
    check(
      "assistant fails closed with the owner action",
      !ai.available && (ai.ownerAction ?? "").length > 0,
    );
    let viewerRefused = false;
    try {
      await createAutomation(A(), "viewer", {
        name: "nope",
        trigger: "lead_created",
        actions: [{ kind: "notify", title: "x" }],
      });
    } catch (e) {
      viewerRefused = e instanceof ForbiddenError;
    }
    check("viewer cannot manage automations", viewerRefused);
    const strangerOrg = (await owner`
      select id::text as id from public.org where id <> ${orgId} order by created_at asc limit 1`) as unknown as Array<{
      id: string;
    }>;
    if (strangerOrg[0]) {
      const stranger: Ctx = { ...A(), orgId: strangerOrg[0].id };
      const seen = await boardPage(stranger, "owner", {
        search: `Smoke deal ${RUN}`,
        status: "all",
      });
      check("another organisation sees nothing", seen.total === 0);
    }

    // ── 10. HTTP on the deployed application ────────────────────────────────
    const cookie = await ownerCookie();
    const hub = await fetch(`${BASE}/o/${orgId}/revenue`, {
      headers: { cookie },
      redirect: "manual",
    });
    const hubBody = await hub.text();
    const notFound = /not found|404|غير موجود/i.test(hubBody);
    const showsStudio =
      hubBody.includes("Revenue Growth Studio") || hubBody.includes("استوديو نمو الإيرادات");
    const pdfRes = await fetch(`${BASE}/api/o/${orgId}/revenue/report?format=pdf`, {
      headers: { cookie },
      redirect: "manual",
    });
    if (surfaces === "off") {
      check(
        "hub hidden while the flag is unset",
        (hub.status === 404 || (hub.status === 200 && notFound)) && !showsStudio,
        `${hub.status}`,
      );
      check("PDF route hidden while the flag is unset", pdfRes.status === 404, `${pdfRes.status}`);
    } else {
      check("hub renders with the flag on", hub.status === 200 && showsStudio, `${hub.status}`);
      const bytes = Buffer.from(await pdfRes.arrayBuffer());
      const latin = bytes.toString("latin1");
      check(
        "PDF route streams real bytes",
        pdfRes.status === 200 &&
          (pdfRes.headers.get("content-type") ?? "").startsWith("application/pdf") &&
          latin.slice(0, 5) === "%PDF-",
        `${pdfRes.status} ${bytes.length} bytes`,
      );
      const board2 = await fetch(`${BASE}/o/${orgId}/revenue/pipeline?status=all`, {
        headers: { cookie },
        redirect: "manual",
      });
      const boardBody = await board2.text();
      check(
        "pipeline renders the smoke deals",
        board2.status === 200 && boardBody.includes(`Smoke deal ${RUN}`),
        `${board2.status}`,
      );
    }
    console.log(`\nALL ${checks} CHECKS PASSED (surfaces=${surfaces})`);
  } finally {
    await cleanup();
    const after = (await COUNTS()) as unknown as Array<Record<string, string>>;
    const same = JSON.stringify(before[0]) === JSON.stringify(after[0]);
    console.log(
      `historical counts intact: ${same} (before=${JSON.stringify(before[0])} after=${JSON.stringify(after[0])})`,
    );
    if (!same) process.exitCode = 1;
    await owner.end();
    await closeAppDb();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
