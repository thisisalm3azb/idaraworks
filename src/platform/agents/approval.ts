/**
 * Approval binding validation (H12 / A1). Execute-class agent actions route
 * through the EXISTING approval and command path — never a parallel system.
 * A1 ships the binding validator the future execute path must pass: an
 * approval is only valid for an agent execution when it belongs to the SAME
 * organization, was decided by a human with authority (not the agent), is
 * approved (not pending/declined), and names the same acting user's request.
 */
import type { Ctx } from "@/platform/tenancy";

export type ApprovalBinding = {
  id: string;
  orgId: string;
  /** The user whose agent request the approval covers. */
  requestedByUserId: string;
  /** The human who decided — must be a real user, never an agent. */
  decidedByUserId: string | null;
  status: "pending" | "approved" | "declined";
};

export type ApprovalBindingFailure =
  "wrong_org" | "wrong_user" | "not_decided" | "not_approved" | "self_approved";

export function validateApprovalBinding(
  ctx: Ctx,
  approval: ApprovalBinding,
): { ok: true } | { ok: false; reason: ApprovalBindingFailure } {
  if (approval.orgId !== ctx.orgId) return { ok: false, reason: "wrong_org" };
  if (approval.requestedByUserId !== ctx.userId) return { ok: false, reason: "wrong_user" };
  if (!approval.decidedByUserId) return { ok: false, reason: "not_decided" };
  if (approval.status !== "approved") return { ok: false, reason: "not_approved" };
  // A person must approve; the requester approving their own agent's
  // consequential action is refused here and re-checked by the domain
  // approval rules when the execute path ships.
  if (approval.decidedByUserId === approval.requestedByUserId) {
    return { ok: false, reason: "self_approved" };
  }
  return { ok: true };
}
