/**
 * Files & storage integration (Phase E; S0 checklist §6/§9/§15 "Storage" AC):
 * the REAL flow against real storage — sign (class+quota gated) → PUT the
 * GPS-tagged fixture through the signed URL → run the derivative pipeline →
 * EXIF gone, variants exist, bytes accounted transactionally → signed reads per
 * class → the DB wall (storage RLS) blocks forged direct-API access →
 * void/legal-hold → reconcile true-up + stale sweep.
 *
 * Requires (fail-loud, never silent-skip): SUPABASE_SERVICE_ROLE_KEY (create
 * test users with sessions), STORAGE_S3_* (worker credential), NEXT_PUBLIC_*.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, objectStore, userStorage, type Ctx } from "@/platform/tenancy";
import {
  confirmUpload,
  FilesError,
  getFile,
  getStorageUsage,
  signRead,
  signUpload,
  setLegalHold,
  voidFile,
  buildObjectPath,
} from "@/platform/files";
import { deriveImageVariants, reconcileOrg } from "@/workers";
import { getLimit } from "@/platform/entitlements";
import { createOrgForUser, inviteMember, acceptInvite } from "@/platform/auth/identity";
import { buildGpsJpeg, hasGps, hasExif } from "../fixtures/gps-jpeg";
import { ownerSql } from "./helpers";

function requireStorageEnv(): { url: string; anonKey: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  for (const [k, v] of [
    ["NEXT_PUBLIC_SUPABASE_URL", url],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", serviceKey],
    ["STORAGE_S3_ACCESS_KEY_ID", process.env.STORAGE_S3_ACCESS_KEY_ID],
    ["STORAGE_S3_SECRET_ACCESS_KEY", process.env.STORAGE_S3_SECRET_ACCESS_KEY],
  ] as const) {
    if (!v) {
      throw new Error(
        `${k} is not set — Phase E storage tests need it (.env.local; see .env.example).`,
      );
    }
  }
  return { url: url!, anonKey: anonKey!, serviceKey: serviceKey! };
}

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
let orgA = "";
let orgB = "";

type TestUser = { id: string; email: string; token: string };
const u: Record<"ownerA" | "foreman" | "viewer" | "ownerB", TestUser> = {} as never;

async function createSessionUser(name: string): Promise<TestUser> {
  const { url, anonKey, serviceKey } = requireStorageEnv();
  const email = `files-${name}-${run}@example.com`;
  const password = `pw-${randomUUID()}`;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${name}) failed: ${error?.message}`);
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !session.session) {
    throw new Error(`signIn(${name}) failed: ${signInError?.message}`);
  }
  return { id: data.user.id, email, token: session.session.access_token };
}

const ctxOf = (orgId: string, user: TestUser): Ctx => ({
  orgId,
  userId: user.id,
  costPrivileged: false,
  // owners are price-privileged (finance.viewPrices) — mirrors role_definition.
  pricePrivileged: user === u.ownerA || user === u.ownerB,
  requestId: "files-test",
});

const attach = { attachedToType: "daily_report", attachedToId: randomUUID() };

beforeAll(async () => {
  requireStorageEnv();
  u.ownerA = await createSessionUser("owner-a");
  u.foreman = await createSessionUser("foreman");
  u.viewer = await createSessionUser("viewer");
  u.ownerB = await createSessionUser("owner-b");
  orgA = await createOrgForUser(u.ownerA.id, {
    name: "Files A",
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(u.ownerB.id, {
    name: "Files B",
    country: "SA",
    baseCurrency: "SAR",
  });
  for (const [user, roleKey] of [
    [u.foreman, "foreman"],
    [u.viewer, "viewer"],
  ] as const) {
    const { token } = await inviteMember(ctxOf(orgA, u.ownerA), "owner", {
      email: user.email,
      roleKey,
    });
    await acceptInvite(user.id, token);
  }
}, 120_000);

afterAll(async () => {
  const store = objectStore();
  for (const org of [orgA, orgB].filter(Boolean)) {
    for (const bucket of ["tenant-media", "tenant-docs"] as const) {
      for (const obj of await store.list(bucket, `${org}/`)) {
        await store.del(bucket, obj.path);
      }
    }
    await owner`delete from public.file where org_id = ${org}`;
    await owner`delete from public.org_storage_usage where org_id = ${org}`;
    await owner`delete from public.audit_log where org_id = ${org}`;
    await owner`delete from public.org_plan_state where org_id = ${org}`;
    await owner`delete from public.membership_invite where org_id = ${org}`;
    await owner`delete from public.membership where org_id = ${org}`;
    await owner`delete from public.role_definition where org_id = ${org}`;
    await owner`delete from public.company where org_id = ${org}`;
    await owner`delete from public.org where id = ${org}`;
  }
  const ids = Object.values(u).map((x) => x.id);
  await owner`delete from public.user_profile where id = any(${ids}::uuid[])`;
  await owner`delete from auth.users where id = any(${ids}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

/** Upload the bytes through the signed upload URL using the SDK (canonical path). */
async function uploadVia(
  signed: { bucket: string; objectPath: string; token: string },
  token: string,
  bytes: Buffer,
  mime: string,
): Promise<void> {
  const { error } = await userStorage(token)
    .from(signed.bucket)
    .uploadToSignedUrl(signed.objectPath, signed.token, new Uint8Array(bytes), {
      contentType: mime,
    });
  if (error) throw new Error(`uploadToSignedUrl failed: ${error.message}`);
}

