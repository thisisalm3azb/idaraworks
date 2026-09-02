import { notFound, redirect } from "next/navigation";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { can } from "@/platform/authz";
import { managementStudioEnabled } from "@/platform/flags";
import { scheduleForPlan, listLinkableJobs, StudioError } from "@/modules/studio/service";
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
    jobs,
    canManage: can(resolved.archetype, "studio.manage"),
    canSchedule: can(resolved.archetype, "studio.schedule"),
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
      }}
    />
  );
}
