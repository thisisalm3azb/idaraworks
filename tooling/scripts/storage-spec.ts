/**
 * The bucket spec, in ONE place.
 *
 * Two scripts provision buckets — one for production/hosted (setup-storage.ts,
 * which loads .env.local) and one for the test project (setup-storage-test.ts,
 * which refuses to load or target anything but the test project). They must
 * create identical buckets, or the test environment stops resembling the real
 * one and storage tests prove nothing.
 */
export const BUCKETS = [
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

export type BucketSpec = (typeof BUCKETS)[number];

/** Create or update every bucket to spec. Idempotent. */
export async function provisionBuckets(
  url: string,
  serviceKey: string,
): Promise<Array<{ name: string; action: "created" | "updated" }>> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: existing, error: listError } = await admin.storage.listBuckets();
  if (listError) throw new Error(`listBuckets failed: ${listError.message}`);
  const have = new Set((existing ?? []).map((b) => b.name));

  const done: Array<{ name: string; action: "created" | "updated" }> = [];
  for (const bucket of BUCKETS) {
    const options = {
      public: false,
      fileSizeLimit: bucket.fileSizeLimit,
      allowedMimeTypes: [...bucket.allowedMimeTypes],
    };
    if (have.has(bucket.name)) {
      const { error } = await admin.storage.updateBucket(bucket.name, options);
      if (error) throw new Error(`updateBucket(${bucket.name}) failed: ${error.message}`);
      done.push({ name: bucket.name, action: "updated" });
    } else {
      const { error } = await admin.storage.createBucket(bucket.name, options);
      if (error) throw new Error(`createBucket(${bucket.name}) failed: ${error.message}`);
      done.push({ name: bucket.name, action: "created" });
    }
  }
  return done;
}
