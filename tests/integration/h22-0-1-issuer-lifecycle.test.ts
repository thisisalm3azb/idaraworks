/**
 * H22.0.1 — the issuer snapshot, proved through the REAL lifecycle actions.
 *
 * H22.0 shipped a working snapshot helper that nothing called. Its integration
 * test passed because the test itself called the helper. So every assertion here
 * goes through the action a user actually triggers — markQuoteSent, acceptQuote,
 * issueInvoice — and never touches captureDocumentIssuerIn directly.
 *
 * The property under test: once a document is final, changing the company's
 * legal name, address, tax registration or logo must not alter what a customer
 * already holds. A draft, by contrast, must keep showing today's details.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import { createCustomer } from "@/modules/masters/service";
import { createQuote, markQuoteSent, acceptQuote, rejectQuote } from "@/modules/quotes/service";
import { issueInvoice } from "@/modules/invoices/service";
import { listActivePresets } from "@/modules/jobs/service";
import {
  documentHtml,
  documentModel,
  createDocumentShare,
  resolveDocumentShare,
} from "@/modules/documents/service";
import {
  renderDocument,
  renderPdf,
  closePdfBrowser,
  embeddedDocumentFonts,
} from "@/platform/documents";
import { ForbiddenError } from "@/platform/authz";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let customerA = "";
let presetA = "";

const ORIGINAL = "Original Marine Works LLC";
const ORIGINAL_TRN = "100111111100003";
const CHANGED = "Renamed Holdings Group LLC";
const CHANGED_TRN = "999888777600003";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22-0-1",
});

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h2201-${label}-${run}@example.com`}, '{"full_name":"H22.0.1"}'::jsonb, now(), now())`;
}

/** Set the organization's document identity. */
async function setIdentity(orgId: string, legalName: string, trn: string, address: string) {
  await owner`
    update public.company set
      legal_name = ${legalName}, tax_reg_no = ${trn}, trade_license_no = 'CN-1',
      address_en = ${address}, address_ar = ${address},
      city = 'Sharjah', country = 'United Arab Emirates', phone = '+971 6 555 0100',
      email = 'accounts@example.com', website = 'example.com',
      signatory_name = 'A. Alqubaisi', signatory_title = 'Managing Director',
      doc_language = 'bilingual'
    where org_id = ${orgId} and is_default`;
}

/** A quotation sitting at 'approved', which is where both real paths begin. */
async function approvedQuote(orgId: string, userId: string): Promise<string> {
  const q = await createQuote(ctxOf(orgId, userId), "owner", {
    customerId: orgId === orgA ? customerA : undefined,
    presetId: orgId === orgA ? presetA : undefined,
    lines: [{ description: "Hull work", qty: 1, unit: "unit", unitPriceMinor: 5_000_00 }],
  });
  await owner`
    update public.quote set status = 'approved' where id = ${q.id} and org_id = ${orgId}`;
  return q.id;
}

/** A draft invoice, written directly so cap.invoicing gating is not the subject. */
async function draftInvoice(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await owner`
    insert into public.invoice (id, org_id, reference, customer_name, status, created_by)
    values (${id}, ${orgId}, ${`INV-${randomUUID().slice(0, 8)}`}, 'A Customer', 'draft', ${userId})`;
  return id;
}

const snapshotOf = async (table: "quote" | "invoice", id: string) => {
  const [row] = (await owner.unsafe(
    `select issuer_snapshot, issued_at::text as issued_at from public.${table} where id = $1`,
    [id],
  )) as unknown as Array<{
    issuer_snapshot: Record<string, unknown> | null;
    issued_at: string | null;
  }>;
  return row!;
};

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H2201 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H2201 B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h22-0-1-issuer", run);
  await markFixtureOrg(owner, orgB, "h22-0-1-issuer", run);
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  await installTemplate(ctxOf(orgB, userB), "generic_operations_v1");
  // Both capabilities on, so the lifecycle actions run rather than gate.
  for (const org of [orgA, orgB]) {
    await owner`
      insert into public.org_entitlement_override (org_id, entitlement_key, enabled, reason)
      values (${org}, 'cap.quoting', true, 'h22.0.1 test'),
             (${org}, 'cap.invoicing', true, 'h22.0.1 test')
      on conflict do nothing`;
  }
  await setIdentity(orgA, ORIGINAL, ORIGINAL_TRN, "Plot 1, Original Street");
  await setIdentity(orgB, "Org B Trading LLC", "100222222200003", "Elsewhere");

  const cust = await createCustomer(ctxOf(orgA, userA), "owner", { name: "Gulf Marine Services" });
  customerA = cust.id;
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
}, 300_000);

