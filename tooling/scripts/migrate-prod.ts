/**
 * Apply migrations to PRODUCTION, deliberately.
 *
 * The plain `db:migrate` loads `.env.local` and applies whatever it finds, which
 * means a mistyped command changes the live database with no warning and no
 * confirmation. That is the accident this path exists to make hard.
 *
 * What it does, in order, refusing at the first problem:
 *   1. Loads `.env.local` ONLY. A production run reads production credentials
 *      from the place they live; nothing else is consulted.
 *   2. POSITIVELY identifies production. It is not enough to fail to recognise a
 *      test project: an empty or half-filled environment must never read as
 *      production, and a file naming two projects is refused outright.
 *   3. Asks the server which database it reached, so a correct-looking URL
 *      pointing somewhere unexpected is caught before any write.
 *   4. PRINTS the target and the exact pending file list, then stops if there is
 *      nothing to do.
 *   5. Requires the confirmation phrase, passed as a command-line argument, and
 *      naming the project it will change. When a terminal is attached it also
 *      asks the operator to retype the project reference.
 *
 * The phrase is an ARGUMENT, never an environment variable. A variable can be
 * left exported in a shell, inherited by a script, or set once in CI and
 * forgotten; an argument has to be typed for this run, and it shows up verbatim
 * in shell history and CI logs where a reviewer can see it.
 *
 *   npx tsx tooling/scripts/migrate-prod.ts --confirm=apply-migrations-to-<ref>
 *   npx tsx tooling/scripts/migrate-prod.ts --dry-run     # print, change nothing
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

function fail(lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const confirmArg = argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);

  // ── 2. Positively production, and nothing else ───────────────────────────
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    fail([
      "Refusing to migrate: this environment does not point exclusively at production.",
      ...target.problems.map((p) => `  - ${p}`),
      `  project references seen: ${target.refs.join(", ") || "none"}`,
      "",
      "For the test project use:  npx tsx tooling/scripts/migrate-test.ts",
    ]);
  }
  for (const key of ["DIRECT_URL", "DATABASE_URL", "APP_DB_PASSWORD"] as const) {
    if (!process.env[key]) {
      fail([
        `Refusing to migrate: ${key} is missing from .env.local.`,
        "Incomplete credentials are refused rather than partially applied.",
      ]);
    }
  }

  // ── 3. Ask the server what it actually is ────────────────────────────────
  const probe = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  let serverDb = "";
  try {
    const who = await probe`select current_database() as db, current_user as usr`;
    serverDb = String(who[0]!.db);
    console.log(`target project : ${PRODUCTION_PROJECT_REF} (PRODUCTION)`);
    console.log(`database       : ${serverDb} as ${who[0]!.usr}`);
  } finally {
    await probe.end({ timeout: 5 });
  }

  // ── 4. Show exactly what would change ────────────────────────────────────
  const { pendingMigrations, runMigrations } = await import("./migrate");
  const { pending, applied } = await pendingMigrations();
  console.log(`already applied: ${applied.length}`);
  if (pending.length === 0) {
    console.log("\nNothing pending. No changes made.");
    return;
  }
  console.log(`\nPENDING (${pending.length}) — these WILL be applied to production:`);
  for (const f of pending) console.log(`  ${f}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing was applied.");
    return;
  }

  // ── 5. The confirmation ──────────────────────────────────────────────────
  const phrase = productionMigrationPhrase();
  if (confirmArg !== phrase) {
    fail([
      "",
      "Refusing to migrate: the confirmation phrase is missing or wrong.",
      "",
      "Re-run with the phrase, which names the project it will change:",
      `  npx tsx tooling/scripts/migrate-prod.ts --confirm=${phrase}`,
      "",
      "Or preview without changing anything:",
      "  npx tsx tooling/scripts/migrate-prod.ts --dry-run",
    ]);
  }
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const typed = await rl.question(
        `\nType the project reference to proceed (${PRODUCTION_PROJECT_REF}): `,
      );
      if (typed.trim() !== PRODUCTION_PROJECT_REF) {
        fail(["That did not match. Nothing was applied."]);
      }
    } finally {
      rl.close();
    }
  }

  console.log("\napplying...");
  const r = await runMigrations();
  console.log(`applied ${r.applied.length}:`);
  for (const f of r.applied) console.log(`  ${f}`);
}

main().catch((e) => {
  console.error("migration failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
