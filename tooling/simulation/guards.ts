/**
 * Safety guards for the simulation factory. These are refusals, not warnings:
 * the factory will not run against an unknown Supabase project, without the
 * explicit simulation-only confirmation flag, or against an org that does not
 * carry the exact demo marker.
 */
import { EXPECTED_PROJECT_REF } from "./marker";

/** Extract the project-ref subdomain from a Supabase URL (https://<ref>.supabase.co). */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i.exec(url.trim());
  return m ? m[1]! : null;
}

/** Throw unless the configured project matches the one the factory targets. */
export function assertKnownProject(env: Record<string, string | undefined> = process.env): string {
  const ref = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!ref) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is missing or not a Supabase project URL — refusing.",
    );
  }
  if (ref !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `Refusing to run: Supabase project '${ref}' is not the expected simulation project '${EXPECTED_PROJECT_REF}'. Point .env.local at the correct project or update EXPECTED_PROJECT_REF deliberately.`,
    );
  }
  return ref;
}

/** Assert the credentials needed to provision + seed are present (never prints them). */
export function assertRequiredEnv(env: Record<string, string | undefined> = process.env): void {
  const missing = ["DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")} (expected in .env.local).`);
  }
}

export type Flags = {
  confirm: boolean; // --confirm — required to write anything
  dryRun: boolean; // --dry-run — plan + invariants only, no DB writes
  asOf: string | null; // --as-of=YYYY-MM-DD (defaults to today at call site)
  only: string[]; // --only=coffee_catering,palm_farm (subset of scenarios)
  yesReallyCleanup: boolean; // cleanup entry only
};

export function parseFlags(argv: readonly string[]): Flags {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    const eq = hit.indexOf("=");
    return eq === -1 ? "" : hit.slice(eq + 1);
  };
  const asOf = get("as-of");
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`--as-of must be YYYY-MM-DD`);
  return {
    confirm: argv.includes("--confirm"),
    dryRun: argv.includes("--dry-run"),
    asOf: asOf || null,
    only: (get("only") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    yesReallyCleanup: argv.includes("--yes-really-delete-demo-orgs"),
  };
}
