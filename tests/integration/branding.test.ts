/**
 * U2 org branding (integration, real DB + real storage) — the 0071 surface
 * end-to-end: catalogue ⇔ DB parity for the honesty REVERSAL (both branding
 * add-ons available again with fresh v2 active price rows), org_branding
 * tenant RLS (org A can never read/write org B's row; DELETE is not granted),
 * the saveBranding/uploadLogo/removeLogo round-trip through the real image
 * pipeline + object store, the display-level feature gates
 * (feat.branding_docs / feat.branding_app), and no-hard-delete on remove.
 * Self-cleaning (wipeOrgs); never touches the protected production orgs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeAppDb, objectStore, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { invalidateEntitlements } from "@/platform/entitlements";
import { getFile } from "@/platform/files";
import {
  BrandingError,
  getAppBranding,
  getBranding,
  getDocBranding,
  getDocumentProfile,
  removeLogo,
  saveBranding,
  saveDocumentIdentity,
  uploadLogo,
} from "@/modules/branding/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "branding-test",
});
const ctxA = () => ctxOf(orgA, userA);
const ctxB = () => ctxOf(orgB, userB);

function requireStorageEnv(): void {
  for (const k of ["STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"] as const) {
    if (!process.env[k]) {
      throw new Error(
        `${k} is not set — the branding upload round-trip needs the storage credential (.env.local).`,
      );
    }
  }
}

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"Branding Test"}'::jsonb, now(), now())`;
}

async function setAddon(orgId: string, key: string, status: string): Promise<void> {
  await owner`select app.set_org_addon(${orgId}::uuid, ${key}, 1, ${status}, null, 'individual')`;
  invalidateEntitlements(orgId);
}

beforeAll(async () => {
  requireStorageEnv();
  await seedAuthUser(userA, `branding-a-${run}@example.com`);
  await seedAuthUser(userB, `branding-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, {
    name: `BRAND-A-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: `BRAND-B-${run}`,
    country: "SA",
    baseCurrency: "SAR",
  });
  // Land both orgs on the FREE base plan so the branding features start OFF and
  // the add-on grant is what turns them on (deterministic gate assertions).
  await owner`update public.org_plan_state set plan_key = 'free', billing_state = 'active'
    where org_id in (${orgA}::uuid, ${orgB}::uuid)`;
  invalidateEntitlements(orgA);
  invalidateEntitlements(orgB);
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("0071 parity: the honesty reversal is live in the DB and matches code", () => {
  it("both branding add-ons are 'available' in addon_def", async () => {
    const rows = (await owner`
      select key, availability from public.addon_def
      where key in ('addon.branding_docs', 'addon.branding_app')
      order by key`) as unknown as Array<{ key: string; availability: string }>;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.availability).toBe("available");
  });

  it("fresh v2 ACTIVE price rows exist (month+year × USD+AED at the owner anchors); v1 rows stay inactive", async () => {
    const expected: Record<string, Record<string, number>> = {
      "addon.branding_docs": {
        "USD:month": 200,
        "USD:year": 2000,
        "AED:month": 800,
        "AED:year": 8000,
      },
      "addon.branding_app": {
        "USD:month": 100,
        "USD:year": 1000,
        "AED:month": 400,
        "AED:year": 4000,
      },
    };
    for (const [key, combos] of Object.entries(expected)) {
      const active = (await owner`
        select currency, billing_interval, unit_amount_minor::int as minor, version, is_placeholder
        from public.addon_price where addon_key = ${key} and active`) as unknown as Array<{
        currency: string;
        billing_interval: string;
        minor: number;
        version: number;
        is_placeholder: boolean;
      }>;
      expect(active.length, `${key} active price rows`).toBe(4);
      for (const row of active) {
        expect(row.minor).toBe(combos[`${row.currency}:${row.billing_interval}`]);
        expect(row.version).toBeGreaterThanOrEqual(2); // fresh rows, never a reactivation
        expect(row.is_placeholder).toBe(true);
      }
      // The 0070-deactivated v1 rows are retained history, still inactive.
      const inactive = (await owner`
        select count(*)::int as n from public.addon_price
        where addon_key = ${key} and not active`) as unknown as Array<{ n: number }>;
      expect(inactive[0]!.n).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("org_branding RLS (tenant isolation + no delete grant)", () => {
  beforeAll(async () => {
    await owner`insert into public.org_branding (org_id, display_name) values (${orgA}, 'Brand A')
      on conflict (org_id) do update set display_name = 'Brand A'`;
    await owner`insert into public.org_branding (org_id, display_name) values (${orgB}, 'Brand B')
      on conflict (org_id) do update set display_name = 'Brand B'`;
  });

  it("org A sees ONLY its own row (org B's row exists but is invisible)", async () => {
    const rows = (await withCtx(ctxA(), (tx) =>
      tx.execute(sql`select org_id::text as org_id, display_name from public.org_branding`),
    )) as unknown as Array<{ org_id: string; display_name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.org_id).toBe(orgA);
    expect(rows[0]!.display_name).toBe("Brand A");
    // getBranding mirrors it (and org B still reads its own).
    expect((await getBranding(ctxA())).displayName).toBe("Brand A");
    expect((await getBranding(ctxB())).displayName).toBe("Brand B");
  });

  it("org A cannot UPDATE org B's row (zero rows hit)", async () => {
    await withCtx(ctxA(), (tx) =>
      tx.execute(
        sql`update public.org_branding set display_name = 'HACKED' where org_id = ${orgB}`,
      ),
    );
    const check = (await owner`
      select display_name from public.org_branding where org_id = ${orgB}`) as unknown as Array<{
      display_name: string;
    }>;
    expect(check[0]!.display_name).toBe("Brand B");
  });

  it("DELETE is not granted to the tenant role (no-hard-delete law)", async () => {
    const outcome = await withCtx(ctxA(), (tx) =>
      tx.execute(sql`delete from public.org_branding where org_id = ${orgA}`),
    ).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({
        ok: false as const,
        code: (e as { cause?: { code?: string } }).cause?.code,
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("42501");
  });
});

describe("saveBranding round-trip + validation", () => {
  it("persists accent/display/footer; empty → null; legal_name is FROZEN (003B.1)", async () => {
    // Seed a legacy legal name and prove saveBranding never touches it again.
    await owner`update public.org_branding set legal_name = 'Legacy Legal LLC'
      where org_id = ${orgA}`;
    await saveBranding(ctxA(), "owner", {
      accentColor: "#0F766E",
      displayName: "Alpha Branding Co",
      footerDetails: "PO Box 1 — TRN 100000000000003",
    });
    const b = await getBranding(ctxA());
    expect(b.accentColor).toBe("#0F766E");
    expect(b.displayName).toBe("Alpha Branding Co");
    expect(b.footerDetails).toContain("TRN");
    expect(b.legalName).toBe("Legacy Legal LLC"); // frozen legacy column untouched
    await saveBranding(ctxA(), "owner", {
      accentColor: "",
      displayName: "Alpha Branding Co",
      footerDetails: "",
    });
    const cleared = await getBranding(ctxA());
    expect(cleared.accentColor).toBeNull();
    expect(cleared.footerDetails).toBeNull();
    expect(cleared.legalName).toBe("Legacy Legal LLC"); // still untouched
  });

  it("rejects a malformed accent colour", async () => {
    await expect(
      saveBranding(ctxA(), "owner", {
        accentColor: "teal",
        displayName: null,
        footerDetails: null,
      }),
    ).rejects.toThrow(BrandingError);
  });
});

describe("uploadLogo → getBranding round-trip (real image pipeline + object store)", () => {
  let fileId = "";

  it("re-encodes, stores, accounts and points org_branding at the READY file row", async () => {
    const bytes = await sharp({
      create: {
        width: 300,
        height: 120,
        channels: 4,
        background: { r: 10, g: 120, b: 110, alpha: 0.6 },
      },
    })
      .png()
      .toBuffer();
    const res = await uploadLogo(ctxA(), "owner", {
      fileName: `logo-${run}.png`,
      mime: "image/png",
      bytes,
    });
    fileId = res.fileId;
    const b = await getBranding(ctxA());
    expect(b.logoFileId).toBe(fileId);
    const file = await getFile(ctxA(), fileId);
    expect(file?.status).toBe("ready");
    expect(file?.exifStripped).toBe(true);
    expect(file?.variants?.main?.mime).toBe("image/png");
    expect(file?.variants?.thumb?.path).toContain(fileId);
    // The clean bytes really are in the bucket under the org's own prefix.
    expect(file!.variants!.main!.path.startsWith(`${orgA}/`)).toBe(true);
    const stored = await objectStore().get(file!.bucket, file!.variants!.main!.path);
    expect(stored).not.toBeNull();
    // Bytes accounted on the org counter.
    const usage = (await owner`
      select bytes_used::int as n from public.org_storage_usage where org_id = ${orgA}`) as unknown as Array<{
      n: number;
    }>;
    expect(usage[0]!.n).toBeGreaterThan(0);
  });

  it("cross-tenant: org B cannot resolve org A's logo file", async () => {
    expect(await getFile(ctxB(), fileId)).toBeNull();
    expect((await getBranding(ctxB())).logoFileId).toBeNull();
  });

  it("rejects fake magic bytes, bad types and tiny images at the service wall", async () => {
    const jpegBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    await expect(
      uploadLogo(ctxA(), "owner", { fileName: "fake.png", mime: "image/png", bytes: jpegBytes }),
    ).rejects.toMatchObject({ code: "bad_signature" });
    await expect(
      uploadLogo(ctxA(), "owner", {
        fileName: "logo.svg",
        mime: "image/svg+xml",
        bytes: Buffer.from("<svg/>"),
      }),
    ).rejects.toMatchObject({ code: "bad_type" });
    const tiny = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    await expect(
      uploadLogo(ctxA(), "owner", { fileName: "tiny.png", mime: "image/png", bytes: tiny }),
    ).rejects.toMatchObject({ code: "too_small_dims" });
  });

  it("003B.1 core identity: document branding resolves on the FREE plan (no add-on)", async () => {
    // Basic document identity is CORE — the onboarding logo + trading name +
    // legacy legal-name fallback all resolve with both features off.
    expect((await getAppBranding(ctxA())).enabled).toBe(false);
    const p = await getDocumentProfile(ctxA());
    expect(p.logoDataUri).toMatch(/^data:image\/png;base64,/);
    expect(p.identity.tradingName).toBe("Alpha Branding Co");
    expect(p.identity.legalName).toBe("Legacy Legal LLC"); // org_branding legacy fallback
    expect(p.advancedStyling).toBe(false);
    expect(p.accentColor).toBeNull(); // accent = advanced styling, gated
    const doc = await getDocBranding(ctxA());
    expect(doc.logoDataUri).toMatch(/^data:image\/png;base64,/);
    expect(doc.displayName).toBe("Alpha Branding Co");
  });

  it("saveDocumentIdentity → default company row; company.legal_name becomes canonical", async () => {
    await saveDocumentIdentity(ctxA(), "owner", {
      legalName: "Alpha Branding LLC",
      taxRegNo: "100000000000003",
      tradeLicenseNo: "CN-1234567",
      addressEn: "Warehouse 4, Industrial Area 2",
      addressAr: "مستودع ٤، المنطقة الصناعية ٢",
      city: "Sharjah",
      region: "Sharjah",
      postalCode: "",
      country: "United Arab Emirates",
      phone: "+971 6 555 0000",
      email: "office@alpha.example",
      website: "www.alpha.example",
      signatoryName: "A. Owner",
      signatoryTitle: "General Manager",
      paymentInstructions: "Bank X — IBAN AE00 0000 0000",
      docLanguage: "bilingual",
    });
    const p = await getDocumentProfile(ctxA());
    expect(p.identity.legalName).toBe("Alpha Branding LLC"); // company beats legacy
    expect(p.identity.trn).toBe("100000000000003"); // the ONLY TRN source
    expect(p.identity.docLanguage).toBe("bilingual");
    expect(p.addressLineEn).toBe(
      "Warehouse 4, Industrial Area 2, Sharjah, Sharjah, United Arab Emirates",
    );
    expect(p.addressLineAr).toContain("مستودع ٤");
    expect(p.addressLineAr).toContain("، "); // Arabic comma joins
  });

  it("rejects an invalid business email at the service wall", async () => {
    await expect(
      saveDocumentIdentity(ctxA(), "owner", {
        legalName: "Alpha Branding LLC",
        taxRegNo: null,
        tradeLicenseNo: null,
        addressEn: null,
        addressAr: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
        phone: null,
        email: "not-an-email",
        website: null,
        signatoryName: null,
        signatoryTitle: null,
        paymentInstructions: null,
        docLanguage: "en",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("cross-tenant isolation: profiles never mix; company rows are RLS-walled", async () => {
    const pb = await getDocumentProfile(ctxB());
    expect(pb.identity.trn).toBeNull();
    expect(pb.identity.legalName).not.toBe("Alpha Branding LLC");
    expect(pb.logoDataUri).toBeNull();
    // Raw wall: ctx B sees only its own company rows…
    const rows = (await withCtx(ctxB(), (tx) =>
      tx.execute(sql`select org_id::text as org_id from public.company`),
    )) as unknown as Array<{ org_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === orgB)).toBe(true);
    // …and cannot update org A's row (zero rows hit).
    await withCtx(ctxB(), (tx) =>
      tx.execute(sql`update public.company set tax_reg_no = 'HACK' where org_id = ${orgA}`),
    );
    const check = (await owner`
      select tax_reg_no from public.company where org_id = ${orgA} and is_default`) as unknown as Array<{
      tax_reg_no: string;
    }>;
    expect(check[0]!.tax_reg_no).toBe("100000000000003");
  });

  it("legacy org compatibility: an org that never saved identity resolves safe fallbacks", async () => {
    const pb = await getDocumentProfile(ctxB());
    expect(pb.identity.legalName.length).toBeGreaterThan(0); // signup-seeded company name
    expect(pb.identity.tradingName).toBe("Brand B");
    expect(pb.identity.docLanguage).toBe("bilingual"); // safe default
    expect(pb.addressLineEn).toBeNull(); // no address parts → null, never ""
  });

  it("gates: feat.branding_app still gates in-app; feat.branding_docs now gates ADVANCED STYLING only", async () => {
    await setAddon(orgA, "addon.branding_docs", "active");
    await setAddon(orgA, "addon.branding_app", "active");
    expect((await getAppBranding(ctxA())).enabled).toBe(true);
    const on = await getDocumentProfile(ctxA());
    expect(on.advancedStyling).toBe(true);
    // Core identity is identical with or without the add-on.
    expect(on.identity.legalName).toBe("Alpha Branding LLC");
    // Org B (no add-on, no logo) still resolves the honest core shape.
    expect((await getDocBranding(ctxB())).logoDataUri).toBeNull();
  });

  it("removeLogo clears the pointer but NEVER deletes the file row", async () => {
    await removeLogo(ctxA(), "owner");
    expect((await getBranding(ctxA())).logoFileId).toBeNull();
    const kept = (await owner`
      select count(*)::int as n from public.file where id = ${fileId} and org_id = ${orgA}`) as unknown as Array<{
      n: number;
    }>;
    expect(kept[0]!.n).toBe(1);
  });
});
