/**
 * H28 — the closed tool registry (ADR-57).
 *
 * Every tool names the domain action the ACTING PERSON must hold, its risk
 * class, the agents that may use it and a strict input schema. Read tools
 * (class 1) call the owning module's door and return redacted, bounded data
 * plus the record references that ground citations. Reversible (3) and
 * material (4) tools build a preview and execute ONLY through the owning
 * service after a confirmed, re-checked action; material tools also ride the
 * approval engine. Restricted tools (5) have no handler by construction.
 *
 * The model never sees a database: it sees this registry's descriptions and
 * schemas, and the runtime enforces allow-list ∩ can() ∩ class policy.
 */
import { z } from "zod";
import { AGENT_DEFS, type AgentId } from "@/platform/agents/registry";
import { assertCan, can, type Action } from "@/platform/authz";
import { resolveEntitlements } from "@/platform/entitlements";
import { listMembers } from "@/platform/auth/identity";
import { listConfigRevisions } from "@/platform/config";
import { listUsage, resolveAiPolicy, allowanceStatus } from "@/platform/ai";
import type { Locale } from "@/platform/i18n";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import {
  boardPage,
  computeForecast,
  gatherCustomer360,
  gatherDealRoom,
  gatherRevenue360,
  getOpportunityCommercial,
  listCustomerTimeline,
  listLeads,
  listOpportunities,
  logActivity,
  moveStage,
  myCommercialQueue,
  salesOverview,
  successOverview,
} from "@/modules/crm/service";
import {
  createTask,
  getJobDetail,
  getWeekView,
  listJobs,
  listStages,
} from "@/modules/jobs/service";
import { portfolioSummary, reviewPlan, scheduleForPlan } from "@/modules/studio/service";
import {
  arAgeing,
  balanceSheet,
  budgetVsActual,
  cashPosition,
  journalEntryDetail,
  listTaxReturns,
  profitAndLoss,
  trialBalance,
  AE_VAT_PACK_VERSION,
  AE_CT_PACK_VERSION,
} from "@/modules/finance/service";
import { hrAttentionFeed, leaveBalances } from "@/modules/hr/service";
import { getPayRun, listPayRuns } from "@/modules/payroll/service";
import {
  attentionFeed as inventoryAttention,
  listMovements,
  listStockLevels,
} from "@/modules/inventory/service";
import { documentClauses, getDocument, listDocuments } from "@/modules/docstudio/service";
import { listOpenExceptions } from "@/modules/exceptions/service";
import type { ActionPreview, OutputBlock, RecordRef, RecordVersion, ToolRiskClass } from "../types";

export type ToolContext = {
  ctx: Ctx;
  archetype: RoleArchetype;
  locale: Locale;
  runId: string;
  conversationId: string | null;
  /** Stable per (run, tool call) so a retried execution never repeats a write. */
  idempotencyKey: string;
};

export type ToolResult = {
  records: RecordRef[];
  /** JSON-safe, already redacted by the owning service's own privilege walls. */
  data: unknown;
  summary: string;
  blocks?: OutputBlock[];
  /** Contact details are needed by the caller (drafting a follow-up). */
  keepContacts?: boolean;
};

export type ActionExecuteResult = { records: RecordRef[]; result: unknown; summary: string };

export class DriftError extends Error {
  readonly drifted: RecordVersion[];
  constructor(drifted: RecordVersion[]) {
    super("the records changed since the preview was built");
    this.drifted = drifted;
  }
}

