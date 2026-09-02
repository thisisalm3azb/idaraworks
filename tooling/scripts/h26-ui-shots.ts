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
