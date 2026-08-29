/**
 * H15 answers → H14 workspace blueprint (Part F) — the ONE mapping from the
 * journey's answers (plus the founder's review edits) to the H14 blueprint
 * contract. Pure and deterministic in (answers, edits, templateKey, now).
 *
 * Laws honored here:
 *  - this module RECOMMENDS; it never grants — the H14 validator re-checks
 *    every rule and the compiler intersects with the real plan entitlement
 *    and permission matrix at apply time;
 *  - every module position carries a bilingual reason traceable to the
 *    answers that produced it (Part F "which answers produced it");
 *  - dependencies are kept valid in BOTH directions: disabling a module
 *    disables its dependents (with the consequence recorded), enabling one
 *    brings its requirements along (Part G);
 *  - canonical identity is stable: terminology overrides are keyed by
 *    TermKey, modules by the closed workspace registry, agents by the
 *    canonical agent ids;
 *  - the deterministic recommendation system is exactly that — nothing here
 *    calls or pretends to be an AI provider.
 */
import { TEMPLATES } from "@/platform/config";
import {
  WORKSPACE_MODULE_KEYS,
  MODULE_INFO,
  type WorkspaceModuleKey,
  type BlueprintArchetype,
} from "@/platform/workspace";
import type { WorkspaceBlueprint } from "@/platform/workspace";
import type { AgentId } from "@/platform/agents/registry";
import {
  effectiveCustomerSharing,
  askMaterialsStep,
  canonicalIndustry,
  INDUSTRY_INFO,
  type DraftAnswers,
  type DraftData,
  type WorkspaceEdits,
} from "./flow";

/** Public slugs used in review forms (never expose the internal prefix). */
export const moduleSlug = (key: WorkspaceModuleKey): string => key.slice("cap.".length);
export function moduleFromSlug(slug: string): WorkspaceModuleKey | null {
  const key = `cap.${slug}` as WorkspaceModuleKey;
  return (WORKSPACE_MODULE_KEYS as readonly string[]).includes(key) ? key : null;
}

/** Modules every workspace keeps (the free operating core; not editable). */
export const CORE_MODULES: readonly WorkspaceModuleKey[] = [
  "cap.jobs",
  "cap.issues",
  "cap.customers",
  "cap.people",
];

export type ModuleRecommendation = {
  key: WorkspaceModuleKey;
  enabled: boolean;
  core: boolean;
  /** i18n suffix under onboarding.journey.reason.* */
  reasonKey: string;
  /** Question keys whose answers produced this position. */
  fromAnswers: readonly string[];
  /** Set when the founder's edit cascaded (dependency explanation). */
  cascadedFrom?: WorkspaceModuleKey;
};

const yes = (v: string | undefined) => v === "yes";

