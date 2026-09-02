/**
 * H26H — obligations on the TEST project: items attach only to issued
 * documents; a renewal decision is seeded at issue from the expiry; due
 * states are computed against the org's reminder window; completion is
 * evidence-gated and immutable once done; recurrence spawns the next item;
 * waive/cancel need a reason; escalation notifies a member; a viewer can read
 * but not manage; another organisation sees nothing; the reminder sweep
 * notifies each offset exactly once; every move lands in the chain.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { listMyNotifications } from "@/platform/notifications";
import {
  attentionFeed,
  cancelObligation,
  completeObligation,
  createDocument,
  createObligation,
  escalateObligation,
  getDocument,
  getObligation,
  issueDocument,
  listObligations,
  reopenObligation,
  sendDueReminders,
  updateObligation,
  waiveObligation,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
const userV = randomUUID();
let orgA = "";
let orgB = "";
const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26h",
});
const A = () => ctxOf(orgA, userA);
const V = () => ctxOf(orgA, userV);
const B = () => ctxOf(orgB, userB);
const plus = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userB, "Other"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26h-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26H A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H26H B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26h", run);
  await markFixtureOrg(owner, orgB, "h26h", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB, userV]);
  await owner.end();
  await closeAppDb();
});

describe("obligations", () => {
  let docId = "";
  let obligationId = "";
  let rowVersion = 1;

  it("attach only to issued documents; issuing with an expiry seeds a renewal decision", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Service ${run}`,
      category: "contract",
      language: "en",
      body: {
        blocks: [
          { id: "h1", type: "heading", level: 1, text: { en: "Terms" } },
          { id: "p1", type: "paragraph", text: { en: "The supplier delivers monthly." } },
        ],
      },
      expiresAt: plus(20),
    });
    docId = d.id;
    await expect(
      createObligation(A(), "owner", { documentId: docId, title: "Too early", dueOn: plus(5) }),
    ).rejects.toMatchObject({ code: "state" });
    await issueDocument(A(), "owner", { documentId: docId });
    const seeded = await listObligations(A(), "owner", { documentId: docId });
    expect(seeded.length).toBe(1);
    expect(seeded[0]!.kind).toBe("renewal");
    expect(seeded[0]!.source).toBe("issue");
    expect(seeded[0]!.dueOn).toBe(plus(20));
    expect(seeded[0]!.requiresEvidence).toBe(false);
    expect(seeded[0]!.dueState).toBe("due_soon"); // default window 30 days
  });

  it("due states follow the window; a viewer reads but cannot manage; the other org sees nothing", async () => {
    const o = await createObligation(A(), "owner", {
      documentId: docId,
      kind: "payment",
      title: "Deposit invoice",
      dueOn: plus(-3),
      amountCents: 500000,
      currency: "AED",
      recurrenceMonths: 1,
      ownerUserId: userV,
    });
    obligationId = o.id;
    rowVersion = o.rowVersion;
    expect(o.dueState).toBe("overdue");
    expect(o.daysLeft).toBe(-3);
    const far = await createObligation(A(), "owner", {
      documentId: docId,
      title: "Annual review",
      dueOn: plus(90),
      requiresEvidence: false,
    });
    expect(far.dueState).toBe("upcoming");
    const asViewer = await listObligations(V(), "viewer", { documentId: docId });
    expect(asViewer.length).toBe(3);
    await expect(
      createObligation(V(), "viewer", { documentId: docId, title: "x", dueOn: plus(1) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getObligation(B(), "owner", obligationId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await listObligations(B(), "owner", {})).toEqual([]);
    // The assignee was notified.
    const notes = await listMyNotifications(V(), true);
    expect(notes.some((n) => n.kind === "document_obligation_due" && n.entityId === docId)).toBe(
      true,
    );
  });

  it("completion is evidence-gated, recurs, and the evidence is then immutable", async () => {
    await expect(
      completeObligation(A(), "owner", { id: obligationId, rowVersion }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      completeObligation(A(), "owner", {
        id: obligationId,
        rowVersion,
        fileId: randomUUID(),
        note: "",
      }),
    ).rejects.toMatchObject({ code: "validation" });
    const res = await completeObligation(A(), "owner", {
      id: obligationId,
      rowVersion,
      note: "Paid by transfer, ref TT-1",
    });
    expect(res.nextId).not.toBeNull();
    const done = await getObligation(A(), "owner", obligationId);
    expect(done.status).toBe("done");
    expect(done.dueState).toBe("closed");
    expect(done.evidenceNote).toContain("TT-1");
    const next = await getObligation(A(), "owner", res.nextId!);
    expect(next.status).toBe("open");
    expect(next.dueOn > done.dueOn).toBe(true);
    expect(next.recurrenceMonths).toBe(1);
    // A done item cannot be edited, completed again, or have its evidence changed.
    await expect(
      updateObligation(A(), "owner", { id: obligationId, rowVersion: done.rowVersion, title: "z" }),
    ).rejects.toMatchObject({ code: "state" });
    await expect(
      owner`update public.doc_obligation set evidence_note = 'tampered' where id = ${obligationId}`,
    ).rejects.toThrow(/immutable/);
    // Stale row version conflicts.
    await expect(
      completeObligation(A(), "owner", { id: next.id, rowVersion: 99, note: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("waive and cancel need a reason; reopen clears evidence; escalation notifies a member", async () => {
    const items = await listObligations(A(), "owner", { documentId: docId, status: ["open"] });
    const review = items.find((i) => i.title === "Annual review")!;
    await expect(
      waiveObligation(A(), "owner", { id: review.id, rowVersion: review.rowVersion, reason: "" }),
    ).rejects.toThrow();
    await waiveObligation(A(), "owner", {
      id: review.id,
      rowVersion: review.rowVersion,
      reason: "Not needed this year",
    });
    expect((await getObligation(A(), "owner", review.id)).status).toBe("waived");
    await reopenObligation(A(), "owner", { id: review.id, reason: "Needed after all" });
    const reopened = await getObligation(A(), "owner", review.id);
    expect(reopened.status).toBe("open");
    expect(reopened.closedReason).toBeNull();
    await cancelObligation(A(), "owner", {
      id: review.id,
      rowVersion: reopened.rowVersion,
      reason: "Superseded by the new contract",
    });
    const reopenedDone = await reopenObligation(A(), "owner", {
      id: obligationId,
      reason: "Payment bounced",
    });
    expect(reopenedDone.id).toBe(obligationId);
    const back = await getObligation(A(), "owner", obligationId);
    expect(back.status).toBe("open");
    expect(back.evidenceNote).toBeNull();
    await expect(
      escalateObligation(A(), "owner", { id: obligationId, toUserId: userB }),
    ).rejects.toMatchObject({ code: "validation" });
    await escalateObligation(A(), "owner", {
      id: obligationId,
      toUserId: userV,
      note: "Please chase",
    });
    const esc = await getObligation(A(), "owner", obligationId);
    expect(esc.escalatedTo).toBe(userV);
    const notes = await listMyNotifications(V(), true);
    expect(notes.some((n) => n.title.startsWith("Escalated:"))).toBe(true);
  });

  it("the reminder sweep notifies each offset once; the feed and the chain reflect everything", async () => {
    const first = await sendDueReminders(A());
    expect(first.sent).toBeGreaterThan(0); // the overdue deposit at least
    const second = await sendDueReminders(A());
    expect(second.sent).toBe(0);
    const feed = await attentionFeed(A(), "owner");
    expect(feed.overdue.some((o) => o.id === obligationId)).toBe(true);
    expect(feed.expiring.some((e) => e.id === docId)).toBe(true);
    const d = await getDocument(A(), "owner", docId);
    const kinds = d.events.map((e) => e.kind);
    for (const k of [
      "obligation_added",
      "obligation_completed",
      "obligation_waived",
      "obligation_reopened",
      "obligation_cancelled",
      "obligation_escalated",
      "reminder_sent",
    ])
      expect(kinds).toContain(k);
    expect(d.chain).toEqual({ ok: true });
  });
});
