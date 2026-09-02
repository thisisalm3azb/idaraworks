"use client";

/**
 * H25E — the board projection: the same nodes in normalized status columns.
 * Dropping a card commits through the ONE status path (a linked task's real
 * lifecycle, with its transition rules; a draft's own status). "Awaiting
 * approval" is set by the approval flow and is never a drop target. Touch and
 * keyboard users get the same move through a select on each card.
 */
import { useState } from "react";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

const COLUMNS = ["planned", "ready", "active", "blocked", "waiting", "done", "dropped"] as const;
const DROPPABLE = new Set(["planned", "ready", "active", "blocked", "done", "dropped"]);

export function BoardView({
  payload,
  dict,
  actions,
  criticalIds,
  selectedId,
  onSelect,
  settle,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [blockPrompt, setBlockPrompt] = useState<{ nodeId: string; reason: string } | null>(null);
  const cards = payload.nodes.filter(
    (n) => !["frame", "group", "swimlane", "note"].includes(n.nodeType),
  );

  async function move(nodeId: string, statusCategory: string, reason?: string) {
    if (!payload.canManage || !DROPPABLE.has(statusCategory)) return;
    if (statusCategory === "blocked" && !reason) {
      setBlockPrompt({ nodeId, reason: "" });
      return;
    }
    const node = payload.nodes.find((n) => n.id === nodeId);
    const res = await actions.setNodeStatus({
      nodeId,
      statusCategory,
      ...(reason ? { reason } : {}),
      ...(node ? { expectedRowVersion: node.rowVersion } : {}),
      ...(payload.scenarioId ? { scenarioId: payload.scenarioId } : {}),
    });
    settle(res);
    setBlockPrompt(null);
  }

  return (
    <div className="flex h-full gap-2 overflow-x-auto p-2">
      {COLUMNS.map((col) => {
        const items = cards.filter((n) => n.statusCategory === col);
        return (
          <section
            key={col}
            aria-label={dict.statuses[col]}
            onDragOver={(e) => {
              if (DROPPABLE.has(col) && dragging) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) void move(dragging, col);
              setDragging(null);
            }}
            className={`flex w-60 shrink-0 flex-col rounded-lg border bg-sunken/60 ${
              DROPPABLE.has(col) ? "border-line" : "border-dashed border-line"
            }`}
          >
            <header className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-ink">
              <span>{dict.statuses[col]}</span>
              <span className="rounded-full bg-card px-1.5 text-[10px] text-ink-muted">
                {items.length}
              </span>
            </header>
            <ul className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {items.map((n) => (
                <li
                  key={n.id}
                  draggable={payload.canManage}
                  onDragStart={() => setDragging(n.id)}
                  onDragEnd={() => setDragging(null)}
                  className={`rounded-md border bg-card p-2 shadow-sm ${
                    criticalIds.has(n.id) ? "border-danger" : "border-line"
                  } ${selectedId === n.id ? "ring-2 ring-accent" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(n.id)}
                    className="block w-full text-start"
                  >
                    <span className="block text-[10px] uppercase tracking-wide text-ink-muted">
                      {dict.nodeTypes[n.nodeType] ?? n.nodeType}
                      {n.recordId ? ` · ${dict.linked}` : ""}
                    </span>
                    <span className="block text-sm font-medium text-ink">{n.title}</span>
                    {payload.schedule[n.id] ? (
                      <span className="block text-[11px] text-ink-muted" dir="ltr">
                        {payload.schedule[n.id]!.earlyStart} → {payload.schedule[n.id]!.earlyFinish}
                      </span>
                    ) : null}
                    {n.assigneeName ? (
                      <span className="block text-[11px] text-ink-muted">{n.assigneeName}</span>
                    ) : null}
                  </button>
                  {payload.canManage ? (
                    <label className="mt-1 block text-[10px] text-ink-muted">
                      <span className="sr-only">{dict.status}</span>
                      <select
                        value={n.statusCategory}
                        onChange={(e) => void move(n.id, e.target.value)}
                        className="mt-1 min-h-8 w-full rounded border border-line bg-card px-1 text-[11px] text-ink"
                      >
                        {COLUMNS.filter((c) => DROPPABLE.has(c) || c === n.statusCategory).map(
                          (c) => (
                            <option key={c} value={c}>
                              {dict.statuses[c]}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  ) : null}
                  {blockPrompt?.nodeId === n.id ? (
                    <form
                      className="mt-1 flex gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void move(n.id, "blocked", blockPrompt.reason);
                      }}
                    >
                      <input
                        autoFocus
                        value={blockPrompt.reason}
                        onChange={(e) => setBlockPrompt({ nodeId: n.id, reason: e.target.value })}
                        placeholder={dict.reason}
                        className="min-h-8 w-full rounded border border-line-strong bg-card px-1 text-[11px] text-ink"
                      />
                      <button
                        type="submit"
                        className="min-h-8 rounded bg-danger px-2 text-[11px] text-white"
                      >
                        {dict.statuses.blocked}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
