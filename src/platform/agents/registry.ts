/**
 * Agent substrate registries (H12 / A1, extended by H28 — ADR-53).
 *
 * The code half of the H11 contract (docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md
 * §8). Pure data: agent identifiers with governance fields, action
 * classifications, read-tool definitions and per-agent allow-lists. NOTHING
 * here grants authority: a tool runs only when the ACTING USER holds its
 * authz action (checked with can() at run time), the agent's allow-list
 * contains it, and a handler is registered. The registry is closed: unknown
 * agents, classes or tools are rejected by the runner.
 *
 * Retirement: `manager` (the H11 orchestrator) is retired and resolved to
 * `idara`; the id stays in AGENT_IDS so stored configuration keeps parsing.
 */
import type { Action } from "@/platform/authz";

// ── Agents (H11 §5-6, H28 §8) ────────────────────────────────────────────────
export const AGENT_IDS = [
  "idara", // orchestrator — the one front door; same authority as the acting user, never more
  "executive",
  "operations",
  "project",
  "sales_crm",
  "customer_success",
  "accounting",
  "finance",
  "tax",
  "people_payroll",
  "inventory_purchasing",
  "planning_analytics",
  "document_contract",
  "org_admin",
  "manager", // RETIRED (H28): resolves to idara
] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export function isAgentId(x: string): x is AgentId {
  return (AGENT_IDS as readonly string[]).includes(x);
}

export type AgentStatus = "active" | "retired";
export type AgentCapability = "read" | "draft" | "action";
export type AgentCostClass = "low" | "medium" | "high";
export type AgentSensitivity = "general" | "commercial" | "financial" | "personal";

export type AgentDef = {
  id: AgentId;
  /** Domain label used by policy restrictions (restricted_domains) and routing. */
  domain: string;
  /** Accountable owner inside IdaraWorks and the version of this definition. */
  owner: string;
  version: number;
  /** Prompt file under src/platform/ai/prompts (reviewed like code). */
  promptFile: string;
  purposeKey: string;
  knowledgeDomains: readonly string[];
  capability: AgentCapability;
  requiredActions: readonly Action[];
  approvalRule: "none" | "material_actions_via_approval_engine" | "never_executes";
  costClass: AgentCostClass;
  sensitivity: AgentSensitivity;
  defaultEnabled: boolean;
  evalVersion: string;
  status: AgentStatus;
  replacedBy: AgentId | null;
  changeHistory: readonly string[];
};

function def(d: AgentDef): AgentDef {
  return d;
}

