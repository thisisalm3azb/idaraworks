/**
 * Is `.env.test.local` ready, and does it point ONLY at the test project?
 *
 * Makes no database connection. Reads the file, reports which variables are
 * still blank, which Supabase project each URL refers to, and what the
 * production guard would decide. Prints no credential values — only whether
 * each is present, and how long it is.
 *
 *   npx tsx tooling/scripts/check-test-env.ts
 */
import { readFileSync } from "node:fs";
import {
  PRODUCTION_PROJECT_REF,
  TEST_PROJECT_REF,
  productionReasons,
  targetsOnlyTestProject,
} from "../../tests/integration/guard-env";

const FILE = ".env.test.local";

/** Blank means "not filled in yet". */
const REQUIRED = [
  "DIRECT_URL",
  "DATABASE_URL",
  "APP_DB_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
] as const;

const OPTIONAL = [
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_REGION",
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
  "APP_ENV",
] as const;

function parse(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, "").trim();
  }
  return out;
}

function main() {
  let env: Record<string, string>;
  try {
    env = parse(FILE);
  } catch {
    console.error(`${FILE} not found. Create it from .env.test.example.`);
    process.exit(1);
  }

  console.log(`${FILE}\n`);
  const missing: string[] = [];
  for (const key of REQUIRED) {
    const v = env[key] ?? "";
    // Length only — never the value. A placeholder left in place is not "set".
    const placeholder = /\[YOUR-PASSWORD\]|^<.*>$/.test(v);
    const ok = v !== "" && !placeholder;
    if (!ok) missing.push(key);
    console.log(
      `  ${ok ? "set  " : "BLANK"}  ${key.padEnd(30)} ${
        ok ? `(${v.length} chars)` : placeholder ? "(placeholder not replaced)" : ""
      }`,
    );
  }
  for (const key of OPTIONAL) {
    const v = env[key] ?? "";
    console.log(`  ${v ? "set  " : "-    "}  ${key.padEnd(30)} ${v && v.length < 60 ? v : ""}`);
  }

  // ── Key sanity: the two API keys are different things ────────────────────
  // A publishable/anon key in the service-role slot passes every "is it set?"
  // check and then fails much later with an opaque permissions error, because
  // it cannot bypass row-level security or reach the admin endpoints.
  const keyProblems: string[] = [];
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const service = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (anon !== "" && service !== "" && anon === service) {
    keyProblems.push(
      "SUPABASE_SERVICE_ROLE_KEY holds the SAME value as NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  if (service !== "" && /^sb_publishable_/.test(service)) {
    keyProblems.push(
      "SUPABASE_SERVICE_ROLE_KEY looks like a publishable key (sb_publishable_...), not a secret one",
    );
  }
  if (anon !== "" && /^sb_secret_/.test(anon)) {
    keyProblems.push(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a SECRET key — that must not be public",
    );
  }
  if (keyProblems.length) {
    console.log("\nAPI key problems:");
    for (const p of keyProblems) console.log(`  - ${p}`);
  }

  console.log("\nproject references found:");
  const target = targetsOnlyTestProject(env);
  if (target.refs.length === 0) console.log("  none yet");
  for (const ref of target.refs) {
    const label =
      ref === TEST_PROJECT_REF
        ? "the test project (idaraworks-test)"
        : ref === PRODUCTION_PROJECT_REF
          ? "PRODUCTION"
          : "an unknown project";
    console.log(`  ${ref}  ->  ${label}`);
  }

  const refusal = productionReasons(env);
  console.log(`\nproduction guard: ${refusal.length ? "WOULD REFUSE" : "would allow"}`);
  for (const r of refusal) console.log(`  - ${r}`);

  console.log(`\npoints only at the test project: ${target.ok ? "yes" : "NO"}`);
  for (const p of target.problems) console.log(`  - ${p}`);

  if (missing.length) {
    console.log(`\nstill to fill: ${missing.join(", ")}`);
  }
  const ready =
    missing.length === 0 && target.ok && refusal.length === 0 && keyProblems.length === 0;
  console.log(`\n${ready ? "READY — migrations and tests can run." : "NOT READY."}`);
  process.exitCode = ready ? 0 : 1;
}

main();
