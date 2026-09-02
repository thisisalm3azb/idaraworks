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
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import type {
  CapacityReport,
  EffectiveEdge,
  EffectiveNode,
  Finding,
  KpiValue,
  LevelingProposal,
  Narrative,
  SavedView,
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
import { PresenceStrip, usePlanPresence } from "./PresenceLayer";
import { ThreeView } from "./ThreeView";
import { KpiView } from "./KpiView";
import { CommandPalette, type Command } from "./CommandPalette";
import { SavedViewsBar } from "./SavedViewsBar";
import { ReviewPanel } from "./ReviewPanel";
import { StrategyView } from "./StrategyView";

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
  /** H25L — who is looking (presence key + display name; nothing else). */
  viewer: { id: string; name: string };
  /** H25C/J — saved ways of looking, the KPI catalogue's live values, an element to centre on. */
  views: SavedView[];
  kpis: KpiValue[];
  /** H25M — deterministic review findings and their basis. */
  review: { findings: Finding[]; basis: string[] };
  initialFocus: string | null;
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
  peers: string;
  worlds: Record<string, string>;
  worldHint: string;
  worldFallback: string;
  worldLoading: string;
  search: string;
  commands: string;
  nothingFound: string;
  savedViews: string;
  saveView: string;
  viewName: string;
  shareView: string;
  retireView: string;
  focus: string;
  exitFocus: string;
  undo: string;
  nothingToUndo: string;
  filters: string;
  clearFilters: string;
  criticalOnly: string;
  linkExisting: string;
  duplicate: string;
  kpiName: string;
  kpiValue: string;
  kpiBasis: string;
  kpiInsufficient: string;
  kpiNames: Record<string, string>;
  paletteHint: string;
  review: string;
  reviewClean: string;
  reviewLaw: string;
  narrative: string;
  narrativeUnavailable: string;
  severities: Record<string, string>;
  saveAsTemplate: string;
  templateSaved: string;
  strategyEmpty: string;
  strategyOrphan: string;
  nodeTypes: Record<string, string>;
  statuses: Record<string, string>;
  edgeTypes: Record<string, string>;
  /** Flat scenario copy: title, live, new, name, branch_hint, status_<s>, … */
  scenario: Record<string, string>;
};

