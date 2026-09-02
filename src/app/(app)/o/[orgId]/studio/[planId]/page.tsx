import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { managementStudioEnabled } from "@/platform/flags";
import {
  scheduleForPlan,
  listLinkableJobs,
  listScenarios,
  compareScenario,
  capacityForPlan,
  StudioError,
} from "@/modules/studio/service";
import { listTaskAllocations } from "@/modules/jobs/service";
import { listEmployees } from "@/modules/masters/service";
import { getDisplayName } from "@/platform/auth/identity";
import {
  addNodeAction,
  updateNodeAction,
  moveNodesAction,
  archiveNodeAction,
  addEdgeAction,
  removeEdgeAction,
  convertNodeAction,
  listJobTasksAction,
  captureBaselineAction,
  setNodeStatusAction,
  createScenarioAction,
  updateScenarioAction,
  submitScenarioAction,
  applyScenarioAction,
  discardScenarioAction,
  simulateAction,
  allocateTaskAction,
  unallocateTaskAction,
  levelAction,
} from "../actions";
import { StudioWorkspace, type StudioDict, type WorkspacePayload } from "./StudioWorkspace";

/**
 * H25 — one plan, every projection. The server resolves the living model ONCE
 * (graph + schedule) and the client projects it into whichever view is open;
 * every edit returns through the same actions and the graph is re-resolved.
 */
