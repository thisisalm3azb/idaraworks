"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  addCompetitor,
  addProductLine,
  addRisk,
  addStakeholder,
  crmAssist,
  CrmAiError,
  getOpportunityCommercial,
  listProductLines,
  logActivity,
  moveStage,
  PipelineError,
  requestDiscount,
  saveDealCanvas,
  setRiskStatus,
  updateCommercial,
  type CanvasDoc,
  type CrmAiResult,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const num = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const minor = (fd: FormData, k: string) => {
  const n = num(fd, k);
  return n === null ? null : Math.round(n * 100);
};

async function ctxOrRedirect(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}
function fail(back: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  if (err instanceof PipelineError) {
    const unmet = err.code === "requirements" ? `&unmet=${(err.details ?? []).join(",")}` : "";
    redirect(`${back}${back.includes("?") ? "&" : "?"}error=${err.code}${unmet}`);
  }
  const code = err instanceof ForbiddenError ? "forbidden" : "failed";
  redirect(`${back}${back.includes("?") ? "&" : "?"}error=${code}`);
}
const dealBase = (orgId: string, id: string) => `/o/${orgId}/revenue/deals/${id}`;

export async function moveStageFormAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = dealBase(orgId, opportunityId);
  try {
    await moveStage(resolved.ctx, resolved.archetype, {
      id: opportunityId,
      stageKey: String(formData.get("stage_key") ?? ""),
      rowVersion: Number(formData.get("row_version") ?? 0),
      reason: str(formData, "reason"),
    });
    revalidatePath(back);
    revalidatePath(`/o/${orgId}/revenue/pipeline`);
    redirect(`${back}?ok=moved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updateCommercialAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=commercial`;
  const buyingProcess = (str(formData, "buying_process") ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => {
      const done = /^\[x\]/i.test(line);
      const parts = line
        .replace(/^\[[ x]\]\s*/i, "")
        .split("|")
        .map((p) => p.trim());
      return {
        step: (parts[0] ?? "").slice(0, 120),
        ...(done ? { done: true } : {}),
        ...(parts[1] ? { owner: parts[1].slice(0, 120) } : {}),
        ...(parts[2] && /^\d{4}-\d{2}-\d{2}$/.test(parts[2]) ? { due: parts[2] } : {}),
      };
    })
    .filter((s) => s.step);
  const prob = num(formData, "probability");
  try {
    await updateCommercial(resolved.ctx, resolved.archetype, {
      id: opportunityId,
      rowVersion: Number(formData.get("row_version") ?? 0),
      forecastCategory: str(formData, "forecast_category") ?? undefined,
      kind: str(formData, "kind") ?? undefined,
      amountKind: str(formData, "amount_kind") ?? undefined,
      recurringMinor: minor(formData, "recurring_major"),
      recurrenceMonths: num(formData, "recurrence_months"),
      currency: str(formData, "currency")?.toUpperCase() ?? null,
      probability: prob === null ? null : Math.round(prob),
      expectedCloseDate: str(formData, "close_date"),
      decisionCriteria: str(formData, "decision_criteria"),
      needs: str(formData, "needs"),
      buyingProcess,
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function addStakeholderAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=stakeholders`;
  try {
    await addStakeholder(resolved.ctx, resolved.archetype, {
      opportunityId,
      contactId: str(formData, "contact_id"),
      name: str(formData, "name"),
      roleKind: str(formData, "role_kind") ?? "other",
      influence: num(formData, "influence") ?? 3,
      sentiment: str(formData, "sentiment") ?? "unknown",
      notes: str(formData, "notes"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function addProductLineAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=products`;
  try {
    await addProductLine(resolved.ctx, resolved.archetype, {
      opportunityId,
      description: str(formData, "description") ?? "",
      qty: num(formData, "qty") ?? 1,
      unit: str(formData, "unit") ?? "ea",
      unitPriceMinor: minor(formData, "unit_price_major") ?? 0,
      discountPct: num(formData, "discount_pct") ?? 0,
      vatRate: num(formData, "vat_rate") ?? 0,
      optional: formData.get("optional") === "on",
      recurrenceMonths: num(formData, "recurrence_months"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function addCompetitorAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=risks`;
  try {
    await addCompetitor(resolved.ctx, resolved.archetype, {
      opportunityId,
      name: str(formData, "name") ?? "",
      strengths: str(formData, "strengths"),
      weaknesses: str(formData, "weaknesses"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function addRiskAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=risks`;
  try {
    await addRisk(resolved.ctx, resolved.archetype, {
      opportunityId,
      kind: str(formData, "kind") ?? "risk",
      title: str(formData, "title") ?? "",
      severity: str(formData, "severity") ?? "medium",
      mitigation: str(formData, "mitigation"),
      ownerUserId: str(formData, "owner_user_id"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

export async function setRiskStatusAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=risks`;
  try {
    await setRiskStatus(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      status: String(formData.get("status") ?? "open"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

/** A discount is a request reviewed by a person through the approvals module; nothing changes on the quote. */
export async function requestDiscountAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=products`;
  try {
    const [lines, o] = await Promise.all([
      listProductLines(resolved.ctx, resolved.archetype, opportunityId),
      getOpportunityCommercial(resolved.ctx, resolved.archetype, opportunityId),
    ]);
    const fromLines = lines.filter((l) => !l.optional).reduce((s, l) => s + l.lineNetMinor, 0);
    const listTotalMinor = fromLines > 0 ? fromLines : (o?.estimatedValueMinor ?? 0);
    await requestDiscount(resolved.ctx, resolved.archetype, {
      opportunityId,
      quoteId: o?.quoteId ?? null,
      requestedPct: num(formData, "requested_pct") ?? 0,
      listTotalMinor,
      currency: o?.currency ?? resolved.baseCurrency,
      reason: str(formData, "reason") ?? "",
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=discount`);
  } catch (err) {
    fail(back, err);
  }
}

export async function logDealActivityAction(
  orgId: string,
  opportunityId: string,
  formData: FormData,
): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `${dealBase(orgId, opportunityId)}?tab=history`;
  try {
    await logActivity(resolved.ctx, resolved.archetype, {
      opportunityId,
      kind: String(formData.get("kind") ?? "note"),
      title: str(formData, "title"),
      body: str(formData, "body"),
      dueDate: str(formData, "due_date"),
      outcome: str(formData, "outcome"),
    });
    revalidatePath(dealBase(orgId, opportunityId));
    redirect(`${back}&ok=logged`);
  } catch (err) {
    fail(back, err);
  }
}

export type SaveCanvasResult =
  { ok: true; rowVersion: number } | { ok: false; code: "forbidden" | "conflict" | "failed" };

export async function saveCanvasAction(
  orgId: string,
  payload: { opportunityId: string; doc: CanvasDoc; rowVersion: number },
): Promise<SaveCanvasResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, code: "forbidden" };
  try {
    const r = await saveDealCanvas(resolved.ctx, resolved.archetype, payload);
    return { ok: true, rowVersion: r.rowVersion };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, code: "forbidden" };
    if (err instanceof PipelineError && err.code === "conflict")
      return { ok: false, code: "conflict" };
    if (/conflict|row_version|version/i.test((err as Error).message ?? ""))
      return { ok: false, code: "conflict" };
    return { ok: false, code: "failed" };
  }
}

export type AssistResult =
  | ({ ok: true } & CrmAiResult)
  | { ok: false; code: "unavailable" | "forbidden" | "failed"; ownerAction: string | null };

/** Read-only: the assistant proposes; every action stays with a person. */
export async function crmAssistAction(
  orgId: string,
  payload: {
    kind: "customer" | "opportunity";
    id: string;
    mode: "brief" | "actions" | "risks" | "ask";
    question?: string;
  },
): Promise<AssistResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, code: "forbidden", ownerAction: null };
  try {
    const r = await crmAssist(resolved.ctx, resolved.archetype, payload);
    return { ok: true, ...r };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, code: "forbidden", ownerAction: null };
    if (err instanceof CrmAiError)
      return {
        ok: false,
        code: err.code === "unavailable" ? "unavailable" : "failed",
        ownerAction: err.ownerAction ?? null,
      };
    return { ok: false, code: "failed", ownerAction: null };
  }
}
