/**
 * Approvals module — the unified approval engine (doc 05). ONE engine for every
 * draft→decide flow. Core invariants:
 *  - the `approval` row is the first-class decision record; the SUBJECT keeps its
 *    own status enum (D-5.1). The engine is the SOLE WRITER of BOTH transitions in
 *    ONE transaction — a CI invariant asserts no subject in a decided-implying
 *    state lacks a matching decided approval.
 *  - single-approver threshold routing (D-5.2): exactly one rule fires, most-
 *    specific wins; config-time ambiguity is rejected (validateRules).
 *  - self-approval guard (F-4): decided_by ≠ requested_by; escalate one role up
 *    when the requester is the sole eligible approver; terminal Owner self-approval
 *    is permitted but stamped self_approved.
 *  - amounts in subject_summary are COST data — redacted at the serialization
 *    boundary for non-finance viewers (F-23), including notification bodies (which
 *    carry NO amount at all).
 *
 * S4 wires material_request + purchase_order subjects. expense/quote_send/payment
 * are registered (D-5.3) but wired by later slices — the engine is generic.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can, ForbiddenError } from "@/platform/authz";
import {
  emitEvent,
  APPROVAL_SUBMITTED,
  APPROVAL_DECIDED,
  PURCHASE_ORDER_APPROVED,
  EXCEPTION_RAISED,
} from "@/platform/events";
import { createNotificationIn } from "@/platform/notifications";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`approval ${id} not found`);
    this.name = "ApprovalNotFoundError";
  }
}
export class ApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalStateError";
  }
}
export class SelfApprovalError extends Error {
  constructor() {
    super("a requester may not decide their own approval");
    this.name = "SelfApprovalError";
  }
}
export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleValidationError";
  }
}
export class ApprovalAlreadyPendingError extends Error {
  constructor() {
    super("this subject already has a pending approval");
    this.name = "ApprovalAlreadyPendingError";
  }
}

// ── subject dispatch: how the engine advances each subject's OWN status ───────
// The engine writes the subject status directly (D-5.1 sole-writer). Keeping the
// map here — not importing the supply module — avoids a cycle: supply→approvals
// (submitForApproval) is the only module edge.
type SubjectConfig = {
  table: string;
  onApprove: string;
  onReject: string;
  onWithdraw: string;
};
const SUBJECTS: Record<string, SubjectConfig> = {
  material_request: {
    table: "material_request",
    onApprove: "approved",
    onReject: "rejected",
    onWithdraw: "draft",
  },
  purchase_order: {
    table: "purchase_order",
    onApprove: "approved",
    onReject: "draft",
    onWithdraw: "draft",
  },
};

// ── role escalation (F-4): one step up until a non-requester decider exists ───
const ESCALATE_UP: Record<string, RoleArchetype> = {
  viewer: "manager",
  foreman: "manager",
  accounts: "admin",
  procurement: "admin",
  manager: "admin",
  admin: "owner",
  owner: "owner",
};

async function countEligibleDeciders(
  tx: TenantTx,
  ctx: Ctx,
  role: string,
  excludeUserId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n
    from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = ${ctx.orgId} and r.archetype = ${role}
      and m.deactivated_at is null and m.user_id <> ${excludeUserId}
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

// ── rule resolution (D-5.2): most-specific active rule for a subject ──────────
type RuleRow = {
  id: string;
  condition_kind: string;
  amount_gte_minor: string | null;
  urgency_in: string[] | null;
  assigned_role: string;
  auto_approve_below_minor: string | null;
};

async function loadActiveRules(tx: TenantTx, ctx: Ctx, subjectType: string): Promise<RuleRow[]> {
  return (await tx.execute(sql`
    select id::text as id, condition_kind, amount_gte_minor::text as amount_gte_minor,
           urgency_in, assigned_role, auto_approve_below_minor::text as auto_approve_below_minor
    from public.approval_rule
    where org_id = ${ctx.orgId} and subject_type = ${subjectType} and active = true
    order by id
  `)) as unknown as RuleRow[];
}

// The config-time ambiguity check as an IN-TRANSACTION predicate (throws) — run
// inside the rule-create command so a rejected set ROLLS BACK the insert (review).
function assertRuleSetUnambiguous(rules: RuleRow[]): void {
  if (rules.filter((r) => r.condition_kind === "always").length > 1) {
    throw new RuleValidationError("two 'always' rules for the same subject");
  }
  const byThreshold = new Map<string, number>();
  for (const r of rules.filter((x) => x.condition_kind === "amount_gte")) {
    const k = String(r.amount_gte_minor);
    byThreshold.set(k, (byThreshold.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byThreshold) {
    if (n > 1) throw new RuleValidationError(`two amount_gte rules at threshold ${k}`);
  }
  const seenUrgency = new Set<string>();
  for (const r of rules.filter((x) => x.condition_kind === "urgency_in")) {
    for (const u of r.urgency_in ?? []) {
      if (seenUrgency.has(u)) throw new RuleValidationError(`urgency '${u}' matched by two rules`);
      seenUrgency.add(u);
    }
  }
}

/** Does a rule's condition match this subject? */
function ruleMatches(r: RuleRow, amountMinor: number | null, urgency: string | null): boolean {
  if (r.condition_kind === "always") return true;
  if (r.condition_kind === "amount_gte") {
    return (
      amountMinor !== null &&
      r.amount_gte_minor !== null &&
      amountMinor >= Number(r.amount_gte_minor)
    );
  }
  if (r.condition_kind === "urgency_in") {
    return urgency !== null && (r.urgency_in ?? []).includes(urgency);
  }
  return false;
}

