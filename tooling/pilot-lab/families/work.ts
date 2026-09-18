/**
 * H33 Pilot Lab — family "work": projects and jobs, and everything that hangs
 * off them.
 *
 *   job + job_stage (snapshots from the org's installed template, exactly as
 *   createJobFromPreset writes them) · job_crew · task + task_dependency
 *   (finish-to-start chains) + task_allocation · daily_report with work /
 *   labour / material lines · issue · approval_rule + approval
 *   (task_completion subjects) · comment · activity · week_plan +
 *   week_plan_job · reference_sequence.
 *
 * How it is built
 *
 * 1. `buildModel(ctx)` is PURE: every random choice comes from `ctx.rng`, every
 *    id from `ctx.id`, every date from `ctx.clock`. It is memoised per context
 *    so `plan()` and `seed()` see the same draws, which is what makes the
 *    dry-run an honest budget: the plan counts ARE the rows seed writes.
 * 2. External ids (customers, employees, items, presets) are not known to a
 *    pure plan. The model stores POSITIONS; `toRows()` resolves them against the
 *    pools handed off by setup / people / masters (or read, bounded, from the
 *    database) without ever dropping or adding a row.
 * 3. Bulk rows are written in the states the product's own services write —
 *    the same columns, the same reasons, the same reconciling values (a held
 *    job has its reason, a reviewed report its reviewer, a task waiting for
 *    approval its pending approval and nothing else). None of these tables has
 *    a database state-machine trigger (docs/H33-TRUTH-MAP.md), so that is the
 *    law here. The one database-side side effect of a submit — the frozen
 *    labour-cost snapshot — is produced by calling the SAME function the
 *    service calls, `app.freeze_report_labour_costs`, for every submitted
 *    report.
 * 4. A representative subset is then driven through the REAL domain services —
 *    lifecycle moves, stage completion, task status, approval decisions, report
 *    review, issue resolution, weekly-plan issue and cancellation — so the
 *    audit log, activity feed, outbox and issuer-snapshot paths are exercised
 *    and those rows are indistinguishable from app writes. Every call checks
 *    the row's current state first, so a resumed run skips what it already
 *    did. Skipped entirely in dry-run, and switchable off (`workFamily({
 *    driveServices: false })`) so the unit test needs no database.
 *
 * Volume: `profile.jobs` jobs, of which `profile.projects` are project-scale
 * (multi-stage, `tasksPerJob` tasks, crews, several reports) and the rest are
 * small work orders (0–3 tasks, at most one report). Every job still carries
 * its full stage snapshot (5–7 rows), which is the family's dominant cost.
 */
import type { Rng } from "../../simulation/rng";
import { brandNow } from "../brand";
import type { SimClock } from "../../simulation/dates";
import type {
  Check,
  Company,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../types";
import { TEMPLATES } from "@/platform/config/templates";
import { renderReference } from "@/platform/config/reference";
import { captureIssuerSnapshot, type IssuerIdentity } from "@/platform/documents/issuer";
import {
  address,
  city,
  email,
  longTitle,
  paragraph,
  phone,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  taxNo,
  weighted,
  workingDayAgo,
} from "./_shared";

export const FAMILY = "work";

// ── Tables this family writes, in insert order ──────────────────────────────

export const WORK_TABLES = [
  "job",
  "job_stage",
  "job_crew",
  "task",
  "task_dependency",
  "task_allocation",
  "daily_report",
  "report_work_line",
  "report_labour_line",
  "report_material_line",
  "issue",
  "approval_rule",
  "approval",
  "comment",
  "activity",
  "week_plan",
  "week_plan_job",
  "reference_sequence",
] as const;
export type WorkTable = (typeof WORK_TABLES)[number];

/**
 * Tables only this family writes; verify() expects their counts to equal the
 * plan exactly. The rest are shared (misc writes activity/comment, sales and
 * studio write reference_sequence) or grow when the services run (activity),
 * so verify() expects at least the plan there.
 */
/*
 * Tables only THIS family writes, so their counts can be asserted exactly.
 * A table two families write cannot be: an equality check on a shared table
 * fails the moment the other family touches it, and says nothing about either.
 * `approval` is shared with assets and sales, and `task_dependency` with
 * studio, which materialises a plan's edges into real dependencies.
 */
export const EXCLUSIVE_TABLES: ReadonlySet<string> = new Set([
  "job",
  "job_stage",
  "job_crew",
  "task",
  "task_allocation",
  "daily_report",
  "report_work_line",
  "report_labour_line",
  "report_material_line",
  "issue",
  "approval_rule",
  "week_plan",
  "week_plan_job",
]);

export const JOB_CATEGORIES = ["draft", "active", "on_hold", "done", "cancelled"] as const;
export const STAGE_STATUSES = ["not_started", "in_progress", "completed", "skipped"] as const;
export const TASK_STATUSES = [
  "pending",
  "ready",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "completed",
  "cancelled",
] as const;
export const REPORT_STATUSES = ["draft", "submitted", "reviewed", "returned"] as const;
export const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export const APPROVAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "superseded",
] as const;
export const WEEK_PLAN_STATUSES = ["draft", "issued", "revised", "cancelled"] as const;

/** Weeks of weekly plans, counted back from the as-of week. */
export const WEEK_PLAN_WEEKS = 60;
/** Organisation-wide issues (no job) per company. */
export const ORG_ISSUES = 15;
/** The pagination threshold the truth map asks for. */
export const PAGINATION_THRESHOLD = 1205;
/** Handoff bounds — later families need a sample of open work, not all of it. */
export const HANDOFF_ACTIVE_JOBS = 400;
export const HANDOFF_MAJOR_JOBS = 200;
export const HANDOFF_PERSONA_JOBS = 25;

// ── Text pools (fictional, bilingual) ───────────────────────────────────────

type Bi = [string, string];

const JOB_NAMES: Record<string, { project: Bi[]; small: Bi[] }> = {
  gulfbuild: {
    project: [
      ["Villa fit-out", "تشطيب فيلا"],
      ["Office fit-out — full floor", "تشطيب مكاتب — طابق كامل"],
      ["Warehouse civil works", "أعمال مدنية لمستودع"],
      ["MEP package — Tower B", "حزمة كهروميكانيكية — البرج ب"],
      ["Retail unit renovation", "تجديد محل تجاري"],
      ["School extension block", "مبنى إضافي لمدرسة"],
      ["Clinic fit-out and MEP", "تشطيب عيادة وأعمال كهروميكانيكية"],
      ["Showroom interiors", "ديكور صالة عرض"],
      ["Labour camp refurbishment", "ترميم سكن عمال"],
      ["Boundary wall and landscaping", "سور خارجي وتنسيق حدائق"],
    ],
    small: [
      ["Snagging works — apartment", "معالجة ملاحظات — شقة"],
      ["Bathroom renovation", "تجديد حمام"],
      ["Partition and ceiling works", "أعمال قواطع وأسقف"],
      ["Waterproofing repair — roof", "إصلاح عزل — سطح"],
      ["Tiling — reception area", "تبليط — منطقة الاستقبال"],
      ["Electrical rewiring — shop", "إعادة تمديدات كهربائية — محل"],
    ],
  },
  tradeline: {
    project: [
      ["Warehouse racking project", "مشروع أرفف مستودع"],
      ["Fleet telematics rollout", "تركيب أنظمة تتبع الأسطول"],
      ["New branch setup", "تجهيز فرع جديد"],
      ["Distribution route redesign", "إعادة تصميم مسارات التوزيع"],
      ["Cold-chain expansion", "توسعة سلسلة التبريد"],
      ["Annual stock count programme", "برنامج الجرد السنوي"],
    ],
    small: [
      ["Delivery run — palletised goods", "جولة توصيل — بضائع على منصات"],
      ["Customer stock count", "جرد مخزون عميل"],
      ["Showroom display refresh", "تجديد عرض صالة البيع"],
      ["Returns processing batch", "دفعة معالجة مرتجعات"],
      ["Internal — stock-take", "داخلي — جرد"],
      ["Sample kit assembly", "تجهيز عينات"],
    ],
  },
  saudimfg: {
    project: [
      ["Custom steel brackets — 400 pcs", "كتائف فولاذية حسب الطلب — 400 قطعة"],
      ["Stainless tank fabrication", "تصنيع خزان ستانلس"],
      ["Conveyor assembly order", "أمر تجميع ناقل"],
      ["Aluminium frames — production batch", "إطارات ألمنيوم — دفعة إنتاج"],
      ["Machine guarding set", "مجموعة حواجز حماية للآلات"],
      ["Skid frame for pump package", "هيكل قاعدة لمجموعة مضخات"],
    ],
    small: [
      ["Rework — weld defects", "إعادة تصنيع — عيوب لحام"],
      ["Repair — gearbox housing", "إصلاح — غلاف علبة التروس"],
      ["Batch run — clamps 1,200 pcs", "دفعة إنتاج — مشابك 1200 قطعة"],
      ["Batch run — brackets 800 pcs", "دفعة إنتاج — كتائف 800 قطعة"],
      ["Repair — conveyor rollers", "إصلاح — بكرات ناقل"],
      ["Batch run — spacers", "دفعة إنتاج — فواصل"],
    ],
  },
  consult: {
    project: [
      ["Operating model design", "تصميم نموذج التشغيل"],
      ["ERP selection engagement", "مشروع اختيار نظام تخطيط الموارد"],
      ["Financial due diligence", "فحص نافٍ للجهالة مالي"],
      ["Market entry study", "دراسة دخول السوق"],
      ["Corporate governance programme", "برنامج حوكمة الشركات"],
      ["Transformation office setup", "تأسيس مكتب التحول"],
      ["Family business succession plan", "خطة تعاقب الشركات العائلية"],
    ],
    small: [
      ["Advisory call — VAT registration", "استشارة — التسجيل الضريبي"],
      ["Board pack review", "مراجعة حزمة مجلس الإدارة"],
      ["Policy review workshop", "ورشة مراجعة السياسات"],
      ["Compliance health check", "فحص الامتثال"],
      ["Retainer visit — monthly", "زيارة عقد استشاري — شهرية"],
      ["Pricing review — one product line", "مراجعة تسعير — خط منتج واحد"],
    ],
  },
  facilico: {
    project: [
      ["Chiller replacement", "استبدال مبرّد"],
      ["BMS upgrade", "ترقية نظام إدارة المباني"],
      ["Fit-out MEP installation", "تركيب كهروميكانيكي لتشطيب"],
      ["Facade cleaning programme", "برنامج تنظيف الواجهات"],
      ["Annual overhaul — AHUs", "صيانة شاملة سنوية — وحدات مناولة الهواء"],
      ["Car park lighting retrofit", "تحديث إنارة المواقف"],
    ],
    small: [
      ["AC service call", "بلاغ صيانة تكييف"],
      ["Chiller fault", "عطل مبرّد"],
      ["Plumbing leak repair", "إصلاح تسرب سباكة"],
      ["Electrical trip — DB", "فصل كهربائي — لوحة توزيع"],
      ["Lift inspection visit", "زيارة فحص مصعد"],
      ["Fire alarm test", "اختبار إنذار حريق"],
      ["Monthly PPM visit", "زيارة صيانة وقائية شهرية"],
      ["Deep clean — common areas", "تنظيف عميق — المناطق المشتركة"],
      ["Generator load test", "اختبار حمل مولّد"],
      ["Water tank cleaning", "تنظيف خزان مياه"],
    ],
  },
};

const TASK_TITLES: Record<string, Bi[]> = {
  preparation: [
    ["Site survey", "مسح الموقع"],
    ["Confirm scope with client", "تأكيد النطاق مع العميل"],
    ["Order materials", "طلب المواد"],
    ["Mobilise crew", "تحريك الطاقم"],
    ["Prepare method statement", "إعداد بيان طريقة العمل"],
    ["Issue drawings for approval", "إصدار الرسومات للاعتماد"],
  ],
  production: [
    ["Install units", "تركيب الوحدات"],
    ["Run cabling and containment", "تمديد الكابلات والمجاري"],
    ["Fabricate frames", "تصنيع الإطارات"],
    ["Execute works — level 2", "تنفيذ الأعمال — الطابق الثاني"],
    ["Assemble components", "تجميع المكونات"],
    ["Pour and cure", "صب ومعالجة"],
  ],
  finishing: [
    ["Snag list walkthrough", "جولة قائمة الملاحظات"],
    ["Clean and restore site", "تنظيف الموقع وإعادته"],
    ["Touch-up paint", "لمسات الدهان"],
    ["Label and tag equipment", "وضع الملصقات على المعدات"],
  ],
  verification: [
    ["Quality inspection", "فحص الجودة"],
    ["Client walkthrough", "جولة مع العميل"],
    ["Test and commission", "اختبار وتشغيل"],
    ["Safety audit", "تدقيق السلامة"],
  ],
  handover: [
    ["Handover documents", "مستندات التسليم"],
    ["Collect sign-off", "الحصول على التوقيع"],
    ["Close out and invoice", "الإقفال والفوترة"],
    ["Final photos and as-builts", "الصور النهائية والمخططات كما نُفذت"],
  ],
  other: [
    ["Follow-up with client", "متابعة مع العميل"],
    ["Update the plan", "تحديث الخطة"],
    ["Prepare report", "إعداد التقرير"],
  ],
};

const ISSUE_TITLES: Bi[] = [
  ["Water leak in ceiling void", "تسرب مياه في فراغ السقف"],
  ["Missing safety harness on site", "غياب حزام الأمان في الموقع"],
  ["Material short delivery", "نقص في توريد المواد"],
  ["Client complaint — noise after hours", "شكوى عميل — ضجيج بعد الدوام"],
  ["Damaged panel on arrival", "لوح تالف عند الوصول"],
  ["Scaffold tag expired", "انتهاء صلاحية بطاقة السقالة"],
  ["Generator overheating", "ارتفاع حرارة المولّد"],
  ["Drawing revision mismatch", "عدم تطابق نسخة الرسومات"],
  ["Access badge not issued", "لم تُصدر بطاقة الدخول"],
  ["Waste skip overflowing", "امتلاء حاوية النفايات"],
  ["Wrong item delivered", "توريد صنف خاطئ"],
  ["Power outage stopped works", "انقطاع الكهرباء أوقف الأعمال"],
];

const HOLD_REASONS: Bi[] = [
  ["Awaiting client approval of the variation", "بانتظار موافقة العميل على التعديل"],
  ["Site access withheld by the landlord", "المالك يمنع الوصول إلى الموقع"],
  ["Awaiting parts from the supplier", "بانتظار قطع الغيار من المورّد"],
  ["Budget hold pending finance review", "إيقاف بانتظار مراجعة المالية"],
];
const CANCEL_REASONS: Bi[] = [
  ["Client cancelled the order", "ألغى العميل الطلب"],
  ["Scope merged into another project", "دُمج النطاق في مشروع آخر"],
  ["Duplicate request", "طلب مكرر"],
  ["Customer did not proceed after the quotation", "لم يمضِ العميل بعد عرض السعر"],
];
const BLOCK_REASONS: Bi[] = [
  ["Waiting for material delivery", "بانتظار توريد المواد"],
  ["Permit not yet issued", "لم يصدر التصريح بعد"],
  ["Access blocked by other trades", "الوصول محجوب من فرق أخرى"],
  ["Awaiting client sign-off", "بانتظار اعتماد العميل"],
];
const RETURN_REASONS: Bi[] = [
  ["Hours do not match attendance; please correct", "الساعات لا تطابق الحضور؛ يرجى التصحيح"],
  ["Missing material quantities", "كميات المواد ناقصة"],
  ["Add the stage worked on", "أضف المرحلة التي تم العمل عليها"],
];
const REJECT_NOTES: Bi[] = [
  ["Photos do not show the finished work", "الصور لا تُظهر العمل المكتمل"],
  ["Checklist incomplete — redo the test", "قائمة التحقق غير مكتملة — أعد الاختبار"],
];
const FREE_MATERIALS: Array<[string, string, string]> = [
  ["Silicone sealant", "سيليكون", "pcs"],
  ["Cable ties (pack)", "رباطات كابلات (عبوة)", "pack"],
  ["Cleaning chemicals", "مواد تنظيف", "ltr"],
  ["Sandpaper", "ورق صنفرة", "pcs"],
  ["Diesel", "ديزل", "ltr"],
];
const PROGRESS_NOTES = ["~25%", "~40%", "about half", "~75%", "nearly done"];
const MATERIAL_GRADES = ["SS304", "SS316", "S275JR", "6061-T6", "Q235B"];
const PAYMENT_TERMS = [
  "30 days from invoice",
  "50% advance, balance on handover",
  "Due on receipt",
  "60 days",
];
const ADJUSTMENT_REASONS = [
  "Variation order 1",
  "Scope reduction agreed with client",
  "Additional access works",
];
const REVISION_REASONS = [
  "Two jobs pulled forward after the client meeting",
  "Crew reassigned after an emergency call-out",
  "Material delay moved the installation week",
];
const PLAN_CANCEL_REASONS = [
  "Public holiday week — replanned",
  "Site shut for inspection",
  "Replaced by an updated plan",
];
const ASSET_DETAILS = [
  "AHU-3, Level 2",
  "Chiller CH-1 (roof)",
  "Lift L2, Tower A",
  "Main DB, ground floor",
];

