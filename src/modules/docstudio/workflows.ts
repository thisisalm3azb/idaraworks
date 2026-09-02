/**
 * H26 — reusable workflow definitions (ADR-22, slice 4). A workflow is an
 * ordered list of steps; each step is a review, an approval or a signature
 * hand-off, sequential or parallel, guarded by a condition over document
 * facts. Runs COPY the definition (workflow-runs.ts), so editing a workflow
 * never changes an in-flight run.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { MVP_GRANTABLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { ConditionSchema, DocError, type Condition } from "./types";

export const STEP_KINDS = ["review", "approval", "signature"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Who a step goes to. Resolved against the document at run time. */
export const Assignee = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archetype"), value: z.enum(MVP_GRANTABLE_ARCHETYPES) }).strict(),
  z.object({ type: z.literal("user"), value: z.string().uuid() }).strict(),
  z.object({ type: z.literal("document_owner") }).strict(),
  z.object({ type: z.literal("counterparty") }).strict(),
]);
export type Assignee = z.infer<typeof Assignee>;

export const WorkflowStep = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    kind: z.enum(STEP_KINDS),
    name: z
      .object({ en: z.string().max(120).optional(), ar: z.string().max(120).optional() })
      .strict(),
    /** parallel = every assignee must decide; sequential = one after another in list order. */
    mode: z.enum(["sequential", "parallel"]).default("sequential"),
    /** parallel only: how many approvals complete the step (default: all). */
    quorum: z.number().int().min(1).max(20).optional(),
    assignees: z.array(Assignee).min(1).max(10),
    condition: ConditionSchema.optional(),
    dueDays: z.number().int().min(0).max(365).optional(),
    /** Escalate to this archetype when overdue (informational + attention feed). */
    escalateTo: z.enum(MVP_GRANTABLE_ARCHETYPES).optional(),
    allowDelegate: z.boolean().default(true),
    /** The person who submitted may not decide this step. */
    separationOfDuties: z.boolean().default(true),
    /** What a rejection does: back to draft (default) or stop the run. */
    onReject: z.enum(["return_to_draft", "stop"]).default("return_to_draft"),
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowDefinition = z
  .object({
    version: z.literal(1).default(1),
    steps: z.array(WorkflowStep).max(20),
    /** Optional reusable rule descriptions shown in the designer. */
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    d.steps.forEach((s, i) => {
      if (ids.has(s.id))
        ctx.addIssue({ code: "custom", message: `duplicate step id ${s.id}`, path: ["steps", i] });
      ids.add(s.id);
      if (s.quorum && s.quorum > s.assignees.length)
        ctx.addIssue({ code: "custom", message: "quorum exceeds assignees", path: ["steps", i] });
    });
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  status: "active" | "retired";
  rowVersion: number;
  updatedAt: string;
};

function mapRow(r: Record<string, unknown>): WorkflowRow {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    definition: WorkflowDefinition.safeParse(r.definition).data ?? { version: 1, steps: [] },
    status: r.status as WorkflowRow["status"],
    rowVersion: Number(r.row_version),
    updatedAt: r.updated_at as string,
  };
}

