/**
 * H26E — collaboration on the TEST project: anchored comments and threads,
 * mentions notify, resolution, suggested changes applied only by an explicit
 * accept on the working revision (with the row-version guard), never on an
 * issued document; a viewer may read but not comment.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { listMyNotifications } from "@/platform/notifications";
import {
  createDocComment,
  createDocument,
  decideSuggestion,
  getDocument,
  getRevision,
  issueDocument,
  listDocComments,
  resolveDocComment,
  saveRevision,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userM = randomUUID();
const userV = randomUUID();
let orgA = "";
const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26e",
});
const A = () => ctxOf(userA);
const M = () => ctxOf(userM);
const V = () => ctxOf(userV);

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userM, "Manager"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26e-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26E", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26e", run);
  for (const [id, name, role] of [
    [userM, "Manager", "manager"],
    [userV, "Viewer", "viewer"],
  ] as const) {
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${id}, ${name}, 'en')
      on conflict (id) do nothing`;
    await owner`
      insert into public.membership (user_id, org_id, role_key) values (${id}, ${orgA}, ${role})`;
  }
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userM, userV]);
  await owner.end();
  await closeAppDb();
});

describe("comments and suggestions", () => {
  let docId = "";
  let revId = "";
  let rootId = "";
  it("anchored comments, replies and mentions", async () => {
    const d = await createDocument(A(), "owner", {
      title: `NDA ${run}`,
      builtinKey: "builtin.nda",
    });
    docId = d.id;
    revId = d.revisionId;
    const root = await createDocComment(M(), "manager", {
      documentId: docId,
      revisionId: revId,
      blockId: "c3",
      body: "Clause 3 is too broad",
      mentions: [userA],
    });
    rootId = root.id;
    await createDocComment(A(), "owner", {
      documentId: docId,
      parentId: root.id,
      body: "Agreed, tighten it",
    });
    const list = await listDocComments(V(), "viewer", docId);
    expect(list.length).toBe(2);
    expect(list.find((c) => c.id === root.id)?.blockId).toBe("c3");
    expect(list.find((c) => c.parentId === root.id)?.body).toBe("Agreed, tighten it");
    const mine = await listMyNotifications(A(), true, { limit: 20 });
    expect(mine.some((n) => n.kind === "document_review_requested" && n.entityId === docId)).toBe(
      true,
    );
    // A viewer may read but not comment (no comments.create lane).
    await expect(
      createDocComment(V(), "viewer", { documentId: docId, body: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("resolution is reversible and recorded", async () => {
    await resolveDocComment(M(), "manager", { commentId: rootId });
    expect(
      (await listDocComments(A(), "owner", docId)).find((c) => c.id === rootId)?.resolvedAt,
    ).not.toBeNull();
    await resolveDocComment(M(), "manager", { commentId: rootId, resolved: false });
    expect(
      (await listDocComments(A(), "owner", docId)).find((c) => c.id === rootId)?.resolvedAt,
    ).toBeNull();
  });

  it("a suggestion changes the working revision only when accepted, through the row-version guard", async () => {
    const s = await createDocComment(M(), "manager", {
      documentId: docId,
      revisionId: revId,
      blockId: "c3",
      body: "Narrow the obligations",
      suggestion: {
        blockId: "c3",
        text: {
          en: "Each party shall use the confidential information only for the Purpose.",
          ar: "يلتزم كل طرف باستخدام المعلومات السرية للغرض فقط.",
        },
      },
    });
    const before = await getRevision(A(), "owner", revId);
    // A viewer/manager without documents.edit cannot accept.
    await expect(
      decideSuggestion(V(), "viewer", { commentId: s.id, decision: "accepted" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A stale row version is refused.
    await expect(
      decideSuggestion(A(), "owner", {
        commentId: s.id,
        decision: "accepted",
        expectedRowVersion: before.rowVersion + 5,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const r = await decideSuggestion(A(), "owner", {
      commentId: s.id,
      decision: "accepted",
      expectedRowVersion: before.rowVersion,
    });
    expect(r.applied).toBe(true);
    const after = await getRevision(A(), "owner", revId);
    const clause = after.body.blocks.find((b) => b.id === "c3");
    expect(clause?.type === "clause" && clause.text.en).toContain("only for the Purpose.");
    expect(after.rowVersion).toBe(before.rowVersion + 1);
    expect(
      (await listDocComments(A(), "owner", docId)).find((c) => c.id === s.id)?.suggestionStatus,
    ).toBe("accepted");
    await expect(
      decideSuggestion(A(), "owner", { commentId: s.id, decision: "rejected" }),
    ).rejects.toMatchObject({ code: "state" });
    const events = (await getDocument(A(), "owner", docId)).events.map((e) => e.kind);
    expect(events).toContain("comment_added");
    expect(events).toContain("suggestion_accepted");
  });

  it("an issued document takes comments but no suggestions", async () => {
    const rev = await getRevision(A(), "owner", revId);
    await saveRevision(A(), "owner", {
      documentId: docId,
      revisionId: revId,
      expectedRowVersion: rev.rowVersion,
      variables: { term_years: 2 },
    });
    await issueDocument(A(), "owner", { documentId: docId });
    await createDocComment(M(), "manager", { documentId: docId, body: "Signed copy filed" });
    await expect(
      createDocComment(M(), "manager", {
        documentId: docId,
        blockId: "c1",
        body: "x",
        suggestion: { blockId: "c1", text: { en: "y" } },
      }),
    ).rejects.toMatchObject({ code: "immutable" });
  });
});
