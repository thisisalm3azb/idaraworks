/**
 * Template #1 — boat-building / marine fabrication (doc 08, verbatim content).
 * Code-shipped, platform-versioned; validated against TemplateManifestSchema by
 * a build-time unit test (doc 07 tooling: a broken template fails the build,
 * never an install). Category lists are reconciled against the Najolatech
 * constants (doc 08 note): 17 item categories, 13 expense categories with the
 * audit F-2 costing mappings, 9 quote sections. Stage weights are the
 * production-proven values (Σ=100).
 */
import type { TemplateManifest } from "../schemas/manifest";

const L = (en: string, ar: string) => ({ en, ar });

export const TEMPLATE_BOATBUILDING: TemplateManifest = {
  key: "boatbuilding_marine_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology (doc 08 "Identity & terminology") ─────────────────────────
  terminology: {
    job: {
      en: { singular: "Boat", plural: "Boats" },
      ar: { singular: "قارب", plural: "قوارب", gender: "m" },
    },
    job_stage: {
      en: { singular: "Production Stage", plural: "Production Stages" },
      ar: { singular: "مرحلة الإنتاج", plural: "مراحل الإنتاج", gender: "f" },
    },
    daily_report: {
      en: { singular: "Daily Report", plural: "Daily Reports" },
      ar: { singular: "التقرير اليومي", plural: "التقارير اليومية", gender: "m" },
    },
    material_request: {
      en: { singular: "Material Request", plural: "Material Requests" },
      ar: { singular: "طلب مواد", plural: "طلبات مواد", gender: "m" },
    },
    purchase_order: {
      // The house term, carried deliberately (doc 07/08).
      en: { singular: "LPO", plural: "LPOs" },
      ar: { singular: "أمر شراء", plural: "أوامر شراء", gender: "m" },
    },
    quote: {
      en: { singular: "Quotation", plural: "Quotations" },
      ar: { singular: "عرض سعر", plural: "عروض أسعار", gender: "m" },
    },
    employee: {
      en: { singular: "Worker", plural: "Workers" },
      ar: { singular: "عامل", plural: "عمال", gender: "m" },
    },
    team: {
      en: { singular: "Team", plural: "Teams" },
      ar: { singular: "فريق", plural: "فرق", gender: "m" },
    },
  },

  // ── Stages (doc 08 table — weights production-proven, Σ=100) ──────────────
  stage_template: {
    stages: [
      {
        stage_key: "mould_prep",
        names: L("Mould Prep", "تجهيز القالب"),
        weight: 5,
        phase_semantic: "preparation",
      },
      {
        stage_key: "lamination",
        names: L("Lamination", "التصفيح"),
        weight: 16,
        phase_semantic: "production",
      },
      {
        stage_key: "below_deck_rigging",
        names: L("Below Deck Rigging", "تجهيزات تحت السطح"),
        weight: 10,
        phase_semantic: "production",
      },
      {
        stage_key: "three_part_assembly",
        names: L("3-part Assembly", "التجميع الثلاثي"),
        weight: 12,
        phase_semantic: "production",
      },
      {
        stage_key: "over_deck_assembly",
        names: L("Over Deck Assembly", "تجميع السطح"),
        weight: 12,
        phase_semantic: "production",
      },
      {
        stage_key: "hardware_rigging",
        names: L("Hardware Rigging", "تركيب التجهيزات"),
        weight: 10,
        phase_semantic: "production",
      },
      {
        stage_key: "electrical_rigging",
        names: L("Electrical Rigging", "التمديدات الكهربائية"),
        weight: 10,
        phase_semantic: "production",
      },
      {
        stage_key: "upholstery",
        names: L("Upholstery", "التنجيد"),
        weight: 7,
        phase_semantic: "production",
      },
      {
        stage_key: "finishing_polishing",
        names: L("Finishing & Polishing", "التشطيب والتلميع"),
        weight: 10,
        phase_semantic: "finishing",
      },
      {
        stage_key: "sea_trial",
        names: L("Sea Trial", "التجربة البحرية"),
        weight: 4,
        phase_semantic: "verification",
      },
      {
        stage_key: "delivery",
        names: L("Delivery", "التسليم"),
        weight: 4,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job status set (doc 08 — semantic categories in arrow notation) ───────
  status_sets: {
    job: {
      entity: "job",
      statuses: [
        { status_key: "draft", labels: L("Draft", "مسودة"), semantic_category: "draft", sort: 0 },
        {
          status_key: "in_production",
          labels: L("In Production", "قيد الإنتاج"),
          semantic_category: "active",
          sort: 1,
        },
        {
          status_key: "on_hold",
          labels: L("On Hold — awaiting decision", "متوقف بانتظار قرار"),
          semantic_category: "on_hold",
          sort: 2,
        },
        {
          status_key: "sea_trial",
          labels: L("Sea Trial", "التجربة البحرية"),
          semantic_category: "active",
          sort: 3,
        },
        {
          status_key: "delivered",
          labels: L("Delivered", "تم التسليم"),
          semantic_category: "done",
          sort: 4,
        },
        { status_key: "closed", labels: L("Closed", "مغلق"), semantic_category: "done", sort: 5 },
        {
          status_key: "cancelled",
          labels: L("Cancelled", "ملغى"),
          semantic_category: "cancelled",
          sort: 6,
        },
      ],
    },
  },

  // ── Category sets (verbatim Najolatech constants; F-2 costing mappings) ───
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "fiberglass", labels: L("Fiberglass", "فايبرجلاس"), retired: false },
        { key: "resin", labels: L("Resin", "ريزن"), retired: false },
        { key: "chemicals", labels: L("Chemicals", "مواد كيميائية"), retired: false },
        { key: "core", labels: L("Core", "مواد القلب"), retired: false },
        {
          key: "vacuum_consumables",
          labels: L("Vacuum Consumables", "مستهلكات التفريغ"),
          retired: false,
        },
        { key: "sanding", labels: L("Sanding", "مواد الصنفرة"), retired: false },
        { key: "polishing", labels: L("Polishing", "مواد التلميع"), retired: false },
        { key: "hardware", labels: L("Hardware", "تجهيزات معدنية"), retired: false },
        { key: "assembly_rubber", labels: L("Assembly (Rubber)", "تجميع (مطاط)"), retired: false },
        { key: "piping_fitting", labels: L("Piping and Fitting", "أنابيب ووصلات"), retired: false },
        { key: "fuel", labels: L("Fuel", "وقود"), retired: false },
        { key: "upholstery", labels: L("Upholstery", "تنجيد"), retired: false },
        { key: "lights", labels: L("Lights", "إضاءة"), retired: false },
        { key: "electrical", labels: L("Electrical", "كهرباء"), retired: false },
        { key: "navionics", labels: L("Navionics", "أجهزة ملاحة"), retired: false },
        { key: "stereo", labels: L("Stereo", "نظام صوتي"), retired: false },
        { key: "motors", labels: L("Motors", "محركات"), retired: false },
      ],
    },
    expense: {
      kind: "expense",
      categories: [
        {
          key: "materials",
          labels: L("Materials", "مواد"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "accessories",
          labels: L("Accessories", "ملحقات"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "engines",
          labels: L("Engines", "محركات"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "upholstery",
          labels: L("Upholstery", "تنجيد"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "electrical",
          labels: L("Electrical", "كهرباء"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "paint_finish",
          labels: L("Paint/finish", "دهان وتشطيب"),
          costing_mapping: "job_materials",
          retired: false,
        },
        {
          key: "labour",
          labels: L("Labour", "عمالة"),
          costing_mapping: "job_other",
          retired: false,
        },
        {
          key: "outsourced_work",
          labels: L("Outsourced work", "أعمال خارجية"),
          costing_mapping: "job_other",
          retired: false,
        },
        {
          key: "transport",
          labels: L("Transport", "نقل"),
          costing_mapping: "job_other",
          retired: false,
        },
        { key: "fuel", labels: L("Fuel", "وقود"), costing_mapping: "overhead", retired: false },
        {
          key: "tools",
          labels: L("Tools", "عدد وأدوات"),
          costing_mapping: "overhead",
          retired: false,
        },
        {
          key: "rent_facility",
          labels: L("Rent/facility", "إيجار ومرافق"),
          costing_mapping: "overhead",
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), costing_mapping: "overhead", retired: false },
      ],
    },
    quote_section: {
      kind: "quote_section",
      categories: [
        { key: "boat_package", labels: L("Boat package", "باقة القارب"), retired: false },
        { key: "engine_package", labels: L("Engine package", "باقة المحرك"), retired: false },
        { key: "electronics", labels: L("Electronics", "إلكترونيات"), retired: false },
        { key: "upholstery", labels: L("Upholstery", "تنجيد"), retired: false },
        {
          key: "fishing_accessories",
          labels: L("Fishing accessories", "معدات صيد"),
          retired: false,
        },
        { key: "safety_equipment", labels: L("Safety equipment", "معدات سلامة"), retired: false },
        {
          key: "trailer_transport",
          labels: L("Trailer / transport", "مقطورة ونقل"),
          retired: false,
        },
        { key: "custom_options", labels: L("Custom options", "خيارات خاصة"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (hull numbers: 24C-001) ─────────────────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{seq:3}", start: 1 },
  },

  // ── Role presets (doc 08 — updates the 7 bootstrap role_definition rows) ──
  role_presets: {
    roles: [
      {
        key: "owner",
        archetype: "owner",
        labels: L("Owner", "المالك"),
        cost_privileged: true,
        price_privileged: true,
      },
      {
        key: "admin",
        archetype: "admin",
        labels: L("Admin", "مشرف"),
        cost_privileged: true,
        price_privileged: true,
      },
      // Doc 08: template #1's Manager is the "Workshop Manager" variant —
      // stages/reports M, finance.viewCosts OFF.
      {
        key: "manager",
        archetype: "manager",
        labels: L("Workshop Manager", "مدير الورشة"),
        cost_privileged: false,
        price_privileged: false,
      },
      {
        key: "foreman",
        archetype: "foreman",
        labels: L("Foreman", "مشرف عمال"),
        cost_privileged: false,
        price_privileged: false,
      },
      {
        key: "procurement",
        archetype: "procurement",
        labels: L("Procurement", "مشتريات"),
        cost_privileged: false,
        price_privileged: false,
      },
      // Template #1 routes the Accounts archetype to Najolatech's back-office
      // "Inventory = accountant" duties (doc 08 note).
      {
        key: "accounts",
        archetype: "accounts",
        labels: L("Accounts", "حسابات"),
        cost_privileged: true,
        price_privileged: true,
      },
      {
        key: "viewer",
        archetype: "viewer",
        labels: L("Viewer", "مشاهد"),
        cost_privileged: false,
        price_privileged: false,
      },
    ],
  },

  // ── Job presets (the 9 BoatModels; skips + 60/40 billing per audit F-1) ───
  presets: [
    "13ft Skiff|13S|skip",
    "18ft Skiff|18S|skip",
    "21ft Panga GW|21P|",
    "24ft Catamaran|24C|",
    "27ft Panga GW|27P|",
    "34ft Catamaran|34C|",
    "35ft EQM|35E|",
    "46ft Dustour|D46|",
    "20m Catamaran|20M|",
  ].map((row) => {
    const [name, code, skip] = row.split("|") as [string, string, string];
    return {
      code,
      names: { en: name, ar: name }, // model names are latin product codes at Najolatech
      // Small skiffs skip Upholstery (doc 08).
      default_skipped_stage_keys: skip === "skip" ? ["upholstery"] : [],
      // The real 60/40 contract terms (audit F-1): 60% on acceptance,
      // 40% at the Delivery stage.
      billing_points: [
        { trigger: "on_acceptance" as const, pct: 60 },
        { trigger: { stage_key: "delivery" }, pct: 40 },
      ],
    };
  }),

  // ── Custom fields on job (doc 08: engine_package, colour_scheme) ──────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "engine_package",
          type: "text",
          labels: L("Engine package", "باقة المحرك"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          field_key: "colour_scheme",
          type: "text",
          labels: L("Colour scheme", "نظام الألوان"),
          required: false,
          visibility: [],
          retired: false,
        },
      ],
    },
  },

  // ── Holiday calendars per country (F-41; install picks the org's country) ─
  // 2026 dates; org-editable after install (the calendar is config, not law).
  holiday_calendars: {
    AE: {
      entries: [
        { starts_on: "2026-01-01", label: L("New Year", "رأس السنة"), kind: "public_holiday" },
        {
          starts_on: "2026-03-19",
          ends_on: "2026-03-22",
          label: L("Eid al-Fitr", "عيد الفطر"),
          kind: "eid",
        },
        {
          starts_on: "2026-05-26",
          ends_on: "2026-05-28",
          label: L("Eid al-Adha", "عيد الأضحى"),
          kind: "eid",
        },
        {
          starts_on: "2026-06-16",
          label: L("Islamic New Year", "رأس السنة الهجرية"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-08-25",
          label: L("Prophet's Birthday", "المولد النبوي"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-12-01",
          ends_on: "2026-12-03",
          label: L("National Day", "اليوم الوطني"),
          kind: "public_holiday",
        },
      ],
      ramadan: { starts_on: "2026-02-17", ends_on: "2026-03-18", daily_hours: 6 },
    },
    SA: {
      entries: [
        {
          starts_on: "2026-02-22",
          label: L("Founding Day", "يوم التأسيس"),
          kind: "public_holiday",
        },
        {
          starts_on: "2026-03-19",
          ends_on: "2026-03-22",
          label: L("Eid al-Fitr", "عيد الفطر"),
          kind: "eid",
        },
        {
          starts_on: "2026-05-26",
          ends_on: "2026-05-28",
          label: L("Eid al-Adha", "عيد الأضحى"),
          kind: "eid",
        },
        {
          starts_on: "2026-09-23",
          label: L("National Day", "اليوم الوطني"),
          kind: "public_holiday",
        },
      ],
      ramadan: { starts_on: "2026-02-17", ends_on: "2026-03-18", daily_hours: 6 },
    },
  },
};

/** Shipped templates by key — the closed platform template registry. */
export const TEMPLATES: Record<string, TemplateManifest> = {
  [TEMPLATE_BOATBUILDING.key]: TEMPLATE_BOATBUILDING,
};