/** Specificity ranking (higher = more specific): amount_gte(by threshold) > urgency_in > always. */
function specificity(r: RuleRow): number {
  if (r.condition_kind === "amount_gte") return 1_000_000 + Number(r.amount_gte_minor ?? 0);
  if (r.condition_kind === "urgency_in") return 1000;
  return 1; // always
}

type Resolved = { rule: RuleRow | null; assignedRole: string; autoApprove: boolean };

function resolveRule(
  rules: RuleRow[],
  amountMinor: number | null,
  urgency: string | null,
): Resolved {
  const matching = rules.filter((r) => ruleMatches(r, amountMinor, urgency));
  if (matching.length === 0) {
    // No rule matched — SAFE DEFAULT: route to owner (never auto-approve).
    return { rule: null, assignedRole: "owner", autoApprove: false };
  }
  matching.sort((a, b) => specificity(b) - specificity(a));
  const rule = matching[0]!;
  const autoApprove =
    rule.auto_approve_below_minor !== null &&
    amountMinor !== null &&
    amountMinor < Number(rule.auto_approve_below_minor);
  return { rule, assignedRole: rule.assigned_role, autoApprove };
}

/**
 * Validate an org's rule set for a subject_type (config-time). Ambiguity — two
 * matching rules of EQUAL specificity for some input — is a validation error
 * (D-5.2: ties are rejected at config time, never resolved at runtime).
 */
export async function validateRules(
  ctx: Ctx,
  archetype: RoleArchetype,
  subjectType: string,
): Promise<{ ok: true }> {
  assertCan(archetype, "config.manage");
  const rules = await withCtx(ctx, (tx) => loadActiveRules(tx, ctx, subjectType));
  assertRuleSetUnambiguous(rules);
  return { ok: true };
}

// ── rule management (owner/admin; org-editable, config-audited) ──────────────
export const CreateRuleInput = z.object({
  subjectType: z.enum(["material_request", "expense", "quote_send", "purchase_order", "payment"]),
  conditionKind: z.enum(["always", "amount_gte", "urgency_in"]),
  amountGteMinor: z.number().int().min(0).optional(),
  urgencyIn: z.array(z.string().min(1).max(20)).optional(),
  assignedRole: z.enum([
    "owner",
    "admin",
    "manager",
    "foreman",
    "procurement",
    "accounts",
    "viewer",
  ]),
  autoApproveBelowMinor: z.number().int().min(0).optional(),
});

