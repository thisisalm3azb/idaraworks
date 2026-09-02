"use server";

import { ZodError } from "zod";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  createStudioPlan,
  addNode,
  updateNode,
  moveNodes,
  archiveNode,
  addEdge,
  removeEdge,
  convertNode,
  listLinkableTasks,
  captureBaseline,
  setNodeStatus,
  createScenario,
  updateScenario,
  submitScenario,
  applyScenario,
  discardScenario,
  simulatePlan,
  levelIntoScenario,
  linkNode,
  duplicateNode,
  saveView,
  updateView,
  draftReviewNarrative,
  createPlanFromTemplate,
  saveAsTemplate,
  type Narrative,
  type SimulationResult,
  type LevelingProposal,
} from "@/modules/studio/service";
import { allocateTask, unallocateTask } from "@/modules/jobs/service";

/**
 * H25 server actions for the canvas. Unlike the form pages, the canvas is a
 * live surface: actions RETURN typed results and the client reconciles state,
 * so a drag never reloads the page. Every action still resolves identity
 * server-side and calls the studio door, which enforces permissions, row
 * versions and the routing of linked-record writes. NOTHING here decides
 * anything about the plan.
 */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; code?: string };

type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtxForAction>>, string>;

async function resolveOrNull(orgId: string): Promise<Resolved | null> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return null;
  return resolved;
}

async function run<T>(orgId: string, fn: (r: Resolved) => Promise<T>): Promise<ActionResult<T>> {
  const resolved = await resolveOrNull(orgId);
  if (!resolved) return { ok: false, error: "unauthorized", code: "auth" };
  try {
    const data = await fn(resolved);
    return { ok: true, data };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
        : err instanceof Error
          ? err.message
          : "failed";
    return { ok: false, error: message.slice(0, 200), code };
  }
}

export async function createPlanAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let id = "";
  try {
    const r = await createStudioPlan(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? "") || undefined,
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const message = err instanceof Error ? err.message : "failed";
    redirect(`/o/${orgId}/studio?error=${encodeURIComponent(message.slice(0, 160))}`);
  }
  revalidatePath(`/o/${orgId}/studio`);
  redirect(`/o/${orgId}/studio/${id}`);
}

export async function addNodeAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => addNode(r.ctx, r.archetype, input));
}

export async function updateNodeAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ routed: string; rowVersion?: number }>> {
  return run(orgId, async (r) => {
    const res = (await updateNode(r.ctx, r.archetype, input)) as {
      routed: string;
      rowVersion?: number;
    };
    return res;
  });
}

export async function moveNodesAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ moved: number }>> {
  return run(orgId, (r) => moveNodes(r.ctx, r.archetype, input));
}

export async function archiveNodeAction(
  orgId: string,
  nodeId: string,
): Promise<ActionResult<undefined>> {
  return run(orgId, async (r) => {
    await archiveNode(r.ctx, r.archetype, nodeId);
    return undefined;
  });
}

export async function addEdgeAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string; taskDependencyId: string | null }>> {
  return run(orgId, async (r) => {
    const res = (await addEdge(r.ctx, r.archetype, input)) as {
      id: string;
      taskDependencyId?: string | null;
    };
    return { id: res.id, taskDependencyId: res.taskDependencyId ?? null };
  });
}

export async function removeEdgeAction(
  orgId: string,
  edgeId: string,
): Promise<ActionResult<undefined>> {
  return run(orgId, async (r) => {
    await removeEdge(r.ctx, r.archetype, edgeId);
    return undefined;
  });
}

export async function convertNodeAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ recordType: string; recordId: string }>> {
  return run(orgId, (r) => convertNode(r.ctx, r.archetype, input));
}

export async function listJobTasksAction(
  orgId: string,
  jobId: string,
): Promise<
  ActionResult<Array<{ id: string; title: string; status: string; dueDate: string | null }>>
> {
  return run(orgId, (r) => listLinkableTasks(r.ctx, r.archetype, jobId));
}

export async function setNodeStatusAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ routed: string }>> {
  return run(orgId, (r) => setNodeStatus(r.ctx, r.archetype, input));
}

export async function captureBaselineAction(
  orgId: string,
  input: { planId: string; name: string },
): Promise<ActionResult<{ id: string; entries: number }>> {
  return run(orgId, (r) => captureBaseline(r.ctx, r.archetype, input));
}

// ── H25G — scenarios ─────────────────────────────────────────────────────────

export async function createScenarioAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => createScenario(r.ctx, r.archetype, input));
}

