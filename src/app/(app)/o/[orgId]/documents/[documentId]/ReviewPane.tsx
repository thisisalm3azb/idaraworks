"use client";

/**
 * H26 — review and redlining: comments anchored to blocks, threads, mentions,
 * suggested changes (accepted only by an explicit editor action), resolution.
 */
import { useMemo, useState } from "react";
import { Badge, Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { CommentRow, DocBody } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import {
  createDocCommentAction,
  decideSuggestionAction,
  removeDocCommentAction,
  resolveDocCommentAction,
} from "../studio-actions";

export type ReviewDict = {
  title: string;
  empty: string;
  anchor: string;
  anchorNone: string;
  comment: string;
  suggest: string;
  suggestionText: string;
  suggestionTextAr: string;
  mention: string;
  post: string;
  reply: string;
  resolve: string;
  reopen: string;
  remove: string;
  accept: string;
  reject: string;
  resolved: string;
  open: string;
  proposed: string;
  accepted: string;
  rejected: string;
  showResolved: string;
  onRevision: string;
};

export function ReviewPane({
  orgId,
  documentId,
  revisionId,
  body,
  comments,
  members,
  currentUserId,
  canEdit,
  canComment,
  language,
  locale,
  dict,
  settle,
}: {
  orgId: string;
  documentId: string;
  revisionId: string | null;
  body: DocBody | null;
  comments: CommentRow[];
  members: Array<{ id: string; name: string }>;
  currentUserId: string;
  canEdit: boolean;
  canComment: boolean;
  language: "en" | "ar" | "bilingual";
  locale: string;
  dict: ReviewDict;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
}) {
  const [blockId, setBlockId] = useState<string>("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"comment" | "suggest">("comment");
  const [sugEn, setSugEn] = useState("");
  const [sugAr, setSugAr] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const l = locale as "en" | "ar";
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  const blocks = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    const pick = (t?: { en?: string; ar?: string }) =>
      (l === "ar" ? (t?.ar ?? t?.en) : (t?.en ?? t?.ar)) ?? "";
    const label = (b: DocBody["blocks"][number]): string => {
      switch (b.type) {
        case "heading":
        case "paragraph":
        case "note":
          return pick(b.text);
        case "clause":
          return `${pick(b.title)} ${pick(b.text)}`;
        case "field":
          return pick(b.label) || b.key;
        case "section":
          return pick(b.title);
        case "signature":
          return pick(b.label);
        default:
          return b.type;
      }
    };
    for (const b of body?.blocks ?? []) {
      out.push({ id: b.id, label: `${b.type}: ${label(b).slice(0, 60)}` });
      if (b.type === "section")
        for (const c of b.blocks)
          out.push({ id: c.id, label: `  ${c.type}: ${label(c).slice(0, 60)}` });
    }
    return out;
  }, [body, l]);

  const threads = useMemo(() => {
    const roots = comments.filter((c) => !c.parentId);
    const byParent = new Map<string, CommentRow[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
    }
    return roots
      .filter((c) => showResolved || !c.resolvedAt)
      .map((c) => ({ root: c, replies: byParent.get(c.id) ?? [] }));
  }, [comments, showResolved]);

  const post = async () => {
    if (mode === "comment" && !text.trim()) return;
    setBusy(true);
    const res = await createDocCommentAction(orgId, {
      documentId,
      revisionId,
      blockId: blockId || null,
      parentId: replyTo,
      body: text.trim() || (mode === "suggest" ? dict.suggest : ""),
      mentions,
      ...(mode === "suggest" && blockId
        ? {
            suggestion: {
              blockId,
              text: {
                ...(sugEn.trim() ? { en: sugEn } : {}),
                ...(sugAr.trim() ? { ar: sugAr } : {}),
              },
            },
          }
        : {}),
    });
    setBusy(false);
    if (settle(res, undefined, true)) {
      setText("");
      setSugEn("");
      setSugAr("");
      setMentions([]);
      setReplyTo(null);
    }
  };

  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  const blockLabel = (id: string | null) =>
    id ? (blocks.find((b) => b.id === id)?.label ?? id) : dict.anchorNone;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{dict.title}</h2>
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
            />
            {dict.showResolved}
          </label>
        </div>
        {threads.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong bg-card p-4 text-sm text-ink-muted">
            {dict.empty}
          </p>
        ) : null}
        {threads.map(({ root, replies }) => (
          <article
            key={root.id}
            className={`rounded-lg border p-3 ${root.resolvedAt ? "border-line bg-sunken" : "border-line bg-card shadow-card"}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="font-medium text-ink">
                {root.authorName || name(root.authorUserId)}
              </span>
              <span>{formatDateTime(root.createdAt, { locale: l })}</span>
              {root.blockId ? (
                <span className="truncate rounded bg-sunken px-1.5 py-0.5">
                  {blockLabel(root.blockId)}
                </span>
              ) : null}
              {root.suggestion ? (
                <Badge
                  tone={
                    root.suggestionStatus === "accepted"
                      ? "success"
                      : root.suggestionStatus === "rejected"
                        ? "danger"
                        : "warning"
                  }
                >
                  {root.suggestionStatus === "accepted"
                    ? dict.accepted
                    : root.suggestionStatus === "rejected"
                      ? dict.rejected
                      : dict.proposed}
                </Badge>
              ) : null}
              {root.resolvedAt ? <Badge tone="neutral">{dict.resolved}</Badge> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{root.body}</p>
            {root.suggestion ? (
              <div className="mt-2 rounded-md border border-warning-soft bg-warning-soft p-2 text-sm">
                {root.suggestion.text.en ? (
                  <p lang="en" dir="ltr">
                    {root.suggestion.text.en}
                  </p>
                ) : null}
                {root.suggestion.text.ar ? (
                  <p lang="ar" dir="rtl">
                    {root.suggestion.text.ar}
                  </p>
                ) : null}
                {root.suggestionStatus === "proposed" && canEdit ? (
                  <div className="mt-2 flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        settle(
                          await decideSuggestionAction(orgId, {
                            commentId: root.id,
                            decision: "accepted",
                          }),
                        );
                        setBusy(false);
                      }}
                    >
                      {dict.accept}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        settle(
                          await decideSuggestionAction(orgId, {
                            commentId: root.id,
                            decision: "rejected",
                          }),
                        );
                        setBusy(false);
                      }}
                    >
                      {dict.reject}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {replies.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 border-s-2 border-line ps-3">
                {replies.map((r) => (
                  <li key={r.id} className="text-sm">
                    <span className="text-xs text-ink-muted">
                      {r.authorName || name(r.authorUserId)} ·{" "}
                      {formatDateTime(r.createdAt, { locale: l })}
                    </span>
                    <p className="whitespace-pre-wrap text-ink">{r.body}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {canComment ? (
                <Button
                  variant="ghost"
                  onClick={() => setReplyTo(replyTo === root.id ? null : root.id)}
                >
                  {dict.reply}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  settle(
                    await resolveDocCommentAction(orgId, {
                      commentId: root.id,
                      resolved: !root.resolvedAt,
                    }),
                    undefined,
                    true,
                  );
                  setBusy(false);
                }}
              >
                {root.resolvedAt ? dict.reopen : dict.resolve}
              </Button>
              {root.authorUserId === currentUserId ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    settle(
                      await removeDocCommentAction(orgId, { commentId: root.id }),
                      undefined,
                      true,
                    );
                    setBusy(false);
                  }}
                >
                  {dict.remove}
                </Button>
              ) : null}
            </div>
          </article>
        ))}
      </section>

      {canComment ? (
        <aside className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3 shadow-card">
          <div className="flex gap-1">
            {(["comment", "suggest"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`min-h-9 rounded-md px-3 text-xs ${mode === m ? "bg-accent-soft text-ink" : "bg-sunken text-ink-secondary"}`}
              >
                {m === "comment" ? dict.comment : dict.suggest}
              </button>
            ))}
          </div>
          {replyTo ? (
            <p className="text-xs text-ink-muted">
              {dict.reply}: {comments.find((c) => c.id === replyTo)?.body.slice(0, 60)}
            </p>
          ) : null}
          <label className="text-xs text-ink-muted">
            {dict.anchor}
            <select value={blockId} onChange={(e) => setBlockId(e.target.value)} className={input}>
              <option value="">{dict.anchorNone}</option>
              {blocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.comment}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className={`${input} py-2`}
            />
          </label>
          {mode === "suggest" ? (
            <>
              {language !== "ar" ? (
                <label className="text-xs text-ink-muted">
                  {dict.suggestionText}
                  <textarea
                    value={sugEn}
                    onChange={(e) => setSugEn(e.target.value)}
                    rows={3}
                    dir="ltr"
                    className={`${input} py-2`}
                  />
                </label>
              ) : null}
              {language !== "en" ? (
                <label className="text-xs text-ink-muted">
                  {dict.suggestionTextAr}
                  <textarea
                    value={sugAr}
                    onChange={(e) => setSugAr(e.target.value)}
                    rows={3}
                    dir="rtl"
                    className={`${input} py-2`}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <label className="text-xs text-ink-muted">
            {dict.mention}
            <select
              multiple
              value={mentions}
              onChange={(e) =>
                setMentions(Array.from(e.target.selectedOptions).map((o) => o.value))
              }
              className={`${input} h-24`}
            >
              {members
                .filter((m) => m.id !== currentUserId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            disabled={
              busy ||
              (mode === "comment" ? !text.trim() : !blockId || (!sugEn.trim() && !sugAr.trim()))
            }
            onClick={post}
          >
            {dict.post}
          </Button>
          {revisionId ? <p className="text-[11px] text-ink-muted">{dict.onRevision}</p> : null}
        </aside>
      ) : null}
    </div>
  );
}