export async function createApprovalRule(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "config.manage");
  const data = CreateRuleInput.parse(input);
  if (data.conditionKind === "amount_gte" && data.amountGteMinor == null) {
    throw new RuleValidationError("amount_gte requires amountGteMinor");
  }
  if (data.conditionKind === "urgency_in" && !data.urgencyIn?.length) {
    throw new RuleValidationError("urgency_in requires a non-empty urgencyIn");
  }
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "approval_rule.create",
        entityType: "approval_rule",
        entityId: id,
        summary: `Approval rule for ${data.subjectType} → ${data.assignedRole}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.approval_rule
          (id, org_id, subject_type, condition_kind, amount_gte_minor, urgency_in, assigned_role,
           auto_approve_below_minor)
        values (${id}, ${ctx.orgId}, ${data.subjectType}, ${data.conditionKind},
                ${data.amountGteMinor ?? null},
                ${data.urgencyIn ? sql`${data.urgencyIn}::text[]` : sql`null`},
                ${data.assignedRole}, ${data.autoApproveBelowMinor ?? null})
      `);
      // Config-time ambiguity guard (D-5.2) INSIDE the tx — a rejected set rolls
      // the insert back, so an ambiguous rule never persists live (review fix).
      const rules = await loadActiveRules(tx, ctx, data.subjectType);
      assertRuleSetUnambiguous(rules);
      return { id };
    },
  );
  return { id };
}

