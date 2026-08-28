/**
 * Agent substrate registries (H12 / A1) — the code half of the H11 contract
 * (docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md). Pure data: agent
 * identifiers, action classifications, tool definitions and per-agent tool
 * allow-lists. NOTHING here grants authority: a tool runs only when the
 * ACTING USER holds its authz action (checked with can() at run time), the
 * agent's allow-list contains it, and a handler is registered.
 *
 * A1 ships tool DEFINITIONS only (read-class overviews per domain); handlers
 * arrive with the first real capability (H13+). The registry is closed:
 * unknown agents, classes or tools are rejected by the runner.
 */
import type { Action } from "@/platform/authz";

// ── Agents (H11 §5-6) ────────────────────────────────────────────────────────
export const AGENT_IDS = [
  "executive",
  "operations",
  "project",
  "sales_crm",
  "accounting",
  "finance",
  "people_payroll",
  "inventory_purchasing",
  "planning_analytics",
  "manager", // orchestrator — same authority as the acting user, never more
] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export function isAgentId(x: string): x is AgentId {
  return (AGENT_IDS as readonly string[]).includes(x);
}

// ── Action classification (H11 §3) ───────────────────────────────────────────
export const ACTION_CLASSES = [
  "read_explain",
  "draft",
  "recommend",
  "prepare_reversible",
  "execute_after_approval",
  "prohibited",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
export function isActionClass(x: string): x is ActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(x);
}

/** Classes an agent run may request in A1. Execution stays structurally
 * unsupported until the approval subject ships; prohibited is never
 * requestable (it names what can NEVER run). */
export const A1_SUPPORTED_CLASSES: readonly ActionClass[] = ["read_explain"];

// ── Tools (read-class domain overviews; definitions only in A1) ─────────────
export type AgentToolId =
  | "read.work_overview"
  | "read.operations_overview"
  | "read.customer_overview"
  | "read.money_overview"
  | "read.supply_overview"
  | "read.people_overview"
  | "read.planning_overview";

export type AgentToolDef = {
  id: AgentToolId;
  /** The authz action the ACTING USER must hold; enforced with can(). */
  action: Action;
  classification: Extract<ActionClass, "read_explain">;
  /** Output may contain money figures — the handler must apply the same
   * role redaction as the surface it reads from (F-23). */
  sensitive: boolean;
};

export const AGENT_TOOLS: Record<AgentToolId, AgentToolDef> = {
  "read.work_overview": {
    id: "read.work_overview",
    action: "jobs.view",
    classification: "read_explain",
    sensitive: false,
  },
  "read.operations_overview": {
    id: "read.operations_overview",
    action: "reports.review",
    classification: "read_explain",
    sensitive: false,
  },
  "read.customer_overview": {
    id: "read.customer_overview",
    action: "customers.view",
    classification: "read_explain",
    sensitive: false,
  },
  "read.money_overview": {
    id: "read.money_overview",
    action: "ar.view",
    classification: "read_explain",
    sensitive: true,
  },
  "read.supply_overview": {
    id: "read.supply_overview",
    action: "po.view",
    classification: "read_explain",
    sensitive: true,
  },
  "read.people_overview": {
    id: "read.people_overview",
    action: "employees.view",
    classification: "read_explain",
    sensitive: true,
  },
  "read.planning_overview": {
    id: "read.planning_overview",
    action: "week.view",
    classification: "read_explain",
    sensitive: false,
  },
};

export function isAgentToolId(x: string): x is AgentToolId {
  return x in AGENT_TOOLS;
}

/** Per-agent tool allow-lists (H11 §5 readable domains). The manager
 * orchestrator holds the UNION of specialists — which is still bounded by
 * the acting user's permissions at run time, so it never widens authority. */
export const AGENT_TOOL_ALLOW: Record<AgentId, readonly AgentToolId[]> = {
  executive: [
    "read.work_overview",
    "read.customer_overview",
    "read.money_overview",
    "read.supply_overview",
    "read.people_overview",
    "read.planning_overview",
  ],
  operations: ["read.work_overview", "read.operations_overview", "read.supply_overview"],
  project: ["read.work_overview", "read.planning_overview"],
  sales_crm: ["read.customer_overview", "read.money_overview"],
  accounting: ["read.money_overview"],
  finance: ["read.money_overview", "read.supply_overview"],
  people_payroll: ["read.people_overview"],
  inventory_purchasing: ["read.supply_overview", "read.work_overview"],
  planning_analytics: [
    "read.work_overview",
    "read.money_overview",
    "read.planning_overview",
    "read.supply_overview",
  ],
  manager: [
    "read.work_overview",
    "read.operations_overview",
    "read.customer_overview",
    "read.money_overview",
    "read.supply_overview",
    "read.people_overview",
    "read.planning_overview",
  ],
};
