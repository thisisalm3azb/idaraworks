/**
 * Demo company importer — the ONLY door to production, and it opens for this
 * importer alone.
 *
 * The Pilot Lab's guard (tooling/pilot-lab/guard.ts) refuses production by
 * construction and has no override; nothing here touches it, and nothing in
 * the lab imports this module. This is its mirror image: it loads
 * `.env.local`, POSITIVELY identifies the production project through the same
 * `targetsOnlyProductionProject()` that the H33 residue proof and twenty other
 * production scripts use, and then demands a phrase that names the project by
 * its reference. A missing or wrong phrase refuses — the friction is the point,
 * exactly as it is for the lab cleanup and the production simulation factory.
 *
 * Nothing here prints a credential. The phrase is not a secret; it is a
 * deliberate act.
 */
import { config } from "dotenv";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";
import type { LabEnv } from "../pilot-lab/guard";

export function productionPhrase(ref: string): string {
  return `seed-demo-showcase-into-${ref}`;
}

const REQUIRED = ["DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

/**
 * Load `.env.local` and prove it is production. Throws otherwise, and throws
 * unless `phrase` is exactly the phrase for the project that was found.
 */
export function loadProductionEnv(phrase: string | undefined): LabEnv {
  config({ path: [".env.local", ".env"], quiet: true });
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    throw new Error(`production only:\n${target.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const ref = PRODUCTION_PROJECT_REF;
  const expected = productionPhrase(ref);
  if (phrase !== expected) {
    throw new Error(
      `refusing to touch production without the phrase: pass --production-phrase=${expected}`,
    );
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing in .env.local: ${missing.join(", ")}`);
  return {
    ref,
    directUrl: process.env.DIRECT_URL!,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}