export type RuleRowDto = {
  id: string;
  subjectType: string;
  conditionKind: string;
  amountGteMinor: string | null;
  urgencyIn: string[] | null;
  assignedRole: string;
  autoApproveBelowMinor: string | null;
  active: boolean;
};
export async function listApprovalRules(ctx: Ctx, archetype: RoleArchetype): Promise<RuleRowDto[]> {
  assertCan(archetype, "config.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, subject_type, condition_kind,
             amount_gte_minor::text as amount_gte_minor, urgency_in, assigned_role,
             auto_approve_below_minor::text as auto_approve_below_minor, active
      from public.approval_rule where org_id = ${ctx.orgId}
      order by subject_type, condition_kind
    `),
  )) as unknown as Array<{
    id: string;
    subject_type: string;
    condition_kind: string;
    amount_gte_minor: string | null;
    urgency_in: string[] | null;
    assigned_role: string;
    auto_approve_below_minor: string | null;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    conditionKind: r.condition_kind,
    amountGteMinor: r.amount_gte_minor,
    urgencyIn: r.urgency_in,
    assignedRole: r.assigned_role,
    autoApproveBelowMinor: r.auto_approve_below_minor,
    active: r.active,
  }));
}

export type SubmitForApprovalParams = {
  subjectType: string;
  subjectId: string;
  subjectSummary: { title: string; amountMinor?: number | null; jobRef?: string | null };
  amountMinor?: number | null;
  urgency?: string | null;
  /** When true, the subject was auto-approved (e.g. an MR→PO conversion of an
   * already-approved MR) — skip routing, create an already-approved approval. */
  preApproved?: boolean;
};

/**
 * IN-TRANSACTION: create the approval row for a subject the caller has just put
 * into its pending state (same command tx — atomic submission, D-5.1). Resolves
 * the rule, applies the self-approval escalation, pushes REDACTED notifications to
 * the assigned role, and emits approval/submitted. Returns the routing outcome so
 * the caller can advance/record accordingly. Auto-approve (or preApproved) creates
 * an already-approved approval and returns {decided:true}.
 */
export async function submitForApproval(
  tx: TenantTx,
  ctx: Ctx,
  params: SubmitForApprovalParams,
): Promise<{ approvalId: string; assignedRole: string; decided: boolean }> {
  const approvalId = randomUUID();
  const amount = params.amountMinor ?? params.subjectSummary.amountMinor ?? null;

  if (params.preApproved) {
    // e.g. a PO created from an already-approved MR (D-5.3: auto-approves its PO).
    await tx.execute(sql`
      insert into public.approval
        (id, org_id, subject_type, subject_id, subject_summary, requested_by, assigned_role,
         state, decided_by, decided_at, self_approved)
      values (${approvalId}, ${ctx.orgId}, ${params.subjectType}, ${params.subjectId},
              ${JSON.stringify(params.subjectSummary)}::jsonb, ${ctx.userId}, 'owner',
              'approved', ${ctx.userId}, now(), false)
    `);
    await emitEvent(tx, ctx, {
      name: APPROVAL_DECIDED,
      payload: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        approvalId,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        outcome: "approved" as const,
      },
    });
    return { approvalId, assignedRole: "owner", decided: true };
  }

  const rules = await loadActiveRules(tx, ctx, params.subjectType);
  const resolved = resolveRule(rules, amount, params.urgency ?? null);

  // Auto-approve below threshold (off by default, D-5.3): create an already-
  // approved approval attributed to the submission (self_approved stays false —
  // it is a RULE decision, not a human self-decision).
  if (resolved.autoApprove) {
    await tx.execute(sql`
      insert into public.approval
        (id, org_id, subject_type, subject_id, subject_summary, rule_id, requested_by,
         assigned_role, state, decided_by, decided_at, decision_note, self_approved)
      values (${approvalId}, ${ctx.orgId}, ${params.subjectType}, ${params.subjectId},
              ${JSON.stringify(params.subjectSummary)}::jsonb, ${resolved.rule?.id ?? null}, ${ctx.userId},
              ${resolved.assignedRole}, 'approved', ${ctx.userId}, now(),
              'auto-approved (below configured threshold)', false)
    `);
    await emitEvent(tx, ctx, {
      name: APPROVAL_DECIDED,
      payload: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        approvalId,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        outcome: "approved" as const,
      },
    });
    return { approvalId, assignedRole: resolved.assignedRole, decided: true };
  }

  // Self-approval escalation (F-4): step up until a non-requester decider exists.
  let role = resolved.assignedRole;
  let guard = 0;
  while (
    role !== "owner" &&
    (await countEligibleDeciders(tx, ctx, role, ctx.userId)) === 0 &&
    guard < 6
  ) {
    role = ESCALATE_UP[role] ?? "owner";
    guard++;
  }

  try {
    await tx.execute(sql`
      insert into public.approval
        (id, org_id, subject_type, subject_id, subject_summary, rule_id, requested_by,
         assigned_role, state)
      values (${approvalId}, ${ctx.orgId}, ${params.subjectType}, ${params.subjectId},
              ${JSON.stringify(params.subjectSummary)}::jsonb, ${resolved.rule?.id ?? null},
              ${ctx.userId}, ${role}, 'pending')
    `);
  } catch (err) {
    // A concurrent submit already opened the ONE live approval (0037 partial
    // unique) — reject the duplicate cleanly (exactly-one-pending invariant).
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (cause?.code === "23505" && cause.constraint_name === "approval_one_live_per_subject") {
      throw new ApprovalAlreadyPendingError();
    }
    throw err;
  }

  // Push a REDACTED notification (NO amount, F-23) to every OTHER member of the
  // assigned role, in this same tx (atomic submission).
  const members = (await tx.execute(sql`
    select m.user_id::text as user_id
    from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = ${ctx.orgId} and r.archetype = ${role}
      and m.deactivated_at is null and m.user_id <> ${ctx.userId}
  `)) as unknown as Array<{ user_id: string }>;
  for (const m of members) {
    await createNotificationIn(tx, ctx, {
      recipientUserId: m.user_id,
      kind: "approval_requested",
      title: `${params.subjectSummary.title} — awaiting approval`,
      body: params.subjectSummary.jobRef ? `Job ${params.subjectSummary.jobRef}` : undefined,
      entityType: "approval",
      entityId: approvalId,
    });
  }

  await emitEvent(tx, ctx, {
    name: APPROVAL_SUBMITTED,
    payload: {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      approvalId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      assignedRole: role,
    },
  });
  return { approvalId, assignedRole: role, decided: false };
}

// ── decide (approve/reject) — advances BOTH records atomically ───────────────
type ApprovalRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  assigned_role: string;
  assigned_user_id: string | null;
  requested_by: string;
  state: string;
};

async function loadApproval(tx: TenantTx, ctx: Ctx, id: string): Promise<ApprovalRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id, subject_type, subject_id::text as subject_id, assigned_role,
           assigned_user_id::text as assigned_user_id, requested_by::text as requested_by, state
    from public.approval where id = ${id} and org_id = ${ctx.orgId}
  `)) as unknown as ApprovalRow[];
  return rows[0] ?? null;
}

