"use client";

/**
 * H25I — the strategy map: objectives, key results and the initiatives that
 * carry them, laid out top-down by dagre from the SAME contribution edges the
 * canvas holds. Nothing is typed in here; an objective with no contribution
 * is shown as such, which is the point.
 */
import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

const KINDS = new Set([
  "portfolio",
  "program",
  "objective",
  "key_result",
  "initiative",
  "outcome",
  "benefit",
  "project",
]);
const W = 200;
const H = 60;

export function StrategyView({
  payload,
  dict,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const layout = useMemo(() => {
    const items = payload.nodes.filter((n) => KINDS.has(n.nodeType));
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "BT", nodesep: 28, ranksep: 70, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of items) g.setNode(n.id, { width: W, height: H });
    const edges = payload.edges.filter(
      (e) =>
        (e.edgeType === "contribution" || e.edgeType === "cause_effect") &&
        g.hasNode(e.sourceNodeId) &&
        g.hasNode(e.targetNodeId),
    );
    for (const e of edges) g.setEdge(e.sourceNodeId, e.targetNodeId);
    dagre.layout(g);
    const pos = new Map<string, { x: number; y: number }>();
    for (const id of g.nodes()) {
      const p = g.node(id);
      if (p) pos.set(id, { x: p.x - W / 2, y: p.y - H / 2 });
    }
    const contributed = new Set(edges.map((e) => e.targetNodeId));
    const gr = g.graph();
    return {
      items,
      edges,
      pos,
      contributed,
      width: Math.max((gr.width ?? 0) + 32, 400),
      height: Math.max((gr.height ?? 0) + 32, 240),
    };
  }, [payload]);

  if (layout.items.length === 0) {
    return <p className="p-4 text-sm text-ink-muted">{dict.strategyEmpty}</p>;
  }

  return (
    <div className="h-full overflow-auto" dir="ltr">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
          <defs>
            <marker
              id="s-arrow"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#1f6f5f" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const a = layout.pos.get(e.sourceNodeId);
            const b = layout.pos.get(e.targetNodeId);
            if (!a || !b) return null;
            const x1 = a.x + W / 2;
            const y1 = a.y;
            const x2 = b.x + W / 2;
            const y2 = b.y + H;
            const my = (y1 + y2) / 2;
            return (
              <path
                key={e.id}
                d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                fill="none"
                stroke="#1f6f5f"
                strokeWidth={1.5}
                markerEnd="url(#s-arrow)"
              />
            );
          })}
        </svg>
        {layout.items.map((n) => {
          const p = layout.pos.get(n.id)!;
          const orphan =
            (n.nodeType === "objective" || n.nodeType === "key_result") &&
            !layout.contributed.has(n.id);
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              className={`absolute rounded-md border bg-card px-2 py-1 text-start shadow-sm ${
                orphan ? "border-dashed border-warning" : "border-line"
              } ${selectedId === n.id ? "ring-2 ring-accent" : ""}`}
              style={{ left: p.x, top: p.y, width: W, height: H }}
              title={orphan ? dict.strategyOrphan : undefined}
            >
              <span className="block text-[10px] uppercase tracking-wide text-ink-muted">
                {dict.nodeTypes[n.nodeType] ?? n.nodeType}
              </span>
              <span className="block truncate text-xs font-medium text-ink">{n.title}</span>
              <span className="block truncate text-[10px] text-ink-muted">
                {dict.statuses[n.statusCategory] ?? n.statusCategory}
                {orphan ? ` · ${dict.strategyOrphan}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
