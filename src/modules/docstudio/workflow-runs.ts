/**
 * H26 — workflow runs (ADR-22). A run copies its workflow definition and
 * walks the steps: review steps are decided here; approval steps become
 * `document_step` approvals in the shared engine (inbox, notifications,
 * self-approval guard) and advance the run from the engine's after-decide
 * hook, in the same transaction; a signature step marks the run as needing
 * signatures after issue. Rejection returns the document to draft (or stops
 * the run) per the step's rule. Editing the workflow never touches a run.
 */
import { z } from "zod";
import { command, recordActivityIn } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { submitForApproval, supersedeApprovalsForSubjectsIn } from "@/modules/approvals/service";
import { evaluateConditions, type ConditionValues } from "./conditions";
import {
  loadDocIn,
  loadRevisionIn,
  openWorkingIn,
  type DocumentRow,
  type RevisionRow,
} from "./documents";
import { appendEventIn } from "./events";
import { DocError, flattenBlocks, type DocStatus } from "./types";
import { WorkflowDefinition, loadWorkflowIn, type Assignee, type WorkflowStep } from "./workflows";

export type StepRunRow = {
  id: string;
  runId: string;
  documentId: string;
  stepId: string;
  stepIndex: number;
  kind: "review" | "approval" | "signature";
  status: "pending" | "active" | "completed" | "rejected" | "skipped" | "cancelled";
  assigneeUserId: string | null;
  assigneeArchetype: string | null;
  approvalId: string | null;
  dueAt: string | null;
  overdue: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  decision: "approved" | "rejected" | null;
  note: string | null;
  delegatedFrom: string | null;
  rowVersion: number;
};

export type RunRow = {
  id: string;
  documentId: string;
  revisionId: string;
  workflowId: string | null;
  definition: WorkflowDefinition;
  status: "running" | "completed" | "rejected" | "cancelled";
  currentStepIndex: number;
  requiresSignature: boolean;
  outcomeNote: string | null;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  rowVersion: number;
  steps: StepRunRow[];
};

function mapStep(r: Record<string, unknown>): StepRunRow {
  const due = (r.due_at as string | null) ?? null;
  const status = r.status as StepRunRow["status"];
  return {
    id: r.id as string,
    runId: r.run_id as string,
    documentId: r.document_id as string,
    stepId: r.step_id as string,
    stepIndex: Number(r.step_index),
    kind: r.kind as StepRunRow["kind"],
    status,
    assigneeUserId: (r.assignee_user_id as string | null) ?? null,
    assigneeArchetype: (r.assignee_archetype as string | null) ?? null,
    approvalId: (r.approval_id as string | null) ?? null,
    dueAt: due,
    overdue: status === "active" && due !== null && new Date(due).getTime() < Date.now(),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decision: (r.decision as StepRunRow["decision"]) ?? null,
    note: (r.note as string | null) ?? null,
    delegatedFrom: (r.delegated_from as string | null) ?? null,
    rowVersion: Number(r.row_version),
  };
}

const STEP_COLUMNS = sql`
  s.id::text as id, s.run_id::text as run_id, s.document_id::text as document_id, s.step_id, s.step_index,
  s.kind, s.status, s.assignee_user_id::text as assignee_user_id, s.assignee_archetype,
  s.approval_id::text as approval_id, s.due_at::text as due_at, s.decided_by::text as decided_by,
  s.decided_at::text as decided_at, s.decision, s.note, s.delegated_from::text as delegated_from, s.row_version`;

