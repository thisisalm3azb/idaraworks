"use client";

/**
 * H26 — the document workspace: one document, its builder, preview,
 * revisions, activity and details. Every mutation goes through a typed
 * server action and ends in `settle()`, which refreshes the server view so
 * every pane agrees. Refusals persist until the next action; successes fade.
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog } from "@/platform/ui";
import type { DocumentDetail } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import {
  archiveDocumentAction,
  createSuccessorAction,
  issueDocumentAction,
  reopenAction,
  returnToDraftAction,
  submitForReviewAction,
  terminateDocumentAction,
} from "../studio-actions";
import { Builder, type BuilderDict } from "./Builder";
import type { Vocabulary } from "./BlockEditor";
import { RevisionsPane, type RevisionsDict } from "./RevisionsPane";
import { ActivityPane, type ActivityDict } from "./ActivityPane";
import { DetailsPane, type DetailsDict } from "./DetailsPane";
import { PreviewPane } from "./PreviewPane";
import { WorkflowPane, type WorkflowDict } from "./WorkflowPane";
import { ReviewPane, type ReviewDict } from "./ReviewPane";
import { SignaturesPane, type SignaturesDict } from "./SignaturesPane";
import type { SignatureRequestRow } from "@/modules/docstudio/service";
import { PresenceStrip, usePlanPresence } from "../../studio/[planId]/PresenceLayer";
import type { CommentRow } from "@/modules/docstudio/service";
import type { RunRow } from "@/modules/docstudio/service";

export type WorkspaceDict = {
  status: Record<string, string>;
  category: Record<string, string>;
  blockTypes: Record<string, string>;
  bindings: Record<string, string>;
  counterparty: Record<string, string>;
  recordKinds: Record<string, string>;
  tabs: Record<
    | "edit"
    | "preview"
    | "review"
    | "workflow"
    | "signatures"
    | "revisions"
    | "activity"
    | "details",
    string
  >;
  actions: {
    submit: string;
    returnDraft: string;
    reopen: string;
    issue: string;
    terminate: string;
    archive: string;
    restore: string;
    supersede: string;
    preview: string;
    print: string;
    pdf: string;
    confirm: string;
    cancel: string;
    close: string;
    note: string;
    reason: string;
    issueTitle: string;
    issueBody: string;
    terminateTitle: string;
    terminateBody: string;
    returnTitle: string;
    supersedeTitle: string;
    supersedeBody: string;
    refresh: string;
    loading: string;
    loadFailed: string;
    openTab: string;
  };
  builder: BuilderDict;
  revisions: RevisionsDict;
  activity: ActivityDict;
  details: DetailsDict;
  workflow: WorkflowDict;
  review: ReviewDict;
  signatures: SignaturesDict;
  consentText: string;
  presence: string;
  saved: string;
  failed: string;
  conflict: string;
  back: string;
};

type Tab = keyof WorkspaceDict["tabs"];
type Notice = { tone: "ok" | "error"; text: string } | null;

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  review: "info",
  approval: "info",
  signature: "warning",
  active: "success",
  expired: "danger",
  terminated: "danger",
  superseded: "neutral",
  archived: "neutral",
};

export function DocumentWorkspace({
  orgId,
  locale,
  detail,
  caps,
  folders,
  initialTab,
  dict,
  vocab,
  run,
  members,
  viewer,
  comments,
  signatureRequest,
  parties,
}: {
  orgId: string;
  locale: string;
  detail: DocumentDetail;
  caps: Record<string, boolean>;
  folders: Array<{ id: string; name: string }>;
  initialTab: string;
  dict: WorkspaceDict;
  vocab: Vocabulary;
  run: RunRow | null;
  members: Array<{ id: string; name: string }>;
  viewer: { id: string; name: string; archetype: string; canReview: boolean; canComment: boolean };
  comments: CommentRow[];
  signatureRequest: SignatureRequestRow | null;
  parties: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const d = detail.document;
  const tabs: Tab[] = [
    "edit",
    "preview",
    "review",
    "workflow",
    "signatures",
    "revisions",
    "activity",
    "details",
  ];
  const [tab, setTab] = useState<Tab>(
    tabs.includes(initialTab as Tab) ? (initialTab as Tab) : "preview",
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [dialog, setDialog] = useState<null | "issue" | "terminate" | "return" | "supersede">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Who else is on this document (a private Realtime channel keyed by the
  // document id; the same org-membership predicate as the Studio, 0112).
  const presence = usePlanPresence({
    orgId,
    planId: d.id,
    viewer: { id: viewer.id, name: viewer.name },
    view: tab,
    selectedId: null,
  });

  useEffect(() => {
    if (!notice || notice.tone !== "ok") return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const settle = useCallback(
    (res: ActionResult<unknown>, okText = dict.saved, quiet = false): boolean => {
      if (res.ok) {
        if (!quiet) setNotice({ tone: "ok", text: okText });
        presence.changed();
        startTransition(() => router.refresh());
      } else {
        setNotice({
          tone: "error",
          text: res.code === "conflict" ? dict.conflict : `${dict.failed}: ${res.error}`,
        });
      }
      return res.ok;
    },
    [dict.saved, dict.failed, dict.conflict, router, presence],
  );

  const act = async (fn: () => Promise<ActionResult<unknown>>, okText?: string) => {
    setBusy(true);
    try {
      const res = await fn();
      settle(res, okText);
      return res;
    } finally {
      setBusy(false);
      setDialog(null);
      setText("");
    }
  };

  const base = `/api/o/${orgId}/documents/studio/${d.id}`;
  const previewSrc = `${base}?lang=${locale === "ar" ? "ar" : "en"}`;
  const tone = STATUS_TONE[d.effectiveStatus] ?? "neutral";
  const working = detail.working;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Link href={`/o/${orgId}/documents`} className="text-sm text-accent underline">
          {dict.back}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-ink-muted">
                <bdi dir="ltr">{d.reference}</bdi>
              </span>
              <Badge tone={tone}>{dict.status[d.effectiveStatus] ?? d.effectiveStatus}</Badge>
              <span className="text-xs text-ink-muted">
                {dict.category[d.category] ?? d.category}
              </span>
            </div>
            <h1 className="truncate text-lg font-semibold text-ink">{d.title}</h1>
            <PresenceStrip peers={presence.peers} label={dict.presence} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`${previewSrc}&print=1`}
              target="_blank"
              rel="noreferrer"
              className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-sunken"
            >
              {dict.actions.print}
            </a>
            <a
              href={`${base}?format=pdf`}
              className="min-h-11 rounded-md border border-line px-3 py-2 text-sm text-ink hover:bg-sunken"
            >
              {dict.actions.pdf}
            </a>
            {caps.submit ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => act(() => submitForReviewAction(orgId, { documentId: d.id }))}
              >
                {dict.actions.submit}
              </Button>
            ) : null}
            {caps.review && !d.issuedSnapshotId ? (
              <Button variant="secondary" disabled={busy} onClick={() => setDialog("return")}>
                {dict.actions.returnDraft}
              </Button>
            ) : null}
            {d.status === "review" && caps.edit === false && !d.issuedSnapshotId && caps.issue
              ? null
              : null}
            {d.status === "review" && !d.issuedSnapshotId && working === null && caps.review ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => act(() => reopenAction(orgId, { documentId: d.id }))}
              >
                {dict.actions.reopen}
              </Button>
            ) : null}
            {caps.issue ? (
              <Button disabled={busy} onClick={() => setDialog("issue")}>
                {dict.actions.issue}
              </Button>
            ) : null}
            {caps.supersede ? (
              <Button variant="secondary" disabled={busy} onClick={() => setDialog("supersede")}>
                {dict.actions.supersede}
              </Button>
            ) : null}
            {caps.terminate ? (
              <Button variant="danger" disabled={busy} onClick={() => setDialog("terminate")}>
                {dict.actions.terminate}
              </Button>
            ) : null}
            {caps.archive ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => act(() => archiveDocumentAction(orgId, { documentId: d.id }))}
              >
                {dict.actions.archive}
              </Button>
            ) : null}
            {caps.restore ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  act(() => archiveDocumentAction(orgId, { documentId: d.id, restore: true }))
                }
              >
                {dict.actions.restore}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`min-h-11 whitespace-nowrap border-b-2 px-3 text-sm ${
              tab === k
                ? "border-accent text-ink"
                : "border-transparent text-ink-secondary hover:text-ink"
            }`}
          >
            {dict.tabs[k]}
          </button>
        ))}
      </div>

      {tab === "edit" ? (
        working ? (
          <Builder
            key={working.id}
            orgId={orgId}
            documentId={d.id}
            language={d.language as "en" | "ar" | "bilingual"}
            revision={working}
            readOnly={!caps.edit}
            settle={settle}
            dict={dict.builder}
            blockTypes={dict.blockTypes}
            bindings={dict.bindings}
            vocab={vocab}
          />
        ) : (
          <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-secondary">
            {dict.builder.readOnly}
          </p>
        )
      ) : null}
      {tab === "preview" ? (
        <PreviewPane
          src={previewSrc}
          dict={{
            refresh: dict.actions.refresh,
            loading: dict.actions.loading,
            failed: dict.actions.loadFailed,
            openTab: dict.actions.openTab,
          }}
        />
      ) : null}
      {tab === "review" ? (
        <ReviewPane
          orgId={orgId}
          documentId={d.id}
          revisionId={working?.id ?? null}
          body={working?.body ?? detail.snapshot?.snapshot.body ?? null}
          comments={comments}
          members={members}
          currentUserId={viewer.id}
          canEdit={caps.edit === true}
          canComment={viewer.canComment}
          language={d.language as "en" | "ar" | "bilingual"}
          locale={locale}
          dict={dict.review}
          settle={settle}
        />
      ) : null}
      {tab === "workflow" ? (
        <WorkflowPane
          orgId={orgId}
          run={run}
          members={members}
          currentUserId={viewer.id}
          currentArchetype={viewer.archetype}
          canReview={viewer.canReview}
          locale={locale}
          dict={dict.workflow}
          settle={settle}
        />
      ) : null}
      {tab === "signatures" ? (
        <SignaturesPane
          orgId={orgId}
          documentId={d.id}
          status={d.effectiveStatus}
          parties={parties}
          request={signatureRequest}
          members={members}
          currentUserId={viewer.id}
          canRequest={caps.requestSignature === true}
          canSign={caps.sign === true}
          consentText={dict.consentText}
          locale={locale}
          dict={dict.signatures}
          settle={settle}
        />
      ) : null}
      {tab === "revisions" ? (
        <RevisionsPane
          orgId={orgId}
          documentId={d.id}
          detail={detail}
          dict={dict.revisions}
          locale={locale}
        />
      ) : null}
      {tab === "activity" ? (
        <ActivityPane detail={detail} dict={dict.activity} locale={locale} />
      ) : null}
      {tab === "details" ? (
        <DetailsPane
          orgId={orgId}
          detail={detail}
          folders={folders}
          canEdit={caps.edit || (!d.issuedSnapshotId && d.status !== "archived")}
          issued={d.issuedSnapshotId !== null}
          dict={dict.details}
          categories={dict.category}
          counterparty={dict.counterparty}
          recordKinds={dict.recordKinds}
          settle={settle}
        />
      ) : null}

      <Dialog
        open={dialog === "issue"}
        onClose={() => setDialog(null)}
        title={dict.actions.issueTitle}
        description={dict.actions.issueBody}
        closeLabel={dict.actions.close}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {dict.actions.cancel}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              act(() =>
                issueDocumentAction(orgId, {
                  documentId: d.id,
                  expectedRevisionId:
                    working?.id ?? detail.revisions[detail.revisions.length - 1]?.id,
                }),
              )
            }
          >
            {dict.actions.issue}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "terminate"}
        onClose={() => setDialog(null)}
        title={dict.actions.terminateTitle}
        description={dict.actions.terminateBody}
        tone="danger"
        closeLabel={dict.actions.close}
      >
        <label className="block text-xs text-ink-muted">
          {dict.actions.reason}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {dict.actions.cancel}
          </Button>
          <Button
            variant="danger"
            disabled={busy || text.trim().length === 0}
            onClick={() =>
              act(() => terminateDocumentAction(orgId, { documentId: d.id, reason: text.trim() }))
            }
          >
            {dict.actions.terminate}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "return"}
        onClose={() => setDialog(null)}
        title={dict.actions.returnTitle}
        closeLabel={dict.actions.close}
      >
        <label className="block text-xs text-ink-muted">
          {dict.actions.note}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-line-strong bg-card px-3 py-2 text-base text-ink"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {dict.actions.cancel}
          </Button>
          <Button
            disabled={busy || text.trim().length === 0}
            onClick={() =>
              act(() => returnToDraftAction(orgId, { documentId: d.id, note: text.trim() }))
            }
          >
            {dict.actions.returnDraft}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "supersede"}
        onClose={() => setDialog(null)}
        title={dict.actions.supersedeTitle}
        description={dict.actions.supersedeBody}
        closeLabel={dict.actions.close}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {dict.actions.cancel}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              const res = await act(() => createSuccessorAction(orgId, { documentId: d.id }));
              if (res.ok) router.push(`/o/${orgId}/documents/${(res.data as { id: string }).id}`);
            }}
          >
            {dict.actions.supersede}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
