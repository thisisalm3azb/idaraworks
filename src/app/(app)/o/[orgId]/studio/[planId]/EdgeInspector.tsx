"use client";

/**
 * H25D — the connector inspector: a dependency's kind and lead/lag are the
 * schedule's logic, so they are edited here and re-made through the owning
 * door; a label is presentation. Removing a connector removes the real
 * dependency too.
 */
import { useState, useTransition } from "react";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

const KINDS = ["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"] as const;

export function EdgeInspector({
  edgeId,
  payload,
  dict,
  actions,
  settle,
  onClose,
}: {
  edgeId: string;
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
  onClose: () => void;
}) {
  const edge = payload.edges.find((e) => e.id === edgeId) ?? null;
  const [pending, start] = useTransition();
  const [seededFor, setSeededFor] = useState(edgeId);
  const [label, setLabel] = useState(edge?.label ?? "");
  const [kind, setKind] = useState(edge?.depKind ?? "finish_to_start");
  const [lag, setLag] = useState(String(edge?.lagDays ?? 0));
  if (seededFor !== edgeId) {
    setSeededFor(edgeId);
    setLabel(edge?.label ?? "");
    setKind(edge?.depKind ?? "finish_to_start");
    setLag(String(edge?.lagDays ?? 0));
  }
  if (!edge) return <p className="text-sm text-ink-muted">{dict.nothingSelected}</p>;
  const from = payload.nodes.find((n) => n.id === edge.sourceNodeId)?.title ?? "?";
  const to = payload.nodes.find((n) => n.id === edge.targetNodeId)?.title ?? "?";
  const isDependency = edge.edgeType === "dependency";
  const input =
    "mt-1 min-h-10 w-full rounded-md border border-line-strong bg-card px-2 text-sm text-ink";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-ink-muted">
            {dict.edgeTypes[edge.edgeType] ?? edge.edgeType}
            {edge.materialized && isDependency ? ` · ${dict.linked}` : ""}
          </span>
          <span className="block truncate text-sm font-medium text-ink">
            {from} → {to}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={dict.remove}
          className="min-h-8 min-w-8 text-ink-muted"
        >
          ×
        </button>
      </div>
      <label className="text-xs text-ink-muted">
        {dict.edgeLabel}
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          className={input}
          disabled={!payload.canManage}
        />
      </label>
      {isDependency ? (
        <>
          <label className="text-xs text-ink-muted">
            {dict.edgeType}
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className={input}
              disabled={!payload.canManage}
              dir="ltr"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {dict.depKinds[k] ?? k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            {dict.lag}
            <input
              type="number"
              min={-365}
              max={365}
              value={lag}
              onChange={(e) => setLag(e.target.value)}
              className={input}
              disabled={!payload.canManage}
              dir="ltr"
            />
            <span className="block text-[10px] text-ink-muted">{dict.lagHint}</span>
          </label>
        </>
      ) : null}
      {payload.canManage ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                settle(
                  await actions.updateEdge({
                    edgeId,
                    label: label.trim() || null,
                    ...(isDependency ? { depKind: kind, lagDays: Number(lag) || 0 } : {}),
                  }),
                );
              })
            }
            className="min-h-10 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {dict.save}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                if (settle(await actions.removeEdge(edgeId))) onClose();
              })
            }
            className="min-h-10 rounded-md border border-line px-3 text-sm text-danger disabled:opacity-50"
          >
            {dict.remove}
          </button>
        </div>
      ) : null}
    </div>
  );
}
