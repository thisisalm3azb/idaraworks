/**
 * Template — Food & Beverage (restaurants, cafés, bakeries, catering, small
 * food production). Composed from the shared blocks (P-TA2); validated against
 * TemplateManifestSchema by the build-time template test. The core JOB is an
 * operational order/run: a catering order, an internal production batch or a
 * full event service, tracked from confirmation through prep, cooking, packing
 * and delivery. Stage weights Σ=100; every preset's billing points Σ=100.
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

export const TEMPLATE_FOOD_BEVERAGE: TemplateManifest = {
  key: "food_beverage_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (only the keys whose domain language differs) ─────────────
  terminology: {
    job: {
      en: { singular: "Order", plural: "Orders" },
      ar: { singular: "طلبية", plural: "طلبيات", gender: "f" },
    },
    job_stage: {
      en: { singular: "Order Stage", plural: "Order Stages" },
      ar: { singular: "مرحلة الطلبية", plural: "مراحل الطلبية", gender: "f" },
    },
    daily_report: {
      en: { singular: "Daily Ops Report", plural: "Daily Ops Reports" },
      ar: { singular: "تقرير التشغيل اليومي", plural: "تقارير التشغيل اليومية", gender: "m" },
    },
    material_request: {
      en: { singular: "Kitchen Requisition", plural: "Kitchen Requisitions" },
      ar: { singular: "طلب مستلزمات المطبخ", plural: "طلبات مستلزمات المطبخ", gender: "m" },
    },
    employee: {
      en: { singular: "Staff Member", plural: "Staff" },
      ar: { singular: "موظف", plural: "موظفون", gender: "m" },
    },
  },

  // ── Stages (order/run lifecycle — weights Σ=100) ───────────────────────────
  stage_template: {
    stages: [
      {
        stage_key: "order_confirmed",
        names: L("Order Confirmed & Prep Plan", "تأكيد الطلبية وخطة التحضير"),
        weight: 10,
        phase_semantic: "preparation",
      },
      {
        stage_key: "ingredient_prep",
        names: L("Ingredient Prep", "تجهيز المكونات"),
        weight: 15,
        phase_semantic: "preparation",
      },
      {
        stage_key: "cooking_production",
        names: L("Cooking & Production", "الطبخ والإنتاج"),
        weight: 35,
        phase_semantic: "production",
      },
      {
        stage_key: "packing_plating",
        names: L("Packing & Plating", "التعبئة والتقديم"),
        weight: 15,
        phase_semantic: "finishing",
      },
      {
        stage_key: "quality_check",
        names: L("Quality Check", "فحص الجودة"),
        weight: 10,
        phase_semantic: "verification",
      },
      {
        stage_key: "delivery_service",
        names: L("Delivery & Service", "التوصيل والخدمة"),
        weight: 15,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses (spine + kitchen renames; delivery is a real state) ──────
  status_sets: {
    job: standardJobStatuses({
      active: L("In Preparation", "قيد التحضير"),
      done: L("Fulfilled", "تم التنفيذ"),
      extraActive: [
        { status_key: "out_for_delivery", labels: L("Out for Delivery", "قيد التوصيل") },
      ],
    }),
  },

  // ── Category sets ──────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "produce", labels: L("Produce", "خضروات وفواكه"), retired: false },
        { key: "dry_goods", labels: L("Dry goods", "مواد جافة"), retired: false },
        { key: "dairy", labels: L("Dairy", "ألبان وأجبان"), retired: false },
        { key: "meat_poultry", labels: L("Meat & poultry", "لحوم ودواجن"), retired: false },
        { key: "seafood", labels: L("Seafood", "مأكولات بحرية"), retired: false },
        { key: "beverages", labels: L("Beverages", "مشروبات"), retired: false },
        {
          key: "bakery_supplies",
          labels: L("Bakery supplies", "مستلزمات المخبوزات"),
          retired: false,
        },
        { key: "packaging", labels: L("Packaging", "مواد تغليف"), retired: false },
        {
          key: "cleaning_supplies",
          labels: L("Cleaning supplies", "مواد تنظيف"),
          retired: false,
        },
        {
          key: "kitchen_equipment",
          labels: L("Kitchen equipment", "معدات مطبخ"),
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Shared expense spine + F&B extras (each carries its F-2 costing mapping;
    // wastage on a specific order/batch is a direct job cost).
    expense: commonExpenseCategories([
      {
        key: "wastage_spoilage",
        labels: L("Wastage & spoilage", "هدر وتلف"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "packaging_disposables",
        labels: L("Packaging & disposables", "تغليف ومستهلكات"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "equipment_rental",
        labels: L("Equipment rental", "تأجير معدات"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "licenses_fees",
        labels: L("Licences & municipality fees", "رخص ورسوم بلدية"),
        costing_mapping: "overhead",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        {
          key: "menu_package",
          labels: L("Menu & catering package", "باقة الطعام والتموين"),
          retired: false,
        },
        {
          key: "beverages_desserts",
          labels: L("Beverages & desserts", "مشروبات وحلويات"),
          retired: false,
        },
        {
          key: "staffing_service",
          labels: L("Staffing & service", "طاقم الخدمة والضيافة"),
          retired: false,
        },
        {
          key: "equipment_rental",
          labels: L("Equipment rental", "تأجير المعدات"),
          retired: false,
        },
        {
          key: "delivery_setup",
          labels: L("Delivery & setup", "التوصيل والتجهيز"),
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (order numbers: CAT-2026-001) ───────────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:3}", start: 1 },
  },

  // ── Role presets (7-role spine with kitchen labels; ops manager sees food
  // cost but not customer pricing) ───────────────────────────────────────────
  role_presets: standardRoles(
    {
      manager: L("Operations Manager", "مدير العمليات"),
      foreman: L("Shift Supervisor", "مشرف الوردية"),
    },
    { managerSeesCosts: true },
  ),

  // ── Job-type presets (selectable order types; billing Σ=100 each) ─────────
  presets: [
    {
      code: "CAT",
      names: L("Catering Order", "طلبية تموين"),
      description:
        "External catering order for a customer or corporate client, billed 50% on confirmation and 50% on delivery.",
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 50 },
        { trigger: { stage_key: "delivery_service" }, pct: 50 },
      ],
    },
    {
      code: "PROD",
      names: L("Production Batch", "دفعة إنتاج"),
      description:
        "Internal production run for stock or branch supply; recorded at full value on confirmation, no delivery stage.",
      default_skipped_stage_keys: ["delivery_service"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
    },
    {
      code: "EVNT",
      names: L("Event Service", "خدمة فعالية"),
      description:
        "Full event service with staffing and on-site setup, billed 40% upfront and 60% at the event service stage.",
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 40 },
        { trigger: { stage_key: "delivery_service" }, pct: 60 },
      ],
    },
  ],

  // ── Custom fields on the order (branch context + event sizing) ────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "branch_location",
          type: "text",
          labels: L("Branch / location", "الفرع أو الموقع"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "guest_count",
          type: "number",
          labels: L("Guest count", "عدد الضيوف"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holiday calendars (shared GCC block; install picks the org's country) ─
  holiday_calendars: gccHolidayCalendars2026(),
};

export const TEMPLATE_FOOD_BEVERAGE_ENTRY: TemplateCatalogueEntry = {
  key: "food_beverage_v1",
  names: L("Food & Beverage", "الأغذية والمشروبات"),
  description: L(
    "Configures IdaraWorks for restaurants, cafés, bakeries, catering companies and small food producers. Catering orders, production batches and event services move through prep, cooking, packing and delivery stages with daily ops reports, service issues and approvals. Kitchen requisitions flow into purchase orders and goods receipts, with ingredient stock categories, wastage and expense tracking, order costing, quotes, invoices and manual payments.",
    "يهيئ النظام للمطاعم والمقاهي والمخابز وشركات التموين ومنتجي الأغذية الصغار. تمر طلبيات التموين ودفعات الإنتاج وخدمات الفعاليات بمراحل التحضير والطبخ والتعبئة والتوصيل مع تقارير تشغيل يومية ومتابعة الملاحظات والاعتمادات. وتتحول طلبات مستلزمات المطبخ إلى أوامر شراء وسندات استلام، مع تصنيفات مخزون المكونات وتتبع الهدر والمصروفات وتكلفة الطلبيات وعروض الأسعار والفواتير والدفعات اليدوية.",
  ),
  targetBusinesses: [
    L("Restaurants & cafés", "المطاعم والمقاهي"),
    L("Bakeries & sweet shops", "المخابز ومحلات الحلويات"),
    L("Catering companies", "شركات التموين والضيافة"),
    L("Central & cloud kitchens", "المطابخ المركزية والسحابية"),
    L("Small food production workshops", "ورش إنتاج الأغذية الصغيرة"),
  ],
  classificationPhrases: [
    "we run a catering company in dubai",
    "small bakery in sharjah making cakes and pastries",
    "restaurant with two branches in riyadh",
    "we prepare daily meal boxes for offices",
    "cloud kitchen taking catering orders",
    "café serving breakfast and specialty coffee",
    "مطعم مأكولات بحرية في جدة",
    "شركة تموين حفلات وأعراس",
    "مخبز ينتج معجنات وحلويات يومياً",
    "مقهى في الرياض يقدم قهوة مختصة",
    "مطبخ مركزي يجهز وجبات للشركات",
    "نجهز ولائم ومناسبات في أبوظبي",
  ],
  classificationKeywords: [
    "restaurant",
    "catering",
    "bakery",
    "cafe",
    "cloud kitchen",
    "food production",
    "meal prep",
    "مطعم",
    "تموين",
    "مخبز",
    "مقهى",
    "مطبخ مركزي",
    "وجبات",
    "حلويات",
    "ضيافة",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.issues",
    "cap.procurement",
    "cap.expenses_costing",
    "cap.customers",
  ],
  optionalModules: ["cap.approvals", "cap.quoting", "cap.invoicing", "cap.customer_updates"],
  dashboardDefaults: ["jobs_active", "reports_today", "exceptions", "week_plan"],
  limitations: [
    L(
      "Not a POS or till system — in-store sales are not processed here",
      "ليس نظام نقاط بيع — لا تُعالج مبيعات الصالة هنا",
    ),
    L(
      "No online-ordering or delivery-app integrations",
      "لا يوجد تكامل مع تطبيقات الطلب أو التوصيل",
    ),
    L("No recipe or nutrition engineering", "لا يشمل هندسة الوصفات أو حسابات التغذية"),
    L(
      "Stock is tracked at category level, without batch or expiry traceability",
      "يُتابع المخزون على مستوى التصنيفات دون تتبع الدفعات أو تواريخ الانتهاء",
    ),
  ],
  manifest: TEMPLATE_FOOD_BEVERAGE,
};
