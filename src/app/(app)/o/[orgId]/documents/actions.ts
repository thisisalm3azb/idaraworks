"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createDocumentShare,
  revokeDocumentShare,
  SHARE_MAX_DAYS,
  type DocumentKind,
} from "@/modules/documents/service";

/** Where a document of each kind lives, so a revoke can revalidate its page. */
const DETAIL_PATH: Record<DocumentKind, (orgId: string, id: string) => string> = {
  quote: (o, id) => `/o/${o}/quotes/${id}`,
  invoice: (o, id) => `/o/${o}/invoices/${id}`,
  week_plan: (o, id) => `/o/${o}/week/plans/${id}`,
  // H23F — HR kinds are NOT shareable (SHAREABLE_KINDS), so no share ever
  // exists to revoke on these paths; the entries satisfy the exhaustive type
  // and point at the surfaces the records live on.
  payslip: (o) => `/o/${o}/payroll`,
  salary_certificate: (o, id) => `/o/${o}/people/${id}`,
  employment_contract: (o) => `/o/${o}/people`,
  experience_letter: (o, id) => `/o/${o}/people/${id}`,
  warning_letter: (o) => `/o/${o}/people`,
  leave_confirmation: (o) => `/o/${o}/leave`,
  expense_claim_summary: (o) => `/o/${o}/claims`,
  payroll_register: (o) => `/o/${o}/payroll`,
  final_settlement: (o) => `/o/${o}/people`,
};

export type CreateShareResult =
  { ok: true; link: string; expiresAt: string } | { ok: false; error: string };

/**
 * Mint a share link and return it ONCE, inline.
 *
 * The plaintext token is never stored and never placed in a URL the browser
 * would keep in history, so this returns it to the client rather than
 * redirecting with it. Losing it is recoverable only by minting another link.
 */
export async function createDocumentShareAction(
  orgId: string,
  kind: DocumentKind,
  id: string,
  days: number,
): Promise<CreateShareResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") return { ok: false, error: "mfa" };
  if (typeof resolved === "string") return { ok: false, error: "auth" };
  const requested = Number.isFinite(days) ? days : 7;
  try {
    const { token, expiresAt } = await createDocumentShare(resolved.ctx, resolved.archetype, {
      kind,
      id,
      days: Math.min(Math.max(Math.trunc(requested), 1), SHARE_MAX_DAYS),
    });
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
    revalidatePath(DETAIL_PATH[kind](orgId, id));
    return { ok: true, link: `${base}/d/${token}`, expiresAt };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: "forbidden" };
    return { ok: false, error: "failed" };
  }
}

export async function revokeDocumentShareAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const kind = String(formData.get("kind") ?? "") as DocumentKind;
  const subjectId = String(formData.get("subject_id") ?? "");
  const shareId = String(formData.get("share_id") ?? "");
  const path = DETAIL_PATH[kind] ? DETAIL_PATH[kind](orgId, subjectId) : `/o/${orgId}`;
  try {
    await revokeDocumentShare(resolved.ctx, resolved.archetype, shareId);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${path}?error=failed`);
  }
  revalidatePath(path);
  redirect(`${path}?ok=revoked`);
}
