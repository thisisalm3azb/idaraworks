/**
 * H26D — workflow runs above the approvals engine, on the TEST project.
 *
 * Properties: a value-gated workflow opens a manager approval as a real
 * `document_step` approval in the inbox; deciding it in the engine advances
 * the run in the same transaction; the conditional owner step opens only
 * above the threshold; a rejection returns the document to draft with a new
 * working revision and retires every live approval; review steps are decided
 * by their assignee with separation of duties; returning to draft cancels
 * the run; the document cannot be issued until the run completes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { decideApproval, listInbox } from "@/modules/approvals/service";
import {
  WORKFLOW_PRESETS,
  createDocument,
  createWorkflow,
  decideReviewStep,
  getDocument,
  getRevision,
  getRunForDocument,
  issueDocument,
  listMySteps,
  returnToDraft,
  saveRevision,
  submitForReview,
  updateDocument,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID(); // owner
const userM = randomUUID(); // manager
const userF = randomUUID(); // accounts
let orgA = "";
const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26d",
});
const A = () => ctxOf(userA);
const M = () => ctxOf(userM);
const F = () => ctxOf(userF);
let valueGateId = "";
let reviewFlowId = "";

const withLines = (rev: Awaited<ReturnType<typeof getRevision>>, unitPriceMinor: number) => ({
  blocks: rev.body.blocks.map((b) =>
    b.type === "line_items"
      ? { ...b, items: [{ description: { en: "Work" }, qty: 1, unit: "lot", unitPriceMinor, vatRate: 0 }] }
      : b,
  ),
});

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userM, "Manager"],
    [userF, "Accounts"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26d-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26D", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26d", run);
  for (const [id, name, role] of [
    [userM, "Manager", "manager"],
    [userF, "Accounts", "accounts"],
  ] as const) {
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${id}, ${name}, 'en')
      on conflict (id) do nothing`;
    await owner`
      insert into public.membership (user_id, org_id, role_key) values (${id}, ${orgA}, ${role})`;
  }
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  valueGateId = (
    await createWorkflow(A(), "owner", {
      name: `Value gate ${run}`,
      definition: WORKFLOW_PRESETS.find((p) => p.key === "value_gate")!.definition,
    })
  ).id;
  reviewFlowId = (
    await createWorkflow(A(), "owner", {
      name: `Review first ${run}`,
      definition: WORKFLOW_PRESETS.find((p) => p.key === "manager_review")!.definition,
    })
  ).id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userM, userF]);
  await owner.end();
  await closeAppDb();
});

describe("value-gated approval workflow", () => {
  let docId = "";
  it("submitting opens a manager approval in the shared inbox and blocks issue", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Big agreement ${run}`,
      category: "agreement",
      language: "en",
      builtinKey: "builtin.service_agreement",
      workflowId: valueGateId,
    });
    docId = d.id;
    const rev = await getRevision(A(), "owner", d.revisionId);
    await saveRevision(A(), "owner", {
      documentId: d.id,
      revisionId: d.revisionId,
      expectedRowVersion: rev.rowVersion,
      body: withLines(rev, 8_000_000), // AED 80,000 → above the 50,000 gate
      variables: { payment_days: 30 },
    });
    await submitForReview(A(), "owner", { documentId: d.id });
    const detail = await getDocument(A(), "owner", d.id);
    expect(detail.document.status).toBe("approval");
    const r = await getRunForDocument(A(), "owner", d.id);
    expect(r?.status).toBe("running");
    expect(r?.steps.filter((s) => s.status === "active").map((s) => s.stepId)).toEqual(["manager"]);
    const inbox = await listInbox(M(), "manager");
    expect(inbox.some((a) => a.subjectType === "document_step")).toBe(true);
    await expect(issueDocument(A(), "owner", { documentId: d.id })).rejects.toMatchObject({ code: "state" });
    const mine = await listMySteps(M(), "manager");
    expect(mine.some((s) => s.documentId === d.id && s.kind === "approval")).toBe(true);
  });

  it("the manager's decision in the engine advances the run to the conditional owner step", async () => {
    const inbox = await listInbox(M(), "manager");
    const item = inbox.find((a) => a.subjectType === "document_step")!;
    await decideApproval(M(), "manager", { approvalId: item.id, decision: "approved" });
    const r = await getRunForDocument(A(), "owner", docId);
    expect(r?.status).toBe("running");
    expect(r?.currentStepIndex).toBe(1);
    const active = r!.steps.filter((s) => s.status === "active");
    expect(active.map((s) => s.stepId)).toEqual(["owner_high_value"]);
    expect(active[0]?.approvalId).not.toBeNull();
    const events = (await getDocument(A(), "owner", docId)).events.map((e) => e.kind);
    expect(events).toContain("approval_started");
    expect(events).toContain("approval_step_decided");
  });

  it("the owner (submitter) decides the terminal owner step; the run completes and issue works", async () => {
    const inbox = await listInbox(A(), "owner");
    const item = inbox.find((a) => a.subjectType === "document_step")!;
    await decideApproval(A(), "owner", { approvalId: item.id, decision: "approved" });
    const r = await getRunForDocument(A(), "owner", docId);
    expect(r?.status).toBe("completed");
    expect((await getDocument(A(), "owner", docId)).document.status).toBe("approval");
    const issued = await issueDocument(A(), "owner", { documentId: docId });
    expect(issued.status).toBe("signature");
  });

  it("below the gate the owner step is skipped", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Small agreement ${run}`,
      category: "agreement",
      language: "en",
      builtinKey: "builtin.service_agreement",
      workflowId: valueGateId,
    });
    const rev = await getRevision(A(), "owner", d.revisionId);
    await saveRevision(A(), "owner", {
      documentId: d.id,
      revisionId: d.revisionId,
      expectedRowVersion: rev.rowVersion,
      body: withLines(rev, 100_000), // AED 1,000
      variables: { payment_days: 14 },
    });
    await submitForReview(A(), "owner", { documentId: d.id });
    const inbox = await listInbox(M(), "manager");
    const item = inbox.find((a) => a.subjectType === "document_step" && a.subjectId !== "")!;
    await decideApproval(M(), "manager", { approvalId: item.id, decision: "approved" });
    const r = await getRunForDocument(A(), "owner", d.id);
    expect(r?.status).toBe("completed");
    expect(r?.steps.find((s) => s.stepId === "owner_high_value")?.status).toBe("skipped");
  });

  it("a rejection returns the document to draft with a fresh working revision and retires the approval", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Rejected agreement ${run}`,
      category: "agreement",
      language: "en",
      builtinKey: "builtin.service_agreement",
      workflowId: valueGateId,
    });
    const rev = await getRevision(A(), "owner", d.revisionId);
    await saveRevision(A(), "owner", {
      documentId: d.id,
      revisionId: d.revisionId,
      expectedRowVersion: rev.rowVersion,
      body: withLines(rev, 100_000),
      variables: { payment_days: 14 },
    });
    await submitForReview(A(), "owner", { documentId: d.id });
    const inbox = await listInbox(M(), "manager");
    const item = inbox.find((a) => a.subjectType === "document_step")!;
    await decideApproval(M(), "manager", { approvalId: item.id, decision: "rejected", note: "price is wrong" });
    const detail = await getDocument(A(), "owner", d.id);
    expect(detail.document.status).toBe("draft");
    expect(detail.working?.revisionNo).toBe(2);
    const r = await getRunForDocument(A(), "owner", d.id);
    expect(r?.status).toBe("rejected");
    expect(r?.outcomeNote).toBe("price is wrong");
    expect(detail.events.map((e) => e.kind)).toContain("approval_rejected");
    // Resubmitting starts a fresh run.
    await submitForReview(A(), "owner", { documentId: d.id });
    const again = await getRunForDocument(A(), "owner", d.id);
    expect(again?.status).toBe("running");
    expect(again?.id).not.toBe(r?.id);
    // Returning to draft cancels it and retires the live approval.
    await returnToDraft(A(), "owner", { documentId: d.id, note: "hold" });
    expect((await getRunForDocument(A(), "owner", d.id))?.status).toBe("cancelled");
    const pending = (await owner`
      select count(*)::int as n from public.approval
      where org_id = ${orgA} and subject_type = 'document_step' and state = 'pending'`) as unknown as Array<{ n: number }>;
    expect(Number(pending[0]!.n)).toBe(0);
  });
});

describe("review steps", () => {
  it("a review step is decided by its assignee, never by the submitter, and then approval follows", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Reviewed letter ${run}`,
      category: "letter",
      language: "en",
      builtinKey: "builtin.cover_letter",
    });
    await updateDocument(A(), "owner", { documentId: d.id, workflowId: reviewFlowId });
    const rev = await getRevision(A(), "owner", d.revisionId);
    await saveRevision(A(), "owner", {
      documentId: d.id,
      revisionId: d.revisionId,
      expectedRowVersion: rev.rowVersion,
      variables: { recipient: "Someone", subject: "Hello" },
    });
    await submitForReview(A(), "owner", { documentId: d.id });
    expect((await getDocument(A(), "owner", d.id)).document.status).toBe("review");
    const r = await getRunForDocument(A(), "owner", d.id);
    const step = r!.steps.find((s) => s.status === "active")!;
    expect(step.kind).toBe("review");
    // The accounts user is not the assignee (manager archetype).
    await expect(
      decideReviewStep(F(), "accounts", { stepRunId: step.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The submitter cannot decide their own review step even as owner.
    await expect(
      decideReviewStep(A(), "owner", { stepRunId: step.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await decideReviewStep(M(), "manager", { stepRunId: step.id, decision: "approved", note: "fine" });
    const after = await getRunForDocument(A(), "owner", d.id);
    expect(after?.currentStepIndex).toBe(1);
    expect(after?.steps.find((s) => s.stepId === "approve")?.status).toBe("active");
    expect((await getDocument(A(), "owner", d.id)).document.status).toBe("approval");
    // A second decision on the same step is refused.
    await expect(
      decideReviewStep(M(), "manager", { stepRunId: step.id, decision: "approved" }),
    ).rejects.toMatchObject({ code: "state" });
  });
});
