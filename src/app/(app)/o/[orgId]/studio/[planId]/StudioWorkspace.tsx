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
import { usePathname, useRouter } from "next/navigation";
import type {
  CapacityReport,
  EffectiveEdge,
  EffectiveNode,
  LevelingProposal,
  ScenarioComparison,
  ScenarioRow,
} from "@/modules/studio/service";
import type { AllocationRow } from "@/modules/jobs/service";
import type { ScheduledTask, ScheduleHealth } from "@/modules/studio/service";
import type { LinkableJob } from "@/modules/studio/service";
import type { ActionResult, SimulationDto } from "../actions";
import { StudioCanvas } from "./StudioCanvas";
import { Inspector } from "./Inspector";
import { TableView } from "./TableView";
import { GanttView } from "./GanttView";
import { NetworkView } from "./NetworkView";
import { BoardView } from "./BoardView";
import { ScenarioPanel } from "./ScenarioPanel";
import { RoadmapView } from "./RoadmapView";
import { CalendarView } from "./CalendarView";
import { WorkloadView } from "./WorkloadView";
import { RiskMatrixView } from "./RiskMatrixView";

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
  /** H25G — the plan's scenarios and, when one is active, its comparison with live. */
  scenarios: ScenarioRow[];
  scenario: ScenarioComparison | null;
  /** H25H — capacity projection of the same schedule, allocations per linked task, people to allocate. */
  capacity: CapacityReport;
  allocations: Record<string, AllocationRow[]>;
  people: Array<{ id: string; name: string; teamName: string | null }>;
  canAllocate: boolean;
  canManage: boolean;
  canSchedule: boolean;
  canManageScenario: boolean;
  canApplyScenario: boolean;
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
  estimateOptimistic: string;
  estimatePessimistic: string;
  unassigned: string;
  capacity: string;
  likelihood: string;
  impact: string;
  unscored: string;
  today: string;
  nothingScheduled: string;
  peopleOnTask: string;
  addPerson: string;
  share: string;
  level: string;
  levelName: string;
  overloads: string;
  peopleWithheld: string;
  implicit: string;
  nodeTypes: Record<string, string>;
  statuses: Record<string, string>;
  edgeTypes: Record<string, string>;
  /** Flat scenario copy: title, live, new, name, branch_hint, status_<s>, … */
  scenario: Record<string, string>;
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
  createScenario: (input: Record<string, unknown>) => Promise<ActionResult<{ id: string }>>;
  updateScenario: (input: Record<string, unknown>) => Promise<ActionResult<{ rowVersion: number }>>;
  submitScenario: (input: {
    scenarioId: string;
    expectedRowVersion?: number;
  }) => Promise<ActionResult<{ status: string; approvalId: string }>>;
  applyScenario: (input: {
    scenarioId: string;
    expectedRowVersion?: number;
  }) => Promise<ActionResult<{ applied: number }>>;
  discardScenario: (input: { scenarioId: string }) => Promise<ActionResult<void>>;
  simulate: (input: {
    planId: string;
    scenarioId?: string;
    samples?: number;
    seed?: number;
  }) => Promise<ActionResult<SimulationDto>>;
  allocateTask: (input: {
    taskId: string;
    employeeId: string;
    sharePct?: number;
    note?: string;
  }) => Promise<ActionResult<{ id: string }>>;
  unallocateTask: (allocationId: string) => Promise<ActionResult<void>>;
  level: (input: {
    planId: string;
    name: string;
  }) => Promise<
    ActionResult<{ scenarioId: string; proposals: LevelingProposal[]; unresolved: number }>
  >;
};

const VIEWS = [
  "canvas",
  "board",
  "gantt",
  "network",
  "roadmap",
  "calendar",
  "workload",
  "risk",
  "table",
] as const;

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
  const pathname = usePathname();
  // The aside shows the inspector for a selection, otherwise the scenario
  // laboratory; a person can flip between them.
  const [asideTab, setAsideTab] = useState<"inspector" | "scenarios">(
    payload.scenario ? "scenarios" : "inspector",
  );
  const openScenario = useCallback(
    (id: string | null) => {
      router.push(id ? `${pathname}?scenario=${id}` : pathname);
    },
    [router, pathname],
  );
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
  const [lastSelected, setLastSelected] = useState<string | null>(selectedId);
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId);
    if (selectedId) setAsideTab("inspector");
  }
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
          </p>
          {payload.scenario ? (
            <p className="mt-0.5 w-fit rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning">
              {dict.scenario.active}: {payload.scenario.scenario.name} ·{" "}
              {dict.scenario[`status_${payload.scenario.scenario.status}`]}
            </p>
          ) : null}
        </div>
        <nav
          className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-card p-1"
          aria-label="views"
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`min-h-9 shrink-0 rounded-full px-3 text-sm ${
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
          ) : view === "roadmap" ? (
            <RoadmapView
              payload={payload}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "calendar" ? (
            <CalendarView
              payload={payload}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "workload" ? (
            <WorkloadView
              payload={payload}
              dict={dict}
              actions={actions}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
              onOpenScenario={openScenario}
            />
          ) : view === "risk" ? (
            <RiskMatrixView
              payload={payload}
              dict={dict}
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
          <div className="mb-3 flex gap-1 rounded-full border border-line bg-sunken p-0.5 text-xs">
            {(["inspector", "scenarios"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setAsideTab(t)}
                aria-pressed={asideTab === t}
                className={`min-h-8 flex-1 rounded-full ${
                  asideTab === t ? "bg-card font-medium text-ink shadow-sm" : "text-ink-muted"
                }`}
              >
                {t === "inspector" ? dict.inspector : dict.scenario.title}
              </button>
            ))}
          </div>
          {asideTab === "inspector" ? (
            <Inspector
              node={selected}
              payload={payload}
              dict={dict}
              actions={actions}
              settle={settle}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <ScenarioPanel
              payload={payload}
              dict={dict}
              actions={actions}
              settle={settle}
              onOpen={openScenario}
            />
          )}
        </aside>
      </div>

      {!selected ? (
        <div className="lg:hidden">
          <details className="rounded-lg border border-line bg-card p-3">
            <summary className="min-h-8 cursor-pointer text-sm font-medium text-ink">
              {dict.scenario.title}
              {payload.scenario ? ` · ${payload.scenario.scenario.name}` : ""}
            </summary>
            <div className="mt-2 max-h-[50vh] overflow-y-auto">
              <ScenarioPanel
                payload={payload}
                dict={dict}
                actions={actions}
                settle={settle}
                onOpen={openScenario}
              />
            </div>
          </details>
        </div>
      ) : null}

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
