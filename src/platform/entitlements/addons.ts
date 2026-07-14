/**
 * The ADD-ON catalogue — code-owned source of truth for the modular monthly
 * add-on model (post-MVP; extends catalogue.ts with the same registry
 * discipline: migration 0065 seeds addon_def/bundle_def from exactly these
 * keys; an integration test asserts DB ⇔ code parity).
 *
 * HONESTY LAW (tested): every add-on carries an `availability` class and ONLY
 * `available` / `manual_process` items are purchasable; `credential_gated` and
 * `d1_gated` render visible-but-unavailable with the honest reason;
 * `deferred` capabilities are NEVER shown as purchasable. An add-on may only
 * grant entitlement keys that exist in catalogue.ts and may only claim
 * capabilities the platform actually ships.
 *
 * PRICES are the RECOMMENDED LAUNCH CATALOGUE (USD/month base, tax-exclusive,
 * AED companion pricing) — validated against 2026 official-page market research
 * (docs/commercial/ADDON_MARKET_RESEARCH.md) and the owner's anchors
 * (docs/commercial/OWNER_PRICING_DECISIONS.md). They are seeded with
 * is_placeholder=true and labelled indicative until owner ratification — never
 * a legal or irreversible commitment. Real payment collection remains D1-gated.
 *
 * Entitlement math (resolve.ts): plan base → add-ons (features OR; limit
 * deltas ADD × quantity) → org overrides (highest precedence, unchanged).
 */
import type { FeatureKey, LimitKey } from "./catalogue";

export type AddonAvailability =
  | "available" // production-operational today
  | "manual_process" // works via a founder/operator manual step (labelled)
  | "credential_gated" // needs a provider credential (Inngest/Resend/AI/OAuth)
  | "d1_gated" // needs the real-payment decision D1
  | "deferred"; // capability does not exist yet — NEVER purchasable

export type AddonDef = {
  key: string; // stable ^addon\.[a-z0-9_]+$
  names: { en: string; ar: string };
  description: { en: string; ar: string };
  /** USD per month, tax-exclusive (recommended launch price; minor units). */
  usdMonthlyMinor: number;
  /** AED companion price (minor units), rounded to clean figures. */
  aedMonthlyMinor: number;
  availability: AddonAvailability;
  /** Honest availability note shown when not plainly available. */
  availabilityNote?: { en: string; ar: string };
  /** Feature keys this add-on enables (OR-merged). */
  features: FeatureKey[];
  /** Numeric limit deltas ADDED to the plan base, × purchased quantity. */
  limitDeltas: Partial<Record<LimitKey, number>>;
  /** true = purchasable multiple times (seat/storage packs). */
  stackable: boolean;
  sort: number;
};

export type BundleDef = {
  key: string; // stable ^bundle\.[a-z0-9_]+$
  names: { en: string; ar: string };
  description: { en: string; ar: string };
  /** The add-ons the bundle expands to (same underlying keys — never a second
   * entitlement system). */
  addonKeys: string[];
  usdMonthlyMinor: number;
  aedMonthlyMinor: number;
  sort: number;
};

const L = (en: string, ar: string) => ({ en, ar });