export async function decideApproval(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: { approvalId: string; decision: "approved" | "rejected"; note?: string },
): Promise<{ id: string; subjectType: string; subjectId: string; outcome: string }> {
  assertCan(archetype, "approvals.decide");
  if (input.decision === "rejected" && !input.note?.trim()) {
    throw new ApprovalStateError("a rejection requires a reason");
  }
  return command<{
    id: string;
    subjectType: string;
    subjectId: string;
    outcome: string;
    selfApproved: boolean;
  }>(
    ctx,
    {
      audit: (r) => ({
        action: "approval.decide",
        entityType: "approval",
        entityId: r.id,
        summary: `Approval ${r.outcome}${r.selfApproved ? " (self-approved)" : ""} (${r.subjectType})`,
      }),
      activity: (r) => ({
        entityType: r.subjectType === "purchase_order" ? "purchase_order" : "material_request",
        entityId: r.subjectId,
        verb: r.outcome === "approved" ? "approved" : "rejected",
        summary: `${r.outcome} the ${r.subjectType.replace("_", " ")}${r.selfApproved ? " (self-approved)" : ""}`,
      }),
      events: (r) => [
        {
          name: APPROVAL_DECIDED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            approvalId: r.id,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            outcome: r.outcome as "approved" | "rejected",
          },
        },
      ],
      // PURCHASE_ORDER_APPROVED (→ LPO PDF worker) is emitted inside fn where the
      // PO reference is available.
    },
    async (tx) => {
      const a = await loadApproval(tx, ctx, input.approvalId);
      if (!a) throw new ApprovalNotFoundError(input.approvalId);
      if (a.state !== "pending") {
        throw new ApprovalStateError(`only a pending approval can be decided (was ${a.state})`);
      }
      // Rule-scope (doc 06): owner/admin decide anything; manager/accounts only
      // approvals routed to THEIR role (or to them by assigned_user_id).
      const scoped = archetype === "owner" || archetype === "admin";
      if (!scoped && a.assigned_role !== archetype && a.assigned_user_id !== ctx.userId) {
        throw new ForbiddenError("approvals.decide");
      }
      // Self-approval guard (F-4): a requester may not decide their own approval,
      // UNLESS it terminally escalated to owner and the decider IS the owner.
      let selfApproved = false;
      if (a.requested_by === ctx.userId) {
        if (a.assigned_role === "owner" && archetype === "owner" && input.decision === "approved") {
          selfApproved = true; // terminal owner self-approval — permitted, stamped
        } else {
          throw new SelfApprovalError();
        }
      }
      // Guarded UPDATE (pending → decided) — RETURNING confirms the row moved and
      // returns the subject refs (avoids the SELECT-FOR-UPDATE-vs-policy trap).
      const updated = (await tx.execute(sql`
        update public.approval
        set state = ${input.decision}, decided_by = ${ctx.userId}, decided_at = now(),
            decision_note = ${input.note?.trim() ?? null}, self_approved = ${selfApproved},
            updated_at = now()
        where id = ${input.approvalId} and org_id = ${ctx.orgId} and state = 'pending'
        returning subject_type, subject_id::text as subject_id
      `)) as unknown as Array<{ subject_type: string; subject_id: string }>;
      const row = updated[0];
      if (!row) throw new ApprovalStateError("approval was concurrently decided");

      // SOLE WRITER: advance the SUBJECT's own status in the SAME tx (D-5.1).
      const cfg = SUBJECTS[row.subject_type];
      if (cfg) {
        const newStatus = input.decision === "approved" ? cfg.onApprove : cfg.onReject;
        const extra =
          row.subject_type === "purchase_order" && input.decision === "approved"
            ? sql`, approved_at = now()`
            : sql``;
        await tx.execute(
          sql`update public.${sql.raw(cfg.table)} set status = ${newStatus}${extra}, updated_at = now()
              where id = ${row.subject_id} and org_id = ${ctx.orgId}`,
        );
        // A newly-approved PO triggers the LPO PDF worker (needs the real ref).
        if (row.subject_type === "purchase_order" && input.decision === "approved") {
          const poRows = (await tx.execute(sql`
            select reference from public.purchase_order
            where id = ${row.subject_id} and org_id = ${ctx.orgId}
          `)) as unknown as Array<{ reference: string }>;
          await emitEvent(tx, ctx, {
            name: PURCHASE_ORDER_APPROVED,
            payload: {
              orgId: ctx.orgId,
              actorUserId: ctx.userId,
              purchaseOrderId: row.subject_id,
              reference: poRows[0]?.reference ?? row.subject_id,
            },
          });
        }
      }

      // Notify the requester of the outcome (redacted — no amount).
      await createNotificationIn(tx, ctx, {
        recipientUserId: a.requested_by,
        kind: "approval_decided",
        title: `Your request was ${input.decision}`,
        body: input.note?.trim() || undefined,
        entityType: "approval",
        entityId: a.id,
      });

      return {
        id: a.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        outcome: input.decision,
        selfApproved,
      };
    },
  );
}

