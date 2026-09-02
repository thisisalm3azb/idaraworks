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
  getRunForDocument,
  getSignatureRequest,
  listDocComments,
  listFolders,
  listFormLinks,
  listSubmissions,
  signatureParties,
  CONSENT_TEXT,
} from "@/modules/docstudio/service";
import { getDisplayName, listMembers } from "@/platform/auth/identity";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
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
  const viewerName = await getDisplayName(resolved.ctx);
  const isForm = detail.document.category === "form";
  const [folders, run, members, comments, signatureRequest, formLinks, submissions] =
    await Promise.all([
      listFolders(resolved.ctx, resolved.archetype),
      getRunForDocument(resolved.ctx, resolved.archetype, documentId),
      listMembers(resolved.ctx, resolved.archetype).catch(() => []),
      listDocComments(resolved.ctx, resolved.archetype, documentId),
      getSignatureRequest(resolved.ctx, resolved.archetype, documentId),
      isForm ? listFormLinks(resolved.ctx, resolved.archetype, documentId) : Promise.resolve([]),
      isForm
        ? listSubmissions(resolved.ctx, resolved.archetype, { documentId })
        : Promise.resolve([]),
    ]);
  const parties = signatureParties(
    detail.snapshot?.snapshot.body ?? detail.working?.body ?? { blocks: [] },
  );
  const caps = documentCapabilities(resolved.archetype, detail.document);
  // A running workflow owns the decision; issue opens only once the run completed.
  if (detail.document.status === "approval" && run?.status !== "completed") caps.issue = false;
  if (detail.document.status === "review" && run?.status === "running") caps.issue = false;
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
      review: k("tab_review"),
      workflow: k("tab_workflow"),
      signatures: k("tab_signatures"),
      forms: k("tab_forms"),
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
    workflow: {
      title: t("docstudio.wfp.title"),
      none: t("docstudio.wfp.none"),
      noneHint: t("docstudio.wfp.none_hint"),
      run: Object.fromEntries(
        ["running", "completed", "rejected", "cancelled"].map((x) => [
          x,
          t(`docstudio.wfp.run.${x}`),
        ]),
      ),
      step: Object.fromEntries(
        ["pending", "active", "completed", "rejected", "skipped", "cancelled"].map((x) => [
          x,
          t(`docstudio.wfp.step.${x}`),
        ]),
      ),
      kinds: {
        review: t("docstudio.wf.kind.review"),
        approval: t("docstudio.wf.kind.approval"),
        signature: t("docstudio.wf.kind.signature"),
      },
      started: t("docstudio.wfp.started"),
      finished: t("docstudio.wfp.finished"),
      outcome: t("docstudio.wfp.outcome"),
      assignee: t("docstudio.wfp.assignee"),
      due: t("docstudio.wfp.due"),
      overdue: t("docstudio.wfp.overdue"),
      decidedBy: t("docstudio.wfp.decided_by"),
      approve: t("docstudio.wfp.approve"),
      reject: t("docstudio.wfp.reject"),
      note: t("docstudio.wfp.note"),
      delegate: t("docstudio.wfp.delegate"),
      delegateTo: t("docstudio.wfp.delegate_to"),
      inInbox: t("docstudio.wfp.in_inbox"),
      openInbox: t("docstudio.wfp.open_inbox"),
      archetypeNames: Object.fromEntries(
        MVP_GRANTABLE_ARCHETYPES.map((a) => [a, t(`docstudio.role.${a}`)]),
      ),
    },
    review: {
      title: t("docstudio.rv.title"),
      empty: t("docstudio.rv.empty"),
      anchor: t("docstudio.rv.anchor"),
      anchorNone: t("docstudio.rv.anchor_none"),
      comment: t("docstudio.rv.comment"),
      suggest: t("docstudio.rv.suggest"),
      suggestionText: t("docstudio.rv.suggestion_text"),
      suggestionTextAr: t("docstudio.rv.suggestion_text_ar"),
      mention: t("docstudio.rv.mention"),
      post: t("docstudio.rv.post"),
      reply: t("docstudio.rv.reply"),
      resolve: t("docstudio.rv.resolve"),
      reopen: t("docstudio.rv.reopen"),
      remove: t("docstudio.ws.remove"),
      accept: t("docstudio.rv.accept"),
      reject: t("docstudio.rv.reject"),
      resolved: t("docstudio.rv.resolved"),
      open: t("docstudio.rv.open"),
      proposed: t("docstudio.rv.proposed"),
      accepted: t("docstudio.rv.accepted"),
      rejected: t("docstudio.rv.rejected"),
      showResolved: t("docstudio.rv.show_resolved"),
      onRevision: t("docstudio.rv.on_revision"),
    },
    signatures: {
      title: t("docstudio.sg.title"),
      notIssued: t("docstudio.sg.not_issued"),
      noRoom: t("docstudio.sg.no_room"),
      parties: t("docstudio.sg.parties"),
      signerKind: t("docstudio.sg.signer_kind"),
      member: t("docstudio.sg.member"),
      external: t("docstudio.sg.external"),
      person: t("docstudio.sg.person"),
      name: t("docstudio.sg.name"),
      email: t("docstudio.sg.email"),
      signerTitle: t("docstudio.sg.signer_title"),
      mode: t("docstudio.sg.mode"),
      parallel: t("docstudio.sg.parallel"),
      sequential: t("docstudio.sg.sequential"),
      expiresInDays: t("docstudio.sg.expires_in_days"),
      message: t("docstudio.sg.message"),
      open: t("docstudio.sg.open"),
      linksTitle: t("docstudio.sg.links_title"),
      linksHint: t("docstudio.sg.links_hint"),
      copy: t("docstudio.sg.copy"),
      status: Object.fromEntries(
        ["pending", "invited", "viewed", "signed", "declined", "revoked", "expired"].map((x) => [
          x,
          t(`docstudio.sg.status.${x}`),
        ]),
      ),
      requestStatus: Object.fromEntries(
        ["pending", "in_progress", "completed", "declined", "cancelled", "expired"].map((x) => [
          x,
          t(`docstudio.sg.request.${x}`),
        ]),
      ),
      delivery: {
        email: t("docstudio.sg.delivery.email"),
        link: t("docstudio.sg.delivery.link"),
        in_app: t("docstudio.sg.delivery.in_app"),
      },
      invitedAt: t("docstudio.sg.invited_at"),
      signedAt: t("docstudio.sg.signed_at"),
      viewedAt: t("docstudio.sg.viewed_at"),
      revoke: t("docstudio.sg.revoke"),
      reinvite: t("docstudio.sg.reinvite"),
      cancel: t("docstudio.sg.cancel"),
      cancelReason: t("docstudio.sg.cancel_reason"),
      signHere: t("docstudio.sg.sign_here"),
      yourName: t("docstudio.sg.your_name"),
      yourTitle: t("docstudio.sg.your_title"),
      typed: t("docstudio.sg.typed"),
      consent: t("docstudio.sg.consent"),
      sign: t("docstudio.sg.sign"),
      evidence: t("docstudio.sg.evidence"),
      provider: t("docstudio.sg.provider"),
      disclaimer: t("docstudio.evidence.disclaimer"),
      expires: t("docstudio.sg.expires"),
    },
    forms: {
      title: t("docstudio.fp.title"),
      notForm: t("docstudio.fp.not_form"),
      notActive: t("docstudio.fp.not_active"),
      links: t("docstudio.fp.links"),
      newLink: t("docstudio.fp.new_link"),
      label: t("docstudio.fp.label"),
      expiresInDays: t("docstudio.fp.expires_in_days"),
      maxUses: t("docstudio.fp.max_uses"),
      unlimited: t("docstudio.fp.unlimited"),
      create: t("docstudio.fp.create"),
      linkOnce: t("docstudio.fp.link_once"),
      copy: t("docstudio.sg.copy"),
      uses: t("docstudio.fp.uses"),
      expires: t("docstudio.sg.expires"),
      revoked: t("docstudio.sg.status.revoked"),
      revoke: t("docstudio.sg.revoke"),
      submissions: t("docstudio.fm.submissions"),
      noSubmissions: t("docstudio.fm.no_submissions"),
      inbox: t("docstudio.fp.inbox"),
      status: Object.fromEntries(
        ["received", "reviewed", "converted", "discarded"].map((s) => [
          s,
          t(`docstudio.fm.status.${s}`),
        ]),
      ),
    },
    consentText: CONSENT_TEXT[locale === "ar" ? "ar" : "en"],
    presence: t("docstudio.ws.presence"),
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
      run={run}
      members={members.map((m) => ({ id: m.userId, name: m.fullName }))}
      viewer={{
        id: resolved.ctx.userId,
        name: viewerName,
        archetype: resolved.archetype,
        canReview: can(resolved.archetype, "documents.review"),
        canComment: can(resolved.archetype, "comments.create"),
      }}
      comments={comments}
      signatureRequest={signatureRequest}
      parties={parties}
      formLinks={formLinks}
      submissions={submissions}
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
