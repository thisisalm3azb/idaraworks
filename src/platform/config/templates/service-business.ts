/**
 * Template — Service Business (maintenance, repair, cleaning, technical &
 * field-service teams, consultancies). Composed from the shared blocks
 * (blocks.ts) and validated against TemplateManifestSchema at build time.
 * The JOB is a Service Job moving request → scheduled → on-site → wrap-up →
 * quality check → handover; crews file Field Reports (daily reports) with
 * materials and labour, and the office runs quotes, invoices, expenses,
 * job costing and MR→PO→GRN purchasing.
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

export const TEMPLATE_SERVICE_BUSINESS: TemplateManifest = {
  key: "service_business_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (only keys whose domain language differs) ─────────────────
  terminology: {
    job: {
      en: { singular: "Service Job", plural: "Service Jobs" },
      ar: { singular: "أمر خدمة", plural: "أوامر خدمة", gender: "m" },
    },
    job_stage: {
      en: { singular: "Service Stage", plural: "Service Stages" },
      ar: { singular: "مرحلة الخدمة", plural: "مراحل الخدمة", gender: "f" },
    },
    daily_report: {
      en: { singular: "Field Report", plural: "Field Reports" },
      ar: { singular: "تقرير ميداني", plural: "تقارير ميدانية", gender: "m" },
    },
    employee: {
      en: { singular: "Technician", plural: "Technicians" },
      ar: { singular: "فني", plural: "فنيون", gender: "m" },
    },
    team: {
      en: { singular: "Crew", plural: "Crews" },
      ar: { singular: "طاقم", plural: "طواقم", gender: "m" },
    },
  },

  // ── Stages (request → handover; weights Σ=100) ─────────────────────────────
  stage_template: {
    stages: [
      {
        stage_key: "request_logged",
        names: L("Request Logged", "تسجيل الطلب"),
        weight: 5,
        phase_semantic: "preparation",
      },
      {
        stage_key: "scheduled",
        names: L("Scheduled", "تحديد الموعد"),
        weight: 10,
        phase_semantic: "preparation",
      },
      {
        stage_key: "on_site_service",
        names: L("On Site / In Service", "التنفيذ في الموقع"),
        weight: 45,
        phase_semantic: "production",
      },
      {
        stage_key: "wrap_up",
        names: L("Wrap-up & Site Cleanup", "الإنهاء وترتيب الموقع"),
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
        stage_key: "handover_closed",
        names: L("Handover & Close", "التسليم والإغلاق"),
        weight: 15,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job status set (repair reality: jobs stall on parts) ──────────────────
  status_sets: {
    job: standardJobStatuses({
      active: L("In Service", "قيد الخدمة"),
      done: L("Work Complete", "اكتمل العمل"),
      extraActive: [
        { status_key: "awaiting_parts", labels: L("Awaiting Parts", "بانتظار قطع الغيار") },
      ],
    }),
  },

  // ── Category sets ──────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "spare_parts", labels: L("Spare parts", "قطع غيار"), retired: false },
        { key: "consumables", labels: L("Consumables", "مستهلكات"), retired: false },
        { key: "cleaning_supplies", labels: L("Cleaning supplies", "مواد تنظيف"), retired: false },
        {
          key: "tools_accessories",
          labels: L("Tools & accessories", "عدد وملحقات"),
          retired: false,
        },
        { key: "safety_equipment", labels: L("Safety equipment", "معدات سلامة"), retired: false },
        { key: "electrical_parts", labels: L("Electrical parts", "قطع كهربائية"), retired: false },
        { key: "plumbing_parts", labels: L("Plumbing parts", "قطع سباكة"), retired: false },
        { key: "filters_fluids", labels: L("Filters & fluids", "فلاتر وسوائل"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Spine (materials/labour/outsourced/transport … fuel/tools/rent/other)
    // plus the service-domain direct-cost extras — each carries its costing map.
    expense: commonExpenseCategories([
      {
        key: "spare_parts",
        labels: L("Spare parts", "قطع غيار"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "consumables",
        labels: L("Consumables", "مستهلكات"),
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
        key: "permits_fees",
        labels: L("Permits & fees", "تصاريح ورسوم"),
        costing_mapping: "job_other",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        {
          key: "labour_callout",
          labels: L("Labour & call-out", "أجور العمل والانتقال"),
          retired: false,
        },
        { key: "parts_materials", labels: L("Parts & materials", "قطع ومواد"), retired: false },
        { key: "equipment", labels: L("Equipment", "معدات"), retired: false },
        { key: "transport", labels: L("Transport", "نقل"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (job ticket numbers: SVC-2026-001) ──────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:3}", start: 1 },
  },

  // ── Role presets (service-domain labels; manager sees job costs — the
  //    service manager owns job profitability, prices stay owner/accounts) ───
  role_presets: standardRoles(
    {
      manager: L("Service Manager", "مدير الخدمات"),
      foreman: L("Crew Lead", "رئيس الطاقم"),
    },
    { managerSeesCosts: true },
  ),

  // ── Job-type presets (selectable Service Job types) ────────────────────────
  presets: [
    {
      code: "SVC",
      names: L("Service Call", "بلاغ خدمة"),
      // A single-visit call-out has no separate cleanup stage.
      default_skipped_stage_keys: ["wrap_up"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description: "Single-visit repair or call-out, billed in full on acceptance.",
    },
    {
      code: "MNT",
      names: L("Maintenance Contract Visit", "زيارة عقد صيانة"),
      default_skipped_stage_keys: ["wrap_up"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description: "Scheduled visit under a maintenance contract, covered by the contract terms.",
    },
    {
      code: "INST",
      names: L("Installation Project", "مشروع تركيب"),
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 50 },
        { trigger: { stage_key: "handover_closed" }, pct: 50 },
      ],
      description: "Multi-day installation: 50% on acceptance, 50% on handover.",
    },
    {
      code: "OVHL",
      names: L("Deep Clean / Major Overhaul", "تنظيف عميق / صيانة شاملة"),
      default_skipped_stage_keys: [],
      billing_points: [
        { trigger: "on_acceptance", pct: 50 },
        { trigger: { stage_key: "handover_closed" }, pct: 50 },
      ],
      description: "Large one-off deep clean or overhaul: 50% upfront, 50% on handover.",
    },
  ],

  // ── Custom fields on job (field-service essentials) ────────────────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "service_location",
          type: "text",
          labels: L("Service location", "موقع الخدمة"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "priority",
          type: "select",
          labels: L("Priority", "الأولوية"),
          required: false,
          visibility: [],
          options: [
            { key: "low", labels: L("Low", "منخفضة") },
            { key: "normal", labels: L("Normal", "عادية") },
            { key: "urgent", labels: L("Urgent", "عاجلة") },
          ],
          retired: false,
        },
        {
          field_key: "asset_details",
          type: "text",
          labels: L("Equipment / asset serviced", "المعدة أو الأصل محل الخدمة"),
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

export const TEMPLATE_SERVICE_BUSINESS_ENTRY: TemplateCatalogueEntry = {
  key: "service_business_v1",
  names: L("Service Business", "شركات الخدمات"),
  description: L(
    "Configures IdaraWorks for maintenance, repair, cleaning and technical field-service teams: Service Jobs move from request to handover through scheduling, on-site work and quality check. Crews file Field Reports with materials and labour used, while the office handles quotes, invoices, expenses, job costing, purchasing and customer updates.",
    "يهيئ المنصة لشركات الصيانة والإصلاح والتنظيف وفرق الخدمات الفنية الميدانية: تتنقل أوامر الخدمة من تسجيل الطلب إلى التسليم عبر الجدولة والتنفيذ في الموقع وفحص الجودة. تسجل الطواقم تقارير ميدانية بالمواد والعمالة المستخدمة، بينما يدير المكتب عروض الأسعار والفواتير والمصروفات وتكلفة الأوامر والمشتريات وتحديثات العملاء.",
  ),
  targetBusinesses: [
    L("Maintenance & AC companies", "شركات الصيانة والتكييف"),
    L("Repair workshops", "ورش الإصلاح"),
    L("Cleaning & facility services", "شركات التنظيف وخدمات المرافق"),
    L("Electrical & plumbing contractors", "مقاولو الكهرباء والسباكة"),
    L("Technical & field-service teams", "فرق الخدمات الفنية والميدانية"),
    L("Consultancies & professional services", "المكاتب الاستشارية والخدمات المهنية"),
  ],
  classificationPhrases: [
    "we run an ac maintenance company in dubai",
    "small plumbing and electrical services team",
    "we do villa cleaning contracts in abu dhabi",
    "equipment repair workshop with field technicians",
    "we install and service kitchen equipment",
    "facility maintenance company serving offices",
    "شركة صيانة تكييف في الرياض",
    "ورشة إصلاح معدات مع فنيين ميدانيين",
    "شركة تنظيف فلل ومكاتب في جدة",
    "فريق صيانة كهرباء وسباكة",
    "نقدم خدمات تركيب وصيانة للمطاعم",
    "مكتب خدمات فنية واستشارية",
  ],
  classificationKeywords: [
    "maintenance",
    "repair",
    "cleaning",
    "technician",
    "service call",
    "field service",
    "installation",
    "callout",
    "صيانة",
    "إصلاح",
    "تنظيف",
    "فني",
    "تركيب",
    "خدمات ميدانية",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.issues",
    "cap.customers",
    "cap.quoting",
    "cap.invoicing",
    "cap.expenses_costing",
  ],
  optionalModules: ["cap.approvals", "cap.procurement", "cap.customer_updates"],
  dashboardDefaults: ["jobs_active", "week_plan", "reports_today", "ar_outstanding"],
  limitations: [
    L("No GPS tracking or route optimisation", "لا يوفر تتبع المركبات أو تحسين المسارات"),
    L("No customer self-service booking portal", "لا توجد بوابة حجز ذاتي للعملاء"),
    L("No IoT or asset condition monitoring", "لا يدعم إنترنت الأشياء أو مراقبة حالة الأصول"),
    L(
      "Scheduling is a week view, not a live dispatch board",
      "الجدولة عرض أسبوعي وليست لوحة إرسال فورية",
    ),
  ],
  manifest: TEMPLATE_SERVICE_BUSINESS,
};
