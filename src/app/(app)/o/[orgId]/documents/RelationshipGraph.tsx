"use client";

/**
 * H26 — the relationship view: documents, the counterparties and records
 * they connect to, and supersession chains, laid out as a graph. Loaded
 * lazily (React Flow is not part of the library's initial bundle).
 */
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DocumentRow } from "@/modules/docstudio/service";
import type { HomeDict } from "./DocumentsHome";

const COLORS: Record<string, string> = {
  draft: "#9aa3a0",
  review: "#4f86c6",
  approval: "#4f86c6",
  signature: "#c68a1f",
  active: "#2f8f5b",
  expired: "#b3352c",
  terminated: "#b3352c",
  superseded: "#7a7a7a",
  archived: "#7a7a7a",
};

export default function RelationshipGraph({
  rows,
  orgId,
  dict,
}: {
  rows: DocumentRow[];
  orgId: string;
  dict: HomeDict;
}) {
  const router = useRouter();
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const hubs = new Map<string, { label: string; kind: string }>();
    const docIds = new Set(rows.map((r) => r.id));
    rows.forEach((r, i) => {
      nodes.push({
        id: `doc:${r.id}`,
        position: { x: 320, y: i * 90 },
        data: { label: `${r.reference}\n${r.title}` },
        style: {
          borderColor: COLORS[r.effectiveStatus] ?? "#999",
          borderWidth: 2,
          width: 220,
          whiteSpace: "pre-wrap",
          fontSize: 12,
        },
      });
      if (r.counterpartyKind && (r.counterpartyId || r.counterpartyLabel)) {
        const key = `cp:${r.counterpartyKind}:${r.counterpartyId ?? r.counterpartyLabel}`;
        hubs.set(key, {
          label:
            `${dict.counterparty[r.counterpartyKind] ?? r.counterpartyKind}\n${r.counterpartyLabel ?? ""}`.trim(),
          kind: "counterparty",
        });
        edges.push({ id: `${key}->${r.id}`, source: key, target: `doc:${r.id}`, animated: false });
      }
      if (r.recordType && r.recordId) {
        const key = `rec:${r.recordType}:${r.recordId}`;
        hubs.set(key, { label: `${r.recordType}\n${r.recordId.slice(0, 8)}`, kind: "record" });
        edges.push({
          id: `${key}->${r.id}`,
          source: key,
          target: `doc:${r.id}`,
          style: { strokeDasharray: "4 3" },
        });
      }
      if (r.supersedesDocumentId && docIds.has(r.supersedesDocumentId)) {
        edges.push({
          id: `sup:${r.supersedesDocumentId}->${r.id}`,
          source: `doc:${r.supersedesDocumentId}`,
          target: `doc:${r.id}`,
          label: dict.status.superseded,
          animated: true,
        });
      }
    });
    let i = 0;
    for (const [id, h] of hubs) {
      nodes.push({
        id,
        position: { x: h.kind === "record" ? 640 : 0, y: i * 90 },
        data: { label: h.label },
        style: { width: 200, whiteSpace: "pre-wrap", fontSize: 12, background: "#f4f4f2" },
      });
      i += 1;
    }
    return { nodes, edges };
  }, [rows, dict]);

  return (
    <div className="h-[560px] overflow-hidden rounded-lg border border-line bg-card shadow-card">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        onNodeClick={(_, n) => {
          if (n.id.startsWith("doc:")) router.push(`/o/${orgId}/documents/${n.id.slice(4)}`);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
