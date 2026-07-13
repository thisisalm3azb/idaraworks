/**
 * Issues module service — S3 (doc 06 row 47; doc 01 L4, audit C-8).
 * A raise-from-anywhere problem ticket. "Blocking" is a FLAG (is_blocker), not a
 * severity (C-8). Raise = every contributor incl. foreman(assigned-scope) /
 * procurement / accounts; resolve/assign = O/A/M. Job link is optional. Photos
 * attach via the generic files table (entity_type='issue'), so no photo code here.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, ForbiddenError } from "@/platform/authz";
import { ISSUE_RAISED, ISSUE_RESOLVED } from "@/platform/events";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assignedJobCondition, isAssignedIn } from "@/modules/jobs/service";
import { ISSUE_SEVERITIES, type RoleArchetype } from "@/platform/registries";

export class IssueNotFoundError extends Error {
  constructor(id: string) {
    super(`issue ${id} not found`);
    this.name = "IssueNotFoundError";
  }
}
export class InvalidIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIssueError";
  }
}

export const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

export const CreateIssueInput = z.object({
  jobId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .transform((v) => (v ? v : undefined)),
  severity: z.enum(ISSUE_SEVERITIES).optional().default("medium"),
  isBlocker: z.boolean().optional().default(false),
});

export async function createIssue(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "issues.raise");
  const data = CreateIssueInput.parse(input);
  const id = randomUUID();
  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "issue.raise",
        entityType: "issue",
        entityId: id,
        summary: `Raised issue: ${data.title}`,
      },
      activity: {
        entityType: "issue",
        entityId: id,
        verb: "raised",
        summary: `raised an issue: ${data.title}`,
      },
      events: [
        {
          name: ISSUE_RAISED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            issueId: id,
            jobId: data.jobId,
            severity: data.severity,
            isBlocker: data.isBlocker,
          },
        },
      ],
    },
    async (tx) => {
      if (data.jobId) {
        // Job must be in-org; a foreman may only raise on an ASSIGNED job (F-6).
        const job = (await tx.execute(sql`
          select id::text as id from public.job
          where org_id = ${ctx.orgId} and id = ${data.jobId}
        `)) as unknown as Array<{ id: string }>;
        if (!job[0]) throw new InvalidIssueError(`unknown job ${data.jobId}`);
        if (archetype === "foreman" && !(await isAssignedIn(tx, ctx, data.jobId))) {
          throw new ForbiddenError("issues.raise");
        }
      }
      await tx.execute(sql`
        insert into public.issue
          (id, org_id, job_id, title, description, severity, is_blocker, status, raised_by)
        values (${id}, ${ctx.orgId}, ${data.jobId ?? null}, ${data.title},
                ${data.description ?? null}, ${data.severity}, ${data.isBlocker}, 'open', ${ctx.userId})
      `);
      return { id };
    },
  );
}

export const UpdateIssueStatusInput = z.object({
  issueId: z.string().uuid(),
  status: z.enum(ISSUE_STATUSES),
});

export async function updateIssueStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; status: string }> {
  assertCan(archetype, "issues.resolve");
  const data = UpdateIssueStatusInput.parse(input);
  const resolving = data.status === "resolved" || data.status === "closed";
  return command<{ id: string; status: string; jobId: string | null; wasResolved: boolean }>(
    ctx,
    {
      audit: (r) => ({
        action: "issue.update_status",
        entityType: "issue",
        entityId: r.id,
        summary: `Issue → ${r.status}`,
      }),
      events: (r) =>
        r.wasResolved
          ? [
              {
                name: ISSUE_RESOLVED,
                payload: {
                  orgId: ctx.orgId,
                  actorUserId: ctx.userId,
                  issueId: r.id,
                  jobId: r.jobId ?? undefined,
                },
              },
            ]
          : [],
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, job_id::text as job_id, status
        from public.issue
        where id = ${data.issueId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ id: string; job_id: string | null; status: string }>;
      const row = rows[0];
      if (!row) throw new IssueNotFoundError(data.issueId);
      const alreadyResolved = row.status === "resolved" || row.status === "closed";
      await tx.execute(sql`
        update public.issue
        set status = ${data.status},
            resolved_by = ${resolving ? ctx.userId : null},
            resolved_at = ${resolving ? sql`now()` : sql`null`},
            updated_at = now()
        where id = ${data.issueId} and org_id = ${ctx.orgId}
      `);
      // Emit resolved only on the OPEN→resolved edge (not a re-close).
      return {
        id: row.id,
        status: data.status,
        jobId: row.job_id,
        wasResolved: resolving && !alreadyResolved,
      };
    },
  ).then((r) => ({ id: r.id, status: r.status }));
}

export const AssignIssueInput = z.object({
  issueId: z.string().uuid(),
  assigneeEmployeeId: z.string().uuid().nullable(),
});

export async function assignIssue(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "issues.resolve");
  const data = AssignIssueInput.parse(input);
  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "issue.assign",
        entityType: "issue",
        entityId: data.issueId,
        summary: data.assigneeEmployeeId
          ? `Assigned issue to ${data.assigneeEmployeeId}`
          : "Unassigned issue",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id from public.issue
        where id = ${data.issueId} and org_id = ${ctx.orgId} for update
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new IssueNotFoundError(data.issueId);
      if (data.assigneeEmployeeId) {
        const emp = (await tx.execute(sql`
          select id::text as id from public.employee
          where org_id = ${ctx.orgId} and id = ${data.assigneeEmployeeId}
        `)) as unknown as Array<{ id: string }>;
        if (!emp[0]) throw new InvalidIssueError(`unknown employee ${data.assigneeEmployeeId}`);
      }
      await tx.execute(sql`
        update public.issue
        set assignee_employee_id = ${data.assigneeEmployeeId}, updated_at = now()
        where id = ${data.issueId} and org_id = ${ctx.orgId}
      `);
      return { id: data.issueId };
    },
  );
}

export type IssueRow = {
  id: string;
  jobId: string | null;
  jobReference: string | null;
  title: string;
  severity: string;
  isBlocker: boolean;
  status: string;
  raisedByName: string | null;
  assigneeName: string | null;
  createdAt: string;
};

/**
 * List issues. Participants (issues.raise holders) see the org issue list;
 * foreman is narrowed to issues on ASSIGNED jobs OR ones they raised. Viewer
 * (no issues.raise) is denied — doc 06 issues row is `−` for viewer.
 */
