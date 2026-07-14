/**
 * Template — Construction / Contracting (P-TA2 catalogue). Small contractors,
 * fit-out companies, civil works, MEP packages and renovation firms: a JOB is a
 * Project moving through weighted phases from mobilisation to handover, with
 * site reports, material requests, approvals, POs/GRNs, variations and
 * milestone billing. Composed from the shared blocks (roles, statuses, expense
 * spine, GCC calendars) and validated by TemplateManifestSchema at build time.
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

export const TEMPLATE_CONSTRUCTION: TemplateManifest = {
  key: "construction_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (only keys whose domain language differs) ─────────────────
  terminology: {
    job: {
      en: { singular: "Project", plural: "Projects" },
      ar: { singular: "مشروع", plural: "مشاريع", gender: "m" },
    },
    job_stage: {
      en: { singular: "Phase", plural: "Phases" },
      ar: { singular: "مرحلة", plural: "مراحل", gender: "f" },
    },
    daily_report: {
      en: { singular: "Site Report", plural: "Site Reports" },
      ar: { singular: "تقرير موقع", plural: "تقارير موقع", gender: "m" },
    },
    purchase_order: {
      // The GCC contracting house term.
      en: { singular: "LPO", plural: "LPOs" },
      ar: { singular: "أمر شراء", plural: "أوامر شراء", gender: "m" },
    },
    supplier: {
      en: { singular: "Supplier/Subcontractor", plural: "Suppliers/Subcontractors" },
      ar: { singular: "مورد / مقاول باطن", plural: "موردون ومقاولو باطن", gender: "m" },
    },
    employee: {
      en: { singular: "Worker", plural: "Workers" },
      ar: { singular: "عامل", plural: "عمال", gender: "m" },
    },
    quote: {
      en: { singular: "Quotation", plural: "Quotations" },
      ar: { singular: "عرض سعر", plural: "عروض أسعار", gender: "m" },
    },
  },

  // ── Phases (weights favour structure + finishes; Σ = 100) ─────────────────
  stage_template: {
    stages: [
      {
        stage_key: "mobilisation",
        names: L("Mobilisation", "تجهيز الموقع"),
        weight: 5,
        phase_semantic: "preparation",
      },
      {
        stage_key: "civil_structural",
        names: L("Civil & Structural Works", "الأعمال المدنية والإنشائية"),
        weight: 35,
        phase_semantic: "production",
      },
      {
        stage_key: "mep_first_fix",
        names: L("MEP First Fix", "التأسيسات الكهروميكانيكية"),
        weight: 20,
        phase_semantic: "production",
      },
      {
        stage_key: "finishes",
        names: L("Finishes", "أعمال التشطيبات"),
        weight: 28,
        phase_semantic: "finishing",
      },
      {
        stage_key: "snagging",
        names: L("Snagging", "معالجة الملاحظات"),
        weight: 7,
        phase_semantic: "verification",
      },
      {
        stage_key: "handover",
        names: L("Handover", "التسليم النهائي"),
        weight: 5,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses (spine + domain renames) ─────────────────────────────────
  status_sets: {
    job: standardJobStatuses({
      active: L("On Site", "قيد التنفيذ بالموقع"),
      done: L("Handed Over", "تم التسليم"),
    }),
  },

  // ── Category sets ──────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        {
          key: "cement_aggregates",
          labels: L("Cement & aggregates", "أسمنت وركام"),
          retired: false,
        },
        { key: "steel_rebar", labels: L("Steel & rebar", "حديد وحديد تسليح"), retired: false },
        { key: "blockwork", labels: L("Blockwork", "بلوك وطابوق"), retired: false },
        { key: "timber_joinery", labels: L("Timber & joinery", "أخشاب ونجارة"), retired: false },
        {
          key: "electrical_materials",
          labels: L("Electrical materials", "مواد كهربائية"),
          retired: false,
        },
        {
          key: "plumbing_drainage",
          labels: L("Plumbing & drainage", "سباكة وصرف صحي"),
          retired: false,
        },
        { key: "hvac", labels: L("HVAC", "تكييف وتهوية"), retired: false },
        { key: "paint_finishes", labels: L("Paint & finishes", "دهانات وتشطيبات"), retired: false },
        { key: "tiles_flooring", labels: L("Tiles & flooring", "بلاط وأرضيات"), retired: false },
        {
          key: "gypsum_partitions",
          labels: L("Gypsum & partitions", "جبس وقواطع"),
          retired: false,
        },
        { key: "waterproofing", labels: L("Waterproofing", "عزل مائي"), retired: false },
        {
          key: "scaffolding_access",
          labels: L("Scaffolding & access", "سقالات ومعدات وصول"),
          retired: false,
        },
        { key: "safety_equipment", labels: L("Safety equipment", "معدات سلامة"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Shared spine + contracting extras (variations mapped to job costing).
    expense: commonExpenseCategories([
      {
        key: "variations",
        labels: L("Variations", "أوامر تغيير"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "equipment_rental",
        labels: L("Equipment & plant rental", "تأجير معدات وآليات"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "permits_fees",
        labels: L("Permits & government fees", "تصاريح ورسوم حكومية"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "site_facilities",
        labels: L("Site facilities & temporary works", "مرافق الموقع والأعمال المؤقتة"),
        costing_mapping: "job_other",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        { key: "preliminaries", labels: L("Preliminaries", "أعمال تمهيدية"), retired: false },
        {
          key: "civil_structural",
          labels: L("Civil & structural", "أعمال مدنية وإنشائية"),
          retired: false,
        },
        { key: "mep", labels: L("MEP", "أعمال كهروميكانيكية"), retired: false },
        { key: "finishes", labels: L("Finishes", "تشطيبات"), retired: false },
        { key: "variations", labels: L("Variations", "أوامر تغيير"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Project numbers (e.g. FIT-2026-001) ───────────────────────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:3}", start: 1 },
  },

  // ── Roles (PM tracks budget → sees costs; prices stay owner/accounts) ─────
  role_presets: standardRoles(
    {
      manager: L("Project Manager", "مدير مشاريع"),
      foreman: L("Site Supervisor", "مشرف موقع"),
    },
    { managerSeesCosts: true },
  ),

  // ── Project types (milestone billing; each Σ = 100) ───────────────────────
  presets: [
    {
      code: "FIT",
      names: L("Fit-out Project", "مشروع تشطيبات داخلية"),
      description:
        "Interior fit-out of a received shell and core space; structural phase skipped by default.",
      default_skipped_stage_keys: ["civil_structural"],
      billing_points: [
        { trigger: "on_acceptance", pct: 30 },
        { trigger: { stage_key: "finishes" }, pct: 40 },
        { trigger: { stage_key: "handover" }, pct: 30 },
      ],
    },
    {
      code: "CVL",
      names: L("Civil Works", "أعمال مدنية"),
      description: "Civil and structural works package; MEP first fix skipped by default.",
      default_skipped_stage_keys: ["mep_first_fix"],
      billing_points: [
        { trigger: "on_acceptance", pct: 20 },
        { trigger: { stage_key: "civil_structural" }, pct: 50 },
        { trigger: { stage_key: "handover" }, pct: 30 },
      ],
    },
    {
      code: "MEP",
      names: L("MEP Package", "حزمة أعمال كهروميكانيكية"),
      description:
        "Mechanical, electrical and plumbing package under a main contractor; civil and finishes phases skipped.",
      default_skipped_stage_keys: ["civil_structural", "finishes"],
      billing_points: [
        { trigger: "on_acceptance", pct: 30 },
        { trigger: { stage_key: "mep_first_fix" }, pct: 40 },
        { trigger: { stage_key: "handover" }, pct: 30 },
      ],
    },
    {
      code: "REN",
      names: L("Renovation", "ترميم وتجديد"),
      description: "Renovation or refurbishment project running the full phase sequence.",
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 40 },
        { trigger: { stage_key: "finishes" }, pct: 30 },
        { trigger: { stage_key: "handover" }, pct: 30 },
      ],
    },
  ],

  // ── Custom fields on project ───────────────────────────────────────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "site_location",
          type: "text",
          labels: L("Site location", "موقع المشروع"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "contract_reference",
          type: "text",
          labels: L("Contract reference", "مرجع العقد"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holidays (shared GCC calendars; org-editable after install) ───────────
  holiday_calendars: gccHolidayCalendars2026(),
};

export const TEMPLATE_CONSTRUCTION_ENTRY: TemplateCatalogueEntry = {
  key: "construction_v1",
  names: L("Construction & Contracting", "المقاولات والإنشاءات"),
  description: L(
    "Sets up projects that move through weighted phases from mobilisation to handover, with daily site reports, issues and approvals. Built for small contractors and fit-out, civil, MEP and renovation companies that need material requests, purchase orders and goods receipts, expense tracking with project costing, and milestone-based quotations, invoices and payments.",
    "يهيئ المنصة لإدارة مشاريع تمر بمراحل موزونة من تجهيز الموقع حتى التسليم، مع تقارير الموقع اليومية والملاحظات والموافقات. مصمم لصغار المقاولين وشركات التشطيبات والأعمال المدنية والكهروميكانيكية والترميم التي تحتاج طلبات المواد وأوامر الشراء واستلام البضائع، وتتبع المصروفات مع حساب تكاليف المشاريع، وعروض الأسعار والفواتير والدفعات على أساس مراحل الإنجاز.",
  ),
  targetBusinesses: [
    L("Fit-out and interior contracting companies", "شركات التشطيبات والمقاولات الداخلية"),
    L("Small civil works and building contractors", "مقاولو الأعمال المدنية والبناء الصغار"),
    L("MEP contractors and subcontractors", "مقاولو الأعمال الكهروميكانيكية ومقاولو الباطن"),
    L("Renovation and refurbishment companies", "شركات الترميم والتجديد"),
    L(
      "Specialist subcontractors working under main contractors",
      "مقاولو باطن متخصصون يعملون مع المقاول الرئيسي",
    ),
  ],
  classificationPhrases: [
    "we are a fit-out contractor in dubai",
    "small construction company building villas in riyadh",
    "mep subcontractor for commercial buildings",
    "we do office fit-outs and renovation work",
    "civil works contractor doing site packages",
    "we build and renovate villas in sharjah",
    "electrical and plumbing packages under a main contractor",
    "شركة مقاولات صغيرة في جدة",
    "مقاول تشطيبات وديكور داخلي",
    "نعمل في ترميم وصيانة المباني",
    "مقاولات كهروميكانيكية للمباني التجارية",
    "شركة بناء فلل ومجمعات سكنية",
  ],
  classificationKeywords: [
    "contracting",
    "contractor",
    "fit-out",
    "construction",
    "subcontractor",
    "mep",
    "civil works",
    "renovation",
    "snagging",
    "مقاولات",
    "مقاول",
    "تشطيبات",
    "إنشاءات",
    "ترميم",
    "مقاول باطن",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.issues",
    "cap.approvals",
    "cap.procurement",
    "cap.expenses_costing",
    "cap.customers",
  ],
  optionalModules: ["cap.quoting", "cap.invoicing", "cap.customer_updates"],
  dashboardDefaults: ["jobs_active", "reports_today", "approvals_pending", "exceptions"],
  limitations: [
    L(
      "No BIM or CAD tools — drawings and models live outside the platform",
      "لا يشمل أدوات BIM أو CAD، فالمخططات والنماذج تدار خارج المنصة",
    ),
    L(
      "No payroll — labour cost is captured through site reports and expenses only",
      "لا يوجد نظام رواتب، وتُحتسب تكلفة العمالة عبر تقارير الموقع والمصروفات فقط",
    ),
    L("No quantity surveying or BOQ engine", "لا يشمل محرك حصر كميات أو إعداد جداول الكميات"),
    L("No tender or bid management", "لا يشمل إدارة المناقصات والعطاءات"),
    L(
      "Progress is stage-weight based, not earned-value",
      "يُحتسب التقدم على أساس أوزان المراحل وليس القيمة المكتسبة",
    ),
  ],
  manifest: TEMPLATE_CONSTRUCTION,
};
