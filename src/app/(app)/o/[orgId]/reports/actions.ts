"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { postConsumptionToStock } from "@/modules/inventory/service";
import { stockSurfacesEnabled } from "@/platform/flags";
import { logger } from "@/platform/logger";
import {
  submitDailyReport,
  reviewReport,
  returnReport,
  DuplicateReportError,
  ReportIdentityMismatchError,
  InvalidReportInputError,
  ReportStateError,
} from "@/modules/reports/service";

/**
 * The offline-tolerant submit. The composer calls this directly and handles the
 * RESULT (it does not redirect): on a network failure the client keeps the draft
 * + idempotency key and retries — the server makes the retry exactly-once.
 */
export type ReportSubmitPayload = {
  jobId: string;
  reportDate: string;
  summary: string;
  blockers?: string;
  nextSteps?: string;
  idempotencyKey: string;
  isBackfill?: boolean;
  workLines?: Array<{ stageKey?: string; description: string; progressNote?: string }>;
  materialLines?: Array<{ itemId?: string; itemName: string; qty: number; unit: string }>;
  labourLines?: Array<{ employeeId: string; normalHours: number; otHours: number }>;
};

export async function submitReportAction(
  orgId: string,
  payload: ReportSubmitPayload,
): Promise<{ ok: true; id: string; deduped: boolean } | { ok: false; error: string }> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") return { ok: false, error: "mfa_required" };
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  try {
    const res = await submitDailyReport(resolved.ctx, resolved.archetype, payload);
    revalidatePath(`/o/${orgId}/jobs/${payload.jobId}`);
    revalidatePath(`/o/${orgId}/reports/review`);
    return { ok: true, id: res.id, deduped: res.deduped };
  } catch (err) {
    if (err instanceof DuplicateReportError) return { ok: false, error: "duplicate" };
    if (err instanceof ReportIdentityMismatchError) return { ok: false, error: "identity" };
    if (err instanceof InvalidReportInputError) return { ok: false, error: "invalid" };
    return { ok: false, error: "failed" };
  }
}

export async function reviewReportAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const reportId = String(formData.get("report_id") ?? "");
  const base = `/o/${orgId}/reports/review`;
  try {
    await reviewReport(resolved.ctx, resolved.archetype, reportId);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof ReportStateError ? "state" : "failed"}`);
  }

  /*
   * TAKE THE MATERIAL OUT OF STOCK.
   *
   * The other half of the chain the receiving action completes. A reviewed
   * daily report is this product's record that material was USED — it is the
   * issue document — and H22C built the posting for it that nothing ever
   * called. Without this, stock in the ledger only ever goes up.
   *
   * After the review commits, never inside it, for the same reason receiving
   * posts after recording: the review is a decision a person made about work
   * that happened, and it must not be undone because a warehouse has no issuing
   * bin or because the ledger has no opening balance for an item a site has
   * plainly been using for months. That last case is the common one on a
   * database with history, and it is precisely why this is release gated: on a
   * deployment where the stock system is off, reviewing a report behaves
   * exactly as it always has.
   *
   * Historical reports are untouched. Only a report reviewed from here on is
   * posted, nothing rewrites a past one, and the legacy deducted_from_inventory
   * flag stays unwritten.
   */
  if (stockSurfacesEnabled() && can(resolved.archetype, "inventory.issue")) {
    try {
      await postConsumptionToStock(resolved.ctx, resolved.archetype, reportId);
    } catch (err) {
      if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
      logger.warn(
        { err: (err as Error).message, reportId, orgId },
        "daily report reviewed but material not booked out of stock",
      );
      revalidatePath(base);
      redirect(`${base}?ok=reviewed&warn=not_stocked`);
    }
  }

  revalidatePath(base);
  redirect(`${base}?ok=reviewed`);
}

export async function returnReportAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const reportId = String(formData.get("report_id") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const base = `/o/${orgId}/reports/review`;
  try {
    await returnReport(resolved.ctx, resolved.archetype, reportId, reason);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof InvalidReportInputError
        ? "reason"
        : err instanceof ReportStateError
          ? "state"
          : "failed";
    redirect(`${base}?error=${code}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=returned`);
}
