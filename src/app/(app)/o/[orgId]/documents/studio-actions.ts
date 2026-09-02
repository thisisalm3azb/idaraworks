"use server";

import { ZodError } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { clientIpFromHeaders } from "@/platform/http/clientIp";
import {
  archiveDocument,
  createDocument,
  createFolder,
  createSuccessor,
  createTemplate,
  extendRetention,
  getRevision,
  issueDocument,
  publishTemplate,
  reopenForEditing,
  retireTemplate,
  returnToDraft,
  saveDocView,
  saveRevision,
  setDocSettings,
  submitForReview,
  terminateDocument,
  updateDocView,
  updateDocument,
  updateFolder,
  updateTemplate,
  diffRevisions,
  createWorkflow,
  updateWorkflow,
  decideReviewStep,
  delegateStep,
  WORKFLOW_PRESETS,
  createDocComment,
  resolveDocComment,
  removeDocComment,
  decideSuggestion,
  createSignatureRequest,
  inviteSigners,
  revokeSigner,
  reinviteSigner,
  cancelSignatureRequest,
  signAsMember,
  type InvitationLink,
  createFormLink,
  revokeFormLink,
  createObligation,
  updateObligation,
  completeObligation,
  waiveObligation,
  cancelObligation,
  reopenObligation,
  escalateObligation,
  type ObligationRow,
  reviewSubmission,
  convertSubmission,
  type RevisionDiff,
} from "@/modules/docstudio/service";

/**
 * H26 server actions. The builder is a live surface: actions RETURN typed
 * results and the client reconciles (autosave never reloads the page).
 * Every action resolves identity server-side and calls the module door,
 * which enforces permissions, states and row versions. Nothing here decides
 * anything about a document.
 */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; code?: string };

type Resolved = Exclude<Awaited<ReturnType<typeof resolveCtxForAction>>, string>;

async function run<T>(orgId: string, fn: (r: Resolved) => Promise<T>): Promise<ActionResult<T>> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, error: "unauthorized", code: "auth" };
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
    return { ok: false, error: message.slice(0, 240), code };
  }
}

const docPath = (orgId: string, id: string) => `/o/${orgId}/documents/${id}`;

function messageOf(err: unknown): string {
  return err instanceof ZodError
    ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
    : err instanceof Error
      ? err.message
      : "failed";
}

