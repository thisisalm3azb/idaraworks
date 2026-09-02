/**
 * H25 production UI walk — one marked fixture, screenshots, removed in `finally`.
 *
 * Proof that the deployed Studio renders for a real person on the real
 * application: creates one user and one organisation with a plan from a
 * built-in template (through the same services the screens call), signs in
 * through the app's token-hash route (no password typed anywhere), opens the
 * projections at desktop width, in Arabic, and at 375 px, and writes PNGs +
 * the console error list to .h25-shots-prod/. The fixture self-destructs
 * pass or fail; residue and historical counts are verified.
 *
 *   npx tsx tooling/scripts/h25-prod-ui-walk.ts --confirm=<production phrase>
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
import { createEmployee } from "@/modules/masters/service";
import { createPlanFromTemplate, addNode, updateNode } from "@/modules/studio/service";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const MARKER = "smoke.h25ui";
const RUN = randomUUID().slice(0, 8);
const OUT = path.join(process.cwd(), ".h25-shots-prod");
const owner = postgres(process.env.DIRECT_URL!, {
  max: 1,
  connect_timeout: 60,
  onnotice: () => {},
});
let ownerUserId = "";
let orgId = "";
const ownerEmail = `h25ui-${RUN}@example.invalid`;
const A = (): Ctx => ({
  orgId,
  userId: ownerUserId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h25-ui-${RUN}`,
});

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
      (select count(*) from public.studio_plan where org_id = ${orgId}) +
      (select count(*) from public.studio_node where org_id = ${orgId}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.identities where user_id = ${ownerUserId || randomUUID()}) +
      (select count(*) from auth.sessions where user_id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

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
  console.log(`H25 production UI walk on ${PRODUCTION_PROJECT_REF} (run ${RUN}) → ${BASE}`);
  mkdirSync(OUT, { recursive: true });
  const before = (await owner`
    select (select count(*) from public.org) as orgs, (select count(*) from public.studio_plan) as plans,
           (select count(*) from auth.users) as users`) as unknown as Array<Record<string, string>>;
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
      user_metadata: { full_name: "H25 Walk" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message}`);
    ownerUserId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${ownerUserId}, 'H25 Walk', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H25 walk ${RUN}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER}, ${JSON.stringify({ run: RUN })}::jsonb)`;
    await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
    const emp = await createEmployee(A(), "owner", { name: "Walk Person" });
    const plan = await createPlanFromTemplate(A(), "owner", {
      templateKey: "builtin.build",
      name: `Walk build ${RUN}`,
      startDate: "2026-10-05",
    });
    // Give the capacity world something to show.
    const nodes = (await owner`
      select id::text as id from public.studio_node where org_id = ${orgId} and plan_id = ${plan.id}
        and node_type = 'task' order by created_at limit 2`) as unknown as Array<{ id: string }>;
    for (const n of nodes)
      await updateNode(A(), "owner", { nodeId: n.id, assigneeEmployeeId: emp.id });
    await addNode(A(), "owner", {
      planId: plan.id,
      nodeType: "risk",
      title: "Unscored walk risk",
      x: 40,
      y: 700,
    });
    console.log(`fixture org ${orgId} plan ${plan.id}`);

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
      const planUrl = `${BASE}/o/${orgId}/studio/${plan.id}`;
      await page.goto(
        `${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=/o/${orgId}/studio/${plan.id}`,
        { waitUntil: "load" },
      );
      await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
      notes.push(`signed in → ${page.url()}`);
      for (const v of ["canvas", "gantt", "network", "workload", "risk", "world", "kpis"]) {
        await page.goto(`${planUrl}?view=${v}`, { waitUntil: "load" });
        await page.waitForTimeout(v === "world" ? 5000 : 2000);
        await page.screenshot({ path: path.join(OUT, `prod-${v}.png`) });
        notes.push(
          `view=${v}: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 160)}`,
        );
      }
      await page.goto(`${BASE}/o/${orgId}/studio`, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, "prod-portfolio.png") });
      await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
      await page.goto(`${planUrl}?view=canvas`, { waitUntil: "load" });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT, "prod-ar-canvas.png") });
      notes.push(
        `ar dir=${await page.locator("html").getAttribute("dir")} lang=${await page.locator("html").getAttribute("lang")}`,
      );
      await ctx.addCookies([{ name: "locale", value: "en", url: BASE }]);
      const mctx = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        storageState: await ctx.storageState(),
      });
      const m = await mctx.newPage();
      m.setDefaultTimeout(90_000);
      for (const v of ["canvas", "board"]) {
        await m.goto(`${planUrl}?view=${v}`, { waitUntil: "load" });
        await m.waitForTimeout(2000);
        await m.screenshot({ path: path.join(OUT, `prod-mobile-${v}.png`) });
      }
      await mctx.close();
    } finally {
      await browser.close();
    }
    notes.push(`errors: ${errors.length === 0 ? "none" : errors.slice(0, 5).join(" | ")}`);
    writeFileSync(path.join(OUT, "notes.txt"), notes.join("\n") + "\n");
    console.log(notes.join("\n"));
  } finally {
    await cleanup();
    const after = (await owner`
      select (select count(*) from public.org) as orgs, (select count(*) from public.studio_plan) as plans,
             (select count(*) from auth.users) as users`) as unknown as Array<
      Record<string, string>
    >;
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
