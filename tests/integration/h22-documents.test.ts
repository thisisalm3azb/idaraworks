/**
 * H22.0 — the document foundation, against a real database.
 *
 * The properties that matter for a document a customer receives: it belongs to
 * one organization and no other, an issued copy keeps the identity it was issued
 * under however the company later changes, and every surface that can produce it
 * agrees on what it says.
 */
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import { createCustomer } from "@/modules/masters/service";
import { createQuote } from "@/modules/quotes/service";
import { createJobFromPreset, listActivePresets, createTask } from "@/modules/jobs/service";
import {
  documentModel,
  documentHtml,
  DocumentNotShareableError,
  createDocumentShare,
  revokeDocumentShare,
  listDocumentShares,
  resolveDocumentShare,
  captureDocumentIssuerIn,
} from "@/modules/documents/service";
import {
  createWeekPlan,
  setWeekPlanJobs,
  issueWeekPlan,
  reviseWeekPlan,
  getWeekPlan,
  updateWeekPlan,
  WeekPlanImmutableError,
} from "@/modules/documents/week-plan";
import {
  renderDocument,
  renderPdf,
  closePdfBrowser,
  embeddedDocumentFonts,
} from "@/platform/documents";
import { ForbiddenError } from "@/platform/authz";
import { withCtx, sql } from "@/platform/tenancy";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let quoteA = "";
let planA = "";
let jobA = "";

/** A share token pair, for writing a row the minting path would have refused. */
function shareTokenFor(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22-test",
});

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22-${label}-${run}@example.com`}, '{"full_name":"H22 Test"}'::jsonb, now(), now())`;
}

/** Give the org a full document identity, so the header has something to show. */
async function setIdentity(orgId: string, legalName: string) {
  await owner`
    update public.company set
      legal_name = ${legalName}, tax_reg_no = '100123456700003', trade_license_no = 'CN-42',
      address_en = 'Plot 42, Industrial Area 3', address_ar = 'قطعة ٤٢، المنطقة الصناعية ٣',
      city = 'Sharjah', country = 'United Arab Emirates', phone = '+971 6 555 0100',
      email = 'accounts@example.com', website = 'example.com',
      signatory_name = 'A. Alqubaisi', signatory_title = 'Managing Director',
      payment_instructions = 'Bank: ENBD', doc_language = 'bilingual'
    where org_id = ${orgId} and is_default`;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H22 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H22 B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22-documents", run);
  await markFixtureOrg(owner, orgB, "h22-documents", run);
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  await installTemplate(ctxOf(orgB, userB), "generic_operations_v1");
  await setIdentity(orgA, "Najolatech Marine LLC");

  const cust = await createCustomer(ctxOf(orgA, userA), "owner", { name: "Gulf Marine Services" });
  const preset = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!;
  const q = await createQuote(ctxOf(orgA, userA), "owner", {
    customerId: cust.id,
    presetId: preset.id,
    lines: [
      { description: "24ft Catamaran hull", qty: 1, unit: "unit", unitPriceMinor: 12_000_000 },
      { description: "Rigging and fit-out", qty: 2, unit: "lot", unitPriceMinor: 2_500_000 },
    ],
  });
  quoteA = q.id;

  const job = await createJobFromPreset(ctxOf(orgA, userA), "owner", {
    presetId: preset.id,
    name: "Hull 24C-001",
  });
  jobA = job.id;
  await createTask(ctxOf(orgA, userA), "owner", { jobId: jobA, title: "Laminate the hull" });
  await createTask(ctxOf(orgA, userA), "owner", { jobId: jobA, title: "Fit the console" });
}, 300_000);

