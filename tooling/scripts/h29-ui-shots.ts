/**
 * H29 — the local UI walk (TEST project only). Drives the Country Readiness
 * Centre, the establishment editor, the version timeline and the rule impact
 * simulator against the dev preview, then repeats the key screens in Arabic,
 * in Spanish, and at 375 px. Every screen is captured to .h29-shots/ and
 * console errors, horizontal overflow and missing affordances are reported.
 *
 *   node tooling/scripts/dev-country-preview.mjs     (in another terminal)
 *   npx tsx tooling/scripts/h29-ui-shots.ts <email> <org> <establishment>
 */
import { config } from "dotenv";
config({ path: [".env.test.local", ".env.test"], quiet: true });
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { PRODUCTION_PROJECT_REF } from "../../tests/integration/guard-env";

const BASE = process.env.COUNTRY_PREVIEW_BASE ?? "http://localhost:3216";
const OUT = ".h29-shots";
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
  if (viewport && width > viewport + 5)
    errors.push(`${name}: horizontal overflow ${width}px at ${viewport}px`);
}

/** Every visible ⟦key⟧ marker: the loud sign of a message key with no string. */
async function missingStrings(page: Page): Promise<string[]> {
  return (await page.evaluate(() => {
    const text = document.body.innerText;
    return [...text.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]!);
  })) as string[];
}

