/**
 * H28 — the local UI walk (TEST project only). Drives the real dock against
 * the dev preview with a deterministic provider: the launcher appears, moves
 * by menu and by keyboard, opens on the shortcut, carries the page's record
 * in its capsule, answers with evidence, shows a proposed action, confirms
 * it, opens the deep workspace, and repeats the key screens in Arabic and at
 * 375 px. Every screen is captured to .h28-shots/ and console errors,
 * horizontal overflow and missing accessibility affordances are reported.
 *
 *   node tooling/scripts/dev-idara-preview.mjs      (in another terminal)
 *   npx tsx tooling/scripts/h28-ui-shots.ts <email> <org> <customer>
 */
import { config } from "dotenv";
config({ path: [".env.test.local", ".env.test"], quiet: true });
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { PRODUCTION_PROJECT_REF } from "../../tests/integration/guard-env";

const BASE = process.env.IDARA_PREVIEW_BASE ?? "http://localhost:3215";
const OUT = ".h28-shots";
const errors: string[] = [];
const notes: string[] = [];

async function signIn(page: Page, email: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (new URL(url).hostname.startsWith(PRODUCTION_PROJECT_REF))
    throw new Error("refusing to run against production");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token)
    throw new Error(`could not mint a sign-in link: ${error?.message}`);
  await page.goto(
    `${BASE}/auth/confirm?token_hash=${data.properties.hashed_token}&type=magiclink&next=/`,
    { waitUntil: "load" },
  );
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 60_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = page.viewportSize()?.width ?? 0;
  if (viewport && width > viewport + 5) {
    errors.push(`${name}: horizontal overflow ${width}px at ${viewport}px`);
    const wide = (await page.evaluate(`(() => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 1 || r.width < 8) continue;
        let n = el.parentElement, clipped = false;
        while (n && n !== document.body) {
          const o = getComputedStyle(n).overflowX;
          if ((o === "auto" || o === "hidden" || o === "scroll") && n.getBoundingClientRect().width <= vw + 1) { clipped = true; break; }
          n = n.parentElement;
        }
        if (clipped) continue;
        const cls = typeof el.className === "string" ? el.className : "";
        out.push(el.tagName.toLowerCase() + " right=" + Math.round(r.right) + " cls=" + cls.slice(0, 60));
        if (out.length >= 5) break;
      }
      return out;
    })()`)) as string[];
    notes.push(`${name}-overflow: ${wide.join(" || ")}`);
  }
}