/** Which template presets are project-scale and which are small work orders. */
const PRESET_SPLIT: Record<string, { project: string[]; small: string[] }> = {
  construction_v1: { project: ["FIT", "CVL", "MEP", "REN"], small: ["REN", "MEP", "FIT"] },
  service_business_v1: { project: ["INST", "OVHL"], small: ["SVC", "MNT"] },
  generic_operations_v1: { project: ["PRJ"], small: ["JOB", "INT"] },
  manufacturing_workshop_v1: { project: ["FAB", "ASSY"], small: ["BATCH", "REP"] },
};

/** Selling-price bands per template, in major units. */
const PRICE_BANDS: Record<string, { project: [number, number]; small: [number, number] }> = {
  construction_v1: { project: [80_000, 1_500_000], small: [2_000, 40_000] },
  service_business_v1: { project: [15_000, 250_000], small: [300, 8_000] },
  generic_operations_v1: { project: [10_000, 200_000], small: [500, 12_000] },
  manufacturing_workshop_v1: { project: [25_000, 600_000], small: [1_500, 30_000] },
};

// ── Small pure helpers ──────────────────────────────────────────────────────

const DAY = 86_400_000;
const dayMs = (date: string) => Date.parse(date + "T00:00:00Z");
export function addDays(date: string, n: number): string {
  return new Date(dayMs(date) + n * DAY).toISOString().slice(0, 10);
}
function tsOn(date: string, hour: number, minute = 0): string {
  return new Date(dayMs(date) + hour * 3_600_000 + minute * 60_000).toISOString();
}
const yearOf = (date: string) => Number(date.slice(0, 4));
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const diffDays = (a: string, b: string) => Math.round((dayMs(a) - dayMs(b)) / DAY);

