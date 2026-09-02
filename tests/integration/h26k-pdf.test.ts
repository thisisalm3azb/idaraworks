/**
 * H26K — real PDF bytes from the governed snapshot, rendered through the same
 * functions the download route uses: a %PDF- file with embedded Noto fonts,
 * a multi-page table breaking across pages, the Arabic face present for a
 * bilingual document, a "draft" watermark for a working revision, a stable
 * download filename, and the content hash that the route sends as a header
 * equal to the hash stored with the snapshot.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  embeddedDocumentFonts,
  renderPdf,
  shellIssuerFromIdentity,
  shellIssuerFromSnapshot,
} from "@/platform/documents";
import { getDocumentProfile } from "@/modules/branding/service";
import {
  contentHash,
  createDocument,
  factsOf,
  getDocument,
  getRevision,
  issueDocument,
  renderDocumentHtml,
  resolveValues,
  type RenderInput,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26k",
});

const pagesOf = (pdf: Uint8Array): number => {
  const latin = Buffer.from(pdf).toString("latin1");
  return (latin.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
};
const filenameFor = (reference: string, draft: boolean) =>
  `${reference.replace(/[^A-Za-z0-9._-]/g, "-")}${draft ? "-draft" : ""}.pdf`;

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h26k-owner-${run}@example.invalid`}, '{"full_name":"Owner"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H26K", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26k", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end();
  await closeAppDb();
});

describe("PDF bytes", () => {
  let docId = "";
  const rows = Array.from({ length: 70 }, (_, i) => [
    { en: `Item ${i + 1}`, ar: `بند ${i + 1}` },
    { en: `Description of work package ${i + 1}`, ar: `وصف حزمة العمل ${i + 1}` },
    { en: `${(i + 1) * 125}.00`, ar: `${(i + 1) * 125}.00` },
  ]);

  it("a long bilingual document renders as a multi-page PDF with both fonts embedded", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Schedule ${run}`,
      category: "agreement",
      language: "bilingual",
      body: {
        blocks: [
          {
            id: "h1",
            type: "heading",
            level: 1,
            text: { en: "Schedule of work", ar: "جدول الأعمال" },
          },
          {
            id: "p1",
            type: "paragraph",
            text: { en: "Seventy items follow.", ar: "يلي سبعون بنداً." },
          },
          {
            id: "t1",
            type: "table",
            columns: [
              { en: "Item", ar: "البند" },
              { en: "Description", ar: "الوصف" },
              { en: "Amount", ar: "المبلغ" },
            ],
            rows,
          },
        ],
      },
    });
    docId = d.id;
    await issueDocument(A(), "owner", { documentId: docId });
    const detail = await getDocument(A(), "owner", docId);
    expect(detail.snapshot).not.toBeNull();
    const s = detail.snapshot!.snapshot;
    // The stored hash is the canonical hash of the stored snapshot (what the route sends as x-document-hash).
    expect(detail.snapshot!.contentHash).toBe(contentHash(s));
    const input: RenderInput = {
      language: "bilingual",
      body: s.body,
      settings: s.settings,
      values: s.values,
      issuer: shellIssuerFromSnapshot(s.issuer, null),
      reference: detail.document.reference,
      title: detail.document.title,
      dateText: s.issuedAt.slice(0, 10),
      statusText: "Active",
      revisionText: `Snapshot ${detail.snapshot!.contentHash.slice(0, 12)}`,
      watermark: null,
      accentColor: s.branding.accentColor,
      evidence: { contentHash: detail.snapshot!.contentHash, lines: [`Issued at ${s.issuedAt}`] },
    };
    const html = renderDocumentHtml(input, {
      delivery: "embed",
      embedded: await embeddedDocumentFonts(),
    });
    const pdf = await renderPdf(html, { pageNumbers: true, rtl: true });
    const latin = Buffer.from(pdf).toString("latin1");
    expect(latin.slice(0, 5)).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(20_000);
    expect(pagesOf(pdf)).toBeGreaterThanOrEqual(2);
    expect(latin).toContain("NotoSans");
    expect(latin).toContain("NotoNaskhArabic");
    expect(filenameFor(detail.document.reference, false)).toMatch(/^DOC-\d+\.pdf$/);
  });

  it("a working revision renders as a draft (watermark, draft filename) and a stale hash never leaks as final", async () => {
    const draft = await createDocument(A(), "owner", {
      title: `Draft ${run}`,
      category: "letter",
      language: "en",
      body: {
        blocks: [
          { id: "h1", type: "heading", level: 1, text: { en: "Letter" } },
          { id: "p1", type: "paragraph", text: { en: "Body of the letter." } },
        ],
      },
    });
    const detail = await getDocument(A(), "owner", draft.id);
    const rev = await getRevision(A(), "owner", detail.document.workingRevisionId!);
    const profile = await getDocumentProfile(A());
    const values = await resolveValues(
      A(),
      "owner",
      factsOf(detail.document),
      rev.body,
      rev.variables,
      profile,
    );
    const html = renderDocumentHtml(
      {
        language: "en",
        body: rev.body,
        settings: rev.settings,
        values,
        issuer: shellIssuerFromIdentity(profile.identity, profile.logoDataUri),
        reference: detail.document.reference,
        title: detail.document.title,
        dateText: "2026-09-02",
        statusText: "Draft",
        revisionText: `Revision ${rev.revisionNo}`,
        watermark: "draft",
        accentColor: profile.accentColor,
      },
      { delivery: "embed", embedded: await embeddedDocumentFonts() },
    );
    expect(html.toLowerCase()).toContain("draft");
    const pdf = await renderPdf(html, { pageNumbers: false, rtl: false });
    expect(Buffer.from(pdf).toString("latin1").slice(0, 5)).toBe("%PDF-");
    expect(pagesOf(pdf)).toBe(1);
    expect(filenameFor(detail.document.reference, true)).toMatch(/-draft\.pdf$/);
    expect(detail.snapshot).toBeNull();
  });
});
