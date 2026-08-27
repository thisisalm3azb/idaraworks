/**
 * Verifies the seeded simulation accounts in the hosted project (micro-step 006A).
 * Reads the PRIVATE manifest + credentials (outside the repo), confirms each owner
 * can authenticate, exercises the REAL dashboard composers / list services the app
 * renders, proves cross-tenant RLS isolation and financial redaction, checks the
 * Arabic account's locale, and writes a private evidence report. Prints NO
 * passwords. Contains no secrets itself.
 *
 *   tsx tooling/scripts/sim-verify.ts
 */
import "./load-env";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import type { Ctx } from "@/platform/tenancy";
import { withCtx, sql, closeAppDb } from "@/platform/tenancy";
import { composeToday } from "@/modules/today/service";
import { getDashboardExtras } from "@/modules/today/dashboard";
import { computeAR } from "@/modules/invoices/service";
import { listCustomers } from "@/modules/masters/service";
import { listQuotes } from "@/modules/quotes/service";
import { listJobs } from "@/modules/jobs/service";
import { getJobCosting } from "@/modules/costing/service";
import { PRIVATE_DIR } from "../simulation/credentials";
import { scenarioByKey } from "../simulation/scenarios";

const manifest = JSON.parse(readFileSync(join(PRIVATE_DIR, "sim-manifest.json"), "utf8")) as {
  asOf: string;
  accounts: Array<{
    scenario: string;
    displayName: string;
    orgId: string;
    ownerUserId: string;
    email: string;
    locale: string;
  }>;
};
const creds = readFileSync(join(PRIVATE_DIR, "simulation-accounts.txt"), "utf8");
const passwordFor = (email: string): string => {
  const lines = creds.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(`Login email : ${email}`));
  const pw = i >= 0 ? lines.slice(i, i + 3).find((l) => l.includes("Password")) : undefined;
  return pw ? pw.split(":").slice(1).join(":").trim() : "";
};

const asOf = manifest.asOf;
const computedAt = `${asOf}T09:00:00.000Z`;
const owner = postgres(process.env.DIRECT_URL!, { max: 2, onnotice: () => {} });
const anon = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

type Report = Record<string, unknown>;

async function main() {
  const report: Report[] = [];
  const jobByOrg: Record<string, string> = {};
  for (const a of manifest.accounts) {
    const [j] =
      (await owner`select id::text as id from public.job where org_id = ${a.orgId} order by created_at limit 1`) as unknown as Array<{
        id: string;
      }>;
    if (j) jobByOrg[a.orgId] = j.id;
  }

  for (const a of manifest.accounts) {
    const scenario = scenarioByKey(a.scenario)!;
    const ctx: Ctx = {
      orgId: a.orgId,
      userId: a.ownerUserId,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: "sim-verify",
    };
    const line: Report = { scenario: a.scenario, displayName: a.displayName, orgId: a.orgId };

    // 1) Login succeeds with the generated credentials.
    const client = anon();
    const { data, error } = await client.auth.signInWithPassword({
      email: a.email,
      password: passwordFor(a.email),
    });
    line.login = error
      ? `FAIL: ${error.message}`
      : data.user?.id === a.ownerUserId
        ? "ok (correct owner)"
        : "FAIL: wrong user";
    await client.auth.signOut();

    // 2) Owner Home renders (real composer) + dashboard state. Shapes are read
    // loosely so this evidence script is decoupled from internal payload types.
    const today = (await composeToday(ctx, "owner", { asOf, computedAt })) as unknown as {
      screen: string;
      owner?: { brief?: { state?: string } };
    };
    const extras = (await getDashboardExtras(ctx, "owner", { asOf, computedAt })) as unknown as {
      jobs?: { active?: number; overdue?: number; doneThisWeek?: number };
      approvalsPending?: number;
      openIssues?: number;
      quotesAwaiting?: number;
      unpaidExpenses?: number;
    };
    const ar = (await computeAR(ctx, "owner", asOf)) as unknown as {
      outstandingMinor: number | null;
      buckets?: { over90?: number | null };
    };
    line.ownerHome = { screen: today.screen, briefState: today.owner?.brief?.state ?? null };
    line.dashboard = {
      activeJobs: extras.jobs?.active ?? null,
      overdueJobs: extras.jobs?.overdue ?? null,
      doneThisWeek: extras.jobs?.doneThisWeek ?? null,
      approvalsPending: extras.approvalsPending ?? null,
      openIssues: extras.openIssues ?? null,
      quotesAwaiting: extras.quotesAwaiting ?? null,
      unpaidExpenses: extras.unpaidExpenses ?? null,
      collectionsOutstandingMinor: ar.outstandingMinor,
      collectionsOver90Minor: ar.buckets?.over90 ?? null,
    };

    // 3) Core surfaces open with data.
    line.customers = (await listCustomers(ctx, "owner")).length;
    const quotes = await listQuotes(ctx, "owner");
    line.quotes = quotes.length;
    line.jobs = (await listJobs(ctx, "owner")).length;

    // 4) Financial redaction: a non-cost/non-price reader sees no cost total.
    const jid = jobByOrg[a.orgId];
    if (jid) {
      const priv = (await getJobCosting(
        ctx,
        "owner",
        jid,
        scenario.currency as "AED",
      )) as unknown as { totalCostMinor: number | null };
      const nonPriv: Ctx = { ...ctx, costPrivileged: false, pricePrivileged: false };
      const red = (await getJobCosting(
        nonPriv,
        "manager",
        jid,
        scenario.currency as "AED",
      )) as unknown as { totalCostMinor: number | null };
      line.redaction =
        priv.totalCostMinor != null && red.totalCostMinor == null
          ? "ok (cost hidden from manager)"
          : "CHECK";
    }

    // 5) Cross-tenant isolation: this org cannot see another demo org's job.
    const other = manifest.accounts.find((x) => x.orgId !== a.orgId);
    if (other && jobByOrg[other.orgId]) {
      const rows = (await withCtx(ctx, (tx) =>
        tx.execute(sql`select id from public.job where id = ${jobByOrg[other.orgId]}`),
      )) as unknown as unknown[];
      line.crossTenant =
        rows.length === 0 ? "ok (foreign job not visible)" : "FAIL: cross-tenant leak";
    }

    // 6) Locale / RTL config.
    const [prof] =
      (await owner`select locale from public.user_profile where id = ${a.ownerUserId}`) as unknown as Array<{
        locale: string;
      }>;
    line.locale = prof?.locale ?? null;
    line.rtl = prof?.locale === "ar" ? "rtl" : "ltr";

    report.push(line);
    console.log(
      `✓ ${a.displayName}: login=${line.login} home=${JSON.stringify(line.ownerHome)} dash=${JSON.stringify(line.dashboard)} customers=${line.customers} quotes=${line.quotes} jobs=${line.jobs} redaction=${line.redaction} crossTenant=${line.crossTenant} locale=${line.locale}`,
    );
  }

  const outPath = join(PRIVATE_DIR, "sim-verification.json");
  writeFileSync(
    outPath,
    JSON.stringify({ asOf, verifiedAt: new Date().toISOString(), accounts: report }, null, 2),
    "utf8",
  );
  console.log(`\nprivate verification report: ${outPath}`);
}

main()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("VERIFY FAILED:", e instanceof Error ? e.message : e);
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