afterAll(async () => {
  await closePdfBrowser();
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("sending a quotation captures the identity it was sent under", () => {
  it("markQuoteSent writes the snapshot and the issue date", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgA, userA);
    expect((await snapshotOf("quote", id)).issuer_snapshot).toBeNull();

    await markQuoteSent(ctxOf(orgA, userA), "owner", id);

    const after = await snapshotOf("quote", id);
    expect(after.issuer_snapshot, "sending must capture the issuer").not.toBeNull();
    expect(after.issuer_snapshot?.legalName).toBe(ORIGINAL);
    expect(after.issued_at, "quote.issued_at must be set by the real lifecycle").not.toBeNull();
  });

  it(
    "a later rename, move and re-registration does not alter the sent copy",
    { timeout: 240_000 },
    async () => {
      const id = await approvedQuote(orgA, userA);
      await markQuoteSent(ctxOf(orgA, userA), "owner", id);
      const issuedAt = (await snapshotOf("quote", id)).issued_at;

      await setIdentity(orgA, CHANGED, CHANGED_TRN, "Plot 999, New Address");

      // Preview and print serve the same HTML; the PDF renders from the same model.
      const html = await documentHtml(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id,
        language: "en",
      });
      expect(html).toContain(ORIGINAL);
      expect(html).toContain(ORIGINAL_TRN);
      expect(html).not.toContain(CHANGED);
      expect(html).not.toContain(CHANGED_TRN);
      expect(html).not.toContain("Plot 999");
      // And no legacy notice: this document has a real snapshot.
      expect(html).not.toMatch(/Issued before document snapshots were recorded/i);

      const model = await documentModel(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id,
        language: "en",
      });
      const pdf = await renderPdf(
        renderDocument(model, { delivery: "embed", embedded: await embeddedDocumentFonts() }),
        { pageNumbers: true },
      );
      expect(Buffer.from(pdf).toString("latin1").slice(0, 5)).toBe("%PDF-");

      // A share link shows the customer the same frozen identity.
      const share = await createDocumentShare(ctxOf(orgA, userA), "owner", {
        kind: "quote",
        id,
        days: 1,
      });
      const resolved = await resolveDocumentShare(share.token);
      expect(resolved?.id).toBe(id);
      const shared = await documentHtml(
        { ...ctxOf(orgA, userA), userId: "00000000-0000-0000-0000-000000000000" },
        "owner",
        { kind: "quote", id, language: "en" },
      );
      expect(shared).toContain(ORIGINAL);
      expect(shared).not.toContain(CHANGED);

      // The issue date did not move either.
      expect((await snapshotOf("quote", id)).issued_at).toBe(issuedAt);

      await setIdentity(orgA, ORIGINAL, ORIGINAL_TRN, "Plot 1, Original Street");
    },
  );
});

describe("accepting an unsent quotation captures too", () => {
  it(
    "acceptQuote from 'approved' captures, though the quote was never sent",
    { timeout: 240_000 },
    async () => {
      const id = await approvedQuote(orgA, userA);
      expect((await snapshotOf("quote", id)).issuer_snapshot).toBeNull();

      await acceptQuote(ctxOf(orgA, userA), "owner", id, { note: "signed" });

      const after = await snapshotOf("quote", id);
      expect(after.issuer_snapshot, "acceptance is an issuance").not.toBeNull();
      expect(after.issuer_snapshot?.legalName).toBe(ORIGINAL);
      expect(after.issued_at).not.toBeNull();
    },
  );
});

describe("rejecting makes a quotation final without inventing an issue date", () => {
  it("rejectQuote captures the identity but no issue date", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgA, userA);
    await rejectQuote(ctxOf(orgA, userA), "owner", id, "price too high");

    const after = await snapshotOf("quote", id);
    expect(after.issuer_snapshot, "a rejected quote renders as final").not.toBeNull();
    expect(after.issued_at, "rejection is not an issuance").toBeNull();

    // And it must not claim to be a legacy record.
    const html = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id,
      language: "en",
    });
    expect(html).not.toMatch(/Issued before document snapshots were recorded/i);
  });
});