// ── create (form → redirect) ─────────────────────────────────────────────────
export async function createDocumentAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let id = "";
  try {
    const source = String(formData.get("source") ?? "");
    const counterpartyKind = String(formData.get("counterpartyKind") ?? "");
    const counterpartyId = String(formData.get("counterpartyId") ?? "");
    const counterpartyLabel = String(formData.get("counterpartyLabel") ?? "");
    const recordType = String(formData.get("recordType") ?? "");
    const recordId = String(formData.get("recordId") ?? "");
    const r = await createDocument(resolved.ctx, resolved.archetype, {
      title: String(formData.get("title") ?? ""),
      category: String(formData.get("category") ?? "other"),
      language: String(formData.get("language") ?? "en"),
      ...(source.startsWith("builtin.") ? { builtinKey: source } : {}),
      ...(source && !source.startsWith("builtin.") && source !== "blank"
        ? { templateId: source }
        : {}),
      folderId: String(formData.get("folderId") ?? "") || null,
      tags: String(formData.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
      counterparty: counterpartyKind
        ? {
            kind: counterpartyKind,
            id: counterpartyId || null,
            label: counterpartyKind === "other" ? counterpartyLabel || null : null,
          }
        : null,
      record: recordType && recordId ? { type: recordType, id: recordId } : null,
      expiresAt: String(formData.get("expiresAt") ?? "") || null,
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/documents/new?error=${encodeURIComponent(messageOf(err).slice(0, 160))}`);
  }
  revalidatePath(`/o/${orgId}/documents`);
  redirect(docPath(orgId, id));
}

// ── live actions ─────────────────────────────────────────────────────────────
export async function saveRevisionAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ rowVersion: number; savedAt: string }>> {
  return run(orgId, (r) => saveRevision(r.ctx, r.archetype, input));
}

export async function updateDocumentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ rowVersion: number }>> {
  return run(orgId, async (r) => {
    const res = await updateDocument(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function submitForReviewAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ revisionId: string }>> {
  return run(orgId, async (r) => {
    const res = await submitForReview(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function returnToDraftAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ revisionId: string }>> {
  return run(orgId, async (r) => {
    const res = await returnToDraft(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function reopenAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ revisionId: string }>> {
  return run(orgId, async (r) => {
    const res = await reopenForEditing(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function issueDocumentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<
  ActionResult<{ snapshotId: string; contentHash: string; status: string; parties: string[] }>
> {
  return run(orgId, async (r) => {
    const res = await issueDocument(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function terminateDocumentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await terminateDocument(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function archiveDocumentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await archiveDocument(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function createSuccessorAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string; reference: string }>> {
  return run(orgId, async (r) => {
    const res = await createSuccessor(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return { id: res.id, reference: res.reference };
  });
}

export async function extendRetentionAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ retentionUntil: string }>> {
  return run(orgId, (r) => extendRetention(r.ctx, r.archetype, input));
}

export async function diffRevisionsAction(
  orgId: string,
  input: { beforeId: string; afterId: string },
): Promise<ActionResult<RevisionDiff>> {
  return run(orgId, async (r) => {
    const [a, b] = await Promise.all([
      getRevision(r.ctx, r.archetype, input.beforeId),
      getRevision(r.ctx, r.archetype, input.afterId),
    ]);
    return diffRevisions(a.body, b.body);
  });
}

// ── library ──────────────────────────────────────────────────────────────────
export async function createFolderAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await createFolder(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function updateFolderAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await updateFolder(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function saveViewAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await saveDocView(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function updateViewAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await updateDocView(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function setDocSettingsAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ retentionYears: number }>> {
  return run(orgId, async (r) => {
    const res = await setDocSettings(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return { retentionYears: res.retentionYears };
  });
}

// ── templates ────────────────────────────────────────────────────────────────
export async function createTemplateAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let id = "";
  try {
    const from = String(formData.get("from") ?? "");
    const r = await createTemplate(resolved.ctx, resolved.archetype, {
      key: String(formData.get("key") ?? ""),
      nameEn: String(formData.get("nameEn") ?? ""),
      nameAr: String(formData.get("nameAr") ?? ""),
      category: String(formData.get("category") ?? "other"),
      language: String(formData.get("language") ?? "en"),
      description: String(formData.get("description") ?? "") || undefined,
      ...(from.startsWith("builtin.") ? { fromBuiltinKey: from } : {}),
      ...(from.startsWith("doc:") ? { fromDocumentId: from.slice(4) } : {}),
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/documents/templates?error=${encodeURIComponent(messageOf(err).slice(0, 160))}`,
    );
  }
  revalidatePath(`/o/${orgId}/documents/templates`);
  redirect(`/o/${orgId}/documents/templates/${id}`);
}

export async function updateTemplateAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ draftVersionId: string | null }>> {
  return run(orgId, async (r) => {
    const res = await updateTemplate(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/templates/${String(input.templateId)}`);
    return res;
  });
}

export async function publishTemplateAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ version: number }>> {
  return run(orgId, async (r) => {
    const res = await publishTemplate(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/templates`);
    revalidatePath(`/o/${orgId}/documents/templates/${String(input.templateId)}`);
    return res;
  });
}

export async function retireTemplateAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await retireTemplate(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/templates`);
    return res;
  });
}

// ── workflows (H26D) ─────────────────────────────────────────────────────────
export async function createWorkflowAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  let id = "";
  try {
    const preset = String(formData.get("preset") ?? "");
    const found = WORKFLOW_PRESETS.find((p) => p.key === preset);
    const r = await createWorkflow(resolved.ctx, resolved.archetype, {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? "") || undefined,
      ...(found ? { definition: found.definition } : {}),
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/documents/workflows?error=${encodeURIComponent(messageOf(err).slice(0, 160))}`,
    );
  }
  revalidatePath(`/o/${orgId}/documents/workflows`);
  redirect(`/o/${orgId}/documents/workflows/${id}`);
}

export async function updateWorkflowAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ rowVersion: number }>> {
  return run(orgId, async (r) => {
    const res = await updateWorkflow(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/workflows`);
    revalidatePath(`/o/${orgId}/documents/workflows/${String(input.workflowId)}`);
    return res;
  });
}

export async function decideReviewStepAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await decideReviewStep(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

export async function delegateStepAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await delegateStep(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents`);
    return res;
  });
}