afterAll(async () => {
  await closePdfBrowser();
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("H22.0 — a document belongs to one organization", () => {
  it("organization B cannot render organization A's quotation", { timeout: 120_000 }, async () => {
    await expect(
      documentModel(ctxOf(orgB, userB), "owner", {
        kind: "quote",
        id: quoteA,
        language: "en",
      }),
    ).rejects.toThrow();
  });

  it("a role without the record's view permission is refused", { timeout: 120_000 }, async () => {
    // A foreman may see work, not quotations. The document inherits the record's
    // permission rather than inventing a weaker one of its own.
    await expect(
      documentModel(ctxOf(orgA, userA), "foreman", {
        kind: "quote",
        id: quoteA,
        language: "en",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("H22.0 — an issued document keeps the identity it was issued under", () => {
  it(
    "the snapshot survives a later change of legal name, address and tax number",
    { timeout: 180_000 },
    async () => {
      // Issue: capture the identity as it stands now.
      await withCtx(ctxOf(orgA, userA), async (tx) => {
        await tx.execute(sql`
          update public.quote set status = 'sent' where id = ${quoteA} and org_id = ${orgA}
        `);
        await captureDocumentIssuerIn(tx, ctxOf(orgA, userA), "quote", quoteA);
      });
      const beforeHtml = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id: quoteA,
        language: "en",
      });
      expect(beforeHtml).toContain("Najolatech Marine LLC");

      // The company rebrands, moves and re-registers.
      await setIdentity(orgA, "Completely Different Holdings LLC");
      await owner`
        update public.company set address_en = 'Somewhere else entirely', tax_reg_no = '999999999999999'
        where org_id = ${orgA} and is_default`;

      const afterHtml = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id: quoteA,
        language: "en",
      });
      // The document a customer already holds still reads the same.
      expect(afterHtml).toContain("Najolatech Marine LLC");
      expect(afterHtml).not.toContain("Completely Different Holdings LLC");
      expect(afterHtml).not.toContain("Somewhere else entirely");
    },
  );

  it("issuing twice never rewrites the first snapshot", { timeout: 120_000 }, async () => {
    const [before] = (await owner`
      select issuer_snapshot ->> 'legalName' as name, issuer_snapshot ->> 'capturedAt' as at
      from public.quote where id = ${quoteA}`) as unknown as Array<Record<string, string>>;
    await withCtx(ctxOf(orgA, userA), (tx) =>
      captureDocumentIssuerIn(tx, ctxOf(orgA, userA), "quote", quoteA),
    );
    const [after] = (await owner`
      select issuer_snapshot ->> 'legalName' as name, issuer_snapshot ->> 'capturedAt' as at
      from public.quote where id = ${quoteA}`) as unknown as Array<Record<string, string>>;
    expect(after!.name).toBe(before!.name);
    expect(after!.at).toBe(before!.at);
  });

  it(
    "a DRAFT renders from current identity, not from a snapshot",
    { timeout: 180_000 },
    async () => {
      const cust = await createCustomer(ctxOf(orgA, userA), "owner", { name: "Draft Customer" });
      const preset = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!;
      const draft = await createQuote(ctxOf(orgA, userA), "owner", {
        customerId: cust.id,
        presetId: preset.id,
        lines: [{ description: "Draft line", qty: 1, unit: "lot", unitPriceMinor: 100_000 }],
      });
      const html = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id: draft.id,
        language: "en",
      });
      // The company's CURRENT name, because a draft is a working copy.
      expect(html).toContain("Completely Different Holdings LLC");
      // And it says it is a draft.
      expect(html.toUpperCase()).toContain("DRAFT");
    },
  );
});

describe("H22.0 — every surface renders the same document", () => {
  it("preview HTML and the PDF come from one model", { timeout: 240_000 }, async () => {
    const model = await documentModel(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id: quoteA,
      language: "en",
    });
    const previewHtml = renderDocument(model);
    const pdfHtml = renderDocument(model, {
      delivery: "embed",
      embedded: await embeddedDocumentFonts(),
    });
    // The two differ ONLY in how the font travels; every word is identical.
    const strip = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/g, "");
    expect(strip(pdfHtml)).toBe(strip(previewHtml));

    const pdf = await renderPdf(pdfHtml);
    expect(pdf.byteLength).toBeGreaterThan(1000);
    const bytes = Buffer.from(pdf).toString("latin1");
    expect(bytes.slice(0, 5)).toBe("%PDF-");
  });

  /**
   * The Arabic PDF must carry the bundled face, because nothing else here has
   * Arabic glyphs: a container without it renders empty boxes, and that failed
   * silently before the font was bundled. The English document deliberately does
   * NOT assert this — Noto Naskh Arabic has Latin glyphs, and setting an English
   * invoice in a Naskh design would be wrong, so English takes a Latin face.
   */
  it("the Arabic PDF embeds the bundled Arabic face", { timeout: 240_000 }, async () => {
    const model = await documentModel(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id: quoteA,
      language: "ar",
    });
    const html = renderDocument(model, {
      delivery: "embed",
      embedded: await embeddedDocumentFonts(),
    });
    const pdf = await renderPdf(html, { pageNumbers: true, rtl: true });
    const bytes = Buffer.from(pdf).toString("latin1");
    expect(bytes).toContain("NotoNaskhArabic");
  });

  it(
    "Arabic renders right to left with the reference kept readable",
    { timeout: 180_000 },
    async () => {
      const html = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id: quoteA,
        language: "ar",
      });
      expect(html).toContain('dir="rtl"');
      expect(html).toContain('lang="ar"');
      // Numbers and references sit in an LTR isolate so Arabic context cannot
      // reorder them into nonsense.
      expect(html).toContain('<bdi dir="ltr">');
      expect(html).toContain("عرض سعر");
    },
  );

  it(
    "a missing logo degrades to the legal name, never a broken image",
    { timeout: 120_000 },
    async () => {
      const html = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id: quoteA,
        language: "en",
      });
      // No logo was uploaded for this fixture.
      expect(html).not.toContain("<img");
      expect(html).toContain("Najolatech Marine LLC");
    },
  );
});