/** Monday of the week containing `date` (the product's own rule). */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** WP-YYYY-Www (ISO week), -Rn for a revision — the product's own numbering. */
export function weekReference(weekStart: string, revision: number): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  const target = new Date(d);
  target.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / DAY -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  const base = `WP-${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  return revision > 0 ? `${base}-R${revision}` : base;
}

/** The sanctioned denormalisation: earliest in_progress, else earliest not_started, else null. */
export function currentStageOf<T extends { status: string; sort: number }>(stages: T[]): T | null {
  const ordered = [...stages].sort((a, b) => a.sort - b.sort);
  return (
    ordered.find((s) => s.status === "in_progress") ??
    ordered.find((s) => s.status === "not_started") ??
    null
  );
}

function bi(rng: Rng, pool: Bi[], lang: "en" | "ar"): string {
  const p = pick(rng, pool);
  return lang === "ar" ? p[1] : p[0];
}

function sum<T>(arr: readonly T[], f: (x: T) => number): number {
  let n = 0;
  for (const x of arr) n += f(x);
  return n;
}

// ── The model ───────────────────────────────────────────────────────────────

/** A person reference the model can hold without knowing employee ids. */
type Who = { crew: number } | { raw: number } | { persona: PersonaKey };

type StageM = {
  id: string;
  stageKey: string;
  names: { en: string; ar: string };
  weight: number;
  sort: number;
  phase: string | null;
  status: (typeof STAGE_STATUSES)[number];
  startedAt: string | null;
  completedAt: string | null;
  completionRequestedBy: string | null;
  completionRequestedAt: string | null;
};
type CrewM = { who: Who; addedAt: string; removedAt: string | null; removedBy: string | null };
type DepM = { id: string; dependsOnTaskId: string; lagDays: number; createdAt: string };
type AllocM = { id: string; who: Who; sharePct: number; note: string | null; createdAt: string };
type ApprovalM = {
  id: string;
  state: (typeof APPROVAL_STATES)[number];
  requestedBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  expiresHint: string;
};
type TaskM = {
  id: string;
  ord: number;
  stageId: string | null;
  title: string;
  description: string | null;
  status: (typeof TASK_STATUSES)[number];
  priority: string;
  assignee: Who | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  blockedReason: string | null;
  requiresApproval: boolean;
  durationDays: number | null;
  isMilestone: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approval: ApprovalM | null;
  deps: DepM[];
  allocations: AllocM[];
};
type WorkLineM = {
  id: string;
  stageKey: string | null;
  stageId: string | null;
  description: string;
  progressNote: string | null;
};
type LabourLineM = { id: string; who: Who; normalHours: number; otHours: number };
type MaterialLineM = {
  id: string;
  itemRaw: number | null;
  freeName: string | null;
  freeUnit: string | null;
  qty: number;
  costSource: "catalog" | "manual" | "none";
  manualCostMinor: number | null;
  deducted: boolean;
};
type ReportM = {
  id: string;
  ord: number;
  reportDate: string;
  status: (typeof REPORT_STATUSES)[number];
  summary: string;
  blockers: string | null;
  nextSteps: string | null;
  submittedBy: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  returnedBy: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  idem: string;
  createdAt: string;
  work: WorkLineM[];
  labour: LabourLineM[];
  material: MaterialLineM[];
};
type IssueM = {
  id: string;
  jobId: string | null;
  jobIndex: number | null;
  title: string;
  description: string | null;
  severity: string;
  isBlocker: boolean;
  status: (typeof ISSUE_STATUSES)[number];
  raisedBy: string;
  assignee: Who | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
};
type CommentM = {
  id: string;
  entityType: "job" | "task" | "issue";
  entityId: string;
  author: string;
  body: string;
  createdAt: string;
};
type ActivityM = {
  id: string;
  actor: string;
  entityType: "job" | "issue" | "task";
  entityId: string;
  verb: string;
  summary: string;
  createdAt: string;
};
type PriceAdjustment = { amount_minor: number; reason: string; actor_user_id: string; at: string };
type JobM = {
  index: number;
  id: string;
  isProject: boolean;
  presetCode: string;
  scope: string;
  seq: number;
  reference: string;
  name: string;
  customerRaw: number | null;
  statusKey: string;
  category: (typeof JOB_CATEGORIES)[number];
  archived: boolean;
  archivedAt: string | null;
  managerUser: string;
  foremanUser: string;
  foremanPersona: PersonaKey;
  createdBy: string;
  createdDate: string;
  createdAt: string;
  updatedAt: string;
  startDate: string;
  dueDate: string;
  completedDate: string | null;
  endRef: string;
  priority: string;
  description: string | null;
  location: string | null;
  origin: "direct" | "quotation";
  sellingPriceMinor: number | null;
  paymentTerms: string | null;
  priceAdjustments: PriceAdjustment[];
  billingPoints: unknown;
  customValues: Record<string, unknown>;
  onHoldReason: string | null;
  cancellationReason: string | null;
  progressOverride: { percent: number; reason: string; at: string } | null;
  stages: StageM[];
  currentStageId: string | null;
  crew: CrewM[];
  tasks: TaskM[];
  reports: ReportM[];
  issues: IssueM[];
  comments: CommentM[];
  activity: ActivityM[];
};
type RuleM = {
  id: string;
  subjectType: string;
  conditionKind: "always" | "amount_gte" | "urgency_in";
  amountGteMinor: number | null;
  urgencyIn: string[] | null;
  assignedRole: string;
  autoApproveBelowMinor: number | null;
};
type WeekPlanM = {
  id: string;
  reference: string;
  weekStart: string;
  weekEnd: string;
  title: string | null;
  notes: string | null;
  status: (typeof WEEK_PLAN_STATUSES)[number];
  issuedAt: string | null;
  cancelledReason: string | null;
  revisionOfId: string | null;
  revisionReason: string | null;
  createdAt: string;
  jobs: Array<{ id: string; jobId: string; sort: number; note: string | null }>;
};

/** Which bulk rows the seed drives through the real services afterwards. */
export type ServiceSample = {
  jobStatus: Array<{
    jobId: string;
    from: string;
    to: string;
    statusKey: string;
    reason: string | null;
    persona: PersonaKey;
  }>;
  archive: string[];
  reopen: Array<{ jobId: string; statusKey: string }>;
  stages: Array<{ jobId: string; completeStageId: string; startStageId: string | null }>;
  tasks: Array<{
    taskId: string;
    from: string;
    to: string;
    reason: string | null;
    actualMinutes: number | null;
  }>;
  approvals: Array<{ approvalId: string; decision: "approved" | "rejected"; note: string | null }>;
  reports: Array<{ reportId: string; to: "reviewed" | "returned"; reason: string | null }>;
  issues: Array<{ issueId: string; to: string | null; assignRaw: number | null }>;
  weekPlans: { issue: string | null; cancel: { id: string; reason: string } | null };
};

export type WorkModel = {
  users: Record<PersonaKey, string>;
  /** When the organisation's approval configuration was written. */
  configAt: string;
  jobs: JobM[];
  orgIssues: IssueM[];
  orgComments: CommentM[];
  orgActivity: ActivityM[];
  rules: RuleM[];
  ruleIdBySubject: Record<string, string>;
  weekPlans: WeekPlanM[];
  sequences: Array<{ scope: string; next: number }>;
  sample: ServiceSample;
  counts: Record<WorkTable, number>;
};

// ── Template access ─────────────────────────────────────────────────────────

type StageT = {
  stage_key: string;
  names: { en: string; ar: string };
  weight: number;
  phase_semantic: string | null;
};
type PresetT = { code: string; default_skipped_stage_keys: string[]; billing_points: unknown };
type FieldT = { field_key: string; type: string; options?: Array<{ key: string }> };
type Tpl = {
  key: string;
  stages: StageT[];
  presets: PresetT[];
  statusKeys: {
    draft: string;
    active: string[];
    onHold: string;
    done: string[];
    cancelled: string;
  };
  pattern: { pattern: string; start: number };
  fields: FieldT[];
};

export function templateOf(company: Company): Tpl {
  const m = TEMPLATES[company.templateKey];
  if (!m) throw new Error(`work: unknown template ${company.templateKey}`);
  const statuses = m.status_sets.job.statuses;
  const byCat = (c: string) =>
    statuses
      .filter((s) => s.semantic_category === c)
      .sort((a, b) => a.sort - b.sort)
      .map((s) => s.status_key);
  const first = (c: string, fallback: string) => byCat(c)[0] ?? fallback;
  return {
    key: m.key,
    stages: m.stage_template.stages.map((s) => ({
      stage_key: s.stage_key,
      names: s.names,
      weight: s.weight,
      phase_semantic: s.phase_semantic ?? null,
    })),
    presets: m.presets.map((p) => ({
      code: p.code,
      default_skipped_stage_keys: p.default_skipped_stage_keys ?? [],
      billing_points: p.billing_points,
    })),
    statusKeys: {
      draft: first("draft", "draft"),
      active: byCat("active").length ? byCat("active") : ["in_progress"],
      onHold: first("on_hold", "on_hold"),
      done: byCat("done").length ? byCat("done") : ["completed"],
      cancelled: first("cancelled", "cancelled"),
    },
    pattern: m.reference_patterns.job ?? { pattern: "{preset_code}-{seq:3}", start: 1 },
    fields: (m.field_definitions?.job?.fields ?? []).map((f) => ({
      field_key: f.field_key,
      type: f.type,
      options: f.options,
    })),
  };
}

// ── Building the model ──────────────────────────────────────────────────────

const MODELS = new WeakMap<LabContext, WorkModel>();

export function buildModel(ctx: LabContext): WorkModel {
  const memo = MODELS.get(ctx);
  if (memo) return memo;
  const model = build(ctx.company, ctx.rng, ctx.clock, ctx.id, ctx.users);
  MODELS.set(ctx, model);
  return model;
}

function build(
  company: Company,
  rng: Rng,
  clock: SimClock,
  id: LabContext["id"],
  users: Record<PersonaKey, string>,
): WorkModel {
  const tpl = templateOf(company);
  const profile = company.profile;
  const asOf = clock.asOf;
  const arabicFirst = company.languages[0] === "ar";
  const lang = (): "en" | "ar" =>
    arabicFirst ? (rng.chance(0.75) ? "ar" : "en") : rng.chance(0.2) ? "ar" : "en";
  const hour = () => rng.int(7, 17);
  const persona = (weights: Partial<Record<PersonaKey, number>>): PersonaKey =>
    weighted(rng, weights as Record<PersonaKey, number>);
  const names = JOB_NAMES[company.key] ?? JOB_NAMES.gulfbuild!;
  const split = PRESET_SPLIT[tpl.key] ?? {
    project: tpl.presets.map((p) => p.code),
    small: tpl.presets.map((p) => p.code),
  };
  const presetByCode = new Map(tpl.presets.map((p) => [p.code, p]));
  const projectPresets = split.project.filter((c) => presetByCode.has(c));
  const smallPresets = split.small.filter((c) => presetByCode.has(c));
  if (projectPresets.length === 0 || smallPresets.length === 0)
    throw new Error(`work: template ${tpl.key} has no usable presets`);
  const bands = PRICE_BANDS[tpl.key] ?? PRICE_BANDS.generic_operations_v1!;
  const withStock = profile.enables.stock;
  const configAt = tsOn(company.history.from, 9);

  const nJobs = profile.jobs;
  const nProjects = Math.min(profile.projects, nJobs);
  const [tLo, tHi] = profile.tasksPerJob;
  const createdAgos = spreadDates(rng, company, nJobs); // oldest first
  const seqByScope = new Map<string, number>();
  const usesPresetScope = tpl.pattern.pattern.includes("{preset_code}");

  // Approval configuration: this family owns the task-completion subject only.
  // Other subjects (leave, expenses, purchasing, quotes) belong to the families
  // that create those documents; a second "always" rule per subject would trip
  // approval_rule_one_always_per_subject.
  const rules: RuleM[] = [
    {
      id: id("approval_rule", "task_completion", 0),
      subjectType: "task_completion",
      conditionKind: "always",
      amountGteMinor: null,
      urgencyIn: null,
      assignedRole: "manager",
      autoApproveBelowMinor: null,
    },
  ];
  const ruleIdBySubject: Record<string, string> = Object.fromEntries(
    rules.map((r) => [r.subjectType, r.id]),
  );

  const jobs: JobM[] = [];
  const stageCount = tpl.stages.length;

  for (let i = 0; i < nJobs; i++) {
    const isProject =
      Math.floor((i * nProjects) / nJobs) !== Math.floor(((i - 1) * nProjects) / nJobs);
    const createdAgo = createdAgos[i]!;
    const createdDate = clock.dayAgo(createdAgo);
    const createdAt = tsOn(createdDate, hour(), rng.int(0, 59));
    const presetCode = pick(rng, isProject ? projectPresets : smallPresets);
    const preset = presetByCode.get(presetCode)!;
    const scope = usesPresetScope ? `job.${presetCode}` : "job";
    const seq = seqByScope.get(scope) ?? tpl.pattern.start;
    seqByScope.set(scope, seq + 1);
    const reference = renderReference(tpl.pattern.pattern, {
      presetCode,
      seq,
      year: yearOf(createdDate),
    });

    const l = lang();
    const base = bi(rng, isProject ? names.project : names.small, l);
    const site = city(company, rng);
    const name = longTitle(rng, l, `${base} — ${l === "ar" ? site.ar : site.en}`).slice(0, 160);

    // Timeline.
    const startOffset = isProject ? rng.int(2, 14) : rng.int(0, 3);
    const duration = isProject ? rng.int(30, 180) : rng.int(1, 10);
    const startDate = addDays(createdDate, startOffset);
    const dueDate = addDays(startDate, duration);
    const elapsed = createdAgo - startOffset; // days since start (negative: not started yet)
    const f = elapsed / duration;
    let category: JobM["category"];
    if (elapsed < 0) category = rng.chance(0.6) ? "draft" : "active";
    else if (f >= 1.1) category = weighted(rng, { done: 88, cancelled: 7, active: 5 });
    else if (f >= 0.6) category = weighted(rng, { done: 35, active: 50, on_hold: 8, cancelled: 7 });
    else category = weighted(rng, { active: 78, on_hold: 10, draft: 4, cancelled: 8 });
    if (createdAgo < 2 && rng.chance(0.5)) category = "draft";

    let completedDate: string | null = null;
    let endRef = asOf; // the last day work happened on this job
    if (category === "done") {
      completedDate = minDate(
        addDays(startDate, Math.max(1, Math.round(duration * rng.float(0.7, 1.25)))),
        asOf,
      );
      completedDate = maxDate(completedDate, createdDate);
      endRef = completedDate;
    } else if (category === "cancelled") {
      endRef =
        elapsed < 0
          ? createdDate
          : minDate(addDays(startDate, Math.round(duration * rng.float(0.05, 0.9))), asOf);
      endRef = maxDate(endRef, createdDate);
    }
    const statusKey =
      category === "draft"
        ? tpl.statusKeys.draft
        : category === "active"
          ? tpl.statusKeys.active.length > 1 && rng.chance(0.15)
            ? tpl.statusKeys.active[1]!
            : tpl.statusKeys.active[0]!
          : category === "on_hold"
            ? tpl.statusKeys.onHold
            : category === "done"
              ? rng.chance(0.8)
                ? tpl.statusKeys.done[0]!
                : (tpl.statusKeys.done[1] ?? tpl.statusKeys.done[0]!)
              : tpl.statusKeys.cancelled;
    const terminal = category === "done" || category === "cancelled";
    const archived = terminal && clock.daysAgoOf(endRef) > 120 && rng.chance(0.35);
    const archivedAt = archived ? tsOn(addDays(endRef, rng.int(30, 90)), hour()) : null;

    const foremanPersona: PersonaKey = rng.chance(isProject ? 0.25 : 0.3) ? "restricted" : "field";
    const managerPersona = persona({ manager: 75, admin: 15, owner: 10 });
    const managerUser = users[managerPersona];
    const foremanUser = users[foremanPersona];
    const createdBy = users[persona({ manager: 80, admin: 12, owner: 8 })];
    const priority =
      company.key === "facilico" && !isProject && presetCode === "SVC"
        ? weighted(rng, { urgent: 25, high: 30, normal: 40, low: 5 })
        : weighted(rng, { normal: 60, high: 20, low: 12, urgent: 8 });
    const loc = address(company, rng, i);
    const location = rng.chance(0.7) ? (l === "ar" ? loc.ar : loc.en).slice(0, 200) : null;
    const description = rng.chance(isProject ? 0.8 : 0.35)
      ? paragraph(rng, l, isProject ? 3 : 1)
      : null;
    const origin: JobM["origin"] = isProject && rng.chance(0.3) ? "quotation" : "direct";
    const band = isProject ? bands.project : bands.small;
    const sellingPriceMinor =
      isProject || rng.chance(0.6) ? priceMinor(rng, band[0], band[1]) : null;
    const paymentTerms =
      sellingPriceMinor !== null && rng.chance(0.4) ? pick(rng, PAYMENT_TERMS) : null;
    const priceAdjustments: PriceAdjustment[] =
      isProject && sellingPriceMinor !== null && rng.chance(0.12)
        ? [
            {
              amount_minor: priceMinor(rng, 500, 20_000) * (rng.chance(0.7) ? 1 : -1),
              reason: pick(rng, ADJUSTMENT_REASONS),
              actor_user_id: users.owner,
              at: tsOn(addDays(startDate, rng.int(1, Math.max(1, duration))), hour()),
            },
          ]
        : [];
    const customValues = customValuesFor(tpl, rng, priority, loc.en, yearOf(createdDate), i);
    const holdReason = category === "on_hold" ? bi(rng, HOLD_REASONS, l) : null;
    const cancellationReason = category === "cancelled" ? bi(rng, CANCEL_REASONS, l) : null;

    // Stage snapshots (exactly what createJobFromPreset writes, then advanced).
    const skipped = new Set(preset.default_skipped_stage_keys);
    const active = tpl.stages.filter((s) => !skipped.has(s.stage_key)).length;
    const progressFraction =
      category === "draft"
        ? 0
        : category === "done"
          ? 1
          : Math.min(Math.max(elapsed, 0) / duration, 0.95) *
            (category === "cancelled" ? rng.float(0.2, 1) : 1);
    const cursor =
      category === "done" ? active : Math.min(active - 1, Math.floor(progressFraction * active));
    const span = Math.max(1, diffDays(endRef, startDate));
    const stages: StageM[] = [];
    let activeIdx = 0;
    for (let s = 0; s < stageCount; s++) {
      const st = tpl.stages[s]!;
      const isSkipped = skipped.has(st.stage_key);
      let status: StageM["status"] = "not_started";
      let startedAt: string | null = null;
      let completedAt: string | null = null;
      if (isSkipped) status = "skipped";
      else if (category !== "draft") {
        const k = activeIdx;
        /*
         * Stage dates are laid out across the job's planned span, and for a job
         * still running that span ends in the future — so a stage marked
         * COMPLETED could carry a completion date after the simulation's today.
         * Nothing in the product can complete tomorrow. Clamp to today; the
         * ordering across stages is preserved because the clamp is monotonic.
         */
        const notFuture = (d: string) => (d > asOf ? asOf : d);
        if (k < cursor) {
          status = "completed";
          startedAt = tsOn(notFuture(addDays(startDate, Math.floor((span * k) / active))), 8);
          completedAt = tsOn(
            notFuture(addDays(startDate, Math.floor((span * (k + 1)) / active))),
            16,
          );
        } else if (k === cursor && category !== "done") {
          status = "in_progress";
          startedAt = tsOn(notFuture(addDays(startDate, Math.floor((span * k) / active))), 8);
        }
        activeIdx++;
      }
      const requested = status === "in_progress" && rng.chance(0.1);
      stages.push({
        id: id("job_stage", i, st.stage_key),
        stageKey: st.stage_key,
        names: st.names,
        weight: st.weight,
        sort: s,
        phase: st.phase_semantic,
        status,
        startedAt,
        completedAt,
        completionRequestedBy: requested ? foremanUser : null,
        completionRequestedAt: requested ? tsOn(clock.dayAgo(rng.int(0, 5)), hour()) : null,
      });
    }
    const currentStageId = currentStageOf(stages)?.id ?? null;
    const progressOverride =
      isProject && category === "active" && rng.chance(0.02)
        ? {
            percent: rng.int(20, 90),
            reason: "Client-agreed measured progress after joint inspection",
            at: tsOn(clock.dayAgo(rng.int(0, 20)), hour()),
          }
        : null;

    // Crew: the foreman persona's employee first, then colleagues.
    const crewSize = isProject ? rng.int(2, 4) : rng.chance(0.6) ? 1 : 0;
    const crew: CrewM[] = [];
    for (let c = 0; c < crewSize; c++) {
      const removed = isProject && c > 0 && rng.chance(0.05) && category !== "draft";
      crew.push({
        who: c === 0 ? { persona: foremanPersona } : { raw: rng.int(0, 1_000_000) },
        addedAt: tsOn(addDays(createdDate, Math.min(startOffset, rng.int(0, 3))), hour()),
        removedAt: removed ? tsOn(addDays(startDate, rng.int(1, Math.max(1, span))), hour()) : null,
        removedBy: removed ? managerUser : null,
      });
    }
    const crewWho = (k: number): Who =>
      crew.length ? { crew: k % crew.length } : { raw: rng.int(0, 1_000_000) };

    // Tasks, aligned with the stages so their statuses agree with progress.
    const nonSkipped = stages.filter((s) => s.status !== "skipped");
    const nTasks = isProject ? rng.int(tLo, tHi) : rng.int(0, Math.min(3, tHi));
    const tasks: TaskM[] = [];
    for (let t = 0; t < nTasks; t++) {
      const sIdx = nonSkipped.length
        ? Math.min(nonSkipped.length - 1, Math.floor((t * nonSkipped.length) / Math.max(1, nTasks)))
        : -1;
      const stage = sIdx >= 0 ? nonSkipped[sIdx]! : null;
      const tl = lang();
      const title = bi(rng, TASK_TITLES[stage?.phase ?? "other"] ?? TASK_TITLES.other!, tl);
      const tStart = stage
        ? addDays(startDate, Math.floor((span * sIdx) / Math.max(1, nonSkipped.length)))
        : startDate;
      const tDue = stage
        ? addDays(startDate, Math.floor((duration * (sIdx + 1)) / Math.max(1, nonSkipped.length)))
        : dueDate;
      let status: TaskM["status"];
      if (category === "draft") status = "pending";
      else if (category === "done") status = rng.chance(0.05) ? "cancelled" : "completed";
      else if (category === "cancelled")
        status =
          stage && stage.status === "completed"
            ? "completed"
            : rng.chance(0.5)
              ? "cancelled"
              : "pending";
      else if (stage?.status === "completed") status = rng.chance(0.06) ? "cancelled" : "completed";
      else if (stage?.status === "in_progress")
        status = weighted(rng, {
          in_progress: 40,
          completed: 25,
          pending: 20,
          blocked: 6,
          ready: 9,
        });
      else status = "pending";
      const completedAt =
        status === "completed"
          ? tsOn(
              minDate(
                minDate(
                  addDays(tStart, rng.int(0, Math.max(0, diffDays(tDue, tStart)) + 3)),
                  endRef,
                ),
                asOf,
              ),
              rng.int(9, 17),
            )
          : null;
      const blockedReason = status === "blocked" ? bi(rng, BLOCK_REASONS, tl) : null;
      const requiresApproval = isProject && rng.chance(0.05);
      const estimated = rng.chance(0.6) ? rng.int(1, 40) * 60 : null;
      const taskCreatedAt = tsOn(
        minDate(addDays(createdDate, rng.int(0, Math.max(0, startOffset))), asOf),
        hour(),
      );
      tasks.push({
        id: id("task", i, t),
        ord: t,
        stageId: stage?.id ?? null,
        title,
        description: rng.chance(0.4) ? sentence(rng, tl) : null,
        status,
        priority: weighted(rng, { normal: 65, high: 20, low: 10, urgent: 5 }),
        assignee: rng.chance(0.85) ? crewWho(t) : null,
        startDate: tStart,
        dueDate: tDue,
        completedAt,
        estimatedMinutes: estimated,
        actualMinutes:
          status === "completed" && estimated !== null && rng.chance(0.8)
            ? Math.round(estimated * rng.float(0.6, 1.5))
            : null,
        blockedReason,
        requiresApproval,
        durationDays: isProject && rng.chance(0.3) ? rng.int(1, 15) : null,
        isMilestone: isProject && t === nTasks - 1 && rng.chance(0.3),
        createdBy: managerUser,
        createdAt: taskCreatedAt,
        updatedAt: completedAt ?? taskCreatedAt,
        approval: null,
        deps: [],
        allocations: [],
      });
    }
    // Finish-to-start chains inside project work; readiness follows the edges.
    for (let t = 1; t < tasks.length; t++) {
      if (!isProject || !rng.chance(0.55)) continue;
      const up = tasks[t - 1]!;
      const down = tasks[t]!;
      down.deps.push({
        id: id("task_dependency", i, t),
        dependsOnTaskId: up.id,
        lagDays: rng.int(0, 2),
        createdAt: down.createdAt,
      });
      const upDone = up.status === "completed" || up.status === "cancelled";
      if (
        !upDone &&
        (down.status === "ready" || down.status === "in_progress" || down.status === "completed")
      )
        down.status = "pending";
      if (upDone && down.status === "pending" && category !== "draft" && category !== "cancelled")
        down.status = "ready";
      if (down.status !== "completed") {
        down.completedAt = null;
        down.actualMinutes = null;
      }
      if (down.status !== "blocked") down.blockedReason = null;
    }
    // Approval-gated steps: the approval row mirrors the task's state exactly.
    for (const task of tasks) {
      if (!task.requiresApproval) continue;
      const reqAt = tsOn(minDate(addDays(task.startDate ?? startDate, 1), asOf), hour());
      const mk = (
        state: ApprovalM["state"],
        decidedAt: string | null,
        note: string | null,
      ): ApprovalM => ({
        id: id("approval", i, task.ord),
        state,
        requestedBy: foremanUser,
        createdAt:
          state === "approved" && task.completedAt ? tsOn(task.completedAt.slice(0, 10), 8) : reqAt,
        decidedBy: state === "pending" || state === "withdrawn" ? null : managerUser,
        // A decision cannot be dated after today: the request date is already
        // clamped, and a rejection adds a day to it.
        decidedAt:
          decidedAt === null ? null : minDate(decidedAt.slice(0, 10), asOf) + decidedAt.slice(10),
        note,
        expiresHint: new Date(Date.parse(reqAt) + 3 * DAY).toISOString(),
      });
      if (task.status === "completed")
        task.approval = mk(
          "approved",
          task.completedAt,
          rng.chance(0.3) ? "Approved after site check" : null,
        );
      else if (task.status === "in_progress") {
        const r = rng.next();
        if (r < 0.45) {
          task.status = "awaiting_approval";
          task.approval = mk("pending", null, null);
        } else if (r < 0.7)
          task.approval = mk(
            "rejected",
            tsOn(addDays(reqAt.slice(0, 10), 1), hour()),
            bi(rng, REJECT_NOTES, lang()),
          );
        else if (r < 0.85) task.approval = mk("withdrawn", null, null);
      } else if (task.status === "cancelled" && rng.chance(0.5))
        task.approval = mk("superseded", tsOn(endRef, hour()), "The step was cancelled");
    }
    // Allocations: who gives what share of their day to an open step.
    for (const task of tasks) {
      if (
        !isProject ||
        task.status === "completed" ||
        task.status === "cancelled" ||
        !rng.chance(0.45)
      )
        continue;
      const first: Who = task.assignee ?? crewWho(task.ord);
      task.allocations.push({
        id: id("task_allocation", i, task.ord, 0),
        who: first,
        sharePct: pick(rng, [50, 75, 100]),
        note: null,
        createdAt: task.createdAt,
      });
      if (crew.length >= 2 && rng.chance(0.2)) {
        const firstCrew = "crew" in first ? first.crew : -1;
        const other = (firstCrew + 1) % crew.length;
        task.allocations.push({
          id: id("task_allocation", i, task.ord, 1),
          who: { crew: other },
          sharePct: pick(rng, [25, 50]),
          note: "Supporting",
          createdAt: task.createdAt,
        });
      }
    }

    // Daily reports on distinct working days between start and the last day worked.
    const reports: ReportM[] = [];
    const wantReports =
      category === "draft" || elapsed < 0
        ? 0
        : isProject
          ? rng.int(2, 5)
          : rng.chance(0.12)
            ? 1
            : 0;
    const daysAvailable = Math.max(0, diffDays(minDate(endRef, asOf), startDate));
    const nReports = Math.min(wantReports, daysAvailable + 1);
    const usedDays = new Set<number>();
    /*
     * A job may hold only one daily report per date — the product enforces it.
     * Offsets are kept unique, but the working-day shift can move a report onto
     * a date another offset already produced, so uniqueness is asserted on the
     * DATE that is actually written, not on the offset it came from.
     */
    const usedDates = new Set<string>();
    for (let r = 0; r < nReports; r++) {
      let offset = rng.int(0, daysAvailable);
      let guard = 0;
      while (usedDays.has(offset) && guard++ < 20) offset = rng.int(0, daysAvailable);
      if (usedDays.has(offset))
        offset = [...Array(daysAvailable + 1).keys()].find((d) => !usedDays.has(d)) ?? offset;
      usedDays.add(offset);
      let reportDate = addDays(startDate, offset);
      const wd = workingDayAgo(clock, clock.daysAgoOf(reportDate), company.sixDayWeek);
      const shifted = clock.dayAgo(wd);
      if (shifted >= startDate && !usedDays.has(diffDays(shifted, startDate))) {
        usedDays.add(diffDays(shifted, startDate));
        reportDate = shifted;
      }
      if (usedDates.has(reportDate)) continue;
      usedDates.add(reportDate);
      const age = clock.daysAgoOf(reportDate);
      const status: ReportM["status"] =
        age >= 14
          ? weighted(rng, { reviewed: 85, returned: 8, submitted: 7 })
          : age >= 3
            ? weighted(rng, { submitted: 55, reviewed: 40, returned: 5 })
            : weighted(rng, { draft: 40, submitted: 60 });
      const rl = lang();
      const submittedAt = status === "draft" ? null : tsOn(reportDate, 17, rng.int(0, 59));
      const reviewedAt =
        status === "reviewed" ? tsOn(addDays(reportDate, 1), 9, rng.int(0, 59)) : null;
      const returnedAt =
        status === "returned" ? tsOn(addDays(reportDate, 1), 10, rng.int(0, 59)) : null;
      const stageAt = stages.filter((s) => s.status === "completed" || s.status === "in_progress");
      const work: WorkLineM[] = [];
      const nWork = isProject ? rng.int(1, 2) : 1;
      for (let w = 0; w < nWork; w++) {
        const st = stageAt.length ? pick(rng, stageAt) : null;
        work.push({
          id: id("report_work_line", i, r, w),
          stageKey: st?.stageKey ?? null,
          stageId: st?.id ?? null,
          description: sentence(rng, rl),
          progressNote: rng.chance(0.3) ? pick(rng, PROGRESS_NOTES) : null,
        });
      }
      const labour: LabourLineM[] = [];
      const nLabour = crew.length ? Math.min(crew.length, rng.int(1, 3)) : 1;
      for (let k = 0; k < nLabour; k++) {
        labour.push({
          id: id("report_labour_line", i, r, k),
          who: crew.length ? { crew: k } : { raw: rng.int(0, 1_000_000) },
          normalHours: pick(rng, [8, 8, 8, 9, 6]),
          otHours: rng.chance(0.25) ? rng.int(1, 3) : 0,
        });
      }
      const material: MaterialLineM[] = [];
      const nMaterial = !withStock
        ? 0
        : company.key === "consult"
          ? rng.int(0, 1)
          : isProject
            ? rng.int(0, 2)
            : rng.chance(0.6)
              ? 1
              : 0;
      for (let m = 0; m < nMaterial; m++) {
        const free = rng.chance(0.15);
        const fm = free ? pick(rng, FREE_MATERIALS) : null;
        const manual = free && rng.chance(0.5);
        const deducted =
          !free && (status === "submitted" || status === "reviewed") && rng.chance(0.2);
        material.push({
          id: id("report_material_line", i, r, m),
          itemRaw: free ? null : rng.int(0, 1_000_000),
          freeName: fm ? (rl === "ar" ? fm[1] : fm[0]) : null,
          freeUnit: fm ? fm[2] : null,
          qty: rng.int(1, 40),
          costSource: free ? (manual ? "manual" : "none") : "catalog",
          manualCostMinor: manual ? priceMinor(rng, 5, 200) : null,
          deducted,
        });
      }
      reports.push({
        id: id("daily_report", i, r),
        ord: r,
        reportDate,
        status,
        summary: paragraph(rng, rl, 2),
        blockers: rng.chance(0.3) ? sentence(rng, rl) : null,
        nextSteps: rng.chance(0.5) ? sentence(rng, rl) : null,
        submittedBy: foremanUser,
        submittedAt,
        reviewedBy: status === "reviewed" ? managerUser : null,
        reviewedAt,
        returnedBy: status === "returned" ? managerUser : null,
        returnedAt,
        returnReason: status === "returned" ? bi(rng, RETURN_REASONS, rl) : null,
        idem: `${brandNow().idPrefix}-${company.key}-report-${i}-${r}`,
        createdAt: tsOn(reportDate, 16, rng.int(0, 59)),
        work,
        labour,
        material,
      });
    }

    // Issues raised on this work.
    const issues: IssueM[] = [];
    const nIssues = category === "draft" ? 0 : isProject ? rng.int(0, 3) : rng.chance(0.04) ? 1 : 0;
    for (let q = 0; q < nIssues; q++) {
      const il = lang();
      // A job scheduled to start next week has a startDate in the future, and an
      // issue cannot be raised against work nobody has begun; clamp the whole
      // expression rather than only its span.
      const raisedDate = minDate(
        addDays(startDate, rng.int(0, Math.max(0, diffDays(minDate(endRef, asOf), startDate)))),
        asOf,
      );
      const raisedAgo = clock.daysAgoOf(raisedDate);
      const resolved = terminal
        ? rng.chance(0.85)
        : rng.chance(Math.min(0.9, 0.2 + raisedAgo / 120));
      const status: IssueM["status"] = resolved
        ? rng.chance(0.7)
          ? "resolved"
          : "closed"
        : rng.chance(0.65)
          ? "open"
          : "in_progress";
      const resolvedAt = resolved
        ? tsOn(minDate(addDays(raisedDate, rng.int(1, 20)), asOf), hour())
        : null;
      issues.push({
        id: id("issue", i, q),
        jobId: id("job", i),
        jobIndex: i,
        title: bi(rng, ISSUE_TITLES, il),
        description: rng.chance(0.6) ? paragraph(rng, il, 2) : null,
        severity: weighted(rng, { low: 25, medium: 45, high: 22, critical: 8 }),
        isBlocker: rng.chance(0.2),
        status,
        raisedBy: rng.chance(0.7) ? foremanUser : managerUser,
        assignee: rng.chance(0.6) ? crewWho(q) : null,
        resolvedBy: resolved ? managerUser : null,
        resolvedAt,
        createdAt: tsOn(raisedDate, hour(), rng.int(0, 59)),
      });
    }

    // Narrative: comments and the activity timeline.
    const comments: CommentM[] = [];
    const activity: ActivityM[] = [];
    const jobId = id("job", i);
    activity.push({
      id: id("activity", "job", i, "created"),
      actor: createdBy,
      entityType: "job",
      entityId: jobId,
      verb: "created",
      summary: `created ${reference} — ${name}`.slice(0, 400),
      createdAt,
    });
    let updatedAt = createdAt;
    if (category !== "draft") {
      const movedAt =
        category === "done" && completedDate
          ? tsOn(completedDate, 17)
          : category === "cancelled"
            ? tsOn(endRef, hour())
            : tsOn(maxDate(minDate(startDate, asOf), createdDate), hour());
      activity.push({
        id: id("activity", "job", i, "moved"),
        actor: managerUser,
        entityType: "job",
        entityId: jobId,
        verb: "moved",
        summary: `moved ${reference} to ${category}`,
        createdAt: movedAt,
      });
      updatedAt = maxDate(movedAt, updatedAt);
    }
    const nJobComments = isProject ? rng.int(0, 3) : 0;
    for (let c = 0; c < nJobComments; c++) {
      const cl = lang();
      const at = tsOn(
        addDays(createdDate, rng.int(0, Math.max(0, diffDays(minDate(endRef, asOf), createdDate)))),
        hour(),
        rng.int(0, 59),
      );
      comments.push({
        id: id("comment", "job", i, c),
        entityType: "job",
        entityId: jobId,
        author: pick(rng, [managerUser, foremanUser, users.owner]),
        body: sentence(rng, cl),
        createdAt: at,
      });
    }
    for (const task of tasks) {
      if (!rng.chance(0.05)) continue;
      comments.push({
        id: id("comment", "task", i, task.ord),
        entityType: "task",
        entityId: task.id,
        author: rng.chance(0.6) ? foremanUser : managerUser,
        body: sentence(rng, lang()),
        createdAt: tsOn(minDate(addDays(task.createdAt.slice(0, 10), rng.int(0, 5)), asOf), hour()),
      });
    }
    for (const issue of issues) {
      activity.push({
        id: id("activity", "issue", issue.id),
        actor: issue.raisedBy,
        entityType: "issue",
        entityId: issue.id,
        verb: "raised",
        summary: `raised an issue: ${issue.title}`.slice(0, 400),
        createdAt: issue.createdAt,
      });
      if (rng.chance(0.4))
        comments.push({
          id: id("comment", "issue", issue.id),
          entityType: "issue",
          entityId: issue.id,
          author: managerUser,
          body: sentence(rng, lang()),
          createdAt: tsOn(
            minDate(addDays(issue.createdAt.slice(0, 10), rng.int(0, 3)), asOf),
            hour(),
          ),
        });
    }
    for (const c of comments)
      activity.push({
        id: id("activity", "comment", c.id),
        actor: c.author,
        entityType: c.entityType,
        entityId: c.entityId,
        verb: "commented",
        summary: c.body.slice(0, 140),
        createdAt: c.createdAt,
      });

    jobs.push({
      index: i,
      id: jobId,
      isProject,
      presetCode,
      scope,
      seq,
      reference,
      name,
      customerRaw: presetCode === "INT" ? null : rng.chance(0.88) ? rng.int(0, 1_000_000) : null,
      statusKey,
      category,
      archived,
      archivedAt,
      managerUser,
      foremanUser,
      foremanPersona,
      createdBy,
      createdDate,
      createdAt,
      updatedAt: maxDate(updatedAt, archivedAt ?? updatedAt),
      startDate,
      dueDate,
      completedDate,
      endRef,
      priority,
      description,
      location,
      origin,
      sellingPriceMinor,
      paymentTerms,
      priceAdjustments,
      billingPoints: preset.billing_points,
      customValues,
      onHoldReason: holdReason,
      cancellationReason,
      progressOverride,
      stages,
      currentStageId,
      crew,
      tasks,
      reports,
      issues,
      comments,
      activity,
    });
  }

  // Organisation-wide issues (a broken tool, a site-wide notice).
  const orgIssues: IssueM[] = [];
  const orgComments: CommentM[] = [];
  const orgActivity: ActivityM[] = [];
  const orgAgos = spreadDates(rng, company, ORG_ISSUES);
  const raisers: PersonaKey[] = ["field", "warehouse", "hr", "manager"];
  for (let q = 0; q < ORG_ISSUES; q++) {
    const il = lang();
    const ago = orgAgos[q]!;
    const resolved = rng.chance(Math.min(0.9, 0.2 + ago / 120));
    const issue: IssueM = {
      id: id("issue", "org", q),
      jobId: null,
      jobIndex: null,
      title: bi(rng, ISSUE_TITLES, il),
      description: rng.chance(0.7) ? paragraph(rng, il, 2) : null,
      severity: weighted(rng, { low: 30, medium: 40, high: 22, critical: 8 }),
      isBlocker: rng.chance(0.15),
      status: resolved
        ? rng.chance(0.6)
          ? "resolved"
          : "closed"
        : rng.chance(0.6)
          ? "open"
          : "in_progress",
      raisedBy: users[pick(rng, raisers)],
      assignee: rng.chance(0.5) ? { raw: rng.int(0, 1_000_000) } : null,
      resolvedBy: resolved ? users.manager : null,
      resolvedAt: resolved ? clock.tsAgo(Math.max(0, ago - rng.int(1, 15)), hour()) : null,
      createdAt: clock.tsAgo(ago, hour(), rng.int(0, 59)),
    };
    orgIssues.push(issue);
    orgActivity.push({
      id: id("activity", "issue", issue.id),
      actor: issue.raisedBy,
      entityType: "issue",
      entityId: issue.id,
      verb: "raised",
      summary: `raised an issue: ${issue.title}`.slice(0, 400),
      createdAt: issue.createdAt,
    });
    if (rng.chance(0.5)) {
      const c: CommentM = {
        id: id("comment", "issue", issue.id),
        entityType: "issue",
        entityId: issue.id,
        author: users.manager,
        body: sentence(rng, lang()),
        createdAt: clock.tsAgo(Math.max(0, ago - 1), hour()),
      };
      orgComments.push(c);
      orgActivity.push({
        id: id("activity", "comment", c.id),
        actor: c.author,
        entityType: "issue",
        entityId: c.entityId,
        verb: "commented",
        summary: c.body.slice(0, 140),
        createdAt: c.createdAt,
      });
    }
  }

  // Weekly plans for the last WEEK_PLAN_WEEKS weeks.
  const weekPlans: WeekPlanM[] = [];
  const thisMonday = weekStartOf(asOf);
  for (let k = 0; k < WEEK_PLAN_WEEKS; k++) {
    const weekStart = addDays(thisMonday, -7 * k);
    const weekEnd = addDays(weekStart, 6);
    const kind: WeekPlanM["status"] =
      k === 0
        ? "draft"
        : k === 1
          ? "issued"
          : weighted(rng, { issued: 84, cancelled: 6, revised: 10 });
    const covered = jobs
      .filter(
        (j) =>
          j.category !== "draft" &&
          j.startDate <= weekEnd &&
          j.endRef >= weekStart &&
          !(j.category === "active" && j.dueDate < addDays(weekStart, -60)),
      )
      .sort((a, b) =>
        a.isProject === b.isProject ? a.dueDate.localeCompare(b.dueDate) : a.isProject ? -1 : 1,
      )
      .slice(0, rng.int(6, 14));
    const createdAt = tsOn(addDays(weekStart, -3), hour());
    const issuedAt = tsOn(addDays(weekStart, -1), 8, rng.int(0, 59));
    const planId = id("week_plan", k);
    const mkJobs = (suffix: string) =>
      covered.map((j, s) => ({
        id: id("week_plan_job", k, suffix, s),
        jobId: j.id,
        sort: s,
        note: rng.chance(0.15) ? sentence(rng, lang()) : null,
      }));
    const title = rng.chance(0.5) ? `Week of ${weekStart}` : null;
    if (kind === "revised") {
      weekPlans.push({
        id: planId,
        reference: weekReference(weekStart, 0),
        weekStart,
        weekEnd,
        title,
        notes: rng.chance(0.5) ? sentence(rng, lang()) : null,
        status: "revised",
        issuedAt,
        cancelledReason: null,
        revisionOfId: null,
        revisionReason: null,
        createdAt,
        jobs: mkJobs("a"),
      });
      const revId = id("week_plan", k, "r1");
      weekPlans.push({
        id: revId,
        reference: weekReference(weekStart, 1),
        weekStart,
        weekEnd,
        title,
        notes: rng.chance(0.5) ? sentence(rng, lang()) : null,
        status: "issued",
        issuedAt: tsOn(addDays(weekStart, 1), 9),
        cancelledReason: null,
        revisionOfId: planId,
        revisionReason: pick(rng, REVISION_REASONS),
        createdAt: tsOn(addDays(weekStart, 1), 8),
        jobs: mkJobs("b"),
      });
    } else {
      weekPlans.push({
        id: planId,
        reference: weekReference(weekStart, 0),
        weekStart,
        weekEnd,
        title,
        notes: rng.chance(0.5) ? sentence(rng, lang()) : null,
        status: kind,
        issuedAt: kind === "draft" ? null : issuedAt,
        cancelledReason: kind === "cancelled" ? pick(rng, PLAN_CANCEL_REASONS) : null,
        revisionOfId: null,
        revisionReason: null,
        createdAt,
        jobs: mkJobs("a"),
      });
    }
  }

  /*
   * Every company must have work genuinely waiting on somebody.
   *
   * A lab whose Approvals screen is empty teaches nothing, and the natural
   * odds do not guarantee one: an approval-gated step is a 5% chance on a
   * project task, and reaching `awaiting_approval` needs another 45% roll on
   * top. Four of the five companies came out with an empty queue. This promotes
   * the earliest eligible in-progress steps until the queue is populated —
   * deterministic (it walks jobs and steps in index order, consuming no
   * randomness), and it preserves the mirroring law the approval rows rely on:
   * a task in `awaiting_approval` has exactly one pending approval, keyed by
   * the same (job, step) ordinal, so subject ids stay unique.
   */
  /*
   * Rare states must be present at ANY scale.
   *
   * Every category and every status below is reachable by chance, and on a
   * smaller company some of them simply did not come up — gulfbuild lost a job
   * category and tradeline lost two task statuses when the profiles were scaled
   * to fit the row budget. A lab missing "cancelled" or "blocked" is a lab that
   * cannot be used to look at cancelled or blocked work, so the states are
   * guaranteed rather than hoped for: walk jobs in index order and convert the
   * first eligible one, consuming no randomness.
   */
  const seenCategories = new Set(jobs.map((j) => j.category));
  for (const want of JOB_CATEGORIES) {
    if (seenCategories.has(want)) continue;
    /*
     * Prefer a job whose content already suits the category, so the conversion
     * changes a label and nothing else. Only when none exists does the job's
     * own history have to be brought into line below.
     */
    const suits = (j: JobM): boolean => {
      if (want === "draft")
        return (
          j.reports.length === 0 &&
          j.stages.every((x) => x.status === "not_started") &&
          j.tasks.every((t) => t.status === "pending")
        );
      if (want === "done")
        return j.tasks.every((t) => t.status === "completed" || t.status === "cancelled");
      return true;
    };
    const pool = jobs.filter((j) => j.category === "active" && !j.archived);
    const victim = pool.find(suits) ?? pool[0];
    if (!victim) break;
    victim.category = want;
    victim.statusKey =
      want === "draft"
        ? tpl.statusKeys.draft
        : want === "on_hold"
          ? tpl.statusKeys.onHold
          : want === "done"
            ? tpl.statusKeys.done[0]!
            : want === "cancelled"
              ? tpl.statusKeys.cancelled
              : tpl.statusKeys.active[0]!;
    /*
     * A category never travels alone: the product demands a reason for on-hold
     * and cancelled work, and a completion date for finished work. Setting a
     * category without its companion is exactly the incoherent data this lab
     * exists to avoid.
     */
    victim.onHoldReason = want === "on_hold" ? "Awaiting the client's material decision" : null;
    victim.cancellationReason = want === "cancelled" ? "Cancelled at the client's request" : null;
    victim.completedDate =
      want === "done" ? minDate(maxDate(victim.createdDate, victim.startDate), asOf) : null;
    /*
     * And neither does a category travel alone from its OWN history. A job
     * relabelled `draft` that still carries completed stages, finished tasks
     * and a fortnight of daily reports is not draft work — it is a
     * contradiction, and the first thing a pilot would notice. Whatever the
     * new category asserts, the job's content is made to say the same thing.
     */
    if (want === "draft") {
      for (const st of victim.stages) {
        st.status = "not_started";
        st.startedAt = null;
        st.completedAt = null;
        st.completionRequestedBy = null;
        st.completionRequestedAt = null;
      }
      // Draft work has a next stage, it simply has not started it.
      victim.currentStageId = currentStageOf(victim.stages)?.id ?? null;
      for (const t of victim.tasks) {
        t.status = "pending";
        t.completedAt = null;
        t.actualMinutes = null;
        t.blockedReason = null;
        t.requiresApproval = false;
        t.approval = null;
      }
      // Nothing has been reported on work that has not begun.
      victim.reports = [];
      victim.progressOverride = null;
    }
    if (want === "done") {
      for (const st of victim.stages) {
        if (st.status === "skipped") continue;
        st.status = "completed";
        st.startedAt = st.startedAt ?? tsOn(victim.startDate, 8);
        st.completedAt = st.completedAt ?? tsOn(victim.completedDate ?? victim.dueDate, 16);
      }
      // Finished work has no stage in front of it.
      victim.currentStageId = currentStageOf(victim.stages)?.id ?? null;
      for (const t of victim.tasks) {
        if (t.status === "cancelled") continue;
        t.status = "completed";
        t.completedAt = t.completedAt ?? tsOn(victim.completedDate ?? victim.dueDate, 15);
        t.actualMinutes = t.actualMinutes ?? t.estimatedMinutes;
        t.blockedReason = null;
        t.requiresApproval = false;
        t.approval = null;
      }
    }
    seenCategories.add(want);
  }

  const MIN_AWAITING = 6;
  const awaitingNow = () =>
    jobs.reduce((n, j) => n + j.tasks.filter((t) => t.status === "awaiting_approval").length, 0);
  if (awaitingNow() < MIN_AWAITING) {
    /*
     * Prefer a step that is genuinely mid-flight; a smaller company can have
     * none at all, in which case a step that is merely ready is promoted
     * instead. Either way the walk is over jobs and steps in index order and
     * consumes no randomness.
     */
    const eligible = (t: TaskM, statuses: string[]) =>
      statuses.includes(t.status) && t.deps.length === 0 && !t.approval;
    const pool = jobs
      .filter((j) => j.category === "active")
      .flatMap((j) => j.tasks.map((t) => ({ j, t })))
      .sort((a, b) => a.j.index - b.j.index || a.t.ord - b.t.ord);
    const tiers = [
      pool.filter(({ t }) => eligible(t, ["in_progress"])),
      pool.filter(({ t }) => eligible(t, ["ready", "pending"])),
      // A finished step waiting on a signature is precisely what this state
      // means, so on a company whose work is mostly closed one of those does.
      pool.filter(({ t }) => eligible(t, [...TASK_STATUSES])),
    ];
    const candidates = tiers.find((x) => x.length > 0) ?? [];
    for (const { j, t } of candidates) {
      if (awaitingNow() >= MIN_AWAITING) break;
      const requestedOn = minDate(addDays(t.startDate ?? j.createdDate, 1), asOf);
      t.requiresApproval = true;
      t.status = "awaiting_approval";
      t.completedAt = null;
      t.actualMinutes = null;
      t.blockedReason = null;
      t.approval = {
        id: id("approval", j.index, t.ord),
        state: "pending",
        requestedBy: j.foremanUser,
        createdAt: tsOn(requestedOn, 9),
        decidedBy: null,
        decidedAt: null,
        note: null,
        expiresHint: new Date(Date.parse(tsOn(requestedOn, 9)) + 3 * DAY).toISOString(),
      };
    }
  }

  /*
   * The same guarantee for task statuses. `pending`, `ready`, `in_progress`
   * and `completed` are common; `blocked`, `cancelled` and
   * `awaiting_approval` are not, and the last of those is handled above.
   */
  const seenStatuses = new Set(jobs.flatMap((j) => j.tasks.map((t) => t.status)));
  for (const want of TASK_STATUSES) {
    if (seenStatuses.has(want)) continue;
    const found = jobs
      .filter((j) => j.category === "active")
      .flatMap((j) => j.tasks)
      .find((t) => t.status === "pending" && t.deps.length === 0 && !t.requiresApproval);
    if (!found) break;
    found.status = want;
    if (want === "blocked") found.blockedReason = "Waiting on the client's written instruction";
    if (want !== "completed") {
      found.completedAt = null;
      found.actualMinutes = null;
    }
    if (want !== "blocked") found.blockedReason = null;
    seenStatuses.add(want);
  }

  /*
   * Decided approvals, guaranteed. The queue above is what is WAITING; a lab
   * also has to show what was settled, and on a smaller company neither an
   * approved nor a rejected decision came up at all. Both are attached to
   * steps that already suit them — an approved decision to a finished step, a
   * rejected one to a step that went back into progress — and the decider is
   * never the requester, which is the segregation the product enforces.
   */
  const approvalStates = new Set(
    jobs.flatMap((j) => j.tasks.map((t) => t.approval?.state).filter(Boolean)),
  );
  const decide = (want: "approved" | "rejected", wantTask: (t: TaskM) => boolean) => {
    if (approvalStates.has(want)) return;
    for (const j of jobs) {
      if (j.category === "draft" || j.archived) continue;
      const t = j.tasks.find((x) => !x.approval && wantTask(x));
      if (!t) continue;
      const at = minDate(t.completedAt?.slice(0, 10) ?? j.startDate, asOf);
      t.requiresApproval = true;
      t.approval = {
        id: id("approval", j.index, t.ord),
        state: want,
        requestedBy: j.foremanUser,
        createdAt: tsOn(at, 9),
        decidedBy: j.managerUser,
        decidedAt: tsOn(at, 14),
        note: want === "rejected" ? "Returned: the measurements do not match the drawing" : null,
        expiresHint: tsOn(at, 17),
      };
      approvalStates.add(want);
      return;
    }
  };
  decide("approved", (t) => t.status === "completed");
  decide("rejected", (t) => t.status === "in_progress" || t.status === "ready");

  /*
   * Every weekly-plan status, at any scale. `cancelled` is a 1-in-many draw
   * over sixty weeks and a smaller company can miss it; a plan board that
   * cannot show a cancelled week is a plan board with a hole in it. A revision
   * needs a partner, so filling `revised` mints the revision too.
   */
  /*
   * Every daily-report status, at any scale. A report is drafted, submitted,
   * then reviewed or returned; on a smaller company the drafts all happened to
   * be submitted, and a site diary that cannot show an unsent draft is missing
   * the state a foreman sees most often. Walk in index order and demote the
   * newest submitted report on open work.
   */
  const reportStatuses = new Set(jobs.flatMap((j) => j.reports.map((r) => r.status)));
  for (const want of REPORT_STATUSES) {
    if (reportStatuses.has(want)) continue;
    const candidates = jobs
      .filter((j) => j.category !== "draft" && !j.archived)
      .flatMap((j) => j.reports.map((r) => ({ j, r })))
      .sort((a, b) => (a.r.reportDate < b.r.reportDate ? 1 : -1));
    const found = candidates.find(({ r }) => r.status === "submitted") ?? candidates[0];
    if (!found) break;
    const r = found.r;
    r.status = want;
    r.submittedAt = want === "draft" ? null : tsOn(r.reportDate, 17);
    r.reviewedBy = want === "reviewed" ? found.j.managerUser : null;
    r.reviewedAt = want === "reviewed" ? tsOn(r.reportDate, 18) : null;
    r.returnedBy = want === "returned" ? found.j.managerUser : null;
    r.returnedAt = want === "returned" ? tsOn(r.reportDate, 18) : null;
    r.returnReason = want === "returned" ? "Quantities do not match the site measure" : null;
    /*
     * The lines were flagged as having deducted stock because the report was
     * SUBMITTED; demoting it to draft or returned has to take that with it, or
     * the report shows inventory moved by a report nobody has accepted. Two
     * such lines survived on facilico, the only company with enough reports to
     * reach this top-up. cost_only is derived from `deducted` at insert, so
     * clearing this clears both.
     */
    if (want !== "submitted" && want !== "reviewed") for (const m of r.material) m.deducted = false;
    reportStatuses.add(want);
  }

  const planStatuses = new Set(weekPlans.map((w) => w.status));
  const drafts = () =>
    weekPlans.filter(
      (w) =>
        w.status === "draft" &&
        w.revisionOfId === null &&
        !weekPlans.some((x) => x.revisionOfId === w.id),
    );
  /*
   * Convert a spare draft — never the last one. Spending it would fill the
   * status being looked for and empty `draft` in the same move, which is how
   * the first version of this guarantee traded one missing status for another.
   */
  const spareplan = (want: string) => {
    const d = drafts();
    if (d.length > 1) return d[0];
    // Never the last draft — spending it would fill the status being looked
    // for and empty `draft` in the same move, which is how the first version
    // of this guarantee traded one missing status for another. An issued plan
    // that nobody revised is the next best donor.
    if (want === "issued") return undefined;
    return weekPlans.find(
      (w) =>
        w.status === "issued" &&
        w.revisionOfId === null &&
        !weekPlans.some((x) => x.revisionOfId === w.id),
    );
  };
  for (const want of WEEK_PLAN_STATUSES) {
    if (planStatuses.has(want)) continue;
    const victim = spareplan(want);
    if (!victim) break;
    victim.status = want === "revised" ? "revised" : want;
    victim.issuedAt = want === "draft" ? null : tsOn(victim.weekStart, 9);
    victim.cancelledReason =
      want === "cancelled" ? "Cancelled: the site was closed for the week" : null;
    if (want === "revised") {
      weekPlans.push({
        id: id("week_plan", victim.weekStart, "guaranteed-r1"),
        reference: `${victim.reference}-R1`,
        weekStart: victim.weekStart,
        weekEnd: victim.weekEnd,
        title: victim.title,
        notes: victim.notes,
        status: "issued",
        issuedAt: tsOn(addDays(victim.weekStart, 1), 9),
        cancelledReason: null,
        revisionOfId: victim.id,
        revisionReason: "Reissued after the crew list changed",
        createdAt: tsOn(addDays(victim.weekStart, 1), 8),
        jobs: victim.jobs.map((x, n) => ({
          id: id("week_plan_job", victim.weekStart, "guaranteed-r1", n),
          jobId: x.jobId,
          sort: x.sort,
          note: x.note,
        })),
      });
      planStatuses.add("issued");
    }
    planStatuses.add(want);
  }

  const sequences = [...seqByScope.entries()]
    .map(([scope, next]) => ({ scope, next }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
  const sample = pickSample(jobs, weekPlans, tpl, rng, users);

  const counts: Record<WorkTable, number> = {
    job: jobs.length,
    job_stage: sum(jobs, (j) => j.stages.length),
    job_crew: sum(jobs, (j) => j.crew.length),
    task: sum(jobs, (j) => j.tasks.length),
    task_dependency: sum(jobs, (j) => sum(j.tasks, (t) => t.deps.length)),
    task_allocation: sum(jobs, (j) => sum(j.tasks, (t) => t.allocations.length)),
    daily_report: sum(jobs, (j) => j.reports.length),
    report_work_line: sum(jobs, (j) => sum(j.reports, (r) => r.work.length)),
    report_labour_line: sum(jobs, (j) => sum(j.reports, (r) => r.labour.length)),
    report_material_line: sum(jobs, (j) => sum(j.reports, (r) => r.material.length)),
    issue: sum(jobs, (j) => j.issues.length) + orgIssues.length,
    approval_rule: rules.length,
    approval: sum(jobs, (j) => j.tasks.filter((t) => t.approval).length),
    comment: sum(jobs, (j) => j.comments.length) + orgComments.length,
    activity: sum(jobs, (j) => j.activity.length) + orgActivity.length,
    week_plan: weekPlans.length,
    week_plan_job: sum(weekPlans, (w) => w.jobs.length),
    reference_sequence: sequences.length,
  };
  return {
    users,
    configAt,
    jobs,
    orgIssues,
    orgComments,
    orgActivity,
    rules,
    ruleIdBySubject,
    weekPlans,
    sequences,
    sample,
    counts,
  };
}

function customValuesFor(
  tpl: Tpl,
  rng: Rng,
  priority: string,
  addr: string,
  year: number,
  i: number,
): Record<string, unknown> {
  if (!rng.chance(0.7)) return {};
  const out: Record<string, unknown> = {};
  for (const f of tpl.fields) {
    switch (f.field_key) {
      case "site_location":
      case "service_location":
        out[f.field_key] = addr;
        break;
      case "contract_reference":
        out[f.field_key] = `CT-${year}-${String(100 + (i % 900))}`;
        break;
      case "priority":
        if (f.options?.some((o) => o.key === priority)) out[f.field_key] = priority;
        break;
      case "asset_details":
        out[f.field_key] = pick(rng, ASSET_DETAILS);
        break;
      case "reference_code":
        out[f.field_key] = `RC-${String(1000 + i)}`;
        break;
      case "drawing_reference":
        out[f.field_key] = `DWG-${String(2000 + i)}-R${rng.int(0, 3)}`;
        break;
      case "material_grade":
        out[f.field_key] = pick(rng, MATERIAL_GRADES);
        break;
      default:
        if (f.type === "text") out[f.field_key] = `${f.field_key}-${i}`;
    }
  }
  return out;
}

/** Deterministically pick the rows the seed drives through the real services. */
function pickSample(
  jobs: JobM[],
  weekPlans: WeekPlanM[],
  tpl: Tpl,
  rng: Rng,
  users: Record<PersonaKey, string>,
): ServiceSample {
  const take = <T>(arr: T[], n: number): T[] => arr.slice(0, n);
  const byCat = (c: JobM["category"]) => jobs.filter((j) => j.category === c && !j.archived);
  const drafts = take(byCat("draft"), 4);
  const actives = byCat("active");
  const jobStatus: ServiceSample["jobStatus"] = [];
  for (const j of drafts)
    jobStatus.push({
      jobId: j.id,
      from: "draft",
      to: "active",
      statusKey: tpl.statusKeys.active[0]!,
      reason: null,
      persona: "manager",
    });
  for (const j of take(actives, 2))
    jobStatus.push({
      jobId: j.id,
      from: "active",
      to: "on_hold",
      statusKey: tpl.statusKeys.onHold,
      reason: HOLD_REASONS[0]![0],
      persona: "manager",
    });
  for (const j of actives.slice(2, 4))
    jobStatus.push({
      jobId: j.id,
      from: "active",
      to: "done",
      statusKey: tpl.statusKeys.done[0]!,
      reason: null,
      persona: "manager",
    });
  for (const j of actives.slice(4, 5))
    jobStatus.push({
      jobId: j.id,
      from: "active",
      to: "cancelled",
      statusKey: tpl.statusKeys.cancelled,
      reason: CANCEL_REASONS[0]![0],
      persona: "manager",
    });
  const dones = byCat("done").filter((j) => !jobStatus.some((s) => s.jobId === j.id));
  const archive = take(dones, 1).map((j) => j.id);
  const reopen = dones
    .slice(1, 2)
    .map((j) => ({ jobId: j.id, statusKey: tpl.statusKeys.active[0]! }));
  const stages: ServiceSample["stages"] = [];
  for (const j of actives.slice(5)) {
    if (stages.length >= 4) break;
    if (jobStatus.some((s) => s.jobId === j.id)) continue;
    const cur = j.stages.find((s) => s.status === "in_progress");
    if (!cur) continue;
    const next =
      j.stages.filter((s) => s.status === "not_started").sort((a, b) => a.sort - b.sort)[0] ?? null;
    stages.push({ jobId: j.id, completeStageId: cur.id, startStageId: next?.id ?? null });
  }
  const touched = new Set([
    ...jobStatus.map((s) => s.jobId),
    ...archive,
    ...reopen.map((r) => r.jobId),
    ...stages.map((s) => s.jobId),
  ]);
  const openJobs = jobs.filter(
    (j) =>
      (j.category === "active" || j.category === "on_hold") && !j.archived && !touched.has(j.id),
  );
  const tasks: ServiceSample["tasks"] = [];
  for (const j of openJobs) {
    for (const t of j.tasks) {
      if (tasks.length >= 12) break;
      if (t.requiresApproval || t.deps.length) continue;
      if (t.status === "pending" && tasks.filter((x) => x.to === "in_progress").length < 6)
        tasks.push({
          taskId: t.id,
          from: "pending",
          to: "in_progress",
          reason: null,
          actualMinutes: null,
        });
      else if (t.status === "in_progress" && tasks.filter((x) => x.to === "completed").length < 4)
        tasks.push({
          taskId: t.id,
          from: "in_progress",
          to: "completed",
          reason: null,
          actualMinutes: rng.int(60, 600),
        });
      else if (t.status === "in_progress" && tasks.filter((x) => x.to === "blocked").length < 2)
        tasks.push({
          taskId: t.id,
          from: "in_progress",
          to: "blocked",
          reason: BLOCK_REASONS[0]![0],
          actualMinutes: null,
        });
    }
    if (tasks.length >= 12) break;
  }
  const approvals: ServiceSample["approvals"] = [];
  for (const j of openJobs) {
    for (const t of j.tasks) {
      if (approvals.length >= 5) break;
      if (t.approval?.state === "pending" && t.approval.requestedBy !== users.manager)
        approvals.push({
          approvalId: t.approval.id,
          decision: approvals.length < 3 ? "approved" : "rejected",
          note: approvals.length < 3 ? null : REJECT_NOTES[0]![0],
        });
    }
    if (approvals.length >= 5) break;
  }
  const reports: ServiceSample["reports"] = [];
  for (const j of jobs) {
    if (touched.has(j.id)) continue;
    for (const r of j.reports) {
      if (reports.length >= 8) break;
      if (r.status === "submitted")
        reports.push({
          reportId: r.id,
          to: reports.length < 6 ? "reviewed" : "returned",
          reason: reports.length < 6 ? null : RETURN_REASONS[0]![0],
        });
    }
    if (reports.length >= 8) break;
  }
  const issues: ServiceSample["issues"] = [];
  for (const j of jobs) {
    for (const q of j.issues) {
      if (issues.length >= 8) break;
      if (q.status === "open")
        issues.push({
          issueId: q.id,
          to: issues.length < 4 ? "resolved" : issues.length < 6 ? "in_progress" : null,
          assignRaw: issues.length >= 6 ? rng.int(0, 1_000_000) : null,
        });
    }
    if (issues.length >= 8) break;
  }
  const draftPlan = weekPlans.find((w) => w.status === "draft");
  const cancelPlan = weekPlans.filter((w) => w.status === "issued" && !w.revisionOfId)[5] ?? null;
  return {
    jobStatus,
    archive,
    reopen,
    stages,
    tasks,
    approvals,
    reports,
    issues,
    weekPlans: {
      issue: draftPlan?.id ?? null,
      cancel: cancelPlan ? { id: cancelPlan.id, reason: "Replanned after a site shutdown" } : null,
    },
  };
}

// ── External references and row production ─────────────────────────────────

export type ItemRef = { id: string; name: string; unit: string; unit_cost_minor: number | null };

export type WorkRefs = {
  orgId: string;
  presets: Array<{ id: string; code: string }>;
  customers: string[];
  employees: string[];
  personaEmployees: Partial<Record<PersonaKey, string>>;
  items: ItemRef[];
  issuer: IssuerIdentity;
};

type Row = Record<string, unknown>;
export type WorkRows = Record<WorkTable, Row[]>;

/** A distinct set of employee ids for one job's crew, honouring persona slots. */
function resolveCrew(job: JobM, refs: WorkRefs): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  const n = refs.employees.length;
  for (const c of job.crew) {
    let candidate: string | undefined;
    if ("persona" in c.who) candidate = refs.personaEmployees[c.who.persona];
    if (candidate === undefined) {
      const start = "raw" in c.who ? c.who.raw : "crew" in c.who ? c.who.crew : job.index;
      for (let k = 0; k < n; k++) {
        const e = refs.employees[(start + k) % n]!;
        if (!used.has(e)) {
          candidate = e;
          break;
        }
      }
    }
    if (candidate === undefined || used.has(candidate)) {
      // Persona employee already on the crew (or unknown) — take the next free one.
      for (let k = 0; k < n; k++) {
        const e = refs.employees[(job.index + k) % n]!;
        if (!used.has(e)) {
          candidate = e;
          break;
        }
      }
    }
    if (candidate === undefined) throw new Error("work: not enough employees to form a crew");
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

function resolveWho(who: Who, crewIds: string[], refs: WorkRefs, fallback: number): string {
  if ("crew" in who && crewIds[who.crew] !== undefined) return crewIds[who.crew]!;
  if ("persona" in who) {
    const p = refs.personaEmployees[who.persona];
    if (p) return p;
  }
  const n = refs.employees.length;
  const raw = "raw" in who ? who.raw : "crew" in who ? who.crew : fallback;
  return refs.employees[raw % n]!;
}

/** Turn the model into insertable rows. Never drops or adds a row. */
export function toRows(model: WorkModel, refs: WorkRefs): WorkRows {
  if (refs.employees.length < 8)
    throw new Error("work: the people family must have created at least 8 active employees");
  const org = refs.orgId;
  const presetId = new Map(refs.presets.map((p) => [p.code, p.id]));
  const rows = Object.fromEntries(WORK_TABLES.map((t) => [t, [] as Row[]])) as WorkRows;
  const push = (t: WorkTable, r: Row) => rows[t].push(r);
  const customer = (raw: number | null) =>
    raw === null || refs.customers.length === 0
      ? null
      : refs.customers[raw % refs.customers.length]!;
  const manager = model.users.manager;

  for (const j of model.jobs) {
    const crewIds = resolveCrew(j, refs);
    const who = (w: Who, fb: number) => resolveWho(w, crewIds, refs, fb);
    const pid = presetId.get(j.presetCode);
    if (!pid)
      throw new Error(`work: preset ${j.presetCode} is not installed for this organisation`);
    push("job", {
      id: j.id,
      org_id: org,
      reference: j.reference,
      name: j.name,
      preset_id: pid,
      customer_id: customer(j.customerRaw),
      status_key: j.statusKey,
      status_category: j.category,
      manager_user_id: j.managerUser,
      foreman_user_id: j.foremanUser,
      created_by: j.createdBy,
      archived: j.archived,
      created_at: j.createdAt,
      updated_at: j.updatedAt,
      kind: "project",
      progress_override: j.progressOverride?.percent ?? null,
      progress_override_reason: j.progressOverride?.reason ?? null,
      progress_override_by: j.progressOverride ? j.managerUser : null,
      progress_override_at: j.progressOverride?.at ?? null,
      start_date: j.startDate,
      due_date: j.dueDate,
      completed_date: j.completedDate,
      selling_price_minor: j.sellingPriceMinor,
      price_adjustments: j.priceAdjustments,
      billing_points: j.billingPoints,
      payment_terms: j.paymentTerms,
      custom_values: j.customValues,
      current_stage_id: null, // set after the stage rows exist (circular FK)
      owner_user_id: j.managerUser,
      priority: j.priority,
      location: j.location,
      description: j.description,
      on_hold_reason: j.onHoldReason,
      cancellation_reason: j.cancellationReason,
      origin: j.origin,
      source_opportunity_id: null,
      archived_at: j.archivedAt,
      archived_by: j.archived ? j.managerUser : null,
    });
    for (const s of j.stages) {
      push("job_stage", {
        id: s.id,
        org_id: org,
        job_id: j.id,
        stage_key: s.stageKey,
        name: s.names,
        weight: s.weight,
        sort: s.sort,
        status: s.status,
        started_at: s.startedAt,
        completed_at: s.completedAt,
        completion_requested_by: s.completionRequestedBy,
        completion_requested_at: s.completionRequestedAt,
        notes: null,
        phase_semantic: s.phase,
        created_at: j.createdAt,
        updated_at: s.completedAt ?? s.startedAt ?? j.createdAt,
      });
    }
    j.crew.forEach((c, k) => {
      push("job_crew", {
        org_id: org,
        job_id: j.id,
        employee_id: crewIds[k]!,
        added_by: j.managerUser,
        added_at: c.addedAt,
        removed_at: c.removedAt,
        removed_by: c.removedBy,
      });
    });
    for (const t of j.tasks) {
      push("task", {
        id: t.id,
        org_id: org,
        job_id: j.id,
        stage_id: t.stageId,
        title: t.title,
        status: t.status,
        assignee_employee_id: t.assignee ? who(t.assignee, t.ord) : null,
        due_date: t.dueDate,
        created_by: t.createdBy,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
        description: t.description,
        priority: t.priority,
        start_date: t.startDate,
        completed_at: t.completedAt,
        estimated_minutes: t.estimatedMinutes,
        actual_minutes: t.actualMinutes,
        parent_task_id: null,
        blocked_reason: t.blockedReason,
        requires_approval: t.requiresApproval,
        updated_by: t.completedAt ? j.foremanUser : null,
        archived: false,
        duration_days: t.durationDays,
        is_milestone: t.isMilestone,
        constraint_kind: "none",
        constraint_date: null,
        deadline_date: null,
        estimate_optimistic_days: null,
        estimate_pessimistic_days: null,
      });
      for (const d of t.deps) {
        push("task_dependency", {
          id: d.id,
          org_id: org,
          task_id: t.id,
          depends_on_task_id: d.dependsOnTaskId,
          kind: "finish_to_start",
          created_by: j.managerUser,
          created_at: d.createdAt,
          removed_at: null,
          removed_by: null,
          lag_days: d.lagDays,
        });
      }
      for (const a of t.allocations) {
        push("task_allocation", {
          id: a.id,
          org_id: org,
          task_id: t.id,
          employee_id: who(a.who, t.ord),
          share_pct: a.sharePct,
          note: a.note,
          created_by: j.managerUser,
          created_at: a.createdAt,
          updated_at: a.createdAt,
          removed_at: null,
        });
      }
      if (t.approval) {
        const a = t.approval;
        push("approval", {
          id: a.id,
          org_id: org,
          subject_type: "task_completion",
          subject_id: t.id,
          subject_summary: { title: t.title, jobRef: j.reference },
          rule_id: model.ruleIdBySubject.task_completion ?? null,
          requested_by: a.requestedBy,
          assigned_role: "manager",
          assigned_user_id: null,
          state: a.state,
          decided_by: a.decidedBy,
          decided_at: a.decidedAt,
          decision_note: a.note,
          self_approved: false,
          expires_hint: a.expiresHint,
          created_at: a.createdAt,
          updated_at: maxDate(a.decidedAt ?? a.createdAt, a.createdAt),
        });
      }
    }
    for (const r of j.reports) {
      push("daily_report", {
        id: r.id,
        org_id: org,
        job_id: j.id,
        report_date: r.reportDate,
        summary: r.summary,
        blockers: r.blockers,
        next_steps: r.nextSteps,
        status: r.status,
        submitted_by: r.submittedBy,
        submitted_at: r.submittedAt,
        created_at: r.createdAt,
        updated_at: r.reviewedAt ?? r.returnedAt ?? r.submittedAt ?? r.createdAt,
        reviewed_by: r.reviewedBy,
        reviewed_at: r.reviewedAt,
        returned_by: r.returnedBy,
        returned_at: r.returnedAt,
        return_reason: r.returnReason,
        idempotency_key: r.idem,
        is_backfill: false,
      });
      r.work.forEach((w, s) => {
        push("report_work_line", {
          id: w.id,
          org_id: org,
          report_id: r.id,
          stage_key: w.stageKey,
          stage_id: w.stageId,
          description: w.description,
          progress_note: w.progressNote,
          sort: s,
          created_at: r.createdAt,
          superseded_at: null,
        });
      });
      // Labour lines must name distinct employees per report.
      const seen = new Set<string>();
      r.labour.forEach((l, s) => {
        let emp = who(l.who, s);
        let guard = 0;
        while (seen.has(emp) && guard < refs.employees.length)
          emp =
            refs.employees[(refs.employees.indexOf(emp) + 1 + guard++) % refs.employees.length]!;
        seen.add(emp);
        push("report_labour_line", {
          id: l.id,
          org_id: org,
          report_id: r.id,
          employee_id: emp,
          normal_hours: l.normalHours,
          ot_hours: l.otHours,
          sort: s,
          created_at: r.createdAt,
          superseded_at: null,
        });
      });
      r.material.forEach((m, s) => {
        const item =
          m.itemRaw !== null && refs.items.length > 0
            ? refs.items[m.itemRaw % refs.items.length]!
            : null;
        const linked = item !== null;
        push("report_material_line", {
          id: m.id,
          org_id: org,
          report_id: r.id,
          item_id: item?.id ?? null,
          item_name: (item?.name ?? m.freeName ?? "Consumables").slice(0, 160),
          qty: m.qty,
          unit: (item?.unit ?? m.freeUnit ?? "pcs").slice(0, 16),
          unit_cost_minor: linked ? item.unit_cost_minor : m.manualCostMinor,
          cost_source: linked ? "catalog" : m.itemRaw !== null ? "none" : m.costSource,
          cost_only: !(linked && m.deducted),
          deducted_from_inventory: linked && m.deducted,
          sort: s,
          created_at: r.createdAt,
          superseded_at: null,
        });
      });
    }
    for (const q of j.issues)
      push("issue", issueRow(q, org, q.assignee ? who(q.assignee, 0) : null));
    for (const c of j.comments) push("comment", commentRow(c, org));
    for (const a of j.activity) push("activity", activityRow(a, org));
  }
  for (const q of model.orgIssues)
    push("issue", issueRow(q, org, q.assignee ? resolveWho(q.assignee, [], refs, 0) : null));
  for (const c of model.orgComments) push("comment", commentRow(c, org));
  for (const a of model.orgActivity) push("activity", activityRow(a, org));
  for (const r of model.rules) {
    push("approval_rule", {
      id: r.id,
      org_id: org,
      subject_type: r.subjectType,
      condition_kind: r.conditionKind,
      amount_gte_minor: r.amountGteMinor,
      urgency_in: r.urgencyIn,
      assigned_role: r.assignedRole,
      auto_approve_below_minor: r.autoApproveBelowMinor,
      active: true,
      created_at: model.configAt,
      updated_at: model.configAt,
    });
  }
  for (const w of model.weekPlans) {
    push("week_plan", {
      id: w.id,
      org_id: org,
      reference: w.reference,
      week_start: w.weekStart,
      week_end: w.weekEnd,
      title: w.title,
      manager_user_id: manager,
      notes: w.notes,
      status: w.status,
      issued_at: w.issuedAt,
      issued_by: w.issuedAt ? manager : null,
      cancelled_reason: w.cancelledReason,
      revision_of_id: w.revisionOfId,
      revision_reason: w.revisionReason,
      issuer_snapshot: w.issuedAt ? captureIssuerSnapshot(refs.issuer, w.issuedAt) : null,
      created_by: manager,
      created_at: w.createdAt,
      updated_at: w.issuedAt ?? w.createdAt,
    });
    for (const wj of w.jobs)
      push("week_plan_job", {
        id: wj.id,
        org_id: org,
        week_plan_id: w.id,
        job_id: wj.jobId,
        sort: wj.sort,
        note: wj.note,
        removed_at: null,
        created_at: w.createdAt,
      });
  }
  for (const s of model.sequences)
    push("reference_sequence", { org_id: org, scope_key: s.scope, next_value: s.next });
  return rows;
}

function issueRow(q: IssueM, org: string, assignee: string | null): Row {
  return {
    id: q.id,
    org_id: org,
    job_id: q.jobId,
    title: q.title,
    description: q.description,
    severity: q.severity,
    is_blocker: q.isBlocker,
    status: q.status,
    raised_by: q.raisedBy,
    assignee_employee_id: assignee,
    resolved_by: q.resolvedBy,
    resolved_at: q.resolvedAt,
    created_at: q.createdAt,
    updated_at: q.resolvedAt ?? q.createdAt,
  };
}
function commentRow(c: CommentM, org: string): Row {
  return {
    id: c.id,
    org_id: org,
    entity_type: c.entityType,
    entity_id: c.entityId,
    author_user_id: c.author,
    body: c.body,
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    created_at: c.createdAt,
  };
}
function activityRow(a: ActivityM, org: string): Row {
  return {
    id: a.id,
    org_id: org,
    actor_user_id: a.actor,
    entity_type: a.entityType,
    entity_id: a.entityId,
    verb: a.verb,
    summary: a.summary,
    created_at: a.createdAt,
  };
}

/** (job id, stage id) pairs for the post-insert current_stage_id update. */
export function currentStagePairs(model: WorkModel): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const j of model.jobs) if (j.currentStageId) out.push([j.id, j.currentStageId]);
  return out;
}

/** A fictional issuer identity for the company (the snapshot on issued plans). */
export function issuerFor(company: Company): IssuerIdentity {
  const owner = company.personas.find((p) => p.key === "owner");
  const c = company.country === "SA" ? "Riyadh" : "Dubai";
  return {
    tradingName: company.nameEn,
    legalName: company.legalNameEn,
    trn: taxNo(company, 0),
    licenseNo: null,
    addressEn: `Unit 100, Test Tower, Fictional District, ${c}`,
    addressAr: `وحدة 100، برج الاختبار، الحي الافتراضي`,
    city: c,
    region: null,
    postalCode: null,
    country: company.country,
    phone: phone(company, 0),
    email: email(company.key, 0),
    website: null,
    signatoryName: owner?.fullName ?? null,
    signatoryTitle: owner ? "Managing Director" : null,
    paymentInstructions: null,
    footer: null,
    docLanguage: company.languages[0] === "ar" ? "ar" : "bilingual",
    logoFileId: null,
  };
}

// ── Handoff ─────────────────────────────────────────────────────────────────

export type WorkHandoffJob = {
  id: string;
  reference: string;
  customerId: string | null;
  category: string;
  presetCode: string;
  isProject: boolean;
};

export type WorkHandoff = {
  jobIds: string[];
  /** Every job, small: what sales (quote → job) and misc (targets) need without a query. */
  jobs: WorkHandoffJob[];
  /** Open work (draft / active / on hold, not archived), bounded. */
  activeJobIds: string[];
  /** Project-scale open work, bounded — what Studio plans link to. */
  majorJobIds: string[];
  taskIds: string[];
  /** Task ids per major job, so a plan can link its WBS nodes to real steps. */
  taskIdsByJob: Record<string, string[]>;
  reportIds: string[];
  issueIds: string[];
  weekPlanIds: string[];
  /** Reports carrying at least one material line flagged deducted_from_inventory. */
  deductedMaterialReportIds: string[];
  /** [lineId, reportId, jobId, itemId, qty, unit, reportDate] — what the stock family sources movements from. */
  deductedMaterialLines: Array<[string, string, string, string, number, string, string]>;
  approvalRuleIds: Record<string, string>;
  jobPresetIds: Record<string, string>;
  referenceSequences: Record<string, number>;
  /** Open jobs whose foreman is the field / restricted persona (assigned-scope tests). */
  personaJobs: Partial<Record<PersonaKey, string[]>>;
};

export function buildHandoff(model: WorkModel, rows: WorkRows, refs: WorkRefs): WorkHandoff {
  const jobRows = rows.job;
  const jobs: WorkHandoffJob[] = [];
  const activeJobIds: string[] = [];
  const majorJobIds: string[] = [];
  const taskIdsByJob: Record<string, string[]> = {};
  const personaJobs: WorkHandoff["personaJobs"] = { field: [], restricted: [] };
  for (let k = 0; k < model.jobs.length; k++) {
    const m = model.jobs[k]!;
    const r = jobRows[k]!;
    jobs.push({
      id: m.id,
      reference: m.reference,
      customerId: (r.customer_id as string | null) ?? null,
      category: m.category,
      presetCode: m.presetCode,
      isProject: m.isProject,
    });
    const open = !m.archived && m.category !== "done" && m.category !== "cancelled";
    if (!open) continue;
    if (activeJobIds.length < HANDOFF_ACTIVE_JOBS) activeJobIds.push(m.id);
    if (m.isProject && majorJobIds.length < HANDOFF_MAJOR_JOBS) {
      majorJobIds.push(m.id);
      taskIdsByJob[m.id] = m.tasks.map((t) => t.id);
    }
    const list = personaJobs[m.foremanPersona]!;
    if (list.length < HANDOFF_PERSONA_JOBS) list.push(m.id);
  }
  const reportsById = new Map<string, { jobId: string; date: string }>();
  for (const j of model.jobs)
    for (const r of j.reports) reportsById.set(r.id, { jobId: j.id, date: r.reportDate });
  const deductedMaterialLines: WorkHandoff["deductedMaterialLines"] = [];
  const reportSet = new Set<string>();
  for (const l of rows.report_material_line) {
    if (l.deducted_from_inventory !== true || typeof l.item_id !== "string") continue;
    const rep = reportsById.get(l.report_id as string)!;
    deductedMaterialLines.push([
      l.id as string,
      l.report_id as string,
      rep.jobId,
      l.item_id,
      l.qty as number,
      l.unit as string,
      rep.date,
    ]);
    reportSet.add(l.report_id as string);
  }
  return {
    jobIds: model.jobs.map((j) => j.id),
    jobs,
    activeJobIds,
    majorJobIds,
    taskIds: model.jobs.flatMap((j) => j.tasks.map((t) => t.id)),
    taskIdsByJob,
    reportIds: model.jobs.flatMap((j) => j.reports.map((r) => r.id)),
    issueIds: [
      ...model.jobs.flatMap((j) => j.issues.map((q) => q.id)),
      ...model.orgIssues.map((q) => q.id),
    ],
    weekPlanIds: model.weekPlans.map((w) => w.id),
    deductedMaterialReportIds: [...reportSet],
    deductedMaterialLines,
    approvalRuleIds: model.ruleIdBySubject,
    jobPresetIds: Object.fromEntries(refs.presets.map((p) => [p.code, p.id])),
    referenceSequences: Object.fromEntries(model.sequences.map((s) => [s.scope, s.next])),
    personaJobs,
  };
}

// ── Loading references at seed time ─────────────────────────────────────────

function safeHandoff(ctx: LabContext, family: string): Record<string, unknown> {
  try {
    return ctx.handoff(family) ?? {};
  } catch {
    return {};
  }
}
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/**
 * Pools from the families this one depends on. Handoff keys are read when
 * present; otherwise the bounded-by-design tables are read directly. The only
 * query on the handoff path is one bounded read of catalogue item names (the
 * masters handoff carries units and costs but not names, and a material line
 * snapshots the catalogue name exactly as the product's own submit does).
 */
export async function loadRefs(ctx: LabContext): Promise<WorkRefs> {
  const setup = safeHandoff(ctx, "setup");
  const people = safeHandoff(ctx, "people");
  const masters = safeHandoff(ctx, "masters");

  let presets = Array.isArray(setup.presets)
    ? (setup.presets as Array<{ id: string; code: string }>)
    : null;
  if (!presets && isObj(setup.presetIds))
    presets = Object.entries(setup.presetIds as Record<string, string>).map(([code, id]) => ({
      id,
      code,
    }));
  if (!presets) {
    presets = (await ctx.sql`
      select id::text as id, code from public.job_preset
      where org_id = ${ctx.orgId} and retired_at is null order by code
    `) as unknown as Array<{ id: string; code: string }>;
  }

  if (ctx.dryRun && presets.length === 0) {
    /*
     * A dry run happens before the organisation exists, so there is nothing
     * installed to find. Stand in deterministic ids for the template's own
     * preset codes purely so the estimate can be produced. Gated on dryRun on
     * purpose: a LIVE seed that found no presets must still fail loudly,
     * because jobs pointing at ids that were never installed would break on
     * the foreign key halfway through the company.
     */
    const tpl = TEMPLATES[ctx.company.templateKey];
    presets = (tpl?.presets ?? []).map((x) => ({
      id: ctx.id("job_preset", x.code),
      code: x.code,
    }));
  }
  let employees = strings(people.activeEmployeeIds) ?? strings(people.employeeIds);
  if (!employees && Array.isArray(people.employees))
    employees = (people.employees as Array<{ id: string }>).map((e) => e.id);
  if (!employees) {
    employees = (
      (await ctx.sql`
        select id::text as id from public.employee
        where org_id = ${ctx.orgId} and active = true order by name, id
      `) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
  }
  const personaEmployees: Partial<Record<PersonaKey, string>> = {
    ...(ctx.employees ?? {}),
    ...((people.personaEmployees as Partial<Record<PersonaKey, string>> | undefined) ?? {}),
  };

  let customers = strings(masters.customerIds);
  if (!customers) {
    customers = (
      (await ctx.sql`
        select id::text as id from public.customer
        where org_id = ${ctx.orgId} and active = true order by created_at, id
      `) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
  }

  let items: ItemRef[] | null = null;
  if (isObj(masters.items) && !Array.isArray(masters.items)) {
    // masters: itemIds (in creation order) + items: Record<id, { unit, cost, … }>.
    const attrs = masters.items as Record<string, { unit?: unknown; cost?: unknown }>;
    const inactive = new Set(strings(masters.inactiveItemIds) ?? []);
    const ids = (strings(masters.itemIds) ?? Object.keys(attrs)).filter(
      (id) => id in attrs && !inactive.has(id),
    );
    const names = new Map<string, string>();
    if (ids.length && !ctx.dryRun) {
      const rows = (await ctx.sql.unsafe(
        `select id::text as id, name from public.item where org_id = $1 and id = any($2::uuid[])`,
        [ctx.orgId, ids],
      )) as unknown as Array<{ id: string; name: string }>;
      for (const r of rows) names.set(r.id, r.name);
    }
    items = ids.map((id, i) => {
      const a = attrs[id]!;
      return {
        id,
        name: names.get(id) ?? `Catalogue item ${i + 1}`,
        unit: typeof a.unit === "string" ? a.unit : "pcs",
        unit_cost_minor: typeof a.cost === "number" ? a.cost : null,
      };
    });
  } else if (Array.isArray(masters.items)) {
    const list = masters.items as ItemRef[];
    if (list.every((i) => i && typeof i.id === "string" && typeof i.name === "string"))
      items = list.map((i) => ({
        id: i.id,
        name: i.name,
        unit: typeof i.unit === "string" ? i.unit : "pcs",
        unit_cost_minor: typeof i.unit_cost_minor === "number" ? i.unit_cost_minor : null,
      }));
  }
  if (!items) {
    items = (
      (await ctx.sql`
        select id::text as id, name, unit, unit_cost_minor::text as unit_cost_minor from public.item
        where org_id = ${ctx.orgId} and active = true order by sku, id
      `) as unknown as Array<{
        id: string;
        name: string;
        unit: string;
        unit_cost_minor: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      unit_cost_minor: r.unit_cost_minor === null ? null : Number(r.unit_cost_minor),
    }));
  }

  return {
    orgId: ctx.orgId,
    presets,
    customers,
    employees,
    personaEmployees,
    items,
    issuer: issuerFor(ctx.company),
  };
}

// ── Database-side effects the product's own writes would have produced ──────

/**
 * job.current_stage_id → job_stage → job is circular, so the job rows are
 * written with a null current stage and closed here, exactly the value the
 * product's recomputeCurrentStageIn derives.
 */
async function closeCurrentStages(ctx: LabContext, model: WorkModel): Promise<number> {
  const pairs = currentStagePairs(model);
  for (let i = 0; i < pairs.length; i += 2000) {
    const chunk = pairs.slice(i, i + 2000);
    await ctx.sql.unsafe(
      `update public.job j set current_stage_id = p.stage_id
       from unnest($1::uuid[], $2::uuid[]) as p(job_id, stage_id)
       where j.id = p.job_id and j.org_id = $3 and j.current_stage_id is distinct from p.stage_id`,
      [chunk.map((p) => p[0]), chunk.map((p) => p[1]), ctx.orgId],
    );
  }
  return pairs.length;
}

/**
 * A submit freezes the labour-cost snapshot through the SECURITY DEFINER
 * `app.freeze_report_labour_costs` (the D-6.2 cost wall). Bulk-inserted
 * submitted / reviewed / returned reports get the same snapshot by calling the
 * same function, inside one transaction that carries the org GUC the function
 * checks. Attendance derivation is left to the attendance family (its rows
 * are keyed per employee-day and it plans them itself).
 */
async function freezeLabourCosts(ctx: LabContext): Promise<number> {
  const org = ctx.orgId;
  const manager = ctx.users.manager;
  return ctx.sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('app.org_id', $1, true)`, [org]);
    await tx.unsafe(`select set_config('app.user_id', $1, true)`, [manager]);
    const rows = await tx.unsafe(
      `select app.freeze_report_labour_costs(r.id)
       from public.daily_report r
       where r.org_id = $1 and r.status <> 'draft'
       order by r.report_date, r.id`,
      [org],
    );
    return rows.length;
  });
}

