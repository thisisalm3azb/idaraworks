/**
 * H28 — Idara's routing brain (ADR-60): a deterministic, bilingual intent
 * classifier over the request text and the context capsule, producing a
 * bounded delegation plan. When a provider is available the run engine may
 * ask the model for a structured classification too, but the registry, the
 * depth and child limits and the person's permissions always decide.
 */
import { ACTIVE_AGENT_IDS, AGENT_DEFS, type AgentId } from "@/platform/agents/registry";
import { can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import type { AiTaskClass } from "@/platform/ai";
import { RUN_LIMITS, type RecordRef } from "./types";

type DomainRule = { agent: AgentId; weight: number; terms: RegExp[] };

const RULES: DomainRule[] = [
  {
    agent: "sales_crm",
    weight: 1,
    terms: [
      /\b(lead|leads|opportunit|pipeline|deal|deals|quote|quotes|forecast|prospect|follow[- ]?up|proposal|win rate|conversion)\b/i,
      /(فرصة|فرص|عميل محتمل|عملاء محتملين|عرض سعر|عروض|خط الأنابيب|التوقعات|متابعة|صفقة|صفقات)/,
    ],
  },
  {
    agent: "customer_success",
    weight: 1,
    terms: [
      /\b(churn|renewal|renewals|retention|at[- ]risk|health score|satisfaction|complaint|service issue|account health)\b/i,
      /(تجديد|تجديدات|الاحتفاظ|رضا|شكوى|صحة الحساب|خطر فقدان)/,
    ],
  },
  {
    agent: "project",
    weight: 1,
    terms: [
      /\b(schedule|critical path|milestone|dependency|dependencies|gantt|resource conflict|capacity|deadline|slippage|plan|planning|re-?plan)\b/i,
      /(جدول|المسار الحرج|مرحلة رئيسية|اعتمادية|تعارض الموارد|السعة|الموعد النهائي|تخطيط|الخطة)/,
    ],
  },
  {
    agent: "operations",
    weight: 1,
    terms: [
      /\b(daily report|reports?|issue|issues|attendance|shift|stage|stages|blocked|foreman|site|delivery)\b/i,
      /(تقرير يومي|التقارير|مشكلة|مشكلات|الحضور|وردية|مرحلة|التسليم|الموقع)/,
    ],
  },
  {
    agent: "inventory_purchasing",
    weight: 1,
    terms: [
      /\b(stock|inventory|warehouse|reorder|purchase order|supplier|suppliers|goods receipt|lot|serial|material request|item|items)\b/i,
      /(مخزون|المستودع|إعادة الطلب|أمر شراء|مورد|موردين|استلام|دفعة|رقم تسلسلي|طلب مواد|صنف|أصناف)/,
    ],
  },
  {
    agent: "accounting",
    weight: 1,
    terms: [
      /\b(journal|ledger|trial balance|reconcil|balance sheet|accounts? (receivable|payable)|entry|entries|period close|posting)\b/i,
      /(قيد|قيود|دفتر الأستاذ|ميزان المراجعة|تسوية|الميزانية العمومية|الذمم|إقفال الفترة|ترحيل)/,
    ],
  },
  {
    agent: "finance",
    weight: 1,
    terms: [
      /\b(cash|cashflow|cash flow|budget|budgets|variance|variances|profit|loss|p&l|margin|bank|treasury|runway|invoice|invoices|overdue|ageing|aging)\b/i,
      /(نقد|التدفق النقدي|ميزانية|ميزانيات|انحراف|ربح|خسارة|هامش|بنك|خزينة|فاتورة|فواتير|متأخر|أعمار الديون)/,
    ],
  },
  {
    agent: "tax",
    weight: 1.2,
    terms: [
      /\b(vat|tax|taxes|return|filing|zakat|corporate tax|working paper)\b/i,
      /(ضريبة|الضرائب|القيمة المضافة|إقرار|زكاة|أوراق العمل)/,
    ],
  },
  {
    agent: "people_payroll",
    weight: 1.1,
    terms: [
      /\b(payroll|salary|salaries|payslip|leave|vacation|overtime|employee|employees|hr|hiring|onboarding|probation|gratuity|end of service)\b/i,
      /(رواتب|راتب|كشف راتب|إجازة|إجازات|عمل إضافي|موظف|موظفين|الموارد البشرية|توظيف|فترة تجربة|مكافأة نهاية الخدمة)/,
    ],
  },
  {
    agent: "document_contract",
    weight: 1.1,
    terms: [
      /\b(contract|contracts|clause|clauses|agreement|document|documents|amendment|obligation|signature|sign|terms)\b/i,
      /(عقد|عقود|بند|بنود|اتفاقية|مستند|مستندات|وثيقة|تعديل|التزام|توقيع|شروط)/,
    ],
  },
  {
    agent: "planning_analytics",
    weight: 0.9,
    terms: [
      /\b(report on|breakdown|compare|comparison|trend|trends|chart|table|statistics|kpi|kpis|export|dashboard|explain (this|the) number)\b/i,
      /(مقارنة|قارن|اتجاه|رسم بياني|جدول|إحصائيات|مؤشرات|تصدير|لوحة)/,
    ],
  },
  {
    agent: "executive",
    weight: 1.2,
    terms: [
      /\b(briefing|brief me|overview of the business|how is the business|what needs attention|risks across|summary of everything|daily summary|morning)\b/i,
      /(ملخص تنفيذي|ملخص الأعمال|ما الذي يحتاج|المخاطر|ملخص يومي|كيف حال الشركة)/,
    ],
  },
  {
    agent: "org_admin",
    weight: 1,
    terms: [
      /\b(member|members|role|roles|permission|permissions|subscription|plan|entitlement|settings|configuration|usage|credits)\b/i,
      /(عضو|أعضاء|دور|أدوار|صلاحية|صلاحيات|اشتراك|الخطة|إعدادات|الإعداد|الاستخدام|رصيد)/,
    ],
  },
];

const CONTEXT_AGENT: Record<string, AgentId> = {
  customer: "sales_crm",
  lead: "sales_crm",
  opportunity: "sales_crm",
  quote: "sales_crm",
  invoice: "finance",
  payment: "finance",
  journal_entry: "accounting",
  tax_return: "tax",
  job: "operations",
  task: "project",
  studio_plan: "project",
  employee: "people_payroll",
  pay_run: "people_payroll",
  leave_request: "people_payroll",
  item: "inventory_purchasing",
  purchase_order: "inventory_purchasing",
  stock_movement: "inventory_purchasing",
  document: "document_contract",
  warehouse: "inventory_purchasing",
};

export type Intent = {
  primary: AgentId;
  contributors: AgentId[];
  taskClass: AiTaskClass;
  scores: Record<string, number>;
  reason: string;
};

function taskClassOf(text: string): AiTaskClass {
  const t = text.toLowerCase();
  if (/\b(draft|write|compose|reply|email|message|letter)\b|(اكتب|صياغة|مسودة|رسالة|بريد)/.test(t))
    return "draft";
  if (/\b(plan|scenario|what if|re-?plan|schedule)\b|(خطة|سيناريو|ماذا لو|جدول)/.test(t))
    return "plan";
  if (
    /\b(analy[sz]e|why|explain|compare|variance|risk|risks|trend)\b|(حلل|لماذا|اشرح|قارن|انحراف|مخاطر|اتجاه)/.test(
      t,
    )
  )
    return "analyse";
  if (/\b(summar\w*|brief|overview|tl;?dr)\b|(لخّص|لخص|ملخص|نظرة عامة)/.test(t)) return "summarise";
  if (/\b(classify|categor|tag|label)\b|(صنف|تصنيف)/.test(t)) return "classify";
  if (/\b(extract|list|find|which|who|how many|count)\b|(استخرج|اعرض|قائمة|من|كم|عدد)/.test(t))
    return "extract";
  return "answer";
}

/** Deterministic classification: text terms plus the context capsule's record kinds; permissions prune. */
export function classifyIntent(
  text: string,
  contextRefs: readonly RecordRef[],
  archetype: RoleArchetype,
  requested: AgentId | null,
): Intent {
  const scores: Record<string, number> = {};
  for (const r of RULES) {
    let hits = 0;
    for (const re of r.terms) if (re.test(text)) hits++;
    if (hits > 0) scores[r.agent] = (scores[r.agent] ?? 0) + hits * r.weight;
  }
  for (const ref of contextRefs.slice(0, RUN_LIMITS.maxContextRefs)) {
    const a = CONTEXT_AGENT[ref.type];
    if (a) scores[a] = (scores[a] ?? 0) + 0.75;
  }
  const permitted = (a: AgentId) =>
    AGENT_DEFS[a].status === "active" &&
    AGENT_DEFS[a].requiredActions.every((x) => can(archetype, x));
  const ranked = Object.entries(scores)
    .filter(([a]) => permitted(a as AgentId))
    .sort((x, y) => y[1] - x[1])
    .map(([a]) => a as AgentId);
  if (requested && permitted(requested)) {
    return {
      primary: requested,
      contributors: [],
      taskClass: taskClassOf(text),
      scores,
      reason: `person chose ${requested}`,
    };
  }
  const primary = ranked[0] ?? "idara";
  const contributors = ranked
    .slice(1, 1 + Math.min(RUN_LIMITS.maxChildrenPerRun - 1, 2))
    .filter((a) => a !== primary);
  return {
    primary,
    contributors,
    taskClass: taskClassOf(text),
    scores,
    reason:
      ranked.length === 0
        ? "no domain matched; Idara answers directly"
        : `matched ${ranked.slice(0, 3).join(", ")}`,
  };
}

/** The bounded plan the run stores and shows (ADR-60). */
export type PlanStep = {
  step: number;
  agent: AgentId;
  purpose: string;
  kind: "answer" | "delegate";
};

export function planFor(intent: Intent): PlanStep[] {
  const steps: PlanStep[] = [];
  let n = 1;
  if (intent.primary !== "idara")
    steps.push({ step: n++, agent: intent.primary, purpose: "primary domain", kind: "delegate" });
  for (const c of intent.contributors)
    steps.push({ step: n++, agent: c, purpose: "contributing domain", kind: "delegate" });
  steps.push({
    step: n++,
    agent: "idara",
    purpose: steps.length ? "merge and answer" : "answer directly",
    kind: "answer",
  });
  return steps.slice(0, RUN_LIMITS.maxChildrenPerRun + 1);
}

/** Specialists the person may address directly (agent switcher, @mentions). */
export function addressableAgents(archetype: RoleArchetype): AgentId[] {
  return ACTIVE_AGENT_IDS.filter((a) =>
    AGENT_DEFS[a].requiredActions.every((x) => can(archetype, x)),
  );
}

/** Resolve an @mention like "@tax" or "@finance" (both scripts) to an agent id. */
export function parseMention(text: string): AgentId | null {
  const m = /(^|\s)@([a-z_]+)/i.exec(text);
  if (!m) return null;
  const key = m[2]!.toLowerCase();
  const aliases: Record<string, AgentId> = {
    idara: "idara",
    executive: "executive",
    exec: "executive",
    operations: "operations",
    ops: "operations",
    project: "project",
    planning: "project",
    sales: "sales_crm",
    revenue: "sales_crm",
    success: "customer_success",
    customer_success: "customer_success",
    accounting: "accounting",
    finance: "finance",
    tax: "tax",
    hr: "people_payroll",
    payroll: "people_payroll",
    inventory: "inventory_purchasing",
    purchasing: "inventory_purchasing",
    data: "planning_analytics",
    reporting: "planning_analytics",
    documents: "document_contract",
    contracts: "document_contract",
    admin: "org_admin",
  };
  return aliases[key] ?? null;
}