let jobMediaFileId = "";
let financialFileId = "";

describe("upload → pipeline → read (the full loop, VC-4's hosted half)", () => {
  it("foreman signs + uploads job_media; the pipeline strips EXIF and derives variants", async () => {
    const fixture = await buildGpsJpeg(2400, 1800);
    expect(await hasGps(fixture)).toBe(true);

    const signed = await signUpload(ctxOf(orgA, u.foreman), "foreman", u.foreman.token, {
      accessClass: "job_media",
      ...attach,
      fileName: "hull-photo.jpg",
      mime: "image/jpeg",
      sizeBytes: fixture.length,
    });
    jobMediaFileId = signed.fileId;
    expect(signed.quota.warn).toBe(false);

    await uploadVia(signed, u.foreman.token, fixture, "image/jpeg");

    // confirm (event transport injected — the real send needs an Inngest server)
    let published = 0;
    await confirmUpload(ctxOf(orgA, u.foreman), signed.fileId, async () => {
      published += 1;
    });
    expect(published).toBe(1);

    // Run the worker's exact code path (payload + already-verified ctx).
    const result = await deriveImageVariants(
      { orgId: orgA, fileId: signed.fileId, actorUserId: u.foreman.id },
      ctxOf(orgA, u.foreman),
    );
    expect(result.outcome).toBe("ready");

    const file = await getFile(ctxOf(orgA, u.foreman), signed.fileId);
    expect(file!.status).toBe("ready");
    expect(file!.exifStripped).toBe(true);
    expect(file!.bytes).toBeGreaterThan(0);
    expect(file!.variants?.main && file!.variants.medium && file!.variants.thumb).toBeTruthy();

    // EXIF/GPS gone from every stored variant (downloaded from REAL storage).
    const store = objectStore();
    for (const variant of ["main", "medium", "thumb"] as const) {
      const stored = await store.get("tenant-media", file!.variants![variant]!.path);
      expect(stored, `${variant} object missing`).not.toBeNull();
      expect(await hasGps(stored!), `GPS survived in ${variant}`).toBe(false);
      expect(await hasExif(stored!), `EXIF survived in ${variant}`).toBe(false);
    }

    // job_media: the EXIF-bearing original is GONE from the bucket.
    expect(await store.get("tenant-media", signed.objectPath)).toBeNull();

    // Accounting: counter == file bytes, in the same transaction as the flip.
    const usage = await getStorageUsage(ctxOf(orgA, u.ownerA));
    expect(usage.bytesUsed).toBe(file!.bytes);

    // Idempotency: a duplicate delivery is a no-op (no double count).
    const dup = await deriveImageVariants(
      { orgId: orgA, fileId: signed.fileId, actorUserId: u.foreman.id },
      ctxOf(orgA, u.foreman),
    );
    expect(dup.outcome).toBe("skipped");
    expect((await getStorageUsage(ctxOf(orgA, u.ownerA))).bytesUsed).toBe(file!.bytes);
  }, 120_000);

  it("financial_doc keeps the original (evidence) alongside clean variants", async () => {
    const fixture = await buildGpsJpeg(1200, 900);
    const signed = await signUpload(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, {
      accessClass: "financial_doc",
      ...attach,
      fileName: "receipt.jpg",
      mime: "image/jpeg",
      sizeBytes: fixture.length,
    });
    financialFileId = signed.fileId;
    await uploadVia(signed, u.ownerA.token, fixture, "image/jpeg");
    const result = await deriveImageVariants(
      { orgId: orgA, fileId: signed.fileId, actorUserId: u.ownerA.id },
      ctxOf(orgA, u.ownerA),
    );
    expect(result.outcome).toBe("ready");
    const store = objectStore();
    const original = await store.get("tenant-docs", signed.objectPath);
    expect(original).not.toBeNull(); // retained
    const file = await getFile(ctxOf(orgA, u.ownerA), signed.fileId);
    expect(file!.variants?.original?.path).toBe(signed.objectPath);
    // clean main exists and is stripped
    const main = await store.get("tenant-docs", file!.variants!.main!.path);
    expect(await hasGps(main!)).toBe(false);
  }, 120_000);

  it("signed reads: allowed classes resolve to fetchable URLs with correct TTL tiers", async () => {
    const read = await signRead(
      ctxOf(orgA, u.viewer),
      "viewer",
      u.viewer.token,
      jobMediaFileId,
      "thumb",
    );
    expect(read.expiresIn).toBe(3600);
    const img = await fetch(read.url);
    expect(img.status).toBe(200);
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const medium = await signRead(
      ctxOf(orgA, u.foreman),
      "foreman",
      u.foreman.token,
      jobMediaFileId,
      "medium",
    );
    expect(medium.expiresIn).toBe(300);
  });
});