export type WorkspaceFilters = {
  search: string;
  types: string[];
  statuses: string[];
  criticalOnly: boolean;
};
const NO_FILTERS: WorkspaceFilters = { search: "", types: [], statuses: [], criticalOnly: false };

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
  linkNode: (input: {
    nodeId: string;
    recordType: string;
    recordId: string;
  }) => Promise<ActionResult<void>>;
  duplicateNode: (nodeId: string) => Promise<ActionResult<{ id: string }>>;
  saveView: (input: Record<string, unknown>) => Promise<ActionResult<{ id: string }>>;
  updateView: (input: Record<string, unknown>) => Promise<ActionResult<void>>;
  saveAsTemplate: (input: {
    planId: string;
    key: string;
    name: string;
    description?: string;
  }) => Promise<ActionResult<{ key: string; nodes: number; edges: number }>>;
  reviewNarrative: (input: {
    planId: string;
    scenarioId?: string;
    locale?: "en" | "ar";
  }) => Promise<ActionResult<Narrative>>;
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
  "world",
  "strategy",
  "kpis",
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
  const [asideTab, setAsideTab] = useState<"inspector" | "scenarios" | "review">(
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
  const [selectedId, setSelectedId] = useState<string | null>(payload.initialFocus);
  // H25C — presentation state: filters, focus mode, the palette, where to centre.
  const [filters, setFilters] = useState<WorkspaceFilters>(NO_FILTERS);
  const [focus, setFocus] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(payload.initialFocus);
  const undoStack = useRef<Array<() => Promise<ActionResult<unknown>>>>([]);
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
  // Presence rides a private channel; `changed` tells peers to re-resolve.
  const presence = usePlanPresence({
    orgId: payload.orgId,
    planId: payload.planId,
    viewer: payload.viewer,
    view,
    selectedId,
  });
  const filtersActive =
    filters.search.trim() !== "" ||
    filters.types.length > 0 ||
    filters.statuses.length > 0 ||
    filters.criticalOnly;
  /** The same resolution, narrowed for the eye: no view ever gets a different truth. */
  const visible = useMemo<WorkspacePayload>(() => {
    if (!filtersActive) return payload;
    const needle = filters.search.trim().toLowerCase();
    const keep = new Set(
      payload.nodes
        .filter(
          (n) =>
            (needle === "" || n.title.toLowerCase().includes(needle)) &&
            (filters.types.length === 0 || filters.types.includes(n.nodeType)) &&
            (filters.statuses.length === 0 || filters.statuses.includes(n.statusCategory)) &&
            (!filters.criticalOnly || criticalIds.has(n.id)),
        )
        .map((n) => n.id),
    );
    return {
      ...payload,
      nodes: payload.nodes.filter((n) => keep.has(n.id)),
      edges: payload.edges.filter((e) => keep.has(e.sourceNodeId) && keep.has(e.targetNodeId)),
    };
  }, [payload, filters, filtersActive, criticalIds]);

  /** Actions that remember how to undo themselves (server-authoritative: undo is another action). */
  const tracked = useMemo<StudioActions>(() => {
    const before = (id: string) => payload.nodes.find((n) => n.id === id);
    return {
      ...actions,
      moveNodes: async (input) => {
        const moves = (input.moves as Array<{ nodeId: string; x: number; y: number }>) ?? [];
        const prev = moves
          .map((m) => before(m.nodeId))
          .filter((n): n is EffectiveNode => !!n)
          .map((n) => ({ nodeId: n.id, x: n.x, y: n.y }));
        const res = await actions.moveNodes(input);
        if (res.ok && prev.length > 0) {
          undoStack.current.push(() => actions.moveNodes({ planId: payload.planId, moves: prev }));
        }
        return res;
      },
      updateNode: async (input) => {
        const id = input.nodeId as string;
        const n = before(id);
        const fields = Object.keys(input).filter(
          (k) => !["nodeId", "expectedRowVersion", "scenarioId"].includes(k),
        );
        const res = await actions.updateNode(input);
        if (res.ok && n && fields.length > 0) {
          const prop: Record<string, keyof EffectiveNode> = {
            title: "title",
            description: "description",
            startDate: "startDate",
            dueDate: "dueDate",
            durationDays: "durationDays",
            priority: "priority",
            estimateOptimisticDays: "estimateOptimisticDays",
            estimatePessimisticDays: "estimatePessimisticDays",
          };
          const inverse: Record<string, unknown> = { nodeId: id };
          for (const f of fields) if (prop[f]) inverse[f] = n[prop[f]];
          if (input.scenarioId) inverse.scenarioId = input.scenarioId;
          if (Object.keys(inverse).length > 1) {
            undoStack.current.push(() => actions.updateNode(inverse));
          }
        }
        return res;
      },
      setNodeStatus: async (input) => {
        const id = input.nodeId as string;
        const n = before(id);
        const res = await actions.setNodeStatus(input);
        if (res.ok && n && n.statusCategory !== "blocked") {
          undoStack.current.push(() =>
            actions.setNodeStatus({ nodeId: id, statusCategory: n.statusCategory }),
          );
        }
        return res;
      },
    };
  }, [actions, payload]);

  const remoteSelections = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const p of presence.peers) {
      if (p.selectedId) (m[p.selectedId] ??= []).push(p.color);
    }
    return m;
  }, [presence.peers]);

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
        presence.changed();
        startTransition(() => router.refresh());
      } else {
        setNotice({
          tone: "error",
          text: res.code === "conflict" ? dict.conflict : `${dict.failed}: ${res.error}`,
        });
      }
      return res.ok;
    },
    [dict.saved, dict.failed, dict.conflict, router, presence],
  );

  const undo = useCallback(() => {
    const inverse = undoStack.current.pop();
    if (!inverse) {
      setNotice({ tone: "error", text: dict.nothingToUndo });
      return;
    }
    startTransition(async () => {
      settle(await inverse(), dict.undo);
    });
  }, [dict.nothingToUndo, dict.undo, settle]);

  const applySavedView = useCallback(
    (viewId: string) => {
      const v = payload.views.find((x) => x.id === viewId);
      if (!v) return;
      const cfg = v.config;
      if (cfg.view && (VIEWS as readonly string[]).includes(cfg.view)) setView(cfg.view);
      setFilters({
        search: cfg.filters?.search ?? "",
        types: cfg.filters?.types ?? [],
        statuses: cfg.filters?.statuses ?? [],
        criticalOnly: cfg.filters?.criticalOnly ?? false,
      });
      const target = cfg.scenarioId ?? null;
      if (target !== payload.scenarioId) openScenario(target);
    },
    [payload.views, payload.scenarioId, openScenario],
  );

  const commands = useMemo<Command[]>(
    () => [
      ...VIEWS.map((v) => ({
        id: `view:${v}`,
        label: dict.views[v] ?? v,
        hint: dict.commands,
        run: () => setView(v),
      })),
      { id: "focus", label: focus ? dict.exitFocus : dict.focus, run: () => setFocus((f) => !f) },
      { id: "undo", label: dict.undo, run: undo },
      { id: "clear", label: dict.clearFilters, run: () => setFilters(NO_FILTERS) },
      {
        id: "critical",
        label: dict.criticalOnly,
        run: () => setFilters((f) => ({ ...f, criticalOnly: !f.criticalOnly })),
      },
      { id: "scenarios", label: dict.scenario.title ?? "", run: () => setAsideTab("scenarios") },
      ...(payload.canManage
        ? [
            {
              id: "template",
              label: dict.saveAsTemplate,
              run: () =>
                startTransition(async () => {
                  const key =
                    payload.planName
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "")
                      .slice(0, 50) || "plan";
                  settle(
                    await actions.saveAsTemplate({
                      planId: payload.planId,
                      key,
                      name: payload.planName,
                    }),
                    dict.templateSaved,
                  );
                }),
            },
          ]
        : []),
    ],
    [dict, focus, undo, payload.canManage, payload.planId, payload.planName, actions, settle],
  );

  // Keyboard: Ctrl/Cmd+K palette, Ctrl/Cmd+Z undo (outside inputs), Escape leaves palette/focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z" &&
        !typing
      ) {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (focus) setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, paletteOpen, focus]);

  const pickNode = useCallback((id: string) => {
    setSelectedId(id);
    setFocusNodeId(id);
    setView("canvas");
  }, []);

  return (
    <div
      className={`flex flex-col gap-2 ${focus ? "fixed inset-0 z-40 bg-page p-2" : "h-[calc(100vh-7rem)] min-h-[32rem]"}`}
    >
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        payload={payload}
        dict={dict}
        commands={commands}
        onPick={pickNode}
      />
      <header
        className={`flex flex-wrap items-center justify-between gap-2 ${focus ? "hidden" : ""}`}
      >
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
        <PresenceStrip peers={presence.peers} label={dict.peers} />
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="min-h-9 rounded-md border border-line px-2 text-xs text-ink"
            title={dict.paletteHint}
          >
            {dict.search}
          </button>
          <button
            type="button"
            onClick={() => setFocus(true)}
            className="min-h-9 rounded-md border border-line px-2 text-xs text-ink"
          >
            {dict.focus}
          </button>
          {filtersActive ? (
            <button
              type="button"
              onClick={() => setFilters(NO_FILTERS)}
              className="min-h-9 rounded-md bg-warning-soft px-2 text-xs text-warning"
            >
              {dict.clearFilters} ({visible.nodes.length}/{payload.nodes.length})
            </button>
          ) : null}
          <SavedViewsBar
            payload={payload}
            dict={dict}
            actions={actions}
            view={view}
            filters={filters}
            onApply={applySavedView}
            settle={settle}
          />
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

      {focus ? (
        <button
          type="button"
          onClick={() => setFocus(false)}
          className="fixed end-3 top-3 z-50 min-h-9 rounded-md border border-line bg-card px-3 text-xs text-ink shadow"
        >
          {dict.exitFocus}
        </button>
      ) : null}

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
              payload={visible}
              dict={dict}
              actions={tracked}
              criticalIds={criticalIds}
              remoteSelections={remoteSelections}
              focusNodeId={focusNodeId}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "board" ? (
            <BoardView
              payload={visible}
              dict={dict}
              actions={tracked}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "gantt" ? (
            <GanttView
              payload={visible}
              dict={dict}
              actions={tracked}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
              settle={settle}
            />
          ) : view === "network" ? (
            <NetworkView
              payload={visible}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "roadmap" ? (
            <RoadmapView
              payload={visible}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "calendar" ? (
            <CalendarView
              payload={visible}
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
              payload={visible}
              dict={dict}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "world" ? (
            <ThreeView
              payload={visible}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "strategy" ? (
            <StrategyView
              payload={visible}
              dict={dict}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : view === "kpis" ? (
            <KpiView payload={payload} dict={dict} />
          ) : (
            <TableView
              payload={visible}
              dict={dict}
              criticalIds={criticalIds}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <aside
          className={`w-80 shrink-0 overflow-y-auto rounded-lg border border-line bg-card p-3 ${focus ? "hidden" : "hidden lg:block"}`}
        >
          <div className="mb-3 flex gap-1 rounded-full border border-line bg-sunken p-0.5 text-xs">
            {(["inspector", "scenarios", "review"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setAsideTab(t)}
                aria-pressed={asideTab === t}
                className={`min-h-8 flex-1 rounded-full ${
                  asideTab === t ? "bg-card font-medium text-ink shadow-sm" : "text-ink-muted"
                }`}
              >
                {t === "inspector"
                  ? dict.inspector
                  : t === "scenarios"
                    ? dict.scenario.title
                    : `${dict.review}${payload.review.findings.length ? ` (${payload.review.findings.length})` : ""}`}
              </button>
            ))}
          </div>
          {asideTab === "inspector" ? (
            <Inspector
              node={selected}
              payload={payload}
              dict={dict}
              actions={tracked}
              settle={settle}
              onClose={() => setSelectedId(null)}
            />
          ) : asideTab === "scenarios" ? (
            <ScenarioPanel
              payload={payload}
              dict={dict}
              actions={actions}
              settle={settle}
              onOpen={openScenario}
            />
          ) : (
            <ReviewPanel
              findings={payload.review.findings}
              basis={payload.review.basis}
              dict={dict}
              onOpenView={(v) => setView(v)}
              onSelect={pickNode}
              onOpenScenarios={() => setAsideTab("scenarios")}
              onLevel={() => setView("workload")}
              onSimulate={() => setAsideTab("scenarios")}
              onCaptureBaseline={() =>
                startTransition(async () => {
                  settle(
                    await actions.captureBaseline({
                      planId: payload.planId,
                      name: `${dict.baseline} ${new Date().toISOString().slice(0, 10)}`,
                    }),
                  );
                })
              }
              onNarrative={async () => {
                const res = await actions.reviewNarrative({
                  planId: payload.planId,
                  ...(payload.scenarioId ? { scenarioId: payload.scenarioId } : {}),
                  locale: payload.locale === "ar" ? "ar" : "en",
                });
                return res.ok ? res.data : { available: false, reason: res.error };
              }}
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
