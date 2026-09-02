/**
 * H27 production UI walk — one marked fixture, screenshots, removed in `finally`.
 *
 * Proof that the deployed Revenue Growth Studio renders for a real person on
 * the real application: creates one user and one organisation with a
 * customer, leads (one quarantined), opportunities, a deal with stakeholders,
 * products and a risk, a campaign, a target and a dry-run automation (through
 * the same services the screens call), signs in through the app's token-hash
 * route (no password typed anywhere), opens the hub, the pipeline, the leads
 * queue, the deal room (including the lazy canvas and the fail-closed
 * assistant), the Customer 360, the forecast, the success overview, the
 * reports, downloads the branded PDF, then repeats the hub, the pipeline and
 * the deal in Arabic and at 375 px. PNGs and the console error list go to
 * .h27-shots-prod/. The fixture self-destructs pass or fail; residue and
 * historical counts are verified.
 *
 *   npx tsx tooling/scripts/h27-prod-ui-walk.ts --confirm=<production phrase>
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { chromium } from "@playwright/test";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { addCustomerContact, createCustomer } from "@/modules/masters/service";
import {
  addProductLine,
  addRisk,
  addStakeholder,
  captureLead,
  convertLeadSafely,
  createAutomation,
  createCampaign,
  logActivity,
  recordConsent,
  saveDealCanvas,
  setTarget,
} from "@/modules/crm/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const OUT = path.join(process.cwd(), ".h27-shots-prod");
const MARKER = "smoke.h27_ui";
const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerEmail = `h27ui-${RUN}@example.invalid`;
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h27-ui-${RUN}`,
});
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
      (select count(*) from public.lead where org_id = ${orgId}) +
      (select count(*) from public.opportunity where org_id = ${orgId}) +
      (select count(*) from public.sales_activity where org_id = ${orgId}) +
      (select count(*) from public.crm_campaign where org_id = ${orgId}) +
      (select count(*) from public.crm_automation where org_id = ${orgId}) +
      (select count(*) from public.crm_deal_canvas where org_id = ${orgId}) +
      (select count(*) from public.crm_consent where org_id = ${orgId}) +
      (select count(*) from storage.objects where name like ${orgId + "/%"}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.sessions where user_id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

const COUNTS = () => owner`
  select (select count(*) from public.org) as orgs,
         (select count(*) from auth.users) as users,
         (select count(*) from public.customer) as customers,
         (select count(*) from public.lead) as leads,
         (select count(*) from public.opportunity) as opportunities,
         (select count(*) from public.job) as jobs`;

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
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
  mkdirSync(OUT, { recursive: true });
  console.log(`H27 production UI walk on ${PRODUCTION_PROJECT_REF} (run ${RUN}) → ${BASE}`);
  const before = (await COUNTS()) as unknown as Array<Record<string, string>>;
  console.log(`before: ${JSON.stringify(before[0])}`);
  const notes: string[] = [];
  const errors: string[] = [];

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const created = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: `Walk-${randomUUID()}`,
      email_confirm: true,
      user_metadata: { full_name: "H27 Walk Owner" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale)
      values (${ownerUserId}, 'H27 Walk Owner', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H27 Walk ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)
      on conflict do nothing`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);

    // Fixture through the services the screens call.
    const customer = await createCustomer(A(), "owner", {
      name: `Walk Marine ${RUN}`,
      country: "AE",
      email: `walk-marine-${RUN}@example.invalid`,
    });
    const contact = await addCustomerContact(A(), "owner", customer.id, {
      name: "Maha Saleh",
      roleTitle: "Buyer",
      email: `maha-${RUN}@example.invalid`,
      isPrimary: true,
    });
    await recordConsent(A(), "owner", {
      contactId: contact.id,
      channel: "email",
      status: "granted",
      source: "written",
      evidence: "Walk fixture",
    });
    const campaign = await createCampaign(A(), "owner", {
      name: `Walk show ${RUN}`,
      channel: "event",
      status: "active",
    });
    await captureLead(A(), "owner", { name: `Walk enquiry form ${RUN}`, sourceKind: "form" });
    const deals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cap = await captureLead(A(), "owner", {
        name: `Walk lead ${i} ${RUN}`,
        sourceKind: i === 0 ? "campaign" : "manual",
        campaignId: i === 0 ? campaign.id : null,
        estimatedValueMinor: (i + 1) * 2_500_000,
        currency: "AED",
      });
      const conv = await convertLeadSafely(A(), "owner", {
        leadId: cap.lead.id,
        customerId: customer.id,
        opportunityName: `Walk deal ${i} ${RUN}`,
        estimatedValueMinor: (i + 1) * 2_500_000,
        expectedCloseDate: plus(30 * (i + 1)),
      });
      deals.push(conv.opportunityId);
    }
    const deal = deals[0]!;
    await addStakeholder(A(), "owner", {
      opportunityId: deal,
      contactId: contact.id,
      roleKind: "decision_maker",
      influence: 5,
      sentiment: "supporter",
    });
    await addProductLine(A(), "owner", {
      opportunityId: deal,
      description: "24ft Catamaran hull",
      qty: 1,
      unit: "ea",
      unitPriceMinor: 38_000_000,
      vatRate: 5,
    });
    await addRisk(A(), "owner", {
      opportunityId: deal,
      kind: "blocker",
      title: "Berth availability",
      severity: "high",
    });
    await saveDealCanvas(A(), "owner", {
      opportunityId: deal,
      rowVersion: 0,
      doc: {
        nodes: [
          { id: "n1", kind: "stakeholder", label: "Maha (decision)", x: 60, y: 60 },
          { id: "n2", kind: "risk", label: "Berth availability", x: 320, y: 60 },
          { id: "n3", kind: "step", label: "Contract signature", x: 190, y: 200 },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n3" },
          { id: "e2", from: "n2", to: "n3", label: "blocks" },
        ],
      },
    });
    await logActivity(A(), "owner", {
      opportunityId: deal,
      kind: "meeting",
      title: "Sea trial",
      outcome: "positive",
    });
    await setTarget(A(), "owner", {
      scopeKind: "org",
      metric: "revenue",
      periodStart: `${plus(0).slice(0, 4)}-01-01`,
      periodEnd: `${plus(0).slice(0, 4)}-12-31`,
      amountMinor: 100_000_000,
      currency: "AED",
    });
    await createAutomation(A(), "owner", {
      name: `Walk ageing ${RUN}`,
      trigger: "opportunity_stage_aged",
      conditions: { all: [{ key: "stage_age_days", op: "gte", value: 30 }] },
      actions: [{ kind: "create_task", title: "Chase", dueInDays: 2 }],
      enabled: false,
      dryRun: true,
    });

    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail,
      options: { redirectTo: `${BASE}/` },
    });
    if (link.error || !link.data) throw new Error(`generateLink: ${link.error?.message}`);
    const token = link.data.properties.hashed_token;

    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.setDefaultTimeout(90_000);
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" && !/favicon/i.test(m.text()))
          errors.push(`console: ${m.text().slice(0, 200)}`);
      });
      const shot = async (name: string, url: string, wait = 2500) => {
        await page.goto(`${BASE}${url}`, { waitUntil: "load" });
        await page.waitForTimeout(wait);
        await page.screenshot({ path: path.join(OUT, `prod-${name}.png`), fullPage: true });
        const text = (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
        notes.push(`${name}: ${text.slice(0, 200)}`);
        return text;
      };
      const hub = `/o/${orgId}/revenue`;
      await page.goto(`${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=${hub}`, {
        waitUntil: "load",
      });
      await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
      notes.push(`signed in → ${page.url()}`);
      const hubText = await shot("hub", hub, 3500);
      if (!/Revenue Growth Studio/.test(hubText)) errors.push("hub: title missing");
      const pipeText = await shot("pipeline", `${hub}/pipeline`, 3000);
      if (!/3 deals|deals/.test(pipeText)) errors.push("pipeline: total missing");
      const leadsText = await shot("leads", `${hub}/leads`, 2500);
      if (!/Awaiting review|بانتظار المراجعة/.test(leadsText))
        errors.push("leads: quarantine badge missing");
      await shot("deal", `${hub}/deals/${deal}`, 2500);
      await shot("deal-products", `${hub}/deals/${deal}?tab=products`, 2000);
      await page.goto(`${BASE}${hub}/deals/${deal}?tab=canvas`, { waitUntil: "load" });
      await page
        .waitForSelector(".react-flow", { timeout: 60_000 })
        .catch(() => errors.push("canvas: react-flow did not mount"));
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(OUT, "prod-deal-canvas.png"), fullPage: true });
      const aiText = await shot("deal-assistant", `${hub}/deals/${deal}?tab=assistant`, 2000);
      if (!/assistant is off|المساعد متوقف/.test(aiText)) errors.push("assistant: not fail-closed");
      await shot("customer", `${hub}/customers/${customer.id}`, 2500);
      const fText = await shot("forecast", `${hub}/forecast`, 3000);
      if (!/not guaranteed revenue/.test(fText)) errors.push("forecast: disclaimer missing");
      await shot("success", `${hub}/success`, 2500);
      await shot("campaigns", `${hub}/campaigns`, 2500);
      await shot("targets", `${hub}/targets`, 2500);
      await shot("automations", `${hub}/automations`, 2500);
      await shot("reports", `${hub}/reports`, 3000);
      await shot("settings", `${hub}/settings`, 2500);
      const res = await ctx.request.get(`${BASE}/api/o/${orgId}/revenue/report?format=pdf`);
      const bytes = Buffer.from(await res.body());
      const latin = bytes.toString("latin1");
      const pages = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      notes.push(
        `pdf: status=${res.status()} type=${res.headers()["content-type"]} bytes=${bytes.length} magic=${latin.slice(0, 5)} pages=${pages}`,
      );
      writeFileSync(path.join(OUT, "prod-revenue-report.pdf"), bytes);
      if (res.status() !== 200 || latin.slice(0, 5) !== "%PDF-" || pages < 1)
        errors.push("pdf: not a real PDF");
      // Arabic
      await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
      await shot("ar-hub", hub, 3000);
      await shot("ar-pipeline", `${hub}/pipeline`, 2500);
      await shot("ar-deal", `${hub}/deals/${deal}`, 2500);
      notes.push(
        `ar dir=${await page.locator("html").getAttribute("dir")} lang=${await page.locator("html").getAttribute("lang")}`,
      );
      await ctx.addCookies([{ name: "locale", value: "en", url: BASE }]);
      // Mobile
      const mctx = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        storageState: await ctx.storageState(),
      });
      const m = await mctx.newPage();
      m.setDefaultTimeout(90_000);
      for (const [name, url] of [
        ["mobile-hub", hub],
        ["mobile-pipeline", `${hub}/pipeline`],
        ["mobile-leads", `${hub}/leads`],
        ["mobile-deal", `${hub}/deals/${deal}`],
        ["mobile-success", `${hub}/success`],
      ] as const) {
        await m.goto(`${BASE}${url}`, { waitUntil: "load" });
        await m.waitForTimeout(2500);
        await m.screenshot({ path: path.join(OUT, `prod-${name}.png`), fullPage: true });
        const w = await m.evaluate(() => document.documentElement.scrollWidth);
        if (w > 380) errors.push(`${name}: horizontal overflow ${w}px`);
      }
      await mctx.close();
    } finally {
      await browser.close();
    }
    notes.push(`errors: ${errors.length === 0 ? "none" : errors.slice(0, 8).join(" | ")}`);
    writeFileSync(path.join(OUT, "notes.txt"), notes.join("\n") + "\n");
    console.log(notes.join("\n"));
    if (errors.length > 0) process.exitCode = 1;
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
