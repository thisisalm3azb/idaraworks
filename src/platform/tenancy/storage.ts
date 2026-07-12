/**
 * Storage clients — constructed here and nowhere else (boundary law, phase2/10 #1, #3).
 *
 * Two clients, two trust levels:
 *
 * 1. userStorage(accessToken) — the USER path. Anon key + the requesting user's
 *    session JWT; every signed upload/read URL is authorized by the
 *    storage.objects RLS policies (0008) as that user. No privileged key exists
 *    in this path — checklist §10 (service-role never in app runtime) holds.
 *
 * 2. objectStore() — the PLATFORM-TASK path (BUILD_BIBLE §5.2): the derivative
 *    worker and the nightly reconcile use a storage-scoped S3 credential
 *    (Supabase Storage S3 protocol). Its blast radius is storage only — it can
 *    never touch the database. It bypasses storage RLS by design; the worker
 *    harness's org re-verification (doc 10 #9) is the guard on the paths it acts on.
 */
import { createClient } from "@supabase/supabase-js";
import { AwsClient } from "aws4fetch";

export class StorageEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageEnvError";
  }
}

function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new StorageEnvError("NEXT_PUBLIC_SUPABASE_URL is not set.");
  return url.replace(/\/$/, "");
}

/** Storage API surface bound to a user's JWT — RLS-authorized signing only. */
export function userStorage(accessToken: string) {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new StorageEnvError("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.");
  const client = createClient(supabaseUrl(), anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  return client.storage;
}

// ── S3 object store (worker/platform-task credential) ───────────────────────

export type StoredObject = { path: string; bytes: number };

function s3Env(): { endpoint: string; client: AwsClient } {
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new StorageEnvError(
      "STORAGE_S3_ACCESS_KEY_ID / STORAGE_S3_SECRET_ACCESS_KEY are not set (worker storage credential).",
    );
  }
  const endpoint =
    process.env.STORAGE_S3_ENDPOINT?.replace(/\/$/, "") ?? `${supabaseUrl()}/storage/v1/s3`;
  const region = process.env.STORAGE_S3_REGION ?? "ap-northeast-2";
  return {
    endpoint,
    client: new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" }),
  };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Unescape the five XML entities S3 list responses may contain. Our keys are
 * uuid/registry-token segments, so this covers the full space they can emit. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function objectStore() {
  const { endpoint, client } = s3Env();

  async function get(bucket: string, path: string): Promise<Buffer | null> {
    const res = await client.fetch(`${endpoint}/${bucket}/${encodePath(path)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage get failed (${res.status}) for ${bucket}/${path}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function put(
    bucket: string,
    path: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const res = await client.fetch(`${endpoint}/${bucket}/${encodePath(path)}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`storage put failed (${res.status}) for ${bucket}/${path}`);
  }

  async function del(bucket: string, path: string): Promise<void> {
    const res = await client.fetch(`${endpoint}/${bucket}/${encodePath(path)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`storage delete failed (${res.status}) for ${bucket}/${path}`);
    }
  }

  /** Recursive listing under a prefix (ListObjectsV2, paginated). */
  async function list(bucket: string, prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
      if (token) params.set("continuation-token", token);
      const res = await client.fetch(`${endpoint}/${bucket}?${params}`);
      if (!res.ok) throw new Error(`storage list failed (${res.status}) for ${bucket}/${prefix}`);
      const xml = await res.text();
      // Keys are uuid/registry-token paths built by paths.ts (no exotic chars);
      // sizes are plain integers — a scoped regex parse is safe here.
      for (const m of xml.matchAll(
        /<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
      )) {
        objects.push({ path: xmlUnescape(m[1]!), bytes: Number(m[2]!) });
      }
      const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
      token = next ? xmlUnescape(next[1]!) : undefined;
    } while (token);
    return objects;
  }

  /** Top-level folder names (org ids) present in a bucket. */
  async function listTopLevelPrefixes(bucket: string): Promise<string[]> {
    const prefixes = new Set<string>();
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ "list-type": "2", delimiter: "/", "max-keys": "1000" });
      if (token) params.set("continuation-token", token);
      const res = await client.fetch(`${endpoint}/${bucket}?${params}`);
      if (!res.ok) throw new Error(`storage prefix list failed (${res.status}) for ${bucket}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Prefix>([\s\S]*?)\/<\/Prefix>/g)) {
        if (m[1]) prefixes.add(xmlUnescape(m[1]));
      }
      const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
      token = next ? xmlUnescape(next[1]!) : undefined;
    } while (token);
    return [...prefixes];
  }

  return { get, put, del, list, listTopLevelPrefixes };
}

export type ObjectStore = ReturnType<typeof objectStore>;