describe("issuing an invoice captures the identity it was issued under", () => {
  it("issueInvoice writes the snapshot", { timeout: 180_000 }, async () => {
    const id = await draftInvoice(orgA, userA);
    await issueInvoice(ctxOf(orgA, userA), "owner", id);

    const after = await snapshotOf("invoice", id);
    expect(after.issuer_snapshot).not.toBeNull();
    expect(after.issuer_snapshot?.legalName).toBe(ORIGINAL);
    expect(after.issued_at).not.toBeNull();
  });

  it("a later rename does not alter the issued invoice", { timeout: 240_000 }, async () => {
    const id = await draftInvoice(orgA, userA);
    await issueInvoice(ctxOf(orgA, userA), "owner", id);
    await setIdentity(orgA, CHANGED, CHANGED_TRN, "Plot 999, New Address");
    const html = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "invoice",
      id,
      language: "ar",
    });
    expect(html).toContain(ORIGINAL);
    expect(html).not.toContain(CHANGED_TRN);
    await setIdentity(orgA, ORIGINAL, ORIGINAL_TRN, "Plot 1, Original Street");
  });
});

describe("repeats and concurrency never rewrite the original identity", () => {
  it("a second send is refused and the snapshot is untouched", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgA, userA);
    await markQuoteSent(ctxOf(orgA, userA), "owner", id);
    const first = await snapshotOf("quote", id);

    await setIdentity(orgA, CHANGED, CHANGED_TRN, "Plot 999, New Address");
    await expect(markQuoteSent(ctxOf(orgA, userA), "owner", id)).rejects.toThrow();
    await setIdentity(orgA, ORIGINAL, ORIGINAL_TRN, "Plot 1, Original Street");

    const second = await snapshotOf("quote", id);
    expect(second.issuer_snapshot).toEqual(first.issuer_snapshot);
    expect(second.issued_at).toBe(first.issued_at);
  });

  it(
    "concurrent sends leave exactly one snapshot and one issue date",
    { timeout: 240_000 },
    async () => {
      const id = await approvedQuote(orgA, userA);
      const results = await Promise.allSettled([
        markQuoteSent(ctxOf(orgA, userA), "owner", id),
        markQuoteSent(ctxOf(orgA, userA), "owner", id),
        markQuoteSent(ctxOf(orgA, userA), "owner", id),
      ]);
      // The status guard is the serialization point: exactly one call wins.
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      const after = await snapshotOf("quote", id);
      expect(after.issuer_snapshot).not.toBeNull();
      expect(after.issuer_snapshot?.legalName).toBe(ORIGINAL);
      expect(after.issued_at).not.toBeNull();
    },
  );
});

describe("drafts and legacy records behave as before", () => {
  it("a draft renders CURRENT identity and gets no snapshot", { timeout: 180_000 }, async () => {
    const q = await createQuote(ctxOf(orgA, userA), "owner", {
      customerId: customerA,
      lines: [{ description: "Draft line", qty: 1, unit: "unit", unitPriceMinor: 1_000_00 }],
    });
    await setIdentity(orgA, CHANGED, CHANGED_TRN, "Plot 999, New Address");
    const html = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id: q.id,
      language: "en",
    });
    expect(html, "a draft is a working copy and shows today's letterhead").toContain(CHANGED);
    expect((await snapshotOf("quote", q.id)).issuer_snapshot).toBeNull();
    await setIdentity(orgA, ORIGINAL, ORIGINAL_TRN, "Plot 1, Original Street");
  });

  it("a genuinely legacy row keeps the visible fallback notice", { timeout: 180_000 }, async () => {
    // A row that reached a final status before snapshots existed: final, and
    // with no snapshot. It must say so rather than present today's details as
    // history. This is the case H22.0.1 must NOT backfill.
    const id = await approvedQuote(orgA, userA);
    await owner`
        update public.quote set status = 'sent', issuer_snapshot = null
        where id = ${id} and org_id = ${orgA}`;

    const html = await documentHtml(ctxOf(orgA, userA), "owner", {
      kind: "quote",
      id,
      language: "en",
    });
    expect(html).toMatch(/Issued before document snapshots were recorded/i);
  });
});

describe("isolation and permission still hold", () => {
  it("organization B cannot send organization A's quotation", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgA, userA);
    await expect(markQuoteSent(ctxOf(orgB, userB), "owner", id)).rejects.toThrow();
    expect((await snapshotOf("quote", id)).issuer_snapshot).toBeNull();
  });

  it("a role without quotes.manage cannot send", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgA, userA);
    await expect(markQuoteSent(ctxOf(orgA, userA), "viewer", id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await snapshotOf("quote", id)).issuer_snapshot).toBeNull();
  });

  it("the captured identity is the acting organization's own", { timeout: 180_000 }, async () => {
    const id = await approvedQuote(orgB, userB);
    await markQuoteSent(ctxOf(orgB, userB), "owner", id);
    const after = await snapshotOf("quote", id);
    expect(after.issuer_snapshot?.legalName).toBe("Org B Trading LLC");
  });
});
