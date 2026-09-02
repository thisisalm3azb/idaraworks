"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  captureLead,
  convertLeadSafely,
  disqualifyLead,
  LeadError,
  reviewQuarantine,
  updateLeadCrm,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const num = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
};

async function ctxOrRedirect(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

function fail(orgId: string, err: unknown, extra = ""): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  const code =
    err instanceof ForbiddenError ? "forbidden" : err instanceof LeadError ? err.code : "failed";
  redirect(`/o/${orgId}/revenue/leads?error=${code}${extra}`);
}

/** Capture an enquiry by hand: trusted source, consent recorded only when ticked. */
export async function captureLeadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const consent = (["email", "sms", "whatsapp", "phone"] as const)
    .filter((ch) => formData.get(`consent_${ch}`) === "on")
    .map((channel) => ({ channel, evidence: "Ticked at manual capture" }));
  const value = num(formData, "value_major");
  try {
    const r = await captureLead(resolved.ctx, resolved.archetype, {
      name: str(formData, "name") ?? "",
      contactName: str(formData, "contact_name"),
      email: str(formData, "email"),
      phone: str(formData, "phone"),
      country: str(formData, "country")?.toUpperCase() ?? null,
      sourceKind: str(formData, "source_kind") ?? "manual",
      source: str(formData, "source"),
      campaignId: str(formData, "campaign_id"),
      estimatedValueMinor: value === null ? null : value * 100,
      currency: value === null ? null : (str(formData, "currency") ?? null),
      timeframe: str(formData, "timeframe"),
      interest: str(formData, "interest"),
      notes: str(formData, "notes"),
      consent,
    });
    revalidatePath(`/o/${orgId}/revenue/leads`);
    redirect(
      `/o/${orgId}/revenue/leads?ok=captured${r.duplicates.length ? `&dups=${r.lead.id}` : ""}`,
    );
  } catch (err) {
    fail(orgId, err);
  }
}

export async function reviewQuarantineAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  try {
    await reviewQuarantine(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      decision: String(formData.get("decision") ?? ""),
    });
    revalidatePath(`/o/${orgId}/revenue/leads`);
    redirect(`/o/${orgId}/revenue/leads?ok=reviewed&quarantine=quarantined`);
  } catch (err) {
    fail(orgId, err);
  }
}

export async function disqualifyLeadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  try {
    await disqualifyLead(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      reason: String(formData.get("reason") ?? "other"),
      note: str(formData, "note"),
    });
    revalidatePath(`/o/${orgId}/revenue/leads`);
    redirect(`/o/${orgId}/revenue/leads?ok=disqualified`);
  } catch (err) {
    fail(orgId, err);
  }
}

export async function qualifyLeadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const id = String(formData.get("id") ?? "");
  const value = num(formData, "value_major");
  try {
    await updateLeadCrm(resolved.ctx, resolved.archetype, {
      id,
      estimatedValueMinor: value === null ? undefined : value * 100,
      currency: value === null ? undefined : (str(formData, "currency") ?? undefined),
      timeframe: str(formData, "timeframe") ?? undefined,
      qualification: {
        budget: formData.get("q_budget") === "on",
        authority: formData.get("q_authority") === "on",
        need: formData.get("q_need") === "on",
        timing: formData.get("q_timing") === "on",
        note: str(formData, "q_note") ?? undefined,
      },
    });
    revalidatePath(`/o/${orgId}/revenue/leads`);
    redirect(`/o/${orgId}/revenue/leads?ok=qualified&open=${id}`);
  } catch (err) {
    fail(orgId, err, `&open=${id}`);
  }
}

/**
 * Conversion is idempotent and duplicate-safe: when the lead looks like an
 * existing customer the service refuses until the person picks that customer
 * or explicitly acknowledges the candidates.
 */
export async function convertLeadAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const leadId = String(formData.get("id") ?? "");
  const customerId = str(formData, "customer_id");
  const value = num(formData, "value_major");
  try {
    const r = await convertLeadSafely(resolved.ctx, resolved.archetype, {
      leadId,
      opportunityName: str(formData, "opportunity_name") ?? undefined,
      customerId: customerId ?? undefined,
      createCustomer: !customerId,
      estimatedValueMinor: value === null ? undefined : value * 100,
      expectedCloseDate: str(formData, "close_date") ?? undefined,
      acknowledgeDuplicates: formData.get("acknowledge") === "on",
    });
    revalidatePath(`/o/${orgId}/revenue/leads`);
    revalidatePath(`/o/${orgId}/revenue/pipeline`);
    redirect(`/o/${orgId}/revenue/deals/${r.opportunityId}?ok=converted`);
  } catch (err) {
    if (err instanceof LeadError && err.code === "duplicates") {
      redirect(`/o/${orgId}/revenue/leads?error=duplicates&open=${leadId}&convert=${leadId}`);
    }
    fail(orgId, err, `&open=${leadId}`);
  }
}