export async function listWorkflows(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { includeRetired?: boolean } = {},
): Promise<WorkflowRow[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, description, definition, status, row_version, updated_at::text as updated_at
      from public.doc_workflow
      where org_id = ${ctx.orgId} and (${opts.includeRetired === true} or status = 'active')
      order by name
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export async function loadWorkflowIn(
  tx: TenantTx,
  ctx: Ctx,
  workflowId: string,
): Promise<WorkflowRow> {
  const rows = (await tx.execute(sql`
    select id::text as id, name, description, definition, status, row_version, updated_at::text as updated_at
    from public.doc_workflow where id = ${workflowId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new DocError("workflow not found", "not_found");
  return mapRow(rows[0]);
}

export async function getWorkflow(
  ctx: Ctx,
  archetype: RoleArchetype,
  workflowId: string,
): Promise<WorkflowRow> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => loadWorkflowIn(tx, ctx, workflowId));
}

export const CreateWorkflowInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    definition: WorkflowDefinition.optional(),
  })
  .strict();

export async function createWorkflow(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.workflows.manage");
  const input = CreateWorkflowInput.parse(raw);
  const definition = input.definition ?? WorkflowDefinition.parse({ steps: [] });
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "documents.workflow.create",
        entityType: "document_workflow",
        entityId: r.id,
        summary: `Created workflow "${input.name}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.doc_workflow (org_id, name, description, definition, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.description ?? null}, ${JSON.stringify(definition)}::jsonb, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export const UpdateWorkflowInput = z
  .object({
    workflowId: z.string().uuid(),
    expectedRowVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    definition: WorkflowDefinition.optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .strict();

export async function updateWorkflow(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number }> {
  assertCan(archetype, "documents.workflows.manage");
  const input = UpdateWorkflowInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action:
          input.status === "retired" ? "documents.workflow.retire" : "documents.workflow.update",
        entityType: "document_workflow",
        entityId: input.workflowId,
        summary: input.status === "retired" ? "Retired workflow" : "Updated workflow",
        after: input.definition ? { steps: input.definition.steps.length } : undefined,
      },
    },
    async (tx) => {
      const w = await loadWorkflowIn(tx, ctx, input.workflowId);
      if (input.expectedRowVersion !== undefined && w.rowVersion !== input.expectedRowVersion)
        throw new DocError("workflow changed since you loaded it", "conflict");
      const rows = (await tx.execute(sql`
        update public.doc_workflow set
          name = coalesce(${input.name ?? null}, name),
          description = case when ${input.description !== undefined} then ${input.description ?? null} else description end,
          definition = coalesce(${input.definition ? JSON.stringify(input.definition) : null}::jsonb, definition),
          status = coalesce(${input.status ?? null}, status),
          row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${w.id} and org_id = ${ctx.orgId}
        returning row_version
      `)) as unknown as Array<{ row_version: number }>;
      return { rowVersion: Number(rows[0]!.row_version) };
    },
  );
}

/** Built-in starting points for the designer (copied into an org workflow on create). */
export const WORKFLOW_PRESETS: Array<{
  key: string;
  nameEn: string;
  nameAr: string;
  definition: WorkflowDefinition;
}> = [
  {
    key: "manager_review",
    nameEn: "Manager review then owner approval",
    nameAr: "مراجعة المدير ثم اعتماد المالك",
    definition: WorkflowDefinition.parse({
      steps: [
        {
          id: "review",
          kind: "review",
          name: { en: "Manager review", ar: "مراجعة المدير" },
          assignees: [{ type: "archetype", value: "manager" }],
          dueDays: 3,
        },
        {
          id: "approve",
          kind: "approval",
          name: { en: "Owner approval", ar: "اعتماد المالك" },
          assignees: [{ type: "archetype", value: "owner" }],
          dueDays: 5,
          escalateTo: "owner",
        },
      ],
    }),
  },
  {
    key: "value_gate",
    nameEn: "Value gate: owner approval above 50,000",
    nameAr: "بوابة القيمة: اعتماد المالك فوق 50,000",
    definition: WorkflowDefinition.parse({
      steps: [
        {
          id: "manager",
          kind: "approval",
          name: { en: "Manager approval", ar: "اعتماد المدير" },
          assignees: [{ type: "archetype", value: "manager" }],
          dueDays: 3,
        },
        {
          id: "owner_high_value",
          kind: "approval",
          name: { en: "Owner approval (high value)", ar: "اعتماد المالك (قيمة عالية)" },
          assignees: [{ type: "archetype", value: "owner" }],
          condition: { key: "document.amount", op: "gte", value: 50000 },
          dueDays: 5,
          escalateTo: "owner",
        },
      ],
    }),
  },
  {
    key: "dual_signoff",
    nameEn: "Dual sign-off (finance and management in parallel)",
    nameAr: "اعتماد مزدوج (المالية والإدارة بالتوازي)",
    definition: WorkflowDefinition.parse({
      steps: [
        {
          id: "parallel",
          kind: "approval",
          name: { en: "Finance and management", ar: "المالية والإدارة" },
          mode: "parallel",
          assignees: [
            { type: "archetype", value: "accounts" },
            { type: "archetype", value: "manager" },
          ],
          dueDays: 4,
        },
      ],
    }),
  },
];

export type { Condition };
