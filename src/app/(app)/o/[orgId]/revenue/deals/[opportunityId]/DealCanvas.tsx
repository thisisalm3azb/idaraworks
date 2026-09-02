"use client";

/**
 * H27 — the optional deal canvas: stakeholders, decisions, risks, documents
 * and steps as nodes a person arranges and links. Loaded lazily (React Flow
 * is heavy), saved explicitly with a row version so two people cannot
 * silently overwrite each other. The canvas is a picture of the deal, never
 * a source of truth: the stakeholder and risk records stay in their tabs.
 */
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/platform/ui";
import type { CanvasDoc } from "@/modules/crm/service";
import { saveCanvasAction, type SaveCanvasResult } from "./actions";

export type CanvasDict = {
  add: string;
  label: string;
  kind: Record<CanvasDoc["nodes"][number]["kind"], string>;
  save: string;
  saved: string;
  conflict: string;
  failed: string;
  forbidden: string;
  hint: string;
};

type NodeData = { label: string; kind: CanvasDoc["nodes"][number]["kind"]; ref?: string };

function toFlow(doc: CanvasDoc): { nodes: Node<NodeData>[]; edges: Edge[] } {
  return {
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: n.label, kind: n.kind, ref: n.ref },
      type: "default",
    })),
    edges: doc.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.label })),
  };
}

function toDoc(nodes: Node<NodeData>[], edges: Edge[]): CanvasDoc {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      label: n.data.label,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      ...(n.data.ref ? { ref: n.data.ref } : {}),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    })),
  };
}

export function DealCanvas({
  orgId,
  opportunityId,
  initial,
  initialRowVersion,
  canManage,
  dict,
}: {
  orgId: string;
  opportunityId: string;
  initial: CanvasDoc;
  initialRowVersion: number;
  canManage: boolean;
  dict: CanvasDict;
}) {
  const start = useMemo(() => toFlow(initial), [initial]);
  const [nodes, setNodes] = useState<Node<NodeData>[]>(start.nodes);
  const [edges, setEdges] = useState<Edge[]>(start.edges);
  const [rowVersion, setRowVersion] = useState(initialRowVersion);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<NodeData["kind"]>("note");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) => addEdge({ ...c, id: `e${es.length + 1}-${Date.now().toString(36)}` }, es)),
    [],
  );
  const add = () => {
    const text = label.trim();
    if (!text) return;
    setNodes((ns) => [
      ...ns,
      {
        id: `n${Date.now().toString(36)}`,
        position: { x: 40 + (ns.length % 5) * 160, y: 40 + Math.floor(ns.length / 5) * 100 },
        data: { label: text, kind },
        type: "default",
      },
    ]);
    setLabel("");
  };
  const save = () =>
    startTransition(async () => {
      const r: SaveCanvasResult = await saveCanvasAction(orgId, {
        opportunityId,
        doc: toDoc(nodes, edges),
        rowVersion,
      });
      if (r.ok) {
        setRowVersion(r.rowVersion);
        setStatus(dict.saved);
      } else
        setStatus(
          r.code === "conflict"
            ? dict.conflict
            : r.code === "forbidden"
              ? dict.forbidden
              : dict.failed,
        );
    });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">{dict.hint}</p>
      {canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            {dict.label}
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={200}
              className="min-h-10 rounded-md border border-line-strong bg-card px-3 text-sm text-ink"
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
            />
          </label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as NodeData["kind"])}
            className="min-h-10 rounded-md border border-line-strong bg-card px-2 text-sm text-ink"
            aria-label={dict.add}
          >
            {(Object.keys(dict.kind) as NodeData["kind"][]).map((k) => (
              <option key={k} value={k}>
                {dict.kind[k]}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={add}>
            {dict.add}
          </Button>
          <Button onClick={save} disabled={pending}>
            {dict.save}
          </Button>
          {status ? (
            <span className="text-xs text-ink-muted" role="status">
              {status}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="h-[420px] w-full rounded-md border border-line bg-card" dir="ltr">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={canManage ? onNodesChange : undefined}
          onEdgesChange={canManage ? onEdgesChange : undefined}
          onConnect={canManage ? onConnect : undefined}
          nodesDraggable={canManage}
          nodesConnectable={canManage}
          elementsSelectable
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
