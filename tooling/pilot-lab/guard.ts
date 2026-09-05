/**
 * H33 Pilot Lab — the only door to a database.
 *
 * Every tool in this directory calls `loadLabEnv()` before it opens a connection.
 * It does three things, in order, and the order matters:
 *
 *   1. Loads `.env.test.local` (then `.env.test`) EXPLICITLY. Never `.env.local`,
 *      which on this machine holds production. dotenv does not overwrite
 *      variables already present in the process, which is exactly the hole the
 *      next step closes.
 *   2. Reads every connection-bearing variable the process now holds — however
 *      it got there — and refuses unless ALL of them resolve to the isolated
 *      test project and NONE of them mentions production, its hosts, or a
 *      production app URL.
 *   3. Returns the test project ref so callers can print it. A tool that cannot
 *      say which project it is about to change has no business changing one.
 *
 * "Refuse" means throw. There is no override flag: the production simulation
 * factory has one and it lives elsewhere on purpose.
 */
import { config } from "dotenv";

export const TEST_PROJECT_REF = "zwnnqaryouevnzuwtyaj";
export const PRODUCTION_PROJECT_REF = "anhgeeutrwftsvuzfinf";
const PRODUCTION_HOSTS = ["idaraworks.com", "www.idaraworks.com", "idaraworks.vercel.app"];

const CONNECTION_VARS = ["DIRECT_URL", "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;
const URL_VARS = ["APP_URL", "NEXT_PUBLIC_APP_URL"] as const;

/** The Supabase project ref embedded in a pooler DSN or an API URL, if any. */
export function projectRefOf(value: string | undefined): string | null {
  if (!value) return null;
  const pooler = value.match(/postgres\.([a-z0-9]{20}):/);
  if (pooler) return pooler[1]!;
  const api = value.match(/https?:\/\/([a-z0-9]{20})\.supabase\.(co|com)/);
  if (api) return api[1]!;
  const direct = value.match(/db\.([a-z0-9]{20})\.supabase\.(co|com)/);
  if (direct) return direct[1]!;
  return null;
}

export type LabEnv = {
  ref: string;
  directUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

/**
 * Load the test env and prove it is the test project. Throws otherwise.
 *
 * Pure with respect to its inputs when `env` is supplied, so the refusal logic
 * is unit-tested without touching dotenv or a database.
 */
export function assertLabEnv(env: Record<string, string | undefined> = process.env): LabEnv {
  const problems: string[] = [];

  for (const k of CONNECTION_VARS) {
    const v = env[k];
    if (!v) {
      problems.push(`${k} is not set`);
      continue;
    }
    const ref = projectRefOf(v);
    if (ref === PRODUCTION_PROJECT_REF) problems.push(`${k} points at PRODUCTION (${ref})`);
    else if (ref !== TEST_PROJECT_REF)
      problems.push(`${k} does not point at the test project (${ref ?? "no ref found"})`);
  }
  for (const k of URL_VARS) {
    const v = env[k];
    if (v && PRODUCTION_HOSTS.some((h) => v.includes(h)))
      problems.push(`${k} names a production host (${v})`);
  }
  if (env.APP_ENV === "prod") problems.push("APP_ENV is prod");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) problems.push("SUPABASE_SERVICE_ROLE_KEY is not set");
  // Belt and braces: any variable at all that carries the production ref.
  for (const [k, v] of Object.entries(env)) {
    if (
      typeof v === "string" &&
      v.includes(PRODUCTION_PROJECT_REF) &&
      !problems.some((p) => p.startsWith(k))
    ) {
      problems.push(`${k} mentions the production project ref`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `H33 Pilot Lab refuses to run:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `It runs only against the isolated test project ${TEST_PROJECT_REF}.`,
    );
  }
  return {
    ref: TEST_PROJECT_REF,
    directUrl: env.DIRECT_URL!,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

/** Load `.env.test.local` and assert. The one call every tool makes first. */
export function loadLabEnv(): LabEnv {
  config({ path: [".env.test.local", ".env.test"], quiet: true });
  return assertLabEnv();
}
