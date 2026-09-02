"use client";

/**
 * H25C — the infinite canvas, projected from the living model.
 *
 * React Flow renders; WE own the model. Nodes carry their semantic type,
 * live status, dates and criticality (from the schedule bridge); dragging
 * commits placement in one batch; connecting two shapes creates a TYPED edge
 * (a dependency between activities becomes canonical); Delete archives
 * (soft). The projection is DERIVED from the server payload (no state copy):
 * only in-flight drag positions and the selection live locally, and both
 * reset when a fresh resolution arrives. The canvas is a spatial surface and
 * is forced LTR like the trend chart; everything around it flips with the
 * document direction.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EffectiveNode } from "@/modules/studio/service";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

type StudioNodeData = {
  title: string;
  nodeType: string;
  statusLabel: string;
  statusCategory: string;
  dates: string | null;
  assignee: string | null;
  critical: boolean;
  milestone: boolean;
  locked: boolean;
  linked: boolean;
  withheld: boolean;
  warnings: number;
  typeLabel: string;
  remote: string[];
};
type StudioNode = Node<StudioNodeData, "studio">;

const STATUS_TONE: Record<string, string> = {
  planned: "bg-sunken text-ink-muted",
  ready: "bg-info-soft text-info",
  active: "bg-success-soft text-success",
  blocked: "bg-danger-soft text-danger",
  waiting: "bg-warning-soft text-warning",
  done: "bg-sunken text-ink-muted line-through",
  dropped: "bg-sunken text-ink-muted line-through",
};

const CONTAINERS = new Set(["frame", "group", "swimlane"]);
const ACTIVITIES = new Set([
  "task",
  "milestone",
  "deliverable",
  "phase",
  "project",
  "initiative",
  "action",
]);

/** Shape vocabulary: a restrained silhouette per semantic family. */
function shapeClass(nodeType: string): string {
  switch (nodeType) {
    case "decision":
      return "rounded-md border-2";
    case "milestone":
      return "rounded-full border-2";
    case "start_end":
      return "rounded-full";
    case "note":
      return "rounded-sm border-dashed";
    case "frame":
    case "group":
    case "swimlane":
      return "rounded-lg border-dashed bg-transparent";
    case "risk":
      return "rounded-md border-s-4";
    case "objective":
    case "key_result":
      return "rounded-xl";
    default:
      return "rounded-md";
  }
}

