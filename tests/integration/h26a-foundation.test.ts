/**
 * H26A — the document foundation on the TEST project.
 *
 * Properties: a document is born from a template with a working revision;
 * autosave refuses stale writes; submitting freezes content with a hash;
 * returning opens a new revision; issuing writes ONE immutable snapshot the
 * database itself refuses to change, stamps retention and moves to
 * `signature` when the body has signature blocks; the evidence chain
 * verifies and detects tampering; a successor supersedes its predecessor;
 * templates publish immutable versions; permissions and tenancy hold.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The test project pooler can take seconds per statement; every case here
// walks dozens of statements through the doors.
vi.setConfig({ testTimeout: 180_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer } from "@/modules/masters/service";
import {
  archiveDocument,
  createDocument,
  createSuccessor,
  createTemplate,
  getDocument,
  getRevision,
  issueDocument,
  listDocuments,
  listTemplates,
  publishTemplate,
  returnToDraft,
  saveRevision,
  submitForReview,
  terminateDocument,
  updateTemplate,
  DocError,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userV = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let customerId = "";
let docId = "";
let workingRevId = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26a",
});
const A = () => ctxOf(orgA, userA);
const V = () => ctxOf(orgA, userV);
const B = () => ctxOf(orgB, userB);

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userV, "Viewer"],
    [userB, "OtherOwner"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26a-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26A", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26a", run);
  orgB = await createOrgForUser(userB, { name: "H26A-B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgB, "h26a", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const c = await createCustomer(A(), "owner", { name: `Counterparty ${run}`, country: "AE" });
  customerId = c.id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userV, userB]);
  await owner.end();
  await closeAppDb();
});

describe("create and edit", () => {
  it("a document is born from a built-in template with a working revision and a chained event", async () => {
    const r = await createDocument(A(), "owner", {
      title: `NDA ${run}`,
      category: "contract",
      language: "bilingual",
      builtinKey: "builtin.nda",
      counterparty: { kind: "customer", id: customerId },
      tags: ["legal", "nda"],
    });
    docId = r.id;
    workingRevId = r.revisionId;
    expect(r.reference).toMatch(/^DOC-\d{3}$/);
    const d = await getDocument(A(), "owner", docId);
    expect(d.document.status).toBe("draft");
    expect(d.working?.id).toBe(workingRevId);
    expect(d.working?.body.blocks.length).toBeGreaterThan(5);
    expect(d.events.map((e) => e.kind)).toEqual(["created"]);
    expect(d.chain).toEqual({ ok: true });
  });

  it("a viewer may read but not create or edit", async () => {
    await expect(createDocument(V(), "viewer", { title: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const d = await getDocument(V(), "viewer", docId);
    expect(d.document.id).toBe(docId);
  });

  it("autosave bumps the row version and refuses a stale write", async () => {
    const rev = await getRevision(A(), "owner", workingRevId);
    const saved = await saveRevision(A(), "owner", {
      documentId: docId,
      revisionId: workingRevId,
      expectedRowVersion: rev.rowVersion,
      variables: { term_years: 3 },
    });
    expect(saved.rowVersion).toBe(rev.rowVersion + 1);
    await expect(
      saveRevision(A(), "owner", {
        documentId: docId,
        revisionId: workingRevId,
        expectedRowVersion: rev.rowVersion,
        variables: { term_years: 4 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("the library lists, filters and searches", async () => {
    const all = await listDocuments(A(), "owner", {});
    expect(all.rows.some((d) => d.id === docId)).toBe(true);
    const byTag = await listDocuments(A(), "owner", { tag: "nda" });
    expect(byTag.rows.map((d) => d.id)).toContain(docId);
    const search = await listDocuments(A(), "owner", { search: "Confidential" });
    expect(search.rows.map((d) => d.id)).toContain(docId);
    const none = await listDocuments(A(), "owner", { search: `zzz-${run}` });
    expect(none.rows.length).toBe(0);
  });
});

describe("review, freeze and issue", () => {
  it("submitting freezes the working revision with a content hash; returning opens revision 2", async () => {
    const s = await submitForReview(A(), "owner", { documentId: docId, note: "please review" });
    expect(s.revisionId).toBe(workingRevId);
    const frozen = await getRevision(A(), "owner", workingRevId);
    expect(frozen.state).toBe("frozen");
    expect(frozen.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The database holds the freeze even for the owner connection.
    await expect(
      owner`update public.doc_revision set note = 'tamper' where id = ${workingRevId}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      saveRevision(A(), "owner", {
        documentId: docId,
        revisionId: workingRevId,
        expectedRowVersion: frozen.rowVersion,
        variables: {},
      }),
    ).rejects.toMatchObject({ code: "state" });

    const back = await returnToDraft(A(), "owner", { documentId: docId, note: "tighten clause 3" });
    expect(back.revisionId).not.toBe(workingRevId);
    const d = await getDocument(A(), "owner", docId);
    expect(d.document.status).toBe("draft");
    expect(d.working?.revisionNo).toBe(2);
    expect(d.revisions.map((r) => r.state)).toEqual(["frozen", "working"]);
    workingRevId = back.revisionId;
  });

  it("a required author field blocks issue until filled", async () => {
    const rev = await getRevision(A(), "owner", workingRevId);
    await saveRevision(A(), "owner", {
      documentId: docId,
      revisionId: workingRevId,
      expectedRowVersion: rev.rowVersion,
      variables: {},
    });
    await expect(issueDocument(A(), "owner", { documentId: docId })).rejects.toMatchObject({
      code: "validation",
    });
    const rev2 = await getRevision(A(), "owner", workingRevId);
    await saveRevision(A(), "owner", {
      documentId: docId,
      revisionId: workingRevId,
      expectedRowVersion: rev2.rowVersion,
      variables: { term_years: 2 },
    });
  });

  it("issuing writes one immutable snapshot with resolved bindings, stamps retention and moves to signature", async () => {
    const r = await issueDocument(A(), "owner", { documentId: docId });
    expect(r.status).toBe("signature");
    expect(r.parties).toEqual(["company", "counterparty"]);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const d = await getDocument(A(), "owner", docId);
    expect(d.document.issuedSnapshotId).toBe(r.snapshotId);
    expect(d.document.workingRevisionId).toBeNull();
    expect(d.document.retentionUntil).not.toBeNull();
    expect(Number(d.document.retentionUntil!.slice(0, 4))).toBeGreaterThanOrEqual(
      new Date().getFullYear() + 7,
    );
    expect(d.snapshot?.snapshot.values.bindings["counterparty.name"]).toBe(`Counterparty ${run}`);
    expect(d.snapshot?.snapshot.issuer.version).toBe(1);
    expect(d.events.map((e) => e.kind)).toContain("issued");
    expect(d.chain).toEqual({ ok: true });

    // Nothing changes the snapshot: no UPDATE grant for app_user, and the trigger refuses every role.
    await expect(
      owner`update public.doc_snapshot set content_hash = ${"0".repeat(64)} where id = ${r.snapshotId}`,
    ).rejects.toThrow(/immutable/);
    await expect(issueDocument(A(), "owner", { documentId: docId })).rejects.toMatchObject({
      code: "immutable",
    });
    await expect(
      saveRevision(A(), "owner", {
        documentId: docId,
        revisionId: workingRevId,
        expectedRowVersion: 1,
        variables: {},
      }),
    ).rejects.toMatchObject({ code: "state" });
  });

  it("the evidence chain detects a tampered event", async () => {
    const rows = (await owner`
      select id from public.doc_event where document_id = ${docId} order by seq limit 1`) as unknown as Array<{
      id: string;
    }>;
    // Even the owner connection cannot edit an event row (trigger), so tampering
    // is simulated the only way it could happen: by replacing the row wholesale.
    await expect(
      owner`update public.doc_event set kind = 'x' where id = ${rows[0]!.id}`,
    ).rejects.toThrow(/immutable/);
    await owner.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx.unsafe(
        `update public.doc_event set payload = '{"forged":true}'::jsonb where id = $1`,
        [rows[0]!.id],
      );
    });
    const d = await getDocument(A(), "owner", docId);
    expect(d.chain).toMatchObject({ ok: false, atSeq: 1, reason: "event hash mismatch" });
    await owner.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx.unsafe(
        `update public.doc_event set payload = (select payload from public.doc_event where id = $1) where id = $1`,
        [rows[0]!.id],
      );
    });
  });
});

describe("successors, termination, archive", () => {
  it("a successor supersedes its predecessor when issued", async () => {
    const s = await createSuccessor(A(), "owner", { documentId: docId, title: `NDA v2 ${run}` });
    const sd = await getDocument(A(), "owner", s.id);
    expect(sd.document.supersedesDocumentId).toBe(docId);
    expect(sd.working?.body.blocks.length).toBeGreaterThan(5);
    const rev = await getRevision(A(), "owner", s.revisionId);
    await saveRevision(A(), "owner", {
      documentId: s.id,
      revisionId: s.revisionId,
      expectedRowVersion: rev.rowVersion,
      variables: { term_years: 5 },
    });
    await issueDocument(A(), "owner", { documentId: s.id });
    const prev = await getDocument(A(), "owner", docId);
    expect(prev.document.status).toBe("superseded");
    expect(prev.document.supersededByDocumentId).toBe(s.id);
    expect(prev.events.map((e) => e.kind)).toContain("superseded");
    await expect(createSuccessor(A(), "owner", { documentId: docId })).rejects.toMatchObject({
      code: "state",
    });
  });

  it("terminate needs the terminate lane and an issued document; archive respects legal hold", async () => {
    const plain = await createDocument(A(), "owner", {
      title: `Letter ${run}`,
      builtinKey: "builtin.cover_letter",
    });
    await expect(
      terminateDocument(A(), "owner", { documentId: plain.id, reason: "x" }),
    ).rejects.toMatchObject({ code: "state" });
    const rev = await getRevision(A(), "owner", plain.revisionId);
    await saveRevision(A(), "owner", {
      documentId: plain.id,
      revisionId: plain.revisionId,
      expectedRowVersion: rev.rowVersion,
      variables: { recipient: "Someone", subject: "Hello" },
    });
    const issued = await issueDocument(A(), "owner", { documentId: plain.id });
    expect(issued.status).toBe("active");
    await expect(
      terminateDocument(ctxOf(orgA, userA), "manager", { documentId: plain.id, reason: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await terminateDocument(A(), "owner", { documentId: plain.id, reason: "no longer needed" });
    const t = await getDocument(A(), "owner", plain.id);
    expect(t.document.status).toBe("terminated");
    await owner`update public.doc_document set legal_hold = true where id = ${plain.id}`;
    await expect(archiveDocument(A(), "owner", { documentId: plain.id })).rejects.toMatchObject({
      code: "state",
    });
    await owner`update public.doc_document set legal_hold = false where id = ${plain.id}`;
    await archiveDocument(A(), "owner", { documentId: plain.id });
    expect((await getDocument(A(), "owner", plain.id)).document.status).toBe("archived");
    await archiveDocument(A(), "owner", { documentId: plain.id, restore: true });
    expect((await getDocument(A(), "owner", plain.id)).document.status).toBe("terminated");
  });
});

describe("templates", () => {
  it("an organisation template publishes an immutable version that documents pin", async () => {
    const t = await createTemplate(A(), "owner", {
      key: `our-nda-${run}`,
      nameEn: "Our NDA",
      nameAr: "اتفاقيتنا",
      category: "contract",
      language: "bilingual",
      fromBuiltinKey: "builtin.nda",
    });
    await expect(
      createDocument(A(), "owner", { title: "x", templateId: t.id }),
    ).rejects.toMatchObject({ code: "state" });
    await publishTemplate(A(), "owner", { templateId: t.id, changeNote: "first" });
    const doc = await createDocument(A(), "owner", {
      title: `From template ${run}`,
      templateId: t.id,
    });
    const d1 = await getDocument(A(), "owner", doc.id);
    expect(d1.document.templateId).toBe(t.id);
    // Editing the template creates a draft version 2; publishing it never touches the document.
    await updateTemplate(A(), "owner", {
      templateId: t.id,
      body: { blocks: [{ id: "only", type: "paragraph", text: { en: "changed" } }] },
    });
    await expect(
      owner`update public.doc_template_version set body = '{"blocks":[]}' where id = ${t.versionId}`,
    ).rejects.toThrow(/immutable/);
    await publishTemplate(A(), "owner", { templateId: t.id });
    const d2 = await getDocument(A(), "owner", doc.id);
    expect(d2.working?.body.blocks.length).toBe(d1.working?.body.blocks.length);
    const list = await listTemplates(A(), "owner");
    expect(list.find((x) => x.id === t.id)?.currentVersion).toBe(2);
    expect(list.filter((x) => x.builtIn).length).toBe(6);
  });
});

describe("tenancy", () => {
  it("another organisation sees nothing of these documents", async () => {
    const other = await listDocuments(B(), "owner", {});
    expect(other.rows.length).toBe(0);
    await expect(getDocument(B(), "owner", docId)).rejects.toBeInstanceOf(DocError);
  });
});