/** The deterministic module recommendation from the answers alone. */
export function recommendModules(a: DraftAnswers): ModuleRecommendation[] {
  const patterns = a.work_patterns ?? [];
  const ind = canonicalIndustry(a.industry);
  // H15.1 (Part D): field work follows DELIVERY patterns, never the industry
  // alone. "Service" delivery counts as field work only for industries where
  // service means being on site (a desk-based consulting business is never
  // pushed into daily reports).
  const fieldWork =
    patterns.some((p) => p === "project" || p === "production") ||
    (patterns.includes("service") && ind !== undefined && INDUSTRY_INFO[ind].fieldService);
  const team = a.employees_band !== undefined && a.employees_band !== "1-5";
  const bigTeam =
    a.employees_band === "21-50" || a.employees_band === "51-200" || a.employees_band === "200+";
  const fieldDepts = (a.departments ?? []).some((d) => d === "field_teams" || d === "workshop");

  const rec = (
    key: WorkspaceModuleKey,
    enabled: boolean,
    reasonKey: string,
    fromAnswers: readonly string[],
  ): ModuleRecommendation => ({
    key,
    enabled,
    core: CORE_MODULES.includes(key),
    reasonKey,
    fromAnswers,
  });

  return [
    rec("cap.jobs", true, "core_work", ["work_patterns"]),
    rec("cap.issues", true, "core_issues", []),
    rec("cap.customers", true, "core_customers", ["customer_types"]),
    rec("cap.people", true, "core_people", ["employees_band"]),
    rec("cap.daily_reports", fieldWork, fieldWork ? "field_reports" : "no_field_reports", [
      "work_patterns",
      "industry",
    ]),
    rec(
      "cap.approvals",
      yes(a.buys_materials) || team,
      yes(a.buys_materials) ? "approvals_purchasing" : team ? "approvals_team" : "approvals_off",
      ["buys_materials", "employees_band"],
    ),
    rec("cap.quoting", yes(a.sends_quotes), yes(a.sends_quotes) ? "quotes_on" : "quotes_off", [
      "sends_quotes",
    ]),
    rec(
      "cap.invoicing",
      a.sends_invoices === "yes" || a.sends_invoices === "not_sure",
      a.sends_invoices === "yes"
        ? "invoices_on"
        : a.sends_invoices === "not_sure"
          ? "invoices_safe_default"
          : "invoices_off",
      ["sends_invoices"],
    ),
    rec(
      "cap.payments",
      yes(a.collects_payments),
      yes(a.collects_payments) ? "payments_on" : "payments_off",
      ["collects_payments"],
    ),
    rec(
      "cap.expenses",
      yes(a.records_expenses),
      yes(a.records_expenses) ? "expenses_on" : "expenses_off",
      ["records_expenses"],
    ),
    rec("cap.costing", yes(a.tracks_costs), yes(a.tracks_costs) ? "costing_on" : "costing_off", [
      "tracks_costs",
    ]),
    rec(
      "cap.material_requests",
      yes(a.buys_materials),
      yes(a.buys_materials) ? "materials_on" : "materials_off",
      ["buys_materials"],
    ),
    rec(
      "cap.purchase_orders",
      yes(a.buys_materials),
      yes(a.buys_materials) ? "purchasing_on" : "purchasing_off",
      ["buys_materials"],
    ),
    rec(
      "cap.goods_receipts",
      yes(a.receives_deliveries),
      yes(a.receives_deliveries) ? "receiving_on" : "receiving_off",
      ["receives_deliveries"],
    ),
    rec("cap.items", yes(a.holds_stock), yes(a.holds_stock) ? "stock_on" : "stock_off", [
      "holds_stock",
    ]),
    rec(
      "cap.attendance",
      team && (fieldWork || fieldDepts || bigTeam),
      team && (fieldWork || fieldDepts || bigTeam) ? "attendance_on" : "attendance_off",
      ["employees_band", "departments"],
    ),
    rec(
      "cap.customer_updates",
      effectiveCustomerSharing(a),
      effectiveCustomerSharing(a) ? "updates_on" : "updates_off",
      ["customer_sharing"],
    ),
  ];
}

/**
 * Apply the founder's review edits and re-close the dependency set.
 * Disabling a module disables everything that requires it (cascade recorded);
 * enabling one brings its requirements along. Core modules cannot be edited.
 */
