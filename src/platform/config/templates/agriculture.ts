/**
 * Template — farms & agriculture (crop, livestock and mixed farms). Composed
 * from the shared blocks (holiday calendars, role spine, job-status spine,
 * expense costing spine) and validated against TemplateManifestSchema at build
 * time. The JOB is a "Season Program": stages are generic seasonal activities
 * that cover both cropping and livestock cycles — presets specialise via
 * default_skipped_stage_keys (LVSK skips crop-only post-harvest storage; FMNT
 * is a maintenance job outside the planting→harvest arc). Billing is 100% on
 * acceptance: seasons are internal programs and a selling price is optional.
 */
import type { TemplateManifest } from "../schemas/manifest";
import type { TemplateCatalogueEntry } from "./catalogue";
import {
  L,
  gccHolidayCalendars2026,
  standardRoles,
  standardJobStatuses,
  commonExpenseCategories,
} from "./blocks";

export const TEMPLATE_AGRICULTURE: TemplateManifest = {
  key: "agriculture_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (only keys whose domain language differs) ─────────────────
  terminology: {
    job: {
      en: { singular: "Season Program", plural: "Season Programs" },
      ar: { singular: "برنامج موسمي", plural: "برامج موسمية", gender: "m" },
    },
    job_stage: {
      en: { singular: "Season Activity", plural: "Season Activities" },
      ar: { singular: "نشاط موسمي", plural: "أنشطة موسمية", gender: "m" },
    },
    daily_report: {
      en: { singular: "Field Log", plural: "Field Logs" },
      ar: { singular: "سجل ميداني", plural: "سجلات ميدانية", gender: "m" },
    },
    material_request: {
      en: { singular: "Input Request", plural: "Input Requests" },
      ar: { singular: "طلب مستلزمات", plural: "طلبات مستلزمات", gender: "m" },
    },
    issue: {
      en: { singular: "Incident", plural: "Incidents" },
      ar: { singular: "حادثة", plural: "حوادث", gender: "f" },
    },
    employee: {
      en: { singular: "Farm Worker", plural: "Farm Workers" },
      ar: { singular: "عامل مزرعة", plural: "عمال مزرعة", gender: "m" },
    },
  },

  // ── Stages (generic seasonal arc covering crop AND livestock; Σ=100) ──────
  stage_template: {
    stages: [
      {
        stage_key: "land_housing_prep",
        names: L("Land & Housing Prep", "تجهيز الأرض والحظائر"),
        weight: 12,
        phase_semantic: "preparation",
      },
      {
        stage_key: "planting_stocking",
        names: L("Planting / Stocking", "الزراعة / الإدخال"),
        weight: 18,
        phase_semantic: "production",
      },
      {
        stage_key: "growing_care",
        names: L("Growing & Care", "النمو والرعاية"),
        weight: 34,
        phase_semantic: "production",
      },
      {
        stage_key: "harvest_collection",
        names: L("Harvest / Collection", "الحصاد / الجمع"),
        weight: 20,
        phase_semantic: "production",
      },
      {
        stage_key: "post_harvest_storage",
        names: L("Post-Harvest & Storage", "ما بعد الحصاد والتخزين"),
        weight: 10,
        phase_semantic: "finishing",
      },
      {
        stage_key: "season_close",
        names: L("Season Close", "إغلاق الموسم"),
        weight: 6,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses (spine with seasonal active/done renames) ────────────────
  status_sets: {
    job: standardJobStatuses({
      active: L("In Season", "قيد الموسم"),
      done: L("Season Complete", "اكتمل الموسم"),
    }),
  },

  // ── Category sets ──────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "seeds_seedlings", labels: L("Seeds & Seedlings", "بذور وشتلات"), retired: false },
        { key: "fertilisers", labels: L("Fertilisers", "أسمدة"), retired: false },
        {
          key: "pesticides_sprays",
          labels: L("Pesticides & Sprays", "مبيدات ومواد رش"),
          retired: false,
        },
        { key: "animal_feed", labels: L("Animal Feed", "أعلاف"), retired: false },
        {
          key: "veterinary_supplies",
          labels: L("Veterinary Supplies", "مستلزمات بيطرية"),
          retired: false,
        },
        { key: "fuel_lubricants", labels: L("Fuel & Lubricants", "وقود وزيوت"), retired: false },
        { key: "irrigation_parts", labels: L("Irrigation Parts", "قطع الري"), retired: false },
        { key: "tools_spares", labels: L("Tools & Spares", "عدد وقطع غيار"), retired: false },
        {
          key: "packaging_crates",
          labels: L("Packaging & Crates", "تغليف وصناديق"),
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    expense: commonExpenseCategories([
      {
        key: "seeds_fertiliser",
        labels: L("Seeds & fertiliser", "بذور وأسمدة"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "animal_feed",
        labels: L("Animal feed", "أعلاف"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "veterinary_supplies",
        labels: L("Veterinary supplies", "مستلزمات بيطرية"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "irrigation_water",
        labels: L("Irrigation & water", "الري والمياه"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "equipment_hire",
        labels: L("Equipment hire", "استئجار معدات"),
        costing_mapping: "job_other",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        { key: "produce", labels: L("Produce", "منتجات زراعية"), retired: false },
        { key: "livestock", labels: L("Livestock", "مواشي"), retired: false },
        { key: "services", labels: L("Services", "خدمات"), retired: false },
        { key: "delivery", labels: L("Delivery", "توصيل"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (season doc numbers: CROP-2026-001) ─────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:3}", start: 1 },
  },

  // ── Roles (spine with farm labels; farm manager tracks input costs) ───────
  role_presets: standardRoles(
    {
      owner: L("Farm Owner", "مالك المزرعة"),
      manager: L("Farm Manager", "مدير المزرعة"),
      foreman: L("Field Supervisor", "مشرف حقلي"),
    },
    { managerSeesCosts: true },
  ),

  // ── Job-type presets (billing 100% on acceptance — internal seasons) ──────
  presets: [
    {
      code: "CROP",
      names: L("Crop Season", "موسم زراعي"),
      default_skipped_stage_keys: [],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Full crop season from land prep through planting, growing and harvest to storage and season close / موسم زراعي كامل من تجهيز الأرض حتى الحصاد والتخزين وإغلاق الموسم",
    },
    {
      code: "LVSK",
      names: L("Livestock Cycle", "دورة ثروة حيوانية"),
      default_skipped_stage_keys: ["post_harvest_storage"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Livestock production cycle: housing prep, stocking, growing and care, collection, season close / دورة إنتاج حيواني: تجهيز الحظائر والإدخال والرعاية والجمع وإغلاق الدورة",
    },
    {
      code: "FMNT",
      names: L("Field Maintenance", "صيانة الحقول"),
      default_skipped_stage_keys: [
        "planting_stocking",
        "harvest_collection",
        "post_harvest_storage",
      ],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Standalone field or facility maintenance job outside the cropping calendar / عمل صيانة مستقل للحقول أو المرافق خارج الدورة الزراعية",
    },
  ],

  // ── Custom fields on the job (plot identity + size of the program) ────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "location_plot",
          type: "text",
          labels: L("Location / Plot", "الموقع / القطعة"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "area_or_headcount",
          type: "number",
          labels: L("Area or Headcount", "المساحة أو عدد الرؤوس"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holiday calendars (shared GCC 2026 block; org-editable after install) ─
  holiday_calendars: gccHolidayCalendars2026(),
};

export const TEMPLATE_AGRICULTURE_ENTRY: TemplateCatalogueEntry = {
  key: "agriculture_v1",
  names: L("Farms & Agriculture", "المزارع والزراعة"),
  description: L(
    "Configures the workspace for crop, livestock and mixed farms: season programs with seasonal activity stages, daily field logs with harvest quantities, incident tracking, input purchasing from request to purchase order and goods receipt, expenses and season costing. Built for farm owners and managers who want one place to plan seasons, record daily field work and see what each season really cost.",
    "يهيئ مساحة العمل لمزارع المحاصيل والثروة الحيوانية والمزارع المختلطة: برامج موسمية بمراحل أنشطة، سجلات ميدانية يومية مع كميات الحصاد، متابعة الحوادث، ومشتريات المستلزمات من الطلب إلى أمر الشراء والاستلام، إضافة إلى المصروفات وتكاليف الموسم. صُمم لملاك المزارع ومديريها لتخطيط المواسم وتسجيل العمل الميداني اليومي ومعرفة التكلفة الفعلية لكل موسم.",
  ),
  targetBusinesses: [
    L("Crop farms (vegetables, fodder, dates)", "مزارع المحاصيل (خضروات، أعلاف، تمور)"),
    L(
      "Livestock farms (sheep, goats, camels, poultry)",
      "مزارع الثروة الحيوانية (أغنام، ماعز، إبل، دواجن)",
    ),
    L("Mixed crop and livestock farms", "المزارع المختلطة (محاصيل وثروة حيوانية)"),
    L("Greenhouse and nursery operations", "البيوت المحمية والمشاتل"),
    L("Dairy and poultry production units", "وحدات إنتاج الألبان والدواجن"),
  ],
  classificationPhrases: [
    "we run a vegetable farm in al ain",
    "livestock farm with sheep and goats in riyadh",
    "date palm farm in al ahsa",
    "we operate greenhouses growing tomatoes and cucumbers",
    "poultry farm producing eggs",
    "mixed farm with crops and camels",
    "مزرعة خضروات في العين",
    "مزرعة أغنام وماعز في القصيم",
    "مزرعة نخيل وتمور في الأحساء",
    "بيوت محمية لإنتاج الخضار",
    "مزرعة دواجن لإنتاج البيض",
    "مزرعة مختلطة محاصيل ومواشي",
  ],
  classificationKeywords: [
    "farm",
    "farming",
    "agriculture",
    "crops",
    "livestock",
    "harvest",
    "irrigation",
    "poultry",
    "greenhouse",
    "مزرعة",
    "زراعة",
    "محاصيل",
    "مواشي",
    "حصاد",
    "دواجن",
    "أعلاف",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.issues",
    "cap.approvals",
    "cap.procurement",
    "cap.expenses_costing",
  ],
  optionalModules: ["cap.quoting", "cap.invoicing", "cap.customers", "cap.customer_updates"],
  dashboardDefaults: ["jobs_active", "reports_today", "approvals_pending", "exceptions"],
  limitations: [
    L(
      "No veterinary or animal health-management records — veterinary items are tracked as supplies only",
      "لا يوفر سجلات بيطرية أو إدارة صحية للحيوانات — المستلزمات البيطرية تُتابع كمواد فقط",
    ),
    L(
      "No regulatory or traceability compliance (GlobalG.A.P., organic certification)",
      "لا يشمل الامتثال التنظيمي أو تتبع المنشأ (مثل GlobalG.A.P. أو شهادات المنتجات العضوية)",
    ),
    L(
      "No scientific agronomy: soil analysis, weather data or yield analytics",
      "لا يقدم تحليلات زراعية علمية: تحليل التربة أو بيانات الطقس أو تحليلات الإنتاجية",
    ),
    L(
      "No weighbridge, sensor or farm-equipment integrations",
      "لا توجد تكاملات مع الموازين الجسرية أو أجهزة الاستشعار أو معدات المزرعة",
    ),
  ],
  manifest: TEMPLATE_AGRICULTURE,
};
