/**
 * Headless walk of the Studio UI on the dev preview (TEST project): signs in
 * through the app's own token-hash route (no password typed anywhere), opens
 * every projection, the aside tabs, the palette, the mobile viewport and the
 * Arabic locale, and writes screenshots + the page's text to .h25-shots/ so a
 * person (or the model) can look at them.
 *
 *   npx tsx tooling/scripts/h25-ui-shots.ts <email> <orgId> <planId> [baseUrl]
 */
import "./load-env-integration";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}

const [email, orgId, planId, baseArg] = process.argv.slice(2);
const BASE = (baseArg ?? "http://localhost:3212").replace(/\/$/, "");
const OUT = path.join(process.cwd(), ".h25-shots");
const VIEWS = [
  "canvas",
  "board",
  "gantt",
  "network",
  "roadmap",
  "calendar",
  "workload",
  "risk",
  "world",
  "strategy",
  "kpis",
  "table",
];

async function magicToken(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: email!,
    options: { redirectTo: `${BASE}/` },
  });
  if (error || !data) throw new Error(`generateLink: ${error?.message}`);
  return data.properties.hashed_token;
}

async function main(): Promise<void> {
  if (!email || !orgId || !planId) {
    console.error("usage: h25-ui-shots.ts <email> <orgId> <planId> [baseUrl]");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const notes: string[] = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
    });
    const planUrl = `${BASE}/o/${orgId}/studio/${planId}`;
    const token = await magicToken();
    await page.goto(
      `${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=/o/${orgId}/studio/${planId}`,
      { waitUntil: "load" },
    );
    await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
    notes.push(`signed in → ${page.url()}`);

    for (const v of VIEWS) {
      await page.goto(`${planUrl}?view=${v}`, { waitUntil: "load" });
      await page.waitForTimeout(v === "world" ? 4000 : 1500);
      await page.screenshot({ path: path.join(OUT, `desktop-${v}.png`), fullPage: false });
      const text = (await page.locator("main, body").first().innerText()).slice(0, 600);
      notes.push(`view=${v}: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    }

    // Aside tabs: scenarios and review; then the palette.
    await page.goto(`${planUrl}?view=canvas`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    for (const tab of ["Scenarios", "Review"]) {
      const btn = page.getByRole("button", { name: new RegExp(`^${tab}`) }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(OUT, `desktop-aside-${tab.toLowerCase()}.png`) });
        notes.push(
          `aside ${tab}: ${(await page.locator("aside").first().innerText()).replace(/\s+/g, " ").slice(0, 300)}`,
        );
      } else notes.push(`aside ${tab}: button not found`);
    }
    await page.keyboard.press("Control+K");
    await page.waitForTimeout(400);
    await page.keyboard.type("Rig");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, "desktop-palette.png") });
    notes.push(
      `palette: ${(
        await page
          .locator('[role="dialog"]')
          .first()
          .innerText()
          .catch(() => "no dialog")
      )
        .replace(/\s+/g, " ")
        .slice(0, 200)}`,
    );
    await page.keyboard.press("Escape");

    // Registers + portfolio pages.
    await page.goto(`${BASE}/o/${orgId}/studio/registers?kind=risk`, { waitUntil: "load" });
    await page.waitForSelector("table, form", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, "desktop-registers.png") });
    notes.push(
      `registers: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
    );
    await page.goto(`${BASE}/o/${orgId}/studio`, { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT, "desktop-portfolio.png") });
    notes.push(
      `portfolio: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 240)}`,
    );

    // Arabic: set the person's locale on their profile (what the header switch does), look, restore.
    const postgres = (await import("postgres")).default;
    const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
    const setLocale = (loc: string) =>
      owner`update public.user_profile set locale = ${loc}
             where id = (select user_id from public.membership where org_id = ${orgId!} limit 1)`;
    try {
      await setLocale("ar");
      await page.goto(`${planUrl}?view=canvas`, { waitUntil: "load" });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT, "desktop-ar-canvas.png") });
      await page.goto(`${planUrl}?view=board`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, "desktop-ar-board.png") });
      await page.goto(`${planUrl}?view=kpis`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, "desktop-ar-kpis.png") });
      notes.push(
        `ar dir=${await page.locator("html").getAttribute("dir")} lang=${await page.locator("html").getAttribute("lang")}`,
      );
    } finally {
      await setLocale("en");
      await owner.end();
    }

    // Mobile.
    const mctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      storageState: await ctx.storageState(),
    });
    const m = await mctx.newPage();
    m.setDefaultTimeout(90_000);
    for (const v of ["canvas", "board", "workload", "kpis"]) {
      await m.goto(`${planUrl}?view=${v}`, { waitUntil: "load" });
      await m.waitForTimeout(1500);
      await m.screenshot({ path: path.join(OUT, `mobile-${v}.png`), fullPage: false });
    }
    await mctx.close();
    notes.push(`errors: ${errors.length === 0 ? "none" : errors.slice(0, 5).join(" | ")}`);
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(OUT, "notes.txt"), notes.join("\n") + "\n");
  console.log(notes.join("\n"));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
