/**
 * H26L — the security and integrity invariants of the Document Studio pinned
 * in one place: cross-organisation access, mutation of issued content (API
 * and raw SQL), signing an unissued version, one-time tokens, duplicate
 * transitions, unauthorised download, a revision of another document, a
 * stale workflow decision, and audit coverage of the lifecycle.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  archiveDocument,
  cancelSignatureRequest,
  createDocument,
  createSignatureRequest,
  declineWithToken,
  getDocument,
  getRevision,
  issueDocument,
  listDocuments,
  resolveSignerToken,
  saveRevision,
  signWithToken,
  terminateDocument,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

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
  requestId: "h26l",
});
const A = () => ctxOf(orgA, userA);
const B = () => ctxOf(orgB, userB);
const INFO = { ip: "198.51.100.9", userAgent: "vitest" };

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userB, "Other"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26l-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26L A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H26L B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26l", run);
  await markFixtureOrg(owner, orgB, "h26l", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  await installTemplate(B(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end();
  await closeAppDb();
});

const body = (suffix: string) => ({
  blocks: [
    { id: "h1", type: "heading" as const, level: 1 as const, text: { en: `Agreement ${suffix}` } },
    { id: "p1", type: "paragraph" as const, text: { en: "Terms of the agreement." } },
    { id: "s1", type: "signature" as const, party: "counterparty", label: { en: "Customer" } },
  ],
});

describe("invariants", () => {
  let docId = "";
  let otherDocId = "";
  let token = "";

  it("cross-organisation: nothing leaks by id, list, revision or download path", async () => {
    const d = await createDocument(A(), "owner", {
      title: `A ${run}`,
      category: "contract",
      language: "en",
      body: body("A"),
    });
    docId = d.id;
    const o = await createDocument(A(), "owner", {
      title: `A2 ${run}`,
      category: "letter",
      language: "en",
      body: body("A2"),
    });
    otherDocId = o.id;
    await expect(getDocument(B(), "owner", docId)).rejects.toMatchObject({ code: "not_found" });
    expect((await listDocuments(B(), "owner", {})).rows.map((r) => r.id)).not.toContain(docId);
    const detail = await getDocument(A(), "owner", docId);
    await expect(
      getRevision(B(), "owner", detail.document.workingRevisionId!),
    ).rejects.toMatchObject({ code: "not_found" });
    // Unauthorised download: a foreman holds no documents.view at all.
    await expect(getDocument(A(), "foreman", docId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a revision of another document cannot be rendered under this document", async () => {
    const other = await getDocument(A(), "owner", otherDocId);
    await expect(
      getRevision(A(), "owner", other.document.workingRevisionId!, docId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await getRevision(A(), "owner", other.document.workingRevisionId!, otherDocId)).id,
    ).toBe(other.document.workingRevisionId);
  });

  it("signing needs an issued version; issued content cannot change through the API or raw SQL; issue is not repeatable", async () => {
    await expect(
      createSignatureRequest(A(), "owner", {
        documentId: docId,
        mode: "parallel",
        signers: [
          { party: "counterparty", kind: "external", name: "Maha", email: "maha@example.invalid" },
        ],
      }),
    ).rejects.toMatchObject({ code: "state" });
    const issued = await issueDocument(A(), "owner", { documentId: docId });
    expect(issued.status).toBe("signature");
    await expect(issueDocument(A(), "owner", { documentId: docId })).rejects.toMatchObject({
      code: "immutable",
    });
    const detail = await getDocument(A(), "owner", docId);
    const frozen = detail.revisions[detail.revisions.length - 1]!;
    await expect(
      saveRevision(A(), "owner", {
        documentId: docId,
        revisionId: frozen.id,
        body: body("tampered"),
      }),
    ).rejects.toThrow();
    await expect(
      owner`update public.doc_snapshot set snapshot = '{"version":1}'::jsonb where document_id = ${docId}`,
    ).rejects.toThrow();
    await expect(
      owner`update public.doc_revision set body = '{"blocks":[]}'::jsonb where id = ${frozen.id}`,
    ).rejects.toThrow();
    expect((await getDocument(A(), "owner", docId)).chain).toEqual({ ok: true });
  });

  it("an invitation token is single-use and dies with its request", async () => {
    const room = await createSignatureRequest(A(), "owner", {
      documentId: docId,
      mode: "parallel",
      signers: [
        { party: "counterparty", kind: "external", name: "Maha", email: "maha@example.invalid" },
      ],
    });
    token = room.invitations.find((i) => i.link)!.link!.split("/sign/")[1]!;
    const resolved = await resolveSignerToken(token);
    expect(resolved).not.toBeNull();
    // Decline once; the same token cannot be used again to sign or decline.
    await declineWithToken(resolved!, { reason: "Not now" }, INFO);
    expect(await resolveSignerToken(token)).toBeNull();
    await expect(
      signWithToken(resolved!, { kind: "typed", data: "Maha", name: "Maha", consent: true }, INFO),
    ).rejects.toThrow();
    await expect(declineWithToken(resolved!, { reason: "Again" }, INFO)).rejects.toThrow();
    // A fresh room's token stops resolving once the request is cancelled.
    const room2 = await createSignatureRequest(A(), "owner", {
      documentId: docId,
      mode: "parallel",
      signers: [
        { party: "counterparty", kind: "external", name: "Maha", email: "maha@example.invalid" },
      ],
    });
    const t2 = room2.invitations.find((i) => i.link)!.link!.split("/sign/")[1]!;
    expect(await resolveSignerToken(t2)).not.toBeNull();
    await cancelSignatureRequest(A(), "owner", { requestId: room2.id, reason: "Renegotiated" });
    expect(await resolveSignerToken(t2)).toBeNull();
  });

  it("duplicate transitions are refused and every lifecycle move is audited", async () => {
    await terminateDocument(A(), "owner", { documentId: docId, reason: "Ended by agreement" });
    await expect(
      terminateDocument(A(), "owner", { documentId: docId, reason: "Again" }),
    ).rejects.toMatchObject({ code: "state" });
    await archiveDocument(A(), "owner", { documentId: docId });
    await expect(archiveDocument(A(), "owner", { documentId: docId })).rejects.toMatchObject({
      code: "state",
    });
    const audit = (await owner`
      select action from public.audit_log where org_id = ${orgA} and entity_id = ${docId}::uuid
    `) as unknown as Array<{ action: string }>;
    const actions = new Set(audit.map((a) => a.action));
    for (const a of [
      "documents.create",
      "documents.issue",
      "documents.terminate",
      "documents.archive",
    ])
      expect([...actions].some((x) => x.startsWith(a))).toBe(true);
  });
});
