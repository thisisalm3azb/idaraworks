"use server";

import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { moveStage, PipelineError, type StageRequirement } from "@/modules/crm/service";

export type MoveResult =
  | { ok: true; rowVersion: number; from: string; to: string }
  | {
      ok: false;
      code: "forbidden" | "conflict" | "requirements" | "state" | "not_found" | "failed";
      unmet?: StageRequirement[];
    };

/**
 * A stage move is a governed command: requirements are validated, the mover
 * and reason are recorded, history is preserved (sales_activity), and an
 * out-of-date card (row version) is refused instead of silently overwritten.
 */
export async function moveStageAction(
  orgId: string,
  payload: { id: string; stageKey: string; rowVersion: number; reason?: string | null },
): Promise<MoveResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, code: "forbidden" };
  try {
    const r = await moveStage(resolved.ctx, resolved.archetype, payload);
    revalidatePath(`/o/${orgId}/revenue/pipeline`);
    revalidatePath(`/o/${orgId}/revenue`);
    return { ok: true, rowVersion: r.rowVersion, from: r.from, to: r.to };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, code: "forbidden" };
    if (err instanceof PipelineError) {
      return {
        ok: false,
        code: err.code === "validation" ? "failed" : err.code,
        unmet: err.code === "requirements" ? (err.details as StageRequirement[]) : undefined,
      };
    }
    return { ok: false, code: "failed" };
  }
}