// ── collaboration (H26E) ─────────────────────────────────────────────────────
export async function createDocCommentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await createDocComment(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function resolveDocCommentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => resolveDocComment(r.ctx, r.archetype, input));
}

export async function removeDocCommentAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => removeDocComment(r.ctx, r.archetype, input));
}

export async function decideSuggestionAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string; applied: boolean }>> {
  return run(orgId, (r) => decideSuggestion(r.ctx, r.archetype, input));
}

// ── signatures (H26F) ────────────────────────────────────────────────────────
async function signingInfo(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIpFromHeaders(h) || null, userAgent: h.get("user-agent") };
}

export async function createSignatureRequestAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string; invitations: InvitationLink[] }>> {
  return run(orgId, async (r) => {
    const res = await createSignatureRequest(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function inviteSignersAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<InvitationLink[]>> {
  return run(orgId, (r) => inviteSigners(r.ctx, r.archetype, input));
}

export async function revokeSignerAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => revokeSigner(r.ctx, r.archetype, input));
}

export async function reinviteSignerAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<InvitationLink[]>> {
  return run(orgId, (r) => reinviteSigner(r.ctx, r.archetype, input));
}

export async function cancelSignatureRequestAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => cancelSignatureRequest(r.ctx, r.archetype, input));
}

export async function signAsMemberAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ completed: boolean; evidenceHash: string }>> {
  return run(orgId, async (r) => signAsMember(r.ctx, r.archetype, input, await signingInfo()));
}

// ── forms (H26G) ─────────────────────────────────────────────────────────────
export async function createFormLinkAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string; url: string }>> {
  return run(orgId, async (r) => {
    const res = await createFormLink(r.ctx, r.archetype, input);
    revalidatePath(docPath(orgId, String(input.documentId)));
    return res;
  });
}

export async function revokeFormLinkAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, (r) => revokeFormLink(r.ctx, r.archetype, input));
}

export async function reviewSubmissionAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await reviewSubmission(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/forms`);
    return res;
  });
}

export async function convertSubmissionAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<{ recordType: string; recordId: string }>> {
  return run(orgId, async (r) => {
    const res = await convertSubmission(r.ctx, r.archetype, input);
    revalidatePath(`/o/${orgId}/documents/forms`);
    return res;
  });
}

// ── obligations (H26H) ───────────────────────────────────────────────────────
function obligationPaths(orgId: string, documentId?: string): void {
  revalidatePath(`/o/${orgId}/documents/obligations`);
  revalidatePath(`/o/${orgId}/documents`);
  if (documentId) revalidatePath(docPath(orgId, documentId));
}

export async function createObligationAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<ObligationRow>> {
  return run(orgId, async (r) => {
    const res = await createObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, res.documentId);
    return res;
  });
}

export async function updateObligationAction(
  orgId: string,
  input: Record<string, unknown>,
): Promise<ActionResult<ObligationRow>> {
  return run(orgId, async (r) => {
    const res = await updateObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, res.documentId);
    return res;
  });
}

export async function completeObligationAction(
  orgId: string,
  input: Record<string, unknown> & { documentId?: string },
): Promise<ActionResult<{ id: string; nextId: string | null }>> {
  return run(orgId, async (r) => {
    const res = await completeObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, input.documentId);
    return res;
  });
}

export async function closeObligationAction(
  orgId: string,
  input: Record<string, unknown> & { documentId?: string; mode: "waive" | "cancel" },
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res =
      input.mode === "waive"
        ? await waiveObligation(r.ctx, r.archetype, input)
        : await cancelObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, input.documentId);
    return res;
  });
}

export async function reopenObligationAction(
  orgId: string,
  input: Record<string, unknown> & { documentId?: string },
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await reopenObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, input.documentId);
    return res;
  });
}

export async function escalateObligationAction(
  orgId: string,
  input: Record<string, unknown> & { documentId?: string },
): Promise<ActionResult<{ id: string }>> {
  return run(orgId, async (r) => {
    const res = await escalateObligation(r.ctx, r.archetype, input);
    obligationPaths(orgId, input.documentId);
    return res;
  });
}