async function loadStepsIn(tx: TenantTx, ctx: Ctx, runId: string): Promise<StepRunRow[]> {
  const rows = (await tx.execute(sql`
    select ${STEP_COLUMNS} from public.doc_workflow_step_run s
    where s.run_id = ${runId} and s.org_id = ${ctx.orgId}
    order by s.step_index, s.created_at
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapStep);
}

async function loadRunIn(tx: TenantTx, ctx: Ctx, runId: string, lock = false): Promise<RunRow> {
  const rows = (await tx.execute(
    lock
      ? sql`select r.id::text as id, r.document_id::text as document_id, r.revision_id::text as revision_id,
                   r.workflow_id::text as workflow_id, r.definition, r.status, r.current_step_index,
                   r.requires_signature, r.outcome_note, r.started_by::text as started_by,
                   r.started_at::text as started_at, r.finished_at::text as finished_at, r.row_version
            from public.doc_workflow_run r where r.id = ${runId} and r.org_id = ${ctx.orgId} for update`
      : sql`select r.id::text as id, r.document_id::text as document_id, r.revision_id::text as revision_id,
                   r.workflow_id::text as workflow_id, r.definition, r.status, r.current_step_index,
                   r.requires_signature, r.outcome_note, r.started_by::text as started_by,
                   r.started_at::text as started_at, r.finished_at::text as finished_at, r.row_version
            from public.doc_workflow_run r where r.id = ${runId} and r.org_id = ${ctx.orgId}`,
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) throw new DocError("workflow run not found", "not_found");
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    revisionId: r.revision_id as string,
    workflowId: (r.workflow_id as string | null) ?? null,
    definition: WorkflowDefinition.parse(r.definition),
    status: r.status as RunRow["status"],
    currentStepIndex: Number(r.current_step_index),
    requiresSignature: Boolean(r.requires_signature),
    outcomeNote: (r.outcome_note as string | null) ?? null,
    startedBy: r.started_by as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    rowVersion: Number(r.row_version),
    steps: await loadStepsIn(tx, ctx, r.id as string),
  };
}

export async function latestRunIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<RunRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.doc_workflow_run
    where document_id = ${documentId} and org_id = ${ctx.orgId}
    order by started_at desc limit 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0] ? loadRunIn(tx, ctx, rows[0].id) : null;
}

/** The facts a step condition may read at submit time (frozen revision + document). */
function runFacts(d: DocumentRow, rev: RevisionRow): ConditionValues {
  let amountMinor = 0;
  let hasSignature = false;
  for (const b of flattenBlocks(rev.body)) {
    if (b.type === "line_items" && b.source === "manual") {
      for (const it of b.items) {
        const line = Math.round(it.qty * it.unitPriceMinor);
        amountMinor += line + Math.round((line * (it.vatRate ?? 0)) / 100);
      }
    }
    if (b.type === "signature") hasSignature = true;
  }
  return {
    bindings: {
      "document.amount": (amountMinor / 100).toFixed(2),
      "document.amount_minor": String(amountMinor),
      "document.category": d.category,
      "document.language": d.language,
      "document.counterparty_kind": d.counterpartyKind,
      "document.has_signatures": hasSignature ? "true" : "false",
    },
    variables: rev.variables,
  };
}

async function archetypeOfUserIn(
  tx: TenantTx,
  ctx: Ctx,
  userId: string,
): Promise<RoleArchetype | null> {
  const rows = (await tx.execute(sql`
    select r.archetype from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = ${ctx.orgId} and m.user_id = ${userId} and m.deactivated_at is null
  `)) as unknown as Array<{ archetype: RoleArchetype }>;
  return rows[0]?.archetype ?? null;
}

async function membersOfArchetypeIn(tx: TenantTx, ctx: Ctx, archetype: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select m.user_id::text as user_id from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = ${ctx.orgId} and r.archetype = ${archetype} and m.deactivated_at is null
  `)) as unknown as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

type ResolvedAssignee = { userId: string | null; archetype: RoleArchetype };

async function resolveAssigneeIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  a: Assignee,
): Promise<ResolvedAssignee | null> {
  if (a.type === "archetype") return { userId: null, archetype: a.value };
  if (a.type === "user") {
    const arch = await archetypeOfUserIn(tx, ctx, a.value);
    return arch ? { userId: a.value, archetype: arch } : null;
  }
  if (a.type === "document_owner") {
    const owner = d.ownerUserId;
    if (!owner) return null;
    const arch = await archetypeOfUserIn(tx, ctx, owner);
    return arch ? { userId: owner, archetype: arch } : null;
  }
  return null; // counterparty: only meaningful for signature steps
}

