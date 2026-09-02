/**
 * H25N — living templates: a plan can start from a template and a plan can
 * become one. A template is a bounded snapshot of DRAFT elements and their
 * edges (shapes, semantic data, relative placement, durations, estimates),
 * never of linked records: instantiating it creates drafts a manager then
 * links or converts. Built-in templates ship in code; organisation templates
 * live in app_settings (bounded), so nothing new is stored per tenant table.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { NODE_TYPES, EDGE_TYPES, DEP_KINDS, StudioError } from "./types";
import { createStudioPlan, addNode, addEdge } from "./graph";
import { resolvePlanGraph } from "./resolve";

const TemplateNode = z.object({
  key: z.string().min(1).max(40),
  nodeType: z.enum(NODE_TYPES),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).optional(),
  durationDays: z.number().int().min(0).max(3650).optional(),
  estimateOptimisticDays: z.number().min(0).max(3650).optional(),
  estimatePessimisticDays: z.number().min(0).max(3650).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  x: z.number(),
  y: z.number(),
});
const TemplateEdge = z.object({
  from: z.string(),
  to: z.string(),
  edgeType: z.enum(EDGE_TYPES),
  depKind: z.enum(DEP_KINDS).optional(),
  lagDays: z.number().int().min(-365).max(365).optional(),
});
export const PlanTemplate = z.object({
  key: z.string().regex(/^[a-z0-9_.-]{1,60}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  nodes: z.array(TemplateNode).min(1).max(200),
  edges: z.array(TemplateEdge).max(400),
});
export type PlanTemplate = z.infer<typeof PlanTemplate>;

const SETTINGS_KEY = "studio.templates";
const MAX_ORG_TEMPLATES = 20;

/** Built-in starting points. Durations are working days; estimates are examples to edit. */
export const BUILT_IN_TEMPLATES: readonly PlanTemplate[] = [
  {
    key: "builtin.build",
    name: "New build",
    description: "Mould to delivery in eleven stages with a season objective and the usual risks.",
    nodes: [
      { key: "obj", nodeType: "objective", title: "Deliver on the agreed date", x: 640, y: 20 },
      { key: "s1", nodeType: "task", title: "Mould prep", durationDays: 5, estimateOptimisticDays: 4, estimatePessimisticDays: 8, x: 60, y: 200 },
      { key: "s2", nodeType: "task", title: "Lamination", durationDays: 10, estimateOptimisticDays: 8, estimatePessimisticDays: 15, x: 300, y: 200 },
      { key: "s3", nodeType: "task", title: "Below deck rigging", durationDays: 6, estimateOptimisticDays: 5, estimatePessimisticDays: 9, x: 540, y: 200 },
      { key: "s4", nodeType: "task", title: "3-part assembly", durationDays: 4, estimateOptimisticDays: 3, estimatePessimisticDays: 7, x: 780, y: 200 },
      { key: "s5", nodeType: "task", title: "Over deck assembly", durationDays: 6, estimateOptimisticDays: 5, estimatePessimisticDays: 9, x: 1020, y: 200 },
      { key: "s6", nodeType: "task", title: "Hardware rigging", durationDays: 5, estimateOptimisticDays: 4, estimatePessimisticDays: 8, x: 60, y: 380 },
      { key: "s7", nodeType: "task", title: "Electrical rigging", durationDays: 5, estimateOptimisticDays: 4, estimatePessimisticDays: 8, x: 300, y: 380 },
      { key: "s8", nodeType: "task", title: "Upholstery", durationDays: 4, estimateOptimisticDays: 3, estimatePessimisticDays: 6, x: 540, y: 380 },
      { key: "s9", nodeType: "task", title: "Finishing and polishing", durationDays: 5, estimateOptimisticDays: 4, estimatePessimisticDays: 8, x: 780, y: 380 },
      { key: "s10", nodeType: "task", title: "Sea trial", durationDays: 2, estimateOptimisticDays: 1, estimatePessimisticDays: 4, x: 1020, y: 380 },
      { key: "m", nodeType: "milestone", title: "Delivery", x: 1260, y: 380 },
      { key: "r1", nodeType: "risk", title: "Resin supply delay", data: { likelihood: 3, impact: 4, response: "mitigate", mitigation: "Second supplier quoted" }, x: 300, y: 560 },
      { key: "r2", nodeType: "risk", title: "Weather window for sea trial", data: { likelihood: 2, impact: 3, response: "accept" }, x: 1020, y: 560 },
      { key: "d1", nodeType: "decision", title: "Engine option confirmed?", data: { question: "Which engine option?", options: [{ label: "Standard" }, { label: "Upgraded" }] }, x: 540, y: 560 },
    ],
    edges: [
      { from: "s1", to: "s2", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s2", to: "s3", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s3", to: "s4", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s4", to: "s5", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s5", to: "s6", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s6", to: "s7", edgeType: "dependency", depKind: "start_to_start", lagDays: 2 },
      { from: "s7", to: "s8", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s8", to: "s9", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s9", to: "s10", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "s10", to: "m", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "r1", to: "s2", edgeType: "risk_influence" },
      { from: "r2", to: "s10", edgeType: "risk_influence" },
      { from: "d1", to: "s7", edgeType: "reference" },
      { from: "m", to: "obj", edgeType: "contribution" },
    ],
  },
  {
    key: "builtin.refit",
    name: "Refit",
    description: "Survey, repairs and hand-back for an existing hull.",
    nodes: [
      { key: "a", nodeType: "task", title: "Survey and strip", durationDays: 3, estimateOptimisticDays: 2, estimatePessimisticDays: 5, x: 60, y: 200 },
      { key: "b", nodeType: "task", title: "Structural repairs", durationDays: 6, estimateOptimisticDays: 4, estimatePessimisticDays: 10, x: 320, y: 120 },
      { key: "c", nodeType: "task", title: "Systems refit", durationDays: 4, estimateOptimisticDays: 3, estimatePessimisticDays: 7, x: 320, y: 300 },
      { key: "d", nodeType: "task", title: "Finishing", durationDays: 3, estimateOptimisticDays: 2, estimatePessimisticDays: 5, x: 600, y: 200 },
      { key: "m", nodeType: "milestone", title: "Handover", x: 860, y: 200 },
      { key: "r", nodeType: "risk", title: "Hidden damage found", data: { likelihood: 3, impact: 3, response: "mitigate", mitigation: "Contingency days agreed" }, x: 320, y: 480 },
    ],
    edges: [
      { from: "a", to: "b", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "a", to: "c", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "b", to: "d", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "c", to: "d", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "d", to: "m", edgeType: "dependency", depKind: "finish_to_start" },
      { from: "r", to: "b", edgeType: "risk_influence" },
    ],
  },
  {
    key: "builtin.strategy",
    name: "Season strategy",
    description: "An objective, three key results and the initiatives that carry them.",
    nodes: [
      { key: "o", nodeType: "objective", title: "Season-ready fleet", x: 500, y: 20 },
      { key: "k1", nodeType: "key_result", title: "Every hull sea-trialled by the target date", data: { target: 100, unit: "percent" }, x: 100, y: 200 },
      { key: "k2", nodeType: "key_result", title: "Rework below 5% of hours", data: { target: 5, unit: "percent" }, x: 500, y: 200 },
      { key: "k3", nodeType: "key_result", title: "No open severe risks at launch", data: { target: 0, unit: "count" }, x: 900, y: 200 },
      { key: "i1", nodeType: "initiative", title: "Sea trial programme", durationDays: 20, x: 100, y: 380 },
      { key: "i2", nodeType: "initiative", title: "Quality gates at each stage", durationDays: 15, x: 500, y: 380 },
      { key: "i3", nodeType: "initiative", title: "Risk reviews every fortnight", durationDays: 30, x: 900, y: 380 },
    ],
    edges: [
      { from: "k1", to: "o", edgeType: "contribution" },
      { from: "k2", to: "o", edgeType: "contribution" },
      { from: "k3", to: "o", edgeType: "contribution" },
      { from: "i1", to: "k1", edgeType: "contribution" },
      { from: "i2", to: "k2", edgeType: "contribution" },
      { from: "i3", to: "k3", edgeType: "contribution" },
    ],
  },
];

export type TemplateSummary = {
  key: string;
  name: string;
  description: string | null;
  nodes: number;
  builtIn: boolean;
};

async function orgTemplates(ctx: Ctx): Promise<PlanTemplate[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings where org_id = ${ctx.orgId} and key = ${SETTINGS_KEY}
    `),
  )) as unknown as Array<{ value: unknown }>;
  const parsed = z.array(PlanTemplate).safeParse((rows[0]?.value as { templates?: unknown })?.templates ?? []);
  return parsed.success ? parsed.data : [];
}

export async function listTemplates(ctx: Ctx, archetype: RoleArchetype): Promise<TemplateSummary[]> {
  assertCan(archetype, "studio.view");
  const own = await orgTemplates(ctx);
  return [
    ...BUILT_IN_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description ?? null,
      nodes: t.nodes.length,
      builtIn: true,
    })),
    ...own.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description ?? null,
      nodes: t.nodes.length,
      builtIn: false,
    })),
  ];
}

export const CreateFromTemplateInput = z.object({
  templateKey: z.string().max(60),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
});

/** A new plan of DRAFT elements from a template, through the same doors as any edit. */
export async function createPlanFromTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string; nodes: number; edges: number }> {
  assertCan(archetype, "studio.manage");
  const input = CreateFromTemplateInput.parse(raw);
  const tpl =
    BUILT_IN_TEMPLATES.find((t) => t.key === input.templateKey) ??
    (await orgTemplates(ctx)).find((t) => t.key === input.templateKey);
  if (!tpl) throw new StudioError("template not found", "not_found");
  const plan = await createStudioPlan(ctx, archetype, {
    name: input.name,
    description: input.description ?? tpl.description,
  });
  const ids = new Map<string, string>();
  for (const n of tpl.nodes) {
    const created = await addNode(ctx, archetype, {
      planId: plan.id,
      nodeType: n.nodeType,
      title: n.title,
      description: n.description,
      x: n.x,
      y: n.y,
      ...(n.durationDays !== undefined ? { durationDays: n.durationDays } : {}),
      ...(n.data ? { data: n.data } : {}),
    });
    ids.set(n.key, created.id);
  }
  // Estimates ride the update path (the draft columns from 0109).
  const { updateNode } = await import("./graph");
  for (const n of tpl.nodes) {
    if (n.estimateOptimisticDays === undefined && n.estimatePessimisticDays === undefined) continue;
    await updateNode(ctx, archetype, {
      nodeId: ids.get(n.key)!,
      ...(n.estimateOptimisticDays !== undefined ? { estimateOptimisticDays: n.estimateOptimisticDays } : {}),
      ...(n.estimatePessimisticDays !== undefined ? { estimatePessimisticDays: n.estimatePessimisticDays } : {}),
    });
  }
  let edges = 0;
  for (const e of tpl.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    await addEdge(ctx, archetype, {
      planId: plan.id,
      sourceNodeId: from,
      targetNodeId: to,
      edgeType: e.edgeType,
      ...(e.depKind ? { depKind: e.depKind } : {}),
      ...(e.lagDays !== undefined ? { lagDays: e.lagDays } : {}),
    });
    edges++;
  }
  return { id: plan.id, reference: plan.reference, nodes: tpl.nodes.length, edges };
}

export const SaveAsTemplateInput = z.object({
  planId: z.string().uuid(),
  key: z.string().regex(/^[a-z0-9_.-]{1,60}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
});

/** Snapshot a plan's DRAFT elements as an organisation template (linked elements become drafts of the same shape). */
export async function saveAsTemplate(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ key: string; nodes: number; edges: number }> {
  assertCan(archetype, "studio.manage");
  const input = SaveAsTemplateInput.parse(raw);
  if (input.key.startsWith("builtin.")) throw new StudioError("that key is reserved", "invalid_state");
  const graph = await resolvePlanGraph(ctx, archetype, { planId: input.planId });
  const keys = new Map<string, string>();
  const nodes = graph.nodes.slice(0, 200).map((n, i) => {
    const key = `n${i}`;
    keys.set(n.id, key);
    return {
      key,
      nodeType: n.nodeType,
      title: n.title,
      description: n.description ?? undefined,
      durationDays: n.durationDays ?? undefined,
      estimateOptimisticDays: n.estimateOptimisticDays ?? undefined,
      estimatePessimisticDays: n.estimatePessimisticDays ?? undefined,
      data: Object.keys(n.data).length ? n.data : undefined,
      x: n.x,
      y: n.y,
    };
  });
  const edges = graph.edges
    .filter((e) => keys.has(e.sourceNodeId) && keys.has(e.targetNodeId))
    .slice(0, 400)
    .map((e) => ({
      from: keys.get(e.sourceNodeId)!,
      to: keys.get(e.targetNodeId)!,
      edgeType: e.edgeType,
      depKind: e.depKind ?? undefined,
      lagDays: e.lagDays || undefined,
    }));
  const tpl = PlanTemplate.parse({
    key: input.key,
    name: input.name,
    description: input.description,
    nodes,
    edges,
  });
  await command(
    ctx,
    {
      audit: {
        action: "studio.template.save",
        entityType: "studio_plan",
        entityId: input.planId,
        summary: `Saved plan as template "${input.name}" (${nodes.length} elements)`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select value from public.app_settings where org_id = ${ctx.orgId} and key = ${SETTINGS_KEY}
      `)) as unknown as Array<{ value: { templates?: PlanTemplate[] } | null }>;
      const existing = rows[0]?.value?.templates ?? [];
      const next = [...existing.filter((t) => t.key !== tpl.key), tpl];
      if (next.length > MAX_ORG_TEMPLATES) {
        throw new StudioError(`at most ${MAX_ORG_TEMPLATES} organisation templates`, "invalid_state");
      }
      await tx.execute(sql`
        insert into public.app_settings (org_id, key, value)
        values (${ctx.orgId}, ${SETTINGS_KEY}, ${JSON.stringify({ templates: next })}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value
      `);
    },
  );
  return { key: tpl.key, nodes: nodes.length, edges: edges.length };
}
