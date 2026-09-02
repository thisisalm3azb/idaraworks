/**
 * H25C — saved views: a named way of LOOKING at the one living model
 * (which projection, which filters, which scenario, where the camera is).
 * Presentation only: a view never stores status, dates, assignments or
 * progress. Private by default; sharing shows it to everyone on the plan.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { VIEW_KINDS, StudioError } from "./types";

export const ViewConfig = z
  .object({
    /** The workspace projection to open. */
    view: z.string().max(40).optional(),
    filters: z
      .object({
        search: z.string().max(200).optional(),
        types: z.array(z.string().max(40)).max(60).optional(),
        statuses: z.array(z.string().max(20)).max(10).optional(),
        assigneeEmployeeId: z.string().uuid().nullable().optional(),
        criticalOnly: z.boolean().optional(),
      })
      .optional(),
    scenarioId: z.string().uuid().nullable().optional(),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
    world: z.enum(["city", "tunnel", "capacity"]).optional(),
  })
  .strict();
export type ViewConfig = z.infer<typeof ViewConfig>;

export type SavedView = {
  id: string;
  planId: string;
  name: string;
  viewKind: string;
  config: ViewConfig;
  isShared: boolean;
  ownerUserId: string;
  mine: boolean;
  updatedAt: string;
};

type Raw = {
  id: string;
  plan_id: string;
  name: string;
  view_kind: string;
  config: unknown;
  is_shared: boolean;
  owner_user_id: string;
  updated_at: string;
};

/** The DB's view_kind vocabulary from the workspace's view key. */
export function viewKindFor(view: string): (typeof VIEW_KINDS)[number] {
  const map: Record<string, (typeof VIEW_KINDS)[number]> = {
    canvas: "canvas",
    board: "board",
    table: "table",
    gantt: "gantt",
    network: "network",
    roadmap: "roadmap",
    calendar: "calendar",
    workload: "workload",
    risk: "risk_matrix",
    world: "three_d",
    kpis: "portfolio",
    strategy: "strategy",
  };
  return map[view] ?? "canvas";
}

export async function listViews(
  ctx: Ctx,
  archetype: RoleArchetype,
  planId: string,
): Promise<SavedView[]> {
  assertCan(archetype, "studio.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, plan_id::text as plan_id, name, view_kind, config, is_shared,
             owner_user_id::text as owner_user_id, updated_at::text as updated_at
      from public.studio_view
      where org_id = ${ctx.orgId} and plan_id = ${planId} and removed_at is null
      order by is_shared desc, name
      limit 200
    `),
  )) as unknown as Raw[];
  return rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    name: r.name,
    viewKind: r.view_kind,
    config: ViewConfig.catch({}).parse(r.config ?? {}),
    isShared: r.is_shared,
    ownerUserId: r.owner_user_id,
    mine: r.owner_user_id === ctx.userId,
    updatedAt: r.updated_at,
  }));
}

export const SaveViewInput = z.object({
  planId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  view: z.string().max(40),
  config: ViewConfig,
  isShared: z.boolean().optional(),
});

export async function saveView(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "studio.view");
  const input = SaveViewInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "studio.view.save",
        entityType: "studio_view",
        entityId: r.id,
        summary: `Saved view "${input.name}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.studio_view (org_id, plan_id, name, view_kind, config, is_shared, owner_user_id)
        values (${ctx.orgId}, ${input.planId}, ${input.name}, ${viewKindFor(input.view)},
                ${JSON.stringify({ ...input.config, view: input.view })}::jsonb,
                ${input.isShared ?? false}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export const UpdateViewInput = z.object({
  viewId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  config: ViewConfig.optional(),
  isShared: z.boolean().optional(),
  remove: z.boolean().optional(),
});

/** Rename, re-share, overwrite the config, or retire a view (owner only; a manager may retire shared ones). */
export async function updateView(ctx: Ctx, archetype: RoleArchetype, raw: unknown): Promise<void> {
  assertCan(archetype, "studio.view");
  const input = UpdateViewInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: input.remove ? "studio.view.remove" : "studio.view.update",
        entityType: "studio_view",
        entityId: input.viewId,
        summary: input.remove ? "Retired a saved view" : "Updated a saved view",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select owner_user_id::text as owner, is_shared from public.studio_view
        where org_id = ${ctx.orgId} and id = ${input.viewId} and removed_at is null
      `)) as unknown as Array<{ owner: string; is_shared: boolean }>;
      const v = rows[0];
      if (!v) throw new StudioError("view not found", "not_found");
      const mine = v.owner === ctx.userId;
      const manager = archetype === "owner" || archetype === "admin" || archetype === "manager";
      if (!mine && !(v.is_shared && manager)) throw new StudioError("not your view", "forbidden");
      if (input.remove) {
        await tx.execute(sql`
          update public.studio_view set removed_at = now(), updated_at = now()
          where org_id = ${ctx.orgId} and id = ${input.viewId}
        `);
        return;
      }
      await tx.execute(sql`
        update public.studio_view set
          name = coalesce(${input.name ?? null}, name),
          config = coalesce(${input.config === undefined ? null : JSON.stringify(input.config)}::jsonb, config),
          is_shared = coalesce(${input.isShared ?? null}, is_shared),
          updated_at = now()
        where org_id = ${ctx.orgId} and id = ${input.viewId}
      `);
    },
  );
}