// ── start ─────────────────────────────────────────────────────────────────────
/**
 * Start a run for a document leaving draft. Returns null when no workflow
 * applies (the document's own, else its template's default).
 */
export async function startRunIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  rev: RevisionRow,
): Promise<{ runId: string; initialStatus: DocStatus } | null> {
  let workflowId = d.workflowId;
  if (!workflowId && d.templateId) {
    const t = (await tx.execute(sql`
      select workflow_id::text as workflow_id from public.doc_template
      where id = ${d.templateId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ workflow_id: string | null }>;
    workflowId = t[0]?.workflow_id ?? null;
  }
  if (!workflowId) return null;
  const w = await loadWorkflowIn(tx, ctx, workflowId);
  if (w.status !== "active") throw new DocError("the document's workflow is retired", "state");
  if (w.definition.steps.length === 0) return null;
  const rows = (await tx.execute(sql`
    insert into public.doc_workflow_run
      (org_id, document_id, revision_id, workflow_id, definition, started_by, created_by)
    values (${ctx.orgId}, ${d.id}, ${rev.id}, ${w.id}, ${JSON.stringify(w.definition)}::jsonb, ${ctx.userId}, ${ctx.userId})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const runId = rows[0]!.id;
  await appendEventIn(tx, ctx, {
    documentId: d.id,
    kind: "approval_started",
    payload: { runId, workflowId: w.id, steps: w.definition.steps.length },
  });
  const run = await loadRunIn(tx, ctx, runId);
  const first = await activateStepIn(tx, ctx, run, d, rev, 0);
  return { runId, initialStatus: first };
}

/** Activate step `index` (skipping conditional steps that do not apply). Returns the document status to hold. */
async function activateStepIn(
  tx: TenantTx,
  ctx: Ctx,
  run: RunRow,
  d: DocumentRow,
  rev: RevisionRow,
  index: number,
): Promise<DocStatus> {
  const facts = runFacts(d, rev);
  let i = index;
  while (i < run.definition.steps.length) {
    const step = run.definition.steps[i]!;
    await tx.execute(sql`
      update public.doc_workflow_run set current_step_index = ${i}, row_version = row_version + 1
      where id = ${run.id} and org_id = ${ctx.orgId}
    `);
    if (step.condition && !evaluateConditions(step.condition, facts)) {
      await tx.execute(sql`
        insert into public.doc_workflow_step_run (org_id, run_id, document_id, step_id, step_index, kind, status, created_by)
        values (${ctx.orgId}, ${run.id}, ${d.id}, ${step.id}, ${i}, ${step.kind}, 'skipped', ${ctx.userId})
      `);
      i += 1;
      continue;
    }
    if (step.kind === "signature") {
      await tx.execute(sql`
        update public.doc_workflow_run set requires_signature = true where id = ${run.id} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        insert into public.doc_workflow_step_run (org_id, run_id, document_id, step_id, step_index, kind, status, note, created_by)
        values (${ctx.orgId}, ${run.id}, ${d.id}, ${step.id}, ${i}, 'signature', 'completed', 'signatures are collected after issue', ${ctx.userId})
      `);
      i += 1;
      continue;
    }
    const assignees: ResolvedAssignee[] = [];
    for (const a of step.assignees) {
      const r = await resolveAssigneeIn(tx, ctx, d, a);
      if (r) assignees.push(r);
    }
    if (assignees.length === 0)
      throw new DocError(`step "${step.id}" has no reachable assignee`, "validation");
    const toActivate = step.mode === "parallel" ? assignees : assignees.slice(0, 1);
    const toQueue = step.mode === "parallel" ? [] : assignees.slice(1);
    for (const a of toActivate) await openStepRunIn(tx, ctx, run, d, step, i, a, "active");
    for (const a of toQueue) await openStepRunIn(tx, ctx, run, d, step, i, a, "pending");
    return step.kind === "approval" ? "approval" : "review";
  }
  await completeRunIn(tx, ctx, run.id, d.id);
  return "approval";
}

async function openStepRunIn(
  tx: TenantTx,
  ctx: Ctx,
  run: RunRow,
  d: DocumentRow,
  step: WorkflowStep,
  index: number,
  a: ResolvedAssignee,
  status: "active" | "pending",
): Promise<string> {
  const dueAt =
    step.dueDays !== undefined
      ? new Date(Date.now() + step.dueDays * 86_400_000).toISOString()
      : null;
  const rows = (await tx.execute(sql`
    insert into public.doc_workflow_step_run
      (org_id, run_id, document_id, step_id, step_index, kind, status, assignee_user_id, assignee_archetype, due_at, created_by)
    values (${ctx.orgId}, ${run.id}, ${d.id}, ${step.id}, ${index}, ${step.kind}, ${status}, ${a.userId}, ${a.archetype},
            ${dueAt}::timestamptz, ${ctx.userId})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const stepRunId = rows[0]!.id;
  if (status === "active") await notifyAndOpenIn(tx, ctx, d, step, stepRunId, a);
  return stepRunId;
}

/** An active step: an approval row for approval steps, a notification for review steps. */
async function notifyAndOpenIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  step: WorkflowStep,
  stepRunId: string,
  a: ResolvedAssignee,
): Promise<void> {
  const title = `${d.reference} ${d.title}`;
  if (step.kind === "approval") {
    const res = await submitForApproval(tx, ctx, {
      subjectType: "document_step",
      subjectId: stepRunId,
      subjectSummary: { title },
      assign: { role: a.archetype, userId: a.userId },
    });
    await tx.execute(sql`
      update public.doc_workflow_step_run set approval_id = ${res.approvalId}
      where id = ${stepRunId} and org_id = ${ctx.orgId}
    `);
    return;
  }
  const recipients = a.userId ? [a.userId] : await membersOfArchetypeIn(tx, ctx, a.archetype);
  for (const userId of recipients) {
    if (userId === ctx.userId) continue;
    await createNotificationIn(tx, ctx, {
      recipientUserId: userId,
      kind: "document_review_requested",
      title,
      entityType: "document",
      entityId: d.id,
    });
  }
}

// ── advance ───────────────────────────────────────────────────────────────────
/** Called by the approvals engine (afterDecide) once the step run moved; also by review decisions. */
export async function onStepDecidedIn(
  tx: TenantTx,
  ctx: Ctx,
  stepRunId: string,
  outcome: "approved" | "rejected",
  note: string | null,
): Promise<void> {
  const rows = (await tx.execute(sql`
    update public.doc_workflow_step_run
    set decided_by = ${ctx.userId}, decided_at = now(), decision = ${outcome}, note = coalesce(${note}, note),
        row_version = row_version + 1
    where id = ${stepRunId} and org_id = ${ctx.orgId}
    returning run_id::text as run_id, document_id::text as document_id, step_index
  `)) as unknown as Array<{ run_id: string; document_id: string; step_index: number }>;
  const r = rows[0];
  if (!r) throw new DocError("step run not found", "not_found");
  await appendEventIn(tx, ctx, {
    documentId: r.document_id,
    kind: "approval_step_decided",
    payload: { stepRunId, outcome, note },
  });
  await recordActivityIn(tx, ctx, {
    entityType: "document",
    entityId: r.document_id,
    verb: outcome === "approved" ? "approved" : "rejected",
    summary: `${outcome} a workflow step`,
  });
  await advanceIn(tx, ctx, r.run_id);
}

async function advanceIn(tx: TenantTx, ctx: Ctx, runId: string): Promise<void> {
  const run = await loadRunIn(tx, ctx, runId, true);
  if (run.status !== "running") return;
  const d = await loadDocIn(tx, ctx, run.documentId, true);
  const rev = await loadRevisionIn(tx, ctx, run.revisionId);
  const step = run.definition.steps[run.currentStepIndex];
  if (!step) {
    await completeRunIn(tx, ctx, run.id, d.id);
    return;
  }
  const mine = run.steps.filter(
    (s) => s.stepIndex === run.currentStepIndex && s.status !== "skipped",
  );
  if (mine.some((s) => s.status === "rejected")) {
    await rejectRunIn(
      tx,
      ctx,
      run,
      d,
      step,
      mine.find((s) => s.status === "rejected")?.note ?? null,
    );
    return;
  }
  const completed = mine.filter((s) => s.status === "completed").length;
  const pending = mine.filter((s) => s.status === "pending");
  const active = mine.filter((s) => s.status === "active");
  const needed = step.mode === "parallel" ? (step.quorum ?? mine.length) : mine.length;
  if (completed >= needed) {
    // Quorum met: retire any remaining live approvals for this step.
    if (active.length > 0) {
      const ids = active.map((s) => s.id);
      await tx.execute(sql`
        update public.doc_workflow_step_run set status = 'cancelled', row_version = row_version + 1
        where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and org_id = ${ctx.orgId}
      `);
      await supersedeApprovalsForSubjectsIn(tx, ctx, {
        subjectType: "document_step",
        subjectIds: ids,
        reason: "quorum reached",
      });
    }
    const next = await activateStepIn(tx, ctx, run, d, rev, run.currentStepIndex + 1);
    if (next !== d.status && (next === "review" || next === "approval")) {
      await tx.execute(sql`
        update public.doc_document set status = ${next}, row_version = row_version + 1
        where id = ${d.id} and org_id = ${ctx.orgId} and status in ('review', 'approval')
      `);
    }
    return;
  }
  if (active.length === 0 && pending.length > 0) {
    // Sequential: hand to the next queued assignee.
    const nextRun = pending[0]!;
    await tx.execute(sql`
      update public.doc_workflow_step_run set status = 'active', row_version = row_version + 1
      where id = ${nextRun.id} and org_id = ${ctx.orgId}
    `);
    await notifyAndOpenIn(tx, ctx, d, step, nextRun.id, {
      userId: nextRun.assigneeUserId,
      archetype: (nextRun.assigneeArchetype ?? "owner") as RoleArchetype,
    });
  }
}

async function completeRunIn(
  tx: TenantTx,
  ctx: Ctx,
  runId: string,
  documentId: string,
): Promise<void> {
  await tx.execute(sql`
    update public.doc_workflow_run set status = 'completed', finished_at = now(), row_version = row_version + 1
    where id = ${runId} and org_id = ${ctx.orgId} and status = 'running'
  `);
  await tx.execute(sql`
    update public.doc_document set status = 'approval', row_version = row_version + 1
    where id = ${documentId} and org_id = ${ctx.orgId} and status in ('review', 'approval')
  `);
  await appendEventIn(tx, ctx, { documentId, kind: "approval_completed", payload: { runId } });
  const starter = (await tx.execute(sql`
    select started_by::text as started_by from public.doc_workflow_run where id = ${runId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ started_by: string }>;
  if (starter[0] && starter[0].started_by !== ctx.userId) {
    await createNotificationIn(tx, ctx, {
      recipientUserId: starter[0].started_by,
      kind: "approval_decided",
      title: "Document approval completed",
      entityType: "document",
      entityId: documentId,
    });
  }
}

async function rejectRunIn(
  tx: TenantTx,
  ctx: Ctx,
  run: RunRow,
  d: DocumentRow,
  step: WorkflowStep,
  note: string | null,
): Promise<void> {
  const live = run.steps.filter((s) => s.status === "active" || s.status === "pending");
  if (live.length > 0) {
    const ids = live.map((s) => s.id);
    await tx.execute(sql`
      update public.doc_workflow_step_run set status = 'cancelled', row_version = row_version + 1
      where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and org_id = ${ctx.orgId}
    `);
    await supersedeApprovalsForSubjectsIn(tx, ctx, {
      subjectType: "document_step",
      subjectIds: ids,
      reason: "step rejected",
    });
  }
  await tx.execute(sql`
    update public.doc_workflow_run set status = 'rejected', finished_at = now(), outcome_note = ${note},
      row_version = row_version + 1
    where id = ${run.id} and org_id = ${ctx.orgId} and status = 'running'
  `);
  await appendEventIn(tx, ctx, {
    documentId: d.id,
    kind: "approval_rejected",
    payload: { runId: run.id, note },
  });
  // Back to draft with a fresh working revision (the default), or stop and stay reviewable.
  await tx.execute(sql`
    update public.doc_document set status = 'draft', row_version = row_version + 1
    where id = ${d.id} and org_id = ${ctx.orgId} and status in ('review', 'approval')
  `);
  if (step.onReject === "return_to_draft") {
    await openWorkingIn(tx, ctx, await loadDocIn(tx, ctx, d.id));
  }
  if (run.startedBy !== ctx.userId) {
    await createNotificationIn(tx, ctx, {
      recipientUserId: run.startedBy,
      kind: "approval_decided",
      title: "Document approval rejected",
      body: note ?? undefined,
      entityType: "document",
      entityId: d.id,
    });
  }
}

/** Cancel the running run (the document was returned or withdrawn). */
export async function cancelRunIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
  reason: string,
): Promise<void> {
  const runs = (await tx.execute(sql`
    select id::text as id from public.doc_workflow_run
    where document_id = ${documentId} and org_id = ${ctx.orgId} and status = 'running'
  `)) as unknown as Array<{ id: string }>;
  for (const r of runs) {
    const run = await loadRunIn(tx, ctx, r.id, true);
    const live = run.steps.filter((s) => s.status === "active" || s.status === "pending");
    if (live.length > 0) {
      const ids = live.map((s) => s.id);
      await tx.execute(sql`
        update public.doc_workflow_step_run set status = 'cancelled', row_version = row_version + 1
        where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and org_id = ${ctx.orgId}
      `);
      await supersedeApprovalsForSubjectsIn(tx, ctx, {
        subjectType: "document_step",
        subjectIds: ids,
        reason,
      });
    }
    await tx.execute(sql`
      update public.doc_workflow_run set status = 'cancelled', finished_at = now(), outcome_note = ${reason},
        row_version = row_version + 1
      where id = ${run.id} and org_id = ${ctx.orgId} and status = 'running'
    `);
  }
}

// ── decisions on review steps, delegation ─────────────────────────────────────
async function assertMayActOn(
  tx: TenantTx,
  ctx: Ctx,
  archetype: RoleArchetype,
  step: StepRunRow,
  run: RunRow,
): Promise<void> {
  if (step.status !== "active") throw new DocError("this step is not active", "state");
  const def = run.definition.steps[step.stepIndex];
  const owner = archetype === "owner" || archetype === "admin";
  const named = step.assigneeUserId
    ? step.assigneeUserId === ctx.userId
    : step.assigneeArchetype === archetype;
  if (!owner && !named) throw new DocError("this step is not assigned to you", "forbidden");
  if (def?.separationOfDuties !== false && run.startedBy === ctx.userId)
    throw new DocError("the person who submitted cannot decide this step", "forbidden");
}

export const DecideReviewInput = z
  .object({
    stepRunId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function decideReviewStep(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.review");
  const input = DecideReviewInput.parse(raw);
  if (input.decision === "rejected" && !input.note)
    throw new DocError("a rejection needs a note", "validation");
  return command(
    ctx,
    {
      audit: {
        action: "documents.review.decide",
        entityType: "document",
        entityId: input.stepRunId,
        summary: `Review step ${input.decision}`,
        after: { note: input.note ?? null },
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select ${STEP_COLUMNS} from public.doc_workflow_step_run s
        where s.id = ${input.stepRunId} and s.org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, unknown>>;
      if (!rows[0]) throw new DocError("step run not found", "not_found");
      const step = mapStep(rows[0]);
      if (step.kind !== "review")
        throw new DocError("approval steps are decided from the approvals inbox", "state");
      const run = await loadRunIn(tx, ctx, step.runId);
      await assertMayActOn(tx, ctx, archetype, step, run);
      const moved = (await tx.execute(sql`
        update public.doc_workflow_step_run set status = ${input.decision === "approved" ? "completed" : "rejected"},
          row_version = row_version + 1
        where id = ${step.id} and org_id = ${ctx.orgId} and status = 'active'
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!moved[0]) throw new DocError("step was decided concurrently", "conflict");
      await onStepDecidedIn(tx, ctx, step.id, input.decision, input.note ?? null);
      return { id: step.id };
    },
  );
}

export const DelegateStepInput = z
  .object({
    stepRunId: z.string().uuid(),
    toUserId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export async function delegateStep(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.review");
  const input = DelegateStepInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.workflow.delegate",
        entityType: "document",
        entityId: input.stepRunId,
        summary: "Delegated a workflow step",
        after: { toUserId: input.toUserId },
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select ${STEP_COLUMNS} from public.doc_workflow_step_run s
        where s.id = ${input.stepRunId} and s.org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, unknown>>;
      if (!rows[0]) throw new DocError("step run not found", "not_found");
      const step = mapStep(rows[0]);
      const run = await loadRunIn(tx, ctx, step.runId);
      const def = run.definition.steps[step.stepIndex];
      if (!def || def.allowDelegate === false)
        throw new DocError("this step cannot be delegated", "state");
      await assertMayActOn(tx, ctx, archetype, step, run);
      const arch = await archetypeOfUserIn(tx, ctx, input.toUserId);
      if (!arch) throw new DocError("that person is not an active member", "validation");
      if (input.toUserId === run.startedBy)
        throw new DocError("cannot delegate to the submitter", "validation");
      if (step.kind === "approval") {
        await supersedeApprovalsForSubjectsIn(tx, ctx, {
          subjectType: "document_step",
          subjectIds: [step.id],
          reason: "delegated",
        });
      }
      await tx.execute(sql`
        update public.doc_workflow_step_run
        set assignee_user_id = ${input.toUserId}, assignee_archetype = ${arch}, delegated_from = ${ctx.userId},
            note = ${input.note ?? null}, row_version = row_version + 1
        where id = ${step.id} and org_id = ${ctx.orgId}
      `);
      const d = await loadDocIn(tx, ctx, step.documentId);
      await notifyAndOpenIn(tx, ctx, d, def, step.id, { userId: input.toUserId, archetype: arch });
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "approval_step_decided",
        payload: { stepRunId: step.id, delegatedTo: input.toUserId },
      });
      return { id: step.id };
    },
  );
}

// ── reads ─────────────────────────────────────────────────────────────────────
export async function getRunForDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<RunRow | null> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => latestRunIn(tx, ctx, documentId));
}

export async function getStepRun(
  ctx: Ctx,
  archetype: RoleArchetype,
  stepRunId: string,
): Promise<StepRunRow> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select ${STEP_COLUMNS} from public.doc_workflow_step_run s
      where s.id = ${stepRunId} and s.org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new DocError("step run not found", "not_found");
  return mapStep(rows[0]);
}

export type MyStep = StepRunRow & {
  reference: string;
  title: string;
  stepName: { en?: string; ar?: string };
};

/** Active review/approval steps waiting on the acting person (by name or by archetype). */
export async function listMySteps(ctx: Ctx, archetype: RoleArchetype): Promise<MyStep[]> {
  if (!can(archetype, "documents.view")) return [];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select ${STEP_COLUMNS}, d.reference, d.title, r.definition
      from public.doc_workflow_step_run s
      join public.doc_document d on d.id = s.document_id and d.org_id = s.org_id
      join public.doc_workflow_run r on r.id = s.run_id and r.org_id = s.org_id
      where s.org_id = ${ctx.orgId} and s.status = 'active'
        and (s.assignee_user_id = ${ctx.userId}
             or (s.assignee_user_id is null and s.assignee_archetype = ${archetype}))
      order by s.due_at nulls last, s.created_at
      limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const def = WorkflowDefinition.safeParse(r.definition).data;
    const step = def?.steps[Number(r.step_index)];
    return {
      ...mapStep(r),
      reference: r.reference as string,
      title: r.title as string,
      stepName: step?.name ?? {},
    };
  });
}
