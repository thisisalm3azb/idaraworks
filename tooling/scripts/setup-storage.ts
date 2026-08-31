/**
 * Hosted bucket setup (S0 checklist §13: "two private buckets; upload size caps").
 * Idempotent — creates or updates `tenant-media` / `tenant-docs` to the spec that
 * config.toml declares for local/CI. Runs with the service-role key, which lives
 * ONLY in .env.local / CI env (checklist §10/§12 — never in app runtime env).
 *
 *   pnpm tsx tooling/scripts/setup-storage.ts
 */
import { config } from "dotenv";
import { provisionBuckets } from "./storage-spec";

// NOTE: this loads PRODUCTION credentials. For the test project use
// `tooling/scripts/setup-storage-test.ts`, which loads only .env.test.local and
// refuses any project but the test one. The bucket spec is shared, so the two
// provision identically.
config({ path: ".env.local" });

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — add them to .env.local (service key: tooling/tests only, never app runtime).",
    );
  }
  const done = await provisionBuckets(url, serviceKey);
  for (const d of done) console.log(`bucket ${d.name}: ${d.action}`);
  console.log("storage setup complete (private buckets, caps, mime allowlists).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
