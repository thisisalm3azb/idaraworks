"use server";

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
    const message = err instanceof Error ? err.message : "failed";
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
