"use client";

/**
 * H25 — the plan workspace: one living model, many projections.
 *
 * The server hands over ONE resolved graph + schedule. This shell owns the
 * view switcher and the selection; each view is a pure projection of the same
 * arrays, and every edit goes through the same typed actions, after which the
 * page re-resolves (router.refresh) so every open projection agrees. No view
 * keeps its own copy of status, dates, assignments or progress.
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EffectiveEdge, EffectiveNode } from "@/modules/studio/service";
import type { ScheduledTask, ScheduleHealth } from "@/modules/studio/service";
import type { LinkableJob } from "@/modules/studio/service";
import type { ActionResult } from "../actions";
import { StudioCanvas } from "./StudioCanvas";
import { Inspector } from "./Inspector";
import { TableView } from "./TableView";
import { GanttView } from "./GanttView";
import { NetworkView } from "./NetworkView";
import { BoardView } from "./BoardView";

export type WorkspacePayload = {
  orgId: string;
  planId: string;
  planName: string;
  planReference: string;
  scenarioId: string | null;
  nodes: EffectiveNode[];
  edges: EffectiveEdge[];
  schedule: Record<string, ScheduledTask>;
  criticalPaths: string[][];
  unscheduled: Array<{ nodeId: string; title: string; reason: string }>;
  warnings: string[];
  health: ScheduleHealth;
  projectStart: string | null;
  projectFinish: string | null;
  calendar: { workingWeekdays: number[]; holidays: Array<{ start: string; end: string }> };
  jobs: LinkableJob[];
  canManage: boolean;
  canSchedule: boolean;
  locale: string;
  initialView: string;
};

export type StudioDict = {
  views: Record<string, string>;
  add: string;
  shapes: string;
  linkRecord: string;
  inspector: string;
  nothingSelected: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  startDate: string;
  dueDate: string;
  duration: string;
  description: string;
  save: string;
  remove: string;
  convert: string;
  convertHint: string;
  chooseJob: string;
  chooseTask: string;
  linked: string;
  withheld: string;
  critical: string;
  milestone: string;
  edgeType: string;
  unscheduled: string;
  warnings: string;
  schedule: string;
  baseline: string;
  baselineName: string;
  saved: string;
  failed: string;
  conflict: string;
  fit: string;
  zoomIn: string;
  zoomOut: string;
  reason: string;
  nodeTypes: Record<string, string>;
  statuses: Record<string, string>;
  edgeTypes: Record<string, string>;
};

export type StudioActions = {
  addNode: (input: Record<string, unknown>) => Promise<ActionResult<{ id: string }>>;
  updateNode: (
    input: Record<string, unknown>,
  ) => Promise<ActionResult<{ routed: string; rowVersion?: number }>>;
  moveNodes: (input: Record<string, unknown>) => Promise<ActionResult<{ moved: number }>>;
  archiveNode: (nodeId: string) => Promise<ActionResult<undefined>>;
  addEdge: (
    input: Record<string, unknown>,
  ) => Promise<ActionResult<{ id: string; taskDependencyId: string | null }>>;
  removeEdge: (edgeId: string) => Promise<ActionResult<undefined>>;
  convertNode: (
    input: Record<string, unknown>,
  ) => Promise<ActionResult<{ recordType: string; recordId: string }>>;
  listJobTasks: (
    jobId: string,
  ) => Promise<
    ActionResult<Array<{ id: string; title: string; status: string; dueDate: string | null }>>
  >;
  captureBaseline: (input: {
    planId: string;
    name: string;
  }) => Promise<ActionResult<{ id: string; entries: number }>>;
  setNodeStatus: (input: Record<string, unknown>) => Promise<ActionResult<{ routed: string }>>;
};

const VIEWS = ["canvas", "board", "gantt", "network", "table"] as const;

export function StudioWorkspace({
  payload,
  dict,
  actions,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
}) {
  const router = useRouter();
  const [view, setView] = useState<string>(
    (VIEWS as readonly string[]).includes(payload.initialView) ? payload.initialView : "canvas",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const selected = useMemo(
    () => payload.nodes.find((n) => n.id === selectedId) ?? null,
    [payload.nodes, selectedId],
  );
  const criticalIds = useMemo(() => new Set(payload.criticalPaths.flat()), [payload.criticalPaths]);

  useEffect(() => {
    // Successes fade; a refusal stays until the next action so it can be read.
    if (!notice || notice.tone === "error") return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  /**
   * Every mutation ends here: report, then re-resolve the living model.
   * `quiet` skips the success notice (a drag is not worth a toast) but never
   * skips the refresh: the client's row versions must follow the server.
   */
  const settle = useCallback(
    (res: ActionResult<unknown>, okText: string = dict.saved, quiet = false) => {
      if (res.ok) {
        if (!quiet) setNotice({ tone: "ok", text: okText });
        startTransition(() => router.refresh());
      } else {
        setNotice({
          tone: "error",
          text: res.code === "conflict" ? dict.conflict : `${dict.failed}: ${res.error}`,
        });
      }
      return res.ok;
    },
    [dict.saved, dict.failed, dict.conflict, router],
  );

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[32rem] flex-col gap-2">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-ink">{payload.planName}</h1>
          <p className="text-xs text-ink-muted" dir="ltr">
            {payload.planReference}
            {payload.projectStart && payload.projectFinish
              ? ` · ${payload.projectStart} → ${payload.projectFinish}`
              : ""}
            {payload.scenarioId ? " · scenario" : ""}
          </p>
        </div>
        <nav className="flex gap-1 rounded-full border border-line bg-card p-1" aria-label="views">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`min-h-9 rounded-full px-3 text-sm ${
                view === v ? "bg-sunken font-medium text-ink" : "text-ink-muted"
              }`}
            >
              {dict.views[v]}
            </button>
          ))}
        </nav>
      </header>

      {notice ? (
        <p
          role="status"
          className={`rounded-md px-3 py-1.5 text-sm ${
            notice.tone === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-card">
          {view === "canvas" ? (
            <StudioCanvas
              payload={payload}
              dict={dict}
              actions={actions}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "board" ? (
            <BoardView
              payload={payload}
              dict={dict}
              actions={actions}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "gantt" ? (
            <GanttView
              payload={payload}
              dict={dict}
              actions={actions}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "network" ? (
            <NetworkView
              payload={payload}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : (
            <TableView
              payload={payload}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <aside className="hidden w-80 shrink-0 overflow-y-auto rounded-lg border border-line bg-card p-3 lg:block">
          <Inspector
            node={selected}
            payload={payload}
            dict={dict}
            actions={actions}
            settle={settle}
            onClose={() => setSelectedId(null)}
          />
        </aside>
      </div>

      {selected ? (
        <div className="lg:hidden">
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-line bg-card p-3">
            <Inspector
              node={selected}
              payload={payload}
              dict={dict}
              actions={actions}
              settle={settle}
              onClose={() => setSelectedId(null)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