// ── Individual add-ons (USD base; AED companion) ─────────────────────────────
export const ADDONS: readonly AddonDef[] = [
  // — Seats & workspace —
  {
    key: "addon.members_10",
    names: L("Additional 10 members", "10 أعضاء إضافيين"),
    description: L(
      "Adds 10 office login seats (field/foreman seats are always free and unlimited).",
      "يضيف 10 مقاعد دخول مكتبية (مقاعد الميدان/المشرفين مجانية وغير محدودة دائماً).",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: [],
    limitDeltas: { "limit.full_users": 10, "limit.viewer_users": 10 },
    stackable: true,
    sort: 10,
  },
  {
    key: "addon.extra_org",
    names: L("Additional organization", "منشأة إضافية"),
    description: L(
      "A second isolated workspace under your account (provisioned with you by support).",
      "مساحة عمل ثانية معزولة ضمن حسابك (تُجهَّز بالتنسيق مع الدعم).",
    ),
    usdMonthlyMinor: 900,
    aedMonthlyMinor: 3300,
    availability: "manual_process",
    availabilityNote: L(
      "Provisioned manually with support during the pilot phase.",
      "تُفعَّل يدوياً بالتنسيق مع الدعم خلال المرحلة التجريبية.",
    ),
    features: [],
    limitDeltas: {},
    stackable: true,
    sort: 20,
  },
  {
    key: "addon.storage_25gb",
    names: L("Additional 25 GB storage", "سعة تخزين إضافية 25 جيجابايت"),
    description: L(
      "Adds 25 GB of document and photo storage.",
      "يضيف 25 جيجابايت لتخزين المستندات والصور.",
    ),
    usdMonthlyMinor: 400,
    aedMonthlyMinor: 1500,
    availability: "available",
    features: [],
    limitDeltas: { "limit.storage_gb": 25 },
    stackable: true,
    sort: 30,
  },

  // — Money modules —
  {
    key: "addon.quotes_invoices",
    names: L("Quotes & invoices", "عروض الأسعار والفواتير"),
    description: L(
      "Create quotations, convert to jobs, issue invoices and credit notes. E-invoice submission is included here once regulatory activation (D1) opens — it is never sold separately.",
      "إنشاء عروض الأسعار وتحويلها إلى أعمال وإصدار الفواتير والإشعارات الدائنة. يشمل الفوترة الإلكترونية عند فتح التفعيل التنظيمي — ولا تُباع منفصلة أبداً.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: ["cap.quoting", "cap.invoicing"],
    limitDeltas: {},
    stackable: false,
    sort: 40,
  },
  {
    key: "addon.payments_ar",
    names: L("Customer payments & receivables", "دفعات العملاء والذمم المدينة"),
    description: L(
      "Record customer payments manually (cash/bank/cheque), receipts, and the accounts-receivable view. No online payment collection — that remains disabled until D1.",
      "تسجيل دفعات العملاء يدوياً (نقد/تحويل/شيك) مع الإيصالات وعرض الذمم المدينة. لا يشمل التحصيل الإلكتروني — يبقى معطلاً حتى قرار D1.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: ["cap.payments"],
    limitDeltas: {},
    stackable: false,
    sort: 50,
  },
  {
    key: "addon.expenses_cashbook",
    names: L("Expenses & cashbook", "المصروفات ودفتر النقدية"),
    description: L(
      "Record and categorise expenses with void-with-reason and the expense book.",
      "تسجيل المصروفات وتصنيفها مع الإلغاء المسبب ودفتر المصروفات.",
    ),
    usdMonthlyMinor: 400,
    aedMonthlyMinor: 1500,
    availability: "available",
    features: ["cap.expenses"],
    limitDeltas: {},
    stackable: false,
    sort: 60,
  },

  // — Purchasing modules —
  {
    key: "addon.purchase_requests",
    names: L("Purchase requests & approvals", "طلبات الشراء والموافقات"),
    description: L(
      "Field material requests routed through approval rules.",
      "طلبات المواد من الميدان عبر قواعد الموافقة.",
    ),
    usdMonthlyMinor: 400,
    aedMonthlyMinor: 1500,
    availability: "available",
    features: ["cap.material_requests"],
    limitDeltas: {},
    stackable: false,
    sort: 70,
  },
  {
    key: "addon.purchase_orders",
    names: L("Purchase orders (LPOs)", "أوامر الشراء"),
    description: L(
      "Formal purchase orders with supplier records and printable documents. Automated PDF rendering activates with the automation pack.",
      "أوامر شراء رسمية مع سجلات الموردين ومستندات قابلة للطباعة. يتفعل إنتاج PDF التلقائي مع باقة الأتمتة.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: ["cap.purchase_orders"],
    limitDeltas: {},
    stackable: false,
    sort: 80,
  },
  {
    key: "addon.goods_receiving",
    names: L("Goods receiving", "استلام البضائع"),
    description: L(
      "Goods receipt notes with partial-receipt tracking against purchase orders.",
      "إشعارات استلام البضائع مع تتبع الاستلام الجزئي مقابل أوامر الشراء.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["cap.goods_receipts"],
    limitDeltas: {},
    stackable: false,
    sort: 90,
  },
  {
    key: "addon.items_catalogue",
    names: L("Items & materials catalogue", "دليل الأصناف والمواد"),
    description: L(
      "A shared item catalogue with categories used across requests, orders and reports. This is category-level operational tracking — not warehouse stock control.",
      "دليل أصناف مشترك بفئات تُستخدم في الطلبات والأوامر والتقارير. تتبع تشغيلي على مستوى الفئات — وليس نظام مخازن.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["cap.items"],
    limitDeltas: {},
    stackable: false,
    sort: 100,
  },
  {
    key: "addon.approval_workflows",
    names: L("Advanced approval workflows", "مسارات موافقات متقدمة"),
    description: L(
      "Configurable approval rules per subject: every / above-amount / auto-approve-below thresholds.",
      "قواعد موافقة قابلة للتهيئة لكل نوع: دائماً / فوق مبلغ / اعتماد تلقائي تحت مبلغ.",
    ),
    usdMonthlyMinor: 400,
    aedMonthlyMinor: 1500,
    availability: "available",
    features: ["cap.approvals"],
    limitDeltas: {},
    stackable: false,
    sort: 110,
  },

  // — Costing & intelligence —
  {
    key: "addon.job_costing",
    names: L("Job costing", "تكاليف الأعمال"),
    description: L(
      "Per-job cost roll-up (materials, purchases, expenses; labour behind the cost wall) with margins for privileged roles.",
      "تجميع تكلفة كل عمل (مواد، مشتريات، مصروفات؛ والعمالة خلف جدار التكلفة) مع الهوامش للأدوار المخوّلة.",
    ),
    usdMonthlyMinor: 700,
    aedMonthlyMinor: 2600,
    availability: "available",
    features: ["cap.costing"],
    limitDeltas: {},
    stackable: false,
    sort: 120,
  },
  {
    key: "addon.labour_timesheets",
    names: L("Labour & attendance costing", "تكلفة العمالة والحضور"),
    description: L(
      "Attendance grid and labour hours from daily reports feeding job costs.",
      "جدول الحضور وساعات العمل من التقارير اليومية لتغذية تكاليف الأعمال.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: ["cap.attendance"],
    limitDeltas: {},
    stackable: false,
    sort: 130,
  },
  {
    key: "addon.quote_vs_actual",
    names: L("Quote-versus-actual reporting", "تقارير المقارنة بين العرض والفعلي"),
    description: L(
      "Compare accepted quote values against actual job costs with divergence flags.",
      "مقارنة قيم العروض المقبولة بالتكاليف الفعلية مع تنبيهات الانحراف.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["feat.quote_vs_actual"],
    limitDeltas: {},
    stackable: false,
    sort: 140,
  },
  {
    key: "addon.owner_digest",
    names: L("Owner digest & exception intelligence", "ملخص المالك وذكاء الاستثناءات"),
    description: L(
      "The owner digest and exception cards (deterministic, on-demand). Nightly automatic runs activate with the automation pack.",
      "ملخص المالك وبطاقات الاستثناءات (حتمي وعند الطلب). يتفعل التشغيل الليلي التلقائي مع باقة الأتمتة.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "available",
    features: ["feat.owner_digest"],
    limitDeltas: {},
    stackable: false,
    sort: 150,
  },
  {
    key: "addon.customer_updates",
    names: L("Customer update sharing", "مشاركة تحديثات العملاء"),
    description: L(
      "Curated progress updates shared with customers via secure links.",
      "تحديثات تقدم منسقة تُشارك مع العملاء عبر روابط آمنة.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["cap.customer_updates"],
    limitDeltas: {},
    stackable: false,
    sort: 160,
  },

  // — Data & branding —
  {
    key: "addon.data_import",
    names: L("Data import tools", "أدوات استيراد البيانات"),
    description: L(
      "Guided CSV imports for customers, employees and items with validation preview.",
      "استيراد CSV موجّه للعملاء والموظفين والأصناف مع معاينة تحقق.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["feat.data_import"],
    limitDeltas: {},
    stackable: false,
    sort: 170,
  },
  {
    key: "addon.exports_extended",
    names: L("Extended data exports", "تصدير بيانات موسّع"),
    description: L(
      "Full-entity CSV export pack. Core record exports always remain available on every plan — this extends coverage, it never gates your data.",
      "باقة تصدير CSV لكل الكيانات. يبقى تصدير السجلات الأساسية متاحاً دائماً في كل الخطط — هذه الباقة توسّع التغطية ولا تحجب بياناتك أبداً.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "available",
    features: ["feat.exports_extended"],
    limitDeltas: {},
    stackable: false,
    sort: 180,
  },
  {
    key: "addon.audit_history",
    names: L("Audit & compliance history", "سجل التدقيق والامتثال"),
    description: L(
      "The full audit trail views and audit-log export.",
      "عروض سجل التدقيق الكامل وتصديره.",
    ),
    usdMonthlyMinor: 400,
    aedMonthlyMinor: 1500,
    availability: "available",
    features: ["feat.audit_export"],
    limitDeltas: {},
    stackable: false,
    sort: 190,
  },
  {
    key: "addon.branding_docs",
    names: L("Your logo on documents", "شعارك على المستندات"),
    description: L(
      "Your logo on published quotes, invoices and purchase orders.",
      "شعارك على عروض الأسعار والفواتير وأوامر الشراء الصادرة.",
    ),
    usdMonthlyMinor: 200,
    aedMonthlyMinor: 800,
    availability: "available",
    features: ["feat.branding_docs"],
    limitDeltas: {},
    stackable: false,
    sort: 200,
  },
  {
    key: "addon.branding_app",
    names: L("Full in-app branding", "علامتك داخل التطبيق"),
    description: L(
      "Your logo across the dashboard and application header for all your users.",
      "شعارك في لوحة التحكم وواجهة التطبيق لجميع مستخدميك.",
    ),
    usdMonthlyMinor: 100,
    aedMonthlyMinor: 400,
    availability: "available",
    features: ["feat.branding_app"],
    limitDeltas: {},
    stackable: false,
    sort: 210,
  },
  {
    key: "addon.priority_support",
    names: L("Priority support", "دعم ذو أولوية"),
    description: L(
      "Priority human support with a faster response target during business hours.",
      "دعم بشري ذو أولوية بهدف استجابة أسرع خلال ساعات العمل.",
    ),
    usdMonthlyMinor: 900,
    aedMonthlyMinor: 3300,
    availability: "manual_process",
    availabilityNote: L(
      "Support is delivered by people — activation is confirmed with you directly.",
      "الدعم يقدمه أشخاص — يُؤكَّد التفعيل معك مباشرة.",
    ),
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 220,
  },

  // — Credential-gated (visible, not purchasable until credentials exist) —
  {
    key: "addon.automation_workers",
    names: L("Automation & scheduled workers", "الأتمتة والمهام المجدولة"),
    description: L(
      "Nightly digests, automatic exception sweeps, document PDF rendering and scheduled maintenance.",
      "ملخصات ليلية، فحوصات استثناءات تلقائية، إنتاج مستندات PDF ومهام صيانة مجدولة.",
    ),
    usdMonthlyMinor: 500,
    aedMonthlyMinor: 1900,
    availability: "credential_gated",
    availabilityNote: L(
      "Activates once the background-worker infrastructure is provisioned.",
      "يتفعل بعد تجهيز بنية المهام الخلفية.",
    ),
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 230,
  },
  {
    key: "addon.email_notifications",
    names: L("Email notification pack", "باقة إشعارات البريد"),
    description: L(
      "Email delivery for invites, approvals and daily summaries.",
      "إرسال بريد إلكتروني للدعوات والموافقات والملخصات اليومية.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "credential_gated",
    availabilityNote: L(
      "Activates once the email provider is provisioned.",
      "يتفعل بعد تجهيز مزود البريد.",
    ),
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 240,
  },
  {
    key: "addon.ai_pack",
    names: L("AI onboarding & narration pack", "باقة الذكاء الاصطناعي"),
    description: L(
      "AI-enriched onboarding conversation and digest narration on top of the deterministic engine.",
      "إثراء المحادثة التأهيلية وسرد الملخصات بالذكاء الاصطناعي فوق المحرك الحتمي.",
    ),
    usdMonthlyMinor: 600,
    aedMonthlyMinor: 2200,
    availability: "credential_gated",
    availabilityNote: L(
      "Activates once an AI provider is wired; the deterministic engine is always included free.",
      "يتفعل بعد ربط مزود ذكاء اصطناعي؛ المحرك الحتمي مشمول مجاناً دائماً.",
    ),
    features: ["feat.ai_narration", "feat.ai_drafts"],
    limitDeltas: { "limit.ai_credits_month": 200 },
    stackable: false,
    sort: 250,
  },
  {
    key: "addon.oauth_login",
    names: L("OAuth login pack", "باقة تسجيل الدخول الموحد"),
    description: L(
      "Google / Microsoft single sign-on for your team.",
      "تسجيل دخول موحد عبر Google / Microsoft لفريقك.",
    ),
    usdMonthlyMinor: 300,
    aedMonthlyMinor: 1100,
    availability: "credential_gated",
    availabilityNote: L(
      "Activates once OAuth providers are configured.",
      "يتفعل بعد تهيئة مزودي الدخول الموحد.",
    ),
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 260,
  },

  // — Deferred (capability does not exist — NEVER purchasable; honesty-tested) —
  {
    key: "addon.inventory_stock",
    names: L("Inventory & stock control", "إدارة المخزون"),
    description: L(
      "Warehouse-grade stock levels and movements. Not built yet — shown for roadmap honesty only.",
      "مستويات مخزون وحركات بمستوى المستودعات. غير متوفر بعد — يُعرض للشفافية فقط.",
    ),
    usdMonthlyMinor: 0,
    aedMonthlyMinor: 0,
    availability: "deferred",
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 300,
  },
  {
    key: "addon.multi_location",
    names: L("Multi-location operations", "عمليات متعددة المواقع"),
    description: L(
      "First-class branches/locations. Not built yet — shown for roadmap honesty only.",
      "فروع ومواقع كوحدات أساسية. غير متوفر بعد — يُعرض للشفافية فقط.",
    ),
    usdMonthlyMinor: 0,
    aedMonthlyMinor: 0,
    availability: "deferred",
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 310,
  },
  {
    key: "addon.multi_currency",
    names: L("Multi-currency documents", "مستندات متعددة العملات"),
    description: L(
      "Per-document currencies beyond the org base currency. Not built yet.",
      "عملات لكل مستند غير عملة المنشأة الأساسية. غير متوفر بعد.",
    ),
    usdMonthlyMinor: 0,
    aedMonthlyMinor: 0,
    availability: "deferred",
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 320,
  },
  {
    key: "addon.whatsapp_pack",
    names: L("WhatsApp / messaging pack", "باقة واتساب والمراسلة"),
    description: L(
      "WhatsApp notifications and customer messaging. Not built yet.",
      "إشعارات واتساب ومراسلة العملاء. غير متوفر بعد.",
    ),
    usdMonthlyMinor: 0,
    aedMonthlyMinor: 0,
    availability: "deferred",
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 330,
  },
  {
    key: "addon.api_webhooks",
    names: L("API & webhook access", "الوصول البرمجي وWebhooks"),
    description: L(
      "A public API and outbound webhooks. Not built yet.",
      "واجهة برمجية عامة وWebhooks صادرة. غير متوفرة بعد.",
    ),
    usdMonthlyMinor: 0,
    aedMonthlyMinor: 0,
    availability: "deferred",
    features: [],
    limitDeltas: {},
    stackable: false,
    sort: 340,
  },
] as const;

// ── Bundles (discounted collections of the SAME add-on keys) ─────────────────
export const BUNDLES: readonly BundleDef[] = [
  {
    key: "bundle.starter_ops",
    names: L("Starter Operations", "العمليات الأساسية"),
    description: L(
      "Quote, invoice and share progress with your customers, with your logo on documents.",
      "أصدر العروض والفواتير وشارك التقدم مع عملائك، مع شعارك على المستندات.",
    ),
    addonKeys: ["addon.quotes_invoices", "addon.customer_updates", "addon.branding_docs"],
    usdMonthlyMinor: 900, // vs 1000 individually (−10%)
    aedMonthlyMinor: 3300,
    sort: 10,
  },
  {
    key: "bundle.finance",
    names: L("Finance", "المالية"),
    description: L(
      "Payments, receivables, expenses and quote-versus-actual — the money picture.",
      "الدفعات والذمم والمصروفات ومقارنة العرض بالفعلي — الصورة المالية الكاملة.",
    ),
    addonKeys: ["addon.payments_ar", "addon.expenses_cashbook", "addon.quote_vs_actual"],
    usdMonthlyMinor: 900, // vs 1200 individually (−25%); the owner's $9 accounting anchor
    aedMonthlyMinor: 3300,
    sort: 20,
  },
  {
    key: "bundle.procurement",
    names: L("Procurement", "المشتريات"),
    description: L(
      "Requests, approvals, purchase orders, receiving and the item catalogue.",
      "الطلبات والموافقات وأوامر الشراء والاستلام ودليل الأصناف.",
    ),
    addonKeys: [
      "addon.purchase_requests",
      "addon.purchase_orders",
      "addon.goods_receiving",
      "addon.items_catalogue",
      "addon.approval_workflows",
    ],
    usdMonthlyMinor: 1200, // vs 1900 individually (−37%)
    aedMonthlyMinor: 4500,
    sort: 30,
  },
  {
    key: "bundle.project_control",
    names: L("Project Control", "ضبط المشاريع"),
    description: L(
      "Job costing, labour costing, quote-versus-actual and the owner digest.",
      "تكاليف الأعمال والعمالة ومقارنة العرض بالفعلي وملخص المالك.",
    ),
    addonKeys: [
      "addon.job_costing",
      "addon.labour_timesheets",
      "addon.quote_vs_actual",
      "addon.owner_digest",
    ],
    usdMonthlyMinor: 1200, // vs 2000 individually (−40%)
    aedMonthlyMinor: 4500,
    sort: 40,
  },
  {
    key: "bundle.growth",
    names: L("Growth", "النمو"),
    description: L(
      "The most-chosen path: billing, money management, costing and customer sharing.",
      "المسار الأكثر اختياراً: الفوترة وإدارة المال والتكاليف ومشاركة العملاء.",
    ),
    addonKeys: [
      "addon.quotes_invoices",
      "addon.payments_ar",
      "addon.expenses_cashbook",
      "addon.job_costing",
      "addon.customer_updates",
    ],
    usdMonthlyMinor: 1900, // vs 2400 individually (−21%)
    aedMonthlyMinor: 7000,
    sort: 50,
  },
  {
    key: "bundle.full_ops",
    names: L("Full Operations", "العمليات الكاملة"),
    description: L(
      "Every available module: billing, finance, procurement, costing, intelligence, imports, exports, audit and branding.",
      "كل الوحدات المتاحة: الفوترة والمالية والمشتريات والتكاليف والذكاء والاستيراد والتصدير والتدقيق والعلامة.",
    ),
    addonKeys: [
      "addon.quotes_invoices",
      "addon.payments_ar",
      "addon.expenses_cashbook",
      "addon.purchase_requests",
      "addon.purchase_orders",
      "addon.goods_receiving",
      "addon.items_catalogue",
      "addon.approval_workflows",
      "addon.job_costing",
      "addon.labour_timesheets",
      "addon.quote_vs_actual",
      "addon.owner_digest",
      "addon.customer_updates",
      "addon.data_import",
      "addon.exports_extended",
      "addon.audit_history",
      "addon.branding_docs",
      "addon.branding_app",
    ],
    usdMonthlyMinor: 2900, // vs 6600 individually (−56%); the $25–45 "everything" market band
    aedMonthlyMinor: 10900,
    sort: 60,
  },
] as const;

// ── Lookup + guards ───────────────────────────────────────────────────────────
const ADDON_MAP = new Map(ADDONS.map((a) => [a.key, a]));
const BUNDLE_MAP = new Map(BUNDLES.map((b) => [b.key, b]));

export function getAddon(key: string): AddonDef | undefined {
  return ADDON_MAP.get(key);
}
export function getBundle(key: string): BundleDef | undefined {
  return BUNDLE_MAP.get(key);
}

/** Purchasable = available | manual_process. credential/d1-gated and deferred
 * items are NEVER purchasable (the pricing UI + service both enforce this). */
export function isPurchasable(addon: AddonDef): boolean {
  return addon.availability === "available" || addon.availability === "manual_process";
}

/** A bundle is purchasable only if EVERY member add-on is purchasable. */
export function bundleIsPurchasable(bundle: BundleDef): boolean {
  return bundle.addonKeys.every((k) => {
    const a = getAddon(k);
    return a !== undefined && isPurchasable(a);
  });
}

/** Sum of a bundle's member prices (for showing the discount honestly). */
export function bundleMemberTotalMinor(bundle: BundleDef, currency: "USD" | "AED"): number {
  return bundle.addonKeys.reduce((s, k) => {
    const a = getAddon(k);
    return s + (a ? (currency === "USD" ? a.usdMonthlyMinor : a.aedMonthlyMinor) : 0);
  }, 0);
}