export async function updateScenarioAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ rowVersion: number }>> {
  return run(orgId, (r) => updateScenario(r.ctx, r.archetype, input));
}

export async function submitScenarioAction(
  orgId: string,
  input: { scenarioId: string; expectedRowVersion?: number },
): Promise<ActionResult<{ status: string; approvalId: string }>> {
  return run(orgId, (r) => submitScenario(r.ctx, r.archetype, input));
}

export async function applyScenarioAction(
  orgId: string,
  input: { scenarioId: string; expectedRowVersion?: number },
): Promise<ActionResult<{ applied: number }>> {
  return run(orgId, (r) => applyScenario(r.ctx, r.archetype, input));
}

export async function discardScenarioAction(
  orgId: string,
  input: { scenarioId: string },
): Promise<ActionResult<void>> {
  return run(orgId, (r) => discardScenario(r.ctx, r.archetype, input));
}

/** Maps are not serialisable across the action boundary; hand back plain objects. */
export type SimulationDto =
  | Extract<SimulationResult, { ok: false }>
  | (Omit<Extract<SimulationResult, { ok: true }>, "criticality" | "finishByNode"> & {
      criticality: Record<string, number>;
      finishByNode: Record<string, { p50: string; p80: string; p90: string }>;
    });

export async function simulateAction(
  orgId: string,
  input: { planId: string; scenarioId?: string; samples?: number; seed?: number },
): Promise<ActionResult<SimulationDto>> {
  return run(orgId, async (r) => {
    const res = await simulatePlan(r.ctx, r.archetype, input);
    if (!res.ok) return res;
    return {
      ...res,
      criticality: Object.fromEntries(res.criticality),
      finishByNode: Object.fromEntries(res.finishByNode),
    };
  });
}

// ── H25H — resources ─────────────────────────────────────────────────────────

export async function allocateTaskAction(
  orgId: string,
  input: { taskId: string; employeeId: string; sharePct?: number; note?: string },
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => allocateTask(r.ctx, r.archetype, input));
}

export async function unallocateTaskAction(
  orgId: string,
  allocationId: string,
): Promise<ActionResult<void>> {
  return run(orgId, (r) => unallocateTask(r.ctx, r.archetype, allocationId));
}

export async function levelAction(
  orgId: string,
  input: { planId: string; name: string },
): Promise<
  ActionResult<{ scenarioId: string; proposals: LevelingProposal[]; unresolved: number }>
> {
  return run(orgId, (r) => levelIntoScenario(r.ctx, r.archetype, input));
}

// ── H25C — links, duplicates, saved views ────────────────────────────────────

export async function linkNodeAction(
  orgId: string,
  input: { nodeId: string; recordType: string; recordId: string },
): Promise<ActionResult<void>> {
  return run(orgId, (r) => linkNode(r.ctx, r.archetype, input));
}

export async function duplicateNodeAction(
  orgId: string,
  nodeId: string,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => duplicateNode(r.ctx, r.archetype, nodeId));
}

export async function saveViewAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => saveView(r.ctx, r.archetype, input));
}

export async function updateViewAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<void>> {
  return run(orgId, (r) => updateView(r.ctx, r.archetype, input));
}

// ── H25M — the assistant seam (fails closed; never acts) ─────────────────────

export async function reviewNarrativeAction(
  orgId: string,
  input: { planId: string; scenarioId?: string; locale?: "en" | "ar" },
): Promise<ActionResult<Narrative>> {
  return run(orgId, (r) => draftReviewNarrative(r.ctx, r.archetype, input));
}

// ── H25N — templates ─────────────────────────────────────────────────────────

export async function createFromTemplateAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let id = "";
  try {
    const r = await createPlanFromTemplate(resolved.ctx, resolved.archetype, {
      templateKey: String(formData.get("template") ?? ""),
      name: String(formData.get("name") ?? ""),
      ...(formData.get("startDate") ? { startDate: String(formData.get("startDate")) } : {}),
    });
    id = r.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    redirect(`/o/${orgId}/studio?error=${encodeURIComponent(message.slice(0, 200))}`);
  }
  revalidatePath(`/o/${orgId}/studio`);
  redirect(`/o/${orgId}/studio/${id}`);
}

export async function saveAsTemplateAction(
  orgId: string,
  input: { planId: string; key: string; name: string; description?: string },
): Promise<ActionResult<{ key: string; nodes: number; edges: number }>> {
  return run(orgId, (r) => saveAsTemplate(r.ctx, r.archetype, input));
}
