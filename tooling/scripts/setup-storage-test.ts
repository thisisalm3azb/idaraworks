/**
 * Provision storage buckets in the TEST project, and only there.
 *
 * `setup-storage.ts` loads `.env.local`, which is production — correct for the
 * hosted release path, unusable for testing. This loads only the test
 * environment, positively requires the test project reference, and refuses
 * production before it opens a connection. Same bucket spec as production, from
 * the same module, so the two cannot drift apart.
 *
 *   npx tsx tooling/scripts/setup-storage-test.ts
 */
import { config } from "dotenv";

config({ path: [".env.test.local", ".env.test"], quiet: true });

import {
  assertNotProduction,
  targetsOnlyTestProject,
  TEST_PROJECT_REF,
} from "../../tests/integration/guard-env";
import { BUCKETS, provisionBuckets } from "./storage-spec";

async function main() {
  // 1. Never production.
  assertNotProduction();
  // 2. Positively the test project, and nothing else.
  const target = targetsOnlyTestProject();
  if (!target.ok || target.refs.length !== 1 || target.refs[0] !== TEST_PROJECT_REF) {
    console.error("Refusing to provision storage — this is not exclusively the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    console.error(`  refs seen: ${target.refs.join(", ") || "none"}`);
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.test.local",
    );
    process.exit(1);
  }
  // 3. The API URL itself must name the test project — the guard checks the env,
  //    this checks the exact string we are about to send requests to.
  if (!url.includes(TEST_PROJECT_REF)) {
    console.error(`Refusing: NEXT_PUBLIC_SUPABASE_URL does not name ${TEST_PROJECT_REF}`);
    process.exit(1);
  }

  console.log(`provisioning storage in ${TEST_PROJECT_REF}`);
  const done = await provisionBuckets(url, serviceKey);
  for (const d of done) console.log(`  bucket ${d.name}: ${d.action}`);

  // Verify by reading back, rather than trusting the write.
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.storage.listBuckets();
  if (error) throw new Error(`listBuckets failed: ${error.message}`);
  const byName = new Map((data ?? []).map((b) => [b.name, b]));

  console.log("\nverification:");
  let ok = true;
  for (const spec of BUCKETS) {
    const live = byName.get(spec.name) as
      | { public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }
      | undefined;
    if (!live) {
      console.log(`  ${spec.name}: MISSING`);
      ok = false;
      continue;
    }
    const privateOk = live.public === false;
    const sizeOk = Number(live.file_size_limit) === spec.fileSizeLimit;
    const mimeOk =
      JSON.stringify([...(live.allowed_mime_types ?? [])].sort()) ===
      JSON.stringify([...spec.allowedMimeTypes].sort());
    if (!privateOk || !sizeOk || !mimeOk) ok = false;
    console.log(
      `  ${spec.name}: private=${privateOk ? "yes" : "NO"} ` +
        `size=${sizeOk ? `${spec.fileSizeLimit}` : `MISMATCH (${live.file_size_limit})`} ` +
        `mime=${mimeOk ? "as specified" : `MISMATCH (${live.allowed_mime_types})`}`,
    );
  }
  console.log(`\n${ok ? "Storage ready." : "Storage NOT to spec."}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