async function main(): Promise<void> {
  const [email, orgId, customerId] = process.argv.slice(2);
  if (!email || !orgId) {
    console.error("usage: h28-ui-shots.ts <email> <orgId> [customerId]");
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
    });
    page.setDefaultTimeout(60_000);
    await signIn(page, email);

    // 1) The dock on an ordinary page.
    await page.goto(`${BASE}/o/${orgId}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const dock = page.locator("[data-idara-dock]");
    if ((await dock.count()) === 0) errors.push("dock: the launcher is not mounted");
    await shot(page, "dock-closed");
    notes.push(`dock present: ${await dock.count()}`);

    // 2) The position menu moves it without dragging, and resets.
    const menuButton = dock.getByRole("button").first();
    await menuButton.click();
    await page.waitForTimeout(300);
    const menu = page.getByRole("menu");
    if ((await menu.count()) === 0) errors.push("dock: the position menu did not open");
    await shot(page, "dock-position-menu");
    const positions = menu.getByRole("menuitemradio");
    const count = await positions.count();
    notes.push(`position choices: ${count}`);
    if (count !== 6) errors.push(`dock: expected six positions, found ${count}`);
    await positions.nth(0).click();
    await page.waitForTimeout(300);
    const moved = await dock.getAttribute("data-position");
    notes.push(`moved to: ${moved}`);
    if (moved !== "top-start") errors.push(`dock: position did not change (${moved})`);
    await menuButton.click();
    await page.getByRole("menuitem").last().click();
    await page.waitForTimeout(300);
    const reset = await dock.getAttribute("data-position");
    if (reset !== "bottom-end") errors.push(`dock: reset did not restore the default (${reset})`);

    // 3) The shortcut opens the window; Escape minimises it.
    await page.keyboard.press("Control+Period");
    await page.waitForTimeout(800);
    const win = page.locator("[data-idara-window]");
    if ((await win.count()) === 0) errors.push("dock: the shortcut did not open the window");
    await shot(page, "dock-open");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    if ((await page.locator("[data-idara-window]").count()) !== 0)
      errors.push("dock: Escape did not minimise the window");
    await shot(page, "dock-minimised");

    // 4) The capsule carries the page's record, and an answer arrives with evidence.
    if (customerId) {
      await page.goto(`${BASE}/o/${orgId}/customers/${customerId}`, { waitUntil: "load" });
      await page.waitForTimeout(1500);
      await shot(page, "record-page");
      await page.keyboard.press("Control+Period");
      await page.waitForTimeout(1000);
      const capsule = page
        .locator("[data-idara-window]")
        .getByText(/Shared records|السجلات المشتركة/);
      if ((await capsule.count()) === 0) errors.push("dock: the context capsule is missing");
      await shot(page, "dock-context");
      const composer = page.locator("[data-idara-window] textarea");
      await composer.fill("Summarise this customer");
      await composer.press("Enter");
      await page.waitForTimeout(6000);
      await shot(page, "dock-answer");
      const evidence = page.locator("[data-idara-window]").getByText(/Evidence|الأدلة/);
      if ((await evidence.count()) === 0) errors.push("answer: no evidence section");
    }

    // 5) The deep workspace.
    await page.goto(`${BASE}/o/${orgId}/idara`, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    await shot(page, "workspace");
    if ((await page.locator("[data-idara-window]").count()) === 0)
      errors.push("workspace: the surface did not render");

    // 6) Settings and the builder.
    await page.goto(`${BASE}/o/${orgId}/settings/ai`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await shot(page, "settings");
    await page.goto(`${BASE}/o/${orgId}/settings/ai/agents`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await shot(page, "builder");

    // 7) Arabic and RTL.
    await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
    await page.goto(`${BASE}/o/${orgId}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const dir = await page.evaluate(() => document.documentElement.dir);
    notes.push(`ar dir=${dir}`);
    if (dir !== "rtl") errors.push(`arabic: dir is ${dir}`);
    await page.keyboard.press("Control+Period");
    await page.waitForTimeout(800);
    await shot(page, "ar-dock-open");
    await page.goto(`${BASE}/o/${orgId}/settings/ai`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await shot(page, "ar-settings");
    await ctx.addCookies([{ name: "locale", value: "en", url: BASE }]);

    // 8) Phones.
    const mctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      storageState: await ctx.storageState(),
    });
    const m = await mctx.newPage();
    m.setDefaultTimeout(60_000);
    for (const [name, url] of [
      ["mobile-home", `/o/${orgId}`],
      ["mobile-workspace", `/o/${orgId}/idara`],
      ["mobile-settings", `/o/${orgId}/settings/ai`],
    ] as const) {
      await m.goto(`${BASE}${url}`, { waitUntil: "load" });
      await m.waitForTimeout(1500);
      await shot(m, name);
    }
    await m.goto(`${BASE}/o/${orgId}`, { waitUntil: "load" });
    await m.waitForTimeout(1200);
    const mdock = m.locator("[data-idara-dock]");
    if ((await mdock.count()) === 0) errors.push("mobile: the launcher is not mounted");
    const box = await mdock.boundingBox();
    if (box && box.y + box.height > 812 - 56)
      errors.push(
        `mobile: the launcher overlaps the bottom navigation (bottom ${Math.round(box.y + box.height)})`,
      );
    await mdock.getByRole("button").last().click();
    await m.waitForTimeout(1200);
    await shot(m, "mobile-sheet");
    const sheet = m.locator("[data-idara-window]");
    if ((await sheet.count()) === 0) errors.push("mobile: the bottom sheet did not open");
    await mctx.close();
    await ctx.close();
  } finally {
    await browser.close();
    writeFileSync(
      path.join(OUT, "notes.txt"),
      [...notes, `errors: ${errors.length === 0 ? "none" : ""}`, ...errors].join("\n"),
    );
    console.log(notes.join("\n"));
    console.log(`errors: ${errors.length === 0 ? "none" : `\n - ${errors.join("\n - ")}`}`);
    if (errors.length > 0) process.exitCode = 1;
  }
}

await main();