function StudioNodeView({ data, selected }: NodeProps<StudioNode>) {
  const container = CONTAINERS.has(data.nodeType);
  return (
    <div
      style={data.remote.length > 0 ? { boxShadow: `0 0 0 3px ${data.remote[0]}` } : undefined}
      className={`min-h-11 border border-line bg-card px-3 py-2 text-start shadow-sm transition-shadow ${shapeClass(
        data.nodeType,
      )} ${selected ? "ring-2 ring-accent" : ""} ${data.critical ? "border-danger" : ""} ${
        container ? "min-h-40 min-w-56" : "min-w-44 max-w-64"
      } ${data.withheld ? "opacity-70" : ""}`}
      data-node-type={data.nodeType}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-ink-muted" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          {data.typeLabel}
        </span>
        <span className="flex items-center gap-1">
          {data.locked ? <span aria-label="locked">🔒</span> : null}
          {data.linked ? <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> : null}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm font-medium text-ink">{data.title}</p>
      {!container ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
          <span className={`rounded-full px-1.5 py-0.5 ${STATUS_TONE[data.statusCategory] ?? ""}`}>
            {data.statusLabel}
          </span>
          {data.dates ? (
            <span className="text-ink-muted" dir="ltr">
              {data.dates}
            </span>
          ) : null}
          {data.assignee ? <span className="truncate text-ink-muted">{data.assignee}</span> : null}
          {data.warnings > 0 ? (
            <span className="text-warning" aria-label="warnings">
              ⚠ {data.warnings}
            </span>
          ) : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-accent" />
    </div>
  );
}

const nodeTypes: NodeTypes = { studio: StudioNodeView };

function toFlowNodes(
  nodes: EffectiveNode[],
  payload: WorkspacePayload,
  dict: StudioDict,
  criticalIds: Set<string>,
  remoteSelections: Record<string, string[]> = {},
): StudioNode[] {
  return nodes.map((n) => {
    const sched = payload.schedule[n.id];
    const dates = sched
      ? sched.durationDays === 0
        ? sched.earlyStart
        : `${sched.earlyStart} → ${sched.earlyFinish}`
      : n.startDate || n.dueDate
        ? `${n.startDate ?? "…"} → ${n.dueDate ?? "…"}`
        : null;
    const container = CONTAINERS.has(n.nodeType);
    return {
      id: n.id,
      type: "studio",
      position: { x: n.x, y: n.y },
      draggable: !n.locked,
      selectable: true,
      zIndex: container ? 0 : n.z + 1,
      style: n.w && n.h ? { width: n.w, height: n.h } : undefined,
      data: {
        title: n.title,
        nodeType: n.nodeType,
        statusLabel: dict.statuses[n.statusCategory] ?? n.statusCategory,
        statusCategory: n.statusCategory,
        dates,
        assignee: n.assigneeName,
        critical: criticalIds.has(n.id),
        milestone: n.isMilestone || n.nodeType === "milestone",
        locked: n.locked,
        linked: n.recordId !== null,
        withheld: n.recordId !== null && !n.recordVisible,
        warnings: n.warnings.length,
        typeLabel: dict.nodeTypes[n.nodeType] ?? n.nodeType,
        remote: remoteSelections[n.id] ?? [],
      },
    };
  });
}

function depLabel(depKind: string | null, lagDays: number): string {
  const short = (depKind ?? "")
    .replace("finish_to_start", "FS")
    .replace("start_to_start", "SS")
    .replace("finish_to_finish", "FF")
    .replace("start_to_finish", "SF");
  const lag = lagDays ? (lagDays > 0 ? ` +${lagDays}` : ` ${lagDays}`) : "";
  return `${short}${lag}`;
}

function toFlowEdges(
  payload: WorkspacePayload,
  dict: StudioDict,
  criticalIds: Set<string>,
): Edge[] {
  return payload.edges.map((e) => {
    const dep = e.edgeType === "dependency";
    const critical = dep && criticalIds.has(e.sourceNodeId) && criticalIds.has(e.targetNodeId);
    return {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.label ?? (dep ? depLabel(e.depKind, e.lagDays) : dict.edgeTypes[e.edgeType]),
      animated: dep && !e.materialized,
      style: {
        stroke: critical
          ? "var(--color-danger, #b3261e)"
          : dep
            ? "var(--accent, #0e6f5c)"
            : "#9aa8a2",
        strokeWidth: critical ? 2.5 : 1.5,
        strokeDasharray: dep ? undefined : "4 3",
      },
      labelStyle: { fontSize: 10 },
      data: { edgeType: e.edgeType, materialized: e.materialized },
    };
  });
}

const PALETTE: string[] = [
  "task",
  "milestone",
  "phase",
  "deliverable",
  "objective",
  "key_result",
  "decision",
  "risk",
  "issue",
  "assumption",
  "process",
  "person",
  "team",
  "customer",
  "supplier",
  "system",
  "document",
  "warehouse",
  "money",
  "start_end",
  "note",
  "frame",
];

type Pos = { x: number; y: number };
const NO_REMOTE: Record<string, string[]> = {};

function CanvasInner({
  payload,
  dict,
  actions,
  criticalIds,
  selectedId,
  onSelect,
  settle,
  remoteSelections = NO_REMOTE,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
  remoteSelections?: Record<string, string[]>;
}) {
  const rf = useReactFlow();
  // Local state is ONLY what the server cannot know yet: in-flight drag
  // positions and the multi-selection. Both reset on a fresh resolution
  // (the React "adjust state while rendering" pattern, no effects).
  const [overrides, setOverrides] = useState<Map<string, Pos>>(() => new Map());
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  // React Flow 12 only keeps `measured` from the node we hand it, so the DOM
  // measurements it reports must be stored and handed back, or the minimap and
  // fit-to-view see unmeasured nodes after every re-resolution.
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
    () => new Map(),
  );
  const [seen, setSeen] = useState(payload);
  if (seen !== payload) {
    setSeen(payload);
    setOverrides(new Map());
  }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dragStart = useRef<Map<string, Pos>>(new Map());

  const baseNodes = useMemo(
    () => toFlowNodes(payload.nodes, payload, dict, criticalIds, remoteSelections),
    [payload, dict, criticalIds, remoteSelections],
  );
  const nodes = useMemo(
    () =>
      baseNodes.map((n) => {
        const o = overrides.get(n.id);
        const m = measured.get(n.id);
        return {
          ...n,
          selected: selection.has(n.id) || n.id === selectedId,
          ...(o ? { position: o } : {}),
          ...(m ? { measured: m } : {}),
        };
      }),
    [baseNodes, overrides, selection, selectedId, measured],
  );
  const edges = useMemo(
    () => toFlowEdges(payload, dict, criticalIds),
    [payload, dict, criticalIds],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StudioNode>[]) => {
      const nextSel = new Set(selection);
      let selChanged = false;
      let nextOverrides: Map<string, Pos> | null = null;
      let nextMeasured: Map<string, { width: number; height: number }> | null = null;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) {
          nextMeasured = nextMeasured ?? new Map(measured);
          nextMeasured.set(c.id, c.dimensions);
        } else if (c.type === "position" && c.position) {
          nextOverrides = nextOverrides ?? new Map(overrides);
          nextOverrides.set(c.id, c.position);
        } else if (c.type === "select") {
          selChanged = true;
          if (c.selected) nextSel.add(c.id);
          else nextSel.delete(c.id);
        }
      }
      if (nextMeasured) setMeasured(nextMeasured);
      if (nextOverrides) setOverrides(nextOverrides);
      if (selChanged) {
        setSelection(nextSel);
        onSelect(nextSel.size === 1 ? [...nextSel][0]! : null);
      }
    },
    [overrides, selection, measured, onSelect],
  );

  const onNodeDragStart = useCallback((_: unknown, node: StudioNode, all: StudioNode[]) => {
    const group = all.length ? all : [node];
    dragStart.current = new Map(group.map((n) => [n.id, n.position]));
  }, []);

  const onNodeDragStop = useCallback(
    async (_: unknown, node: StudioNode, all: StudioNode[]) => {
      const moved = (all.length ? all : [node]).filter((n) => {
        const before = dragStart.current.get(n.id);
        return !before || before.x !== n.position.x || before.y !== n.position.y;
      });
      if (moved.length === 0) return;
      const res = await actions.moveNodes({
        planId: payload.planId,
        moves: moved.map((n) => ({
          nodeId: n.id,
          x: Math.round(n.position.x),
          y: Math.round(n.position.y),
        })),
      });
      settle(res, undefined, true);
    },
    [actions, payload.planId, settle],
  );

  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || !payload.canManage) return;
      const s = payload.nodes.find((n) => n.id === c.source);
      const t = payload.nodes.find((n) => n.id === c.target);
      const dependency = !!s && !!t && ACTIVITIES.has(s.nodeType) && ACTIVITIES.has(t.nodeType);
      const res = await actions.addEdge({
        planId: payload.planId,
        sourceNodeId: c.source,
        targetNodeId: c.target,
        edgeType: dependency ? "dependency" : "reference",
        ...(dependency ? { depKind: "finish_to_start" } : {}),
      });
      settle(res);
    },
    [actions, payload, settle],
  );

  const onNodesDelete = useCallback(
    async (deleted: StudioNode[]) => {
      if (!payload.canManage) return;
      for (const n of deleted) {
        const res = await actions.archiveNode(n.id);
        if (!settle(res)) break;
      }
      setSelection(new Set());
      onSelect(null);
    },
    [actions, payload.canManage, settle, onSelect],
  );

  const onEdgesDelete = useCallback(
    async (deleted: Edge[]) => {
      if (!payload.canManage) return;
      for (const e of deleted) {
        const res = await actions.removeEdge(e.id);
        if (!settle(res)) break;
      }
    },
    [actions, payload.canManage, settle],
  );

  const addShape = useCallback(
    async (nodeType: string) => {
      const center = rf.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const res = await actions.addNode({
        planId: payload.planId,
        nodeType,
        title: dict.nodeTypes[nodeType] ?? nodeType,
        x: Math.round(center.x),
        y: Math.round(center.y),
      });
      setPaletteOpen(false);
      if (settle(res) && res.ok) onSelect(res.data.id);
    },
    [rf, actions, payload.planId, dict.nodeTypes, settle, onSelect],
  );

  const minimapColor = useCallback(
    (n: StudioNode) => (criticalIds.has(n.id) ? "#b3261e" : n.data.linked ? "#0e6f5c" : "#9aa8a2"),
    [criticalIds],
  );

  return (
    <div className="relative h-full w-full" dir="ltr">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        nodesDraggable={payload.canManage}
        nodesConnectable={payload.canManage}
        elementsSelectable
        deleteKeyCode={payload.canManage ? ["Delete", "Backspace"] : null}
        multiSelectionKeyCode="Shift"
        selectionOnDrag
        panOnDrag={[1, 2]}
        snapToGrid
        snapGrid={[8, 8]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.1}
        maxZoom={2.5}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <MiniMap pannable zoomable nodeColor={minimapColor} className="!bg-card max-sm:!hidden" />
      </ReactFlow>

      <div className="absolute start-2 top-2 flex flex-col gap-1" dir="auto">
        {payload.canManage ? (
          <button
            type="button"
            onClick={() => setPaletteOpen((o) => !o)}
            aria-expanded={paletteOpen}
            className="min-h-10 rounded-md border border-line-strong bg-card px-3 text-sm font-medium text-ink shadow-sm"
          >
            + {dict.add}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => rf.fitView({ padding: 0.2 })}
          className="min-h-10 rounded-md border border-line bg-card px-3 text-sm text-ink shadow-sm"
        >
          {dict.fit}
        </button>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label={dict.zoomIn}
            onClick={() => rf.zoomIn()}
            className="min-h-10 min-w-10 rounded-md border border-line bg-card text-sm text-ink shadow-sm"
          >
            +
          </button>
          <button
            type="button"
            aria-label={dict.zoomOut}
            onClick={() => rf.zoomOut()}
            className="min-h-10 min-w-10 rounded-md border border-line bg-card text-sm text-ink shadow-sm"
          >
            −
          </button>
        </div>
      </div>

      {paletteOpen ? (
        <div
          role="menu"
          aria-label={dict.shapes}
          className="absolute start-2 top-36 z-10 grid max-h-[60%] w-56 grid-cols-2 gap-1 overflow-y-auto rounded-lg border border-line bg-card p-2 shadow-md"
        >
          {PALETTE.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              onClick={() => addShape(k)}
              className="min-h-10 rounded-md border border-line px-2 text-start text-xs text-ink hover:bg-sunken"
            >
              {dict.nodeTypes[k] ?? k}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StudioCanvas(props: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
  remoteSelections?: Record<string, string[]>;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