describe("class-map denials (doc 06; deny-by-default)", () => {
  it("viewer cannot upload job_media; foreman cannot touch financial_doc or hr_doc", async () => {
    const base = { ...attach, fileName: "x.jpg", mime: "image/jpeg", sizeBytes: 1000 };
    await expect(
      signUpload(ctxOf(orgA, u.viewer), "viewer", u.viewer.token, {
        accessClass: "job_media",
        ...base,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      signUpload(ctxOf(orgA, u.foreman), "foreman", u.foreman.token, {
        accessClass: "financial_doc",
        ...base,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      signRead(ctxOf(orgA, u.foreman), "foreman", u.foreman.token, financialFileId),
    ).rejects.toThrow(/not found/); // denial reads as absence — no metadata leak
  });

  it("customer_share has no member upload path", async () => {
    await expect(
      signUpload(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, {
        accessClass: "customer_share",
        ...attach,
        fileName: "x.jpg",
        mime: "image/jpeg",
        sizeBytes: 1000,
      }),
    ).rejects.toThrow(/no member upload path/);
  });

  it("mimes outside the S0 allowlist are refused (documents land S4)", async () => {
    await expect(
      signUpload(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, {
        accessClass: "financial_doc",
        ...attach,
        fileName: "invoice.pdf",
        mime: "application/pdf",
        sizeBytes: 1000,
      }),
    ).rejects.toThrow();
  });
});

describe("the DB wall: storage RLS blocks forged direct-API access", () => {
  it("a viewer's own JWT cannot mint a financial_doc read straight at the storage API", async () => {
    const file = await getFile(ctxOf(orgA, u.ownerA), financialFileId);
    const { data, error } = await userStorage(u.viewer.token)
      .from("tenant-docs")
      .createSignedUrl(file!.variants!.main!.path, 60);
    expect(data).toBeNull();
    expect(error).not.toBeNull(); // Postgres said no, not our service layer
  });

  it("org B's owner cannot mint an upload into org A's prefix", async () => {
    const path = buildObjectPath({
      orgId: orgA, // forged cross-tenant target
      accessClass: "job_media",
      attachedToType: "daily_report",
      attachedToId: randomUUID(),
      fileId: randomUUID(),
      ext: "jpg",
      variant: "orig",
    });
    const { data, error } = await userStorage(u.ownerB.token)
      .from("tenant-media")
      .createSignedUploadUrl(path);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("org B cannot see org A's file rows (metadata isolation)", async () => {
    expect(await getFile(ctxOf(orgB, u.ownerB), jobMediaFileId)).toBeNull();
    await expect(
      voidFile(ctxOf(orgB, u.ownerB), "owner", jobMediaFileId, "cross-tenant attempt"),
    ).rejects.toThrow(/not found/);
  });
});

describe("quota (doc 10 #39: warn 80, block adds at 100, NEVER reads — FR-9)", () => {
  it("warns at ≥80%, blocks at 100%, and reads keep working while blocked", async () => {
    const limitGb = await getLimit(ctxOf(orgA, u.ownerA), "limit.storage_gb");
    expect(limitGb).not.toBeNull(); // growth placeholder must be finite for this test
    const limitBytes = limitGb! * 1024 ** 3;

    const [before] = await owner`
      select bytes_used from public.org_storage_usage where org_id = ${orgA}`;
    const realUsage = Number(before!.bytes_used);

    await owner`update public.org_storage_usage
      set bytes_used = ${Math.ceil(limitBytes * 0.85)} where org_id = ${orgA}`;
    const warned = await signUpload(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, {
      accessClass: "job_media",
      ...attach,
      fileName: "warn.jpg",
      mime: "image/jpeg",
      sizeBytes: 1000,
    });
    expect(warned.quota.warn).toBe(true);
    await owner`delete from public.file where id = ${warned.fileId}`; // tidy pending row

    await owner`update public.org_storage_usage
      set bytes_used = ${limitBytes} where org_id = ${orgA}`;
    await expect(
      signUpload(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, {
        accessClass: "job_media",
        ...attach,
        fileName: "blocked.jpg",
        mime: "image/jpeg",
        sizeBytes: 1000,
      }),
    ).rejects.toThrow(FilesError);

    // Reads still served at 100% — the law that never bends.
    const read = await signRead(
      ctxOf(orgA, u.viewer),
      "viewer",
      u.viewer.token,
      jobMediaFileId,
      "thumb",
    );
    expect(read.url).toContain("token=");

    await owner`update public.org_storage_usage
      set bytes_used = ${realUsage} where org_id = ${orgA}`;
  });
});

describe("void + legal hold (D-1.7 foundations, audited)", () => {
  it("legal hold blocks void; releasing it allows void, which frees quota", async () => {
    await setLegalHold(ctxOf(orgA, u.ownerA), "owner", financialFileId, true);
    await expect(
      voidFile(ctxOf(orgA, u.ownerA), "owner", financialFileId, "should be blocked"),
    ).rejects.toThrow(/legal hold/);

    const usageBefore = (await getStorageUsage(ctxOf(orgA, u.ownerA))).bytesUsed;
    const file = await getFile(ctxOf(orgA, u.ownerA), financialFileId);

    await setLegalHold(ctxOf(orgA, u.ownerA), "owner", financialFileId, false);
    await voidFile(ctxOf(orgA, u.ownerA), "owner", financialFileId, "test cleanup");

    const after = await getFile(ctxOf(orgA, u.ownerA), financialFileId);
    expect(after!.voidedAt).not.toBeNull();
    expect((await getStorageUsage(ctxOf(orgA, u.ownerA))).bytesUsed).toBe(
      usageBefore - file!.bytes!,
    );

    await expect(
      voidFile(ctxOf(orgA, u.ownerA), "owner", financialFileId, "twice"),
    ).rejects.toThrow(/already voided/);

    const audits = await owner`
      select action from public.audit_log where org_id = ${orgA} and entity_id = ${financialFileId}
      order by created_at`;
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("file.legal_hold.set");
    expect(actions).toContain("file.legal_hold.clear");
    expect(actions).toContain("file.void");

    // Voided files no longer serve reads.
    await expect(
      signRead(ctxOf(orgA, u.ownerA), "owner", u.ownerA.token, financialFileId),
    ).rejects.toThrow(/voided/);
  });
});

describe("reconcile (doc 10 #39; audit F-36)", () => {
  it("trues the counter up to file-row truth and sweeps stale pendings", async () => {
    // Tamper the counter (simulates a crash between flip and accounting)…
    await owner`update public.org_storage_usage set bytes_used = 999999999 where org_id = ${orgA}`;
    // …and plant a stale pending row (upload that never completed).
    const staleId = randomUUID();
    const stalePath = buildObjectPath({
      orgId: orgA,
      accessClass: "job_media",
      attachedToType: "daily_report",
      attachedToId: randomUUID(),
      fileId: staleId,
      ext: "jpg",
      variant: "orig",
    });
    await owner`
      insert into public.file (id, org_id, access_class, attached_to_type, attached_to_id,
                               bucket, object_path, original_name, mime, created_by, created_at)
      values (${staleId}, ${orgA}, 'job_media', 'daily_report', ${randomUUID()},
              'tenant-media', ${stalePath}, 'stale.jpg', 'image/jpeg', ${u.ownerA.id},
              now() - interval '25 hours')`;

    const result = await reconcileOrg(orgA, "itest-reconcile");
    expect(result.staleFailed).toBeGreaterThanOrEqual(1);
    expect(result.previousCounter).toBe(999999999);
    expect(result.drift).toBe(true); // the tamper was detected

    const [stale] = await owner`select status from public.file where id = ${staleId}`;
    expect(stale!.status).toBe("failed");

    // Counter now equals live file-row truth exactly.
    const [counter] = await owner`
      select bytes_used, reconciled_at from public.org_storage_usage where org_id = ${orgA}`;
    expect(Number(counter!.bytes_used)).toBe(result.fileBytes);
    expect(counter!.reconciled_at).not.toBeNull();

    // A second run reports no drift — voided-but-unpurged objects (from the
    // void test above) are EXPECTED residue, not orphans (0010).
    const clean = await reconcileOrg(orgA, "itest-reconcile-2");
    expect(clean.drift).toBe(false);
    expect(clean.orphanKeys).toBe(0);
  }, 120_000);

  it("detects a TRUE orphan — an object with no owning file row (CM4 leak detector)", async () => {
    // Plant an object directly via the worker S3 credential (bypasses RLS) at a
    // conforming path with NO file row — exactly what a bypassed upload would
    // leave. The detector must flag it.
    const store = objectStore();
    const orphanPath = buildObjectPath({
      orgId: orgA,
      accessClass: "job_media",
      attachedToType: "daily_report",
      attachedToId: randomUUID(),
      fileId: randomUUID(),
      ext: "jpg",
    });
    await store.put("tenant-media", orphanPath, await buildGpsJpeg(200, 200), "image/jpeg");
    try {
      const r = await reconcileOrg(orgA, "itest-orphan");
      expect(r.orphanKeys).toBeGreaterThanOrEqual(1);
      expect(r.drift).toBe(true);
    } finally {
      await store.del("tenant-media", orphanPath);
    }
  }, 120_000);
});
