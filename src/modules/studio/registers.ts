/**
 * H25K — governance registers: risks, issues, assumptions, decisions,
 * changes, actions and lessons are typed elements of plans (semantic node
 * types with validated data), so a register is a PROJECTION across the
 * organisation's plans, never a second table. Paged, org-wide, filterable;
 * every row links back to its plan.
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { draftStatusCategory, parseNodeData, type StatusCategory } from "./types";

export const REGISTER_KINDS = [
  "risk",
  "issue",
  "assumption",
  "decision",
  "change",
  "action",
  "lesson",
  "constraint",
  "opportunity",
] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number];

export type RegisterRow = {
  id: string;
  planId: string;
  planReference: string;
  planName: string;
  nodeType: RegisterKind;
  title: string;
  description: string | null;
  statusCategory: StatusCategory;
  rawStatus: string;
  priority: string;
  ownerUserId: string | null;
  dueDate: string | null;
  data: Record<string, unknown>;
  /** Derived for risks: likelihood × impact (null when unscored). */
  score: number | null;
  updatedAt: string;
};

export const RegisterQuery = z.object({
  kind: z.enum(REGISTER_KINDS),
  planId: z.string().uuid().optional(),
  status: z.enum(["open", "closed", "all"]).default("open"),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

export async function listRegister(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rows: RegisterRow[]; total: number }> {
  assertCan(archetype, "studio.view");
  const q = RegisterQuery.parse(raw);
  const closedStatuses = ["done", "dropped"];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select n.id::text as id, n.plan_id::text as plan_id, p.reference as plan_reference,
             p.name as plan_name, n.node_type, n.title, n.description, n.status, n.priority,
             n.owner_user_id::text as owner_user_id, n.due_date::text as due_date, n.data,
             n.updated_at::text as updated_at, count(*) over () as total
      from public.studio_node n
      join public.studio_plan p on p.id = n.plan_id and p.org_id = n.org_id
      where n.org_id = ${ctx.orgId} and n.archived_at is null and n.node_type = ${q.kind}
        and (${q.planId ?? null}::uuid is null or n.plan_id = ${q.planId ?? null}::uuid)
        and (${q.status === "all"}
             or (${q.status === "open"} and n.status not in ('done', 'dropped'))
             or (${q.status === "closed"} and n.status in ('done', 'dropped')))
        and (${q.search ?? null}::text is null or n.title ilike '%' || ${q.search ?? ""} || '%')
      order by n.updated_at desc
      limit ${q.limit} offset ${q.offset}
    `),
  )) as unknown as Array<{
    id: string;
    plan_id: string;
    plan_reference: string;
    plan_name: string;
    node_type: RegisterKind;
    title: string | null;
    description: string | null;
    status: string;
    priority: string;
    owner_user_id: string | null;
    due_date: string | null;
    data: unknown;
    updated_at: string;
    total: string | number;
  }>;
  void closedStatuses;
  const mapped = rows.map((r) => {
    let data: Record<string, unknown> = {};
    try {
      data = parseNodeData(r.node_type, r.data ?? {}) as Record<string, unknown>;
    } catch {
      data = (r.data as Record<string, unknown>) ?? {};
    }
    const l = Number(data.likelihood);
    const i = Number(data.impact);
    const score =
      r.node_type === "risk" && Number.isInteger(l) && Number.isInteger(i) ? l * i : null;
    return {
      id: r.id,
      planId: r.plan_id,
      planReference: r.plan_reference,
      planName: r.plan_name,
      nodeType: r.node_type,
      title: r.title ?? "Untitled",
      description: r.description,
      statusCategory: draftStatusCategory(r.status),
      rawStatus: r.status,
      priority: r.priority,
      ownerUserId: r.owner_user_id,
      dueDate: r.due_date,
      data,
      score,
      updatedAt: r.updated_at,
    };
  });
  return { rows: mapped, total: Number(rows[0]?.total ?? 0) };
}
