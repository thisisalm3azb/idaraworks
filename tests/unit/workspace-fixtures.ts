/**
 * H14 deterministic blueprint fixtures — the six representative scenarios
 * (Part H) plus a parameterized builder. Shared by the unit suites and the
 * database integration suite. Fixed timestamps: fixtures must be fully
 * deterministic so the compiler-determinism law is testable.
 */
import type { WorkspaceBlueprint } from "@/platform/workspace";
import { FEATURE_KEYS } from "@/platform/entitlements";
import {
  WORKSPACE_MODULE_KEYS,
  type WorkspaceModuleKey,
  type BlueprintArchetype,
} from "@/platform/workspace";

export const loc = (en: string, ar: string) => ({ en, ar });

export const prov = (reasonEn: string, reasonAr: string) => ({
  source: "onboarding_answer" as const,
  proposedBy: "system",
  proposedAt: "2026-08-29T00:00:00.000Z",
  reason: loc(reasonEn, reasonAr),
});

const STAGES = [
  {
    key: "planning",
    name: loc("Planning", "التخطيط"),
    weight: 20,
    phaseSemantic: "preparation" as const,
  },
  {
    key: "execution",
    name: loc("Execution", "التنفيذ"),
    weight: 50,
    phaseSemantic: "production" as const,
  },
  {
    key: "review",
    name: loc("Review", "المراجعة"),
    weight: 15,
    phaseSemantic: "verification" as const,
  },
  {
    key: "handover",
    name: loc("Handover", "التسليم"),
    weight: 15,
    phaseSemantic: "handover" as const,
  },
];

export function modulesWith(enabledKeys: readonly WorkspaceModuleKey[]) {
  return WORKSPACE_MODULE_KEYS.map((key) => ({
    key,
    enabled: enabledKeys.includes(key),
    reason: enabledKeys.includes(key)
      ? loc("Needed for daily operations", "مطلوبة للتشغيل اليومي")
      : loc("Not part of how this business works", "ليست جزءاً من طريقة عمل هذه المنشأة"),
  }));
}

const ownerRole = {
  archetype: "owner" as const,
  name: loc("Owner", "المالك"),
  responsibilities: loc("Runs the business", "يدير المنشأة"),
  permissionRefs: ["config.manage"],
  navVisibility: [],
  relevantAgents: ["manager" as const],
  approvalAuthority: true,
  provenance: prov("The accountable principal", "المسؤول الأول"),
};

const dashOwner = {
  archetype: "owner" as const,
  outcomes: [loc("Know what needs attention", "معرفة ما يحتاج انتباهاً")],
  cards: [
    {
      key: "needs_decision" as const,
      why: loc("Decisions block the team", "القرارات توقف الفريق"),
    },
    { key: "at_risk" as const, why: loc("Risk seen early is cheap", "الخطر المبكر أرخص") },
  ],
  attentionSignals: ["at_risk" as const],
  decisionsRequired: ["needs_decision" as const],
  exceptions: [],
  timeHorizon: "today" as const,
  provenance: prov("Owner watches exceptions", "المالك يراقب الاستثناءات"),
};

export type FixtureOverrides = Partial<WorkspaceBlueprint>;