export async function listIssues(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { jobId?: string; status?: string } = {},
): Promise<IssueRow[]> {
  assertCan(archetype, "issues.raise");
  const statusFilter =
    opts.status && (ISSUE_STATUSES as readonly string[]).includes(opts.status) ? opts.status : null;
  const rows = (await withCtx(ctx, async (tx) => {
    // Foreman: own-raised issues (incl. org-wide, no job) OR issues on an
    // ASSIGNED job (the ONE F-6 resolver — j is the LEFT-JOINed job alias).
    const foremanScope =
      archetype === "foreman"
        ? sql`and (i.raised_by = ${ctx.userId} or ${assignedJobCondition(ctx)})`
        : sql``;
    return tx.execute(sql`
      select i.id::text as id, i.job_id::text as job_id, j.reference as job_reference,
             i.title, i.severity, i.is_blocker, i.status,
             ru.full_name as raised_by_name, ae.name as assignee_name,
             i.created_at::text as created_at
      from public.issue i
      left join public.job j on j.id = i.job_id and j.org_id = i.org_id
      left join public.user_profile ru on ru.id = i.raised_by
      left join public.employee ae on ae.id = i.assignee_employee_id and ae.org_id = i.org_id
      where i.org_id = ${ctx.orgId}
        ${opts.jobId ? sql`and i.job_id = ${opts.jobId}` : sql``}
        ${statusFilter ? sql`and i.status = ${statusFilter}` : sql``}
        ${foremanScope}
      order by i.is_blocker desc, i.created_at desc
      limit 500
    `);
  })) as unknown as Array<{
    id: string;
    job_id: string | null;
    job_reference: string | null;
    title: string;
    severity: string;
    is_blocker: boolean;
    status: string;
    raised_by_name: string | null;
    assignee_name: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    jobReference: r.job_reference,
    title: r.title,
    severity: r.severity,
    isBlocker: r.is_blocker,
    status: r.status,
    raisedByName: r.raised_by_name,
    assigneeName: r.assignee_name,
    createdAt: r.created_at,
  }));
}