export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; planId: string }>;
  searchParams: Promise<{ view?: string; scenario?: string }>;
}) {
  if (!managementStudioEnabled()) notFound();
  const { orgId, planId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "studio.view")) notFound();
  const t = await getT();
  const locale = await getServerLocale();

  let plan;
  try {
    plan = await scheduleForPlan(resolved.ctx, resolved.archetype, {
      planId,
      scenarioId: sp.scenario,
    });
  } catch (err) {
    if (err instanceof StudioError && err.code === "not_found") notFound();
    throw err;
  }
  const jobs = can(resolved.archetype, "jobs.view")
    ? await listLinkableJobs(resolved.ctx, resolved.archetype, { limit: 100 })
    : [];
  // H25G — the scenario list, and the active scenario's comparison with live.
  const scenarios = await listScenarios(resolved.ctx, resolved.archetype, planId);
  let scenario = null;
  if (sp.scenario) {
    try {
      scenario = await compareScenario(resolved.ctx, resolved.archetype, sp.scenario);
    } catch (err) {
      if (err instanceof StudioError && err.code === "not_found") notFound();
      throw err;
    }
  }

  // H25H — capacity projection + who is on each linked task + who can be added.
  const capacity = await capacityForPlan(resolved.ctx, resolved.archetype, {
    planId,
    scenarioId: sp.scenario,
  });
  const taskIds = plan.graph.nodes
    .filter((n) => n.recordType === "task" && n.recordId)
    .map((n) => n.recordId!);
  const allocationRows =
    can(resolved.archetype, "tasks.view") && taskIds.length > 0
      ? await listTaskAllocations(resolved.ctx, resolved.archetype, taskIds)
      : [];
  const allocations: Record<string, typeof allocationRows> = {};
  for (const a of allocationRows) (allocations[a.taskId] ??= []).push(a);
  const people = can(resolved.archetype, "employees.view")
    ? (await listEmployees(resolved.ctx, resolved.archetype))
        .filter((e) => e.active)
        .map((e) => ({ id: e.id, name: e.name, teamName: e.teamName }))
    : [];

  const payload: WorkspacePayload = {
    orgId,
    planId,
    planName: plan.graph.planName,
    planReference: plan.graph.planReference,
    scenarioId: sp.scenario ?? null,
    nodes: plan.graph.nodes,
    edges: plan.graph.edges,
    schedule: Object.fromEntries(plan.byNode),
    criticalPaths: plan.result.criticalPaths,
    unscheduled: plan.unscheduled,
    warnings: [...plan.graph.warnings, ...plan.result.warnings],
    health: plan.result.health,
    projectStart: plan.result.projectStart,
    projectFinish: plan.result.projectFinish,
    calendar: { workingWeekdays: plan.calendar.workingWeekdays, holidays: plan.calendar.holidays },
    jobs,
    scenarios,
    scenario,
    capacity,
    allocations,
    people,
    canAllocate:
      can(resolved.archetype, "tasks.manage") && can(resolved.archetype, "employees.view"),
    viewer: { id: resolved.ctx.userId, name: await getDisplayName(resolved.ctx) },
    canManage: can(resolved.archetype, "studio.manage"),
    canSchedule: can(resolved.archetype, "studio.schedule"),
    canManageScenario: can(resolved.archetype, "scenario.manage"),
    canApplyScenario: can(resolved.archetype, "scenario.apply"),
    locale,
    initialView: sp.view ?? "canvas",
  };

  const dict: StudioDict = {
    views: {
      canvas: t("studio.view.canvas"),
      table: t("studio.view.table"),
      board: t("studio.view.board"),
      gantt: t("studio.view.gantt"),
      network: t("studio.view.network"),
      roadmap: t("studio.view.roadmap"),
      calendar: t("studio.view.calendar"),
      workload: t("studio.view.workload"),
      risk: t("studio.view.risk"),
      world: t("studio.view.world"),
    },
    add: t("studio.add"),
    shapes: t("studio.shapes"),
    linkRecord: t("studio.link_record"),
    inspector: t("studio.inspector"),
    nothingSelected: t("studio.nothing_selected"),
    title: t("studio.field.title"),
    type: t("studio.field.type"),
    status: t("studio.field.status"),
    priority: t("studio.field.priority"),
    startDate: t("studio.field.start"),
    dueDate: t("studio.field.due"),
    duration: t("studio.field.duration"),
    description: t("studio.field.description"),
    save: t("common.save"),
    remove: t("studio.remove"),
    convert: t("studio.convert"),
    convertHint: t("studio.convert_hint"),
    chooseJob: t("studio.choose_job"),
    chooseTask: t("studio.choose_task"),
    linked: t("studio.linked"),
    withheld: t("studio.withheld"),
    critical: t("studio.critical"),
    milestone: t("studio.milestone"),
    edgeType: t("studio.edge_type"),
    unscheduled: t("studio.unscheduled"),
    warnings: t("studio.warnings"),
    schedule: t("studio.schedule_summary"),
    baseline: t("studio.capture_baseline"),
    baselineName: t("studio.baseline_name"),
    saved: t("common.saved"),
    failed: t("common.error"),
    conflict: t("studio.conflict"),
    fit: t("studio.fit"),
    zoomIn: t("studio.zoom_in"),
    zoomOut: t("studio.zoom_out"),
    reason: t("studio.reason"),
    estimateOptimistic: t("studio.field.estimate_optimistic"),
    estimatePessimistic: t("studio.field.estimate_pessimistic"),
    unassigned: t("studio.workload.unassigned"),
    capacity: t("studio.workload.capacity"),
    likelihood: t("studio.risk.likelihood"),
    impact: t("studio.risk.impact"),
    unscored: t("studio.risk.unscored"),
    today: t("studio.calendar.today"),
    nothingScheduled: t("studio.nothing_scheduled"),
    peopleOnTask: t("studio.allocation.people"),
    addPerson: t("studio.allocation.add"),
    share: t("studio.allocation.share"),
    level: t("studio.level"),
    levelName: t("studio.level_name"),
    overloads: t("studio.overloads"),
    peopleWithheld: t("studio.people_withheld"),
    implicit: t("studio.allocation.implicit"),
    peers: t("studio.peers"),
    worlds: {
      city: t("studio.world.city"),
      tunnel: t("studio.world.tunnel"),
      capacity: t("studio.world.capacity"),
    },
    worldHint: t("studio.world.hint"),
    worldFallback: t("studio.world.fallback"),
    worldLoading: t("studio.world.loading"),
    scenario: Object.fromEntries(
      [
        "title",
        "live",
        "new",
        "name",
        "branch_hint",
        "active",
        "details",
        "shared",
        "status.draft",
        "status.under_review",
        "status.approved",
        "status.applied",
        "status.discarded",
        "changes",
        "no_changes",
        "drifted",
        "schedule",
        "finish_live",
        "finish_scenario",
        "delta_days",
        "no_delta",
        "assumptions",
        "assumption_add",
        "confidence.low",
        "confidence.medium",
        "confidence.high",
        "decision",
        "decision.question",
        "decision.recommendation",
        "decision.decision",
        "decision.rationale",
        "submit",
        "apply",
        "apply_hint",
        "discard",
        "awaiting",
        "simulation",
        "simulate",
        "samples",
        "seed",
        "confidence",
        "forecast_note",
        "insufficient",
        "criticality",
        "ran",
        "plan_date",
      ].map((k) => [k.replace(".", "_"), t(`studio.scenario.${k}`)]),
    ),
    nodeTypes: Object.fromEntries(
      [
        "task",
        "milestone",
        "project",
        "phase",
        "deliverable",
        "objective",
        "key_result",
        "initiative",
        "decision",
        "risk",
        "issue",
        "assumption",
        "opportunity",
        "process",
        "person",
        "team",
        "customer",
        "supplier",
        "system",
        "document",
        "database",
        "warehouse",
        "money",
        "start_end",
        "note",
        "group",
        "swimlane",
        "frame",
      ].map((k) => [k, t(`studio.type.${k}`)]),
    ),
    statuses: Object.fromEntries(
      ["planned", "ready", "active", "blocked", "waiting", "done", "dropped"].map((k) => [
        k,
        t(`studio.status.${k}`),
      ]),
    ),
    edgeTypes: Object.fromEntries(
      [
        "dependency",
        "flow",
        "approval",
        "responsibility",
        "financial",
        "material",
        "customer",
        "risk_influence",
        "contribution",
        "cause_effect",
        "reference",
      ].map((k) => [k, t(`studio.edge.${k}`)]),
    ),
  };

  return (
    <StudioWorkspace
      payload={payload}
      dict={dict}
      actions={{
        addNode: addNodeAction.bind(null, orgId),
        updateNode: updateNodeAction.bind(null, orgId),
        moveNodes: moveNodesAction.bind(null, orgId),
        archiveNode: archiveNodeAction.bind(null, orgId),
        addEdge: addEdgeAction.bind(null, orgId),
        removeEdge: removeEdgeAction.bind(null, orgId),
        convertNode: convertNodeAction.bind(null, orgId),
        listJobTasks: listJobTasksAction.bind(null, orgId),
        captureBaseline: captureBaselineAction.bind(null, orgId),
        setNodeStatus: setNodeStatusAction.bind(null, orgId),
        createScenario: createScenarioAction.bind(null, orgId),
        updateScenario: updateScenarioAction.bind(null, orgId),
        submitScenario: submitScenarioAction.bind(null, orgId),
        applyScenario: applyScenarioAction.bind(null, orgId),
        discardScenario: discardScenarioAction.bind(null, orgId),
        simulate: simulateAction.bind(null, orgId),
        allocateTask: allocateTaskAction.bind(null, orgId),
        unallocateTask: unallocateTaskAction.bind(null, orgId),
        level: levelAction.bind(null, orgId),
      }}
    />
  );
}