describe("H22.0 — the weekly plan is a document, not a view", () => {
  it("creates, covers work, and issues with a snapshot", { timeout: 240_000 }, async () => {
    const plan = await createWeekPlan(ctxOf(orgA, userA), "owner", {
      weekStart: "2026-08-31",
      title: "Yard week",
    });
    planA = plan.id;
    expect(plan.reference).toMatch(/^WP-\d{4}-W\d{2}$/);

    await setWeekPlanJobs(ctxOf(orgA, userA), "owner", planA, [jobA]);
    const draft = await getWeekPlan(ctxOf(orgA, userA), "owner", planA);
    expect(draft!.status).toBe("draft");
    expect(draft!.jobCount).toBe(1);

    // A plan has no money on it, and is not forced to pretend otherwise.
    const model = await documentModel(ctxOf(orgA, userA), "owner", {
      kind: "week_plan",
      id: planA,
      language: "en",
    });
    expect(model.totals ?? []).toEqual([]);
    expect(model.sections.length).toBeGreaterThan(0);
    expect(model.sections[0]!.lines.length).toBe(2); // the two steps

    await issueWeekPlan(ctxOf(orgA, userA), "owner", planA);
    const issued = await getWeekPlan(ctxOf(orgA, userA), "owner", planA);
    expect(issued!.status).toBe("issued");
    expect(issued!.issuedAt).not.toBeNull();
    const [snap] = (await owner`
      select issuer_snapshot is not null as has from public.week_plan where id = ${planA}
    `) as unknown as Array<{ has: boolean }>;
    expect(snap!.has).toBe(true);
  });

  it("an issued plan refuses edits", { timeout: 120_000 }, async () => {
    await expect(
      updateWeekPlan(ctxOf(orgA, userA), "owner", planA, { notes: "too late" }),
    ).rejects.toBeInstanceOf(WeekPlanImmutableError);
    await expect(setWeekPlanJobs(ctxOf(orgA, userA), "owner", planA, [])).rejects.toBeInstanceOf(
      WeekPlanImmutableError,
    );
  });

  it("a revision keeps the original and records why", { timeout: 180_000 }, async () => {
    const rev = await reviseWeekPlan(
      ctxOf(orgA, userA),
      "owner",
      planA,
      "Two jobs moved to next week",
    );
    const original = await getWeekPlan(ctxOf(orgA, userA), "owner", planA);
    const revision = await getWeekPlan(ctxOf(orgA, userA), "owner", rev.id);

    // The circulated plan is kept exactly as circulated.
    expect(original!.status).toBe("revised");
    expect(original!.issuedAt).not.toBeNull();
    // The new one names its parent and its reason, and starts as a draft.
    expect(revision!.status).toBe("draft");
    expect(revision!.revisionOfId).toBe(planA);
    expect(revision!.revisionReason).toMatch(/moved to next week/);
    expect(revision!.reference).toMatch(/-R\d+$/);
    // It inherits the work the original covered.
    expect(revision!.jobCount).toBe(1);
  });
});

