/**
 * Simulation teardown runner (micro-step 006A). Deletes ONLY organizations that
 * carry the exact demo marker (and their dedicated owner users). Refuses to run
 * without explicit authorization; never touches unmarked/real orgs.
 *
 *   tsx tooling/scripts/sim-cleanup.ts                              # list only
 *   tsx tooling/scripts/sim-cleanup.ts --yes-really-delete-demo-orgs   # delete
 *   …optionally --only=palm_farm,home_cupcakes to scope to some scenarios.
 */
import "./load-env";
import postgres from "postgres";
import { assertKnownProject, assertRequiredEnv, parseFlags } from "../simulation/guards";
import { cleanupDemoOrgs, discoverDemoOrgs } from "../simulation/cleanup";

const flags = parseFlags(process.argv.slice(2));

async function main() {
  assertRequiredEnv();
  const ref = assertKnownProject();
  const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    let demo = await discoverDemoOrgs(owner);
    if (flags.only.length) demo = demo.filter((d) => flags.only.includes(d.scenario));
    console.log(`\nproject: ${ref}`);
    console.log(`demo orgs found (marker '${"demo.simulation"}'): ${demo.length}`);
    for (const d of demo) console.log(`  - ${d.scenario}: ${d.orgId}`);
    if (demo.length === 0) return;

    if (!flags.yesReallyCleanup) {
      console.log(
        `\nThis is a LISTING only. To delete these ${demo.length} demo orgs (and their owner users),`,
      );
      console.log(`re-run with:  tsx tooling/scripts/sim-cleanup.ts --yes-really-delete-demo-orgs`);
      return;
    }
    const summary = await cleanupDemoOrgs(
      owner,
      demo.map((d) => d.orgId),
    );
    console.log(
      `\n✓ deleted ${summary.orgIds.length} demo orgs across ${summary.tables} org-scoped tables; removed ${summary.deletedUsers.length} owner users.`,
    );
    console.log(`  (Any non-demo org was refused; protected orgs untouched.)`);
  } finally {
    await owner.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nSIM CLEANUP FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