export type ToolDef<I = unknown> = {
  id: string;
  titleKey: string;
  /** Model-facing description (trusted text, no data). */
  description: string;
  agentIds: readonly AgentId[];
  riskClass: ToolRiskClass;
  /** The action the acting person must hold; null only for tools that read nothing tenant-owned. */
  action: Action | null;
  sensitive: boolean;
  reversible: boolean;
  externalCommunication: boolean;
  input: z.ZodType<I>;
  run?: (tc: ToolContext, input: I) => Promise<ToolResult>;
  preview?: (
    tc: ToolContext,
    input: I,
  ) => Promise<{ title: string; preview: ActionPreview; versions: RecordVersion[] }>;
  execute?: (tc: ToolContext, input: I, expected: RecordVersion[]) => Promise<ActionExecuteResult>;
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const today = () => new Date().toISOString().slice(0, 10);

function ref(type: string, id: string, label?: string): RecordRef {
  return label ? { type, id, label } : { type, id };
}

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

const ALL_SPECIALISTS: readonly AgentId[] = [
  "idara",
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
];

// ── Class 1: read tools ─────────────────────────────────────────────────────

const readTools: ToolDef[] = [
  tool({
    id: "customer.overview",
    titleKey: "idara.tools.customer_overview",
    description:
      "The 360 view of one customer: identity, work, money, documents, health signals and recent timeline.",
    agentIds: [
      "idara",
      "executive",
      "sales_crm",
      "customer_success",
      "document_contract",
      "planning_analytics",
    ],
    riskClass: 1,
    action: "customers.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ customerId: uuid }),
    run: async (tc, input) => {
      const c360 = await gatherCustomer360(tc.ctx, tc.archetype, input.customerId, {
        asOf: today(),
      });
      if (!c360) return { records: [], data: null, summary: "customer not found" };
      const revenue = await gatherRevenue360(tc.ctx, tc.archetype, input.customerId);
      const timeline = await listCustomerTimeline(tc.ctx, tc.archetype, input.customerId, {
        limit: 20,
      });
      const name = (c360 as { customer?: { name?: string } }).customer?.name ?? "customer";
      return {
        records: [ref("customer", input.customerId, name)],
        data: { customer360: c360, revenue360: revenue, timeline },
        summary: `Customer ${name}: 360 view, revenue view and the last ${timeline.length} timeline events.`,
        keepContacts: true,
      };
    },
  }),
  tool({
    id: "customer.success_overview",
    titleKey: "idara.tools.customer_success_overview",
    description:
      "Customer health and retention overview across the organisation: bands, counts and the customers most at risk.",
    agentIds: ["idara", "executive", "customer_success", "sales_crm"],
    riskClass: 1,
    action: "customers.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ band: z.enum(["healthy", "watch", "at_risk"]).optional() }),
    run: async (tc, input) => {
      const o = await successOverview(tc.ctx, tc.archetype, {
        band: input.band,
        limit: 25,
        offset: 0,
      });
      const rows =
        (o as { rows?: Array<{ customerId?: string; id?: string; name?: string }> }).rows ?? [];
      return {
        records: rows
          .slice(0, 25)
          .map((r) => ref("customer", String(r.customerId ?? r.id), r.name)),
        data: o,
        summary: `Success overview: ${rows.length} customers in the first page.`,
      };
    },
  }),
  tool({
    id: "opportunity.overview",
    titleKey: "idara.tools.opportunity_overview",
    description:
      "One opportunity: stage, value, forecast category, products, stakeholders, risks and history.",
    agentIds: ["idara", "executive", "sales_crm", "customer_success", "planning_analytics"],
    riskClass: 1,
    action: "opportunities.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ opportunityId: uuid }),
    run: async (tc, input) => {
      const commercial = await getOpportunityCommercial(tc.ctx, tc.archetype, input.opportunityId);
      if (!commercial) return { records: [], data: null, summary: "opportunity not found" };
      const room = await gatherDealRoom(tc.ctx, tc.archetype, input.opportunityId);
      const name = (commercial as { name?: string }).name ?? "opportunity";
      return {
        records: [ref("opportunity", input.opportunityId, name)],
        data: { commercial, dealRoom: room },
        summary: `Opportunity ${name}: commercial view and deal room.`,
      };
    },
  }),
  tool({
    id: "pipeline.summary",
    titleKey: "idara.tools.pipeline_summary",
    description:
      "Pipeline board totals by stage for the default pipeline (counts and, when permitted, values).",
    agentIds: ["idara", "executive", "sales_crm", "planning_analytics"],
    riskClass: 1,
    action: "opportunities.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const page = await boardPage(tc.ctx, tc.archetype, { limit: 20, offset: 0 });
      return { records: [], data: page, summary: "Pipeline board totals by stage." };
    },
  }),
  tool({
    id: "sales.forecast",
    titleKey: "idara.tools.sales_forecast",
    description: "The deterministic sales forecast with its named model and monthly buckets.",
    agentIds: ["idara", "executive", "sales_crm", "finance", "planning_analytics"],
    riskClass: 1,
    action: "crm.forecast.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const f = await computeForecast(tc.ctx, tc.archetype, {});
      return { records: [], data: f, summary: "Forecast computed from open opportunities." };
    },
  }),
  tool({
    id: "sales.my_queue",
    titleKey: "idara.tools.sales_my_queue",
    description: "The signed-in person's commercial queue: overdue, today and upcoming follow-ups.",
    agentIds: ["idara", "sales_crm", "customer_success"],
    riskClass: 1,
    action: "customers.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const q = await myCommercialQueue(tc.ctx, tc.archetype, today());
      const recs = [...q.overdue, ...q.today, ...q.upcoming]
        .slice(0, 30)
        .map((a) =>
          ref(
            "activity",
            String((a as { id: string }).id),
            (a as { title?: string | null }).title ?? undefined,
          ),
        );
      return {
        records: recs,
        data: q,
        summary: `Queue: ${q.overdue.length} overdue, ${q.today.length} today, ${q.upcoming.length} upcoming.`,
      };
    },
  }),
  tool({
    id: "sales.overview",
    titleKey: "idara.tools.sales_overview",
    description:
      "Sales overview for a period: pipeline movement, wins, losses and activity counts.",
    agentIds: ["idara", "executive", "sales_crm", "planning_analytics"],
    riskClass: 1,
    action: "opportunities.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    run: async (tc, input) => {
      const o = await salesOverview(tc.ctx, tc.archetype, { asOf: today(), days: input.days });
      return { records: [], data: o, summary: `Sales overview over ${input.days} days.` };
    },
  }),
  tool({
    id: "leads.list",
    titleKey: "idara.tools.leads_list",
    description: "Leads matching a status or search, newest first (bounded page).",
    agentIds: ["idara", "sales_crm"],
    riskClass: 1,
    action: "leads.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({
      q: z.string().max(80).optional(),
      status: z.enum(["new", "contacted", "qualified", "converted", "lost", "all"]).optional(),
    }),
    run: async (tc, input) => {
      const rows = await listLeads(tc.ctx, tc.archetype, {
        q: input.q,
        status: (input.status ?? "all") as never,
        limit: 50,
      });
      return {
        records: rows.map((r) =>
          ref("lead", String((r as { id: string }).id), (r as { name?: string }).name),
        ),
        data: rows,
        summary: `${rows.length} leads.`,
        keepContacts: true,
      };
    },
  }),
  tool({
    id: "opportunities.list",
    titleKey: "idara.tools.opportunities_list",
    description: "Open, won or lost opportunities, optionally for one customer (bounded page).",
    agentIds: ["idara", "executive", "sales_crm", "customer_success", "planning_analytics"],
    riskClass: 1,
    action: "opportunities.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({
      status: z.enum(["open", "won", "lost", "all"]).default("open"),
      customerId: uuid.optional(),
    }),
    run: async (tc, input) => {
      const rows = await listOpportunities(tc.ctx, tc.archetype, {
        status: input.status,
        customerId: input.customerId,
        limit: 50,
      });
      return {
        records: rows.map((r) =>
          ref("opportunity", String((r as { id: string }).id), (r as { name?: string }).name),
        ),
        data: rows,
        summary: `${rows.length} opportunities (${input.status}).`,
      };
    },
  }),
  tool({
    id: "work.list",
    titleKey: "idara.tools.work_list",
    description:
      "Work items (projects) matching a search, with status and progress (bounded page).",
    agentIds: [
      "idara",
      "executive",
      "operations",
      "project",
      "customer_success",
      "planning_analytics",
      "inventory_purchasing",
    ],
    riskClass: 1,
    action: "jobs.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ search: z.string().max(80).optional(), customerId: uuid.optional() }),
    run: async (tc, input) => {
      const rows = await listJobs(tc.ctx, tc.archetype, {
        search: input.search,
        customerId: input.customerId,
        limit: 50,
      } as never);
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      return {
        records: (list as Array<{ id: string; reference?: string; name?: string }>).map((r) =>
          ref("job", r.id, r.reference ?? r.name),
        ),
        data: rows,
        summary: `${list.length} work items.`,
      };
    },
  }),
  tool({
    id: "work.detail",
    titleKey: "idara.tools.work_detail",
    description: "One work item in detail with its stages and progress.",
    agentIds: [
      "idara",
      "executive",
      "operations",
      "project",
      "customer_success",
      "inventory_purchasing",
    ],
    riskClass: 1,
    action: "jobs.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ jobId: uuid }),
    run: async (tc, input) => {
      const detail = await getJobDetail(tc.ctx, tc.archetype, input.jobId);
      if (!detail) return { records: [], data: null, summary: "work item not found" };
      const stages = await listStages(tc.ctx, input.jobId);
      const label =
        (detail as { reference?: string; name?: string }).reference ??
        (detail as { name?: string }).name;
      return {
        records: [ref("job", input.jobId, label)],
        data: { detail, stages },
        summary: `Work item ${label ?? ""} with ${stages.length} stages.`,
      };
    },
  }),
  tool({
    id: "work.week",
    titleKey: "idara.tools.work_week",
    description:
      "The weekly view of work: what is planned per day for the week that contains a date.",
    agentIds: ["idara", "operations", "project", "planning_analytics"],
    riskClass: 1,
    action: "week.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ weekStart: isoDate.optional() }),
    run: async (tc, input) => {
      const w = await getWeekView(tc.ctx, tc.archetype, { weekStart: input.weekStart ?? today() });
      return {
        records: w.jobs.map((j) => ref("job", String((j as { id: string }).id))),
        data: w,
        summary: `Week ${w.weekStart} to ${w.weekEnd}: ${w.jobs.length} work items.`,
      };
    },
  }),
  tool({
    id: "plans.portfolio",
    titleKey: "idara.tools.plans_portfolio",
    description:
      "The Management Studio portfolio: every plan with its schedule health and key dates.",
    agentIds: ["idara", "executive", "project", "planning_analytics"],
    riskClass: 1,
    action: "studio.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const p = await portfolioSummary(tc.ctx, tc.archetype);
      return {
        records: p.rows.map((r) =>
          ref(
            "studio_plan",
            String((r as { planId?: string; id?: string }).planId ?? (r as { id?: string }).id),
          ),
        ),
        data: p,
        summary: `${p.rows.length} plans in the portfolio.`,
      };
    },
  }),
  tool({
    id: "plans.schedule",
    titleKey: "idara.tools.plans_schedule",
    description: "The computed schedule of one plan: critical path, slack, dates and risks.",
    agentIds: ["idara", "executive", "project"],
    riskClass: 1,
    action: "studio.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ planId: uuid }),
    run: async (tc, input) => {
      const s = await scheduleForPlan(tc.ctx, tc.archetype, { planId: input.planId });
      return {
        records: [ref("studio_plan", input.planId)],
        data: s,
        summary: "Plan schedule computed.",
      };
    },
  }),
  tool({
    id: "plans.review",
    titleKey: "idara.tools.plans_review",
    description:
      "Deterministic review findings for one plan (schedule, capacity and dependency risks) with their basis.",
    agentIds: ["idara", "executive", "project"],
    riskClass: 1,
    action: "studio.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ planId: uuid }),
    run: async (tc, input) => {
      const r = await reviewPlan(tc.ctx, tc.archetype, { planId: input.planId });
      return {
        records: [ref("studio_plan", input.planId)],
        data: r,
        summary: `${r.findings.length} findings.`,
      };
    },
  }),
  tool({
    id: "finance.trial_balance",
    titleKey: "idara.tools.finance_trial_balance",
    description: "The trial balance for a period (debits and credits by account).",
    agentIds: ["idara", "executive", "accounting", "finance", "tax", "planning_analytics"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
    run: async (tc, input) => {
      const tb = await trialBalance(tc.ctx, tc.archetype, { from: input.from, to: input.to });
      return {
        records: tb.rows
          .slice(0, 200)
          .map((r) =>
            ref(
              "gl_account",
              String(
                (r as { accountId?: string; id?: string }).accountId ??
                  (r as { id?: string }).id ??
                  "",
              ),
            ),
          )
          .filter((r) => r.id),
        data: tb,
        summary: `Trial balance with ${tb.rows.length} accounts.`,
      };
    },
  }),
  tool({
    id: "finance.profit_and_loss",
    titleKey: "idara.tools.finance_profit_and_loss",
    description: "The profit and loss statement for a date range.",
    agentIds: ["idara", "executive", "accounting", "finance", "planning_analytics"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ from: isoDate, to: isoDate }),
    run: async (tc, input) => {
      const pl = await profitAndLoss(tc.ctx, tc.archetype, { from: input.from, to: input.to });
      return { records: [], data: pl, summary: `Profit and loss ${pl.from} to ${pl.to}.` };
    },
  }),
  tool({
    id: "finance.balance_sheet",
    titleKey: "idara.tools.finance_balance_sheet",
    description: "The balance sheet as of a date.",
    agentIds: ["idara", "executive", "accounting", "finance", "planning_analytics"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ asOf: isoDate.optional() }),
    run: async (tc, input) => {
      const bs = await balanceSheet(tc.ctx, tc.archetype, { asOf: input.asOf ?? today() });
      return { records: [], data: bs, summary: `Balance sheet as of ${bs.asOf}.` };
    },
  }),
  tool({
    id: "finance.cash_position",
    titleKey: "idara.tools.finance_cash_position",
    description: "Cash position per bank account.",
    agentIds: ["idara", "executive", "accounting", "finance"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const rows = await cashPosition(tc.ctx, tc.archetype);
      return {
        records: rows.map((r) => ref("bank_account", r.bankAccountId, r.name)),
        data: rows,
        summary: `${rows.length} bank accounts.`,
      };
    },
  }),
  tool({
    id: "finance.ar_ageing",
    titleKey: "idara.tools.finance_ar_ageing",
    description: "Receivables ageing buckets as of a date.",
    agentIds: ["idara", "executive", "accounting", "finance", "customer_success", "sales_crm"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ asOf: isoDate.optional() }),
    run: async (tc, input) => {
      const a = await arAgeing(tc.ctx, tc.archetype, { asOf: input.asOf });
      return {
        records: [],
        data: a,
        summary: `Receivables ageing in ${a.buckets.length} buckets.`,
      };
    },
  }),
  tool({
    id: "finance.budget_vs_actual",
    titleKey: "idara.tools.finance_budget_vs_actual",
    description: "Budget versus actual rows for one budget.",
    agentIds: ["idara", "executive", "finance", "planning_analytics"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ budgetId: uuid }),
    run: async (tc, input) => {
      const rows = await budgetVsActual(tc.ctx, tc.archetype, input.budgetId);
      return {
        records: [ref("budget", input.budgetId)],
        data: rows,
        summary: `${rows.length} budget lines.`,
      };
    },
  }),
  tool({
    id: "finance.journal_entry",
    titleKey: "idara.tools.finance_journal_entry",
    description: "One journal entry with its lines (tracing a number to its entry).",
    agentIds: ["idara", "accounting", "finance", "tax"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ entryId: uuid }),
    run: async (tc, input) => {
      const e = await journalEntryDetail(tc.ctx, tc.archetype, input.entryId);
      return {
        records: [ref("journal_entry", input.entryId, e.entryNo)],
        data: e,
        summary: `Journal entry ${e.entryNo}.`,
      };
    },
  }),
  tool({
    id: "tax.returns",
    titleKey: "idara.tools.tax_returns",
    description: "Tax returns with their status, period and the active tax pack versions.",
    agentIds: ["idara", "executive", "tax", "accounting", "finance"],
    riskClass: 1,
    action: "finance.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const rows = await listTaxReturns(tc.ctx, tc.archetype);
      return {
        records: rows.map((r) =>
          ref(
            "tax_return",
            String((r as { id: string }).id),
            (r as { reference?: string }).reference,
          ),
        ),
        data: { returns: rows, packs: { vat: AE_VAT_PACK_VERSION, corporate: AE_CT_PACK_VERSION } },
        summary: `${rows.length} tax returns; packs ${AE_VAT_PACK_VERSION}, ${AE_CT_PACK_VERSION}.`,
      };
    },
  }),
  tool({
    id: "hr.attention",
    titleKey: "idara.tools.hr_attention",
    description:
      "People matters needing attention: probation ends, document expiries, pending requests.",
    agentIds: ["idara", "executive", "people_payroll"],
    riskClass: 1,
    action: "employees.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ withinDays: z.number().int().min(1).max(365).default(30) }),
    run: async (tc, input) => {
      const feed = await hrAttentionFeed(tc.ctx, tc.archetype, { withinDays: input.withinDays });
      return { records: [], data: feed, summary: `HR attention within ${input.withinDays} days.` };
    },
  }),
  tool({
    id: "hr.leave_balances",
    titleKey: "idara.tools.hr_leave_balances",
    description: "Leave balances for one employee.",
    agentIds: ["idara", "people_payroll"],
    riskClass: 1,
    action: "employees.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ employeeId: uuid }),
    run: async (tc, input) => {
      const b = await leaveBalances(tc.ctx, tc.archetype, input.employeeId);
      return {
        records: [ref("employee", input.employeeId)],
        data: b,
        summary: `${b.length} leave balances.`,
      };
    },
  }),
  tool({
    id: "payroll.runs",
    titleKey: "idara.tools.payroll_runs",
    description: "Recent payroll runs with their state (amounts only with cost privilege).",
    agentIds: ["idara", "executive", "people_payroll", "finance"],
    riskClass: 1,
    action: "payroll.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const rows = await listPayRuns(tc.ctx, tc.archetype, { limit: 24 });
      return {
        records: rows.map((r) =>
          ref("pay_run", String((r as { id: string }).id), (r as { reference?: string }).reference),
        ),
        data: rows,
        summary: `${rows.length} pay runs.`,
      };
    },
  }),
  tool({
    id: "payroll.run",
    titleKey: "idara.tools.payroll_run",
    description: "One payroll run in detail (requires cost privilege).",
    agentIds: ["idara", "people_payroll", "finance"],
    riskClass: 1,
    action: "payroll.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ runId: uuid }),
    run: async (tc, input) => {
      const r = await getPayRun(tc.ctx, tc.archetype, input.runId);
      if (!r) return { records: [], data: null, summary: "pay run not found" };
      return { records: [ref("pay_run", input.runId)], data: r, summary: "Pay run detail." };
    },
  }),
  tool({
    id: "inventory.stock_levels",
    titleKey: "idara.tools.inventory_stock_levels",
    description: "Stock levels by item and location, optionally only low stock.",
    agentIds: ["idara", "executive", "operations", "inventory_purchasing", "planning_analytics"],
    riskClass: 1,
    action: "inventory.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ search: z.string().max(80).optional(), lowOnly: z.boolean().default(false) }),
    run: async (tc, input) => {
      const page = await listStockLevels(tc.ctx, tc.archetype, {
        search: input.search,
        lowOnly: input.lowOnly,
        limit: 50,
      });
      const rows = (page as { rows?: Array<{ itemId?: string; itemName?: string }> }).rows ?? [];
      return {
        records: rows.filter((r) => r.itemId).map((r) => ref("item", String(r.itemId), r.itemName)),
        data: page,
        summary: `${rows.length} stock rows.`,
      };
    },
  }),
  tool({
    id: "inventory.attention",
    titleKey: "idara.tools.inventory_attention",
    description: "Stock matters needing attention: reorder points reached, expiries, due services.",
    agentIds: ["idara", "executive", "operations", "inventory_purchasing"],
    riskClass: 1,
    action: "inventory.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ withinDays: z.number().int().min(1).max(365).default(30) }),
    run: async (tc, input) => {
      const feed = await inventoryAttention(tc.ctx, tc.archetype, { withinDays: input.withinDays });
      return { records: [], data: feed, summary: "Inventory attention feed." };
    },
  }),
  tool({
    id: "inventory.movements",
    titleKey: "idara.tools.inventory_movements",
    description: "Recent stock movements, optionally for one item.",
    agentIds: ["idara", "operations", "inventory_purchasing", "accounting"],
    riskClass: 1,
    action: "inventory.view",
    sensitive: true,
    reversible: true,
    externalCommunication: false,
    input: z.object({ itemId: uuid.optional() }),
    run: async (tc, input) => {
      const page = await listMovements(tc.ctx, tc.archetype, { itemId: input.itemId, limit: 50 });
      const rows = (page as { rows?: Array<{ id: string }> }).rows ?? [];
      return {
        records: rows.map((r) => ref("stock_movement", r.id)),
        data: page,
        summary: `${rows.length} movements.`,
      };
    },
  }),
  tool({
    id: "documents.list",
    titleKey: "idara.tools.documents_list",
    description: "Governed documents matching a search (title, reference, counterparty).",
    agentIds: ["idara", "executive", "document_contract", "customer_success", "sales_crm"],
    riskClass: 1,
    action: "documents.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ search: z.string().max(200).optional(), counterpartyId: uuid.optional() }),
    run: async (tc, input) => {
      const r = await listDocuments(tc.ctx, tc.archetype, {
        search: input.search,
        counterpartyId: input.counterpartyId,
        limit: 30,
      });
      return {
        records: r.rows.map((d) =>
          ref("document", String((d as { id: string }).id), (d as { title?: string }).title),
        ),
        data: r,
        summary: `${r.total} documents match; ${r.rows.length} shown.`,
      };
    },
  }),
  tool({
    id: "documents.detail",
    titleKey: "idara.tools.documents_detail",
    description:
      "One governed document with its citable clauses (issued snapshot when issued, else the working revision).",
    agentIds: ["idara", "document_contract", "customer_success", "sales_crm", "tax"],
    riskClass: 1,
    action: "documents.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ documentId: uuid }),
    run: async (tc, input) => {
      const d = await getDocument(tc.ctx, tc.archetype, input.documentId);
      const body = d as {
        working?: { body?: unknown };
        revision?: { body?: unknown };
        snapshot?: { snapshot?: { body?: unknown } };
      };
      const raw = body.snapshot?.snapshot?.body ??
        body.working?.body ??
        body.revision?.body ?? { blocks: [] };
      const clauses = documentClauses(raw as never, tc.locale === "ar" ? "ar" : "en");
      const title =
        (d as { document?: { title?: string } }).document?.title ?? (d as { title?: string }).title;
      return {
        records: [ref("document", input.documentId, title)],
        data: { document: d, clauses },
        summary: `Document ${title ?? ""} with ${clauses.length} clauses.`,
      };
    },
  }),
  tool({
    id: "exceptions.open",
    titleKey: "idara.tools.exceptions_open",
    description:
      "Open exceptions raised by the deterministic engine (late stages, missing reports, overdue invoices and more).",
    agentIds: ["idara", "executive", "operations", "project", "finance", "customer_success"],
    riskClass: 1,
    action: "exceptions.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({ jobId: uuid.optional() }),
    run: async (tc, input) => {
      const rows = await listOpenExceptions(tc.ctx, tc.archetype, {
        jobId: input.jobId,
        limit: 100,
      });
      return {
        records: rows.map((e) => ref("exception", String((e as { id: string }).id))),
        data: rows,
        summary: `${rows.length} open exceptions.`,
      };
    },
  }),
  tool({
    id: "admin.members",
    titleKey: "idara.tools.admin_members",
    description: "Members of the organisation and their roles.",
    agentIds: ["idara", "org_admin", "executive"],
    riskClass: 1,
    action: "members.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const m = await listMembers(tc.ctx, tc.archetype);
      return { records: [], data: m, summary: `${m.length} members.` };
    },
  }),
  tool({
    id: "admin.entitlements",
    titleKey: "idara.tools.admin_entitlements",
    description:
      "The organisation's plan, billing state, features and limits, and its recent configuration revisions.",
    agentIds: ["idara", "org_admin", "executive"],
    riskClass: 1,
    action: "config.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const ent = await resolveEntitlements(tc.ctx);
      const revisions = await listConfigRevisions(tc.ctx, 10);
      return {
        records: [],
        data: { entitlements: ent, revisions },
        summary: `Plan ${ent.planKey} (${ent.billingState}).`,
      };
    },
  }),
  tool({
    id: "admin.ai_usage",
    titleKey: "idara.tools.admin_ai_usage",
    description:
      "The organisation's AI policy, allowance and recent usage (credits, not provider tokens).",
    agentIds: ["idara", "org_admin", "executive"],
    riskClass: 1,
    action: "config.view",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: z.object({}),
    run: async (tc) => {
      const data = await withCtx(tc.ctx, async (tx) => {
        const policy = await resolveAiPolicy(tx, tc.ctx);
        const allowance = await allowanceStatus(tx, tc.ctx, policy);
        const usage = await listUsage(tx, tc.ctx, { limit: 20, offset: 0 });
        return {
          policy: {
            mode: policy.mode,
            version: policy.version,
            restrictedDomains: policy.restrictedDomains,
          },
          allowance,
          recent: usage.rows,
          totals: usage.totals,
        };
      });
      return {
        records: [],
        data,
        summary: `AI mode ${data.policy.mode}; ${data.allowance.consumed} credits used this period.`,
      };
    },
  }),
];

