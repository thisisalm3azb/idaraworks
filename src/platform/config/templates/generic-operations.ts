/**
 * Template — Generic Operations (the neutral fallback). Installed when no
 * industry template matches the founder's business: strictly plain vocabulary
 * (organization, customers, projects, stages, tasks, employees, suppliers) and
 * a balanced 5-stage planning → execution → finalization → review → handover
 * spine. Composed from the shared blocks so the spine artifacts (roles,
 * statuses, expense costing, GCC calendars) cannot drift; validated against
 * TemplateManifestSchema at build time.
 */
import type { TemplateManifest } from "../schemas/manifest";
import type { TemplateCatalogueEntry } from "./catalogue";
import {
  L,
  commonExpenseCategories,
  gccHolidayCalendars2026,
  standardJobStatuses,
  standardRoles,
} from "./blocks";

export const TEMPLATE_GENERIC_OPERATIONS: TemplateManifest = {
  key: "generic_operations_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology — platform defaults are already neutral; only the core
  // object term changes: a generic org runs "Projects", not "Jobs". ──────────
  terminology: {
    job: {
      en: { singular: "Project", plural: "Projects" },
      ar: { singular: "مشروع", plural: "مشاريع", gender: "m" },
    },
  },

  // ── Stages (5, balanced; Σ=100) ────────────────────────────────────────────
  stage_template: {
    stages: [
      {
        stage_key: "planning",
        names: L("Planning", "التخطيط"),
        weight: 15,
        phase_semantic: "preparation",
      },
      {
        stage_key: "execution",
        names: L("Execution", "التنفيذ"),
        weight: 45,
        phase_semantic: "production",
      },
      {
        stage_key: "finalization",
        names: L("Finalization", "اللمسات النهائية"),
        weight: 15,
        phase_semantic: "finishing",
      },
      {
        stage_key: "review",
        names: L("Review", "المراجعة"),
        weight: 15,
        phase_semantic: "verification",
      },
      {
        stage_key: "handover",
        names: L("Handover", "التسليم"),
        weight: 10,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses — the standard spine needs no domain renames here ─────────
  status_sets: {
    job: standardJobStatuses(),
  },

  // ── Category sets ──────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "general_materials", labels: L("General materials", "مواد عامة"), retired: false },
        {
          key: "office_admin_supplies",
          labels: L("Office & admin supplies", "مستلزمات مكتبية وإدارية"),
          retired: false,
        },
        { key: "equipment", labels: L("Equipment", "معدات"), retired: false },
        { key: "consumables", labels: L("Consumables", "مواد استهلاكية"), retired: false },
        { key: "spare_parts", labels: L("Spare parts", "قطع غيار"), retired: false },
        { key: "services", labels: L("Services", "خدمات"), retired: false },
        { key: "packaging", labels: L("Packaging", "مواد تغليف"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Spine only — a generic org has no domain-specific expense lines.
    expense: commonExpenseCategories(),
    quote_section: {
      kind: "quote_section",
      categories: [
        { key: "services", labels: L("Services", "خدمات"), retired: false },
        { key: "materials", labels: L("Materials", "مواد"), retired: false },
        { key: "equipment", labels: L("Equipment", "معدات"), retired: false },
        { key: "delivery", labels: L("Delivery", "التوصيل"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (neutral doc numbers: PRJ-2026-001) ─────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:3}", start: 1 },
  },

  // ── Role presets — the standard 7-role spine, neutral labels as shipped ───
  role_presets: standardRoles(),

  // ── Project-type presets ───────────────────────────────────────────────────
  presets: [
    {
      code: "PRJ",
      names: L("Standard Project", "مشروع قياسي"),
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 50 },
        { trigger: { stage_key: "handover" }, pct: 50 },
      ],
      description: "Standard customer project billed 50% on acceptance and 50% on handover.",
    },
    {
      code: "JOB",
      names: L("Small Job", "عمل صغير"),
      default_skipped_stage_keys: [],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description: "Small, short-duration job billed in full on acceptance.",
    },
    {
      code: "INT",
      names: L("Internal Work", "عمل داخلي"),
      default_skipped_stage_keys: [],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description: "Internal work for the organization itself, typically with no selling price.",
    },
  ],

  // ── Custom fields — one neutral cross-reference field ─────────────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "reference_code",
          type: "text",
          labels: L("Reference code", "الرقم المرجعي"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holiday calendars (shared GCC 2026 block; org-editable after install) ──
  holiday_calendars: gccHolidayCalendars2026(),
};

export const TEMPLATE_GENERIC_OPERATIONS_ENTRY: TemplateCatalogueEntry = {
  key: "generic_operations_v1",
  names: L("Generic Operations", "العمليات العامة"),
  description: {
    en: "A neutral starting point for any organization that runs customer projects or internal work through clear stages. It configures projects with weighted stages, daily reports, issues and approvals, purchasing from material request to goods receipt, expenses and project costing, plus quotes, invoices and manual payments. When a specialised template fits your industry, choose that instead.",
    ar: "نقطة انطلاق محايدة لأي منشأة تنفذ مشاريع لعملائها أو أعمالاً داخلية عبر مراحل واضحة. يهيئ هذا القالب المشاريع بمراحل موزونة، مع التقارير اليومية والملاحظات والموافقات، والمشتريات من طلب المواد حتى استلام البضاعة، والمصروفات وتكاليف المشاريع، إضافة إلى عروض الأسعار والفواتير والدفعات اليدوية. وإذا توفر قالب متخصص يناسب نشاطك فاختره بدلاً من هذا القالب.",
  },
  targetBusinesses: [
    L("General trading and services companies", "شركات التجارة العامة والخدمات"),
    L(
      "Project-based teams without a specialised template",
      "الفرق العاملة بنظام المشاريع دون قالب متخصص",
    ),
    L("Maintenance and facilities service providers", "مزودو خدمات الصيانة والمرافق"),
    L("Consultancies and professional service offices", "مكاتب الاستشارات والخدمات المهنية"),
    L("Small operations and back-office teams", "فرق التشغيل والأعمال المساندة الصغيرة"),
  ],
  classificationPhrases: [
    "we run a general services company in dubai",
    "small operations team handling client projects",
    "we manage projects for customers and need simple tracking",
    "general trading and services in riyadh",
    "we do maintenance work for offices and buildings",
    "nothing here matches our business exactly",
    "شركة خدمات عامة في أبوظبي",
    "ننفذ مشاريع متنوعة لعملائنا",
    "مؤسسة تجارة عامة وخدمات في الرياض",
    "فريق تشغيل صغير يدير أعمالاً متنوعة",
    "نحتاج نظاماً بسيطاً لمتابعة المشاريع والمصروفات",
    "أعمال صيانة وخدمات للشركات",
  ],
  classificationKeywords: [
    "general services",
    "general trading",
    "operations",
    "projects",
    "maintenance",
    "client projects",
    "خدمات عامة",
    "تجارة عامة",
    "مشاريع",
    "عمليات",
    "صيانة",
    "أعمال متنوعة",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.issues",
    "cap.approvals",
    "cap.expenses_costing",
    "cap.customers",
  ],
  optionalModules: ["cap.procurement", "cap.quoting", "cap.invoicing", "cap.customer_updates"],
  dashboardDefaults: ["jobs_active", "reports_today", "approvals_pending", "exceptions"],
  limitations: [
    L(
      "Generic structure — no industry-specific workflows or stage names",
      "هيكل عام لا يتضمن مسارات عمل أو مراحل خاصة بقطاع معين",
    ),
    L(
      "Pick a specialised template instead when one fits your industry",
      "اختر قالباً متخصصاً بدلاً منه متى توفر قالب يناسب نشاطك",
    ),
    L(
      "Terminology is intentionally plain: projects, stages, tasks",
      "المصطلحات بسيطة عن قصد: مشاريع ومراحل ومهام",
    ),
    L(
      "Not a point-of-sale, payroll or full accounting system",
      "ليس نظام نقاط بيع أو رواتب أو محاسبة متكاملة",
    ),
  ],
  manifest: TEMPLATE_GENERIC_OPERATIONS,
};