/** A minimal, fully valid blueprint; override sections per scenario. */
export function makeBlueprint(overrides: FixtureOverrides = {}): WorkspaceBlueprint {
  return {
    schemaVersion: 1,
    profile: {
      businessModel: "services",
      industries: ["professional services"],
      size: "1-5",
      markets: ["AE"],
      customerTypes: ["businesses"],
      workDelivery: ["appointments"],
      revenueModels: ["fixed_price"],
      operatingMode: "physical",
      operatingLocations: 1,
      provenance: prov("From the intake answers", "من إجابات الاستبيان"),
    },
    capabilities: {
      modules: modulesWith(["cap.jobs", "cap.customers", "cap.issues"]),
      provenance: prov("Chosen from the described work", "اختيرت من وصف العمل"),
    },
    terminology: {
      overrides: {},
      fallback: "platform_default",
      provenance: prov("Platform defaults fit", "المصطلحات الافتراضية مناسبة"),
    },
    workflows: [
      {
        id: "job",
        name: loc("Engagement", "مهمة"),
        stages: STAGES,
        transitions: [
          { from: "planning", to: "execution" },
          { from: "execution", to: "review" },
          { from: "review", to: "handover" },
        ],
        requiredApprovals: [{ stageKey: "handover", approvedBy: "owner" }],
        responsibilities: [{ stageKey: "execution", role: "manager" }],
        exceptionPaths: [
          {
            from: "review",
            to: "execution",
            reason: loc("Rework after review", "إعادة عمل بعد المراجعة"),
          },
        ],
        versioning: "snapshot_on_creation",
        provenance: prov("Simple four-stage flow", "مسار من أربع مراحل"),
      },
    ],
    roles: [ownerRole],
    navigation: {
      order: [],
      hidden: [],
      mobileContract: "bottom_bar_role_primary",
      clientAuthority: "none",
      provenance: prov("Default ordering", "الترتيب الافتراضي"),
    },
    dashboards: [dashOwner],
    international: {
      countryPack: "AE",
      defaultLocale: "en",
      currency: "AED",
      timezone: "Asia/Dubai",
      taxIdentityFields: ["tax_registration_number"],
      vatRegistered: false,
      provenance: prov("UAE workspace", "منشأة إماراتية"),
    },
    agents: [],
    ...overrides,
  };
}

// ── The six representative scenarios (Part H) ───────────────────────────────

/** 1. Small professional-services business. */
export const scenarioServices = (): WorkspaceBlueprint => makeBlueprint();

/** 2. Project-based contractor. */
export const scenarioContractor = (): WorkspaceBlueprint =>
  makeBlueprint({
    profile: {
      businessModel: "projects",
      industries: ["contracting"],
      size: "21-50",
      markets: ["AE"],
      customerTypes: ["businesses", "government"],
      workDelivery: ["site_work", "projects"],
      revenueModels: ["milestone_billing"],
      operatingMode: "physical",
      operatingLocations: 3,
      provenance: prov("Site-based project delivery", "تنفيذ مشاريع ميدانية"),
    },
    capabilities: {
      modules: modulesWith([
        "cap.jobs",
        "cap.daily_reports",
        "cap.issues",
        "cap.approvals",
        "cap.customers",
        "cap.people",
        "cap.attendance",
        "cap.material_requests",
        "cap.purchase_orders",
        "cap.goods_receipts",
        "cap.items",
        "cap.expenses",
        "cap.costing",
        "cap.quoting",
        "cap.invoicing",
        "cap.payments",
      ]),
      provenance: prov("Full site delivery loop", "دورة تنفيذ ميدانية كاملة"),
    },
    terminology: {
      overrides: {
        job: {
          en: { singular: "Project", plural: "Projects" },
          ar: { singular: "مشروع", plural: "مشاريع", gender: "m" },
        },
      },
      fallback: "platform_default",
      provenance: prov("Contractors call work projects", "المقاولون يسمون العمل مشاريع"),
    },
    roles: [
      ownerRole,
      {
        archetype: "manager",
        name: loc("Project manager", "مدير المشروع"),
        responsibilities: loc("Plans and reviews delivery", "يخطط ويراجع التنفيذ"),
        permissionRefs: ["reports.review"],
        navVisibility: [],
        relevantAgents: ["project", "operations"],
        approvalAuthority: true,
        provenance: prov("Runs delivery", "يدير التنفيذ"),
      },
      {
        archetype: "foreman",
        name: loc("Site foreman", "مشرف الموقع"),
        responsibilities: loc("Reports daily site work", "يرفع تقارير الموقع اليومية"),
        permissionRefs: ["reports.create"],
        navVisibility: [],
        relevantAgents: ["operations"],
        approvalAuthority: false,
        provenance: prov("Field-first role", "دور ميداني أولاً"),
      },
      {
        archetype: "procurement",
        name: loc("Procurement", "المشتريات"),
        responsibilities: loc("Buys what the sites need", "يشتري ما تحتاجه المواقع"),
        permissionRefs: ["mr.create"],
        navVisibility: [],
        relevantAgents: ["inventory_purchasing"],
        approvalAuthority: false,
        provenance: prov("Materials pipeline", "مسار المواد"),
      },
    ],
    dashboards: [
      dashOwner,
      {
        archetype: "foreman",
        outcomes: [loc("Report today's work", "رفع تقرير عمل اليوم")],
        cards: [
          { key: "my_jobs_today", why: loc("Where I work today", "أين أعمل اليوم") },
          {
            key: "submit_daily_report",
            why: loc("The day is not done without it", "لا ينتهي اليوم بدونه"),
          },
        ],
        attentionSignals: [],
        decisionsRequired: [],
        exceptions: [],
        timeHorizon: "today",
        provenance: prov("Field focus", "تركيز ميداني"),
      },
      {
        archetype: "procurement",
        outcomes: [loc("Keep materials moving", "إبقاء المواد تتحرك")],
        cards: [
          { key: "approved_mrs", why: loc("Ready to order", "جاهزة للطلب") },
          { key: "open_pos", why: loc("Chase deliveries", "متابعة التوريدات") },
        ],
        attentionSignals: ["approved_mrs"],
        decisionsRequired: [],
        exceptions: [],
        timeHorizon: "this_week",
        provenance: prov("Purchasing focus", "تركيز المشتريات"),
      },
    ],
    agents: [
      {
        agentId: "operations",
        relevantRoles: ["manager", "foreman"],
        relevantModules: ["cap.daily_reports", "cap.issues"],
        readDomains: ["read.work_overview", "read.operations_overview"],
        classifications: ["read_explain"],
        entitlement: "feat.ai_agents",
        provenance: prov("Daily delivery helper", "مساعد التنفيذ اليومي"),
      },
      {
        agentId: "inventory_purchasing",
        relevantRoles: ["procurement"],
        relevantModules: ["cap.material_requests", "cap.purchase_orders"],
        readDomains: ["read.supply_overview"],
        classifications: ["read_explain"],
        entitlement: "feat.ai_agents",
        provenance: prov("Materials helper", "مساعد المواد"),
      },
    ],
  });

