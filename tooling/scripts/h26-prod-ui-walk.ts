/**
 * H26 production UI walk — one marked fixture, screenshots, removed in `finally`.
 *
 * Proof that the deployed Document Studio renders for a real person on the
 * real application: creates one user and one organisation with an issued
 * agreement, an obligation and an issued form (through the same services the
 * screens call), signs in through the app's token-hash route (no password
 * typed anywhere), opens the hub, the builder, the preview, the obligations
 * board, the forms inbox, the public form page, downloads the real PDF, then
 * repeats the hub and a document in Arabic and at 375 px. PNGs and the console
 * error list go to .h26-shots-prod/. The fixture self-destructs pass or fail;
 * residue and historical counts are verified.
 *
 *   npx tsx tooling/scripts/h26-prod-ui-walk.ts --confirm=<production phrase>
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
import {
  createDocument,
  createFormLink,
  createObligation,
  issueDocument,
  saveRevision,
} from "@/modules/docstudio/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const OUT = path.join(process.cwd(), ".h26-shots-prod");
const MARKER = "smoke.h26_ui";
const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerEmail = `h26ui-${RUN}@example.invalid`;
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h26-ui-${RUN}`,
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
      (select count(*) from public.doc_document where org_id = ${orgId}) +
      (select count(*) from public.doc_snapshot where org_id = ${orgId}) +
      (select count(*) from public.doc_obligation where org_id = ${orgId}) +
      (select count(*) from public.doc_form_link where org_id = ${orgId}) +
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
         (select count(*) from public.doc_document) as documents,
         (select count(*) from public.doc_obligation) as obligations,
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
  console.log(`H26 production UI walk on ${PRODUCTION_PROJECT_REF} (run ${RUN}) → ${BASE}`);
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
      user_metadata: { full_name: "H26 Walk" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${ownerUserId}, 'H26 Walk', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H26 walk ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)
      on conflict (org_id, key) do update set value = excluded.value`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);

    const draft = await createDocument(A(), "owner", {
      title: `Walk NDA ${RUN}`,
      category: "contract",
      language: "bilingual",
      builtinKey: "builtin.nda",
    });
    const sa = await createDocument(A(), "owner", {
      title: `Walk refit ${RUN}`,
      category: "agreement",
      language: "bilingual",
      builtinKey: "builtin.service_agreement",
      expiresAt: plus(300),
    });
    await saveRevision(A(), "owner", {
      documentId: sa.id,
      revisionId: sa.revisionId,
      variables: { payment_days: 30 },
    });
    await issueDocument(A(), "owner", { documentId: sa.id });
    await createObligation(A(), "owner", {
      documentId: sa.id,
      kind: "payment",
      title: "Deposit invoice",
      dueOn: plus(-3),
      amountCents: 250000,
      currency: "AED",
    });
    const form = await createDocument(A(), "owner", {
      title: `Walk intake ${RUN}`,
      category: "form",
      language: "bilingual",
      builtinKey: "builtin.intake_form",
    });
    await issueDocument(A(), "owner", { documentId: form.id });
    const flink = await createFormLink(A(), "owner", {
      documentId: form.id,
      expiresInDays: 1,
      maxUses: 2,
    });
    const formToken = flink.url.split("/f/")[1]!;
    console.log(`fixture org ${orgId} draft ${draft.id} issued ${sa.id} form ${form.id}`);

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
        if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
      });
      const hub = `/o/${orgId}/documents`;
      await page.goto(`${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=${hub}`, {
        waitUntil: "load",
      });
      await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
      notes.push(`signed in → ${page.url()}`);
      const shot = async (name: string, url: string, wait = 2500) => {
        await page.goto(`${BASE}${url}`, { waitUntil: "load" });
        await page.waitForTimeout(wait);
        await page.screenshot({ path: path.join(OUT, `prod-${name}.png`), fullPage: true });
        notes.push(
          `${name}: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 160)}`,
        );
      };
      await shot("hub", hub);
      await shot("builder", `/o/${orgId}/documents/${draft.id}?tab=edit`, 4000);
      await shot("issued-preview", `/o/${orgId}/documents/${sa.id}?tab=preview`, 5000);
      await shot("obligations", `/o/${orgId}/documents/obligations`);
      await shot("forms-inbox", `/o/${orgId}/documents/forms`);
      await shot("templates", `/o/${orgId}/documents/templates`);
      await shot("workflows", `/o/${orgId}/documents/workflows`);
      // The real PDF bytes through the deployed route (same session).
      const res = await page.request.get(
        `${BASE}/api/o/${orgId}/documents/studio/${sa.id}?format=pdf`,
      );
      const bytes = await res.body();
      const latin = bytes.toString("latin1");
      const pages = (latin.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      notes.push(
        `pdf: status=${res.status()} type=${res.headers()["content-type"]} bytes=${bytes.length} magic=${latin.slice(0, 5)} pages=${pages} naskh=${latin.includes("NotoNaskhArabic")} sans=${latin.includes("NotoSans")} hash=${res.headers()["x-document-hash"]?.slice(0, 12)}`,
      );
      writeFileSync(path.join(OUT, "prod-issued.pdf"), bytes);
      if (res.status() !== 200 || latin.slice(0, 5) !== "%PDF-" || pages < 2)
        errors.push("pdf: not a real multi-page PDF");
      // Public form page: no session.
      const pub = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const fp = await pub.newPage();
      fp.on("pageerror", (e) => errors.push(`form pageerror: ${e.message}`));
      await fp.goto(`${BASE}/f/${formToken}`, { waitUntil: "load" });
      await fp.waitForTimeout(3000);
      await fp.screenshot({ path: path.join(OUT, "prod-form-page.png"), fullPage: true });
      notes.push(
        `form-page: ${(await fp.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120)}`,
      );
      await fp.goto(`${BASE}/f/${formToken}?lang=ar`, { waitUntil: "load" });
      await fp.waitForTimeout(2500);
      await fp.screenshot({ path: path.join(OUT, "prod-form-page-ar.png"), fullPage: true });
      await pub.close();
      // Arabic
      await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
      await shot("ar-hub", hub);
      await shot("ar-issued-preview", `/o/${orgId}/documents/${sa.id}?tab=preview`, 5000);
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
        ["mobile-builder", `/o/${orgId}/documents/${draft.id}?tab=edit`],
        ["mobile-obligations", `/o/${orgId}/documents/obligations`],
      ] as const) {
        await m.goto(`${BASE}${url}`, { waitUntil: "load" });
        await m.waitForTimeout(2500);
        await m.screenshot({ path: path.join(OUT, `prod-${name}.png`), fullPage: true });
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
