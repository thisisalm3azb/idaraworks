/**
 * The integration suite must never run against production.
 *
 * It used to. `vitest.integration.config.ts` loaded `.env.local`, whose
 * DIRECT_URL points at the same Supabase project that serves www.idaraworks.com,
 * so every local integration run created and deleted organizations in the live
 * database — which is how leaked test organizations ended up there.
 *
 * This module is the gate. It is deliberately pure: it takes an environment
 * snapshot and returns reasons, so the rules can be tested without setting real
 * environment variables or touching a database.
 *
 * The refusal is not advisory. globalSetup calls assertNotProduction() before a
 * single test file is loaded, so a misconfigured run stops before it can write.
 */

/** The Supabase project that serves production. */
export const PRODUCTION_PROJECT_REF = "anhgeeutrwftsvuzfinf";

/**
 * The project the integration suite is meant to use: `idaraworks-test`, a
 * separate free project that exists only to be written to and emptied.
 *
 * Refusing production is the safety floor; naming the intended project lets a
 * run also PROVE it is pointed where it should be, rather than merely "not at
 * production". A third project would pass the refusal but fail the confirmation.
 */
export const TEST_PROJECT_REF = "zwnnqaryouevnzuwtyaj";

/** Hosts that are production, whatever the database says. */
export const PRODUCTION_APP_HOSTS = ["idaraworks.com", "www.idaraworks.com"];

/**
 * Getting past the gate requires this variable set to this exact value. It names
 * the danger in full so it cannot be set absent-mindedly, cannot be copied from
 * a generic example, and is obvious in a shell history or CI log.
 */
export const OVERRIDE_VAR = "I_KNOW_THIS_WRITES_TO_PRODUCTION";
export const OVERRIDE_VALUE = `yes-destroy-${PRODUCTION_PROJECT_REF}`;

export type EnvSnapshot = {
  DIRECT_URL?: string;
  DATABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
  [OVERRIDE_VAR]?: string;
};

/** Every reason this environment looks like production. Empty means it does not. */
export function productionReasons(env: EnvSnapshot): string[] {
  const reasons: string[] = [];
  const ref = PRODUCTION_PROJECT_REF;

  // The project ref appears in the Supabase URL host and, for pooler
  // connections, inside the database username (postgres.<ref>).
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "DIRECT_URL", "DATABASE_URL"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.includes(ref)) {
      reasons.push(`${key} refers to the production project (${ref})`);
    }
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (typeof appUrl === "string" && appUrl.trim() !== "") {
    let host = "";
    try {
      host = new URL(appUrl).host.toLowerCase();
    } catch {
      // A bare host is still worth checking.
      host = appUrl.trim().toLowerCase();
    }
    if (PRODUCTION_APP_HOSTS.includes(host)) {
      reasons.push(`NEXT_PUBLIC_APP_URL is the production application (${host})`);
    }
  }
  return reasons;
}

/**
 * Every Supabase project reference mentioned anywhere in this environment.
 * Reads the URLs textually, because the reference appears in the host of an API
 * URL and inside the USERNAME of a pooler connection string.
 */
export function referencedProjectRefs(env: EnvSnapshot): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== "string") return;
    // <ref>.supabase.co / <ref>.supabase.in
    for (const m of value.matchAll(/\b([a-z]{20})\.supabase\.(?:co|in)\b/g)) found.add(m[1]!);
    // postgres.<ref>@... on Supavisor pooler URLs
    for (const m of value.matchAll(/postgres\.([a-z]{20})\b/g)) found.add(m[1]!);
  };
  add(env.NEXT_PUBLIC_SUPABASE_URL);
  add(env.DIRECT_URL);
  add(env.DATABASE_URL);
  return [...found];
}

/**
 * Confirms this environment points at the intended test project and nothing
 * else. Used before migrating or seeding, so a half-filled file cannot send
 * migrations to one project and tests to another.
 */
export function targetsOnlyTestProject(env: EnvSnapshot = process.env as EnvSnapshot): {
  ok: boolean;
  refs: string[];
  problems: string[];
} {
  const refs = referencedProjectRefs(env);
  const problems: string[] = [];
  if (refs.length === 0) {
    problems.push("no Supabase project reference found in any URL — is the file filled in?");
  }
  for (const ref of refs) {
    if (ref === PRODUCTION_PROJECT_REF) problems.push(`${ref} is PRODUCTION`);
    else if (ref !== TEST_PROJECT_REF)
      problems.push(`${ref} is neither the test project nor production`);
  }
  if (refs.length > 1) {
    problems.push(`more than one project referenced: ${refs.join(", ")}`);
  }
  return { ok: problems.length === 0, refs, problems };
}

export class ProductionDatabaseRefusal extends Error {
  constructor(public readonly reasons: string[]) {
    super(
      [
        "Refusing to run the integration suite against PRODUCTION.",
        ...reasons.map((r) => `  - ${r}`),
        "",
        "The integration suite creates and deletes organizations, users and records.",
        "Point it at a database you can afford to lose:",
        "",
        "  local stack   supabase start   then   npm run test:integration",
        "  own project   put its credentials in .env.test.local",
        "",
        "See docs/TEST-ENVIRONMENTS.md.",
      ].join("\n"),
    );
    this.name = "ProductionDatabaseRefusal";
  }
}

/**
 * Throws unless this environment is safe to write to. The override exists for
 * one legitimate case — a deliberate, supervised production smoke check — and
 * demands an exact phrase naming the project it will write to.
 */
export function assertNotProduction(env: EnvSnapshot = process.env as EnvSnapshot): void {
  const reasons = productionReasons(env);
  if (reasons.length === 0) return;
  if (env[OVERRIDE_VAR] === OVERRIDE_VALUE) {
    console.warn(
      `\n!! ${OVERRIDE_VAR} is set: writing to PRODUCTION on purpose.\n` +
        reasons.map((r) => `   ${r}`).join("\n") +
        "\n",
    );
    return;
  }
  throw new ProductionDatabaseRefusal(reasons);
}
