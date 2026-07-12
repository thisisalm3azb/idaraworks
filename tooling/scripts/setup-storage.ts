/**
 * Hosted bucket setup (S0 checklist §13: "two private buckets; upload size caps").
 * Idempotent — creates or updates `tenant-media` / `tenant-docs` to the spec that
 * config.toml declares for local/CI. Runs with the service-role key, which lives
 * ONLY in .env.local / CI env (checklist §10/§12 — never in app runtime env).
 *
 *   pnpm tsx tooling/scripts/setup-storage.ts
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

const BUCKETS = [
  {
    name: "tenant-media",
    fileSizeLimit: 15 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  {
    name: "tenant-docs",
    fileSizeLimit: 25 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
] as const;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — add them to .env.local (service key: tooling/tests only, never app runtime).",
    );
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: existing, error: listError } = await admin.storage.listBuckets();
  if (listError) throw new Error(`listBuckets failed: ${listError.message}`);
  const have = new Set((existing ?? []).map((b) => b.name));

  for (const bucket of BUCKETS) {
    const options = {
      public: false,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: [...bucket.allowedMimeTypes],
    };
    if (have.has(bucket.name)) {
      const { error } = await admin.storage.updateBucket(bucket.name, options);
      if (error) throw new Error(`updateBucket(${bucket.name}) failed: ${error.message}`);
      console.log(`bucket ${bucket.name}: updated to spec`);
    } else {
      const { error } = await admin.storage.createBucket(bucket.name, options);
      if (error) throw new Error(`createBucket(${bucket.name}) failed: ${error.message}`);
      console.log(`bucket ${bucket.name}: created`);
    }
  }
  console.log("storage setup complete (private buckets, caps, mime allowlists).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