/** 3. Retail / inventory-led business. */
export const scenarioRetail = (): WorkspaceBlueprint =>
  makeBlueprint({
    profile: {
      businessModel: "retail",
      industries: ["retail trade"],
      size: "6-20",
      markets: ["AE"],
      customerTypes: ["consumers"],
      workDelivery: ["orders"],
      revenueModels: ["product_sales"],
      operatingMode: "mixed",
      operatingLocations: 2,
      provenance: prov("Inventory-led selling", "بيع قائم على المخزون"),
    },
    capabilities: {
      modules: modulesWith([
        "cap.jobs",
        "cap.customers",
        "cap.items",
        "cap.purchase_orders",
        "cap.goods_receipts",
        "cap.invoicing",
        "cap.payments",
        "cap.expenses",
      ]),
      provenance: prov("Stock in, sales out", "مخزون داخل ومبيعات خارجة"),
    },
    terminology: {
      overrides: {
        job: {
          en: { singular: "Order", plural: "Orders" },
          ar: { singular: "طلب", plural: "طلبات", gender: "m" },
        },
      },
      fallback: "platform_default",
      provenance: prov("Retail speaks in orders", "التجزئة تتحدث بالطلبات"),
    },
  });

/** 4. International consulting organization (multi-market, USD). */
export const scenarioConsulting = (): WorkspaceBlueprint =>
  makeBlueprint({
    profile: {
      businessModel: "services",
      industries: ["management consulting"],
      size: "51-200",
      markets: ["AE", "SA", "QA"],
      customerTypes: ["businesses", "government"],
      workDelivery: ["projects"],
      revenueModels: ["time_and_materials", "recurring"],
      operatingMode: "mixed",
      operatingLocations: 4,
      provenance: prov("Cross-market consulting", "استشارات عبر الأسواق"),
    },
    capabilities: {
      modules: modulesWith([
        "cap.jobs",
        "cap.customers",
        "cap.people",
        "cap.quoting",
        "cap.invoicing",
        "cap.payments",
        "cap.expenses",
      ]),
      provenance: prov("Engagement lifecycle", "دورة حياة التكليفات"),
    },
    international: {
      countryPack: "AE",
      defaultLocale: "en",
      currency: "USD",
      timezone: "Asia/Dubai",
      taxIdentityFields: ["tax_registration_number"],
      vatRegistered: true,
      provenance: prov("USD billing across markets", "فوترة بالدولار عبر الأسواق"),
    },
  });

