/**
 * Template — Manufacturing / Workshop (composable template catalogue).
 * The general project-based factory pattern: fabrication, metalwork, joinery,
 * composites and equipment workshops running work orders (أوامر تشغيل) across
 * production stages from design to delivery. Composed from the shared blocks
 * (holiday calendars, role spine, status spine, expense costing spine) and
 * validated against TemplateManifestSchema by the build-time template test.
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

export const TEMPLATE_MANUFACTURING: TemplateManifest = {
  key: "manufacturing_workshop_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (JOB = Work Order / أمر تشغيل) ─────────────────────────────
  terminology: {
    job: {
      en: { singular: "Work Order", plural: "Work Orders" },
      ar: { singular: "أمر تشغيل", plural: "أوامر تشغيل", gender: "m" },
    },
    job_stage: {
      en: { singular: "Production Stage", plural: "Production Stages" },
      ar: { singular: "مرحلة إنتاج", plural: "مراحل الإنتاج", gender: "f" },
    },
    daily_report: {
      en: { singular: "Production Report", plural: "Production Reports" },
      ar: { singular: "تقرير الإنتاج", plural: "تقارير الإنتاج", gender: "m" },
    },
  },

  // ── Stages (design → delivery; weights production-heavy, Σ=100) ────────────
  stage_template: {
    stages: [
      {
        stage_key: "design_prep",
        names: L("Design & Prep", "التصميم والتجهيز"),
        weight: 8,
        phase_semantic: "preparation",
      },
      {
        stage_key: "material_preparation",
        names: L("Material Preparation", "تجهيز المواد"),
        weight: 10,
        phase_semantic: "preparation",
      },
      {
        stage_key: "fabrication",
        names: L("Fabrication", "التصنيع"),
        weight: 30,
        phase_semantic: "production",
      },
      {
        stage_key: "assembly",
        names: L("Assembly", "التجميع"),
        weight: 22,
        phase_semantic: "production",
      },
      {
        stage_key: "surface_finishing",
        names: L("Surface Finishing", "تشطيب الأسطح"),
        weight: 14,
        phase_semantic: "finishing",
      },
      {
        stage_key: "quality_inspection",
        names: L("Quality Inspection", "فحص الجودة"),
        weight: 8,
        phase_semantic: "verification",
      },
      {
        stage_key: "delivery",
        names: L("Delivery", "التسليم"),
        weight: 8,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses (spine with the active status renamed to the shop floor) ──
  status_sets: {
    job: standardJobStatuses({ active: L("In Production", "قيد الإنتاج") }),
  },

  // ── Category sets ───────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "sheet_metal", labels: L("Sheet Metal", "صاج وألواح معدنية"), retired: false },
        { key: "structural_steel", labels: L("Structural Steel", "حديد إنشائي"), retired: false },
        { key: "aluminium", labels: L("Aluminium", "ألمنيوم"), retired: false },
        { key: "fasteners", labels: L("Fasteners", "مثبتات وبراغي"), retired: false },
        {
          key: "welding_consumables",
          labels: L("Welding Consumables", "مستهلكات لحام"),
          retired: false,
        },
        { key: "coatings_paint", labels: L("Coatings & Paint", "دهانات وطلاءات"), retired: false },
        { key: "timber_boards", labels: L("Timber & Boards", "أخشاب وألواح"), retired: false },
        {
          key: "composites_resins",
          labels: L("Composites & Resins", "مواد مركبة وراتنجات"),
          retired: false,
        },
        { key: "machine_parts", labels: L("Machine Parts", "قطع غيار آلات"), retired: false },
        { key: "abrasives", labels: L("Abrasives", "مواد صنفرة وجلخ"), retired: false },
        { key: "gases", labels: L("Gases", "غازات صناعية"), retired: false },
        {
          key: "electrical_components",
          labels: L("Electrical Components", "مكونات كهربائية"),
          retired: false,
        },
        { key: "packaging", labels: L("Packaging", "مواد تغليف"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Expense spine + workshop extras (each extra carries its costing mapping).
    expense: commonExpenseCategories([
      {
        key: "consumables",
        labels: L("Workshop consumables", "مستهلكات الورشة"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "surface_treatment",
        labels: L("Surface treatment", "معالجة الأسطح"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "machine_maintenance",
        labels: L("Machine maintenance", "صيانة الآلات"),
        costing_mapping: "overhead",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        {
          key: "design_engineering",
          labels: L("Design & Engineering", "التصميم والهندسة"),
          retired: false,
        },
        { key: "materials", labels: L("Materials", "المواد"), retired: false },
        {
          key: "fabrication_labour",
          labels: L("Fabrication & Labour", "التصنيع والعمالة"),
          retired: false,
        },
        {
          key: "surface_treatment",
          labels: L("Surface Treatment", "معالجة الأسطح"),
          retired: false,
        },
        {
          key: "assembly_testing",
          labels: L("Assembly & Testing", "التجميع والاختبار"),
          retired: false,
        },
        {
          key: "delivery_installation",
          labels: L("Delivery & Installation", "التسليم والتركيب"),
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (work-order numbers: WO-2026-0001) ───────────────────
  reference_patterns: {
    job: { pattern: "WO-{year}-{seq:4}", start: 1 },
  },

  // ── Role presets (shop-floor labels; manager money-visibility stays off) ───
  role_presets: standardRoles({
    manager: L("Production Manager", "مدير الإنتاج"),
    foreman: L("Foreman", "مشرف الورشة"),
  }),

  // ── Job-type presets (selectable work-order types, not seeded data) ────────
  presets: [
    {
      code: "FAB",
      names: L("Custom Fabrication", "تصنيع حسب الطلب"),
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 50 },
        { trigger: { stage_key: "delivery" }, pct: 50 },
      ],
      description:
        "One-off fabrication to customer drawings; billed 50% on acceptance and 50% on delivery.",
    },
    {
      code: "BATCH",
      names: L("Batch Production", "إنتاج بالدفعات"),
      // Repeat runs of an established product — drawings already exist.
      default_skipped_stage_keys: ["design_prep"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Repeat production run of an established product; the design stage is skipped by default.",
    },
    {
      code: "REP",
      names: L("Repair & Rework", "إصلاح وإعادة تصنيع"),
      default_skipped_stage_keys: ["design_prep"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description: "Repair or rework of customer equipment; billed in full on acceptance.",
    },
    {
      code: "ASSY",
      names: L("Assembly Order", "أمر تجميع"),
      // Assembling supplied or purchased parts — no in-house fabrication.
      default_skipped_stage_keys: ["fabrication"],
      billing_points: [
        { trigger: "on_acceptance", pct: 40 },
        { trigger: { stage_key: "delivery" }, pct: 60 },
      ],
      description:
        "Assembly of supplied or purchased parts into a finished unit; the fabrication stage is skipped by default.",
    },
  ],

  // ── Custom fields on the work order ────────────────────────────────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "drawing_reference",
          type: "text",
          labels: L("Drawing reference", "مرجع الرسم الفني"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "material_grade",
          type: "text",
          labels: L("Material grade", "درجة المادة"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holiday calendars (shared GCC block; install picks the org's country) ──
  holiday_calendars: gccHolidayCalendars2026(),
};

export const TEMPLATE_MANUFACTURING_ENTRY: TemplateCatalogueEntry = {
  key: TEMPLATE_MANUFACTURING.key,
  names: L("Manufacturing & Workshop", "التصنيع والورش الصناعية"),
  description: L(
    "Configures IdaraWorks for project-based manufacturing and industrial workshops: work orders tracked across production stages from design and material preparation through fabrication, assembly and surface finishing to a quality-inspection sign-off and delivery. Includes daily production reports, issues and approvals, material requests through purchase orders and goods receipts, an item catalogue with stock categories, expenses and work-order costing, quotes, invoices, manual payments and customer updates. This is the general workshop pattern that IdaraWorks' more specialised production templates are refinements of.",
    "يهيئ هذا القالب المنصة للتصنيع القائم على المشاريع والورش الصناعية: أوامر تشغيل تُتابع عبر مراحل الإنتاج من التصميم وتجهيز المواد مروراً بالتصنيع والتجميع وتشطيب الأسطح وصولاً إلى اعتماد فحص الجودة والتسليم. يشمل تقارير الإنتاج اليومية والمشكلات والاعتمادات وطلبات المواد وأوامر الشراء وسندات الاستلام وفهرس الأصناف وفئات المخزون والمصروفات وتكاليف أوامر التشغيل وعروض الأسعار والفواتير والدفعات اليدوية وتحديثات العملاء. وهو النمط العام للورش الذي تُبنى عليه قوالب الإنتاج الأكثر تخصصاً في المنصة.",
  ),
  targetBusinesses: [
    L("Metal fabrication and welding workshops", "ورش تصنيع المعادن واللحام"),
    L("Joinery and carpentry workshops", "ورش النجارة والأعمال الخشبية"),
    L("Aluminium and glass fabricators", "ورش تصنيع الألمنيوم والزجاج"),
    L("Equipment and machinery manufacturers", "مصنعو المعدات والآلات"),
    L("Composites and GRP product workshops", "ورش المواد المركبة والراتنجات"),
    L(
      "Project-based factories and industrial workshops",
      "المصانع القائمة على المشاريع والورش الصناعية",
    ),
  ],
  classificationPhrases: [
    "we run a steel fabrication workshop in dammam",
    "custom metalwork and welding shop in sharjah",
    "we manufacture stainless steel kitchens to order",
    "aluminium and glass fabrication company in riyadh",
    "joinery workshop making custom doors and furniture",
    "we build industrial equipment to order",
    "small factory doing made-to-order production runs",
    "ورشة تصنيع معادن ولحام في جدة",
    "مصنع أبواب وشبابيك ألمنيوم",
    "ورشة نجارة تصنع أثاثاً حسب الطلب",
    "مصنع معدات صناعية حسب الطلب",
    "ورشة حدادة وتشكيل معادن في الرياض",
  ],
  classificationKeywords: [
    "fabrication",
    "metalwork",
    "welding",
    "workshop",
    "joinery",
    "machining",
    "sheet metal",
    "manufacturing",
    "تصنيع",
    "ورشة",
    "لحام",
    "حدادة",
    "نجارة",
    "معادن",
    "مصنع",
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
      "No MRP or BOM explosion — materials are requested and costed per work order",
      "لا يوفر تخطيط متطلبات المواد أو تفكيك قوائم المواد — تُطلب المواد وتُحتسب تكلفتها لكل أمر تشغيل",
    ),
    L(
      "No capacity or machine-load planning",
      "لا يوفر تخطيط الطاقة الإنتاجية أو جدولة تحميل الآلات",
    ),
    L(
      "No machine or CNC integration — does not connect to shop-floor equipment",
      "لا يتكامل مع الآلات أو ماكينات التحكم الرقمي",
    ),
    L(
      "No serial or lot traceability on stock items",
      "لا يتتبع الأرقام التسلسلية أو دفعات أصناف المخزون",
    ),
    L(
      "Quality checks are stage sign-offs, not statistical process control",
      "فحوصات الجودة اعتمادات مرحلية وليست ضبطاً إحصائياً للعمليات",
    ),
  ],
  manifest: TEMPLATE_MANUFACTURING,
};
