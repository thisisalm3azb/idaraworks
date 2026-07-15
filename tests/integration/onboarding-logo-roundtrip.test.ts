/**
 * DEFECT 2 — the onboarding logo path END-TO-END against the real DB + storage:
 * stashDraftLogo (branding STEP; re-encodes a real PNG through sharp and stashes
 * ONLY the 512px base64 in the user-scoped draft — NO storage object yet) →
 * runConfirmChain (the explicit confirm) → applyDraftBranding → uploadLogo (the
 * real branding service: re-encode again, store under the NEW org's prefix,
 * insert the READY file row, point org_branding.logo_file_id at it).
 *
 * Also asserts the pre-org SAFETY model the fix relies on:
 *  - the stash writes NO object-storage file before the org exists (the base64
 *    lives in the draft row only);
 *  - a duplicate final confirm is idempotent (same org, one logo file row).
 *
 * Synthetic org only (name prefixed "R2FIX-"); never touches a protected org.
 * Self-cleaning: wipeOrgs + explicit onboarding_draft delete (it is USER-keyed,
 * so wipeOrgs' org_id sweep cannot reach it).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeAppDb, objectStore, type Ctx } from "@/platform/tenancy";
import { getFile } from "@/platform/files";
import {
  DraftDataSchema,
  getDraft,
  runConfirmChain,
  saveDraft,
  stashDraftLogo,
  type DraftData,
} from "@/modules/onboarding/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const orgIds: string[] = [];

function requireStorageEnv(): void {
  for (const k of ["STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"] as const) {
    if (!process.env[k]) {
      throw new Error(
        `${k} is not set — the onboarding logo round-trip needs the storage credential (.env.local).`,
      );
    }
  }
}

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"R2FIX Logo Test"}'::jsonb, now(), now())`;
}

function completeDraftData(name: string): DraftData {
  return DraftDataSchema.parse({
    answers: {
      business_name: name,
      legal_name: `${name} LLC`,
      industry: "field_services",
      business_description: "AC maintenance and repair callouts for villas",
      country: "AE",
      timezone: "Asia/Dubai",
      base_currency: "AED",
      preferred_language: "en",
      employees_band: "6-20",
      users_band: "4-10",
      locations_band: "1",
      departments: ["operations", "field_teams"],
      work_patterns: ["service"],
      work_intake: ["phone_whatsapp"],
      workflow_description: "customer calls, we visit, quote, fix, invoice",
      capabilities: ["quotes", "invoices", "daily_reports"],
      device: "both",
      customer_sharing: true,
      main_problem: "updates scattered across chats",
    },
    template: { selected_key: "service_business_v1", recommended_key: "service_business_v1" },
    tier: { mode: "free" },
    branding: { accent_color: "#0f766e", display_name: name },
  });
}

/** A real transparent PNG a founder might upload (300×120, alpha). */
function realLogoPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 300,
      height: 120,
      channels: 4,
      background: { r: 10, g: 120, b: 110, alpha: 0.6 },
    },
  })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  requireStorageEnv();
  await seedAuthUser(userA, `r2fix-logo-${run}@example.com`);
}, 120_000);

afterAll(async () => {
  await owner`delete from public.onboarding_draft where user_id = ${userA}`;
  await wipeOrgs(owner, orgIds, [userA]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("onboarding logo round-trip (stash → confirm → uploadLogo)", () => {
  it("stashDraftLogo re-encodes to base64 in the draft and writes NO storage object", async () => {
    await saveDraft(userA, { data: completeDraftData(`R2FIX-LOGO-${run}`), step: "branding" });
    await stashDraftLogo(userA, { mime: "image/png", bytes: await realLogoPng() });

    const draft = await getDraft(userA);
    expect(draft!.data.branding.logo_base64).toBeTruthy();
    // The stashed value is a re-encoded PNG (magic bytes), never the raw upload.
    const stashed = Buffer.from(draft!.data.branding.logo_base64!, "base64");
    expect(stashed.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // No org exists yet, so no file row and no storage object could have been created.
    const files = await owner`select id from public.file where created_by = ${userA}`;
    expect(files.length).toBe(0);
  }, 120_000);

  it("confirm applies the branding: org_branding.logo_file_id points at a READY file under the new org", async () => {
    const { orgId } = await runConfirmChain(userA);
    orgIds.push(orgId);

    const [branding] = (await owner`
      select logo_file_id::text as logo_file_id from public.org_branding where org_id = ${orgId}`) as unknown as Array<{
      logo_file_id: string | null;
    }>;
    expect(branding?.logo_file_id).toBeTruthy();
    const fileId = branding!.logo_file_id!;

    const [file] = (await owner`
      select status, org_id::text as org_id, mime, exif_stripped, object_path
      from public.file where id = ${fileId}`) as unknown as Array<{
      status: string;
      org_id: string;
      mime: string;
      exif_stripped: boolean;
      object_path: string;
    }>;
    expect(file!.status).toBe("ready");
    expect(file!.org_id).toBe(orgId);
    expect(file!.mime).toBe("image/png");
    expect(file!.exif_stripped).toBe(true);
    // Stored under the org's OWN prefix.
    expect(file!.object_path.startsWith(`${orgId}/`)).toBe(true);

    // The clean bytes are really in the bucket, resolvable via the org-scoped read.
    const ctx: Ctx = {
      orgId,
      userId: userA,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: "r2fix-logo-verify",
    };
    const resolved = await getFile(ctx, fileId);
    const mainPath = resolved?.variants?.main?.path;
    expect(mainPath).toBeTruthy();
    const stored = await objectStore().get(resolved!.bucket, mainPath!);
    expect(stored).not.toBeNull();

    // The draft is completed and carries the org id.
    const draft = await getDraft(userA);
    expect(draft!.status).toBe("completed");
    expect(draft!.data.confirm.org_id).toBe(orgId);
  }, 120_000);

  it("duplicate confirm is idempotent: same org, exactly one logo file row", async () => {
    const first = await getDraft(userA);
    const { orgId, alreadyCompleted } = await runConfirmChain(userA);
    expect(alreadyCompleted).toBe(true);
    expect(orgId).toBe(first!.data.confirm.org_id);
    const files = (await owner`
      select count(*)::int as n from public.file
      where org_id = ${orgId} and attached_to_type = 'org'`) as unknown as Array<{ n: number }>;
    expect(files[0]!.n).toBe(1);
  }, 120_000);
});