export const AGENT_DEFS: Record<AgentId, AgentDef> = {
  idara: def({
    id: "idara",
    domain: "general",
    owner: "platform",
    version: 1,
    promptFile: "idara.md",
    purposeKey: "idara.agents.idara.purpose",
    knowledgeDomains: ["all_permitted"],
    capability: "action",
    requiredActions: [],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "general",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H28: created as the orchestrator, replacing manager"],
  }),
  executive: def({
    id: "executive",
    domain: "executive",
    owner: "platform",
    version: 2,
    promptFile: "executive.md",
    purposeKey: "idara.agents.executive.purpose",
    knowledgeDomains: ["work", "money", "customers", "supply", "people", "planning", "documents"],
    capability: "draft",
    requiredActions: ["today.view"],
    approvalRule: "never_executes",
    costClass: "high",
    sensitivity: "financial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H12: defined", "H28: briefing, cross-domain risks and scenario questions"],
  }),
  operations: def({
    id: "operations",
    domain: "operations",
    owner: "platform",
    version: 2,
    promptFile: "operations.md",
    purposeKey: "idara.agents.operations.purpose",
    knowledgeDomains: ["work", "reports", "issues", "attendance", "supply"],
    capability: "action",
    requiredActions: ["jobs.view"],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "general",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H12: defined", "H28: delivery signals with the inventory agent"],
  }),
  project: def({
    id: "project",
    domain: "project",
    owner: "platform",
    version: 2,
    promptFile: "project.md",
    purposeKey: "idara.agents.project.purpose",
    knowledgeDomains: ["work", "tasks", "capacity", "planning"],
    capability: "action",
    requiredActions: ["jobs.view"],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "general",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: Project and Planning (schedule risks, critical path, resource conflicts)",
    ],
  }),
  sales_crm: def({
    id: "sales_crm",
    domain: "sales",
    owner: "platform",
    version: 2,
    promptFile: "sales.md",
    purposeKey: "idara.agents.sales_crm.purpose",
    knowledgeDomains: ["customers", "leads", "opportunities", "quotes", "forecast"],
    capability: "action",
    requiredActions: ["customers.view"],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "commercial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: Sales and Revenue (account summaries, meeting briefs, follow-up drafts)",
    ],
  }),
  customer_success: def({
    id: "customer_success",
    domain: "customer_success",
    owner: "platform",
    version: 1,
    promptFile: "customer-success.md",
    purposeKey: "idara.agents.customer_success.purpose",
    knowledgeDomains: ["customers", "health", "renewals", "invoices", "documents"],
    capability: "draft",
    requiredActions: ["customers.view"],
    approvalRule: "never_executes",
    costClass: "medium",
    sensitivity: "commercial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H28: created"],
  }),
  accounting: def({
    id: "accounting",
    domain: "finance",
    owner: "platform",
    version: 2,
    promptFile: "accounting.md",
    purposeKey: "idara.agents.accounting.purpose",
    knowledgeDomains: ["ledger", "receivables", "payables", "periods"],
    capability: "draft",
    requiredActions: ["finance.view"],
    approvalRule: "never_executes",
    costClass: "high",
    sensitivity: "financial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: explains balances, drafts journals and reconciliations, never posts",
    ],
  }),
  finance: def({
    id: "finance",
    domain: "finance",
    owner: "platform",
    version: 2,
    promptFile: "finance.md",
    purposeKey: "idara.agents.finance.purpose",
    knowledgeDomains: ["cash", "budgets", "variances", "forecast"],
    capability: "draft",
    requiredActions: ["finance.view"],
    approvalRule: "never_executes",
    costClass: "high",
    sensitivity: "financial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H12: defined", "H28: variance explanations traced to entries"],
  }),
  tax: def({
    id: "tax",
    domain: "tax",
    owner: "platform",
    version: 1,
    promptFile: "tax.md",
    purposeKey: "idara.agents.tax.purpose",
    knowledgeDomains: ["tax_returns", "tax_pack", "working_papers"],
    capability: "read",
    requiredActions: ["finance.view"],
    approvalRule: "never_executes",
    costClass: "high",
    sensitivity: "financial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H28: created; explains configured calculations, cites the pack version, never files",
    ],
  }),
  people_payroll: def({
    id: "people_payroll",
    domain: "hr_payroll",
    owner: "platform",
    version: 2,
    promptFile: "hr-payroll.md",
    purposeKey: "idara.agents.people_payroll.purpose",
    knowledgeDomains: ["employees", "leave", "attendance", "payroll"],
    capability: "draft",
    requiredActions: ["employees.view"],
    approvalRule: "never_executes",
    costClass: "medium",
    sensitivity: "personal",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: HR and Payroll (policies, calculations within permission, drafts)",
    ],
  }),
  inventory_purchasing: def({
    id: "inventory_purchasing",
    domain: "operations",
    owner: "platform",
    version: 2,
    promptFile: "inventory.md",
    purposeKey: "idara.agents.inventory_purchasing.purpose",
    knowledgeDomains: [
      "items",
      "stock",
      "material_requests",
      "purchase_orders",
      "suppliers",
      "receipts",
    ],
    capability: "action",
    requiredActions: ["po.view"],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "commercial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: Inventory and Purchasing (movements, reorder, lots, proposals)",
    ],
  }),
  planning_analytics: def({
    id: "planning_analytics",
    domain: "reporting",
    owner: "platform",
    version: 2,
    promptFile: "data-reporting.md",
    purposeKey: "idara.agents.planning_analytics.purpose",
    knowledgeDomains: ["reports", "exports", "aggregates"],
    capability: "draft",
    requiredActions: ["today.view"],
    approvalRule: "never_executes",
    costClass: "medium",
    sensitivity: "financial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H12: defined",
      "H28: Data and Reporting (explains numbers, builds comparisons and tables)",
    ],
  }),
  document_contract: def({
    id: "document_contract",
    domain: "documents",
    owner: "platform",
    version: 1,
    promptFile: "document-contract.md",
    purposeKey: "idara.agents.document_contract.purpose",
    knowledgeDomains: ["documents", "clauses", "obligations", "signatures"],
    capability: "draft",
    requiredActions: ["documents.view"],
    approvalRule: "never_executes",
    costClass: "medium",
    sensitivity: "commercial",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: [
      "H28: created; summarises, compares, cites clauses, drafts amendments, never signs",
    ],
  }),
  org_admin: def({
    id: "org_admin",
    domain: "administration",
    owner: "platform",
    version: 1,
    promptFile: "org-admin.md",
    purposeKey: "idara.agents.org_admin.purpose",
    knowledgeDomains: ["configuration", "members", "entitlements", "usage"],
    capability: "read",
    requiredActions: ["config.view"],
    approvalRule: "never_executes",
    costClass: "low",
    sensitivity: "general",
    defaultEnabled: true,
    evalVersion: "v1",
    status: "active",
    replacedBy: null,
    changeHistory: ["H28: created; explains configuration and usage, never changes permissions"],
  }),
  manager: def({
    id: "manager",
    domain: "general",
    owner: "platform",
    version: 1,
    promptFile: "idara.md",
    purposeKey: "idara.agents.idara.purpose",
    knowledgeDomains: ["all_permitted"],
    capability: "action",
    requiredActions: [],
    approvalRule: "material_actions_via_approval_engine",
    costClass: "medium",
    sensitivity: "general",
    defaultEnabled: false,
    evalVersion: "v1",
    status: "retired",
    replacedBy: "idara",
    changeHistory: ["H12: defined as the orchestrator", "H28: retired, replaced by idara"],
  }),
};

