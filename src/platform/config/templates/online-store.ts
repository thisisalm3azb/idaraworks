/**
 * Template — Online Store / E-commerce (template catalogue). The JOB is a
 * customer order tracked from confirmation through sourcing, picking & packing
 * and dispatch to delivery. Composed from the shared blocks (role spine, job
 * status spine, expense costing spine, GCC 2026 calendars) and validated
 * against TemplateManifestSchema by the build-time template test — a broken
 * template fails the build, never an install.
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

export const TEMPLATE_ONLINE_STORE: TemplateManifest = {
  key: "online_store_v1",
  version: 1,
  object_kind: "job",

  // ── Terminology — the core object is an Order ─────────────────────────────
  terminology: {
    job: {
      en: { singular: "Order", plural: "Orders" },
      ar: { singular: "طلب", plural: "طلبات", gender: "m" },
    },
    job_stage: {
      en: { singular: "Fulfilment Stage", plural: "Fulfilment Stages" },
      ar: { singular: "مرحلة التجهيز", plural: "مراحل التجهيز", gender: "f" },
    },
    material_request: {
      en: { singular: "Stock Request", plural: "Stock Requests" },
      ar: { singular: "طلب توفير مخزون", plural: "طلبات توفير مخزون", gender: "m" },
    },
    quote: {
      en: { singular: "Quotation", plural: "Quotations" },
      ar: { singular: "عرض سعر", plural: "عروض أسعار", gender: "m" },
    },
  },

  // ── Fulfilment stages (Σ = 100) ───────────────────────────────────────────
  stage_template: {
    stages: [
      {
        stage_key: "order_confirmed",
        names: L("Order Confirmed", "تأكيد الطلب"),
        weight: 10,
        phase_semantic: "preparation",
      },
      {
        stage_key: "sourcing_allocation",
        names: L("Sourcing & Allocation", "التوريد وتخصيص المخزون"),
        weight: 25,
        phase_semantic: "production",
      },
      {
        stage_key: "picking_packing",
        names: L("Picking & Packing", "التجهيز والتغليف"),
        weight: 30,
        phase_semantic: "production",
      },
      {
        stage_key: "dispatch",
        names: L("Dispatch", "الشحن"),
        weight: 15,
        phase_semantic: "finishing",
      },
      {
        stage_key: "delivered",
        names: L("Delivered", "التسليم"),
        weight: 10,
        phase_semantic: "verification",
      },
      {
        stage_key: "closed",
        names: L("Order Closed", "إغلاق الطلب"),
        weight: 10,
        phase_semantic: "handover",
      },
    ],
  },

  // ── Job statuses — standard spine with order language ─────────────────────
  status_sets: {
    job: standardJobStatuses({
      active: L("Processing", "قيد التجهيز"),
      done: L("Fulfilled", "تم التسليم"),
    }),
  },

  // ── Category sets ─────────────────────────────────────────────────────────
  category_sets: {
    item: {
      kind: "item",
      categories: [
        { key: "mobile_phones", labels: L("Mobile Phones", "هواتف محمولة"), retired: false },
        {
          key: "tablets_computers",
          labels: L("Tablets & Computers", "أجهزة لوحية وحواسيب"),
          retired: false,
        },
        { key: "accessories", labels: L("Accessories", "إكسسوارات"), retired: false },
        { key: "audio", labels: L("Audio", "أجهزة صوتية"), retired: false },
        { key: "wearables", labels: L("Wearables", "أجهزة قابلة للارتداء"), retired: false },
        {
          key: "home_electronics",
          labels: L("Home Electronics", "إلكترونيات منزلية"),
          retired: false,
        },
        { key: "spare_parts", labels: L("Spare Parts", "قطع غيار"), retired: false },
        { key: "packaging", labels: L("Packaging", "مواد تغليف"), retired: false },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
    // Shared expense spine + store-specific extras (each carries its F-2
    // costing mapping: per-order costs → job_*, shop running costs → overhead).
    expense: commonExpenseCategories([
      {
        key: "packaging_supplies",
        labels: L("Packaging supplies", "مستلزمات التغليف"),
        costing_mapping: "job_materials",
        retired: false,
      },
      {
        key: "shipping_delivery",
        labels: L("Shipping & delivery", "شحن وتوصيل"),
        costing_mapping: "job_other",
        retired: false,
      },
      {
        key: "marketing_ads",
        labels: L("Marketing & advertising", "تسويق وإعلانات"),
        costing_mapping: "overhead",
        retired: false,
      },
      {
        key: "payment_fees",
        labels: L("Bank & card fees", "رسوم بنكية ورسوم بطاقات"),
        costing_mapping: "overhead",
        retired: false,
      },
    ]),
    quote_section: {
      kind: "quote_section",
      categories: [
        { key: "products", labels: L("Products", "المنتجات"), retired: false },
        { key: "delivery", labels: L("Delivery", "التوصيل"), retired: false },
        {
          key: "installation_setup",
          labels: L("Installation & setup", "التركيب والتشغيل"),
          retired: false,
        },
        {
          key: "extended_warranty",
          labels: L("Extended warranty", "الضمان الممتد"),
          retired: false,
        },
        { key: "other", labels: L("Other", "أخرى"), retired: false },
      ],
    },
  },

  // ── Reference pattern (order numbers: ORD-2026-0001) ──────────────────────
  reference_patterns: {
    job: { pattern: "{preset_code}-{year}-{seq:4}", start: 1 },
  },

  // ── Role presets — store manager runs pricing and margins day to day ──────
  role_presets: standardRoles(
    {
      manager: L("Store Manager", "مدير المتجر"),
      foreman: L("Fulfilment Supervisor", "مشرف تجهيز الطلبات"),
    },
    { managerSeesCosts: true, managerSeesPrices: true },
  ),

  // ── Order-type presets (paid up-front is the norm — 100% on acceptance) ───
  presets: [
    {
      code: "ORD",
      names: L("Standard Order", "طلب عادي"),
      default_skipped_stage_keys: [],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Standard retail customer order fulfilled from stock — طلب عميل قياسي يُجهز من المخزون",
    },
    {
      code: "BULK",
      names: L("Bulk / Wholesale Order", "طلب جملة"),
      default_skipped_stage_keys: [],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Bulk or wholesale order for business buyers, usually multi-item — طلب جملة لعملاء الأعمال",
    },
    {
      // A pure return skips the outbound fulfilment stages by default; for an
      // exchange the team re-enables them on the order. Money moves via credit
      // paths — the billing point only satisfies the operational contract.
      code: "RMA",
      names: L("Return / Exchange", "إرجاع أو استبدال"),
      default_skipped_stage_keys: ["sourcing_allocation", "picking_packing", "dispatch"],
      billing_points: [{ trigger: "on_acceptance", pct: 100 }],
      description:
        "Return or exchange of a delivered order; skips sourcing, picking and dispatch by default — إرجاع أو استبدال لطلب مُسلَّم",
    },
  ],

  // ── Custom fields on the order ────────────────────────────────────────────
  field_definitions: {
    job: {
      fields: [
        {
          field_key: "sales_channel",
          type: "select",
          labels: L("Sales channel", "قناة البيع"),
          required: false,
          visibility: [],
          options: [
            { key: "website", labels: L("Website", "الموقع الإلكتروني") },
            { key: "whatsapp", labels: L("WhatsApp", "واتساب") },
            { key: "instagram", labels: L("Instagram", "إنستغرام") },
            { key: "phone", labels: L("Phone", "هاتف") },
            { key: "walk_in", labels: L("Walk-in", "زيارة للمحل") },
          ],
          retired: false,
        },
        {
          field_key: "delivery_address",
          type: "text",
          labels: L("Delivery address", "عنوان التوصيل"),
          required: false,
          visibility: [],
          retired: false,
        },
        {
          // Manual entry — there is no courier integration.
          field_key: "tracking_number",
          type: "text",
          labels: L("Tracking number", "رقم التتبع"),
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

export const TEMPLATE_ONLINE_STORE_ENTRY: TemplateCatalogueEntry = {
  key: "online_store_v1",
  names: L("Online Store & E-commerce", "المتجر الإلكتروني والتجارة الإلكترونية"),
  description: L(
    "Configures IdaraWorks for retailers and online sellers who fulfil customer orders: each order is tracked from confirmation through sourcing, picking and packing, and dispatch to delivery. Includes a product and stock category catalogue, supplier purchase orders and receiving, expenses with per-order margin costing, quotations, invoices with manually recorded payments, and customer updates. Built for electronics, mobile-phone and accessories sellers taking orders online, by phone or in person.",
    "يهيئ إدارة أعمال المتاجر الإلكترونية وتجار التجزئة الذين يجهزون طلبات العملاء، حيث يُتابع كل طلب من التأكيد مروراً بالتوريد والتجهيز والتغليف والشحن حتى التسليم. يشمل تصنيف المنتجات والمخزون، وأوامر الشراء من الموردين والاستلام، والمصروفات مع احتساب هامش الربح لكل طلب، وعروض الأسعار، والفواتير مع تسجيل الدفعات يدوياً، وتحديثات العملاء. مصمم لبائعي الإلكترونيات والجوالات والإكسسوارات الذين يستقبلون الطلبات عبر الإنترنت أو الهاتف أو حضورياً.",
  ),
  targetBusinesses: [
    L("Electronics & gadget stores", "متاجر الإلكترونيات والأجهزة"),
    L("Mobile phone & accessories shops", "محلات الجوالات والإكسسوارات"),
    L(
      "Online sellers taking Instagram/WhatsApp orders",
      "البائعون عبر الإنترنت (طلبات إنستغرام وواتساب)",
    ),
    L("Home electronics & appliance retailers", "متاجر الأجهزة المنزلية"),
    L("Computer & IT equipment sellers", "بائعو الحواسيب ومعدات تقنية المعلومات"),
    L("Small wholesale & distribution sellers", "تجار الجملة والتوزيع الصغار"),
  ],
  classificationPhrases: [
    "we sell mobile phones and accessories online",
    "i run an online electronics store in riyadh",
    "we take orders on instagram and deliver in dubai",
    "small e-commerce business selling gadgets",
    "we run a phone shop and sell online too",
    "we ship customer orders across the uae",
    "wholesale electronics orders for shops",
    "متجر إلكتروني لبيع الجوالات والإكسسوارات",
    "نبيع إلكترونيات أونلاين مع توصيل",
    "محل هواتف يستقبل طلبات عبر واتساب",
    "متجر أونلاين للأجهزة المنزلية في جدة",
    "نستقبل الطلبات عبر إنستغرام ونشحنها للعملاء",
  ],
  classificationKeywords: [
    "e-commerce",
    "ecommerce",
    "online store",
    "online orders",
    "electronics",
    "mobile phones",
    "accessories",
    "fulfilment",
    "متجر إلكتروني",
    "تجارة إلكترونية",
    "جوالات",
    "إلكترونيات",
    "إكسسوارات",
    "طلبات أونلاين",
    "شحن الطلبات",
  ],
  enabledModules: [
    "cap.jobs",
    "cap.daily_reports",
    "cap.people",
    "cap.customers",
    "cap.procurement",
    "cap.expenses_costing",
    "cap.invoicing",
    "cap.customer_updates",
  ],
  optionalModules: ["cap.quoting", "cap.approvals", "cap.issues"],
  dashboardDefaults: ["jobs_active", "reports_today", "ar_outstanding", "exceptions"],
  limitations: [
    L(
      "Not a storefront or website builder — it manages orders behind the scenes",
      "ليس منشئ متاجر أو مواقع إلكترونية — بل يدير الطلبات خلف الكواليس",
    ),
    L(
      "No Shopify or marketplace integration — orders are entered in the app",
      "لا يتكامل مع شوبيفاي أو المنصات الأخرى — تُدخل الطلبات في التطبيق",
    ),
    L(
      "No courier or last-mile integration — dispatch and tracking are recorded manually",
      "لا يتكامل مع شركات الشحن — يُسجل الشحن والتتبع يدوياً",
    ),
    L(
      "No online payment gateway — payments are recorded manually",
      "لا توجد بوابة دفع إلكتروني — تُسجل الدفعات يدوياً",
    ),
    L(
      "Stock is tracked by operational categories, not barcode or variant-level warehouse management",
      "يُتابع المخزون بتصنيفات تشغيلية، وليس إدارة مستودعات بالباركود أو على مستوى خيارات المنتج",
    ),
  ],
  manifest: TEMPLATE_ONLINE_STORE,
};
