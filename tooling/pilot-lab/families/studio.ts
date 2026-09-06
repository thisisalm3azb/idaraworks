/**
 * H33 Pilot Lab — family `studio`: Management Studio depth.
 *
 * Per company `profile.studioPlans` plans: one flagship programme board past
 * the navigation thresholds (> 300 nodes, > 400 edges), work-breakdown plans
 * linked to real jobs/tasks/employees from the `work` and `people` handoffs,
 * strategy boards. Every plan is a dense typed graph — phases as frames with
 * a parent hierarchy, a critical-path-shaped dependency backbone with FS/SS/FF
 * logic and lead/lag, parallel branches with float, resource conflicts (two
 * activities, one assignee, overlapping windows), delays (progress behind the
 * dates), risk/decision/assumption/issue registers, resource requirements,
 * objectives and key results, saved views, two frozen baselines, two canvas
 * checkpoints and two or three scenarios per plan.
 *
 * Truthfulness: schedule dates and both baselines come from the product's own
 * CPM engine (`computeSchedule`) over the company's working calendar; the
 * stored Monte Carlo result of a scenario comes from the product's own
 * `simulateSchedule`. Nothing here is a hand-coloured critical path.
 *
 * State law: every bulk row is born — plans active/archived (the schema knows
 * no other status), nodes proposed/active/done/dropped (draft fields the
 * product writes directly), scenarios `draft`. The two lifecycle transitions
 * that carry meaning — a scenario APPLIED to the live plan and a dependency
 * between two linked tasks MATERIALISED canonically — go through the real
 * services (`submitScenario` → `decideApproval` → `applyScenario`,
 * `discardScenario`, `addEdge`) for every active plan, never by writing
 * `applied_at` or `task_dependency_id` by hand. Service calls are skipped in
 * a dry run, and the unit test switches them off with `setStudioServices(false)`
 * so `seed()` can run against an in-memory insert; `plan()` follows the same
 * switch, which is what keeps the dry-run honest in both modes.
 */
import type { Rng } from "../../simulation/rng";
import type { Check, Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import {
  computeSchedule,
  type ScheduleDep,
  type ScheduleResult,
} from "@/modules/studio/engine/cpm";
import { simulateSchedule, type EstimatedTask } from "@/modules/studio/engine/monte-carlo";
import type { Calendar, Weekday } from "@/platform/calendar/calendar";
import { paragraph, pick, priceMinor, sentence, spreadDates, weighted } from "./_shared";

// ── vocabularies (mirrors src/modules/studio/types.ts; the DB CHECKs them) ──

export const SCHEDULABLE_NODE_TYPES = [
  "task",
  "milestone",
  "deliverable",
  "phase",
  "project",
  "initiative",
  "action",
] as const;

type NodeType =
  | "portfolio"
  | "program"
  | "objective"
  | "key_result"
  | "initiative"
  | "project"
  | "phase"
  | "milestone"
  | "task"
  | "deliverable"
  | "decision"
  | "assumption"
  | "constraint"
  | "issue"
  | "risk"
  | "opportunity"
  | "change"
  | "action"
  | "lesson"
  | "resource_requirement"
  | "budget_allocation"
  | "capacity_allocation"
  | "kpi"
  | "outcome"
  | "benefit"
  | "process"
  | "person"
  | "team"
  | "customer"
  | "supplier"
  | "system"
  | "document"
  | "database"
  | "warehouse"
  | "money"
  | "start_end"
  | "note"
  | "group"
  | "swimlane"
  | "frame"
  | "custom";

type EdgeType =
  | "dependency"
  | "flow"
  | "approval"
  | "responsibility"
  | "financial"
  | "material"
  | "customer"
  | "risk_influence"
  | "contribution"
  | "cause_effect"
  | "reference";

type DepKind = "finish_to_start" | "start_to_start" | "finish_to_finish";
type NodeStatus = "proposed" | "active" | "done" | "dropped";
type Priority = "low" | "normal" | "high" | "urgent";
type PlanKind = "programme" | "wbs" | "strategy";

export const STUDIO_TABLES = [
  "studio_plan",
  "studio_node",
  "studio_edge",
  "studio_baseline",
  "studio_version",
  "studio_scenario",
  "studio_scenario_change",
  "studio_view",
  "reference_sequence",
] as const;
export type StudioTable = (typeof STUDIO_TABLES)[number];

type Row = Record<string, unknown>;

// ── handoffs (tolerant readers: a missing key means "unlinked", never a crash)

type IdLike = string | { id?: unknown };

function idsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v as IdLike[]) {
    if (typeof x === "string") out.push(x);
    else if (x && typeof x === "object" && typeof x.id === "string") out.push(x.id);
  }
  return out;
}

function handoffOf(ctx: LabContext, family: string): Record<string, unknown> {
  try {
    return ctx.handoff<Record<string, unknown>>(family) ?? {};
  } catch {
    return {};
  }
}

export type LinkedRecords = {
  employees: string[];
  jobs: Array<{ id: string; label: string | null }>;
  tasksByJob: Map<string, string[]>;
  unassignedTasks: string[];
};

/**
 * What this family reads from `people` and `work`; everything is optional.
 *
 * `work` hands its jobs off as compact tuples
 * `[id, customerId, statusCategory, startDate, dueDate, presetCode, isProject, origin]`
 * and its tasks as a flat id list; `people` hands off `employeeIds` /
 * `activeEmployeeIds` / `personaEmployees`. Object and plain-string forms are
 * accepted too so a hand-built handoff in a test reads the same way. Jobs are
 * ordered so plans link projects first, then live work, then the rest;
 * cancelled jobs are never linked (a plan of cancelled work is noise).
 */