export function applyModuleEdits(
  recommended: ModuleRecommendation[],
  edits: WorkspaceEdits,
): ModuleRecommendation[] {
  const byKey = new Map(recommended.map((m) => [m.key, { ...m }]));
  const off = new Set(
    (edits.modules_off ?? [])
      .map(moduleFromSlug)
      .filter((k): k is WorkspaceModuleKey => k !== null),
  );
  const on = new Set(
    (edits.modules_on ?? []).map(moduleFromSlug).filter((k): k is WorkspaceModuleKey => k !== null),
  );

  for (const key of on) {
    const m = byKey.get(key);
    if (m && !m.core && !m.enabled) {
      m.enabled = true;
      m.reasonKey = "founder_enabled";
      m.fromAnswers = [];
    }
  }
  for (const key of off) {
    const m = byKey.get(key);
    if (m && !m.core && m.enabled) {
      m.enabled = false;
      m.reasonKey = "founder_disabled";
    }
  }
  // Close dependencies deterministically (bounded fixpoint).
  for (let pass = 0; pass < WORKSPACE_MODULE_KEYS.length; pass++) {
    let changed = false;
    for (const m of byKey.values()) {
      if (!m.enabled) continue;
      for (const dep of MODULE_INFO[m.key].requires) {
        const d = byKey.get(dep)!;
        if (!d.enabled) {
          if (off.has(dep)) {
            // The founder disabled a requirement: the dependent goes too,
            // and the consequence is recorded (Part G).
            m.enabled = false;
            m.reasonKey = "dependency_disabled";
            m.cascadedFrom = dep;
          } else {
            d.enabled = true;
            d.reasonKey = "dependency_enabled";
            d.cascadedFrom = m.key;
          }
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return [...byKey.values()];
}

export function modulesForDraft(data: DraftData): ModuleRecommendation[] {
  return applyModuleEdits(recommendModules(data.answers), data.workspace);
}

// ── Roles ───────────────────────────────────────────────────────────────────
export type RoleRecommendation = {
  archetype: BlueprintArchetype;
  reasonKey: string;
  permissionRefs: readonly string[];
  approvalAuthority: boolean;
};

const ROLE_DEFAULT_NAMES: Record<string, { en: string; ar: string }> = {
  owner: { en: "Owner", ar: "المالك" },
  admin: { en: "Administrator", ar: "المسؤول الإداري" },
  manager: { en: "Manager", ar: "المدير" },
  foreman: { en: "Site supervisor", ar: "مشرف الموقع" },
  procurement: { en: "Purchasing", ar: "المشتريات" },
  accounts: { en: "Accounts", ar: "الحسابات" },
};

const ROLE_RESPONSIBILITIES: Record<string, { en: string; ar: string }> = {
  owner: { en: "Owns the business and approves what matters", ar: "يملك المنشأة ويوافق على المهم" },
  admin: { en: "Runs settings, people and access", ar: "يدير الإعدادات والأفراد والصلاحيات" },
  manager: { en: "Plans the work and reviews progress", ar: "يخطط العمل ويراجع التقدم" },
  foreman: {
    en: "Leads the field team and reports daily",
    ar: "يقود فريق الميدان ويرفع التقارير اليومية",
  },
  procurement: { en: "Buys materials and follows deliveries", ar: "يشتري المواد ويتابع التوريدات" },
  accounts: { en: "Issues invoices and follows collections", ar: "يصدر الفواتير ويتابع التحصيل" },
};

export function recommendRoles(
  a: DraftAnswers,
  modules: ModuleRecommendation[],
): RoleRecommendation[] {
  const enabled = new Set(modules.filter((m) => m.enabled).map((m) => m.key));
  const team = a.employees_band !== undefined && a.employees_band !== "1-5";
  const big = a.employees_band === "51-200" || a.employees_band === "200+";
  const fieldWork = enabled.has("cap.daily_reports");
  const out: RoleRecommendation[] = [
    {
      archetype: "owner",
      reasonKey: "role_owner",
      permissionRefs: ["config.manage", "approvals.decide"],
      approvalAuthority: true,
    },
  ];
  if (big)
    out.push({
      archetype: "admin",
      reasonKey: "role_admin",
      permissionRefs: ["config.view", "members.view"],
      approvalAuthority: true,
    });
  if (team)
    out.push({
      archetype: "manager",
      reasonKey: "role_manager",
      permissionRefs: ["reports.review", "approvals.decide"],
      approvalAuthority: true,
    });
  if (team && fieldWork)
    out.push({
      archetype: "foreman",
      reasonKey: "role_foreman",
      permissionRefs: ["reports.create"],
      approvalAuthority: false,
    });
  if (team && enabled.has("cap.material_requests")) {
    out.push({
      archetype: "procurement",
      reasonKey: "role_procurement",
      permissionRefs: ["mr.create", "po.view"],
      approvalAuthority: false,
    });
  }
  if (team && enabled.has("cap.invoicing")) {
    out.push({
      archetype: "accounts",
      reasonKey: "role_accounts",
      permissionRefs: ["invoices.view", "ar.view"],
      approvalAuthority: true,
    });
  }
  return out;
}

// ── Agents ──────────────────────────────────────────────────────────────────
export type AgentRecommendation = {
  agentId: AgentId;
  reasonKey: string;
  relevantRoles: BlueprintArchetype[];
  relevantModules: WorkspaceModuleKey[];
};

export function recommendAgents(
  a: DraftAnswers,
  modules: ModuleRecommendation[],
  roles: RoleRecommendation[],
  edits: WorkspaceEdits,
): AgentRecommendation[] {
  const enabled = new Set(modules.filter((m) => m.enabled).map((m) => m.key));
  const has = (r: BlueprintArchetype) => roles.some((x) => x.archetype === r);
  const roleOr = (r: BlueprintArchetype, fallback: BlueprintArchetype = "owner") =>
    has(r) ? r : fallback;
  const optOut = new Set(edits.agents_off ?? []);

  const all: Array<AgentRecommendation | null> = [
    {
      agentId: "manager",
      reasonKey: "agent_manager",
      relevantRoles: ["owner", roleOr("manager")],
      relevantModules: [],
    },
    enabled.has("cap.daily_reports")
      ? {
          agentId: "operations",
          reasonKey: "agent_operations",
          relevantRoles: [roleOr("manager"), roleOr("foreman", roleOr("manager"))],
          relevantModules: ["cap.daily_reports", "cap.issues"],
        }
      : null,
    {
      agentId: "project",
      reasonKey: "agent_project",
      relevantRoles: [roleOr("manager")],
      relevantModules: ["cap.jobs"],
    },
    enabled.has("cap.quoting")
      ? {
          agentId: "sales_crm",
          reasonKey: "agent_sales",
          relevantRoles: ["owner"],
          relevantModules: ["cap.quoting", "cap.customers"],
        }
      : null,
    enabled.has("cap.invoicing")
      ? {
          agentId: "accounting",
          reasonKey: "agent_accounting",
          relevantRoles: [roleOr("accounts")],
          relevantModules: ["cap.invoicing"],
        }
      : null,
    enabled.has("cap.payments") || enabled.has("cap.expenses")
      ? {
          agentId: "finance",
          reasonKey: "agent_finance",
          relevantRoles: [roleOr("accounts")],
          relevantModules: (["cap.payments", "cap.expenses"] as const).filter((k) =>
            enabled.has(k),
          ),
        }
      : null,
    enabled.has("cap.attendance")
      ? {
          agentId: "people_payroll",
          reasonKey: "agent_people",
          relevantRoles: [roleOr("admin")],
          relevantModules: ["cap.people", "cap.attendance"],
        }
      : null,
    enabled.has("cap.purchase_orders")
      ? {
          agentId: "inventory_purchasing",
          reasonKey: "agent_supply",
          relevantRoles: [roleOr("procurement")],
          relevantModules: (
            [
              "cap.material_requests",
              "cap.purchase_orders",
              "cap.goods_receipts",
              "cap.items",
            ] as const
          ).filter((k) => enabled.has(k)),
        }
      : null,
    enabled.has("cap.costing") ||
    a.employees_band === "21-50" ||
    a.employees_band === "51-200" ||
    a.employees_band === "200+"
      ? {
          agentId: "planning_analytics",
          reasonKey: "agent_planning",
          relevantRoles: ["owner", roleOr("manager")],
          relevantModules: (["cap.costing", "cap.jobs"] as const).filter((k) => enabled.has(k)),
        }
      : null,
    a.employees_band !== undefined && a.employees_band !== "1-5"
      ? {
          agentId: "executive",
          reasonKey: "agent_executive",
          relevantRoles: ["owner"],
          relevantModules: [],
        }
      : null,
  ];
  return all
    .filter((x): x is AgentRecommendation => x !== null)
    .filter((x) => !optOut.has(x.agentId))
    .map((x) => ({ ...x, relevantRoles: [...new Set(x.relevantRoles)] }));
}

// ── The blueprint ───────────────────────────────────────────────────────────
/** The profile.industries token — legacy marine keeps its own wording so an
 * existing draft's blueprint output stays what the founder saw. */
function industryToken(industry: DraftAnswers["industry"]): string {
  if (industry === "marine") return "marine services";
  const ind = canonicalIndustry(industry);
  return ind ? INDUSTRY_INFO[ind].token : "general business";
}

function businessModelOf(a: DraftAnswers): WorkspaceBlueprint["profile"]["businessModel"] {
  const p = a.work_patterns ?? [];
  if (p.includes("retail")) return "retail";
  if (p.includes("production")) return "manufacturing";
  if (p.includes("project")) return "projects";
  if (p.includes("order")) return "products";
  if (p.includes("service") || p.includes("recurring")) return "services";
  return "mixed";
}

function workDeliveryOf(a: DraftAnswers): WorkspaceBlueprint["profile"]["workDelivery"] {
  const map: Record<
    string,
    "site_work" | "projects" | "continuous_operations" | "orders" | "appointments"
  > = {
    project: "projects",
    service: "appointments",
    order: "orders",
    retail: "orders",
    production: "continuous_operations",
    recurring: "continuous_operations",
    mixed: "projects",
  };
  const out = [...new Set((a.work_patterns ?? []).map((p) => map[p]!))];
  return out.length > 0 ? out : ["projects"];
}

const LOCATION_COUNT: Record<string, number> = { "1": 1, "2-3": 2, "4-10": 4, "10+": 10 };

/** Naive english pluralisation (the S8 convention; refinable in Settings). */
function pluralizeEn(term: string): string {
  if (/[sxz]$|[cs]h$/i.test(term)) return `${term}es`;
  if (/[^aeiou]y$/i.test(term)) return `${term.slice(0, -1)}ies`;
  return `${term}s`;
}

export class BlueprintMapError extends Error {
  constructor(public readonly missing: string[]) {
    super(`answers incomplete for blueprint: ${missing.join(", ")}`);
    this.name = "BlueprintMapError";
  }
}

/**
 * Build the H14 blueprint from a complete draft. `now` is passed in so the
 * mapping stays a pure function (the confirm chain passes the real time).
 */
export function buildBlueprintFromDraft(data: DraftData, now: string): WorkspaceBlueprint {
  const a = data.answers;
  const missing: string[] = [];
  if (!a.country) missing.push("country");
  if (!a.base_currency) missing.push("base_currency");
  if (!a.preferred_language) missing.push("preferred_language");
  if (!a.timezone) missing.push("timezone");
  if (!a.employees_band) missing.push("employees_band");
  const templateKey = data.template.selected_key;
  const manifest = templateKey ? TEMPLATES[templateKey] : undefined;
  if (!manifest) missing.push("template");
  if (missing.length > 0) throw new BlueprintMapError(missing);

  const modules = modulesForDraft(data);
  const roles = recommendRoles(a, modules);
  const agents = recommendAgents(a, modules, roles, data.workspace);

  const prov = (reasonEn: string, reasonAr: string) => ({
    source: "onboarding_answer" as const,
    proposedBy: "onboarding",
    proposedAt: now,
    reason: { en: reasonEn, ar: reasonAr },
  });

  // Terminology: the founder's typed term (the S8 typed-vs-blank law).
  const typedEn = data.terms.job_term_en?.trim();
  const typedAr = data.terms.job_term_ar?.trim();
  const tplJobEn = manifest!.terminology?.job?.en?.singular ?? "Job";
  const tplJobAr = manifest!.terminology?.job?.ar?.singular ?? "مهمة";
  const tplJobGender = (manifest!.terminology?.job?.ar?.gender ?? "m") as "m" | "f";
  const jobEn = typedEn || tplJobEn;
  const jobAr = typedAr || tplJobAr;
  const overrides: WorkspaceBlueprint["terminology"]["overrides"] =
    typedEn || typedAr
      ? {
          job: {
            en: { singular: jobEn, plural: pluralizeEn(jobEn) },
            ar: { singular: jobAr, plural: jobAr, gender: tplJobGender },
          },
        }
      : {};

  // Workflow from the selected template's stage set (the shipped source).
  const stages = manifest!.stage_template.stages.map((s) => ({
    key: s.stage_key,
    name: { en: s.names.en, ar: s.names.ar },
    weight: s.weight,
    phaseSemantic: s.phase_semantic,
  }));
  const transitions = stages.slice(0, -1).map((s, i) => ({ from: s.key, to: stages[i + 1]!.key }));

  const roleNames = (archetype: string) => {
    const edited = data.workspace.role_names?.[archetype];
    const base = ROLE_DEFAULT_NAMES[archetype]!;
    return {
      en: edited?.en?.trim() || base.en,
      ar: edited?.ar?.trim() || base.ar,
    };
  };

  const enabledSet = new Set(modules.filter((m) => m.enabled).map((m) => m.key));
  const focus = a.priority_focus ?? "delivery";
  const ownerCards: Array<{ key: string; whyEn: string; whyAr: string }> = [];
  if (focus === "collections" && enabledSet.has("cap.invoicing")) {
    ownerCards.push({
      key: "collections",
      whyEn: "You chose collections as your main focus",
      whyAr: "اخترت التحصيل تركيزاً رئيسياً",
    });
  }
  ownerCards.push(
    {
      key: "needs_decision",
      whyEn: "Decisions waiting on you block the team",
      whyAr: "القرارات المعلقة عليك توقف الفريق",
    },
    {
      key: "at_risk",
      whyEn: "Work at risk is cheapest to fix early",
      whyAr: "معالجة العمل المتعثر مبكراً أوفر",
    },
  );

  const dashboards: WorkspaceBlueprint["dashboards"] = [
    {
      archetype: "owner",
      outcomes: [{ en: "Know what needs your attention first", ar: "اعرف ما يحتاج انتباهك أولاً" }],
      cards: ownerCards
        .slice(0, 3)
        .map((c) => ({ key: c.key as never, why: { en: c.whyEn, ar: c.whyAr } })),
      attentionSignals: ["at_risk" as never],
      decisionsRequired: ["needs_decision" as never],
      exceptions: [],
      timeHorizon: "today",
      provenance: prov(
        "Built from your management priority answer",
        "بنيت من إجابتك عن أولوية الإدارة",
      ),
    },
  ];
  if (roles.some((r) => r.archetype === "manager")) {
    dashboards.push({
      archetype: "manager",
      outcomes: [{ en: "Keep delivery moving every day", ar: "إبقاء التنفيذ متحركاً كل يوم" }],
      cards: [
        ...(enabledSet.has("cap.daily_reports")
          ? [
              {
                key: "reports_to_review" as never,
                why: {
                  en: "Field reports wait for your review",
                  ar: "تقارير الميدان تنتظر مراجعتك",
                },
              },
              {
                key: "missing_today" as never,
                why: { en: "A missing report hides a problem", ar: "التقرير الغائب يخفي مشكلة" },
              },
            ]
          : []),
        {
          key: "blockers" as never,
          why: { en: "Blocked work needs unblocking first", ar: "العمل المتوقف يحتاج حلاً أولاً" },
        },
        {
          key: "overdue" as never,
          why: { en: "Overdue work slips further silently", ar: "العمل المتأخر يزداد تأخراً بصمت" },
        },
      ],
      attentionSignals: ["blockers" as never],
      decisionsRequired: [],
      exceptions: [],
      timeHorizon: "today",
      provenance: prov("A manager watches daily delivery", "المدير يراقب التنفيذ اليومي"),
    });
  }
  if (roles.some((r) => r.archetype === "foreman")) {
    dashboards.push({
      archetype: "foreman",
      outcomes: [
        { en: "Report today's work before the day ends", ar: "رفع تقرير عمل اليوم قبل نهايته" },
      ],
      cards: [
        {
          key: "my_jobs_today" as never,
          why: { en: "Where your team works today", ar: "أين يعمل فريقك اليوم" },
        },
        {
          key: "submit_daily_report" as never,
          why: { en: "The day is not done without the report", ar: "لا ينتهي اليوم بدون التقرير" },
        },
      ],
      attentionSignals: [],
      decisionsRequired: [],
      exceptions: [],
      timeHorizon: "today",
      provenance: prov("Field-first daily rhythm", "إيقاع ميداني يومي"),
    });
  }
  if (roles.some((r) => r.archetype === "accounts")) {
    dashboards.push({
      archetype: "accounts",
      outcomes: [{ en: "Collect what the business is owed", ar: "تحصيل مستحقات المنشأة" }],
      cards: [
        {
          key: "invoices_to_issue" as never,
          why: { en: "Finished work should be billed", ar: "العمل المنجز يجب أن يُفوتر" },
        },
        {
          key: "overdue_receivables" as never,
          why: { en: "The oldest money needs chasing first", ar: "أقدم المستحقات تُتابع أولاً" },
        },
      ],
      attentionSignals: ["overdue_receivables" as never],
      decisionsRequired: [],
      exceptions: [],
      timeHorizon: "this_week",
      provenance: prov("Invoicing is enabled for this workspace", "الفوترة مفعلة لهذه المنشأة"),
    });
  }
  if (roles.some((r) => r.archetype === "procurement")) {
    dashboards.push({
      archetype: "procurement",
      outcomes: [{ en: "Keep materials moving to the work", ar: "إبقاء المواد تصل إلى العمل" }],
      cards: [
        {
          key: "approved_mrs" as never,
          why: { en: "Approved requests are ready to order", ar: "الطلبات المعتمدة جاهزة للشراء" },
        },
        {
          key: "open_pos" as never,
          why: {
            en: "Open orders need delivery follow-up",
            ar: "أوامر الشراء المفتوحة تحتاج متابعة",
          },
        },
      ],
      attentionSignals: ["approved_mrs" as never],
      decisionsRequired: [],
      exceptions: [],
      timeHorizon: "this_week",
      provenance: prov("Purchasing is enabled for this workspace", "المشتريات مفعلة لهذه المنشأة"),
    });
  }

  return {
    schemaVersion: 1,
    profile: {
      businessModel: businessModelOf(a),
      industries: [industryToken(a.industry)],
      size: a.employees_band!,
      markets: [a.country!],
      customerTypes: (a.customer_types && a.customer_types.length > 0
        ? a.customer_types
        : ["businesses"]) as never,
      workDelivery: workDeliveryOf(a),
      revenueModels: (a.revenue_models && a.revenue_models.length > 0
        ? a.revenue_models
        : ["fixed_price"]) as never,
      operatingMode:
        yes(a.buys_materials) || yes(a.holds_stock)
          ? "physical"
          : askMaterialsStep(a)
            ? "mixed"
            : "digital",
      operatingLocations: LOCATION_COUNT[a.locations_band ?? "1"] ?? 1,
      provenance: prov("From your answers about the business", "من إجاباتك عن المنشأة"),
    },
    capabilities: {
      modules: modules.map((m) => ({
        key: m.key,
        enabled: m.enabled,
        reason: REASON_TEXT[m.reasonKey] ?? { en: "From your answers", ar: "من إجاباتك" },
      })),
      provenance: prov("Chosen from how the business works", "اختيرت من طريقة عمل المنشأة"),
    },
    terminology: {
      overrides,
      fallback: "platform_default",
      provenance: prov("Your words for your work", "كلماتك عن عملك"),
    },
    workflows: [
      {
        id: "job",
        name: { en: jobEn, ar: jobAr },
        stages,
        transitions,
        requiredApprovals: [],
        responsibilities: [],
        exceptionPaths: [],
        versioning: "snapshot_on_creation",
        provenance: prov(
          "Stages from your selected way of working",
          "المراحل من أسلوب العمل الذي اخترته",
        ),
      },
    ],
    roles: roles.map((r) => ({
      archetype: r.archetype,
      name: { en: roleNames(r.archetype).en, ar: roleNames(r.archetype).ar },
      responsibilities: ROLE_RESPONSIBILITIES[r.archetype] ?? { en: "Team member", ar: "عضو فريق" },
      permissionRefs: [...r.permissionRefs],
      navVisibility: [],
      relevantAgents: agents
        .filter((x) => x.relevantRoles.includes(r.archetype))
        .map((x) => x.agentId),
      approvalAuthority: r.approvalAuthority,
      provenance: prov("From your team size and enabled areas", "من حجم فريقك والمجالات المفعلة"),
    })),
    navigation: {
      order: [],
      hidden: [],
      mobileContract: "bottom_bar_role_primary",
      clientAuthority: "none",
      provenance: prov(
        "Standard navigation over your enabled areas",
        "تنقل قياسي فوق مجالاتك المفعلة",
      ),
    },
    dashboards,
    international: {
      countryPack: a.country!,
      defaultLocale: a.preferred_language!,
      currency: a.base_currency!,
      timezone: a.timezone!,
      taxIdentityFields: a.vat_registered_q === "yes" ? ["tax_registration_number"] : [],
      vatRegistered: a.vat_registered_q === "yes",
      provenance: prov(
        "Your country, currency and language choices",
        "اختياراتك للدولة والعملة واللغة",
      ),
    },
    agents: agents.map((x) => ({
      agentId: x.agentId,
      relevantRoles: x.relevantRoles,
      relevantModules: x.relevantModules,
      readDomains: [],
      classifications: ["read_explain"],
      entitlement: "feat.ai_agents",
      provenance: prov(
        "Relevant to your enabled areas; always under your authority",
        "مرتبط بمجالاتك المفعلة، ودائماً تحت صلاحيتك",
      ),
    })),
  };
}

/** Bilingual reason texts embedded into the blueprint (audited provenance).
 * The UI shows richer i18n copy; these are the durable recorded reasons. */
const REASON_TEXT: Record<string, { en: string; ar: string }> = {
  core_work: { en: "Every workspace tracks its work here", ar: "كل منشأة تتابع عملها هنا" },
  core_issues: { en: "Problems need one place to land", ar: "المشكلات تحتاج مكاناً واحداً" },
  core_customers: { en: "Work is done for customers", ar: "العمل يُنجز للعملاء" },
  core_people: { en: "The team works in the workspace", ar: "الفريق يعمل داخل المنشأة" },
  field_reports: {
    en: "Your work happens in the field or workshop",
    ar: "عملك يجري في الميدان أو الورشة",
  },
  no_field_reports: {
    en: "No daily field reporting in your flow",
    ar: "لا تقارير ميدانية يومية في عملك",
  },
  approvals_purchasing: {
    en: "Purchases should be approved before money moves",
    ar: "المشتريات تحتاج اعتماداً قبل تحرك المال",
  },
  approvals_team: {
    en: "A team benefits from clear approvals",
    ar: "الفريق يستفيد من اعتمادات واضحة",
  },
  approvals_off: {
    en: "You work alone; approvals can wait",
    ar: "تعمل وحدك؛ يمكن تأجيل الاعتمادات",
  },
  quotes_on: { en: "You send quotations to customers", ar: "ترسل عروض أسعار لعملائك" },
  quotes_off: { en: "You said you do not send quotations", ar: "قلت إنك لا ترسل عروض أسعار" },
  invoices_on: { en: "You invoice your customers", ar: "تفوتر عملاءك" },
  invoices_safe_default: {
    en: "Most businesses need invoicing; you can turn it off",
    ar: "معظم المنشآت تحتاج الفوترة؛ يمكنك إيقافها",
  },
  invoices_off: { en: "You said you do not send invoices", ar: "قلت إنك لا ترسل فواتير" },
  payments_on: { en: "You record customer payments", ar: "تسجل دفعات العملاء" },
  payments_off: { en: "Payment recording is not needed yet", ar: "تسجيل الدفعات غير مطلوب بعد" },
  expenses_on: { en: "You record business spending", ar: "تسجل مصروفات المنشأة" },
  expenses_off: {
    en: "You said you do not record expenses here",
    ar: "قلت إنك لا تسجل المصروفات هنا",
  },
  costing_on: { en: "You track cost against each piece of work", ar: "تتابع التكلفة لكل عمل" },
  costing_off: { en: "Cost tracking can be enabled later", ar: "يمكن تفعيل تتبع التكلفة لاحقاً" },
  materials_on: { en: "You buy materials for the work", ar: "تشتري مواد للعمل" },
  materials_off: { en: "No material buying in your flow", ar: "لا شراء مواد في عملك" },
  purchasing_on: {
    en: "Purchase orders keep buying accountable",
    ar: "أوامر الشراء تضبط المشتريات",
  },
  purchasing_off: { en: "No purchasing in your flow", ar: "لا مشتريات في عملك" },
  receiving_on: { en: "You receive deliveries against orders", ar: "تستلم توريدات مقابل أوامر" },
  receiving_off: { en: "No delivery receiving in your flow", ar: "لا استلام توريدات في عملك" },
  stock_on: { en: "You hold stock or a catalog of items", ar: "لديك مخزون أو قائمة أصناف" },
  stock_off: { en: "No stock holding in your flow", ar: "لا مخزون في عملك" },
  attendance_on: {
    en: "A working team benefits from attendance",
    ar: "الفريق العامل يستفيد من الحضور",
  },
  attendance_off: { en: "Attendance is not needed yet", ar: "الحضور غير مطلوب بعد" },
  updates_on: { en: "You share progress with customers", ar: "تشارك التقدم مع عملائك" },
  updates_off: { en: "You keep progress internal for now", ar: "تبقي التقدم داخلياً حالياً" },
  founder_enabled: { en: "You switched this on at review", ar: "فعّلته عند المراجعة" },
  founder_disabled: { en: "You switched this off at review", ar: "أوقفته عند المراجعة" },
  dependency_enabled: { en: "Needed by another enabled area", ar: "مطلوب لمجال آخر مفعل" },
  dependency_disabled: { en: "Its requirement was switched off", ar: "متطلبه أُوقف" },
};

export { ROLE_DEFAULT_NAMES, ROLE_RESPONSIBILITIES, REASON_TEXT };