/** 5. Arabic-first organization. */
export const scenarioArabicFirst = (): WorkspaceBlueprint =>
  makeBlueprint({
    profile: {
      businessModel: "services",
      industries: ["مقاولات صيانة"],
      size: "6-20",
      markets: ["SA"],
      customerTypes: ["businesses"],
      workDelivery: ["site_work"],
      revenueModels: ["fixed_price"],
      operatingMode: "physical",
      operatingLocations: 1,
      provenance: prov("Arabic-first maintenance firm", "منشأة صيانة عربية أولاً"),
    },
    international: {
      countryPack: "SA",
      defaultLocale: "ar",
      currency: "SAR",
      timezone: "Asia/Riyadh",
      taxIdentityFields: ["tax_registration_number"],
      vatRegistered: true,
      provenance: prov("Saudi workspace in Arabic", "منشأة سعودية بالعربية"),
    },
    terminology: {
      overrides: {
        job: {
          en: { singular: "Work order", plural: "Work orders" },
          ar: { singular: "أمر عمل", plural: "أوامر عمل", gender: "m" },
        },
      },
      fallback: "platform_default",
      provenance: prov("Maintenance vocabulary", "مفردات الصيانة"),
    },
  });

/** 6. Multi-role growing company. */
export const scenarioGrowing = (): WorkspaceBlueprint => {
  const contractor = scenarioContractor();
  const roles: WorkspaceBlueprint["roles"] = [
    ...contractor.roles,
    {
      archetype: "admin" as BlueprintArchetype,
      name: loc("Administrator", "المسؤول الإداري"),
      responsibilities: loc("Runs settings and people", "يدير الإعدادات والأفراد"),
      permissionRefs: ["config.view"],
      navVisibility: [],
      relevantAgents: ["executive"],
      approvalAuthority: true,
      provenance: prov("Back office", "المكتب الخلفي"),
    },
    {
      archetype: "accounts",
      name: loc("Accounts", "الحسابات"),
      responsibilities: loc("Invoices and collections", "الفواتير والتحصيل"),
      permissionRefs: ["invoices.view"],
      navVisibility: [],
      relevantAgents: ["accounting", "finance"],
      approvalAuthority: false,
      provenance: prov("Money desk", "مكتب المال"),
    },
    {
      archetype: "viewer",
      name: loc("Viewer", "مطّلع"),
      responsibilities: loc("Reads, never edits", "يطّلع ولا يعدّل"),
      permissionRefs: [],
      navVisibility: [],
      relevantAgents: [],
      approvalAuthority: false,
      provenance: prov("Read-only stakeholder", "طرف مطّلع فقط"),
    },
  ];
  return makeBlueprint({
    ...contractor,
    profile: { ...contractor.profile, size: "51-200" },
    roles,
    dashboards: [
      ...contractor.dashboards,
      {
        archetype: "accounts",
        outcomes: [loc("Collect what is owed", "تحصيل المستحقات")],
        cards: [
          { key: "overdue_receivables", why: loc("Oldest money first", "الأقدم أولاً") },
          { key: "invoices_to_issue", why: loc("Bill finished work", "فوترة العمل المنجز") },
        ],
        attentionSignals: ["overdue_receivables"],
        decisionsRequired: [],
        exceptions: [],
        timeHorizon: "this_week",
        provenance: prov("Collections focus", "تركيز التحصيل"),
      },
    ],
  });
};

/** A server-resolved snapshot with EVERY registered feature entitled. */
export const entitleAll = () => ({
  entitlements: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
});

/** The free-plan shape (no commercial modules). */
export const entitleFree = () => ({
  entitlements: Object.fromEntries(
    FEATURE_KEYS.map((k) => [
      k,
      [
        "cap.jobs",
        "cap.daily_reports",
        "cap.issues",
        "cap.customers",
        "cap.people",
        "feat.ai_onboarding",
        "feat.ai_drafts",
        "feat.custom_fields",
        "feat.org_terminology_overrides",
      ].includes(k),
    ]),
  ),
});
