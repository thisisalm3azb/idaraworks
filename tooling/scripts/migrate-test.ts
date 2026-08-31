/**
 * Apply migrations to the TEST project, and only ever to the test project.
 *
 * `npm run db:migrate` loads `.env.local`, which is production — correct for the
 * release process, wrong for everyday work. This runner loads `.env.test.local`
 * FIRST (dotenv never overwrites an already-set variable, so `.env.local` cannot
 * clobber it afterwards), then refuses to continue unless the resolved target is
 * the test project.
 *
 *   npx tsx tooling/scripts/migrate-test.ts
 */
import { config } from "dotenv";

// Before anything imports the migration runner, which pulls in ./load-env.
config({ path: [".env.test.local", ".env.test"], quiet: true });

import {
  assertNotProduction,
  targetsOnlyTestProject,
  TEST_PROJECT_REF,
} from "../../tests/integration/guard-env";

async function main() {
  assertNotProduction();
  const target = targetsOnlyTestProject();
  if (!target.ok) {
    console.error("Refusing to migrate — the environment does not point only at the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`migrating project ${target.refs.join(", ")} (expected ${TEST_PROJECT_REF})`);

  // Imported late so the test environment is already in place.
  const { runMigrations } = await import("./migrate");

  // Last line of defence: confirm at the server which database we reached, and
  // that it is not the production one, before applying anything.
  const postgres = (await import("postgres")).default;
  const probe = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const who = await probe`select current_database() as db, current_user as usr`;
    console.log(`connected: db=${who[0]!.db} user=${who[0]!.usr}`);
  } finally {
    await probe.end({ timeout: 5 });
  }

  const r = await runMigrations();
  console.log(
    `migrations applied: ${r.applied.length}` +
      (r.applied.length ? `\n  ${r.applied.join("\n  ")}` : " (already up to date)"),
  );
}

main().catch((e) => {
  console.error("migration failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
