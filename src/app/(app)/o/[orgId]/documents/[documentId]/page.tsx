import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { documentStudioEnabled } from "@/platform/flags";
import { loadOrgTerminology, term } from "@/platform/terminology";
import {
  BLOCK_TYPES,
  BINDING_PATHS,
  CONDITION_OPS,
  FIELD_KINDS,
  SIGNATURE_PARTS,
  DOC_CATEGORIES,
  DOC_STATUSES,
  DocError,
  documentCapabilities,
  getDocument,
  listFolders,
} from "@/modules/docstudio/service";
import { DocumentWorkspace, type WorkspaceDict } from "./DocumentWorkspace";
import { builderDict } from "./builderDict";

/** H26 — one document: build it, review it, issue it, follow it. */
export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; documentId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  if (!documentStudioEnabled()) notFound();
  const { orgId, documentId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "documents.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  let detail;
  try {
    detail = await getDocument(resolved.ctx, resolved.archetype, documentId);
  } catch (err) {
    if (err instanceof DocError && err.code === "not_found") notFound();
    throw err;
  }
  const folders = await listFolders(resolved.ctx, resolved.archetype);
  const caps = documentCapabilities(resolved.archetype, detail.document);
  const k = (key: string) => t(`docstudio.ws.${key}`);
  const dict: WorkspaceDict = {
    status: Object.fromEntries(DOC_STATUSES.map((s) => [s, t(`docstudio.status.${s}`)])),
    category: Object.fromEntries(DOC_CATEGORIES.map((c) => [c, t(`docstudio.category.${c}`)])),
    blockTypes: Object.fromEntries(BLOCK_TYPES.map((b) => [b, t(`docstudio.block.${b}`)])),
    bindings: Object.fromEntries(
      BINDING_PATHS.map((p) => [p, t(`docstudio.binding.${p.replace(/\./g, "_")}`)]),
    ),
    counterparty: {
      customer: t("docstudio.counterparty.customer"),
      supplier: t("docstudio.counterparty.supplier"),
      employee: t("docstudio.counterparty.employee"),
      other: t("docstudio.counterparty.other"),
    },
    recordKinds: {
      quote: t("docstudio.record.quote"),
      invoice: t("docstudio.record.invoice"),
      job: term("job", terms, "singular"),
    },
    tabs: {
      edit: k("tab_edit"),
      preview: k("tab_preview"),
      revisions: k("tab_revisions"),
      activity: k("tab_activity"),
      details: k("tab_details"),
    },
    actions: {
      submit: k("submit"),
      returnDraft: k("return_draft"),
      reopen: k("reopen"),
      issue: k("issue"),
      terminate: k("terminate"),
      archive: k("archive"),
      restore: k("restore"),
      supersede: k("supersede"),
      preview: k("preview"),
      print: k("print"),
      pdf: k("pdf"),
      confirm: k("confirm"),
      cancel: t("docstudio.cancel"),
      close: k("close"),
      note: k("note"),
      reason: k("reason"),
      issueTitle: k("issue_title"),
      issueBody: k("issue_body"),
      terminateTitle: k("terminate_title"),
      terminateBody: k("terminate_body"),
      returnTitle: k("return_title"),
      supersedeTitle: k("supersede_title"),
      supersedeBody: k("supersede_body"),
      refresh: k("refresh"),
      loading: k("loading"),
      loadFailed: k("load_failed"),
      openTab: k("open_tab"),
    },
    builder: builderDict(t),
    revisions: {
      title: k("revisions_title"),
      compare: k("compare"),
      from: k("from"),
      to: k("to"),
      working: k("working"),
      frozen: k("frozen"),
      hash: k("hash"),
      added: k("added"),
      removed: k("removed"),
      changed: k("changed"),
      moved: k("moved"),
      unchanged: k("unchanged"),
      noDiff: k("no_diff"),
      view: k("view_revision"),
    },
    activity: {
      title: k("activity_title"),
      chainOk: k("chain_ok"),
      chainBroken: k("chain_broken"),
      snapshotHash: k("snapshot_hash"),
      retention: k("retention"),
      legalHold: k("legal_hold"),
      kinds: Object.fromEntries(
        [
          "created",
          "revision_frozen",
          "revision_opened",
          "submitted_for_review",
          "review_returned",
          "review_approved",
          "approval_started",
          "approval_step_decided",
          "approval_completed",
          "approval_rejected",
          "issued",
          "signature_requested",
          "invitation_sent",
          "invitation_viewed",
          "invitation_revoked",
          "signed",
          "declined",
          "activated",
          "expired",
          "terminated",
          "superseded",
          "archived",
          "restored",
          "pdf_rendered",
          "obligation_added",
          "obligation_completed",
          "obligation_waived",
          "form_submitted",
          "form_converted",
          "comment_added",
          "suggestion_accepted",
          "suggestion_rejected",
          "retention_extended",
          "legal_hold_set",
        ].map((x) => [x, t(`docstudio.event.${x}`)]),
      ),
    },
    details: {
      title: k("details_title"),
      reference: t("docstudio.columns.reference"),
      docTitle: t("docstudio.field.title"),
      category: t("docstudio.field.category"),
      language: t("docstudio.field.language"),
      counterparty: t("docstudio.field.counterparty"),
      record: t("docstudio.field.record"),
      folder: t("docstudio.field.folder"),
      noFolder: t("docstudio.field.no_folder"),
      tags: t("docstudio.field.tags"),
      effectiveFrom: k("effective_from"),
      expires: t("docstudio.field.expires"),
      issuedAt: k("issued_at"),
      frozenNote: k("frozen_note"),
      save: k("save"),
      supersedes: k("supersedes"),
      supersededBy: k("superseded_by"),
      languages: {
        en: t("docstudio.language.en"),
        ar: t("docstudio.language.ar"),
        bilingual: t("docstudio.language.bilingual"),
      },
    },
    saved: t("docstudio.saved"),
    failed: t("docstudio.failed"),
    conflict: t("docstudio.conflict"),
    back: t("docstudio.back"),
  };

  return (
    <DocumentWorkspace
      orgId={orgId}
      locale={locale}
      detail={detail}
      caps={caps}
      folders={folders.map((f) => ({ id: f.id, name: f.name }))}
      initialTab={sp.tab ?? (caps.edit ? "edit" : "preview")}
      dict={dict}
      vocab={{
        blockTypes: BLOCK_TYPES,
        fieldKinds: FIELD_KINDS,
        bindingPaths: BINDING_PATHS,
        conditionOps: CONDITION_OPS,
        signatureParts: SIGNATURE_PARTS,
      }}
    />
  );
}