export function readLinkedRecords(ctx: LabContext): LinkedRecords {
  const people = handoffOf(ctx, "people");
  const work = handoffOf(ctx, "work");

  const employees = new Set<string>();
  const active = idsOf(people.activeEmployeeIds);
  for (const id of active.length ? active : idsOf(people.employeeIds)) employees.add(id);
  for (const id of idsOf(people.employees)) employees.add(id);
  const personaEmployees = people.personaEmployees;
  if (personaEmployees && typeof personaEmployees === "object") {
    for (const v of Object.values(personaEmployees as Record<string, unknown>))
      if (typeof v === "string") employees.add(v);
  }
  for (const v of Object.values(ctx.employees)) if (typeof v === "string") employees.add(v);

  type JobPick = { id: string; label: string | null; rank: number };
  const picked: JobPick[] = [];
  const seenJobs = new Set<string>();
  const pushJob = (id: string, label: string | null, rank: number) => {
    if (seenJobs.has(id)) return;
    seenJobs.add(id);
    picked.push({ id, label, rank });
  };
  for (const key of ["activeJobIds", "majorJobIds", "jobIds", "jobs"]) {
    const v = work[key];
    if (!Array.isArray(v)) continue;
    for (const x of v as unknown[]) {
      if (typeof x === "string") pushJob(x, null, 1);
      else if (Array.isArray(x) && typeof x[0] === "string") {
        const [id, , category, , , presetCode, isProject] = x as [
          string,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
        ];
        if (category === "cancelled") continue;
        const live = category === "active" || category === "on_hold";
        const rank = (isProject === 1 || isProject === true ? 0 : 2) + (live ? 0 : 1);
        pushJob(id, typeof presetCode === "string" ? presetCode : null, rank);
      } else if (
        x &&
        typeof x === "object" &&
        typeof (x as IdLike as { id?: unknown }).id === "string"
      ) {
        const o = x as { id: string; reference?: unknown; name?: unknown };
        const label =
          [o.reference, o.name].filter((s): s is string => typeof s === "string").join(" — ") ||
          null;
        pushJob(o.id, label, 1);
      }
    }
  }
  const jobs: Array<{ id: string; label: string | null }> = picked
    .map((j, i) => ({ ...j, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ id, label }) => ({ id, label }));
  const pushJobId = (id: string) => {
    if (seenJobs.has(id)) return;
    seenJobs.add(id);
    jobs.push({ id, label: null });
  };

  const tasksByJob = new Map<string, string[]>();
  for (const key of ["taskIdsByJob", "tasksByJob"]) {
    const v = work[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    for (const [jobId, list] of Object.entries(v as Record<string, unknown>)) {
      const ids = idsOf(list);
      if (ids.length) tasksByJob.set(jobId, [...(tasksByJob.get(jobId) ?? []), ...ids]);
    }
  }
  const unassignedTasks: string[] = [];
  const tasks = work.tasks;
  if (Array.isArray(tasks)) {
    for (const t of tasks as Array<{ id?: unknown; jobId?: unknown; job_id?: unknown }>) {
      if (!t || typeof t.id !== "string") continue;
      const jobId = typeof t.jobId === "string" ? t.jobId : t.job_id;
      if (typeof jobId === "string")
        tasksByJob.set(jobId, [...(tasksByJob.get(jobId) ?? []), t.id]);
      else unassignedTasks.push(t.id);
    }
  }
  for (const id of idsOf(work.taskIds)) unassignedTasks.push(id);
  for (const jobId of tasksByJob.keys()) pushJobId(jobId);

  return { employees: [...employees], jobs, tasksByJob, unassignedTasks };
}

// ── calendar: the same working week the provisioner gave the organisation ──

export function companyCalendar(company: Company): Calendar {
  const gulf = company.country === "SA";
  const days: Weekday[] = gulf
    ? ["sun", "mon", "tue", "wed", "thu"]
    : ["mon", "tue", "wed", "thu", "fri"];
  if (company.sixDayWeek) days.push("sat");
  return { workingDays: new Set(days), holidays: [] };
}

// ── text pools (fictional, bilingual) ────────────────────────────────────────

type Bi = [string, string];

const PHASES: Record<string, Bi[]> = {
  construction_v1: [
    ["Mobilisation", "التحريك والتجهيز"],
    ["Substructure", "الأساسات"],
    ["Superstructure", "الهيكل الإنشائي"],
    ["Envelope and MEP first fix", "الغلاف والتثبيت الأول للأعمال الكهروميكانيكية"],
    ["Internal finishes", "التشطيبات الداخلية"],
    ["External works", "الأعمال الخارجية"],
    ["Testing and commissioning", "الاختبار والتشغيل"],
    ["Handover", "التسليم"],
  ],
  generic_operations_v1: [
    ["Sourcing", "التوريد"],
    ["Inbound logistics", "اللوجستيات الواردة"],
    ["Warehouse setup", "تجهيز المستودع"],
    ["Distribution rollout", "إطلاق التوزيع"],
    ["Retail activation", "تفعيل التجزئة"],
    ["Season campaign", "حملة الموسم"],
    ["Stock review", "مراجعة المخزون"],
    ["Close-out", "الإغلاق"],
  ],
  manufacturing_workshop_v1: [
    ["Design freeze", "تجميد التصميم"],
    ["Tooling", "العدد والقوالب"],
    ["Material intake", "استلام المواد"],
    ["Machining", "التشغيل الآلي"],
    ["Assembly", "التجميع"],
    ["Quality gate", "بوابة الجودة"],
    ["Packaging", "التغليف"],
    ["Delivery", "التسليم"],
  ],
  service_business_v1: [
    ["Discovery", "الاستكشاف"],
    ["Current-state assessment", "تقييم الوضع الحالي"],
    ["Design", "التصميم"],
    ["Pilot", "التجربة"],
    ["Rollout", "التطبيق"],
    ["Training", "التدريب"],
    ["Stabilisation", "الاستقرار"],
    ["Close-out", "الإغلاق"],
  ],
  facilities: [
    ["Site survey", "مسح الموقع"],
    ["Contract mobilisation", "تعبئة العقد"],
    ["Preventive maintenance cycle", "دورة الصيانة الوقائية"],
    ["Chiller overhaul", "إصلاح شامل للمبرد"],
    ["Fire systems certification", "اعتماد أنظمة الحريق"],
    ["Fit-out works", "أعمال التجهيز"],
    ["Handback inspection", "فحص التسليم"],
    ["Contract close-out", "إغلاق العقد"],
  ],
};

const VERBS: Bi[] = [
  ["Survey", "مسح"],
  ["Prepare", "تجهيز"],
  ["Procure", "شراء"],
  ["Install", "تركيب"],
  ["Inspect", "فحص"],
  ["Test", "اختبار"],
  ["Review", "مراجعة"],
  ["Approve", "اعتماد"],
  ["Document", "توثيق"],
  ["Train", "تدريب"],
  ["Commission", "تشغيل"],
  ["Hand over", "تسليم"],
];

const OBJECTS: Record<string, Bi[]> = {
  construction_v1: [
    ["site hoarding", "سياج الموقع"],
    ["formwork for level 2", "قوالب الطابق الثاني"],
    ["rebar cages", "أقفاص حديد التسليح"],
    ["block work", "أعمال البلوك"],
    ["chilled-water piping", "أنابيب المياه المبردة"],
    ["cable trays", "حوامل الكابلات"],
    ["curtain wall panels", "ألواح الواجهة الزجاجية"],
    ["gypsum ceilings", "أسقف الجبس"],
    ["floor tiling", "بلاط الأرضيات"],
    ["lift shafts", "أعمدة المصاعد"],
  ],
  generic_operations_v1: [
    ["supplier shortlist", "قائمة الموردين المختصرة"],
    ["import permits", "تصاريح الاستيراد"],
    ["container schedule", "جدول الحاويات"],
    ["racking layout", "تخطيط الرفوف"],
    ["barcode labelling", "ترميز الباركود"],
    ["route plan", "خطة المسارات"],
    ["price list", "قائمة الأسعار"],
    ["promotional bundles", "الحزم الترويجية"],
    ["returns process", "إجراءات المرتجعات"],
    ["cycle counts", "الجرد الدوري"],
  ],
  manufacturing_workshop_v1: [
    ["CNC fixtures", "مثبتات التشغيل الآلي"],
    ["raw-material lots", "دفعات المواد الخام"],
    ["first-article samples", "عينات القطعة الأولى"],
    ["welding jigs", "قوالب اللحام"],
    ["surface treatment", "المعالجة السطحية"],
    ["calibration records", "سجلات المعايرة"],
    ["assembly line B", "خط التجميع ب"],
    ["packaging crates", "صناديق التغليف"],
    ["inspection gauges", "مقاييس الفحص"],
    ["export documents", "مستندات التصدير"],
  ],
  service_business_v1: [
    ["stakeholder interviews", "مقابلات أصحاب المصلحة"],
    ["process maps", "خرائط العمليات"],
    ["target operating model", "نموذج التشغيل المستهدف"],
    ["data migration plan", "خطة ترحيل البيانات"],
    ["user guides", "أدلة المستخدم"],
    ["change impact register", "سجل أثر التغيير"],
    ["benefits tracker", "متتبع الفوائد"],
    ["steering pack", "حزمة اللجنة التوجيهية"],
    ["pilot scorecard", "بطاقة نتائج التجربة"],
    ["lessons log", "سجل الدروس المستفادة"],
  ],
  facilities: [
    ["AHU filters", "فلاتر وحدات معالجة الهواء"],
    ["fire pumps", "مضخات الحريق"],
    ["BMS points", "نقاط نظام إدارة المبنى"],
    ["lift certificates", "شهادات المصاعد"],
    ["generator load bank", "بنك أحمال المولد"],
    ["water tank cleaning", "تنظيف خزانات المياه"],
    ["façade access", "الوصول إلى الواجهة"],
    ["car park lighting", "إنارة المواقف"],
    ["helpdesk SLA", "اتفاقية مستوى خدمة الدعم"],
    ["asset register", "سجل الأصول"],
  ],
};

const RISKS: Bi[] = [
  ["Supplier lead time slips past the mobilisation window", "تأخر مهلة المورد بعد نافذة التحريك"],
  [
    "Authority approval takes longer than planned",
    "استغراق موافقة الجهة المختصة وقتاً أطول من المخطط",
  ],
  ["Key resource unavailable during the peak weeks", "عدم توفر مورد رئيسي خلال أسابيع الذروة"],
  ["Design change after procurement is committed", "تغيير التصميم بعد الالتزام بالشراء"],
  ["Weather window closes for external works", "إغلاق نافذة الطقس للأعمال الخارجية"],
  [
    "Client sign-off delayed by an internal reorganisation",
    "تأخر اعتماد العميل بسبب إعادة هيكلة داخلية",
  ],
  ["Rework after a failed quality gate", "إعادة العمل بعد فشل بوابة الجودة"],
  ["Currency movement raises imported material cost", "تحرك العملة يرفع تكلفة المواد المستوردة"],
];
const DECISIONS: Bi[] = [
  ["Which supplier carries the long-lead package?", "أي مورد يتولى حزمة المهلة الطويلة؟"],
  [
    "Single shift or double shift for the critical phase?",
    "وردية واحدة أم وردية مزدوجة للمرحلة الحرجة؟",
  ],
  ["Accept the variation or hold the scope?", "قبول التعديل أم الإبقاء على النطاق؟"],
  ["Pilot in one region or all at once?", "تجربة في منطقة واحدة أم في الجميع دفعة واحدة؟"],
  ["Rent the equipment or buy it?", "استئجار المعدات أم شراؤها؟"],
];
const OPTIONS: Bi[][] = [
  [
    ["Standard option", "الخيار القياسي"],
    ["Upgraded option", "الخيار المطوّر"],
  ],
  [
    ["Hold scope", "الإبقاء على النطاق"],
    ["Accept variation", "قبول التعديل"],
    ["Defer to phase 2", "التأجيل إلى المرحلة الثانية"],
  ],
  [
    ["Rent", "استئجار"],
    ["Buy", "شراء"],
  ],
];
const ASSUMPTIONS: Bi[] = [
  ["Site access is available from the first working day", "الوصول إلى الموقع متاح من أول يوم عمل"],
  ["Client provides the design freeze before procurement", "يقدم العميل تجميد التصميم قبل الشراء"],
  ["Two crews can work in parallel on the level", "يمكن لطاقمين العمل بالتوازي على الطابق"],
  [
    "Imported materials clear customs within five days",
    "تخليص المواد المستوردة جمركياً خلال خمسة أيام",
  ],
  ["No change to the working week during the season", "لا تغيير في أسبوع العمل خلال الموسم"],
];
const ISSUES: Bi[] = [
  ["Access road blocked by a neighbouring contractor", "طريق الوصول مغلق بسبب مقاول مجاور"],
  [
    "Drawings revision C conflicts with the approved set",
    "المراجعة ج للرسومات تتعارض مع المجموعة المعتمدة",
  ],
  ["Short delivery of twelve units", "نقص في التسليم بمقدار اثنتي عشرة وحدة"],
  ["Inspection failed on the first batch", "فشل الفحص للدفعة الأولى"],
];
const ACTIONS: Bi[] = [
  ["Chase the supplier for a revised delivery date", "متابعة المورد للحصول على موعد تسليم معدّل"],
  ["Book the authority inspection", "حجز موعد فحص الجهة المختصة"],
  ["Issue the toolbox talk on the new method", "إصدار جلسة السلامة حول الطريقة الجديدة"],
  ["Update the client on the recovery plan", "إطلاع العميل على خطة التعافي"],
];
const ROLES: Bi[] = [
  ["Site engineer", "مهندس موقع"],
  ["Electrician", "كهربائي"],
  ["QA inspector", "مفتش جودة"],
  ["Logistics coordinator", "منسق لوجستي"],
  ["Business analyst", "محلل أعمال"],
  ["Crane operator", "مشغل رافعة"],
  ["Technician", "فني"],
];
const OBJECTIVES: Bi[] = [
  [
    "Deliver on the agreed date with zero open severe risks",
    "التسليم في الموعد المتفق عليه دون مخاطر شديدة مفتوحة",
  ],
  ["Season-ready operation with stable service levels", "تشغيل جاهز للموسم بمستويات خدمة مستقرة"],
  ["Every hull sea-trialled before the target date", "اختبار كل هيكل بحرياً قبل التاريخ المستهدف"],
];
const KEY_RESULTS: Array<{ en: string; ar: string; metric: string; unit: string; target: number }> =
  [
    {
      en: "Milestones hit on time",
      ar: "المعالم المحققة في موعدها",
      metric: "on_time_milestones",
      unit: "percent",
      target: 90,
    },
    {
      en: "Rework below five percent of hours",
      ar: "إعادة العمل أقل من خمسة بالمئة من الساعات",
      metric: "rework_hours",
      unit: "percent",
      target: 5,
    },
    {
      en: "No open severe risks at the gate",
      ar: "لا مخاطر شديدة مفتوحة عند البوابة",
      metric: "severe_open_risks",
      unit: "count",
      target: 0,
    },
    {
      en: "Client satisfaction score",
      ar: "درجة رضا العميل",
      metric: "csat",
      unit: "score",
      target: 4.5,
    },
  ];
const KPI_KEYS = [
  "plan.finish",
  "plan.duration_days",
  "plan.finish_variance_days",
  "plan.missing_logic_pct",
  "plan.negative_float",
];
const NOTES: Bi[] = [
  [
    "Weekly look-ahead meeting every Sunday 08:00 at the site office.",
    "اجتماع الاستشراف الأسبوعي كل أحد الساعة الثامنة صباحاً في مكتب الموقع.",
  ],
  [
    "Scope re-baselined after the client's variation; see baseline 2.",
    "أُعيد تحديد النطاق بعد تعديل العميل؛ انظر الخط المرجعي الثاني.",
  ],
  [
    "Long-lead items are ordered — tracked in the procurement register.",
    "البنود ذات المهلة الطويلة مطلوبة — تُتابع في سجل المشتريات.",
  ],
  [
    "Critical chain runs through the highlighted phases.",
    "تمر السلسلة الحرجة عبر المراحل المميزة.",
  ],
];

function arabicFirst(company: Company): boolean {
  return company.languages[0] === "ar";
}

/** Bilingual display: Arabic-first companies lead with Arabic; others mix ~25 %. */
function bi(rng: Rng, company: Company, pair: Bi): string {
  const [en, ar] = pair;
  if (arabicFirst(company)) return rng.chance(0.3) ? `${ar} — ${en}` : ar;
  const r = rng.next();
  return r < 0.22 ? ar : r < 0.32 ? `${en} — ${ar}` : en;
}

function lang(rng: Rng, company: Company): "en" | "ar" {
  return arabicFirst(company) ? (rng.chance(0.8) ? "ar" : "en") : rng.chance(0.25) ? "ar" : "en";
}

function pools(company: Company): { phases: Bi[]; objects: Bi[] } {
  const key = company.key === "facilico" ? "facilities" : company.templateKey;
  return {
    phases: PHASES[key] ?? PHASES.service_business_v1!,
    objects: OBJECTS[key] ?? OBJECTS.service_business_v1!,
  };
}

// ── the model ────────────────────────────────────────────────────────────────

type NodeSpec = {
  id: string;
  nodeType: NodeType;
  title: string | null;
  description: string | null;
  recordType: "job" | "task" | "employee" | null;
  recordId: string | null;
  status: NodeStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  durationDays: number | null;
  progressPct: number | null;
  ownerUserId: string | null;
  assigneeEmployeeId: string | null;
  amountMinor: number | null;
  currency: string | null;
  data: Record<string, unknown>;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
  parentNodeId: string | null;
  layerKey: string;
  locked: boolean;
  style: Record<string, unknown>;
  deadlineDate: string | null;
  constraintKind: "none" | "start_no_earlier";
  constraintDate: string | null;
  estimateOptimisticDays: number | null;
  estimatePessimisticDays: number | null;
  createdAgo: number;
};

type EdgeSpec = {
  id: string;
  source: string;
  target: string;
  edgeType: EdgeType;
  depKind: DepKind | null;
  lagDays: number;
  label: string | null;
  createdAgo: number;
};

type ServiceEdge = {
  planId: string;
  source: string;
  target: string;
  depKind: DepKind;
  lagDays: number;
};

type ScenarioSpec = {
  id: string;
  planId: string;
  name: string;
  description: string;
  isShared: boolean;
  assumptions: Array<{ text: string; confidence: "low" | "medium" | "high"; owner?: string }>;
  simulation: Record<string, unknown>;
  decision: Record<string, unknown>;
  baseCapturedAgo: number;
  createdBy: string;
  /** Bulk changes the apply replays; empty for scenarios that stay draft or are discarded. */
  changes: Array<{
    id: string;
    nodeId: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
  transition: "apply" | "discard" | null;
};

export type PlanModel = {
  id: string;
  index: number;
  kind: PlanKind;
  reference: string;
  name: string;
  status: "active" | "archived";
  anchor: string;
  createdAgo: number;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Node ids the engine scheduled at capture (the baseline snapshot lists exactly these). */
  scheduledIds: string[];
  schedule: ScheduleResult;
  serviceEdges: ServiceEdge[];
  scenarios: ScenarioSpec[];
  baselines: Array<{ id: string; name: string; snapshot: unknown[]; capturedAgo: number }>;
  versions: Array<{ id: string; name: string; snapshot: unknown; createdAgo: number }>;
  views: Array<{
    id: string;
    name: string;
    viewKind: string;
    config: Record<string, unknown>;
    isShared: boolean;
    ownerUserId: string;
    createdAgo: number;
  }>;
};

export type StudioModel = {
  plans: PlanModel[];
  rows: Record<StudioTable, Row[]>;
  /**
   * Rows the real services create on top of the bulk insert, which the plan
   * must budget: one studio_edge + one task_dependency per materialised
   * dependency, one approval per scenario that is submitted and applied.
   * (Audit, activity and outbox rows are by-products of every service call
   * and are not budgeted here, as in the other families.)
   */
  serviceRows: { studio_edge: number; task_dependency: number; approval: number };
  linked: LinkedRecords;
};

// ── the service switch ───────────────────────────────────────────────────────
//
// The lifecycle transitions need a database and the real domain services. A
// dry run never calls them; the unit test turns them off so `seed()` can run
// against an in-memory insert. `plan()` reads the same switch, so the counts
// it promises are exactly the counts `seed()` attempts in either mode.

let servicesEnabled = true;

/** Turn the service-driven transitions on or off (tests only; defaults to on). */
export function setStudioServices(enabled: boolean): void {
  servicesEnabled = enabled;
}

export function studioServicesEnabled(): boolean {
  return servicesEnabled;
}

function distribute(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const rem = total - base * buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < rem ? 1 : 0));
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function addDaysIso(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Build one plan: nodes, edges, schedule, baselines, versions, scenarios, views. */
function buildPlan(
  ctx: LabContext,
  linked: LinkedRecords,
  opts: {
    index: number;
    kind: PlanKind;
    size: number;
    flagship: boolean;
    anchorDaysAgo: number;
    archived: boolean;
    job: { id: string; label: string | null } | null;
  },
): PlanModel {
  const { rng, company, clock } = ctx;
  const p = opts.index;
  const planId = ctx.id("studio", "plan", p);
  const cal = companyCalendar(company);
  const { phases: phasePool, objects } = pools(company);
  const asOf = clock.asOf;
  const anchor = clock.dayAgo(opts.anchorDaysAgo);
  const createdAgo = Math.max(0, opts.anchorDaysAgo + 20);
  const users = ctx.users;
  const managers = [users.manager, users.owner, users.hr];
  const N = opts.size;

  // ── composition ──────────────────────────────────────────────────────────
  const K = opts.flagship ? 8 : Math.min(7, Math.max(3, Math.round(N / 32)));
  const activitiesTotal = Math.round(N * 0.6);
  const perPhase = distribute(Math.max(K * 3, activitiesTotal - K), K);
  const G = Math.round(N * 0.2);
  const riskCount = Math.max(2, Math.ceil(G * 0.45));
  const decisionCount = Math.max(1, Math.ceil(G * 0.2));
  const assumptionCount = Math.max(1, Math.ceil(G * 0.15));
  const issueCount = Math.max(1, Math.floor(G * 0.1));
  const actionCount = Math.max(1, G - riskCount - decisionCount - assumptionCount - issueCount);
  const Rn = Math.max(2, Math.round(N * 0.08));
  const personCount = Math.min(Math.floor(Rn / 2), linked.employees.length);
  const requirementCount = Rn - personCount;
  const krCount = 3;
  const kpiCount = 2;
  const fixed = 1 + K + activitiesTotal + G + Rn + 1 + krCount + kpiCount + K;
  const noteCount = Math.max(2, N - fixed);

  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  const edgeKeys = new Set<string>();
  let nodeSeq = 0;
  let edgeSeq = 0;

  const newNode = (partial: Partial<NodeSpec> & { nodeType: NodeType }): NodeSpec => {
    const n: NodeSpec = {
      id: ctx.id("studio", "node", p, nodeSeq++),
      title: null,
      description: null,
      recordType: null,
      recordId: null,
      status: "proposed",
      priority: "normal",
      startDate: null,
      dueDate: null,
      durationDays: null,
      progressPct: null,
      ownerUserId: null,
      assigneeEmployeeId: null,
      amountMinor: null,
      currency: null,
      data: {},
      x: 0,
      y: 0,
      w: null,
      h: null,
      z: 1,
      parentNodeId: null,
      layerKey: "schedule",
      locked: false,
      style: {},
      deadlineDate: null,
      constraintKind: "none",
      constraintDate: null,
      estimateOptimisticDays: null,
      estimatePessimisticDays: null,
      createdAgo,
      ...partial,
    };
    nodes.push(n);
    return n;
  };
  const link = (
    source: NodeSpec,
    target: NodeSpec,
    edgeType: EdgeType,
    dep: { kind: DepKind; lag?: number } | null = null,
    label: string | null = null,
  ): EdgeSpec | null => {
    if (source.id === target.id) return null;
    const key = `${source.id}>${target.id}:${edgeType}`;
    if (edgeKeys.has(key)) return null;
    edgeKeys.add(key);
    const e: EdgeSpec = {
      id: ctx.id("studio", "edge", p, edgeSeq++),
      source: source.id,
      target: target.id,
      edgeType,
      depKind: dep?.kind ?? null,
      lagDays: dep?.lag ?? 0,
      label,
      createdAgo,
    };
    edges.push(e);
    return e;
  };
  const depLabel = (kind: DepKind, lag: number): string | null => {
    if (lag === 0 && kind === "finish_to_start") return null;
    const short = kind === "finish_to_start" ? "FS" : kind === "start_to_start" ? "SS" : "FF";
    return lag === 0 ? short : `${short} ${lag > 0 ? "+" : ""}${lag}d`;
  };

  // ── structure: root → phases (frames) → activities ───────────────────────
  const COL = 250;
  const ROW = 110;
  const rootType: NodeType =
    opts.kind === "wbs" ? "project" : opts.kind === "strategy" ? "initiative" : "program";
  const root = newNode({
    nodeType: rootType,
    title:
      opts.job && opts.kind === "wbs"
        ? null
        : opts.kind === "programme"
          ? bi(rng, company, ["Programme board", "لوحة البرنامج"])
          : bi(rng, company, ["Strategic initiative", "المبادرة الاستراتيجية"]),
    description: paragraph(rng, lang(rng, company), 2),
    recordType: opts.job && opts.kind === "wbs" ? "job" : null,
    recordId: opts.job && opts.kind === "wbs" ? opts.job.id : null,
    status: "active",
    x: 40,
    y: 160,
    z: 0,
    layerKey: "structure",
    ownerUserId: users.manager,
    locked: true,
  });

  type Activity = NodeSpec & { dur: number; branch: boolean; phase: number };
  const phaseNodes: NodeSpec[] = [];
  const mains: Activity[][] = [];
  const branches: Activity[][] = [];
  const milestones: NodeSpec[] = [];
  const activities: Activity[] = [];
  const dropped = new Set<string>();
  let maxFrameW = 0;
  const jobsForPhases = linked.jobs;

  for (let ph = 0; ph < K; ph++) {
    const a = perPhase[ph]!;
    const mainCount = Math.max(2, Math.floor(a * 0.6));
    const branchCount = a - mainCount;
    const frameW = (Math.max(mainCount, branchCount) + 1) * COL + 60;
    const frameH = (1 + (branchCount > 0 ? 1 : 0) + (branchCount > mainCount ? 1 : 0)) * ROW + 120;
    const fx = 80;
    const fy = 260 + ph * (2 * ROW + 200);
    maxFrameW = Math.max(maxFrameW, frameW);
    const phaseJob =
      opts.kind === "programme" && jobsForPhases.length > 0
        ? jobsForPhases[(p * K + ph) % jobsForPhases.length]!
        : opts.kind === "wbs"
          ? opts.job
          : null;
    const phaseName = phasePool[ph % phasePool.length]!;
    const phase = newNode({
      nodeType: "phase",
      title: opts.kind === "programme" && phaseJob ? null : bi(rng, company, phaseName),
      description: opts.kind === "programme" && phaseJob ? null : sentence(rng, lang(rng, company)),
      recordType: opts.kind === "programme" && phaseJob ? "job" : null,
      recordId: opts.kind === "programme" && phaseJob ? phaseJob.id : null,
      x: fx,
      y: fy,
      w: frameW,
      h: frameH,
      z: 0,
      parentNodeId: root.id,
      layerKey: "structure",
      ownerUserId: pick(rng, managers),
    });
    phaseNodes.push(phase);
    const phaseTasks =
      (phaseJob ? linked.tasksByJob.get(phaseJob.id) : undefined) ??
      (linked.unassignedTasks.length ? linked.unassignedTasks : []);
    let taskCursor = (p * 7 + ph * 3) % Math.max(1, phaseTasks.length);
    const nextTask = (): string | null => {
      if (phaseTasks.length === 0) return null;
      const id = phaseTasks[taskCursor % phaseTasks.length]!;
      taskCursor++;
      return id;
    };

    const main: Activity[] = [];
    for (let i = 0; i < mainCount; i++) {
      const dur = rng.int(1, opts.flagship ? 5 : 6);
      const taskId = i % 2 === 1 ? nextTask() : null;
      const verb = pick(rng, VERBS);
      const obj = pick(rng, objects);
      const n = newNode({
        nodeType: taskId ? "task" : rng.chance(0.15) ? "deliverable" : "task",
        title: taskId ? null : bi(rng, company, [`${verb[0]} ${obj[0]}`, `${verb[1]} ${obj[1]}`]),
        description: taskId ? null : rng.chance(0.5) ? sentence(rng, lang(rng, company)) : null,
        recordType: taskId ? "task" : null,
        recordId: taskId,
        durationDays: dur,
        estimateOptimisticDays: Math.max(0, roundHalf(dur * 0.7)),
        estimatePessimisticDays: Math.round(dur * 1.6) + 1,
        priority: weighted(rng, { low: 1, normal: 6, high: 2, urgent: 0.5 }),
        x: fx + 40 + i * COL,
        y: fy + 50,
        w: 200,
        h: 64,
        parentNodeId: phase.id,
        ownerUserId: rng.chance(0.4) ? pick(rng, managers) : null,
      });
      main.push({ ...n, dur, branch: false, phase: ph });
    }
    const branch: Activity[] = [];
    for (let j = 0; j < branchCount; j++) {
      const dur = rng.int(1, 4);
      const verb = pick(rng, VERBS);
      const obj = pick(rng, objects);
      const n = newNode({
        nodeType: rng.chance(0.3) ? "deliverable" : "task",
        title: bi(rng, company, [`${verb[0]} ${obj[0]}`, `${verb[1]} ${obj[1]}`]),
        description: rng.chance(0.3) ? sentence(rng, lang(rng, company)) : null,
        durationDays: dur,
        estimateOptimisticDays: Math.max(0, roundHalf(dur * 0.7)),
        estimatePessimisticDays: Math.round(dur * 1.6) + 1,
        priority: weighted(rng, { low: 2, normal: 6, high: 1.5, urgent: 0.5 }),
        x: fx + 40 + (j % Math.max(1, mainCount)) * COL,
        y: fy + 50 + ROW * (1 + Math.floor(j / Math.max(1, mainCount))),
        w: 200,
        h: 64,
        parentNodeId: phase.id,
      });
      branch.push({ ...n, dur, branch: true, phase: ph });
    }
    const milestone = newNode({
      nodeType: "milestone",
      title: bi(rng, company, [`${phaseName[0]} complete`, `اكتمال ${phaseName[1]}`]),
      x: fx + 40 + mainCount * COL,
      y: fy + 50,
      w: 160,
      h: 64,
      parentNodeId: phase.id,
      priority: "high",
    });
    milestones.push(milestone);
    mains.push(main);
    branches.push(branch);
    activities.push(...main, ...branch);

    // dependency backbone: main chain → milestone; branches fan out from main[0]
    for (let i = 0; i + 1 < main.length; i++) {
      const kind: DepKind = i % 5 === 3 ? "start_to_start" : "finish_to_start";
      const lag = kind === "start_to_start" ? rng.int(1, 3) : rng.chance(0.15) ? rng.int(1, 2) : 0;
      link(main[i]!, main[i + 1]!, "dependency", { kind, lag }, depLabel(kind, lag));
    }
    link(main[main.length - 1]!, milestone, "dependency", { kind: "finish_to_start" }, null);
    branch.forEach((b, j) => {
      const inKind: DepKind = j % 3 === 2 ? "start_to_start" : "finish_to_start";
      const inLag = inKind === "start_to_start" ? 0 : j === 0 || j === 1 ? 0 : rng.int(0, 2);
      link(main[0]!, b, "dependency", { kind: inKind, lag: inLag }, depLabel(inKind, inLag));
      const outKind: DepKind = j % 4 === 1 ? "finish_to_finish" : "finish_to_start";
      link(b, milestone, "dependency", { kind: outKind, lag: 0 }, depLabel(outKind, 0));
    });
    // lattice: forward skips that add density without touching the linked-linked rule
    for (let i = 0; i + 3 < main.length; i += 3) {
      if (rng.chance(opts.flagship ? 0.9 : 0.35)) {
        link(main[i]!, main[i + 3]!, "dependency", { kind: "finish_to_start", lag: 0 }, "FS");
      }
    }
    // resource conflict: the first two branches start together and share a person
    if (branch.length >= 2 && linked.employees.length > 0) {
      const who = pick(rng, linked.employees);
      branch[0]!.assigneeEmployeeId = who;
      branch[1]!.assigneeEmployeeId = who;
      const b0 = nodes.find((n) => n.id === branch[0]!.id)!;
      const b1 = nodes.find((n) => n.id === branch[1]!.id)!;
      b0.assigneeEmployeeId = who;
      b1.assigneeEmployeeId = who;
    }
    // a few late branches are dropped (cancelled scope)
    branch.slice(2).forEach((b) => {
      if (rng.chance(0.08)) dropped.add(b.id);
    });
  }
  // phases in sequence: the flagship runs phases overlapped (SS), others gated (FS)
  for (let ph = 0; ph + 1 < K; ph++) {
    if (opts.flagship) {
      const lag = 8 + ph;
      link(
        mains[ph]![0]!,
        mains[ph + 1]![0]!,
        "dependency",
        { kind: "start_to_start", lag },
        depLabel("start_to_start", lag),
      );
    } else {
      const lag = rng.chance(0.3) ? rng.int(1, 3) : 0;
      link(
        milestones[ph]!,
        mains[ph + 1]![0]!,
        "dependency",
        { kind: "finish_to_start", lag },
        depLabel("finish_to_start", lag),
      );
    }
    link(phaseNodes[ph]!, phaseNodes[ph + 1]!, "flow", null, null);
  }
  let finalMilestone: NodeSpec | null = null;
  if (opts.flagship) {
    finalMilestone = newNode({
      nodeType: "milestone",
      title: bi(rng, company, ["Programme complete", "اكتمال البرنامج"]),
      x: maxFrameW + 160,
      y: 260 + (K - 1) * (2 * ROW + 200) + 50,
      w: 180,
      h: 64,
      priority: "urgent",
      parentNodeId: root.id,
    });
    for (const m of milestones)
      link(m, finalMilestone, "dependency", { kind: "finish_to_start" }, null);
  }
  for (const ph of phaseNodes) link(ph, root, "contribution", null, null);
  const rootNode = nodes[0]!;
  rootNode.w = maxFrameW + 420;
  rootNode.h = 260 + K * (2 * ROW + 200);

  // ── governance register (right of the frames) ────────────────────────────
  const gx = maxFrameW + 420;
  const gy = 260;
  let gi = 0;
  const gpos = () => {
    const r = { x: gx + (gi % 3) * 300, y: gy + Math.floor(gi / 3) * 120 };
    gi++;
    return r;
  };
  const anyActivity = () => pick(rng, activities);
  const risks: NodeSpec[] = [];
  for (let i = 0; i < riskCount; i++) {
    const r = RISKS[i % RISKS.length]!;
    const likelihood = rng.int(1, 5);
    const impact = rng.int(1, 5);
    const risk = newNode({
      nodeType: "risk",
      title: bi(rng, company, r),
      description: rng.chance(0.5) ? sentence(rng, lang(rng, company)) : null,
      status: weighted(rng, { proposed: 2, active: 5, done: 2, dropped: 0.5 }),
      priority: likelihood * impact >= 12 ? "high" : "normal",
      data: {
        likelihood,
        impact,
        proximity: pick(rng, ["imminent", "near", "distant"] as const),
        response: pick(rng, ["avoid", "mitigate", "transfer", "accept"] as const),
        mitigation: sentence(rng, lang(rng, company)),
        ...(rng.chance(0.5)
          ? { residualLikelihood: Math.max(1, likelihood - 1), residualImpact: impact }
          : {}),
        ...(rng.chance(0.6) ? { reviewDate: clock.dayAgo(rng.int(-30, 20)) } : {}),
      },
      ...gpos(),
      w: 240,
      h: 72,
      layerKey: "governance",
      ownerUserId: pick(rng, managers),
    });
    risks.push(risk);
    link(risk, anyActivity(), "risk_influence", null, null);
    if (rng.chance(0.4)) link(risk, anyActivity(), "risk_influence", null, null);
  }
  const issues: NodeSpec[] = [];
  for (let i = 0; i < issueCount; i++) {
    const issue = newNode({
      nodeType: "issue",
      title: bi(rng, company, ISSUES[i % ISSUES.length]!),
      description: sentence(rng, lang(rng, company)),
      status: weighted(rng, { active: 5, done: 3, proposed: 1 }),
      priority: weighted(rng, { normal: 3, high: 3, urgent: 1 }),
      ...gpos(),
      w: 240,
      h: 72,
      layerKey: "governance",
      ownerUserId: pick(rng, managers),
    });
    issues.push(issue);
    link(issue, risks[i % risks.length]!, "cause_effect", null, null);
    link(issue, anyActivity(), "reference", null, null);
  }
  for (let i = 0; i < decisionCount; i++) {
    const q = DECISIONS[i % DECISIONS.length]!;
    const options = OPTIONS[i % OPTIONS.length]!;
    const decided = rng.chance(0.5);
    const chosen = options[rng.int(0, options.length - 1)]!;
    const decision = newNode({
      nodeType: "decision",
      title: bi(rng, company, q),
      status: decided ? "done" : "active",
      priority: "high",
      data: {
        question: bi(rng, company, q),
        options: options.map((o) => ({ label: bi(rng, company, o) })),
        recommendation: sentence(rng, lang(rng, company)),
        participants: [company.personas[2]!.fullName, company.personas[0]!.fullName],
        ...(decided
          ? { decidedOption: bi(rng, company, chosen), decidedOn: clock.dayAgo(rng.int(5, 90)) }
          : {}),
      },
      ...gpos(),
      w: 240,
      h: 72,
      layerKey: "governance",
      ownerUserId: users.owner,
    });
    link(decision, anyActivity(), "reference", null, null);
    if (rng.chance(0.5)) link(decision, phaseNodes[i % K]!, "approval", null, null);
  }
  for (let i = 0; i < assumptionCount; i++) {
    const validated = rng.chance(0.4);
    const a = newNode({
      nodeType: "assumption",
      title: bi(rng, company, ASSUMPTIONS[i % ASSUMPTIONS.length]!),
      status: validated ? "done" : "active",
      data: {
        confidence: pick(rng, ["low", "medium", "high"] as const),
        ...(validated ? { validatedOn: clock.dayAgo(rng.int(10, 120)) } : {}),
      },
      ...gpos(),
      w: 240,
      h: 72,
      layerKey: "governance",
    });
    link(a, phaseNodes[i % K]!, "reference", null, null);
  }
  for (let i = 0; i < actionCount; i++) {
    const act = newNode({
      nodeType: "action",
      title: bi(rng, company, ACTIONS[i % ACTIONS.length]!),
      status: weighted(rng, { proposed: 2, active: 4, done: 3 }),
      priority: weighted(rng, { normal: 4, high: 2 }),
      assigneeEmployeeId: linked.employees.length ? pick(rng, linked.employees) : null,
      ...gpos(),
      w: 240,
      h: 72,
      layerKey: "governance",
    });
    link(
      act,
      (i % 2 === 0 ? risks : issues)[i % Math.max(1, (i % 2 === 0 ? risks : issues).length)] ??
        risks[0]!,
      "reference",
      null,
      null,
    );
  }

  // ── resources (further right) ────────────────────────────────────────────
  const rx = gx + 3 * 300 + 120;
  let ri = 0;
  const rpos = () => {
    const r = { x: rx + (ri % 2) * 280, y: gy + Math.floor(ri / 2) * 110 };
    ri++;
    return r;
  };
  for (let i = 0; i < personCount; i++) {
    const emp = linked.employees[(p * 5 + i) % linked.employees.length]!;
    const person = newNode({
      nodeType: "person",
      recordType: "employee",
      recordId: emp,
      status: "active",
      ...rpos(),
      w: 220,
      h: 64,
      layerKey: "resources",
    });
    const k = rng.int(2, 5);
    for (let j = 0; j < k; j++) link(person, anyActivity(), "responsibility", null, null);
  }
  for (let i = 0; i < requirementCount; i++) {
    const role = ROLES[i % ROLES.length]!;
    const req = newNode({
      nodeType: "resource_requirement",
      title: bi(rng, company, role),
      status: weighted(rng, { proposed: 3, active: 5, done: 1 }),
      data: {
        roleLabel: role[0],
        skillKey: role[0].toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        headcount: rng.int(1, 6),
        minutesPerWeek: rng.int(4, 48) * 60,
      },
      ...rpos(),
      w: 220,
      h: 64,
      layerKey: "resources",
    });
    link(req, phaseNodes[i % K]!, "responsibility", null, null);
  }
  for (let ph = 0; ph < K; ph++) {
    const budget = newNode({
      nodeType: "budget_allocation",
      title: bi(rng, company, [
        `Budget — ${phasePool[ph % phasePool.length]![0]}`,
        `الميزانية — ${phasePool[ph % phasePool.length]![1]}`,
      ]),
      amountMinor: priceMinor(rng, 5_000, 250_000),
      currency: company.currency,
      status: "active",
      ...rpos(),
      w: 220,
      h: 64,
      layerKey: "resources",
    });
    link(budget, phaseNodes[ph]!, "financial", null, null);
  }

  // ── strategy (top row) ───────────────────────────────────────────────────
  const objective = newNode({
    nodeType: "objective",
    title: bi(rng, company, OBJECTIVES[p % OBJECTIVES.length]!),
    status: "active",
    priority: "high",
    data: {
      theme: pick(rng, ["delivery", "quality", "growth"]),
      horizon: pick(rng, ["quarter", "year", "multi_year"] as const),
    },
    x: 40 + 2 * 320,
    y: 20,
    w: 260,
    h: 72,
    layerKey: "strategy",
    ownerUserId: users.owner,
  });
  link(root, objective, "contribution", null, null);
  for (let i = 0; i < krCount; i++) {
    const kr = KEY_RESULTS[(p + i) % KEY_RESULTS.length]!;
    const current =
      kr.unit === "count" ? rng.int(0, 3) : Math.round(kr.target * rng.float(0.5, 1.1) * 10) / 10;
    const krNode = newNode({
      nodeType: "key_result",
      title: bi(rng, company, [kr.en, kr.ar]),
      status: "active",
      data: {
        metric: kr.metric,
        unit: kr.unit,
        baseline: 0,
        target: kr.target,
        current,
        direction: kr.metric === "on_time_milestones" || kr.metric === "csat" ? "up" : "down",
      },
      x: 40 + i * 320,
      y: 110,
      w: 260,
      h: 64,
      layerKey: "strategy",
    });
    link(krNode, objective, "contribution", null, null);
    link(milestones[i % K]!, krNode, "contribution", null, null);
  }
  for (let i = 0; i < kpiCount; i++) {
    const kpi = newNode({
      nodeType: "kpi",
      title: KPI_KEYS[(p + i) % KPI_KEYS.length]!,
      status: "active",
      data: { kpiKey: KPI_KEYS[(p + i) % KPI_KEYS.length]! },
      x: 40 + (3 + i) * 320,
      y: 110,
      w: 200,
      h: 56,
      layerKey: "strategy",
    });
    link(kpi, objective, "reference", null, null);
  }

  // ── notes (canvas vocabulary) ────────────────────────────────────────────
  for (let i = 0; i < noteCount; i++) {
    const note = newNode({
      nodeType: "note",
      title: bi(rng, company, NOTES[i % NOTES.length]!),
      x: 80 + (i % 4) * 300,
      y: rootNode.h! + 300 + Math.floor(i / 4) * 90,
      w: 260,
      h: 60,
      z: 2,
      layerKey: "canvas",
      style: { color: pick(rng, ["amber", "sky", "rose", "lime"]) },
    });
    if (i % 2 === 0) link(note, anyActivity(), "reference", null, null);
  }

  // ── the flagship must cross the navigation thresholds ────────────────────
  if (opts.flagship) {
    let guard = 0;
    while (edges.length < 410 && guard++ < 2000) {
      const a = pick(rng, risks);
      const b = anyActivity();
      link(a, b, "risk_influence", null, null);
    }
  }

  // ── schedule from the product's engine ───────────────────────────────────
  const activityById = new Map(activities.map((a) => [a.id, a]));
  const engineTasks: EstimatedTask[] = [];
  for (const n of nodes) {
    const isMilestone = n.nodeType === "milestone";
    const act = activityById.get(n.id);
    if (!isMilestone && !act) continue;
    if (dropped.has(n.id)) continue;
    engineTasks.push({
      id: n.id,
      title: n.title ?? undefined,
      durationDays: isMilestone ? 0 : act!.dur,
      startDate: null,
      dueDate: null,
      isMilestone,
      constraintKind: "none",
      constraintDate: null,
      deadlineDate: null,
      optimisticDays: isMilestone ? null : n.estimateOptimisticDays,
      pessimisticDays: isMilestone ? null : n.estimatePessimisticDays,
    });
  }
  const engineDeps: ScheduleDep[] = edges
    .filter((e) => e.edgeType === "dependency" && e.depKind)
    .map((e) => ({
      predecessorId: e.source,
      successorId: e.target,
      kind: e.depKind!,
      lagDays: e.lagDays,
    }));
  const schedule = computeSchedule(cal, engineTasks, engineDeps, { projectStart: anchor });
  if (!schedule.ok) {
    throw new Error(
      `studio: plan ${p} of ${company.key} has a dependency cycle (${schedule.cycle.length} nodes)`,
    );
  }
  const scheduledIds = [...schedule.tasks.keys()];

  // ── dates, status and progress from the schedule (delays included) ───────
  const delayed = new Map<string, number>();
  for (const n of nodes) {
    const s = schedule.tasks.get(n.id);
    if (!s) {
      if (dropped.has(n.id)) n.status = "dropped";
      continue;
    }
    if (n.recordType) continue; // a linked node carries no copied business fields
    n.startDate = s.earlyStart;
    n.dueDate = s.earlyFinish;
    if (n.nodeType === "milestone") {
      n.status = opts.archived || s.earlyFinish < asOf ? "done" : "proposed";
      n.progressPct = n.status === "done" ? 100 : 0;
      continue;
    }
    if (opts.archived || s.earlyFinish < asOf) {
      if (!opts.archived && rng.chance(0.22)) {
        n.status = "active";
        n.progressPct = rng.int(20, 75);
        delayed.set(n.id, rng.int(2, 6));
      } else {
        n.status = "done";
        n.progressPct = 100;
      }
    } else if (s.earlyStart <= asOf) {
      const span = Math.max(
        1,
        Math.round((Date.parse(s.earlyFinish) - Date.parse(s.earlyStart)) / 86_400_000) + 1,
      );
      const elapsed = Math.round((Date.parse(asOf) - Date.parse(s.earlyStart)) / 86_400_000);
      const expected = Math.min(95, Math.round((elapsed / span) * 100));
      const behind = rng.chance(0.5);
      n.status = "active";
      n.progressPct = Math.max(
        0,
        Math.min(100, expected + (behind ? -rng.int(15, 40) : rng.int(0, 10))),
      );
      if (behind) delayed.set(n.id, rng.int(1, 4));
    } else {
      n.status = "proposed";
      n.progressPct = 0;
    }
    if (!n.assigneeEmployeeId && linked.employees.length && rng.chance(0.5)) {
      n.assigneeEmployeeId = pick(rng, linked.employees);
    }
  }
  // a dated constraint on one early activity; a deadline on the last milestone
  const firstMain = mains[0]![0]!;
  const fm = nodes.find((n) => n.id === firstMain.id)!;
  if (!fm.recordType && fm.startDate) {
    fm.constraintKind = "start_no_earlier";
    fm.constraintDate = fm.startDate;
  }
  const lastMilestone = finalMilestone ?? milestones[K - 1]!;
  const lm = schedule.tasks.get(lastMilestone.id);
  if (lm)
    lastMilestone.deadlineDate = addDaysIso(
      lm.earlyFinish,
      rng.chance(0.35) ? -rng.int(3, 15) : rng.int(5, 30),
    );
  // phases summarise their children
  for (let ph = 0; ph < K; ph++) {
    const kids = [...mains[ph]!, ...branches[ph]!].map((a) => nodes.find((n) => n.id === a.id)!);
    const done = kids.every((k) => k.status === "done" || k.status === "dropped" || k.recordType);
    const active = kids.some((k) => k.status === "active");
    const phase = phaseNodes[ph]!;
    if (!phase.recordType) phase.status = done ? "done" : active ? "active" : "proposed";
  }

  // ── baselines: the approved plan, then the re-baseline after slippage ────
  const snapshotOf = (r: ScheduleResult): unknown[] =>
    [...r.tasks.values()].map((t) => ({
      nodeId: t.id,
      title:
        nodes.find((n) => n.id === t.id)?.title ??
        (activityById.get(t.id)?.recordType ? "linked task" : t.id),
      start: t.earlyStart,
      finish: t.earlyFinish,
      durationDays: t.durationDays,
      amountMinor: null,
    }));
  const slipped = computeSchedule(
    cal,
    engineTasks.map((t) => ({
      ...t,
      durationDays: (t.durationDays ?? 0) + (delayed.get(t.id) ?? 0),
    })),
    engineDeps,
    { projectStart: anchor },
  );
  const b1Ago = Math.max(1, opts.anchorDaysAgo + 1);
  const b2Ago = Math.max(0, Math.min(b1Ago - 1, Math.round(opts.anchorDaysAgo * 0.55)));
  const baselines: PlanModel["baselines"] = [
    {
      id: ctx.id("studio", "baseline", p, 1),
      name: bi(rng, company, ["Baseline 1 — approved plan", "الخط المرجعي ١ — الخطة المعتمدة"]),
      snapshot: snapshotOf(schedule),
      capturedAgo: b1Ago,
    },
    {
      id: ctx.id("studio", "baseline", p, 2),
      name: bi(rng, company, [
        "Baseline 2 — re-baselined after slippage",
        "الخط المرجعي ٢ — إعادة التحديد بعد التأخر",
      ]),
      snapshot: snapshotOf(slipped.ok ? slipped : schedule),
      capturedAgo: b2Ago,
    },
  ];

  // ── canvas checkpoints ───────────────────────────────────────────────────
  const layout = () => ({
    nodes: nodes.map((n) => ({
      id: n.id,
      t: n.nodeType,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      p: n.parentNodeId,
      l: n.layerKey,
    })),
    edges: edges.map((e) => ({ id: e.id, s: e.source, t: e.target, k: e.edgeType })),
  });
  const versions: PlanModel["versions"] = [
    {
      id: ctx.id("studio", "version", p, 1),
      name: bi(rng, company, ["Initial layout", "التخطيط الأولي"]),
      snapshot: layout(),
      createdAgo: Math.max(0, createdAgo - 1),
    },
    {
      id: ctx.id("studio", "version", p, 2),
      name: bi(rng, company, ["After re-baseline", "بعد إعادة التحديد"]),
      snapshot: layout(),
      createdAgo: b2Ago,
    },
  ];

  // ── scenarios ────────────────────────────────────────────────────────────
  const scenarios: ScenarioSpec[] = [];
  const draftCandidates = nodes.filter(
    (n) =>
      !n.recordType &&
      activityById.has(n.id) &&
      (n.status === "active" || n.status === "proposed") &&
      n.durationDays !== null &&
      n.durationDays >= 2,
  );
  const scenarioBaseAgo = Math.max(0, Math.min(createdAgo, rng.int(3, 45)));
  let simulation: Record<string, unknown> = {};
  if (p <= 1) {
    const seed = rng.int(1, 2_147_483_646);
    const sim = simulateSchedule(cal, engineTasks, engineDeps, {
      samples: 100,
      seed,
      projectStart: anchor,
    });
    if (sim.ok) {
      const top = [...sim.criticality.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      simulation = {
        seed: sim.seed,
        samples: sim.samples,
        ranAt: clock.tsAgo(scenarioBaseAgo, 11),
        deterministicFinish: sim.deterministicFinish,
        finish: sim.finish,
        confidenceInDeterministic: sim.confidenceInDeterministic,
        criticality: Object.fromEntries(top),
        warnings: sim.warnings,
      };
    }
  }
  scenarios.push({
    id: ctx.id("studio", "scenario", p, 0),
    planId,
    name: bi(rng, company, [
      "What if we double-shift the critical phase?",
      "ماذا لو ضاعفنا الورديات في المرحلة الحرجة؟",
    ]),
    description: paragraph(rng, lang(rng, company), 2),
    isShared: true,
    assumptions: [
      {
        text: bi(rng, company, ASSUMPTIONS[0]!),
        confidence: "medium",
        owner: company.personas[2]!.fullName,
      },
      { text: bi(rng, company, ASSUMPTIONS[2]!), confidence: "low" },
    ],
    simulation,
    decision: {
      question: bi(rng, company, DECISIONS[1]!),
      recommendation: sentence(rng, lang(rng, company)),
    },
    baseCapturedAgo: scenarioBaseAgo,
    createdBy: users.manager,
    changes: [],
    transition: null,
  });
  if (draftCandidates.length >= 2) {
    const targets = [draftCandidates[0]!, draftCandidates[Math.floor(draftCandidates.length / 2)]!];
    const sid = ctx.id("studio", "scenario", p, 1);
    // A change that changes nothing would be noise in the overlay: always a real step.
    const raised: Record<Priority, Priority> = {
      low: "normal",
      normal: "high",
      high: "urgent",
      urgent: "high",
    };
    scenarios.push({
      id: sid,
      planId,
      name: bi(rng, company, [
        "Recovery plan — compress two activities",
        "خطة التعافي — ضغط نشاطين",
      ]),
      description: sentence(rng, lang(rng, company)),
      isShared: true,
      assumptions: [{ text: bi(rng, company, ASSUMPTIONS[1]!), confidence: "high" }],
      simulation: {},
      decision: {
        question: bi(rng, company, [
          "Can the finish be protected without extra cost?",
          "هل يمكن حماية موعد الانتهاء دون تكلفة إضافية؟",
        ]),
        recommendation: sentence(rng, lang(rng, company)),
        decision: bi(rng, company, [
          "Apply the compression and re-baseline",
          "تطبيق الضغط وإعادة تحديد الخط المرجعي",
        ]),
        rationale: sentence(rng, lang(rng, company)),
      },
      baseCapturedAgo: Math.max(0, scenarioBaseAgo - 2),
      createdBy: users.manager,
      changes: [
        {
          id: ctx.id("studio", "change", p, 1, 0),
          nodeId: targets[0]!.id,
          field: "durationDays",
          oldValue: targets[0]!.durationDays,
          newValue: Math.max(1, targets[0]!.durationDays! - 1),
        },
        {
          id: ctx.id("studio", "change", p, 1, 1),
          nodeId: targets[0]!.id,
          field: "priority",
          oldValue: targets[0]!.priority,
          newValue: raised[targets[0]!.priority],
        },
        {
          id: ctx.id("studio", "change", p, 1, 2),
          nodeId: targets[1]!.id,
          field: "durationDays",
          oldValue: targets[1]!.durationDays,
          newValue: Math.max(1, targets[1]!.durationDays! - 1),
        },
      ],
      transition: opts.archived ? null : "apply",
    });
  }
  // Every plan carries at least two scenarios (verify() holds the family to it):
  // a closed plan has no compressible activity left, so it gets the outsourcing
  // question instead of the recovery plan.
  if (p % 2 === 0 || scenarios.length < 2) {
    scenarios.push({
      id: ctx.id("studio", "scenario", p, 2),
      planId,
      name: bi(rng, company, [
        "Outsource the long-lead package",
        "إسناد حزمة المهلة الطويلة لطرف خارجي",
      ]),
      description: sentence(rng, lang(rng, company)),
      isShared: false,
      assumptions: [{ text: bi(rng, company, ASSUMPTIONS[3]!), confidence: "low" }],
      simulation: {},
      decision: {},
      baseCapturedAgo: Math.max(0, scenarioBaseAgo - 5),
      createdBy: users.owner,
      changes: [],
      transition: "discard",
    });
  }

  // ── saved views ──────────────────────────────────────────────────────────
  const viewSpecs: Array<[Bi, string, Record<string, unknown>, boolean, string]> = [
    [
      ["Gantt — critical path", "غانت — المسار الحرج"],
      "gantt",
      { view: "gantt", filters: { criticalOnly: true } },
      true,
      users.manager,
    ],
    [
      ["Board by status", "اللوحة حسب الحالة"],
      "board",
      { view: "board", filters: { statuses: ["active", "blocked", "done"] } },
      true,
      users.manager,
    ],
    [
      ["Dependency network", "شبكة الاعتماديات"],
      "network",
      { view: "network", viewport: { x: 120, y: 80, zoom: 0.6 } },
      false,
      users.owner,
    ],
    [
      ["Risk matrix", "مصفوفة المخاطر"],
      "risk_matrix",
      { view: "risk", filters: { types: ["risk", "issue"] } },
      true,
      users.owner,
    ],
    [
      ["Workload — my crew", "الأحمال — طاقمي"],
      "workload",
      { view: "workload", filters: { assigneeEmployeeId: linked.employees[0] ?? null } },
      false,
      users.hr,
    ],
    [
      ["Canvas", "اللوحة"],
      "canvas",
      { view: "canvas", viewport: { x: 0, y: 0, zoom: 0.45 } },
      false,
      users.manager,
    ],
  ];
  const viewCount = rng.int(3, 5);
  const views: PlanModel["views"] = viewSpecs
    .slice(0, viewCount)
    .map(([name, kind, config, shared, owner], i) => ({
      id: ctx.id("studio", "view", p, i),
      name: bi(rng, company, name),
      viewKind: kind,
      config,
      isShared: shared,
      ownerUserId: owner,
      createdAgo: Math.max(0, Math.min(createdAgo, rng.int(0, 60))),
    }));

  // ── canonical materialisation candidates (linked task → linked task) ─────
  const serviceEdges: ServiceEdge[] = [];
  if (!opts.archived) {
    for (const main of mains) {
      if (serviceEdges.length >= 4) break;
      const a = main[1];
      const b = main[3];
      if (
        a &&
        b &&
        a.recordType === "task" &&
        b.recordType === "task" &&
        a.recordId !== b.recordId
      ) {
        serviceEdges.push({
          planId,
          source: a.id,
          target: b.id,
          depKind: "finish_to_start",
          lagDays: 0,
        });
      }
    }
  }

  const planName =
    opts.kind === "wbs"
      ? bi(rng, company, [
          `Work breakdown — ${opts.job?.label ?? `project ${p}`}`,
          `هيكل تجزئة العمل — ${opts.job?.label ?? `المشروع ${p}`}`,
        ])
      : opts.kind === "strategy"
        ? bi(rng, company, [`Strategy board ${p}`, `لوحة الاستراتيجية ${p}`])
        : opts.flagship
          ? bi(rng, company, [
              "Programme board — all live projects",
              "لوحة البرنامج — جميع المشاريع الجارية",
            ])
          : bi(rng, company, [`Programme board ${p}`, `لوحة البرنامج ${p}`]);

  return {
    id: planId,
    index: p,
    kind: opts.kind,
    reference: `PLN-${String(p + 1).padStart(3, "0")}`,
    name: planName.slice(0, 200),
    status: opts.archived ? "archived" : "active",
    anchor,
    createdAgo,
    nodes,
    edges,
    scheduledIds,
    schedule,
    serviceEdges,
    scenarios,
    baselines,
    versions,
    views,
  };
}

// ── rows ─────────────────────────────────────────────────────────────────────

function toRows(ctx: LabContext, plans: PlanModel[]): Record<StudioTable, Row[]> {
  const { orgId, clock, users } = ctx;
  const ts = (ago: number, hour = 9) => clock.tsAgo(Math.max(0, ago), hour);
  const rows: Record<StudioTable, Row[]> = {
    studio_plan: [],
    studio_node: [],
    studio_edge: [],
    studio_baseline: [],
    studio_version: [],
    studio_scenario: [],
    studio_scenario_change: [],
    studio_view: [],
    reference_sequence: [],
  };
  for (const pl of plans) {
    const updatedAgo = Math.min(pl.createdAgo, ctx.rng.int(0, 20));
    rows.studio_plan.push({
      id: pl.id,
      org_id: orgId,
      reference: pl.reference,
      name: pl.name,
      description: paragraph(ctx.rng, lang(ctx.rng, ctx.company), 2),
      status: pl.status,
      settings: {
        defaultView: pl.kind === "strategy" ? "canvas" : "gantt",
        layers: ["structure", "schedule", "governance", "resources", "strategy", "canvas"],
      },
      row_version: 1,
      created_by: users.manager,
      updated_by: users.manager,
      created_at: ts(pl.createdAgo),
      updated_at: ts(updatedAgo, 14),
    });
    for (const n of pl.nodes) {
      rows.studio_node.push({
        id: n.id,
        org_id: orgId,
        plan_id: pl.id,
        node_type: n.nodeType,
        title: n.title,
        description: n.description,
        record_type: n.recordType,
        record_id: n.recordId,
        status: n.status,
        priority: n.priority,
        start_date: n.startDate,
        due_date: n.dueDate,
        duration_days: n.durationDays,
        progress_pct: n.progressPct,
        owner_user_id: n.ownerUserId,
        assignee_employee_id: n.assigneeEmployeeId,
        amount_minor: n.amountMinor,
        currency: n.currency,
        data: n.data,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        z: n.z,
        parent_node_id: n.parentNodeId,
        layer_key: n.layerKey,
        locked: n.locked,
        style: n.style,
        row_version: 1,
        archived_at: null,
        created_by: users.manager,
        updated_by: null,
        created_at: ts(n.createdAgo),
        updated_at: ts(n.createdAgo),
        constraint_kind: n.constraintKind,
        constraint_date: n.constraintDate,
        deadline_date: n.deadlineDate,
        estimate_optimistic_days: n.estimateOptimisticDays,
        estimate_pessimistic_days: n.estimatePessimisticDays,
      });
    }
    for (const e of pl.edges) {
      rows.studio_edge.push({
        id: e.id,
        org_id: orgId,
        plan_id: pl.id,
        source_node_id: e.source,
        target_node_id: e.target,
        edge_type: e.edgeType,
        dep_kind: e.depKind,
        lag_days: e.lagDays,
        task_dependency_id: null,
        label: e.label,
        style: {},
        waypoints: [],
        row_version: 1,
        created_by: users.manager,
        created_at: ts(e.createdAgo, 10),
        removed_at: null,
        removed_by: null,
      });
    }
    for (const b of pl.baselines) {
      rows.studio_baseline.push({
        id: b.id,
        org_id: orgId,
        plan_id: pl.id,
        name: b.name,
        snapshot: b.snapshot,
        captured_by: users.manager,
        captured_at: ts(b.capturedAgo, 16),
      });
    }
    for (const v of pl.versions) {
      rows.studio_version.push({
        id: v.id,
        org_id: orgId,
        plan_id: pl.id,
        name: v.name,
        snapshot: v.snapshot,
        created_by: users.manager,
        created_at: ts(v.createdAgo, 17),
      });
    }
    for (const s of pl.scenarios) {
      rows.studio_scenario.push({
        id: s.id,
        org_id: orgId,
        plan_id: pl.id,
        name: s.name,
        description: s.description,
        status: "draft",
        is_shared: s.isShared,
        assumptions: s.assumptions,
        simulation: s.simulation,
        decision: s.decision,
        base_captured_at: ts(s.baseCapturedAgo, 12),
        applied_at: null,
        applied_by: null,
        row_version: 1,
        created_by: s.createdBy,
        created_at: ts(s.baseCapturedAgo, 12),
        updated_at: ts(s.baseCapturedAgo, 12),
      });
      for (const c of s.changes) {
        rows.studio_scenario_change.push({
          id: c.id,
          org_id: orgId,
          scenario_id: s.id,
          target_kind: "node",
          target_id: c.nodeId,
          record_type: null,
          field: c.field,
          old_value: c.oldValue,
          new_value: c.newValue,
          created_by: s.createdBy,
          created_at: ts(s.baseCapturedAgo, 13),
          updated_at: ts(s.baseCapturedAgo, 13),
        });
      }
    }
    for (const v of pl.views) {
      rows.studio_view.push({
        id: v.id,
        org_id: orgId,
        plan_id: pl.id,
        name: v.name,
        view_kind: v.viewKind,
        config: v.config,
        is_shared: v.isShared,
        owner_user_id: v.ownerUserId,
        created_at: ts(v.createdAgo, 15),
        updated_at: ts(v.createdAgo, 15),
        removed_at: null,
      });
    }
  }
  // The UI allocates PLN-nnn from this counter; move it past the seeded references.
  rows.reference_sequence.push({
    org_id: orgId,
    scope_key: "studio_plan",
    next_value: plans.length + 1,
  });
  return rows;
}

// ── the model, memoised per context so plan() and seed() agree ──────────────

const MODELS = new WeakMap<LabContext, StudioModel>();

export function buildStudioModel(ctx: LabContext): StudioModel {
  const cached = MODELS.get(ctx);
  if (cached) return cached;
  const { rng, company } = ctx;
  const P = Math.max(1, company.profile.studioPlans);
  const linked = readLinkedRecords(ctx);

  // Sizes: 60–250 per plan, the flagship past 300; anchors spread over the history.
  const sizes = Array.from({ length: P }, (_, i) => (i === 0 ? 330 : rng.int(60, 250)));
  const spread = spreadDates(rng, company, P);
  const anchors = spread.map((d, i) => (i === 0 ? 160 : d));
  if (P >= 4) anchors[P - 1] = -21; // one plan that has not started yet
  const archived = anchors.map((a, i) => i !== 0 && a > 400 && rng.chance(0.7));
  if (P >= 3 && !archived.some(Boolean)) {
    const oldest = anchors.reduce((best, a, i) => (i !== 0 && a > anchors[best]! ? i : best), 1);
    archived[oldest] = true;
  }
  const kinds: PlanKind[] = Array.from({ length: P }, (_, i) =>
    i === 0 ? "programme" : i % 4 === 3 ? "strategy" : i % 4 === 2 ? "programme" : "wbs",
  );

  const plans: PlanModel[] = [];
  let wbsIndex = 0;
  for (let i = 0; i < P; i++) {
    const kind = kinds[i]!;
    const job =
      kind === "wbs" && linked.jobs.length ? linked.jobs[wbsIndex++ % linked.jobs.length]! : null;
    plans.push(
      buildPlan(ctx, linked, {
        index: i,
        kind,
        size: sizes[i]!,
        flagship: i === 0,
        anchorDaysAgo: anchors[i]!,
        archived: archived[i]!,
        job,
      }),
    );
  }
  const rows = toRows(ctx, plans);
  const materialised = plans.reduce((n, pl) => n + pl.serviceEdges.length, 0);
  const applied = plans.reduce(
    (n, pl) => n + pl.scenarios.filter((s) => s.transition === "apply").length,
    0,
  );
  const model: StudioModel = {
    plans,
    rows,
    serviceRows: { studio_edge: materialised, task_dependency: materialised, approval: applied },
    linked,
  };
  MODELS.set(ctx, model);
  return model;
}

/** Kahn over dependency edges; returns the ids left in a cycle (empty = acyclic). */
export function cycleIn(edges: Array<{ source: string; target: string }>): string[] {
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const e of edges) {
    indeg.set(e.source, indeg.get(e.source) ?? 0);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    succ.set(e.source, [...(succ.get(e.source) ?? []), e.target]);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const t of succ.get(id) ?? []) {
      const left = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, left);
      if (left === 0) queue.push(t);
    }
  }
  return seen === indeg.size ? [] : [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id);
}

