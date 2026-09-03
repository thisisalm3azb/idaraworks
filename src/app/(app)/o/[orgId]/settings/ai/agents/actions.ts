"use server";

/**
 * H28 — the agent builder's server actions (ADR-53/63). Administrators only;
 * every draft is validated for narrowing and safe instructions before it is
 * stored, and publishing runs the evaluation suite for the agent's category
 * set and refuses to publish when a critical category fails.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import {
  AgentBuilderError,
  createCustomAgent,
  getCustomAgent,
  publishCustomAgent,
  retireCustomAgent,
  rollbackCustomAgent,
  updateCustomAgent,
  validateDraft,
  CustomAgentDraftSchema,
  AGENT_TEMPLATES,
  runAgentEvaluation,
} from "@/modules/idara/service";

const base = (orgId: string) => `/o/${orgId}/settings/ai/agents`;

async function ctxOrRedirect(orgId: string) {
  if (!idaraEnabled()) redirect("/");
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

function fail(orgId: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  if (err instanceof AgentBuilderError) {
    redirect(
      `${base(orgId)}?error=${err.code}${err.details.length ? `&details=${encodeURIComponent(err.details.join(","))}` : ""}`,
    );
  }
  const code =
    err instanceof ForbiddenError ? "forbidden" : err instanceof z.ZodError ? "invalid" : "failed";
  redirect(`${base(orgId)}?error=${code}`);
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

export async function createAgentAction(orgId: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  let id = "";
  try {
    const templateKey = str(fd, "template");
    const template = AGENT_TEMPLATES.find((x) => x.key === templateKey);
    const row = await createCustomAgent(r.ctx, r.archetype, {
      key: str(fd, "key"),
      baseAgentId: str(fd, "baseAgentId") ?? template?.baseAgentId,
      nameEn: str(fd, "nameEn") ?? template?.nameEn,
      nameAr: str(fd, "nameAr") ?? template?.nameAr,
      draft: template
        ? CustomAgentDraftSchema.parse({
            instructions: template.instructions,
            allowedTools: template.allowedTools,
          })
        : undefined,
    });
    id = row.id;
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?agent=${id}&ok=created`);
}

export async function updateAgentAction(orgId: string, id: string, fd: FormData): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await updateCustomAgent(r.ctx, r.archetype, {
      id,
      nameEn: str(fd, "nameEn") ?? undefined,
      nameAr: str(fd, "nameAr") ?? undefined,
      draft: {
        instructions: str(fd, "instructions") ?? "",
        allowedTools: fd.getAll("tools").map(String),
        availabilityRoles: fd.getAll("roles").map(String) as never,
        costCeilingCredits: str(fd, "costCeiling") === null ? null : Number(str(fd, "costCeiling")),
        evalRequired: fd.get("evalRequired") === "on",
      },
    });
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?agent=${id}&ok=saved`);
}

export async function publishAgentAction(orgId: string, id: string): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    const row = await getCustomAgent(r.ctx, id);
    if (!row) throw new AgentBuilderError("not_found");
    const v = validateDraft(row.baseAgentId, row.draft);
    if (!v.ok) throw v.error;
    // The evaluation runner: the safety categories the platform enforces for
    // every agent version, executed here against the deterministic pipeline.
    const outcome = await runAgentEvaluation(row.baseAgentId, row.draft);
    await publishCustomAgent(r.ctx, r.archetype, id, outcome);
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?agent=${id}&ok=published`);
}

export async function rollbackAgentAction(
  orgId: string,
  id: string,
  version: number,
): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await rollbackCustomAgent(r.ctx, r.archetype, id, version);
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?agent=${id}&ok=rolled_back`);
}

export async function retireAgentAction(orgId: string, id: string): Promise<void> {
  const r = await ctxOrRedirect(orgId);
  try {
    await retireCustomAgent(r.ctx, r.archetype, id);
  } catch (e) {
    fail(orgId, e);
  }
  revalidatePath(base(orgId));
  redirect(`${base(orgId)}?ok=retired`);
}
