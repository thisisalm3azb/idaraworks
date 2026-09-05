/**
 * H33 Pilot Lab — performance measurement against the seeded lab.
 *
 *   npm run lab:perf                         # every company, the owner persona, desktop
 *   npm run lab:perf -- --company=tradeline --persona=finance --mobile --locale=ar
 *
 * Signs in through a one-time admin-minted link (no password), then times a
 * fixed list of surfaces with a real browser: navigation start → network idle,
 * plus the count of requests the page made. Runs each surface three times and
 * reports median and slowest, so a single cold compile on the dev server does
 * not masquerade as a product defect. Writes `.pilot-lab/perf-<stamp>.json`
 * and prints a table. It measures; it never edits anything.
 *
 * Requires the app to be running on localhost:3000 against the TEST env
 * (npm run lab:open starts it). The dev server compiles on first hit — the
 * first of the three runs is reported separately as "cold".
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { COMPANIES, companyByKey, personaEmail } from "./companies";
import { findLabOrg } from "./provision";
import { LOCAL_DIR } from "./checkpoint";
import type { PersonaKey } from "./types";

const BASE = "http://localhost:3000";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const MOBILE = process.argv.includes("--mobile");
const LOCALE = arg("locale") ?? "en";
const ONLY = arg("company");
const PERSONA = (arg("persona") ?? "owner") as PersonaKey;

/** The surfaces that matter, relative to /o/<orgId>. */
const SURFACES: Array<{ key: string; path: string }> = [
  { key: "dashboard", path: "" },
  { key: "jobs list", path: "/jobs" },
  { key: "jobs list p2", path: "/jobs?page=2" },
  { key: "customers list", path: "/customers" },
  { key: "customers search", path: "/customers?q=Horizon" },
  { key: "items list", path: "/items" },
  { key: "invoices list", path: "/invoices" },
  { key: "invoices overdue", path: "/invoices?status=overdue" },
  { key: "quotes list", path: "/quotes" },
  { key: "purchase orders", path: "/purchase-orders" },
  { key: "stock", path: "/stock" },
  { key: "people", path: "/people" },
  { key: "attendance", path: "/attendance" },
  { key: "payroll", path: "/payroll" },
  { key: "leads", path: "/leads" },
  { key: "opportunities", path: "/opportunities" },
  { key: "revenue pipeline", path: "/revenue/pipeline" },
  { key: "revenue forecast", path: "/revenue/forecast" },
  { key: "documents", path: "/documents" },
  { key: "studio", path: "/studio" },
  { key: "finance journals", path: "/finance/journals" },
  { key: "finance reports", path: "/finance/reports" },
  { key: "finance tax", path: "/finance/tax" },
  { key: "receivables", path: "/ar" },
  { key: "assets", path: "/assets" },
  { key: "inbox", path: "/inbox" },
  { key: "week", path: "/week" },
];

type Sample = { ms: number; requests: number; status: number | null; bytes: number };
type Result = {
  company: string;
  persona: string;
  surface: string;
  path: string;
  cold: Sample;
  median: number;
  slowest: number;
  requestsMedian: number;
  note?: string;
};

async function timeOnce(page: Page, url: string): Promise<Sample> {
  let requests = 0;
  let bytes = 0;
  const onReq = () => requests++;
  const onRes = async (r: { headers: () => Record<string, string> }) => {
    const len = Number(r.headers()["content-length"] ?? 0);
    if (!Number.isNaN(len)) bytes += len;
  };
  page.on("request", onReq);
  page.on("response", onRes);
  const t0 = Date.now();
  const resp = await page
    .goto(url, { waitUntil: "networkidle", timeout: 120_000 })
    .catch(() => null);
  const ms = Date.now() - t0;
  page.off("request", onReq);
  page.off("response", onRes);
  return { ms, requests, status: resp?.status() ?? null, bytes };
}

async function main() {
  const env = loadLabEnv();
  const sql = openOwner(env);
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const companies = ONLY ? [companyByKey(ONLY)] : COMPANIES;
  const results: Result[] = [];
  const browser = await chromium.launch();
  try {
    for (const company of companies) {
      const orgId = await findLabOrg(sql, company.key);
      if (!orgId) {
        console.log(`${company.key}: not provisioned — skipped`);
        continue;
      }
      const ctx = await browser.newContext(
        MOBILE
          ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }
          : { viewport: { width: 1366, height: 768 } },
      );
      await ctx.addCookies([{ name: "locale", value: LOCALE, url: BASE }]);
      const page = await ctx.newPage();
      const link = await admin.auth.admin.generateLink({
        type: "magiclink",
        email: personaEmail(company.key, PERSONA),
      });
      if (link.error || !link.data.properties?.hashed_token)
        throw link.error ?? new Error("no token");
      await page.goto(
        `${BASE}/auth/confirm?token_hash=${encodeURIComponent(link.data.properties.hashed_token)}&type=magiclink&next=${encodeURIComponent(`/o/${orgId}`)}`,
      );
      await page.waitForURL(new RegExp(`/o/${orgId}`), { timeout: 120_000 });
      console.log(`\n${company.nameEn} — ${PERSONA} — ${MOBILE ? "375px" : "desktop"} — ${LOCALE}`);
      console.log(
        `  ${"surface".padEnd(20)} ${"cold".padStart(7)} ${"median".padStart(7)} ${"slowest".padStart(8)} ${"reqs".padStart(5)}  status`,
      );
      for (const s of SURFACES) {
        const url = `${BASE}/o/${orgId}${s.path}`;
        const cold = await timeOnce(page, url);
        const warm = [await timeOnce(page, url), await timeOnce(page, url)];
        const all = [cold, ...warm].map((x) => x.ms).sort((a, b) => a - b);
        const median = all[1]!;
        const slowest = all[2]!;
        const requestsMedian = [cold, ...warm].map((x) => x.requests).sort((a, b) => a - b)[1]!;
        const note = cold.status && cold.status >= 400 ? `HTTP ${cold.status}` : undefined;
        results.push({
          company: company.key,
          persona: PERSONA,
          surface: s.key,
          path: s.path,
          cold,
          median,
          slowest,
          requestsMedian,
          note,
        });
        console.log(
          `  ${s.key.padEnd(20)} ${String(cold.ms).padStart(6)}ms ${String(median).padStart(6)}ms ${String(slowest).padStart(7)}ms ${String(requestsMedian).padStart(5)}  ${cold.status ?? "—"}${note ? "  ← " + note : ""}`,
        );
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await sql.end();
  }
  mkdirSync(LOCAL_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${LOCAL_DIR}/perf-${stamp}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { base: BASE, mobile: MOBILE, locale: LOCALE, persona: PERSONA, results },
      null,
      2,
    ),
  );
  const slow = results.filter((r) => r.median > 3000);
  console.log(
    `\nwritten ${file}; ${results.length} measurements; ${slow.length} with median > 3 s${slow.length ? ": " + slow.map((r) => `${r.company}/${r.surface} ${r.median}ms`).join(", ") : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