// ── Class 3: reversible changes (preview + confirmation, no approval) ────────

const ActivityLogInput = z.object({
  customerId: uuid.optional(),
  opportunityId: uuid.optional(),
  leadId: uuid.optional(),
  kind: z.enum(["note", "follow_up", "task"]).default("note"),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).optional(),
  dueDate: isoDate.optional(),
});

const TaskCreateInput = z.object({
  jobId: uuid,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  startDate: isoDate,
  dueDate: isoDate,
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

async function opportunityVersion(ctx: Ctx, id: string): Promise<RecordVersion | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select row_version::text as v from public.opportunity where id = ${id} and org_id = ${ctx.orgId}`,
    ),
  )) as unknown as Array<{ v: string }>;
  return rows[0] ? { type: "opportunity", id, version: rows[0].v } : null;
}

const actionTools: ToolDef[] = [
  tool({
    id: "crm.activity.log",
    titleKey: "idara.tools.crm_activity_log",
    description:
      "Log a note, follow-up or task on a customer, opportunity or lead. Reversible (the entry can be edited or voided).",
    agentIds: ["idara", "sales_crm", "customer_success"],
    riskClass: 3,
    action: "customers.manage",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: ActivityLogInput,
    preview: async (tc, input) => {
      const subject = input.opportunityId
        ? ref("opportunity", input.opportunityId)
        : input.leadId
          ? ref("lead", input.leadId)
          : input.customerId
            ? ref("customer", input.customerId)
            : null;
      if (!subject) throw new Error("an activity needs a customer, opportunity or lead");
      const permission: Action = input.leadId
        ? "leads.manage"
        : input.opportunityId
          ? "opportunities.manage"
          : "customers.manage";
      assertCan(tc.archetype, permission);
      return {
        title: `Log ${input.kind}: ${input.title}`,
        preview: {
          what: `A ${input.kind} titled "${input.title}" will be recorded on the ${subject.type}.`,
          records: [subject],
          changes: [{ field: "activity", from: null, to: input.title }],
          permission,
          external: [],
          estCredits: 0,
          reversible: true,
          sideEffects:
            input.kind === "follow_up" && input.dueDate
              ? ["a follow-up appears in the commercial queue"]
              : [],
        },
        versions: [],
      };
    },
    execute: async (tc, input) => {
      const row = await logActivity(tc.ctx, tc.archetype, {
        customerId: input.customerId ?? null,
        opportunityId: input.opportunityId ?? null,
        leadId: input.leadId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        dueDate: input.dueDate ?? null,
      });
      const id = String((row as { id: string }).id);
      return {
        records: [ref("activity", id, input.title)],
        result: { activityId: id },
        summary: `Logged ${input.kind} ${id}.`,
      };
    },
  }),
  tool({
    id: "task.create",
    titleKey: "idara.tools.task_create",
    description:
      "Create a task on a work item with dates and priority. Reversible (the task can be cancelled).",
    agentIds: ["idara", "operations", "project"],
    riskClass: 3,
    action: "tasks.manage",
    sensitive: false,
    reversible: true,
    externalCommunication: false,
    input: TaskCreateInput,
    preview: async (tc, input) => {
      assertCan(tc.archetype, "tasks.manage");
      const job = await getJobDetail(tc.ctx, tc.archetype, input.jobId);
      if (!job) throw new Error("work item not found");
      const label = (job as { reference?: string }).reference;
      return {
        title: `Create task: ${input.title}`,
        preview: {
          what: `A ${input.priority} task "${input.title}" from ${input.startDate} to ${input.dueDate} will be created on ${label ?? "the work item"}.`,
          records: [ref("job", input.jobId, label)],
          changes: [{ field: "task", from: null, to: input.title }],
          permission: "tasks.manage",
          external: [],
          estCredits: 0,
          reversible: true,
          sideEffects: ["the task appears in the work item's plan and in the week view"],
        },
        versions: [],
      };
    },
    execute: async (tc, input) => {
      const r = await createTask(tc.ctx, tc.archetype, {
        jobId: input.jobId,
        title: input.title,
        description: input.description,
        startDate: input.startDate,
        dueDate: input.dueDate,
        priority: input.priority,
      });
      return {
        records: [ref("task", r.id, input.title)],
        result: r,
        summary: `Created task ${r.id}.`,
      };
    },
  }),
  tool({
    id: "opportunity.move_stage",
    titleKey: "idara.tools.opportunity_move_stage",
    description:
      "Move an opportunity to another pipeline stage. Material: requires a second person's approval and a final confirmation; stage requirements and the record version are re-checked.",
    agentIds: ["idara", "sales_crm"],
    riskClass: 4,
    action: "opportunities.manage",
    sensitive: false,
    reversible: false,
    externalCommunication: false,
    input: z.object({
      opportunityId: uuid,
      stageKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      reason: z.string().trim().max(500).optional(),
    }),
    preview: async (tc, input) => {
      assertCan(tc.archetype, "opportunities.manage");
      const commercial = await getOpportunityCommercial(tc.ctx, tc.archetype, input.opportunityId);
      if (!commercial) throw new Error("opportunity not found");
      const version = await opportunityVersion(tc.ctx, input.opportunityId);
      const from = String((commercial as { stageKey?: string }).stageKey ?? "");
      const name = (commercial as { name?: string }).name;
      return {
        title: `Move ${name ?? "opportunity"} to ${input.stageKey}`,
        preview: {
          what: `The opportunity moves from stage "${from}" to "${input.stageKey}". Stage requirements are validated at execution and the move is recorded with who and why.`,
          records: [ref("opportunity", input.opportunityId, name)],
          changes: [{ field: "stage", from, to: input.stageKey }],
          permission: "opportunities.manage",
          external: [],
          estCredits: 0,
          reversible: false,
          sideEffects: [
            "downstream automations bound to stage entry may run",
            "forecast buckets change",
          ],
        },
        versions: version ? [version] : [],
      };
    },
    execute: async (tc, input, expected) => {
      const current = await opportunityVersion(tc.ctx, input.opportunityId);
      const exp = expected.find((v) => v.type === "opportunity" && v.id === input.opportunityId);
      if (!current || !exp || current.version !== exp.version)
        throw new DriftError(current ? [current] : []);
      const r = await moveStage(tc.ctx, tc.archetype, {
        id: input.opportunityId,
        stageKey: input.stageKey,
        rowVersion: Number(exp.version),
        reason: input.reason ?? "moved through Idara after approval",
      });
      if (!r.moved)
        throw new Error(
          `stage requirements unmet: ${r.unmet.map((u) => String((u as { key?: string }).key ?? u)).join(", ")}`,
        );
      return {
        records: [ref("opportunity", input.opportunityId)],
        result: r,
        summary: `Moved from ${r.from} to ${r.to}.`,
      };
    },
  }),
];

// ── Class 5: restricted (never a handler) ───────────────────────────────────

const RESTRICTED: Array<{ id: string; titleKey: string; description: string }> = [
  {
    id: "payments.release",
    titleKey: "idara.tools.restricted_payments_release",
    description: "Releasing or transferring money is never available to an agent.",
  },
  {
    id: "tax.submit",
    titleKey: "idara.tools.restricted_tax_submit",
    description: "Submitting a tax filing is never available to an agent.",
  },
  {
    id: "payroll.finalise",
    titleKey: "idara.tools.restricted_payroll_finalise",
    description: "Finalising payroll is never available to an agent.",
  },
  {
    id: "permissions.change",
    titleKey: "idara.tools.restricted_permissions_change",
    description: "Changing roles or permissions is never available to an agent.",
  },
  {
    id: "campaign.send",
    titleKey: "idara.tools.restricted_campaign_send",
    description: "Sending a marketing campaign is never available to an agent.",
  },
  {
    id: "records.delete",
    titleKey: "idara.tools.restricted_records_delete",
    description: "Deleting business history is never available to an agent.",
  },
  {
    id: "journal.post",
    titleKey: "idara.tools.restricted_journal_post",
    description: "Posting an accounting journal is never available to an agent.",
  },
  {
    id: "document.sign",
    titleKey: "idara.tools.restricted_document_sign",
    description: "Signing or issuing a document is never available to an agent.",
  },
  {
    id: "employment.decide",
    titleKey: "idara.tools.restricted_employment_decide",
    description: "Hiring, dismissing or disciplining is never available to an agent.",
  },
];

const restrictedTools: ToolDef[] = RESTRICTED.map((r) =>
  tool({
    id: r.id,
    titleKey: r.titleKey,
    description: r.description,
    agentIds: [],
    riskClass: 5,
    action: null,
    sensitive: true,
    reversible: false,
    externalCommunication: false,
    input: z.object({}),
  }),
);

export const TOOLS: readonly ToolDef[] = [...readTools, ...actionTools, ...restrictedTools];
const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function getTool(id: string): ToolDef | null {
  return BY_ID.get(id) ?? null;
}

/** Tools an agent may use for a person: allow-list ∩ can() ∩ class policy (class 5 never). */
export function usableTools(
  agentId: AgentId,
  archetype: RoleArchetype,
  opts: { maxClass?: ToolRiskClass } = {},
): ToolDef[] {
  const maxClass = opts.maxClass ?? 4;
  const def = AGENT_DEFS[agentId];
  const capMax: ToolRiskClass = def.capability === "read" ? 1 : def.capability === "draft" ? 2 : 4;
  return TOOLS.filter(
    (t) =>
      t.riskClass <= Math.min(maxClass, capMax) &&
      t.agentIds.includes(agentId) &&
      (t.action === null || can(archetype, t.action)) &&
      (t.run !== undefined || (t.preview !== undefined && t.execute !== undefined)),
  );
}

/** Why a tool is not usable (stated, never silent). */
export function toolWithheldReason(
  tool: ToolDef,
  agentId: AgentId,
  archetype: RoleArchetype,
): "not_allowed" | "no_permission" | "restricted" | "not_implemented" | null {
  if (tool.riskClass === 5) return "restricted";
  if (!tool.agentIds.includes(agentId)) return "not_allowed";
  if (tool.action !== null && !can(archetype, tool.action)) return "no_permission";
  if (!tool.run && !(tool.preview && tool.execute)) return "not_implemented";
  return null;
}

/** JSON schema for the provider tool channel (strict, additionalProperties false). */
export function toolJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input as z.ZodTypeAny, {
    target: "draft-7",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type === "object") schema.additionalProperties = false;
  return schema;
}

/** Every tool with its class and whether the person could use it, for the settings and builder surfaces. */
export function describeTools(
  agentId: AgentId,
  archetype: RoleArchetype,
): Array<{
  id: string;
  titleKey: string;
  riskClass: ToolRiskClass;
  usable: boolean;
  reason: string | null;
  action: Action | null;
}> {
  return TOOLS.map((t) => {
    const reason = toolWithheldReason(t, agentId, archetype);
    return {
      id: t.id,
      titleKey: t.titleKey,
      riskClass: t.riskClass,
      usable: reason === null,
      reason,
      action: t.action,
    };
  });
}

export const TOOL_IDS = TOOLS.map((t) => t.id);
export { ALL_SPECIALISTS };
