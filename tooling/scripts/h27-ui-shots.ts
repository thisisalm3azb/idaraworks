/**
 * H27 headless UI walk against the dev preview (TEST project). Signs in
 * through the app's own token-hash route (no password typed), opens every
 * Revenue Studio screen at desktop width, in Arabic, and at 375 px, drives
 * the real interactions (a governed stage move through the card's select, a
 * lead capture, a quarantine review, a dry-run automation, a merge preview,
 * the lazy canvas and the assistant tab), proves the board and lead list
 * page past 1,000 rows with database-side totals, downloads the branded PDF
 * and checks its bytes, and writes PNGs + page text to .h27-shots/.
 *
 *   npx tsx tooling/scripts/h27-ui-shots.ts <owner email> <orgId> <dealId> <customerId>
 *
 * BASE defaults to http://localhost:3214 (dev-revenue-preview.mjs).
 */
import "./load-env-integration";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const email = process.argv[2] ?? "";
const orgId = process.argv[3] ?? "";
const dealId = process.argv[4] ?? "";
const customerId = process.argv[5] ?? "";
if (!email || !orgId || !dealId || !customerId) {
  console.error("usage: h27-ui-shots.ts <email> <orgId> <dealId> <customerId>");
  process.exit(1);
}
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}
const BASE = (process.env.PDF_VERIFY_BASE ?? "http://localhost:3214").replace(/\/$/, "");
const OUT = path.join(process.cwd(), ".h27-shots");
const R = `${BASE}/o/${orgId}/revenue`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${BASE}/` },
  });
  if (link.error || !link.data) throw new Error(`generateLink: ${link.error?.message}`);
  const token = link.data.properties.hashed_token;
  const notes: string[] = [];
  const errors: string[] = [];
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(90_000);
    const wire = (p: Page, tag = "") => {
      p.on("pageerror", (e) => errors.push(`${tag}pageerror: ${e.message}`));
      p.on("console", (m) => {
        if (m.type() === "error" && !/favicon|hydrat/i.test(m.text()))
          errors.push(`${tag}console: ${m.text().slice(0, 200)}`);
      });
    };
    wire(page);
    const text = async (p: Page) =>
      (await p.locator("main, body").first().innerText()).replace(/\s+/g, " ");
    const shot = async (name: string, wait = 1500, p: Page = page) => {
      await p.waitForTimeout(wait);
      await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      notes.push(`${name}: ${(await text(p)).slice(0, 220)}`);
    };
    const expectText = (name: string, body: string, re: RegExp) => {
      if (!re.test(body)) errors.push(`${name}: expected ${re}`);
    };

    await page.goto(
      `${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=/o/${orgId}/revenue`,
      { waitUntil: "load" },
    );
    await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
    notes.push(`signed in → ${page.url()}`);
    await shot("hub", 3000);
    expectText("hub", await text(page), /Revenue Growth Studio/);

    // Command centre: Ctrl+K, search a deal, Enter opens it.
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(400);
    await page.keyboard.type("Hull refit 0005");
    await page
      .waitForSelector("[role=option]", { timeout: 60_000 })
      .catch(() => errors.push("palette: no results arrived"));
    await shot("palette", 300);
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => /\/revenue\/deals\/[0-9a-f-]{36}/.test(u.pathname), {
      timeout: 30_000,
    });
    notes.push(`palette-open: ${page.url().split("/deals/")[1]?.slice(0, 8)}`);

    // Pipeline: totals across the full result (past 1,000), then page 2.
    await page.goto(`${R}/pipeline`, { waitUntil: "load" });
    await shot("pipeline", 3000);
    const boardText = await text(page);
    const total = Number((boardText.match(/([\d,]+)\s+deals/) ?? [])[1]?.replace(/,/g, "") ?? 0);
    notes.push(`pipeline total=${total}`);
    if (total <= 1000) errors.push(`pipeline: total ${total} is not past the 1,000-row cap`);
    await page.goto(`${R}/pipeline?page=2`, { waitUntil: "load" });
    await shot("pipeline-page2", 2500);
    await page.goto(`${R}/pipeline?status=all&stalled=30`, { waitUntil: "load" });
    await shot("pipeline-stalled", 2500);
    // A governed move through the card's own select (keyboard path), then the dialog.
    await page.goto(`${R}/pipeline`, { waitUntil: "load" });
    await page.waitForTimeout(2000);
    const cardSelect = page.locator("li select").first();
    if (await cardSelect.count()) {
      const options = await cardSelect.locator("option").allTextContents();
      const target = options[1];
      if (target) {
        await cardSelect.selectOption({ label: target });
        await page.waitForTimeout(600);
        await shot("pipeline-move-dialog", 400);
        await page.locator("textarea").first().fill("Walk: customer confirmed the scope");
        await page
          .getByRole("button", { name: /^Move$|^نقل$/ })
          .last()
          .click();
        await page
          .locator("[role=dialog]")
          .getByText(/Moved|Missing|Changed by someone|Not possible|تم النقل|مفقود/)
          .first()
          .waitFor({ timeout: 90_000 })
          .catch(() => errors.push("move: no outcome shown"));
        await shot("pipeline-move-result", 400);
        notes.push(
          `move-dialog: ${(
            await page
              .locator("[role=dialog]")
              .innerText()
              .catch(() => "")
          )
            .replace(/\s+/g, " ")
            .slice(0, 160)}`,
        );
        await page.keyboard.press("Escape");
      }
    } else errors.push("pipeline: no card select found");

    // Leads: list past 1,000, filters, capture, quarantine review.
    await page.goto(`${R}/leads`, { waitUntil: "load" });
    await shot("leads", 2500);
    const leadsText = await text(page);
    const leadTotal = Number(
      (leadsText.match(/([\d,]+)\s+leads/) ?? [])[1]?.replace(/,/g, "") ?? 0,
    );
    notes.push(`leads total=${leadTotal}`);
    if (leadTotal <= 1000) errors.push(`leads: total ${leadTotal} is not past the 1,000-row cap`);
    await page.goto(`${R}/leads?page=3&status=new`, { waitUntil: "load" });
    await shot("leads-page3", 2000);
    await page.goto(`${R}/leads?quarantine=quarantined`, { waitUntil: "load" });
    await shot("leads-quarantine", 2000);
    const work = page.getByRole("link", { name: /Work on it|العمل عليه/ }).first();
    if (await work.count()) {
      await work.click();
      await page.waitForTimeout(2000);
      await shot("lead-work", 500);
      const trust = page.getByRole("button", { name: /^Trust$|^توثيق$/ }).first();
      if (await trust.count()) {
        await trust.click();
        await page
          .waitForURL(/ok=reviewed/, { timeout: 90_000 })
          .catch(() => errors.push("trust: no redirect"));
        await shot("lead-trusted", 500);
      }
    }
    await page.goto(`${R}/leads`, { waitUntil: "load" });
    await page.locator("summary").first().click();
    await page.locator('input[name="name"]').first().fill(`Walk enquiry ${Date.now()}`);
    await page.locator('input[name="email"]').first().fill(`walk-${Date.now()}@example.invalid`);
    await page.locator('input[name="value_major"]').first().fill("125000");
    await page.getByRole("button", { name: /Capture lead|تسجيل العميل المحتمل/ }).click();
    await page
      .waitForURL(/ok=captured/, { timeout: 90_000 })
      .catch(() => errors.push("capture: no redirect"));
    await shot("lead-captured", 500);
    expectText("lead-captured", await text(page), /Lead captured|تم تسجيل/);

    // Deal room: every tab, the lazy canvas and the assistant (fail-closed).
    const deal = `${R}/deals/${dealId}`;
    for (const tab of ["overview", "stakeholders", "products", "risks", "commercial", "history"]) {
      await page.goto(tab === "overview" ? deal : `${deal}?tab=${tab}`, { waitUntil: "load" });
      await shot(`deal-${tab}`, 2000);
    }
    await page.goto(`${deal}?tab=canvas`, { waitUntil: "load" });
    await page
      .waitForSelector(".react-flow", { timeout: 60_000 })
      .catch(() => errors.push("canvas: react-flow did not mount"));
    await shot("deal-canvas", 3000);
    await page.goto(`${deal}?tab=assistant`, { waitUntil: "load" });
    await shot("deal-assistant", 2000);
    expectText("deal-assistant", await text(page), /assistant is off|المساعد متوقف/);
    // Log an activity on the deal (history tab form).
    await page.goto(`${deal}?tab=history`, { waitUntil: "load" });
    await page.locator('input[name="title"]').first().fill("Walk: call with the buyer");
    await page
      .getByRole("button", { name: /Log activity|تسجيل نشاط/ })
      .first()
      .click();
    await page
      .waitForURL(/ok=logged/, { timeout: 90_000 })
      .catch(() => errors.push("log: no redirect"));
    await shot("deal-history-logged", 500);

    // Customer 360 and merge preview (nothing applied).
    await page.goto(`${R}/customers/${customerId}`, { waitUntil: "load" });
    await shot("customer-360", 2500);
    await page.goto(`${R}/customers/${customerId}/merge`, { waitUntil: "load" });
    const src = page.locator('select[name="source"]');
    if (await src.count()) {
      await src.selectOption({ index: 1 });
      await page.getByRole("button", { name: /Preview merge|معاينة الدمج/ }).click();
      await page
        .waitForURL(/source=/, { timeout: 90_000 })
        .catch(() => errors.push("merge: no preview"));
      await shot("customer-merge-preview", 500);
      expectText("merge-preview", await text(page), /Records that will move|السجلات التي ستنتقل/);
    }

    // Forecast, campaigns, targets, success, automations (dry run), reports, settings.
    await page.goto(`${R}/forecast`, { waitUntil: "load" });
    await shot("forecast", 3000);
    expectText("forecast", await text(page), /not guaranteed revenue|ليست إيرادات مضمونة/);
    await page.goto(`${R}/campaigns`, { waitUntil: "load" });
    await shot("campaigns", 2500);
    await page.goto(`${R}/targets`, { waitUntil: "load" });
    await shot("targets", 2500);
    await page.goto(`${R}/success`, { waitUntil: "load" });
    await shot("success", 3000);
    await page.goto(`${R}/success?band=at_risk`, { waitUntil: "load" });
    await shot("success-at-risk", 2000);
    await page.goto(`${R}/automations`, { waitUntil: "load" });
    await shot("automations", 2000);
    const dry = page.getByRole("button", { name: /^Dry run$|^تجربة$/ }).first();
    if (await dry.count()) {
      await dry.click();
      await page
        .waitForURL(/ok=ran/, { timeout: 90_000 })
        .catch(() => errors.push("dry run: no redirect"));
      await shot("automations-dry-run", 500);
      expectText("automations-dry-run", await text(page), /matched|مطابق/);
    }
    await page.goto(`${R}/reports`, { waitUntil: "load" });
    await shot("reports", 3000);
    const res = await ctx.request.get(`${BASE}/api/o/${orgId}/revenue/report?format=pdf`);
    const bytes = Buffer.from(await res.body());
    const latin = bytes.toString("latin1");
    const pages = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    notes.push(
      `pdf: status=${res.status()} type=${res.headers()["content-type"]} bytes=${bytes.length} magic=${latin.slice(0, 5)} pages=${pages}`,
    );
    writeFileSync(path.join(OUT, "revenue-report.pdf"), bytes);
    if (res.status() !== 200 || latin.slice(0, 5) !== "%PDF-")
      errors.push("pdf: not a PDF response");
    await page.goto(`${R}/settings`, { waitUntil: "load" });
    await shot("settings", 2500);

    // Arabic
    await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
    await page.goto(`${R}`, { waitUntil: "load" });
    await shot("ar-hub", 3000);
    notes.push(
      `ar dir=${await page.locator("html").getAttribute("dir")} lang=${await page.locator("html").getAttribute("lang")}`,
    );
    await page.goto(`${R}/pipeline`, { waitUntil: "load" });
    await shot("ar-pipeline", 2500);
    await page.goto(deal, { waitUntil: "load" });
    await shot("ar-deal", 2500);
    await page.goto(`${R}/forecast`, { waitUntil: "load" });
    await shot("ar-forecast", 2500);
    const resAr = await ctx.request.get(`${BASE}/api/o/${orgId}/revenue/report?format=pdf`);
    notes.push(`pdf-ar: status=${resAr.status()} bytes=${(await resAr.body()).length}`);
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
    wire(m, "mobile ");
    for (const [name, url] of [
      ["mobile-hub", R],
      ["mobile-pipeline", `${R}/pipeline`],
      ["mobile-leads", `${R}/leads`],
      ["mobile-deal", deal],
      ["mobile-deal-products", `${deal}?tab=products`],
      ["mobile-customer", `${R}/customers/${customerId}`],
      ["mobile-success", `${R}/success`],
      ["mobile-forecast", `${R}/forecast`],
    ] as const) {
      await m.goto(url, { waitUntil: "load" });
      await m.waitForTimeout(2500);
      await m.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      const w = await m.evaluate(() => document.documentElement.scrollWidth);
      if (w > 380) errors.push(`${name}: horizontal overflow ${w}px`);
    }
    await mctx.close();
  } finally {
    await browser.close();
  }
  notes.push(`errors: ${errors.length === 0 ? "none" : errors.slice(0, 12).join(" | ")}`);
  writeFileSync(path.join(OUT, "notes.txt"), notes.join("\n") + "\n");
  console.log(notes.join("\n"));
  if (errors.length > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
