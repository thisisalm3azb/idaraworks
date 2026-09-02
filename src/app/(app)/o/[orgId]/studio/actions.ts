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
  type SimulationResult,
} from "@/modules/studio/service";

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
