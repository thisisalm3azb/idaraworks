"use client";

/**
 * H25E — the dependency network / critical-path projection. Activities are
 * laid out left-to-right by dagre from the SAME dependency edges the engine
 * scheduled; the critical chain(s) are exactly the engine's zero-float paths,
 * and every node shows its float. Selecting focuses the inspector.
 */
import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

const NODE_W = 180;
const NODE_H = 56;
const ACTIVITIES = new Set([
  "task",
  "milestone",
  "deliverable",
  "phase",
  "project",
  "initiative",
  "action",
]);

export function NetworkView({
  payload,
  dict,
  criticalIds,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 64, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    const activities = payload.nodes.filter((n) => ACTIVITIES.has(n.nodeType));
    for (const n of activities) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    const deps = payload.edges.filter(
      (e) => e.edgeType === "dependency" && g.hasNode(e.sourceNodeId) && g.hasNode(e.targetNodeId),
    );
    for (const e of deps) g.setEdge(e.sourceNodeId, e.targetNodeId);
    dagre.layout(g);
    const pos = new Map<string, { x: number; y: number }>();
    for (const id of g.nodes()) {
      const p = g.node(id);
      if (p) pos.set(id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
    }
    const gr = g.graph();
    return {
      activities,
      deps,
      pos,
      width: Math.max((gr.width ?? 0) + 32, 400),
      height: Math.max((gr.height ?? 0) + 32, 240),
    };
  }, [payload]);

  if (layout.activities.length === 0) {
    return <p className="p-4 text-sm text-ink-muted">{dict.unscheduled}</p>;
  }

  return (
    <div className="h-full overflow-auto" dir="ltr">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#9aa8a2" />
            </marker>
            <marker
              id="arrow-critical"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#b3261e" />
            </marker>
          </defs>
          {layout.deps.map((e) => {
            const a = layout.pos.get(e.sourceNodeId);
            const b = layout.pos.get(e.targetNodeId);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const critical = criticalIds.has(e.sourceNodeId) && criticalIds.has(e.targetNodeId);
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={e.id}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={critical ? "#b3261e" : "#9aa8a2"}
                strokeWidth={critical ? 2.5 : 1.5}
                markerEnd={critical ? "url(#arrow-critical)" : "url(#arrow)"}
              />
            );
          })}
        </svg>
        {layout.activities.map((n) => {
          const p = layout.pos.get(n.id)!;
          const s = payload.schedule[n.id];
          const critical = criticalIds.has(n.id);
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              className={`absolute rounded-md border bg-card px-2 py-1 text-start shadow-sm ${
                critical ? "border-danger" : "border-line"
              } ${selectedId === n.id ? "ring-2 ring-accent" : ""}`}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
            >
              <span className="block truncate text-xs font-medium text-ink">{n.title}</span>
              <span className="block text-[10px] text-ink-muted">
                {s ? `${s.earlyStart} → ${s.earlyFinish}` : dict.unscheduled}
              </span>
              <span
                className={`block text-[10px] ${critical ? "font-semibold text-danger" : "text-ink-muted"}`}
              >
                {s ? `float ${s.totalFloatDays}${critical ? ` · ${dict.critical}` : ""}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