describe("H22.0 — a share link exposes one document, briefly", () => {
  it("resolves while live and stops the moment it is revoked", { timeout: 180_000 }, async () => {
    const { token, expiresAt } = await createDocumentShare(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id: quoteA,
      days: 7,
    });
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const live = await resolveDocumentShare(token);
    expect(live).not.toBeNull();
    expect(live!.kind).toBe("quote");
    expect(live!.id).toBe(quoteA);
    expect(live!.orgId).toBe(orgA);

    // The plaintext token is never stored.
    const [row] = (await owner`
      select token_hash from public.document_share where org_id = ${orgA} limit 1
    `) as unknown as Array<{ token_hash: string }>;
    expect(row!.token_hash).not.toBe(token);
    expect(row!.token_hash).toHaveLength(64);

    const shares = await listDocumentShares(ctxOf(orgA, userA), "owner", "quote", quoteA);
    expect(shares.length).toBeGreaterThan(0);
    await revokeDocumentShare(ctxOf(orgA, userA), "owner", shares[0]!.id);
    expect(await resolveDocumentShare(token)).toBeNull();
  });

  it("an expired link resolves to nothing", { timeout: 120_000 }, async () => {
    const { token } = await createDocumentShare(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id: quoteA,
      days: 1,
    });
    expect(await resolveDocumentShare(token)).not.toBeNull();
    // Age the row so it is genuinely expired. The schema forbids a share that
    // is born expired (expires_at > created_at), so both timestamps move back.
    await owner`
      update public.document_share set created_at = now() - interval '3 days',
        expires_at = now() - interval '1 hour'
      where org_id = ${orgA} and revoked_at is null`;
    expect(await resolveDocumentShare(token)).toBeNull();
  });

  it(
    "a made-up token resolves to nothing, and so does a wrong-length one",
    { timeout: 120_000 },
    async () => {
      expect(await resolveDocumentShare("a".repeat(43))).toBeNull();
      expect(await resolveDocumentShare("short")).toBeNull();
      expect(await resolveDocumentShare("")).toBeNull();
    },
  );

  it("a role without documents.share cannot mint a link", { timeout: 120_000 }, async () => {
    await expect(
      createDocumentShare(ctxOf(orgA, userA), "viewer", { kind: "quote", id: quoteA, days: 7 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  /**
   * A weekly plan names employees against tasks and covers every job that week,
   * so one customer's link would show them another customer's work. Even an
   * owner, who holds documents.share, cannot mint one: this is a property of the
   * document, not of the person asking.
   */
  it("a weekly plan cannot be shared, even by an owner", { timeout: 180_000 }, async () => {
    const plan = await createWeekPlan(ctxOf(orgA, userA), "owner", {
      weekStart: "2026-03-02",
      title: "Not for outside eyes",
    });
    await expect(
      createDocumentShare(ctxOf(orgA, userA), "owner", {
        kind: "week_plan",
        id: plan.id,
        days: 7,
      }),
    ).rejects.toBeInstanceOf(DocumentNotShareableError);

    // And the resolver refuses the kind independently, so a row written by any
    // other path still serves nobody.
    const { hash, raw } = shareTokenFor();
    await owner`
      insert into public.document_share
        (org_id, subject_type, subject_id, token_hash, expires_at, created_by)
      values (${orgA}, 'week_plan', ${plan.id}, ${hash}, now() + interval '7 days', ${userA})`;
    expect(await resolveDocumentShare(raw)).toBeNull();
  });
});