// ── the family ───────────────────────────────────────────────────────────────

export const studio: Family = {
  key: "studio",
  deps: ["setup", "people", "work"],
  appliesTo: (company) => company.profile.enables.studio,

  plan(ctx): FamilyPlan {
    const m = buildStudioModel(ctx);
    const expected: Record<string, number> = {};
    for (const t of STUDIO_TABLES) expected[t] = m.rows[t].length;
    if (servicesEnabled) {
      expected.studio_edge = (expected.studio_edge ?? 0) + m.serviceRows.studio_edge;
      expected.task_dependency = m.serviceRows.task_dependency;
      expected.approval = m.serviceRows.approval;
    }
    return { family: "studio", expected };
  },

  async seed(ctx): Promise<FamilyReport> {
    const m = buildStudioModel(ctx);
    const counts: Record<string, number> = {};
    const notes: string[] = [];
    for (const t of STUDIO_TABLES) {
      if (m.rows[t].length === 0) continue;
      const conflict =
        t === "reference_sequence"
          ? "on conflict (org_id, scope_key) do update set next_value = greatest(reference_sequence.next_value, excluded.next_value)"
          : undefined;
      const res = await ctx.insert(t, m.rows[t], conflict);
      counts[t] = res.attempted;
      ctx.log(`${t}: ${res.attempted} rows`);
    }

    // ── lifecycle through the real services (never in a dry run) ────────────
    if (servicesEnabled && !ctx.dryRun) {
      const [{ submitScenario, applyScenario, discardScenario }, { decideApproval }, { addEdge }] =
        await Promise.all([
          import("@/modules/studio/scenarios"),
          import("@/modules/approvals/service"),
          import("@/modules/studio/graph"),
        ]);
      const manager = ctx.ctxFor("manager");
      const owner = ctx.ctxFor("owner");
      const mArch = ctx.archetypeOf("manager");
      const oArch = ctx.archetypeOf("owner");
      let applied = 0;
      let discarded = 0;
      let approvals = 0;
      let materialised = 0;
      const failures: string[] = [];
      for (const pl of m.plans) {
        for (const s of pl.scenarios) {
          try {
            if (s.transition === "apply") {
              const sub = await submitScenario(manager, mArch, { scenarioId: s.id });
              approvals++;
              if (!sub.approvalId) throw new Error("no approval created");
              await decideApproval(owner, oArch, {
                approvalId: sub.approvalId,
                decision: "approved",
              });
              await applyScenario(owner, oArch, { scenarioId: s.id });
              applied++;
            } else if (s.transition === "discard") {
              await discardScenario(manager, mArch, { scenarioId: s.id });
              discarded++;
            }
          } catch (e) {
            failures.push(`${pl.reference}/${s.transition}: ${(e as Error).message}`);
          }
        }
        for (const se of pl.serviceEdges) {
          try {
            await addEdge(manager, mArch, {
              planId: se.planId,
              sourceNodeId: se.source,
              targetNodeId: se.target,
              edgeType: "dependency",
              depKind: se.depKind,
              lagDays: se.lagDays,
            });
            materialised++;
          } catch (e) {
            failures.push(`${pl.reference}/edge: ${(e as Error).message}`);
          }
        }
      }
      counts.studio_edge = (counts.studio_edge ?? 0) + materialised;
      counts.task_dependency = materialised;
      counts.approval = approvals;
      notes.push(
        `scenarios applied ${applied}, discarded ${discarded}; dependencies materialised ${materialised}`,
      );
      if (failures.length)
        notes.push(
          `service transitions skipped: ${failures.slice(0, 5).join(" | ")}${failures.length > 5 ? ` (+${failures.length - 5})` : ""}`,
        );
      ctx.log(notes.join("; "));
    }

    return {
      family: "studio",
      counts,
      handoff: {
        planIds: m.plans.map((p) => p.id),
        flagshipPlanId: m.plans[0]?.id ?? null,
        planByJobId: Object.fromEntries(
          m.plans
            .filter((p) => p.kind === "wbs")
            .flatMap((p) => {
              const root = p.nodes[0];
              return root?.recordType === "job" && root.recordId ? [[root.recordId, p.id]] : [];
            }),
        ),
        appliedScenarioIds: m.plans.flatMap((p) =>
          p.scenarios.filter((s) => s.transition === "apply").map((s) => s.id),
        ),
      },
      notes,
    };
  },

  async verify(ctx): Promise<Check[]> {
    const m = buildStudioModel(ctx);
    const sql = ctx.sql;
    const org = ctx.orgId;
    const checks: Check[] = [];
    const one = async <T>(q: Promise<unknown>): Promise<T> => ((await q) as unknown as T[])[0]!;

    // counts vs plan
    for (const t of STUDIO_TABLES) {
      if (t === "reference_sequence") continue;
      const r = await one<{ n: number }>(
        sql.unsafe(`select count(*)::int as n from public.${t} where org_id = $1`, [org]),
      );
      const expected = m.rows[t].length;
      const ok =
        t === "studio_edge"
          ? r.n >= expected && r.n <= expected + m.serviceRows.studio_edge
          : r.n === expected;
      checks.push({
        name: `${t} count matches plan`,
        ok,
        detail: `${r.n} live vs ${expected} planned${t === "studio_edge" ? ` (+≤${m.serviceRows.studio_edge} materialised)` : ""}`,
      });
    }
    const seq = await one<{ n: number | null }>(
      sql`select max(next_value)::int as n from public.reference_sequence where org_id = ${org} and scope_key = 'studio_plan'`,
    );
    checks.push({
      name: "PLN reference counter sits past the seeded plans",
      ok: (seq.n ?? 0) >= m.plans.length + 1,
      detail: `next_value ${seq.n}`,
    });

    // every edge points at two live nodes of its own plan
    const dangling = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_edge e
      left join public.studio_node s on s.id = e.source_node_id and s.org_id = e.org_id and s.plan_id = e.plan_id
      left join public.studio_node t on t.id = e.target_node_id and t.org_id = e.org_id and t.plan_id = e.plan_id
      where e.org_id = ${org} and e.removed_at is null and (s.id is null or t.id is null)`);
    checks.push({
      name: "no edge references a missing node",
      ok: dangling.n === 0,
      detail: `${dangling.n} dangling`,
    });

    // parents are nodes of the same plan
    const badParents = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_node n
      left join public.studio_node p on p.id = n.parent_node_id and p.org_id = n.org_id and p.plan_id = n.plan_id
      where n.org_id = ${org} and n.parent_node_id is not null and p.id is null`);
    checks.push({
      name: "parent hierarchy resolves inside each plan",
      ok: badParents.n === 0,
      detail: `${badParents.n} orphans`,
    });

    // no cycles in dependency logic, per plan
    const deps = (await sql`
      select plan_id::text as plan_id, source_node_id::text as source, target_node_id::text as target
      from public.studio_edge where org_id = ${org} and edge_type = 'dependency' and removed_at is null`) as unknown as Array<{
      plan_id: string;
      source: string;
      target: string;
    }>;
    const byPlan = new Map<string, Array<{ source: string; target: string }>>();
    for (const d of deps) byPlan.set(d.plan_id, [...(byPlan.get(d.plan_id) ?? []), d]);
    const cyclic = [...byPlan.entries()]
      .filter(([, es]) => cycleIn(es).length > 0)
      .map(([id]) => id);
    checks.push({
      name: "no cycles in dependency edges (FS/SS/FF)",
      ok: cyclic.length === 0,
      detail: `${deps.length} dependency edges across ${byPlan.size} plans${cyclic.length ? `; cycles in ${cyclic.join(", ")}` : ""}`,
    });

    // baseline snapshot size == nodes the engine schedules at capture
    const baselines = (await sql`
      select b.plan_id::text as plan_id, b.name, jsonb_array_length(b.snapshot)::int as entries,
        (select count(*)::int from public.studio_node n
          where n.org_id = b.org_id and n.plan_id = b.plan_id and n.archived_at is null and n.status <> 'dropped'
            and n.node_type in ('task','milestone','deliverable','phase','project','initiative','action')
            and (n.node_type = 'milestone' or n.duration_days is not null or (n.start_date is not null and n.due_date is not null))) as schedulable
      from public.studio_baseline b where b.org_id = ${org}`) as unknown as Array<{
      plan_id: string;
      name: string;
      entries: number;
      schedulable: number;
    }>;
    const badBaselines = baselines.filter((b) => b.entries !== b.schedulable);
    checks.push({
      name: "baseline snapshot node count == schedulable nodes at capture",
      ok: baselines.length > 0 && badBaselines.length === 0,
      detail: `${baselines.length} baselines${
        badBaselines.length
          ? `; mismatched: ${badBaselines
              .map((b) => `${b.name} ${b.entries}/${b.schedulable}`)
              .slice(0, 3)
              .join(", ")}`
          : ""
      }`,
    });
    const perPlan = await one<{ min_b: number; min_s: number; min_v: number }>(sql`
      select min(b.n)::int as min_b, min(s.n)::int as min_s, min(v.n)::int as min_v from public.studio_plan p
      left join (select plan_id, count(*) n from public.studio_baseline where org_id = ${org} group by plan_id) b on b.plan_id = p.id
      left join (select plan_id, count(*) n from public.studio_scenario where org_id = ${org} group by plan_id) s on s.plan_id = p.id
      left join (select plan_id, count(*) n from public.studio_view where org_id = ${org} and removed_at is null group by plan_id) v on v.plan_id = p.id
      where p.org_id = ${org}`);
    checks.push({
      name: "every plan has ≥ 2 baselines, ≥ 2 scenarios, ≥ 3 views",
      ok: (perPlan.min_b ?? 0) >= 2 && (perPlan.min_s ?? 0) >= 2 && (perPlan.min_v ?? 0) >= 3,
      detail: `min baselines ${perPlan.min_b}, scenarios ${perPlan.min_s}, views ${perPlan.min_v}`,
    });

    // navigation thresholds
    const big = await one<{ nodes: number; edges: number }>(sql`
      select max(n.c)::int as nodes, max(e.c)::int as edges from public.studio_plan p
      left join (select plan_id, count(*) c from public.studio_node where org_id = ${org} and archived_at is null group by plan_id) n on n.plan_id = p.id
      left join (select plan_id, count(*) c from public.studio_edge where org_id = ${org} and removed_at is null group by plan_id) e on e.plan_id = p.id
      where p.org_id = ${org}`);
    checks.push({
      name: "a plan crosses 300 nodes and 400 edges",
      ok: big.nodes > 300 && big.edges > 400,
      detail: `largest plan ${big.nodes} nodes / ${big.edges} edges`,
    });
    const totalNodes = m.rows.studio_node.length;
    if (totalNodes > 1205) {
      const n = await one<{ n: number }>(
        sql`select count(*)::int as n from public.studio_node where org_id = ${org}`,
      );
      checks.push({
        name: "studio nodes exceed the 1,205 pagination threshold",
        ok: n.n > 1205,
        detail: `${n.n} nodes`,
      });
    }

    // lifecycle: applied scenarios really changed the live plan
    const expectedApplied = m.plans.flatMap((p) =>
      p.scenarios.filter((s) => s.transition === "apply"),
    ).length;
    const applied = await one<{ n: number; bad: number }>(sql`
      select count(*)::int as n,
        count(*) filter (where s.applied_at is null or s.applied_by is null)::int as bad
      from public.studio_scenario s where s.org_id = ${org} and s.status = 'applied'`);
    checks.push({
      name: "scenarios applied through the service",
      ok: applied.n >= expectedApplied && applied.bad === 0,
      detail: `${applied.n} applied of ${expectedApplied} planned; ${applied.bad} without applied_at/by`,
    });
    const replayed = await one<{ n: number; drift: number }>(sql`
      select count(*)::int as n,
        count(*) filter (where c.field = 'durationDays' and (n.duration_days::text)::jsonb <> c.new_value)::int as drift
      from public.studio_scenario_change c
      join public.studio_scenario s on s.id = c.scenario_id and s.org_id = c.org_id and s.status = 'applied'
      join public.studio_node n on n.id = c.target_id and n.org_id = c.org_id
      where c.org_id = ${org} and c.target_kind = 'node'`);
    checks.push({
      name: "applied changes are the live values",
      ok: replayed.drift === 0,
      detail: `${replayed.n} applied changes, ${replayed.drift} not reflected`,
    });
    const forbidden = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_scenario where org_id = ${org}
        and ((status = 'applied') <> (applied_at is not null))`);
    checks.push({ name: "scenario applied flag agrees with applied_at", ok: forbidden.n === 0 });
    const statusMix = await one<{ kinds: number }>(
      sql`select count(distinct status)::int as kinds from public.studio_scenario where org_id = ${org}`,
    );
    checks.push({
      name: "scenario statuses are mixed (draft/applied/discarded…)",
      ok: statusMix.kinds >= 2,
      detail: `${statusMix.kinds} distinct statuses`,
    });

    // canonical links resolve
    const links = await one<{ jobs: number; tasks: number; emps: number }>(sql`
      select count(*) filter (where n.record_type = 'job' and j.id is null)::int as jobs,
             count(*) filter (where n.record_type = 'task' and t.id is null)::int as tasks,
             count(*) filter (where n.record_type = 'employee' and e.id is null)::int as emps
      from public.studio_node n
      left join public.job j on j.id = n.record_id and j.org_id = n.org_id
      left join public.task t on t.id = n.record_id and t.org_id = n.org_id
      left join public.employee e on e.id = n.record_id and e.org_id = n.org_id
      where n.org_id = ${org} and n.record_type is not null`);
    checks.push({
      name: "linked nodes resolve to real jobs/tasks/employees",
      ok: links.jobs + links.tasks + links.emps === 0,
      detail: `missing: ${links.jobs} jobs, ${links.tasks} tasks, ${links.emps} employees`,
    });
    const linkedCount = await one<{ n: number }>(
      sql`select count(*)::int as n from public.studio_node where org_id = ${org} and record_type is not null`,
    );
    checks.push({
      name: "plans link canonical records",
      ok: linkedCount.n > 0 || (m.linked.jobs.length === 0 && m.linked.employees.length === 0),
      detail: `${linkedCount.n} linked nodes`,
    });
    const mat = await one<{ n: number; missing: number }>(sql`
      select count(*)::int as n, count(*) filter (where d.id is null or d.removed_at is not null)::int as missing
      from public.studio_edge e left join public.task_dependency d on d.id = e.task_dependency_id and d.org_id = e.org_id
      where e.org_id = ${org} and e.task_dependency_id is not null`);
    checks.push({
      name: "materialised dependencies cite live task_dependency rows",
      ok: mat.missing === 0 && (mat.n > 0 || m.serviceRows.studio_edge === 0),
      detail: `${mat.n} materialised of ${m.serviceRows.studio_edge} attempted, ${mat.missing} dangling`,
    });

    // realism: conflicts and delays
    const conflicts = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_node a join public.studio_node b
        on b.org_id = a.org_id and b.plan_id = a.plan_id and b.assignee_employee_id = a.assignee_employee_id and b.id > a.id
      where a.org_id = ${org} and a.assignee_employee_id is not null and a.start_date is not null and b.start_date is not null
        and a.start_date <= b.due_date and b.start_date <= a.due_date and a.status <> 'dropped' and b.status <> 'dropped'`);
    checks.push({
      name: "resource conflicts exist (same assignee, overlapping dates)",
      ok: conflicts.n >= m.plans.length || m.linked.employees.length === 0,
      detail: `${conflicts.n} overlapping pairs`,
    });
    const delays = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_node where org_id = ${org} and status = 'active'
        and due_date < ${ctx.clock.asOf}::date and progress_pct < 100`);
    checks.push({
      name: "delays exist (progress behind the dates)",
      ok: delays.n > 0,
      detail: `${delays.n} activities behind`,
    });
    const invalid = await one<{ n: number }>(sql`
      select count(*)::int as n from public.studio_edge where org_id = ${org}
        and ((edge_type = 'dependency') <> (dep_kind is not null) or source_node_id = target_node_id)`);
    checks.push({ name: "dependency edges carry a kind; no self-loops", ok: invalid.n === 0 });
    return checks;
  },
};