export async function withdrawApproval(
  ctx: Ctx,
  archetype: RoleArchetype,
  approvalId: string,
): Promise<{ id: string }> {
  // Any submitter may withdraw their OWN pending approval (mr.create is the proxy
  // capability for "can create things that need approval"; the RLS + fn pin it to
  // the requester).
  assertCan(archetype, "mr.create");
  return command<{ id: string; subjectType: string; subjectId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "approval.withdraw",
        entityType: "approval",
        entityId: r.id,
        summary: `Withdrew approval (${r.subjectType})`,
      }),
      events: (r) => [
        {
          name: APPROVAL_DECIDED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            approvalId: r.id,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            outcome: "withdrawn" as const,
          },
        },
      ],
    },
    async (tx) => {
      const a = await loadApproval(tx, ctx, approvalId);
      if (!a) throw new ApprovalNotFoundError(approvalId);
      if (a.requested_by !== ctx.userId) {
        throw new ApprovalStateError("only the requester may withdraw their approval");
      }
      if (a.state !== "pending") {
        throw new ApprovalStateError(`only a pending approval can be withdrawn (was ${a.state})`);
      }
      const updated = (await tx.execute(sql`
        update public.approval set state = 'withdrawn', updated_at = now()
        where id = ${approvalId} and org_id = ${ctx.orgId} and state = 'pending'
          and requested_by = ${ctx.userId}
        returning subject_type, subject_id::text as subject_id
      `)) as unknown as Array<{ subject_type: string; subject_id: string }>;
      const row = updated[0];
      if (!row) throw new ApprovalStateError("approval was concurrently changed");
      const cfg = SUBJECTS[row.subject_type];
      if (cfg) {
        await tx.execute(
          sql`update public.${sql.raw(cfg.table)} set status = ${cfg.onWithdraw}, updated_at = now()
              where id = ${row.subject_id} and org_id = ${ctx.orgId}`,
        );
      }
      return { id: a.id, subjectType: row.subject_type, subjectId: row.subject_id };
    },
  ).then((r) => ({ id: r.id }));
}

// ── inbox + reads ─────────────────────────────────────────────────────────────
export type InboxRow = {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  /** Redacted to null for non-cost-privileged viewers (F-23). */
  amountMinor: string | null;
  jobRef: string | null;
  assignedRole: string;
  createdAt: string;
};

