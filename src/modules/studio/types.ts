/**
 * H25B — the studio's closed vocabularies and per-type data contracts.
 *
 * A visual node CARRIES SEMANTIC MEANING (mandate H25B): every node has a
 * validated node_type, every edge a validated edge_type, and type-specific
 * fields live in `data` validated by the schema registered here. Business
 * calculations read these validated types — never colors or labels.
 */
import { z } from "zod";

export const NODE_TYPES = [
  // structure & strategy
  "portfolio",
  "program",
  "objective",
  "key_result",
  "initiative",
  "project",
  "phase",
  "milestone",
  "task",
  "deliverable",
  // governance registers
  "decision",
  "assumption",
  "constraint",
  "issue",
  "risk",
  "opportunity",
  "change",
  "action",
  "lesson",
  // resources & money
  "resource_requirement",
  "budget_allocation",
  "capacity_allocation",
  "kpi",
  "outcome",
  "benefit",
  // canvas vocabulary (shape library)
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
  "custom",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
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
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const DEP_KINDS = [
  "finish_to_start",
  "start_to_start",
  "finish_to_finish",
  "start_to_finish",
] as const;
export type DepKind = (typeof DEP_KINDS)[number];

export const VIEW_KINDS = [
  "canvas",
  "board",
  "table",
  "gantt",
  "timeline",
  "calendar",
  "roadmap",
  "network",
  "critical_path",
  "workload",
  "heatmap",
  "risk_matrix",
  "cost_map",
  "strategy",
  "portfolio",
  "geo_map",
  "three_d",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/**
 * Canonical records a node may LINK. Each entry names the record's own view
 * action — a linked node never widens access (ADR-8): without that action the
 * viewer sees only that the node exists and its neutral title.
 */
export const LINKABLE_RECORDS = {
  job: { table: "job", viewAction: "jobs.view" },
  task: { table: "task", viewAction: "tasks.view" },
  employee: { table: "employee", viewAction: "employees.view" },
  team: { table: "team", viewAction: "employees.view" },
  customer: { table: "customer", viewAction: "customers.view" },
  supplier: { table: "supplier", viewAction: "catalog.view" },
  item: { table: "item", viewAction: "catalog.view" },
  warehouse: { table: "warehouse", viewAction: "inventory.view" },
  quote: { table: "quote", viewAction: "quotes.view" },
  invoice: { table: "invoice", viewAction: "invoices.view" },
  opportunity: { table: "opportunity", viewAction: "opportunities.view" },
  issue: { table: "issue", viewAction: "jobs.view" },
  week_plan: { table: "week_plan", viewAction: "week.view" },
  budget: { table: "budget", viewAction: "finance.view" },
} as const;
export type LinkableRecordType = keyof typeof LINKABLE_RECORDS;
export const LINKABLE_RECORD_TYPES = Object.keys(LINKABLE_RECORDS) as LinkableRecordType[];

// ── per-type `data` contracts (strict: unknown keys refused) ────────────────

const confidence = z.enum(["low", "medium", "high"]);
const fiveScale = z.number().int().min(1).max(5);

export const NODE_DATA_SCHEMAS: Partial<Record<NodeType, z.ZodTypeAny>> = {
  risk: z
    .object({
      likelihood: fiveScale.optional(),
      impact: fiveScale.optional(),
      proximity: z.enum(["imminent", "near", "distant"]).optional(),
      response: z.enum(["avoid", "mitigate", "transfer", "accept"]).optional(),
      trigger: z.string().max(500).optional(),
      mitigation: z.string().max(1000).optional(),
      contingency: z.string().max(1000).optional(),
      residualLikelihood: fiveScale.optional(),
      residualImpact: fiveScale.optional(),
      reviewDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
  decision: z
    .object({
      question: z.string().max(1000).optional(),
      options: z
        .array(z.object({ label: z.string().max(300), note: z.string().max(1000).optional() }))
        .max(10)
        .optional(),
      evidence: z.string().max(2000).optional(),
      recommendation: z.string().max(1000).optional(),
      participants: z.array(z.string().max(120)).max(20).optional(),
      decidedOption: z.string().max(300).optional(),
      decidedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      consequences: z.string().max(2000).optional(),
    })
    .strict(),
  assumption: z
    .object({
      confidence: confidence.optional(),
      validatedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      invalidatedReason: z.string().max(500).optional(),
    })
    .strict(),
  key_result: z
    .object({
      metric: z.string().max(200).optional(),
      unit: z.string().max(40).optional(),
      baseline: z.number().optional(),
      target: z.number().optional(),
      current: z.number().optional(),
      direction: z.enum(["up", "down"]).optional(),
    })
    .strict(),
  objective: z
    .object({
      theme: z.string().max(120).optional(),
      horizon: z.enum(["quarter", "year", "multi_year"]).optional(),
    })
    .strict(),
  resource_requirement: z
    .object({
      roleLabel: z.string().max(120).optional(),
      skillKey: z.string().max(60).optional(),
      headcount: z.number().int().min(1).max(999).optional(),
      minutesPerWeek: z.number().int().min(0).max(10080).optional(),
    })
    .strict(),
  kpi: z
    .object({
      kpiKey: z.string().max(60).optional(),
    })
    .strict(),
  change: z
    .object({
      reason: z.string().max(1000).optional(),
      approvedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
};

const GENERIC_DATA = z.object({}).catchall(z.never());

/** Validate a node's `data` for its type; unknown types get the empty shape. */
export function parseNodeData(nodeType: NodeType, data: unknown): Record<string, unknown> {
  const schema = NODE_DATA_SCHEMAS[nodeType];
  if (schema) return schema.parse(data ?? {}) as Record<string, unknown>;
  return GENERIC_DATA.parse(data ?? {}) as Record<string, unknown>;
}

/** One normalized status vocabulary every view can render. */
export const STATUS_CATEGORIES = [
  "planned",
  "ready",
  "active",
  "blocked",
  "waiting",
  "done",
  "dropped",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export function taskStatusCategory(status: string): StatusCategory {
  switch (status) {
    case "pending":
      return "planned";
    case "ready":
      return "ready";
    case "in_progress":
      return "active";
    case "blocked":
      return "blocked";
    case "awaiting_approval":
      return "waiting";
    case "completed":
      return "done";
    case "cancelled":
      return "dropped";
    default:
      return "planned";
  }
}

export function jobStatusCategory(statusCategory: string): StatusCategory {
  switch (statusCategory) {
    case "draft":
      return "planned";
    case "active":
      return "active";
    case "on_hold":
      return "blocked";
    case "done":
      return "done";
    case "cancelled":
      return "dropped";
    default:
      return "planned";
  }
}

export function draftStatusCategory(status: string): StatusCategory {
  switch (status) {
    case "proposed":
      return "planned";
    case "active":
      return "active";
    case "done":
      return "done";
    case "dropped":
      return "dropped";
    default:
      return "planned";
  }
}

export class StudioError extends Error {
  constructor(
    message: string,
    public code:
      | "not_found"
      | "invalid_state"
      | "forbidden"
      | "conflict"
      | "invalid_link"
      | "cycle" = "invalid_state",
  ) {
    super(message);
    this.name = "StudioError";
  }
}
