"use client";

/**
 * H28 — the working window (ADR-58): a movable, resizable non-modal dialog on
 * desktop and a bottom sheet on phones, holding the context capsule, the
 * transcript (`role="log"`), the visible execution trace, proposed actions
 * and the composer with an agent switcher. It polls the run while it works
 * so navigation never blocks, and it announces state through one polite
 * status region. In `workspace` mode it fills the page (the deep workspace).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentId } from "@/platform/agents/registry";
import type { ActionStatus, RecordRef } from "@/modules/idara/service";
import type { ConversationRow, MessageRow, RunRow, StepRow } from "@/modules/idara/service";
import {
  idaraCancelAction,
  idaraCancelProposedAction,
  idaraConfirmAction,
  idaraContextLabelAction,
  idaraConversationsAction,
  idaraExecuteApprovedAction,
  idaraSearchAction,
  idaraSendAction,
  idaraStartAction,
  idaraViewAction,
  type SearchHit,
} from "./actions";
import { Blocks, RecordChip } from "./IdaraBlocks";
import type { AgentOption, DockDict, DockPosition, DockStatus, OpenRequest } from "./IdaraDock";

type Size = "s" | "m" | "l";
const SIZE_CLASS: Record<Size, string> = {
  s: "md:w-[380px] md:h-[520px]",
  m: "md:w-[520px] md:h-[640px]",
  l: "md:w-[720px] md:h-[760px]",
};

export function IdaraWindow({
  orgId,
  userId,
  locale,
  dir,
  dict,
  agents,
  modelAvailable,
  reason,
  ownerAction,
  canConfirm,
  pageContext,
  openRequest,
  position,
  onStatus,
  onUnread,
  onMinimise,
  onClose,
  mode = "window",
  initialConversationId = null,
}: {
  orgId: string;
  userId: string;
  locale: "en" | "ar";
  dir: "ltr" | "rtl";
  dict: DockDict;
  agents: AgentOption[];
  modelAvailable: boolean;
  reason: string;
  ownerAction: string | null;
  canConfirm: boolean;
  pageContext: RecordRef | null;
  openRequest: OpenRequest | null;
  position: DockPosition;
  onStatus: (s: DockStatus) => void;
  onUnread: (n: number) => void;
  onMinimise: () => void;
  onClose: () => void;
  mode?: "window" | "workspace";
  initialConversationId?: string | null;
}) {
  void userId;
  void onUnread;
  void locale;
  const [conversation, setConversation] = useState<ConversationRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [run, setRun] = useState<RunRow | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const [input, setInput] = useState(openRequest?.intent ?? "");
  const [agentId, setAgentId] = useState<AgentId>(openRequest?.agentId ?? "idara");
  const [contextRefs, setContextRefs] = useState<RecordRef[]>(openRequest?.contextRefs ?? []);
  const [includePage, setIncludePage] = useState<boolean>(
    Boolean(pageContext) && !openRequest?.contextRefs?.length,
  );
  const [pageRef, setPageRef] = useState<RecordRef | null>(pageContext);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<Size>("m");
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [showList] = useState(mode === "workspace");
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false,
    [],
  );

  // Label the page's record for the capsule.
  useEffect(() => {
    if (!pageContext) return;
    let alive = true;
    idaraContextLabelAction(orgId, pageContext).then((r) => {
      if (alive && r.ok) setPageRef(r.ref);
    });
    return () => {
      alive = false;
    };
  }, [orgId, pageContext]);

  const effectiveRefs = useMemo(() => {
    const list = [...contextRefs];
    if (includePage && pageRef && !list.some((r) => r.type === pageRef.type && r.id === pageRef.id))
      list.unshift(pageRef);
    return list.slice(0, 12);
  }, [contextRefs, includePage, pageRef]);

  const refreshList = useCallback(async () => {
    const r = await idaraConversationsAction(orgId, { limit: 30, offset: 0 });
    if (r.ok) setConversations(r.rows);
  }, [orgId]);

  const load = useCallback(
    async (conversationId: string) => {
      const r = await idaraViewAction(orgId, conversationId);
      if (!r.ok) {
        setError(r.code);
        return;
      }
      setConversation(r.conversation);
      setMessages(r.messages);
      setRun(r.run);
      setSteps(r.steps);
      setAgentId(r.conversation.agentId);
      setContextRefs(r.conversation.contextRefs);
      setIncludePage(false);
    },
    [orgId],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if (initialConversationId) void load(initialConversationId);
      if (mode === "workspace") void refreshList();
    }, 0);
    return () => clearTimeout(t);
  }, [initialConversationId, load, mode, refreshList]);

  // Poll while a run is active (bounded, stops when it finishes).
  useEffect(() => {
    if (!run || !conversation) return;
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      queueMicrotask(() =>
        onStatus(run.status === "completed" ? "done" : run.status === "failed" ? "failed" : "idle"),
      );
      return;
    }
    queueMicrotask(() => onStatus(run.status === "waiting_approval" ? "waiting" : "thinking"));
    const id = setInterval(async () => {
      const r = await idaraViewAction(orgId, conversation.id);
      if (r.ok) {
        setMessages(r.messages);
        setRun(r.run);
        setSteps(r.steps);
      }
    }, 1200);
    return () => clearInterval(id);
  }, [run, conversation, orgId, onStatus]);

  useEffect(() => {
    logRef.current?.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [messages.length, reduceMotion]);

  // Initial focus and Escape (WCAG 2.1.2: a documented exit, never a trap).
  useEffect(() => {
    composerRef.current?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode === "window") onMinimise();
    }
    if (
      e.altKey &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) &&
      mode === "window"
    ) {
      e.preventDefault();
      const d = 24;
      setOffset((o) => ({
        x: o.x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0),
        y: o.y + (e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0),
      }));
    }
  };

  // Title-bar drag (pointer) with keyboard alternative above.
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const onTitlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "window" || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onTitlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const onTitlePointerUp = () => {
    drag.current = null;
  };

  const ensureConversation = async (): Promise<ConversationRow | null> => {
    if (conversation) return conversation;
    const r = await idaraStartAction(orgId, {
      kind: mode === "workspace" ? "session" : "quick",
      agentId,
      contextRefs: effectiveRefs,
    });
    if (!r.ok) {
      setError(r.code);
      return null;
    }
    setConversation(r.conversation);
    return r.conversation;
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    onStatus("thinking");
    try {
      const conv = await ensureConversation();
      if (!conv) return;
      setMessages((m) => [
        ...m,
        {
          id: `local-${Date.now()}`,
          seq: m.length + 1,
          role: "user",
          agentId: null,
          blocks: [{ kind: "text", text }],
          evidence: effectiveRefs,
          runId: null,
          provenance: {},
          createdAt: new Date().toISOString(),
        },
      ]);
      setInput("");
      const r = await idaraSendAction(orgId, {
        conversationId: conv.id,
        input: text,
        agentId,
        contextRefs: effectiveRefs,
      });
      if (!r.ok) {
        setError(r.code);
        onStatus("failed");
        return;
      }
      await load(conv.id);
      const v = await idaraViewAction(orgId, conv.id);
      if (v.ok) {
        setRun(v.run);
        onStatus(
          v.run?.status === "completed"
            ? "done"
            : v.run?.status === "failed"
              ? "failed"
              : "thinking",
        );
      }
      if (mode === "workspace") void refreshList();
    } finally {
      setBusy(false);
      composerRef.current?.focus();
    }
  };

  const stop = async () => {
    if (!run) return;
    await idaraCancelAction(orgId, run.id);
    if (conversation) await load(conversation.id);
  };

  const onConfirm = async (actionId: string) => {
    setBusyAction(actionId);
    const r = await idaraConfirmAction(orgId, actionId);
    setBusyAction(null);
    if (r.ok) setActionStatus((s) => ({ ...s, [actionId]: r.action.status }));
    else setError(r.message ?? r.code);
  };
  const onExecute = async (actionId: string) => {
    setBusyAction(actionId);
    const r = await idaraExecuteApprovedAction(orgId, actionId);
    setBusyAction(null);
    if (r.ok) setActionStatus((s) => ({ ...s, [actionId]: r.action.status }));
    else setError(r.message ?? r.code);
  };
  const onCancelAction = async (actionId: string) => {
    const r = await idaraCancelProposedAction(orgId, actionId);
    if (r.ok) setActionStatus((s) => ({ ...s, [actionId]: "cancelled" }));
  };

  useEffect(() => {
    if (search.trim().length < 2) return;
    const h = setTimeout(async () => {
      const r = await idaraSearchAction(orgId, search);
      if (r.ok) setHits(r.hits);
    }, 250);
    return () => clearTimeout(h);
  }, [search, orgId]);
  const visibleHits = search.trim().length >= 2 ? hits : [];

  const agentName = (id: AgentId | null | undefined) =>
    agents.find((a) => a.id === id)?.name ?? id ?? "";

  const frame =
    mode === "workspace"
      ? "relative flex h-[calc(100dvh-8rem)] w-full flex-col rounded-xl border border-line bg-card"
      : `fixed z-40 flex flex-col border border-line bg-card shadow-pop inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl md:inset-auto md:rounded-xl md:resize md:overflow-hidden ${SIZE_CLASS[size]} ${position.startsWith("top") ? "md:top-20" : "md:bottom-6"} ${position.endsWith("start") ? "md:start-3" : "md:end-3"}`;

  return (
    <div
      id="idara-window"
      role="dialog"
      aria-label={dict.launcher}
      data-idara-window
      onKeyDown={onKeyDown}
      className={frame}
      style={
        mode === "window" && (offset.x || offset.y)
          ? { transform: `translate(${dir === "rtl" ? -offset.x : offset.x}px, ${offset.y}px)` }
          : undefined
      }
    >
      <div
        ref={titleRef}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        className={`flex items-center gap-2 border-b border-line px-3 py-2 ${mode === "window" ? "touch-none md:cursor-move" : ""}`}
      >
        <span className="mx-auto h-1 w-10 rounded-full bg-line md:hidden" aria-hidden="true" />
        <div className="hidden min-w-0 flex-1 md:block">
          <p className="truncate text-sm font-semibold text-ink">
            {conversation?.title ?? dict.launcher}
          </p>
          <p className="truncate text-xs text-ink-muted">
            {run
              ? run.status === "completed"
                ? dict.done
                : run.status === "failed"
                  ? dict.failed
                  : run.status === "waiting_approval"
                    ? dict.waiting
                    : run.status === "running" || run.status === "queued"
                      ? dict.thinking
                      : dict.idle
              : dict.idle}
            {run?.credits ? ` · ${run.credits} ${dict.credits}` : ""}
          </p>
        </div>
        {mode === "window" ? (
          <div className="ms-auto flex items-center gap-1">
            <div
              className="hidden items-center gap-0.5 md:flex"
              role="group"
              aria-label={dict.position}
            >
              {(["s", "m", "l"] as Size[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={size === s}
                  onClick={() => setSize(s)}
                  className={`min-h-7 rounded px-1.5 text-xs ${size === s ? "bg-sunken text-ink" : "text-ink-muted"}`}
                >
                  {s === "s" ? dict.sizeSmall : s === "m" ? dict.sizeMedium : dict.sizeLarge}
                </button>
              ))}
            </div>
            <Link
              href={`/o/${orgId}/idara${conversation ? `?c=${conversation.id}` : ""}`}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
              aria-label={dict.workspace}
              prefetch={false}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M4 12v4h4M16 8V4h-4M4 4l6 6M16 16l-6-6" />
              </svg>
            </Link>
            <button
              type="button"
              onClick={onMinimise}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
              aria-label={dict.minimise}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M5 10h10" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
              aria-label={dict.close}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {mode === "workspace" && showList ? (
          <aside
            className="hidden w-64 shrink-0 flex-col border-e border-line md:flex"
            aria-label={dict.conversations}
          >
            <button
              type="button"
              onClick={() => {
                setConversation(null);
                setMessages([]);
                setRun(null);
                setSteps([]);
                setContextRefs([]);
                composerRef.current?.focus();
              }}
              className="m-2 min-h-9 rounded-md border border-line px-3 text-sm text-ink hover:bg-sunken"
            >
              {dict.newConversation}
            </button>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void load(c.id)}
                    aria-current={conversation?.id === c.id ? "true" : undefined}
                    className={`w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-sunken ${conversation?.id === c.id ? "bg-sunken font-medium text-ink" : "text-ink-secondary"}`}
                  >
                    <span className="block truncate">{c.title}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {agentName(c.agentId)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Context capsule */}
          <div className="border-b border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {dict.contextTitle}
              </span>
              {pageRef ? (
                <label className="ms-1 flex items-center gap-1 text-xs text-ink">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={includePage}
                    onChange={(e) => setIncludePage(e.target.checked)}
                  />
                  {dict.includePage}
                </label>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {effectiveRefs.map((r) => (
                <span key={`${r.type}:${r.id}`} className="inline-flex items-center gap-1">
                  <RecordChip orgId={orgId} r={r} />
                  <button
                    type="button"
                    aria-label={`${dict.remove}: ${r.label ?? r.type}`}
                    onClick={() => {
                      if (pageRef && r.type === pageRef.type && r.id === pageRef.id)
                        setIncludePage(false);
                      setContextRefs((list) =>
                        list.filter((x) => !(x.type === r.type && x.id === r.id)),
                      );
                    }}
                    className="flex min-h-6 min-w-6 items-center justify-center rounded text-ink-muted hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="relative">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={dict.addRecord}
                  aria-label={dict.addRecord}
                  className="min-h-7 w-40 rounded-md border border-line bg-card px-2 text-xs text-ink"
                />
                {visibleHits.length > 0 ||
                (search.trim().length >= 2 && visibleHits.length === 0) ? (
                  <ul
                    role="listbox"
                    className="absolute z-10 mt-1 max-h-48 w-64 overflow-y-auto rounded-md border border-line bg-card p-1 text-sm shadow-pop"
                  >
                    {hits.length === 0 ? (
                      <li className="px-2 py-1 text-xs text-ink-muted">{dict.nothingFound}</li>
                    ) : null}
                    {visibleHits.map((h) => (
                      <li key={`${h.type}:${h.id}`} role="option" aria-selected="false">
                        <button
                          type="button"
                          onClick={() => {
                            setContextRefs((list) =>
                              (list.some((x) => x.id === h.id)
                                ? list
                                : [...list, { type: h.type, id: h.id, label: h.label }]
                              ).slice(0, 12),
                            );
                            setSearch("");
                            setHits([]);
                          }}
                          className="flex w-full flex-col rounded px-2 py-1 text-start hover:bg-sunken"
                        >
                          <span className="truncate text-ink">{h.label ?? h.id}</span>
                          <span className="truncate text-xs text-ink-muted">
                            {h.type}
                            {h.hint ? ` · ${h.hint}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>

          {!modelAvailable ? (
            <div className="border-b border-line bg-info-soft px-3 py-2 text-xs text-ink">
              <p>{reason === "allowance_exhausted" ? dict.unavailable : dict.evidenceOnly}</p>
              {ownerAction ? (
                <p className="mt-1 text-ink-secondary" dir="ltr">
                  {dict.ownerAction}: {ownerAction}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Transcript */}
          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
          >
            {messages.length === 0 ? (
              <p className="text-sm text-ink-muted">{dict.quickAsk}</p>
            ) : null}
            <ol className="space-y-3">
              {messages.map((m) => (
                <li key={m.id} className={m.role === "user" ? "ms-8" : "me-4"}>
                  <div
                    className={`rounded-xl px-3 py-2 ${m.role === "user" ? "bg-brand-soft" : "bg-sunken"}`}
                  >
                    {m.role === "assistant" ? (
                      <p className="mb-1 text-xs text-ink-muted">
                        {dict.answeredBy} {agentName(m.provenance.answeredBy ?? m.agentId)}
                        {m.provenance.contributors && m.provenance.contributors.length
                          ? ` · ${dict.contributors}: ${m.provenance.contributors.map((c) => agentName(c)).join(", ")}`
                          : ""}
                        {m.provenance.generated === false ? ` · ${dict.notGenerated}` : ""}
                        {m.provenance.model ? ` · ${m.provenance.model}` : ""}
                      </p>
                    ) : null}
                    <Blocks
                      orgId={orgId}
                      blocks={m.blocks}
                      dict={dict}
                      canConfirm={canConfirm}
                      busyAction={busyAction}
                      onConfirm={onConfirm}
                      onExecute={onExecute}
                      onCancelAction={onCancelAction}
                      actionStatus={actionStatus}
                    />
                  </div>
                </li>
              ))}
            </ol>
            {run && (run.status === "running" || run.status === "queued") ? (
              <p className="mt-3 text-xs text-ink-muted" aria-hidden="true">
                {dict.thinking}…
              </p>
            ) : null}
            {steps.length > 0 ? (
              <div className="mt-3">
                <button
                  type="button"
                  aria-expanded={showSteps}
                  onClick={() => setShowSteps((v) => !v)}
                  className="text-xs text-ink-muted underline"
                >
                  {dict.steps} ({steps.length})
                </button>
                {showSteps ? (
                  <ol className="mt-1 space-y-0.5 border-s border-line ps-3 text-xs text-ink-secondary">
                    {steps.map((s) => (
                      <li key={s.id}>
                        <span className="me-1 rounded bg-sunken px-1 text-[10px] uppercase">
                          {s.kind}
                        </span>
                        {s.status !== "completed" ? (
                          <span className="me-1 text-warning">{s.status}</span>
                        ) : null}
                        {s.summary ?? s.toolId ?? ""}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              className="border-t border-danger bg-danger-soft px-3 py-1 text-xs text-ink"
            >
              {error}
            </p>
          ) : null}

          {/* Composer */}
          <form
            className="border-t border-line p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="flex items-end gap-2">
              <label className="sr-only" htmlFor="idara-agent">
                {dict.agent}
              </label>
              <select
                id="idara-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value as AgentId)}
                className="min-h-10 max-w-[10rem] rounded-md border border-line bg-card px-2 text-xs text-ink"
                aria-label={dict.agent}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={dict.placeholder}
                aria-label={dict.placeholder}
                className="min-h-10 flex-1 resize-none rounded-md border border-line bg-card px-3 py-2 text-sm text-ink"
              />
              {run && (run.status === "running" || run.status === "queued") ? (
                <button
                  type="button"
                  onClick={() => void stop()}
                  className="min-h-10 rounded-md border border-line px-3 text-sm text-ink"
                >
                  {dict.stop}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  className="min-h-10 rounded-md bg-brand px-3 text-sm font-medium text-ink-inverse disabled:opacity-60"
                >
                  {dict.send}
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">{dict.shortcutHint}</p>
          </form>
        </div>
      </div>
    </div>
  );
}