export async function listInbox(ctx: Ctx, archetype: RoleArchetype): Promise<InboxRow[]> {
  assertCan(archetype, "approvals.decide");
  const scoped = archetype === "owner" || archetype === "admin";
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, subject_type, subject_id::text as subject_id,
             subject_summary->>'title' as title,
             (subject_summary->>'amountMinor') as amount_minor,
             subject_summary->>'jobRef' as job_ref,
             assigned_role, created_at::text as created_at
      from public.approval
      where org_id = ${ctx.orgId} and state = 'pending'
        ${
          scoped
            ? sql``
            : sql`and (assigned_role = ${archetype} or assigned_user_id = ${ctx.userId})`
        }
      -- age × amount ordering (doc 05): older + bigger first. Amount used for the
      -- SORT only (server-side); the value is redacted from the DTO below.
      order by (extract(epoch from now() - created_at)
                * greatest(coalesce((subject_summary->>'amountMinor')::bigint, 1), 1)) desc
    `),
  )) as unknown as Array<{
    id: string;
    subject_type: string;
    subject_id: string;
    title: string;
    amount_minor: string | null;
    job_ref: string | null;
    assigned_role: string;
    created_at: string;
  }>;
  // Amount visibility rides "po.view" (the purchasing/finance roles) — a manager
  // decides MR approvals and must see the amount, though they aren't
  // cost-privileged; a foreman/viewer never sees supply money (F-23).
  const seesAmount = can(archetype, "po.view");
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    title: r.title,
    amountMinor: seesAmount ? r.amount_minor : null,
    jobRef: r.job_ref,
    assignedRole: r.assigned_role,
    createdAt: r.created_at,
  }));
}

// ── E-03 evaluator STUB (doc 04): stuck-approval age check ────────────────────
// Emits exception/raised(approval_stuck) for pending approvals past the age
// threshold. The exception TABLE + persistent dedup (dedup_key) land in S5 — this
// stub DETECTS + emits (the facts accumulate on the bus). 8 working hours →
// warning, 3 days → critical (wall-clock in the stub; working-calendar precision
// is S5). Directly testable: backdate an approval, invoke, assert the emission.
const STUCK_WARN_MS = 8 * 60 * 60 * 1000; // 8h
const STUCK_CRIT_MS = 3 * 24 * 60 * 60 * 1000; // 3d

export async function evaluateStuckApprovals(ctx: Ctx): Promise<{ raised: number }> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id,
             (extract(epoch from (now() - created_at)) * 1000)::bigint as age_ms
      from public.approval
      where org_id = ${ctx.orgId} and state = 'pending'
    `)) as unknown as Array<{ id: string; age_ms: string }>;
    let raised = 0;
    for (const r of rows) {
      const age = Number(r.age_ms);
      const severity = age >= STUCK_CRIT_MS ? "critical" : age >= STUCK_WARN_MS ? "warning" : null;
      if (!severity) continue;
      await emitEvent(tx, ctx, {
        name: EXCEPTION_RAISED,
        payload: {
          orgId: ctx.orgId,
          actorUserId: ctx.userId,
          kind: "approval_stuck" as const,
          subjectType: "approval",
          subjectId: r.id,
          severity,
        },
      });
      raised++;
    }
    return { raised };
  });
}

export type ApprovalDetail = {
  id: string;
  subjectType: string;
  subjectId: string;
  title: string;
  amountMinor: string | null;
  jobRef: string | null;
  state: string;
  assignedRole: string;
  requestedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  selfApproved: boolean;
  createdAt: string;
};
export async function getApproval(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<ApprovalDetail | null> {
  assertCan(archetype, "approvals.decide");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.id::text as id, a.subject_type, a.subject_id::text as subject_id,
             a.subject_summary->>'title' as title,
             (a.subject_summary->>'amountMinor') as amount_minor,
             a.subject_summary->>'jobRef' as job_ref, a.state, a.assigned_role,
             ru.full_name as requested_by_name, du.full_name as decided_by_name,
             a.decision_note, a.self_approved, a.created_at::text as created_at
      from public.approval a
      left join public.user_profile ru on ru.id = a.requested_by
      left join public.user_profile du on du.id = a.decided_by
      where a.id = ${id} and a.org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    subjectType: r.subject_type as string,
    subjectId: r.subject_id as string,
    title: r.title as string,
    amountMinor: can(archetype, "po.view") ? ((r.amount_minor as string | null) ?? null) : null,
    jobRef: (r.job_ref as string | null) ?? null,
    state: r.state as string,
    assignedRole: r.assigned_role as string,
    requestedByName: (r.requested_by_name as string | null) ?? null,
    decidedByName: (r.decided_by_name as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    selfApproved: r.self_approved as boolean,
    createdAt: r.created_at as string,
  };
}
