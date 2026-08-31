/**
 * Apply one ad-hoc SQL file to the TEST project, and only ever the test project.
 *
 * Used while iterating on a migration that has already been applied there: the
 * runner tracks migrations by filename, so an edited file is never re-applied.
 * This runs the delta so local work can continue; the file as committed is
 * proven from scratch by CI's fresh stack.
 *
 *   npx tsx tooling/scripts/apply-sql-test.ts path/to/fragment.sql
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import postgres from "postgres";
import {
  assertNotProduction,
  targetsOnlyTestProject,
  TEST_PROJECT_REF,
} from "../../tests/integration/guard-env";

config({ path: [".env.test.local", ".env.test"], quiet: true });

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: apply-sql-test.ts <file.sql>");

  assertNotProduction();
  const target = targetsOnlyTestProject();
  if (!target.ok) {
    console.error("Refusing to run — the environment does not point only at the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`target project: ${target.refs.join(", ")} (expected ${TEST_PROJECT_REF})`);

  const text = readFileSync(file, "utf8");
  const sql = postgres(process.env.DIRECT_URL!, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 60,
  });
  try {
    const who = await sql`select current_database() as db, current_user as usr`;
    console.log(`connected: db=${who[0]!.db} user=${who[0]!.usr}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
    });
    console.log(`applied ${file}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
