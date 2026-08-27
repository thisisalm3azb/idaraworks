/**
 * Simulation seed runner (micro-step 006A). Provisions and seeds the five demo
 * businesses in the hosted Supabase project, or validates the plan without writing.
 *
 *   tsx tooling/scripts/sim-seed.ts --dry-run          # plan + invariants only
 *   tsx tooling/scripts/sim-seed.ts --confirm          # WRITE to the hosted DB
 *   tsx tooling/scripts/sim-seed.ts --confirm --only=palm_farm
 *
 * Refuses to write without --confirm, or against any project other than the
 * expected simulation project. Credentials/manifest are written OUTSIDE the repo.
 */
import "./load-env";
import postgres from "postgres";
import { closeAppDb } from "@/platform/tenancy";
import { SCENARIOS } from "../simulation/scenarios";
import { buildPlan } from "../simulation/plan";
import { check } from "../simulation/invariants";
import { planCounts } from "../simulation/types";
import { assertKnownProject, assertRequiredEnv, parseFlags } from "../simulation/guards";
import { provisionScenario, type ProvisionResult } from "../simulation/provision";
import { applyPlan } from "../simulation/apply";
import { writeCredentialsFile, writeManifest } from "../simulation/credentials";

const flags = parseFlags(process.argv.slice(2));
const asOf = flags.asOf ?? new Date().toISOString().slice(0, 10);
const generatedAt = new Date().toISOString();
const projectRef = assertKnownProject();
const scenarios = flags.only.length
  ? SCENARIOS.filter((s) => flags.only.includes(s.key))
  : SCENARIOS;

function log(m: string) {
  console.log(m);
}

async function main() {
  log(`\n── IdaraWorks simulation seed ──────────────────────────────`);
  log(
    `project: ${projectRef}   as-of: ${asOf}   scenarios: ${scenarios.map((s) => s.key).join(", ")}`,
  );

  // 1) Build every plan and validate invariants BEFORE any DB write.
  const plans = scenarios.map((s) => ({ scenario: s, plan: buildPlan(s, asOf) }));
  let anyFail = false;
  for (const { scenario, plan } of plans) {
    const res = check(plan, scenario);
    const c = planCounts(plan);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    log(`\n• ${scenario.displayName} [${scenario.key}] — ${total} rows`);
    log(
      `  ${Object.entries(c)
        .map(([k, v]) => `${k}:${v}`)
        .join("  ")}`,
    );
    log(
      `  states: ${Object.entries(res.metrics)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
    if (!res.ok) {
      anyFail = true;
      log(`  INVARIANT FAILURES:\n   - ${res.errors.join("\n   - ")}`);
    }
  }
  if (anyFail) throw new Error("invariant failures — aborting before any DB write");

  if (flags.dryRun || !flags.confirm) {
    log(`\n${flags.dryRun ? "DRY RUN" : "No --confirm"}: no database writes performed.`);
    log(flags.confirm ? "" : "Pass --confirm to provision + seed the hosted project.");
    return;
  }

  // 2) Real provisioning + seeding (owner/superuser connection).
  assertRequiredEnv();
  const owner = postgres(process.env.DIRECT_URL!, { max: 2, onnotice: () => {} });
  try {
    const pre = (await owner`select
        (select count(*) from public.org)::int as orgs,
        (select count(*) from auth.users)::int as users`) as unknown as Array<{
      orgs: number;
      users: number;
    }>;
    log(`\npre-seed: orgs=${pre[0]!.orgs} users=${pre[0]!.users}`);

    const results: ProvisionResult[] = [];
    for (const { scenario, plan } of plans) {
      log(`\n▶ provisioning ${scenario.displayName}…`);
      const prov = await provisionScenario(owner, scenario, { asOf, generatedAt });
      log(
        `  org ${prov.orgId.slice(0, 8)}… owner ${prov.ownerUserId.slice(0, 8)}… (${prov.createdOrg ? "created" : "reused"}, presets: ${Object.keys(prov.presetIdByCode).join("/")})`,
      );
      const counts = await applyPlan(owner, plan, {
        orgId: prov.orgId,
        ownerUserId: prov.ownerUserId,
        presetIdByCode: prov.presetIdByCode,
      });
      log(
        `  seeded: ${Object.entries(counts)
          .map(([k, v]) => `${k}:${v}`)
          .join("  ")}`,
      );
      results.push(prov);
    }

    const credPath = writeCredentialsFile(results, { asOf, generatedAt });
    const manifestPath = writeManifest(results, {
      asOf,
      generatedAt,
      projectRef,
      preSeedCounts: { orgs: pre[0]!.orgs, users: pre[0]!.users },
    });
    log(`\n✓ done. ${results.length} simulation orgs provisioned + seeded.`);
    log(`  credentials (PRIVATE, has passwords): ${credPath}`);
    log(`  manifest (ids only):                  ${manifestPath}`);
    log(`  org ids: ${results.map((r) => `${r.scenarioKey}=${r.orgId}`).join("  ")}`);
  } finally {
    await owner.end({ timeout: 5 });
    await closeAppDb();
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\nSIM SEED FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