// ── Service-driven transitions (a representative subset) ────────────────────

async function driveServices(ctx: LabContext, model: WorkModel, refs: WorkRefs): Promise<string[]> {
  const notes: string[] = [];
  const failures: string[] = [];
  let done = 0;
  const s = model.sample;
  const byId = new Map(model.jobs.map((j) => [j.id, j]));
  const manager = ctx.ctxFor("manager");
  const owner = ctx.ctxFor("owner");
  const mArch = ctx.archetypeOf("manager");
  const oArch = ctx.archetypeOf("owner");
  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      done++;
      return true;
    } catch (e) {
      failures.push(`${label}: ${(e as Error).message}`);
      return false;
    }
  };
  const one = async <T>(q: Promise<unknown>): Promise<T | null> => ((await q) as T[])[0] ?? null;

  const jobsSvc = await import("@/modules/jobs/service");
  const approvals = await import("@/modules/approvals/service");
  const reports = await import("@/modules/reports/service");
  const issues = await import("@/modules/issues/service");
  const weekPlan = await import("@/modules/documents/week-plan");

  for (const t of s.jobStatus) {
    const cur = await one<{ status_category: string }>(
      ctx.sql`select status_category from public.job where id = ${t.jobId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status_category !== t.from) continue;
    const ok = await attempt(`job ${t.from}->${t.to}`, () =>
      jobsSvc.changeWorkStatus(manager, mArch, t.jobId, {
        statusKey: t.statusKey,
        reason: t.reason ?? undefined,
      }),
    );
    if (ok) byId.get(t.jobId)!.category = t.to as JobM["category"];
  }
  for (const jobId of s.archive) {
    const cur = await one<{ archived: boolean }>(
      ctx.sql`select archived from public.job where id = ${jobId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.archived) continue;
    const ok = await attempt("job archive", () =>
      jobsSvc.setJobArchived(owner, oArch, jobId, true),
    );
    if (ok) byId.get(jobId)!.archived = true;
  }
  for (const r of s.reopen) {
    const cur = await one<{ status_category: string }>(
      ctx.sql`select status_category from public.job where id = ${r.jobId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status_category !== "done") continue;
    const ok = await attempt("job reopen", () =>
      jobsSvc.reopenJob(owner, oArch, r.jobId, {
        reason: "Client reported a defect under warranty",
        statusKey: r.statusKey,
      }),
    );
    if (ok) byId.get(r.jobId)!.category = "active";
  }
  for (const st of s.stages) {
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.job_stage where id = ${st.completeStageId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status !== "in_progress") continue;
    await attempt("stage complete", () =>
      jobsSvc.completeStage(manager, mArch, st.completeStageId),
    );
    if (st.startStageId) {
      const nxt = await one<{ status: string }>(
        ctx.sql`select status from public.job_stage where id = ${st.startStageId} and org_id = ${ctx.orgId}`,
      );
      if (nxt && nxt.status === "not_started")
        await attempt("stage start", () => jobsSvc.startStage(manager, mArch, st.startStageId!));
    }
  }
  for (const t of s.tasks) {
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.task where id = ${t.taskId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status !== t.from) continue;
    await attempt(`task ${t.from}->${t.to}`, () =>
      jobsSvc.updateTaskStatus(manager, mArch, t.taskId, {
        status: t.to,
        reason: t.reason ?? undefined,
        actualMinutes: t.actualMinutes ?? undefined,
      }),
    );
  }
  for (const a of s.approvals) {
    const cur = await one<{ state: string }>(
      ctx.sql`select state from public.approval where id = ${a.approvalId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.state !== "pending") continue;
    await attempt(`approval ${a.decision}`, () =>
      approvals.decideApproval(manager, mArch, {
        approvalId: a.approvalId,
        decision: a.decision,
        note: a.note ?? undefined,
      }),
    );
  }
  for (const r of s.reports) {
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.daily_report where id = ${r.reportId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status !== "submitted") continue;
    await attempt(`report ${r.to}`, () =>
      r.to === "reviewed"
        ? reports.reviewReport(manager, mArch, r.reportId)
        : reports.returnReport(manager, mArch, r.reportId, r.reason ?? "Please correct"),
    );
  }
  for (const q of s.issues) {
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.issue where id = ${q.issueId} and org_id = ${ctx.orgId}`,
    );
    if (!cur || cur.status !== "open") continue;
    if (q.to)
      await attempt(`issue ${q.to}`, () =>
        issues.updateIssueStatus(manager, mArch, { issueId: q.issueId, status: q.to }),
      );
    if (q.assignRaw !== null && refs.employees.length) {
      const emp = refs.employees[q.assignRaw % refs.employees.length]!;
      await attempt("issue assign", () =>
        issues.assignIssue(manager, mArch, { issueId: q.issueId, assigneeEmployeeId: emp }),
      );
    }
  }
  if (s.weekPlans.issue) {
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.week_plan where id = ${s.weekPlans.issue} and org_id = ${ctx.orgId}`,
    );
    if (cur && cur.status === "draft")
      await attempt("week plan issue", () =>
        weekPlan.issueWeekPlan(manager, mArch, s.weekPlans.issue!),
      );
  }
  if (s.weekPlans.cancel) {
    const c = s.weekPlans.cancel;
    const cur = await one<{ status: string }>(
      ctx.sql`select status from public.week_plan where id = ${c.id} and org_id = ${ctx.orgId}`,
    );
    if (cur && cur.status === "issued")
      await attempt("week plan cancel", () =>
        weekPlan.cancelWeekPlan(manager, mArch, c.id, c.reason),
      );
  }

  notes.push(`${done} service-driven transitions`);
  if (failures.length)
    notes.push(`${failures.length} service calls failed: ${failures.slice(0, 3).join(" | ")}`);
  return notes;
}

