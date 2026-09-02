/**
 * H26 headless UI walk against the dev preview (TEST project). Signs in
 * through the app's own token-hash route (no password typed), opens the
 * Document Studio screens at desktop width, in Arabic, and at 375 px, writes
 * PNGs + page text to .h26-shots/, and downloads a real PDF to check its
 * bytes (magic number, embedded faces, page count).
 *
 *   npx tsx tooling/scripts/h26-ui-shots.ts <owner email> <orgId> <documentId> [issuedDocumentId]
 *
 * BASE defaults to http://localhost:3213 (dev-docstudio-preview.mjs).
 */
import "./load-env-integration";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const email = process.argv[2] ?? "";
const orgId = process.argv[3] ?? "";
const docId = process.argv[4] ?? "";
const issuedId = process.argv[5];
if (!email || !orgId || !docId) {
  console.error("usage: h26-ui-shots.ts <email> <orgId> <documentId> [issuedDocumentId]");
  process.exit(1);
}
if (/anhgeeutrwftsvuzfinf/.test(process.env.DIRECT_URL ?? "")) {
  console.error("REFUSING: that is the production project.");
  process.exit(1);
}
const BASE = (process.env.PDF_VERIFY_BASE ?? "http://localhost:3213").replace(/\/$/, "");
const OUT = path.join(process.cwd(), ".h26-shots");

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
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
    });
    const shot = async (name: string, wait = 1500) => {
      await page.waitForTimeout(wait);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      const text = (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
      notes.push(`${name}: ${text.slice(0, 220)}`);
    };
    await page.goto(
      `${BASE}/auth/confirm?token_hash=${token}&type=magiclink&next=/o/${orgId}/documents`,
      { waitUntil: "load" },
    );
    await page.waitForSelector("h1", { timeout: 60_000 }).catch(() => {});
    notes.push(`signed in → ${page.url()}`);
    await shot("hub-list");
    for (const layout of ["Board", "Timeline", "Relationships"]) {
      await page.getByRole("button", { name: layout, exact: true }).first().click();
      await shot(`hub-${layout.toLowerCase()}`, 2500);
    }
    await page.goto(`${BASE}/o/${orgId}/documents/new`, { waitUntil: "load" });
    await shot("new");
    await page.goto(`${BASE}/o/${orgId}/documents/templates`, { waitUntil: "load" });
    await shot("templates-list", 2500);
    await page.goto(`${BASE}/o/${orgId}/documents/workflows`, { waitUntil: "load" });
    await shot("workflows-list", 2500);
    const designerLink = page.getByRole("link", { name: "Open designer" }).first();
    if (await designerLink.count()) {
      await designerLink.click();
      await page.waitForURL((u) => u.pathname.includes("/documents/workflows/"), {
        timeout: 60_000,
      });
      await shot("workflow-designer", 3000);
      const firstStep = page.locator("ol li button").first();
      if (await firstStep.count()) {
        await firstStep.click();
        await shot("workflow-designer-step", 1500);
      }
    }
    const gatedId = process.argv[6];
    if (gatedId) {
      await page.goto(`${BASE}/o/${orgId}/documents/${gatedId}?tab=workflow`, {
        waitUntil: "load",
      });
      await shot("doc-workflow", 3000);
    }
    const docUrl = `${BASE}/o/${orgId}/documents/${docId}`;
    await page.goto(`${docUrl}?tab=edit`, { waitUntil: "load" });
    await shot("builder", 2500);
    // Select the first block and open its inspector; insert a paragraph.
    const firstBlock = page.locator("ul[aria-label] > li button").first();
    if (await firstBlock.count()) {
      await firstBlock.click();
      await shot("builder-inspector");
    }
    const insertParagraph = page.getByRole("button", { name: /\+ Paragraph/ }).first();
    if (await insertParagraph.count()) {
      await insertParagraph.click();
      await page.waitForTimeout(2500);
      await shot("builder-inserted");
    }
    // Review: post a real comment anchored to the first block, then screenshot.
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    await page.waitForTimeout(1500);
    const anchorSelect = page.locator("aside select").first();
    if (await anchorSelect.count()) await anchorSelect.selectOption({ index: 1 });
    const commentBox = page.locator("aside textarea").first();
    if (await commentBox.count()) {
      await commentBox.fill(`Walk comment ${Date.now()}`);
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await page.waitForTimeout(3000);
    }
    await shot("doc-review", 1500);
    for (const tab of ["Preview", "Revisions", "Activity", "Details"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await shot(`doc-${tab.toLowerCase()}`, tab === "Preview" ? 8000 : 2500);
    }
    if (issuedId) {
      await page.goto(`${BASE}/o/${orgId}/documents/${issuedId}?tab=preview`, {
        waitUntil: "load",
      });
      await shot("issued-preview", 8000);
      await page.goto(`${BASE}/o/${orgId}/documents/${issuedId}?tab=activity`, {
        waitUntil: "load",
      });
      await shot("issued-activity", 2000);
      // The rendered document itself (the same HTML the preview mounts and the PDF prints).
      await page.goto(`${BASE}/api/o/${orgId}/documents/studio/${issuedId}?lang=en`, {
        waitUntil: "load",
      });
      await shot("issued-document-en", 2500);
      await page.goto(`${BASE}/api/o/${orgId}/documents/studio/${issuedId}?lang=ar`, {
        waitUntil: "load",
      });
      await shot("issued-document-ar", 2500);
      await page.goto(`${BASE}/api/o/${orgId}/documents/studio/${docId}`, { waitUntil: "load" });
      await shot("draft-document", 2500);
      // The real PDF: bytes, not the preview route.
      const res = await ctx.request.get(
        `${BASE}/api/o/${orgId}/documents/studio/${issuedId}?format=pdf`,
      );
      const bytes = Buffer.from(await res.body());
      const latin = bytes.toString("latin1");
      const pages = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      notes.push(
        `pdf: status=${res.status()} type=${res.headers()["content-type"]} disposition=${res.headers()["content-disposition"]} bytes=${bytes.length} magic=${latin.slice(0, 5)} pages=${pages} naskh=${latin.includes("NotoNaskhArabic")} sans=${latin.includes("NotoSans")} hash=${res.headers()["x-document-hash"]?.slice(0, 12)}`,
      );
      writeFileSync(path.join(OUT, "issued.pdf"), bytes);
      if (res.status() !== 200 || latin.slice(0, 5) !== "%PDF-")
        errors.push("pdf: not a PDF response");
    }
    // The public signing page (a fresh context: no session, only the token).
    const signToken = process.argv[7];
    if (signToken) {
      const pub = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const sp = await pub.newPage();
      sp.on("pageerror", (e) => errors.push(`sign pageerror: ${e.message}`));
      await sp.goto(`${BASE}/sign/${signToken}`, { waitUntil: "load" });
      await sp.waitForTimeout(4000);
      await sp.screenshot({ path: path.join(OUT, "sign-page.png"), fullPage: true });
      notes.push(
        `sign-page: ${(await sp.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
      );
      await sp.goto(`${BASE}/sign/${signToken}?lang=ar`, { waitUntil: "load" });
      await sp.waitForTimeout(3000);
      await sp.screenshot({ path: path.join(OUT, "sign-page-ar.png"), fullPage: true });
      const mob = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      });
      const mp = await mob.newPage();
      await mp.goto(`${BASE}/sign/${signToken}`, { waitUntil: "load" });
      await mp.waitForTimeout(3000);
      await mp.screenshot({ path: path.join(OUT, "sign-page-mobile.png"), fullPage: true });
      await mob.close();
      await pub.close();
      // Signatures tab on the issued document.
      if (issuedId) {
        await page.goto(`${BASE}/o/${orgId}/documents/${issuedId}?tab=signatures`, {
          waitUntil: "load",
        });
        await shot("doc-signatures", 2500);
      }
    }
    // The public form page (fresh context, only the token): validation, then a submission.
    const formToken = process.argv[8];
    const formDocId = process.argv[9];
    if (formToken) {
      const pub = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const fp = await pub.newPage();
      fp.on("pageerror", (e) => errors.push(`form pageerror: ${e.message}`));
      await fp.goto(`${BASE}/f/${formToken}`, { waitUntil: "load" });
      await fp.waitForTimeout(4000);
      await fp.screenshot({ path: path.join(OUT, "form-page.png"), fullPage: true });
      notes.push(
        `form-page: ${(await fp.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160)}`,
      );
      // Empty submit: the server refuses and the page shows the problems.
      await fp.locator('button[type="submit"]').click();
      await fp.waitForURL((u) => u.searchParams.has("problems"), { timeout: 30_000 });
      await fp.waitForTimeout(2500);
      await fp.screenshot({ path: path.join(OUT, "form-page-problems.png"), fullPage: true });
      const problemCount = await fp.locator("p.text-danger").count();
      notes.push(`form problems shown: ${problemCount}`);
      if (problemCount === 0) errors.push("form: no validation problems rendered");
      // A real submission.
      await fp.fill('input[name="__name"]', "Walk Tester");
      await fp.fill('input[name="__email"]', "walk@example.invalid");
      await fp.fill('input[name="company_name"]', "Walk Trading LLC");
      await fp.fill('input[name="contact_name"]', "Walk Tester");
      await fp.fill('input[name="email"]', "walk@example.invalid");
      await fp.fill('input[name="phone"]', "+971500000001");
      await fp.selectOption('select[name="customer_type"]', "0");
      await fp.waitForTimeout(500);
      await fp.fill('input[name="license_no"]', "CN-WALK-1");
      await fp.locator('input[name="consent"]').check();
      await fp.locator('button[type="submit"]').click();
      await fp.waitForURL((u) => u.searchParams.get("outcome") === "submitted", {
        timeout: 30_000,
      });
      await fp.waitForTimeout(1500);
      await fp.screenshot({ path: path.join(OUT, "form-page-submitted.png"), fullPage: true });
      notes.push(
        `form-submitted: ${(await fp.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 120)}`,
      );
      await fp.goto(`${BASE}/f/${formToken}?lang=ar`, { waitUntil: "load" });
      await fp.waitForTimeout(3000);
      await fp.screenshot({ path: path.join(OUT, "form-page-ar.png"), fullPage: true });
      const mob = await browser.newContext({
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      });
      const mp = await mob.newPage();
      await mp.goto(`${BASE}/f/${formToken}`, { waitUntil: "load" });
      await mp.waitForTimeout(3000);
      await mp.screenshot({ path: path.join(OUT, "form-page-mobile.png"), fullPage: true });
      await mob.close();
      await pub.close();
      // The inbox and the form document's tab, as the reviewer.
      await page.goto(`${BASE}/o/${orgId}/documents/forms`, { waitUntil: "load" });
      await shot("forms-inbox", 3000);
      notes.push(
        `forms-inbox: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
      );
      if (formDocId) {
        await page.goto(`${BASE}/o/${orgId}/documents/${formDocId}?tab=forms`, {
          waitUntil: "load",
        });
        await shot("doc-forms-tab", 3000);
      }
    }
    // Arabic
    await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
    await page.goto(`${BASE}/o/${orgId}/documents`, { waitUntil: "load" });
    await shot("ar-hub", 2000);
    notes.push(
      `ar dir=${await page.locator("html").getAttribute("dir")} lang=${await page.locator("html").getAttribute("lang")}`,
    );
    await page.goto(`${docUrl}?tab=edit`, { waitUntil: "load" });
    await shot("ar-builder", 2500);
    await page.goto(`${docUrl}?tab=preview`, { waitUntil: "load" });
    await shot("ar-preview", 3000);
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
    m.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
    await m.goto(`${BASE}/o/${orgId}/documents`, { waitUntil: "load" });
    await m.waitForTimeout(2000);
    await m.screenshot({ path: path.join(OUT, "mobile-hub.png"), fullPage: true });
    await m.goto(`${docUrl}?tab=edit`, { waitUntil: "load" });
    await m.waitForTimeout(2500);
    await m.screenshot({ path: path.join(OUT, "mobile-builder.png"), fullPage: true });
    await m.goto(`${BASE}/o/${orgId}/documents/new`, { waitUntil: "load" });
    await m.waitForTimeout(2000);
    await m.screenshot({ path: path.join(OUT, "mobile-new.png"), fullPage: true });
    await mctx.close();
  } finally {
    await browser.close();
  }
  notes.push(`errors: ${errors.length === 0 ? "none" : errors.slice(0, 8).join(" | ")}`);
  writeFileSync(path.join(OUT, "notes.txt"), notes.join("\n") + "\n");
  console.log(notes.join("\n"));
  if (errors.length > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
