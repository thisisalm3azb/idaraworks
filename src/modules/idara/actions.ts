/**
 * H28 — proposed actions: preview, confirmation, approval, execution (ADR-57).
 *
 * A tool of class 3 or 4 never executes from a model turn. It proposes an
 * `ai_action` row holding the preview (what, records, old and new values,
 * required permission, external communication, cost, reversibility, side
 * effects) and the record versions it saw. Confirmation re-checks identity,
 * permission, expiry and status; class 3 executes immediately through the
 * owning service with a stable idempotency key; class 4 submits the existing
 * approval engine (separation of duties) and executes only after approval and
 * a second explicit confirmation. Drift, replay and stale approvals are
 * refused; success, failure and rollback are recorded honestly.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { can, ForbiddenError } from "@/platform/authz";
import type { Locale } from "@/platform/i18n";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { submitForApproval } from "@/modules/approvals/service";
import { DriftError, getTool, type ToolContext, type ToolDef } from "./tools/registry";
import type { ActionPreview, ActionStatus, RecordRef, RecordVersion, ToolRiskClass } from "./types";

export type ActionRow = {
  id: string;
  runId: string;
  conversationId: string | null;
  toolId: string;
  riskClass: ToolRiskClass;
  title: string;
  preview: ActionPreview;
  input: unknown;
  recordVersions: RecordVersion[];
  status: ActionStatus;
  approvalId: string | null;
  requestedBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  executedAt: string | null;
  result: unknown;
  error: string | null;
  expiresAt: string;
  createdAt: string;
};

function asJson<T>(v: unknown, fallback: T): T {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v as T) ?? fallback;
}

function rowOf(r: Record<string, unknown>): ActionRow {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    conversationId: (r.conversation_id as string | null) ?? null,
    toolId: String(r.tool_id),
    riskClass: Number(r.risk_class) as ToolRiskClass,
    title: String(r.title),
    preview: asJson<ActionPreview>(r.preview, {
      what: "",
      records: [],
      changes: [],
      permission: "",
      external: [],
      estCredits: 0,
      reversible: false,
      sideEffects: [],
    }),
    input: asJson<unknown>(r.input, {}),
    recordVersions: asJson<RecordVersion[]>(r.record_versions, []),
    status: String(r.status) as ActionStatus,
    approvalId: (r.approval_id as string | null) ?? null,
    requestedBy: String(r.requested_by),
    confirmedBy: (r.confirmed_by as string | null) ?? null,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
    executedAt: (r.executed_at as string | null) ?? null,
    result: asJson<unknown>(r.result, null),
    error: (r.error as string | null) ?? null,
    expiresAt: String(r.expires_at),
    createdAt: String(r.created_at),
  };
}

const SELECT = sql`
  select id::text as id, run_id::text as run_id, conversation_id::text as conversation_id, tool_id, risk_class, title, preview, input,
         record_versions, status, approval_id::text as approval_id, requested_by::text as requested_by, confirmed_by::text as confirmed_by,
         confirmed_at::text as confirmed_at, executed_at::text as executed_at, result, error, expires_at::text as expires_at, created_at::text as created_at
  from public.ai_action`;

export async function getAction(ctx: Ctx, id: string): Promise<ActionRow | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where id = ${id} and org_id = ${ctx.orgId}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function listActions(
  ctx: Ctx,
  q: { status?: ActionStatus; mine?: boolean; limit: number; offset: number },
): Promise<{ rows: ActionRow[]; total: number }> {
  const limit = Math.min(Math.max(q.limit, 1), 100);
  const offset = Math.max(q.offset, 0);
  return withCtx(ctx, async (tx) => {
    const where = sql`org_id = ${ctx.orgId}
      and (${q.status ?? null}::text is null or status = ${q.status ?? null})
      and (${q.mine ? ctx.userId : null}::uuid is null or requested_by = ${q.mine ? ctx.userId : null}::uuid)`;
    const rows = (await tx.execute(
      sql`${SELECT} where ${where} order by created_at desc limit ${limit} offset ${offset}`,
    )) as unknown as Array<Record<string, unknown>>;
    const total = (await tx.execute(
      sql`select count(*)::int as n from public.ai_action where ${where}`,
    )) as unknown as Array<{ n: number }>;
    return { rows: rows.map(rowOf), total: Number(total[0]?.n ?? 0) };
  });
}

/** Build the preview and store the proposal (called by the run engine inside its own flow). */
export async function proposeAction(
  tc: ToolContext,
  tool: ToolDef,
  input: unknown,
  opts: { flagged: boolean },
): Promise<ActionRow> {
  if (!tool.preview || !tool.execute) throw new Error(`tool ${tool.id} cannot propose actions`);
  if (tool.action && !can(tc.archetype, tool.action)) throw new ForbiddenError(tool.action);
  const parsed = tool.input.parse(input);
  const built = await tool.preview(tc, parsed);
  const id = randomUUID();
  const idempotencyKey = `${tc.idempotencyKey}:${tool.id}`.slice(0, 120);
  const preview: ActionPreview = {
    ...built.preview,
    sideEffects: opts.flagged
      ? [
          ...built.preview.sideEffects,
          "suspicious instructions were detected in the consulted content; confirm deliberately",
        ]
      : built.preview.sideEffects,
  };
  await command(
    tc.ctx,
    {
      audit: {
        action: "idara.action.propose",
        entityType: "ai_action",
        entityId: id,
        summary: `${tool.id} (class ${tool.riskClass}): ${built.title}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.ai_action (id, org_id, run_id, conversation_id, tool_id, risk_class, title, preview, input, record_versions, idempotency_key, requested_by)
        values (${id}, ${tc.ctx.orgId}, ${tc.runId}, ${tc.conversationId}, ${tool.id}, ${tool.riskClass}, ${built.title.slice(0, 200)},
                ${JSON.stringify(preview)}::jsonb, ${JSON.stringify(parsed)}::jsonb, ${JSON.stringify(built.versions)}::jsonb,
                ${idempotencyKey}, ${tc.ctx.userId})
        on conflict (org_id, idempotency_key) do nothing`);
      return null;
    },
  );
  const existing = (await withCtx(tc.ctx, (tx) =>
    tx.execute(
      sql`${SELECT} where org_id = ${tc.ctx.orgId} and idempotency_key = ${idempotencyKey}`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
  if (!existing[0]) throw new Error("proposal not visible after insert");
  return rowOf(existing[0]);
}

export const ActionRef = z.object({ actionId: z.string().uuid() });

class ActionStateError extends Error {
  readonly code:
    "not_found" | "not_owner" | "expired" | "wrong_status" | "no_permission" | "replay";
  constructor(code: ActionStateError["code"]) {
    super(`action ${code}`);
    this.code = code;
  }
}
export { ActionStateError };

async function loadForRecheck(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  allowed: ActionStatus[],
): Promise<{ row: ActionRow; tool: ToolDef }> {
  const row = await getAction(ctx, id);
  if (!row) throw new ActionStateError("not_found");
  if (row.requestedBy !== ctx.userId) throw new ActionStateError("not_owner");
  if (new Date(row.expiresAt) < new Date() && !["executed", "failed"].includes(row.status))
    throw new ActionStateError("expired");
  if (!allowed.includes(row.status)) throw new ActionStateError("wrong_status");
  const tool = getTool(row.toolId);
  if (!tool || !tool.execute) throw new ActionStateError("wrong_status");
  if (tool.action && !can(archetype, tool.action)) throw new ActionStateError("no_permission");
  return { row, tool };
}

async function transition(
  ctx: Ctx,
  id: string,
  from: ActionStatus[],
  to: ActionStatus,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      update public.ai_action set status = ${to},
        confirmed_by = coalesce(${(extra.confirmedBy as string | null) ?? null}::uuid, confirmed_by),
        confirmed_at = coalesce(${(extra.confirmedAt as string | null) ?? null}::timestamptz, confirmed_at),
        executed_at = coalesce(${(extra.executedAt as string | null) ?? null}::timestamptz, executed_at),
        approval_id = coalesce(${(extra.approvalId as string | null) ?? null}::uuid, approval_id),
        result = coalesce(${extra.result === undefined ? null : JSON.stringify(extra.result)}::jsonb, result),
        error = coalesce(${(extra.error as string | null) ?? null}, error)
      where id = ${id} and org_id = ${ctx.orgId} and status = any(string_to_array(${from.join(",")}, ','))
      returning id`),
  )) as unknown as Array<{ id: string }>;
  return rows.length === 1;
}

async function runExecution(
  ctx: Ctx,
  archetype: RoleArchetype,
  locale: Locale,
  row: ActionRow,
  tool: ToolDef,
): Promise<ActionRow> {
  // Compare-and-set into `executing`: a replayed confirmation loses the race and is refused.
  const won = await transition(ctx, row.id, ["confirmed", "approved"], "executing");
  if (!won) throw new ActionStateError("replay");
  const tc: ToolContext = {
    ctx,
    archetype,
    locale,
    runId: row.runId,
    conversationId: row.conversationId,
    idempotencyKey: `${row.id}`,
  };
  try {
    const out = await tool.execute!(tc, tool.input.parse(row.input), row.recordVersions);
    await transition(ctx, row.id, ["executing"], "executed", {
      executedAt: new Date().toISOString(),
      result: { ...((out.result as object) ?? {}), records: out.records, summary: out.summary },
    });
    await command(
      ctx,
      {
        audit: {
          action: "idara.action.execute",
          entityType: "ai_action",
          entityId: row.id,
          summary: `${tool.id}: ${out.summary}`.slice(0, 2000),
        },
      },
      async () => null,
    );
  } catch (e) {
    const drift = e instanceof DriftError;
    await transition(ctx, row.id, ["executing"], drift ? "refused_drift" : "failed", {
      error: drift
        ? `records changed since the preview: ${e.drifted.map((d) => `${d.type} ${d.id}`).join(", ")}`
        : String((e as Error).message ?? e).slice(0, 1000),
    });
    await command(
      ctx,
      {
        audit: {
          action: drift ? "idara.action.refuse_drift" : "idara.action.fail",
          entityType: "ai_action",
          entityId: row.id,
          summary: `${tool.id}: ${String((e as Error).message ?? e).slice(0, 500)}`,
        },
      },
      async () => null,
    );
  }
  const after = await getAction(ctx, row.id);
  return after!;
}

/**
 * Confirm a proposed action. Class 3 executes now; class 4 submits the
 * approval engine and waits for another person.
 */
export async function confirmAction(
  ctx: Ctx,
  archetype: RoleArchetype,
  locale: Locale,
  raw: unknown,
): Promise<ActionRow> {
  const { actionId } = ActionRef.parse(raw);
  const { row, tool } = await loadForRecheck(ctx, archetype, actionId, ["proposed"]);
  if (tool.riskClass === 4) {
    const approvalId = await command(
      ctx,
      {
        audit: {
          action: "idara.action.confirm",
          entityType: "ai_action",
          entityId: row.id,
          summary: `${tool.id}: confirmed, approval requested`,
        },
      },
      async (tx) => {
        const moved = (await tx.execute(sql`
          update public.ai_action set status = 'awaiting_approval', confirmed_by = ${ctx.userId}, confirmed_at = now()
          where id = ${row.id} and org_id = ${ctx.orgId} and status = 'proposed' returning id`)) as unknown as Array<{
          id: string;
        }>;
        if (moved.length !== 1) throw new ActionStateError("replay");
        const a = await submitForApproval(tx, ctx, {
          subjectType: "ai_action",
          subjectId: row.id,
          subjectSummary: { title: `Idara: ${row.title}`.slice(0, 200) },
        });
        await tx.execute(
          sql`update public.ai_action set approval_id = ${a.approvalId} where id = ${row.id} and org_id = ${ctx.orgId}`,
        );
        return a.approvalId;
      },
    );
    void approvalId;
    return (await getAction(ctx, row.id))!;
  }
  const confirmed = await transition(ctx, row.id, ["proposed"], "confirmed", {
    confirmedBy: ctx.userId,
    confirmedAt: new Date().toISOString(),
  });
  if (!confirmed) throw new ActionStateError("replay");
  await command(
    ctx,
    {
      audit: {
        action: "idara.action.confirm",
        entityType: "ai_action",
        entityId: row.id,
        summary: `${tool.id}: confirmed`,
      },
    },
    async () => null,
  );
  return runExecution(ctx, archetype, locale, { ...row, status: "confirmed" }, tool);
}

/** Second explicit confirmation by the requester after another person approved (class 4). */
export async function executeApprovedAction(
  ctx: Ctx,
  archetype: RoleArchetype,
  locale: Locale,
  raw: unknown,
): Promise<ActionRow> {
  const { actionId } = ActionRef.parse(raw);
  const { row, tool } = await loadForRecheck(ctx, archetype, actionId, ["approved"]);
  return runExecution(ctx, archetype, locale, row, tool);
}

export async function cancelAction(ctx: Ctx, raw: unknown): Promise<void> {
  const { actionId } = ActionRef.parse(raw);
  const row = await getAction(ctx, actionId);
  if (!row || row.requestedBy !== ctx.userId) throw new ActionStateError("not_owner");
  const ok = await transition(
    ctx,
    actionId,
    ["proposed", "awaiting_approval", "approved"],
    "cancelled",
  );
  if (!ok) throw new ActionStateError("wrong_status");
  await command(
    ctx,
    {
      audit: {
        action: "idara.action.cancel",
        entityType: "ai_action",
        entityId: actionId,
        summary: row.toolId,
      },
    },
    async () => null,
  );
}

/** The approval engine's afterDecide hook (same decision transaction). */
export async function onAiActionDecidedIn(
  tx: TenantTx,
  ctx: Ctx,
  actionId: string,
  outcome: "approved" | "rejected",
  note?: string | null,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select requested_by::text as requested_by, title, conversation_id::text as conversation_id
    from public.ai_action where id = ${actionId} and org_id = ${ctx.orgId}`)) as unknown as Array<{
    requested_by: string;
    title: string;
    conversation_id: string | null;
  }>;
  const row = rows[0];
  if (!row) return;
  if (outcome === "rejected") {
    await tx.execute(
      sql`update public.ai_action set error = ${note ? note.slice(0, 1000) : "rejected"} where id = ${actionId} and org_id = ${ctx.orgId}`,
    );
  }
  await createNotificationIn(tx, ctx, {
    recipientUserId: row.requested_by,
    kind: "idara_action_waiting",
    title:
      outcome === "approved"
        ? `Approved: ${row.title}`.slice(0, 200)
        : `Not approved: ${row.title}`.slice(0, 200),
    body:
      outcome === "approved"
        ? "Open Idara to execute the approved action."
        : (note ?? "The approver declined.").slice(0, 2000),
    entityType: "ai_action",
    entityId: actionId,
  });
}

/** Expire stale proposals (called by the sweep); returns how many expired. */
export async function expireActionsIn(tx: TenantTx, ctx: Ctx): Promise<number> {
  const rows = (await tx.execute(sql`
    update public.ai_action set status = 'expired'
    where org_id = ${ctx.orgId} and status in ('proposed', 'awaiting_approval', 'approved') and expires_at < now()
    returning id`)) as unknown as Array<{ id: string }>;
  return rows.length;
}

export function actionRecords(row: ActionRow): RecordRef[] {
  return row.preview.records;
}