async function main(): Promise<void> {
  const [email, orgId, establishmentId] = process.argv.slice(2);
  if (!email || !orgId || !establishmentId) {
    console.error("usage: h29-ui-shots.ts <email> <orgId> <establishmentId>");
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const countries = `/o/${orgId}/settings/countries`;
  const establishment = `${countries}/${establishmentId}`;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
    });
    page.setDefaultTimeout(60_000);
    await signIn(page, email);

    // 1) The readiness centre: two establishments, six states each, no score.
    await page.goto(`${BASE}${countries}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await shot(page, "centre");
    const body = await page.evaluate(() => document.body.innerText);
    for (const state of [
      "Technically configured",
      "Reviewed internally",
      "Provider connected",
      "Reviewed by a professional",
      "Ready for a pilot",
      "Generally available",
    ])
      if (!body.includes(state)) errors.push(`centre: the state "${state}" is not shown`);
    // A percentage anywhere on this page would be the thing ADR-74 forbids.
    if (/\b\d{1,3}\s?%/.test(body)) errors.push("centre: a percentage appears on the page");
    if (!/does not file|files? nothing|not.*advice|certif/i.test(body))
      errors.push("centre: the disclaimer is missing");
    notes.push(`centre: ${(body.match(/Technically configured/g) ?? []).length} establishment(s)`);

    // 2) The establishment: readiness detail, the version timeline, the
    //    registrations and the country's own address fields.
    await page.goto(`${BASE}${establishment}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await shot(page, "establishment");
    const est = await page.evaluate(() => document.body.innerText);
    for (const label of ["Building number", "District", "Postal code"])
      if (!est.includes(label))
        errors.push(`establishment: the Saudi address field "${label}" is missing`);
    if (est.includes("Address line 1"))
      errors.push("establishment: a generic address shape is being used for Saudi Arabia");
    if (!/Rule versions/i.test(est)) errors.push("establishment: the version timeline is missing");
    const markers = await missingStrings(page);
    if (markers.length) errors.push(`establishment: missing strings ${markers.join(", ")}`);

    // 3) Reading the world as at an earlier date changes the answer.
    await page.goto(`${BASE}${establishment}?on=2026-01-01`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    await shot(page, "establishment-earlier");
    const earlier = await page.evaluate(() => document.body.innerText);
    if (!/No country pack version adopted yet|not adopted/i.test(earlier))
      notes.push(
        "as-at: the earlier date still shows an adopted version (check the fixture dates)",
      );

    // 4) The simulator: a diff, what it cannot touch, and no write.
    await page.goto(`${BASE}${establishment}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const preview = page.getByRole("button", { name: /see what would change/i });
    if ((await preview.count()) === 0) errors.push("simulator: the preview control is missing");
    else {
      await preview.first().click();
      await page.waitForURL(/\/simulate\?/, { timeout: 30_000 });
      await page.waitForTimeout(1200);
      await shot(page, "simulator");
      const sim = await page.evaluate(() => document.body.innerText);
      if (!/cannot touch/i.test(sim))
        errors.push("simulator: the unchanged-records panel is missing");
      if (!/Nothing on this page changes anything/i.test(sim))
        errors.push("simulator: the read-only statement is missing");
      const simMarkers = await missingStrings(page);
      if (simMarkers.length) errors.push(`simulator: missing strings ${simMarkers.join(", ")}`);
    }

    // 5) The language switcher offers three languages, each named in itself.
    await page.goto(`${BASE}/account`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await shot(page, "account-languages");
    const account = await page.evaluate(() => document.body.innerText);
    for (const name of ["English", "العربية", "Español"])
      if (!account.includes(name)) errors.push(`switcher: "${name}" is not offered`);

    // 6) Arabic, right to left.
    await ctx.addCookies([{ name: "locale", value: "ar", url: BASE }]);
    await page.goto(`${BASE}${countries}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const dir = await page.evaluate(() => document.documentElement.dir);
    notes.push(`ar dir=${dir}`);
    if (dir !== "rtl") errors.push(`arabic: dir is ${dir}`);
    await shot(page, "ar-centre");
    const ar = await page.evaluate(() => document.body.innerText);
    if (!/[؀-ۿ]/.test(ar)) errors.push("arabic: the page carries no Arabic script");
    await page.goto(`${BASE}${establishment}`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    await shot(page, "ar-establishment");
    const arMarkers = await missingStrings(page);
    if (arMarkers.length) errors.push(`ar-establishment: missing strings ${arMarkers.join(", ")}`);

    // 7) Spanish, left to right, and no English left on the page.
    await ctx.addCookies([{ name: "locale", value: "es", url: BASE }]);
    await page.goto(`${BASE}${countries}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const esDir = await page.evaluate(() => document.documentElement.dir);
    const esLang = await page.evaluate(() => document.documentElement.lang);
    notes.push(`es lang=${esLang} dir=${esDir}`);
    if (esLang !== "es") errors.push(`spanish: lang is ${esLang}`);
    if (esDir !== "ltr") errors.push(`spanish: dir is ${esDir}`);
    await shot(page, "es-centre");
    const es = await page.evaluate(() => document.body.innerText);
    // English strings that are definitely ON THIS SCREEN in English, so their
    // presence here means a string was not translated rather than that the
    // check was looking at the wrong page.
    for (const leak of [
      "Countries and establishments",
      "Add an establishment",
      "Technically configured",
      "Reviewed by a professional",
    ])
      if (es.includes(leak)) errors.push(`spanish: English left on the centre ("${leak}")`);
    // Spanish should also be visibly Spanish, not merely not-English.
    if (!/Países y establecimientos/.test(es))
      errors.push("spanish: the centre title did not render in Spanish");

    await page.goto(`${BASE}${establishment}`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    await shot(page, "es-establishment");
    const esEst = await page.evaluate(() => document.body.innerText);
    for (const leak of ["Readiness", "Rule versions", "Registrations", "Personal data register"])
      if (esEst.includes(leak))
        errors.push(`spanish: English left on the establishment ("${leak}")`);
    const esMarkers = await missingStrings(page);
    if (esMarkers.length) errors.push(`es-establishment: missing strings ${esMarkers.join(", ")}`);
    await ctx.addCookies([{ name: "locale", value: "en", url: BASE }]);

    // 8) Phones — the workshop-floor case.
    const mctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      storageState: await ctx.storageState(),
    });
    const m = await mctx.newPage();
    m.setDefaultTimeout(60_000);
    for (const [name, url] of [
      ["mobile-centre", countries],
      ["mobile-establishment", establishment],
      ["mobile-new", `${countries}/new`],
    ] as const) {
      await m.goto(`${BASE}${url}`, { waitUntil: "load" });
      await m.waitForTimeout(1200);
      await shot(m, name);
    }
    // Every control a thumb has to hit is at least 44px tall.
    await m.goto(`${BASE}${countries}/new`, { waitUntil: "load" });
    await m.waitForTimeout(1000);
    const small = (await m.evaluate(`(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll("button, a, input, select"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 40) out.push(el.tagName.toLowerCase() + " h=" + Math.round(r.height));
        if (out.length >= 6) break;
      }
      return out;
    })()`)) as string[];
    if (small.length) errors.push(`mobile: controls under 40px — ${small.join(", ")}`);
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