// ── The family ──────────────────────────────────────────────────────────────

export type WorkOptions = {
  /**
   * Drive the representative subset through the real domain services and call
   * the labour-cost freeze function after the bulk insert. On by default; the
   * unit test turns it off so `seed()` needs no database. Dry runs never drive
   * services regardless.
   */
  driveServices?: boolean;
};

export function workFamily(options: WorkOptions = {}): Family {
  const drive = options.driveServices ?? true;
  return {
    key: FAMILY,
    deps: ["setup", "people", "masters"],
    appliesTo: () => true,

    plan(ctx): FamilyPlan {
      const model = buildModel(ctx);
      return { family: FAMILY, expected: { ...model.counts } };
    },

    async seed(ctx): Promise<FamilyReport> {
      const model = buildModel(ctx);
      const refs = await loadRefs(ctx);
      const rows = toRows(model, refs);

      for (const table of WORK_TABLES) {
        const list = rows[table];
        if (table === "reference_sequence") {
          await ctx.insert(
            table,
            list,
            "on conflict (org_id, scope_key) do update set next_value = greatest(reference_sequence.next_value, excluded.next_value)",
          );
        } else if (table === "week_plan") {
          // Revisions name their original, so originals go first.
          await ctx.insert(
            table,
            list.filter((r) => r.revision_of_id === null),
          );
          await ctx.insert(
            table,
            list.filter((r) => r.revision_of_id !== null),
          );
        } else {
          await ctx.insert(table, list);
        }
        if (table === "job_stage" && !ctx.dryRun) await closeCurrentStages(ctx, model);
        ctx.log(`${table}: ${list.length} rows`);
      }

      const notes: string[] = [];
      if (ctx.dryRun) notes.push("dry run: services and the labour-cost freeze skipped");
      else if (!drive) notes.push("services and the labour-cost freeze switched off");
      else {
        notes.push(...(await driveServices(ctx, model, refs)));
        const frozen = await freezeLabourCosts(ctx);
        notes.push(`${frozen} submitted reports frozen through app.freeze_report_labour_costs`);
      }
      const handoff = buildHandoff(model, rows, refs);
      return { family: FAMILY, counts: { ...model.counts }, handoff, notes };
    },

    async verify(ctx): Promise<Check[]> {
      const model = buildModel(ctx);
      const org = ctx.orgId;
      const checks: Check[] = [];
      const count = async (q: Promise<unknown>) =>
        Number(((await q) as Array<{ n: number | string }>)[0]?.n ?? 0);
      const countOf = (table: string) =>
        count(
          ctx.sql.unsafe(`select count(*)::int as n from public.${table} where org_id = $1`, [org]),
        );

      for (const table of WORK_TABLES) {
        const n = await countOf(table);
        const planned = model.counts[table];
        const exact = EXCLUSIVE_TABLES.has(table);
        checks.push({
          name: exact ? `${table} count matches plan` : `${table} count is at least the plan`,
          ok: exact ? n === planned : n >= planned,
          detail: `${n} vs ${planned}`,
        });
      }

      const zero = async (name: string, sql: string) => {
        const n = await count(ctx.sql.unsafe(sql, [org]));
        checks.push({ name, ok: n === 0, detail: n === 0 ? undefined : `${n} offending rows` });
      };
      await zero(
        "held jobs carry a reason",
        `select count(*)::int as n from public.job where org_id = $1 and status_category = 'on_hold' and on_hold_reason is null`,
      );
      await zero(
        "cancelled jobs carry a reason",
        `select count(*)::int as n from public.job where org_id = $1 and status_category = 'cancelled' and cancellation_reason is null`,
      );
      await zero(
        "done jobs carry a completion date",
        `select count(*)::int as n from public.job where org_id = $1 and status_category = 'done' and completed_date is null`,
      );
      await zero(
        "only terminal work is archived",
        `select count(*)::int as n from public.job where org_id = $1 and archived and status_category not in ('done', 'cancelled')`,
      );
      await zero(
        "current_stage_id follows the stage rows",
        `select count(*)::int as n from public.job j
         where j.org_id = $1 and j.current_stage_id is distinct from (
           select s.id from public.job_stage s where s.job_id = j.id
           order by (s.status = 'in_progress') desc, (s.status = 'not_started') desc, s.sort
           limit 1
         ) and exists (select 1 from public.job_stage s where s.job_id = j.id and s.status in ('in_progress', 'not_started'))`,
      );
      await zero(
        "stage weights sum to 100 per job",
        `select count(*)::int as n from (select job_id, sum(weight) w from public.job_stage where org_id = $1 group by job_id) x where w <> 100`,
      );
      await zero(
        "the foreman persona is on the crew of every crewed job",
        `select count(*)::int as n from public.job j
         where j.org_id = $1
           and exists (select 1 from public.job_crew c where c.job_id = j.id)
           and not exists (
             select 1 from public.job_crew c join public.employee e on e.id = c.employee_id
             where c.job_id = j.id and e.user_id = j.foreman_user_id
           )`,
      );
      await zero(
        "blocked tasks explain themselves",
        `select count(*)::int as n from public.task where org_id = $1 and status = 'blocked' and blocked_reason is null`,
      );
      await zero(
        "a task awaiting approval has exactly one pending approval",
        `select count(*)::int as n from public.task t where t.org_id = $1 and t.status = 'awaiting_approval'
         and (select count(*) from public.approval a where a.org_id = t.org_id and a.subject_type = 'task_completion' and a.subject_id = t.id and a.state = 'pending') <> 1`,
      );
      await zero(
        "a pending task approval has a task still awaiting it",
        `select count(*)::int as n from public.approval a join public.task t on t.id = a.subject_id
         where a.org_id = $1 and a.subject_type = 'task_completion' and a.state = 'pending' and t.status <> 'awaiting_approval'`,
      );
      await zero(
        "ready/in-progress tasks have no unfinished prerequisites",
        `select count(*)::int as n from public.task_dependency d
         join public.task t on t.id = d.task_id join public.task up on up.id = d.depends_on_task_id
         where d.org_id = $1 and d.removed_at is null and t.status in ('ready', 'in_progress') and up.status not in ('completed', 'cancelled')`,
      );
      await zero(
        "submitted reports carry submitted_at",
        `select count(*)::int as n from public.daily_report where org_id = $1 and status <> 'draft' and submitted_at is null`,
      );
      await zero(
        "reviewed reports carry a reviewer",
        `select count(*)::int as n from public.daily_report where org_id = $1 and status = 'reviewed' and (reviewed_by is null or reviewed_at is null)`,
      );
      await zero(
        "returned reports carry a reason",
        `select count(*)::int as n from public.daily_report where org_id = $1 and status = 'returned' and return_reason is null`,
      );
      await zero(
        "submitted reports carry the frozen labour-cost snapshot",
        `select count(*)::int as n from public.daily_report r
         where r.org_id = $1 and r.status <> 'draft'
           and exists (
             select 1 from public.report_labour_line l join public.employee_terms t on t.employee_id = l.employee_id
             where l.report_id = r.id and l.superseded_at is null
           )
           and not exists (select 1 from public.report_labour_cost c where c.report_id = r.id)`,
      );
      await zero(
        "inventory deductions only on submitted/reviewed, item-linked lines",
        `select count(*)::int as n from public.report_material_line l join public.daily_report r on r.id = l.report_id
         where l.org_id = $1 and l.deducted_from_inventory and (l.item_id is null or l.cost_only or r.status not in ('submitted', 'reviewed'))`,
      );
      await zero(
        "issued plans carry issuer and date",
        `select count(*)::int as n from public.week_plan where org_id = $1 and status <> 'draft' and (issued_at is null or issued_by is null or issuer_snapshot is null)`,
      );
      await zero(
        "revised plans have a successor",
        `select count(*)::int as n from public.week_plan p where p.org_id = $1 and p.status = 'revised' and not exists (select 1 from public.week_plan q where q.revision_of_id = p.id)`,
      );
      await zero(
        "comments point at existing jobs",
        `select count(*)::int as n from public.comment c where c.org_id = $1 and c.entity_type = 'job' and not exists (select 1 from public.job j where j.id = c.entity_id)`,
      );
      await zero(
        "comments point at existing tasks",
        `select count(*)::int as n from public.comment c where c.org_id = $1 and c.entity_type = 'task' and not exists (select 1 from public.task t where t.id = c.entity_id)`,
      );
      await zero(
        "comments point at existing issues",
        `select count(*)::int as n from public.comment c where c.org_id = $1 and c.entity_type = 'issue' and not exists (select 1 from public.issue i where i.id = c.entity_id)`,
      );
      await zero(
        "task approvals point at existing tasks",
        `select count(*)::int as n from public.approval a where a.org_id = $1 and a.subject_type = 'task_completion' and not exists (select 1 from public.task t where t.id = a.subject_id)`,
      );

      const distinctRefs = await count(
        ctx.sql`select count(distinct reference)::int as n from public.job where org_id = ${org}`,
      );
      checks.push({
        name: "job references are unique",
        ok: distinctRefs === model.counts.job,
        detail: `${distinctRefs} distinct of ${model.counts.job}`,
      });
      for (const s of model.sequences) {
        const row = (
          (await ctx.sql`select next_value::int as n from public.reference_sequence where org_id = ${org} and scope_key = ${s.scope}`) as unknown as Array<{
            n: number;
          }>
        )[0];
        checks.push({
          name: `reference_sequence ${s.scope} is past the seeded numbers`,
          ok: !!row && row.n >= s.next,
          detail: `${row?.n ?? "missing"} vs ${s.next}`,
        });
      }
      const deducted = await count(
        ctx.sql`select count(*)::int as n from public.report_material_line where org_id = ${org} and deducted_from_inventory`,
      );
      if (ctx.company.profile.enables.stock)
        checks.push({
          name: "some material lines were deducted from inventory",
          ok: deducted > 0,
          detail: String(deducted),
        });
      const audited = await count(
        ctx.sql`select count(*)::int as n from public.audit_log where org_id = ${org}
          and action in ('job.status', 'job.archive', 'job.reopen', 'job_stage.complete', 'job_stage.start',
                         'task.status', 'approval.decide', 'daily_report.review', 'daily_report.return',
                         'issue.update_status', 'issue.assign', 'week_plan.issue', 'week_plan.cancel')`,
      );
      if (drive)
        checks.push({
          name: "service-driven transitions left audit rows",
          ok: audited > 0,
          detail: `${audited} audit rows`,
        });
      for (const [table, planned] of Object.entries(model.counts)) {
        if (
          !["job", "task", "daily_report", "issue"].includes(table) ||
          planned <= PAGINATION_THRESHOLD
        )
          continue;
        const n = await countOf(table);
        checks.push({
          name: `${table} crosses the ${PAGINATION_THRESHOLD}-row pagination threshold`,
          ok: n > PAGINATION_THRESHOLD,
          detail: String(n),
        });
      }
      return checks;
    },
  };
}

export const work: Family = workFamily();