/** Active agent ids (the runtime registry); retired ids resolve through resolveAgentId. */
export const ACTIVE_AGENT_IDS: readonly AgentId[] = AGENT_IDS.filter(
  (id) => AGENT_DEFS[id].status === "active",
);

/** Resolve a retired id to its replacement (one hop; the registry is reviewed to stay acyclic). */
export function resolveAgentId(id: AgentId): AgentId {
  const d = AGENT_DEFS[id];
  return d.status === "retired" && d.replacedBy ? d.replacedBy : id;
}

/** The H13 public showcase keeps the ten canonical H11 agents until the Owner
 * refreshes public copy and portraits (recorded divergence, phase2/14 §7). */
export const SHOWCASE_AGENT_IDS = [
  "executive",
  "operations",
  "project",
  "sales_crm",
  "accounting",
  "finance",
  "people_payroll",
  "inventory_purchasing",
  "planning_analytics",
  "manager",
] as const satisfies readonly AgentId[];
export type ShowcaseAgentId = (typeof SHOWCASE_AGENT_IDS)[number];

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

/** Classes the H12 runner may request. Execution stays structurally
 * unsupported there; the H28 run engine implements the risk-class model
 * (docs/H28-TRUTH-MAP.md ADR-57) with previews and confirmations. */
export const A1_SUPPORTED_CLASSES: readonly ActionClass[] = ["read_explain"];

// ── Tools (read-class domain overviews; definitions only in A1) ─────────────
export type AgentToolId =
  | "read.work_overview"
  | "read.operations_overview"
  | "read.customer_overview"
  | "read.money_overview"
  | "read.supply_overview"
  | "read.people_overview"
  | "read.planning_overview"
  | "read.document_text";

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
  "read.document_text": {
    id: "read.document_text",
    action: "documents.view",
    classification: "read_explain",
    sensitive: false,
  },
};

export function isAgentToolId(x: string): x is AgentToolId {
  return x in AGENT_TOOLS;
}

const ALL_TOOLS: readonly AgentToolId[] = [
  "read.document_text",
  "read.work_overview",
  "read.operations_overview",
  "read.customer_overview",
  "read.money_overview",
  "read.supply_overview",
  "read.people_overview",
  "read.planning_overview",
];

/** Per-agent read-tool allow-lists (H11 §5 readable domains). The orchestrator
 * holds the UNION of specialists — still bounded by the acting user's
 * permissions at run time, so it never widens authority. */
export const AGENT_TOOL_ALLOW: Record<AgentId, readonly AgentToolId[]> = {
  idara: ALL_TOOLS,
  executive: [
    "read.document_text",
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
  customer_success: ["read.customer_overview", "read.money_overview", "read.document_text"],
  accounting: ["read.money_overview"],
  finance: ["read.money_overview", "read.supply_overview"],
  tax: ["read.money_overview"],
  people_payroll: ["read.people_overview"],
  inventory_purchasing: ["read.supply_overview", "read.work_overview"],
  planning_analytics: [
    "read.work_overview",
    "read.money_overview",
    "read.planning_overview",
    "read.supply_overview",
  ],
  document_contract: ["read.document_text", "read.customer_overview"],
  org_admin: [],
  manager: ALL_TOOLS,
};
