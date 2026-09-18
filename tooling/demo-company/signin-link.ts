/**
 * Demo company importer — a one-time sign-in link for a FICTIONAL persona on
 * the live host, for the verification walk-through only.
 *
 *   npx tsx tooling/demo-company/signin-link.ts <persona> --env=production --production-phrase=... --base=https://www.idaraworks.com
 *
 * Refuses the owner persona: the owner is a real account and signs in through
 * the site's normal flow. Mints a magic link through the Supabase Admin API
 * (no password is known or set) aimed at the app's own /auth/confirm route,
 * which consumes it once. The link is printed with its token — it dies on
 * first use and belongs to a fictional login that can see nothing but the
 * demo company.
 */
import { createClient } from "@supabase/supabase-js";
import { setActiveBrand, personaEmailFor } from "../pilot-lab/brand";
import { DEMO_BRAND } from "./brand";
import { RIMAL } from "./company";
import { loadLabEnv, type LabEnv } from "../pilot-lab/guard";
import { loadProductionEnv } from "./guard";
import { openOwner } from "../pilot-lab/db";
import { findDemoOrg } from "./provision";
import type { PersonaKey } from "../pilot-lab/types";

setActiveBrand(DEMO_BRAND);
const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ENV = (arg("env") ?? "test") as "test" | "production";
const BASE = arg("base") ?? "http://localhost:3000";
const persona = argv.find((a) => !a.startsWith("--")) as PersonaKey | undefined;

function loadEnv(): LabEnv {
  return ENV === "production" ? loadProductionEnv(arg("production-phrase")) : loadLabEnv();
}

async function main() {
  if (!persona || !RIMAL.personas.some((p) => p.key === persona))
    throw new Error(`persona must be one of ${RIMAL.personas.map((p) => p.key).join(", ")}`);
  if (persona === "owner")
    throw new Error(
      "the owner is a real account and signs in through the site — no link is minted for it",
    );
  const env = loadEnv();
  const sql = openOwner(env);
  try {
    const orgId = await findDemoOrg(sql, DEMO_BRAND, RIMAL.key);
    if (!orgId) throw new Error(`${RIMAL.key} is not provisioned in ${ENV}`);
    const email = personaEmailFor(DEMO_BRAND, RIMAL.key, persona);
    const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token)
      throw link.error ?? new Error("could not mint a sign-in link");
    const url =
      `${BASE}/auth/confirm?token_hash=${encodeURIComponent(link.data.properties.hashed_token)}` +
      `&type=magiclink&next=${encodeURIComponent(`/o/${orgId}`)}`;
    console.log(
      `persona ${persona} (${RIMAL.personas.find((p) => p.key === persona)!.fullName}) — org ${orgId}`,
    );
    console.log(url);
  } finally {
    await sql.end();
  }
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
