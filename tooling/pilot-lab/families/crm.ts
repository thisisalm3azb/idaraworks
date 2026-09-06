/**
 * H33 Pilot Lab — crm: the Revenue Studio's depth.
 *
 * Leads, opportunities (open / won / lost with the evidence each state needs),
 * their commercial context (products, stakeholders, risks, competitors,
 * discounts, deal canvases), the activity history behind them, campaigns and
 * attribution touches, territories and dated targets, monthly forecast
 * snapshots that reconcile with the opportunities they froze, saved scenarios,
 * governed automations with an execution history, customer-success signals and
 * one reviewed customer merge.
 *
 * Shape: `model()` draws every random choice ONCE from ctx.rng into a pure
 * in-memory model (memoised per context, so plan and seed see the same
 * numbers). Customers, items and pipeline stages are resolved from the setup
 * and masters handoffs inside the model, so the plan is exact without a
 * database. `materialize()` resolves the only live references (contacts for
 * activities and stakeholders, the merged customers' row images) without
 * drawing anything more. `seed()` inserts in batches and then drives a small
 * representative subset through the product's own services (win, lose,
 * governed stage move, safe lead conversion) so those rows are
 * indistinguishable from application writes. No automation is ever invoked,
 * nothing is sent, and no state the database would refuse is written by hand —
 * the CRM tables carry check constraints, not state-machine triggers, so bulk
 * rows are inserted in fully legal, reconciling states.
 */
import type { Ctx } from "@/platform/tenancy";
import { withCtx } from "@/platform/tenancy";
import { computeLine } from "@/modules/crm/dealroom";
import { convertLeadSafely } from "@/modules/crm/leads";
import { ensurePipelinesIn, moveStage } from "@/modules/crm/pipelines";
import { loseOpportunity, winOpportunity } from "@/modules/crm/sales";
import type { Rng } from "../../simulation/rng";
import type { Check, Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import {
  companyName,
  doneByAge,
  email,
  longTitle,
  paragraph,
  personName,
  phone,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  weighted,
} from "./_shared";

// ── constants ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type OwnerKey = "manager" | "owner" | "finance" | "admin";
const OWNER_WEIGHTS: Record<OwnerKey, number> = { manager: 5, owner: 2, finance: 1, admin: 1 };
const OWNER_KEYS: OwnerKey[] = ["manager", "owner", "finance", "admin"];

/** The representative subset driven through the product's own services (not dry-run). */
export const SERVICE_SUBSET = { win: 6, lose: 6, move: 6, convert: 4 } as const;

export const CRM_TABLES = [
  "crm_territory",
  "crm_campaign",
  "lead",
  "opportunity",
  "sales_activity",
  "crm_opportunity_product",
  "crm_opportunity_stakeholder",
  "crm_opportunity_competitor",
  "crm_opportunity_risk",
  "crm_discount",
  "crm_deal_canvas",
  "crm_touch",
  "crm_target",
  "crm_forecast_snapshot",
  "crm_scenario",
  "crm_automation",
  "crm_automation_run",
  "crm_customer_signal",
  "crm_merge",
] as const;
export type CrmTable = (typeof CRM_TABLES)[number];

const FORECAST_MODEL = "value × probability (opportunity, else stage default)";
export const SNAPSHOT_MONTHS = 24;
const TARGET_QUARTERS = 8;
const LOSS_REASONS = [
  "price",
  "timing",
  "competitor",
  "no_budget",
  "no_response",
  "scope",
  "other",
] as const;
const DISQUALIFY_REASONS = [
  "no_budget",
  "no_need",
  "no_authority",
  "timing",
  "competitor",
  "unresponsive",
  "spam",
  "duplicate",
  "other",
] as const;
const ROLE_KINDS = [
  "decision_maker",
  "economic_buyer",
  "influencer",
  "champion",
  "user",
  "procurement",
  "finance",
  "technical",
  "blocker",
  "other",
] as const;

/** Lead sources: label → source_kind (the kind decides quarantine for untrusted captures). */
const LEAD_SOURCES: Array<[string, string, string]> = [
  ["Website form", "نموذج الموقع", "form"],
  ["Trade show", "معرض تجاري", "manual"],
  ["Referral", "إحالة", "referral"],
  ["LinkedIn", "لينكدإن", "manual"],
  ["Cold call", "اتصال مباشر", "manual"],
  ["Google Ads", "إعلانات جوجل", "campaign"],
  ["WhatsApp", "واتساب", "messaging"],
  ["Imported list", "قائمة مستوردة", "import"],
  ["Existing customer", "عميل حالي", "customer"],
  ["Email enquiry", "استفسار بالبريد", "email"],
  ["Partner API", "واجهة شريك", "api"],
];

const SCOPES: Record<string, Array<[string, string]>> = {
  gulfbuild: [
    ["Villa MEP fit-out", "تجهيزات ميكانيكية وكهربائية لفيلا"],
    ["Warehouse steel structure", "هيكل فولاذي لمستودع"],
    ["Road resurfacing package", "حزمة إعادة رصف طريق"],
    ["Office tower façade works", "أعمال واجهة برج مكتبي"],
    ["School extension works", "أعمال توسعة مدرسة"],
    ["Mosque interior finishes", "تشطيبات داخلية لمسجد"],
    ["Substation civil works", "أعمال مدنية لمحطة فرعية"],
  ],
  tradeline: [
    ["Annual supply agreement", "اتفاقية توريد سنوية"],
    ["Pallet racking order", "طلب أرفف منصات"],
    ["Seasonal stock replenishment", "تجديد المخزون الموسمي"],
    ["Distribution contract", "عقد توزيع"],
    ["Packaging materials tender", "مناقصة مواد تغليف"],
    ["Cold-chain consumables", "مستهلكات سلسلة التبريد"],
  ],
  saudimfg: [
    ["Precision parts batch", "دفعة قطع دقيقة"],
    ["CNC machining contract", "عقد تشغيل CNC"],
    ["Pressure vessel fabrication", "تصنيع أوعية ضغط"],
    ["Tooling and jigs", "عدد وقوالب"],
    ["Assembly line spares", "قطع غيار خط التجميع"],
    ["Stainless enclosure order", "طلب صناديق فولاذ مقاوم"],
  ],
  consult: [
    ["Advisory engagement", "مهمة استشارية"],
    ["Feasibility study", "دراسة جدوى"],
    ["Operations review", "مراجعة العمليات"],
    ["Digital transformation roadmap", "خارطة طريق التحول الرقمي"],
    ["Compliance audit", "تدقيق الامتثال"],
    ["Cost optimisation programme", "برنامج تحسين التكاليف"],
    ["Board strategy workshop", "ورشة استراتيجية لمجلس الإدارة"],
  ],
  facilico: [
    ["Annual maintenance contract", "عقد صيانة سنوي"],
    ["HVAC servicing", "صيانة التكييف"],
    ["Cleaning and janitorial services", "خدمات النظافة"],
    ["Fire system inspection", "فحص أنظمة الحريق"],
    ["Landscaping contract", "عقد تنسيق حدائق"],
    ["Lift maintenance", "صيانة المصاعد"],
  ],
};

const ACTIVITY_TITLES: Record<string, Array<[string, string, string | null]>> = {
  call: [
    ["Discovery call", "مكالمة استكشاف", "discovery_call"],
    ["Check-in", "متابعة", "check_in"],
    ["Pricing discussion", "مناقشة الأسعار", null],
  ],
  email: [
    ["Proposal sent", "إرسال العرض", null],
    ["Follow-up email", "بريد متابعة", null],
    ["Clarifications requested", "طلب توضيحات", null],
  ],
  meeting: [
    ["Proposal walkthrough", "استعراض العرض", "proposal_walkthrough"],
    ["Kick-off planning", "تخطيط الانطلاق", null],
    ["Negotiation meeting", "اجتماع تفاوض", null],
  ],
  task: [
    ["Prepare revised quotation", "إعداد عرض سعر معدل", null],
    ["Send references", "إرسال المراجع", null],
    ["Update bill of quantities", "تحديث جدول الكميات", null],
  ],
  note: [["Internal note", "ملاحظة داخلية", null]],
  follow_up: [["Follow up on proposal", "متابعة العرض", null]],
  site_visit: [["Site survey", "معاينة الموقع", "site_survey"]],
  demo: [["Demonstration", "عرض توضيحي", "demo"]],
  message: [["WhatsApp update", "تحديث عبر واتساب", null]],
};
const ENGAGEMENT_KINDS = new Set(["call", "email", "meeting", "site_visit", "demo", "message"]);
const OUTCOMES = ["completed", "positive", "neutral", "negative", "no_answer", "rescheduled"];

const COMPETITORS = [
  "Northwind Works (fictional)",
  "Blue Dune Systems (fictional)",
  "Sahara Bridge Co. (fictional)",
  "Falcon Peak Trading (fictional)",
  "Ivory Gate Services (fictional)",
];
const RISK_TITLES: Array<[string, string]> = [
  ["Budget approval pending at client board", "اعتماد الميزانية معلق لدى مجلس العميل"],
  ["Site access depends on the main contractor", "الوصول للموقع يعتمد على المقاول الرئيسي"],
  ["Competitor undercutting on price", "منافس يخفض السعر"],
  ["Specification not yet frozen", "المواصفات لم تُثبّت بعد"],
  ["Payment terms exceed policy", "شروط الدفع تتجاوز السياسة"],
];
const CUSTOMER_TAGS = ["vip", "government", "sme", "enterprise", "renewal"];

/** The setup family names its pipelines by key; the product's kind for each. */
const PIPELINE_KIND_BY_KEY: Record<string, PipelineRef["kind"]> = {
  default: "new_business",
  renewals: "renewal",
  expansion: "expansion",
};

// ── time helpers (pure, UTC) ────────────────────────────────────────────────

function monthKey(asOf: string, back: number): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7)) - 1 - back;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}
function monthEnd(key: string): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(d).padStart(2, "0")}`;
}
function quarterOfMonth(key: string): { y: number; q: number } {
  return { y: Number(key.slice(0, 4)), q: Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1 };
}
function quarterBounds(y: number, q: number): { key: string; start: string; end: string } {
  const first = (q - 1) * 3 + 1;
  const start = `${y}-${String(first).padStart(2, "0")}-01`;
  const end = monthEnd(`${y}-${String(first + 2).padStart(2, "0")}`);
  return { key: `${y}-Q${q}`, start, end };
}
function lastQuarters(asOf: string, n: number): Array<{ key: string; start: string; end: string }> {
  const out: Array<{ key: string; start: string; end: string }> = [];
  let { y, q } = quarterOfMonth(asOf.slice(0, 7));
  for (let i = 0; i < n; i++) {
    out.push(quarterBounds(y, q));
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out.reverse();
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function roundToMajorThousand(minor: number): number {
  return Math.max(100_000, Math.round(minor / 100_000) * 100_000);
}

// ── references written by earlier families (from their handoffs; pure) ──────

export type PipelineRef = {
  key: string;
  id: string;
  kind: "new_business" | "expansion" | "renewal" | "custom";
  /** Open stage keys in board order, then the terminal keys. */
  open: string[];
  won: string;
  lost: string;
};

export type Refs = {
  /** The default pipeline first. */
  pipelines: PipelineRef[];
  customers: {
    /** Ordinal-ordered customer ids, exactly as the masters family wrote them. */
    ids: string[];
    active: Set<string>;
    /** Active ordinals the model may reference — never the merge source. */
    pool: number[];
    mergeSourceOrd: number;
    mergeTargetOrd: number;
  };
  items: Array<{ id: string; unit: string }>;
};

type SetupHandoffLite = {
  pipelines?: Record<
    string,
    { id: string; stages: Record<string, { id: string; category: string }> }
  >;
};
type MastersHandoffLite = {
  customerIds?: string[];
  inactiveCustomerIds?: string[];
  itemIds?: string[];
  items?: Record<string, { unit?: string }>;
};

/** Resolve what setup and masters wrote from their handoffs — no database, exact for the plan. */
export function refsFromHandoffs(ctx: LabContext): Refs {
  const setup = ctx.handoff<SetupHandoffLite>("setup");
  const masters = ctx.handoff<MastersHandoffLite>("masters");

  const pipelines: PipelineRef[] = Object.entries(setup.pipelines ?? {}).map(([key, p]) => {
    const stages = Object.entries(p.stages);
    const open = stages.filter(([, s]) => s.category === "open").map(([k]) => k);
    const won = stages.find(([, s]) => s.category === "won")?.[0];
    const lost = stages.find(([, s]) => s.category === "lost")?.[0];
    if (open.length === 0 || !won || !lost)
      throw new Error(`crm: pipeline ${key} lacks an open, won or lost stage`);
    return { key, id: p.id, kind: PIPELINE_KIND_BY_KEY[key] ?? "custom", open, won, lost };
  });
  if (pipelines.length === 0) throw new Error("crm: the setup handoff carries no pipelines");
  pipelines.sort((a, b) => (a.key === "default" ? -1 : b.key === "default" ? 1 : 0));

  const ids = masters.customerIds ?? [];
  if (ids.length === 0) throw new Error("crm: the masters handoff carries no customers");
  const inactive = new Set(masters.inactiveCustomerIds ?? []);
  const active = new Set(ids.filter((id) => !inactive.has(id)));
  const activeOrds = ids.map((_, i) => i).filter((i) => active.has(ids[i]!));
  if (activeOrds.length < 3) throw new Error("crm: fewer than three active customers to work with");
  const mergeSourceOrd = activeOrds[activeOrds.length - 1]!;
  const mergeTargetOrd = activeOrds[activeOrds.length - 2]!;
  const pool = activeOrds.slice(0, -1);

  const itemIds = masters.itemIds ?? [];
  const items = itemIds.slice(0, 400).map((id) => {
    const unit = String(masters.items?.[id]?.unit ?? "ea").slice(0, 16) || "ea";
    return { id, unit };
  });

  return { pipelines, customers: { ids, active, pool, mergeSourceOrd, mergeTargetOrd }, items };
}

// ── the model ───────────────────────────────────────────────────────────────

type LeadM = {
  i: number;
  id: string;
  name: string;
  lang: "en" | "ar";
  status: "new" | "contacted" | "qualified" | "disqualified" | "converted";
  createdDaysAgo: number;
  createdAt: string;
  ownerKey: OwnerKey | null;
  campaignIdx: number | null;
  territoryIdx: number | null;
  valueMinor: number | null;
  convertedAt: string | null;
  oppIdx: number | null;
  serviceConvert: boolean;
  customerId: string | null;
};

type OppM = {
  i: number;
  id: string;
  name: string;
  lang: "en" | "ar";
  status: "open" | "won" | "lost";
  /** Status the row is INSERTED with (service subsets are born open). */
  bornStatus: "open" | "won" | "lost";
  createdDaysAgo: number;
  createdAt: string;
  closedDaysAgo: number | null;
  closedAt: string | null;
  customerId: string | null;
  leadIdx: number | null;
  ownerKey: OwnerKey;
  pipeline: PipelineRef;
  /** Index into pipeline.open for open rows; the stage the row is inserted with. */
  stageIdx: number;
  stageKey: string;
  valueMinor: number | null;
  probability: number;
  closeDate: string | null;
  category: "pipeline" | "best_case" | "commit" | "omitted";
  kind: "new_business" | "expansion" | "renewal";
  archived: boolean;
  campaignIdx: number | null;
  territoryIdx: number | null;
  lossReason: (typeof LOSS_REASONS)[number] | null;
  stalled: boolean;
  activityEndDaysAgo: number;
  lastActivityAt: string | null;
  service: "win" | "lose" | "move" | null;
  moveToKey: string | null;
  lossNote: string | null;
};

type ConvertM = {
  lead: LeadM;
  name: string;
  customerId: string;
  valueMinor: number;
  closeDate: string;
};

export type Model = {
  company: Company;
  orgId: string;
  users: Record<OwnerKey, string>;
  currency: string;
  refs: Refs;
  territoryIds: string[];
  campaignIds: string[];
  automationIds: string[];
  leads: LeadM[];
  opps: OppM[];
  /** Rows per table, in insert order; `$…` keys are resolved by materialize(). */
  tables: Record<CrmTable, Row[]>;
  convert: ConvertM[];
  /** What the service subset will attempt — the model's actual picks, not the caps. */
  services: { win: number; lose: number; move: number; convert: number };
  expectedWonMinor: number;
  expectedWonCount: number;
  /** Open pipeline after the services ran: bulk open rows plus the converted leads. */
  expectedOpenCount: number;
  expectedOpenMinor: number;
  merge: { sourceId: string; targetId: string };
};

const MODEL_CACHE = new WeakMap<LabContext, Model>();

function valueRange(company: Company): [number, number] {
  switch (company.key) {
    case "gulfbuild":
      return [25_000, 900_000];
    case "tradeline":
      return [3_000, 120_000];
    case "saudimfg":
      return [8_000, 400_000];
    case "consult":
      return [5_000, 150_000];
    default:
      return [4_000, 200_000];
  }
}

function langFor(rng: Rng, company: Company): "en" | "ar" {
  return rng.chance(company.key === "saudimfg" ? 0.7 : 0.25) ? "ar" : "en";
}

function stageIndexOf(pl: PipelineRef, frac: number): number {
  return Math.min(pl.open.length - 1, Math.max(0, Math.floor(frac * pl.open.length)));
}

function buildModel(ctx: LabContext): Model {
  const { company, rng, clock } = ctx;
  const P = company.profile;
  const orgId = ctx.orgId;
  const refs = refsFromHandoffs(ctx);
  const users: Record<OwnerKey, string> = {
    manager: ctx.users.manager,
    owner: ctx.users.owner,
    finance: ctx.users.finance,
    admin: ctx.users.admin,
  };
  const uid = (k: OwnerKey) => users[k];
  const currency = company.currency;
  const asOf = company.history.asOf;
  const firstDayAgo = clock.daysAgoOf(company.history.from);
  const [vLo, vHi] = valueRange(company);
  const vatRate = company.country === "SA" ? 15 : 5;
  const scopes = SCOPES[company.key] ?? SCOPES.consult!;
  const tables = {} as Record<CrmTable, Row[]>;
  for (const t of CRM_TABLES) tables[t] = [];
  const push = (table: CrmTable, row: Row) => tables[table].push(row);
  const ts = (daysAgo: number, hour = 9, minute = 0) => clock.tsAgo(daysAgo, hour, minute);
  const personaName = (k: OwnerKey) => company.personas.find((p) => p.key === k)!.fullName;
  const ownerPick = (): OwnerKey => weighted(rng, OWNER_WEIGHTS);
  const { ids: customerIds, pool } = refs.customers;
  /** An active customer the model may reference; never the merge source. */
  const custId = (): string => customerIds[pool[rng.int(0, pool.length - 1)]!]!;
  const defaultPipeline = refs.pipelines[0]!;
  const pipelineOf = (kind: OppM["kind"]): PipelineRef =>
    refs.pipelines.find((p) => p.kind === kind) ?? defaultPipeline;
  const merge = {
    sourceId: customerIds[refs.customers.mergeSourceOrd]!,
    targetId: customerIds[refs.customers.mergeTargetOrd]!,
  };

  // ── territories (3) ──────────────────────────────────────────────────────
  const territoryDefs: Array<[string, string, string, string[], string[]]> =
    company.country === "SA"
      ? [
          ["central", "Central Region", "المنطقة الوسطى", ["SA"], ["enterprise", "government"]],
          ["western", "Western Region", "المنطقة الغربية", ["SA"], ["sme"]],
          ["gulf", "GCC export", "تصدير خليجي", ["AE", "QA", "KW", "BH", "OM"], []],
        ]
      : [
          ["north", "Northern Emirates", "الإمارات الشمالية", ["AE"], ["sme"]],
          [
            "capital",
            "Abu Dhabi and Al Ain",
            "أبوظبي والعين",
            ["AE"],
            ["government", "enterprise"],
          ],
          ["gcc", "GCC accounts", "حسابات دول الخليج", ["SA", "QA", "KW", "BH", "OM"], ["vip"]],
        ];
  const territoryIds = territoryDefs.map(([key]) => ctx.id("crm", "territory", key));
  territoryDefs.forEach(([key, en, ar, countries, tags], i) => {
    push("crm_territory", {
      id: territoryIds[i],
      org_id: orgId,
      key,
      name: { en, ar },
      rules: { countries, tags },
      owner_user_id: uid(i === 1 ? "owner" : "manager"),
      active: true,
      created_by: uid("admin"),
      created_at: ts(firstDayAgo, 8),
      updated_at: ts(firstDayAgo, 8),
    });
  });

  // ── campaigns (5) ────────────────────────────────────────────────────────
  // [en, ar, channel, status, startsDaysAgo, endsDaysAgo | null (open-ended)]
  const campaignDefs: Array<[string, string, string, string, number, number | null]> = [
    ["Spring trade show", "معرض الربيع التجاري", "event", "completed", 420, 417],
    ["Referral programme", "برنامج الإحالة", "referral", "active", 300, null],
    ["Search ads — Q2", "إعلانات البحث — الربع الثاني", "ads", "completed", 180, 120],
    ["Newsletter relaunch", "إعادة إطلاق النشرة", "email", "paused", 120, -60],
    ["Year-end webinar", "ندوة نهاية العام", "web", "planned", -20, -21],
  ];
  const campaignIds = campaignDefs.map((_, i) => ctx.id("crm", "campaign", i));
  campaignDefs.forEach(([en, ar, channel, status, startsDaysAgo, endsDaysAgo], i) => {
    const budget = priceMinor(rng, 5_000, 60_000);
    const cost =
      status === "planned"
        ? 0
        : Math.round(
            (budget *
              rng.int(status === "completed" ? 80 : 20, status === "completed" ? 110 : 70)) /
              100,
          );
    const touchedDaysAgo = Math.max(0, Math.min(startsDaysAgo, endsDaysAgo ?? 0));
    push("crm_campaign", {
      id: campaignIds[i],
      org_id: orgId,
      name: company.key === "saudimfg" ? ar : rng.chance(0.3) ? `${en} — ${ar}` : en,
      objective: paragraph(rng, "en", 2),
      channel,
      status,
      audience: {
        segments: ["sme", "enterprise"].slice(0, rng.int(1, 2)),
        tags: [pick(rng, CUSTOMER_TAGS)],
        territories: [territoryIds[i % territoryIds.length]!],
        note: sentence(rng, "en"),
      },
      budget_minor: budget,
      cost_minor: cost,
      currency,
      starts_on: clock.dayAgo(startsDaysAgo),
      ends_on: endsDaysAgo === null ? null : clock.dayAgo(endsDaysAgo),
      owner_user_id: uid("manager"),
      created_by: uid("manager"),
      created_at: ts(Math.max(0, startsDaysAgo + 14)),
      updated_at: ts(touchedDaysAgo, 11),
    });
  });

  // ── leads ────────────────────────────────────────────────────────────────
  const L = P.leads;
  const leadDays = spreadDates(rng, company, L);
  const leads: LeadM[] = [];
  for (let i = 0; i < L; i++) {
    const createdDaysAgo = leadDays[i]!;
    const lang = langFor(rng, company);
    const isCompany = rng.chance(0.7);
    const cn = companyName(rng, i);
    const pn = personName(rng, i);
    const name = (
      isCompany ? (lang === "ar" ? cn.ar : cn.en) : lang === "ar" ? pn.ar : pn.en
    ).slice(0, 160);
    const src = pick(rng, LEAD_SOURCES);
    const resolved = createdDaysAgo >= 20 && doneByAge(rng, createdDaysAgo, 240);
    let status: LeadM["status"];
    if (resolved) status = rng.chance(0.55) ? "converted" : "disqualified";
    else status = weighted(rng, { new: 4, contacted: 4, qualified: 3 });
    if (createdDaysAgo < 3) status = "new";
    const ownerKey: OwnerKey | null = rng.chance(0.1) ? null : ownerPick();
    const campaignIdx = rng.chance(0.3) ? rng.int(0, campaignIds.length - 2) : null;
    const territoryIdx = rng.chance(0.6) ? rng.int(0, territoryIds.length - 1) : null;
    const withValue = rng.chance(0.6);
    const valueMinor = withValue ? priceMinor(rng, vLo, vHi) : null;
    const contactedDaysAgo = Math.max(0, createdDaysAgo - rng.int(1, 6));
    const convertedDaysAgo =
      status === "converted" ? Math.max(0, createdDaysAgo - rng.int(2, 40)) : null;
    const reason = status === "disqualified" ? pick(rng, DISQUALIFY_REASONS) : null;
    const quarantine =
      status === "disqualified" && reason === "spam"
        ? "spam"
        : status === "new" && ["form", "api", "messaging"].includes(src[2]) && rng.chance(0.35)
          ? "quarantined"
          : "trusted";
    const archived = status === "disqualified" && createdDaysAgo > 200 && rng.chance(0.3);
    const customerId = status === "converted" && rng.chance(0.85) ? custId() : null;
    const country = rng.chance(0.8) ? company.country : pick(rng, ["SA", "AE", "QA", "OM", "KW"]);
    const qualified = status === "qualified" || status === "converted";
    const referrerId = src[2] === "customer" || src[2] === "referral" ? custId() : null;
    const lead: LeadM = {
      i,
      id: ctx.id("crm", "lead", i),
      name,
      lang,
      status,
      createdDaysAgo,
      createdAt: ts(createdDaysAgo, rng.int(7, 18), rng.int(0, 59)),
      ownerKey,
      campaignIdx,
      territoryIdx,
      valueMinor,
      convertedAt: convertedDaysAgo === null ? null : ts(convertedDaysAgo, 11),
      oppIdx: null,
      serviceConvert: false,
      customerId,
    };
    leads.push(lead);
    const updatedDaysAgo =
      status === "new"
        ? createdDaysAgo
        : Math.min(contactedDaysAgo, convertedDaysAgo ?? contactedDaysAgo);
    push("lead", {
      id: lead.id,
      org_id: orgId,
      name,
      contact_name: isCompany ? (lang === "ar" ? pn.ar : pn.en) : null,
      phone: phone(company, i),
      email: email(pn.en, i),
      source: lang === "ar" ? src[1] : src[0],
      status,
      owner_user_id: ownerKey ? uid(ownerKey) : null,
      country,
      notes: rng.chance(0.5) ? sentence(rng, lang) : null,
      converted_opportunity_id: null, // filled once opportunities are allocated
      converted_customer_id: status === "converted" ? customerId : null,
      converted_at: lead.convertedAt,
      archived,
      created_by: uid(ownerKey ?? "manager"),
      created_at: lead.createdAt,
      updated_at: ts(updatedDaysAgo, 16),
      source_kind: src[2],
      campaign_id: campaignIdx === null ? null : campaignIds[campaignIdx],
      referrer_customer_id: referrerId,
      territory_id: territoryIdx === null ? null : territoryIds[territoryIdx],
      estimated_value_minor: valueMinor,
      currency: valueMinor === null ? null : currency,
      timeframe: pick(rng, ["immediate", "quarter", "half_year", "year", "unknown"]),
      interest: lang === "ar" ? scopes[i % scopes.length]![1] : scopes[i % scopes.length]![0],
      qualification: qualified
        ? {
            budget: rng.chance(0.8),
            authority: rng.chance(0.7),
            need: true,
            timing: rng.chance(0.6),
            note: sentence(rng, lang),
          }
        : {},
      disqualify_reason: reason,
      quarantine,
      duplicate_of_lead_id: reason === "duplicate" && i > 0 ? ctx.id("crm", "lead", i - 1) : null,
    });
  }

  // Service-converted leads: born qualified and trusted, converted by the product's own door.
  const convert: ConvertM[] = [];
  for (const lead of leads) {
    if (convert.length >= SERVICE_SUBSET.convert) break;
    if (lead.status !== "qualified" || lead.ownerKey === null) continue;
    lead.serviceConvert = true;
    convert.push({
      lead,
      name: `${lead.name} — ${scopes[lead.i % scopes.length]![lead.lang === "ar" ? 1 : 0]}`.slice(
        0,
        160,
      ),
      customerId: custId(),
      valueMinor: priceMinor(rng, vLo, vHi),
      closeDate: clock.dayAhead(rng.int(20, 120)),
    });
  }

  // ── opportunities ────────────────────────────────────────────────────────
  const converted = leads.filter((l) => l.status === "converted");
  const O = P.opportunities - convert.length;
  if (converted.length > O) throw new Error("crm: more converted leads than opportunities");
  const oppDays = spreadDates(rng, company, O - converted.length);
  const opps: OppM[] = [];
  for (let i = 0; i < O; i++) {
    const fromLead = i < converted.length ? converted[i]! : null;
    const createdDaysAgo = fromLead
      ? clock.daysAgoOf(fromLead.convertedAt!.slice(0, 10))
      : oppDays[i - converted.length]!;
    const lang = fromLead ? fromLead.lang : langFor(rng, company);
    const scope = scopes[rng.int(0, scopes.length - 1)]!;
    const baseName = fromLead
      ? `${fromLead.name} — ${lang === "ar" ? scope[1] : scope[0]}`
      : lang === "ar"
        ? scope[1]
        : scope[0];
    const name = longTitle(rng, lang, baseName).slice(0, 160);
    const closed = createdDaysAgo >= 20 && doneByAge(rng, createdDaysAgo, 300);
    let status: OppM["status"] = "open";
    let closedDaysAgo: number | null = null;
    if (closed) {
      const winRate = company.key === "facilico" ? 0.55 : 0.45;
      status = rng.chance(winRate) ? "won" : "lost";
      const cycle = rng.int(15, 150);
      closedDaysAgo = createdDaysAgo - cycle;
      if (closedDaysAgo < 0) closedDaysAgo = rng.int(0, Math.max(0, createdDaysAgo - 1));
    }
    const customerId = fromLead
      ? fromLead.customerId
      : status === "won" || rng.chance(0.85)
        ? custId()
        : null;
    const kind: OppM["kind"] = weighted(rng, {
      new_business: company.key === "facilico" ? 5 : 7,
      expansion: 1.5,
      renewal: company.key === "facilico" ? 3.5 : 1.5,
    });
    const pipeline = pipelineOf(kind);
    const stageFrac = status === "open" ? rng.next() * Math.min(1, 0.25 + createdDaysAgo / 150) : 1;
    const stageIdx = stageIndexOf(pipeline, stageFrac);
    const stageKey =
      status === "open"
        ? pipeline.open[stageIdx]!
        : status === "won"
          ? pipeline.won
          : pipeline.lost;
    const probability =
      status === "open"
        ? Math.min(95, Math.max(5, Math.round(10 + stageFrac * 75 + rng.int(-5, 5))))
        : rng.int(40, 90);
    const withValue = status !== "open" || rng.chance(0.95);
    const valueMinor = withValue ? priceMinor(rng, vLo, vHi) : null;
    let closeDate: string | null;
    if (status === "open") {
      closeDate = rng.chance(0.1) ? null : clock.dayAgo(createdDaysAgo - rng.int(30, 200));
    } else {
      closeDate = clock.dayAgo(closedDaysAgo! + rng.int(-20, 10));
    }
    const category: OppM["category"] =
      status === "open"
        ? weighted(rng, { pipeline: 55, best_case: 20, commit: 20, omitted: 5 })
        : "pipeline";
    const archived = status === "lost" && rng.chance(0.03);
    const stalled = status === "open" && createdDaysAgo > 75 && rng.chance(0.2);
    const activityEndDaysAgo =
      status === "open" ? (stalled ? Math.min(createdDaysAgo - 1, 60) : 0) : closedDaysAgo!;
    const lossReason = status === "lost" ? pick(rng, LOSS_REASONS) : null;
    const opp: OppM = {
      i,
      id: ctx.id("crm", "opp", i),
      name,
      lang,
      status,
      bornStatus: status,
      createdDaysAgo,
      createdAt: fromLead
        ? fromLead.convertedAt!
        : ts(createdDaysAgo, rng.int(8, 17), rng.int(0, 59)),
      closedDaysAgo,
      closedAt: closedDaysAgo === null ? null : ts(closedDaysAgo, 14, rng.int(0, 59)),
      customerId,
      leadIdx: fromLead ? fromLead.i : null,
      ownerKey: fromLead?.ownerKey ?? ownerPick(),
      pipeline,
      stageIdx,
      stageKey,
      valueMinor,
      probability,
      closeDate,
      category,
      kind,
      archived,
      campaignIdx: fromLead
        ? fromLead.campaignIdx
        : rng.chance(0.25)
          ? rng.int(0, campaignIds.length - 2)
          : null,
      territoryIdx: fromLead
        ? fromLead.territoryIdx
        : rng.chance(0.6)
          ? rng.int(0, territoryIds.length - 1)
          : null,
      lossReason,
      stalled,
      activityEndDaysAgo,
      lastActivityAt: null,
      service: null,
      moveToKey: null,
      lossNote: lossReason ? sentence(rng, lang) : null,
    };
    if (fromLead) fromLead.oppIdx = i;
    opps.push(opp);
  }

  // The representative service subset: born open in the default pipeline, transitioned by
  // the product. A governed move targets the third open stage ("qualified": value and
  // close date), which the picked rows satisfy by construction.
  const services = { win: 0, lose: 0, move: 0, convert: convert.length };
  const moveToKey = defaultPipeline.open.length >= 3 ? defaultPipeline.open[2]! : null;
  for (const o of opps) {
    if (
      o.status !== "open" ||
      o.valueMinor === null ||
      o.customerId === null ||
      o.archived ||
      o.pipeline !== defaultPipeline
    )
      continue;
    const frac = (o.stageIdx + 1) / o.pipeline.open.length;
    if (services.win < SERVICE_SUBSET.win && frac > 0.6) {
      o.service = "win";
      services.win++;
    } else if (services.lose < SERVICE_SUBSET.lose && frac > 0.4) {
      o.service = "lose";
      o.lossReason = pick(rng, LOSS_REASONS);
      o.lossNote = sentence(rng, o.lang);
      services.lose++;
    } else if (
      services.move < SERVICE_SUBSET.move &&
      moveToKey !== null &&
      o.stageIdx <= 1 &&
      o.closeDate !== null &&
      o.valueMinor > 0
    ) {
      o.service = "move";
      o.moveToKey = moveToKey;
      services.move++;
    }
  }

  /*
   * Top up the "move a deal along" subset.
   *
   * The assignment above is an else-if chain, so wins and losses claim the
   * eligible opportunities first and the move quota was reached on only the
   * largest company — three of six on the others. A stage move is the cheapest
   * way for the lab to show a pipeline that is actually alive, so the quota is
   * filled deterministically from the opportunities the chain passed over,
   * walking them in index order and consuming no randomness.
   */
  /*
   * Fill every service quota from the deals the chain passed over.
   *
   * The assignment above is an else-if chain gated on how far a deal has
   * travelled: a win needs to be past 60% of the pipeline, a loss past 40%. On
   * the smallest company the wins claimed the far-along deals and only three
   * losses were left — and a lab that cannot show a lost deal cannot be used to
   * look at why deals are lost. The quotas are therefore filled deterministically
   * here, walking the leftovers in index order and consuming no randomness, so
   * the subset is the same size on every company whatever its scale.
   */
  const leftovers = () =>
    opps.filter(
      (o) =>
        o.service === null &&
        o.status === "open" &&
        o.customerId !== null &&
        !o.archived &&
        o.pipeline === defaultPipeline &&
        o.valueMinor !== null &&
        o.valueMinor > 0,
    );
  for (const o of leftovers()) {
    if (services.win >= SERVICE_SUBSET.win) break;
    o.service = "win";
    services.win++;
  }
  for (const o of leftovers()) {
    if (services.lose >= SERVICE_SUBSET.lose) break;
    o.service = "lose";
    // Chosen by position rather than by rng: the stream must stay identical.
    o.lossReason = LOSS_REASONS[services.lose % LOSS_REASONS.length]!;
    o.lossNote = o.lang === "ar" ? "فضّل العميل عرضاً آخر" : "The client preferred another offer";
    services.lose++;
  }
  if (moveToKey !== null) {
    for (const o of leftovers()) {
      if (services.move >= SERVICE_SUBSET.move) break;
      if (o.stageIdx >= o.pipeline.open.length - 1) continue;
      // An early-stage deal often has no expected close date yet, and moving one
      // forward is exactly when a date gets agreed.
      if (o.closeDate === null) o.closeDate = clock.dayAhead(30);
      o.service = "move";
      o.moveToKey = moveToKey;
      services.move++;
    }
  }

  // ── activities, products, stakeholders, competitors, risks, discounts, canvases, touches ─
  const contactFrac = () => rng.next();
  const participantsFor = (o: OppM, withContact: boolean): Row[] => {
    const out: Row[] = [{ kind: "member", id: uid(o.ownerKey), name: personaName(o.ownerKey) }];
    if (withContact) out.push({ kind: "contact", name: personName(rng, o.i).en });
    return out;
  };
  const titleFor = (kind: string, lang: "en" | "ar") => {
    const t = pick(rng, ACTIVITY_TITLES[kind] ?? ACTIVITY_TITLES.note!);
    return { title: lang === "ar" ? t[1] : t[0], template: t[2] };
  };
  const activity = (o: OppM, j: number | string, fields: Row): Row => ({
    id: ctx.id("crm", "act", o.i, j),
    org_id: orgId,
    lead_id: null,
    opportunity_id: o.id,
    customer_id: o.customerId,
    contact_id: null,
    $contactFrac: null,
    kind: "note",
    custom_kind: null,
    title: null,
    body: null,
    due_date: null,
    completed_at: null,
    completed_by: null,
    owner_user_id: uid(o.ownerKey),
    actor_user_id: uid(o.ownerKey),
    outcome: null,
    participants: [],
    next_action: null,
    next_action_due: null,
    location: null,
    reminder_at: null,
    recurrence_days: null,
    template_key: null,
    meta: {},
    created_at: o.createdAt,
    updated_at: o.createdAt,
    ...fields,
  });
  const [aMin, aMax] = P.activitiesPerOpportunity;
  let discountSeq = 0;
  let canvasCount = 0;
  const canvasTarget = Math.max(2, Math.round(O * 0.03));
  for (const o of opps) {
    const n = rng.int(aMin, aMax);
    const lo = Math.min(o.createdDaysAgo, o.activityEndDaysAgo);
    const hi = o.createdDaysAgo;
    const days = Array.from({ length: n }, () => rng.int(lo, hi)).sort((a, b) => b - a);
    let last: string | null = null;
    for (let j = 0; j < n; j++) {
      const d = days[j]!;
      const kind = weighted(rng, {
        call: 30,
        email: 25,
        meeting: 15,
        task: 10,
        note: 8,
        follow_up: 5,
        [company.key === "consult" || company.key === "tradeline" ? "demo" : "site_visit"]: 4,
        message: 3,
      });
      const { title, template } = titleFor(kind, o.lang);
      const createdAt = ts(d, rng.int(8, 17), rng.int(0, 59));
      const row: Row = { kind, title, body: sentence(rng, o.lang), created_at: createdAt };
      if (ENGAGEMENT_KINDS.has(kind)) {
        const done = o.status !== "open" || rng.chance(0.85);
        if (done) {
          row.completed_at = ts(d, 18);
          row.completed_by = uid(o.ownerKey);
          row.outcome = pick(rng, OUTCOMES);
          row.updated_at = row.completed_at;
        }
        row.participants = participantsFor(o, rng.chance(0.6));
        row.template_key = template;
        if (kind === "meeting" || kind === "site_visit")
          row.location = `${o.lang === "ar" ? "مكتب العميل" : "Client office"}, ${company.country === "SA" ? "Riyadh" : "Dubai"}`;
        if (rng.chance(0.3)) {
          row.next_action = o.lang === "ar" ? "إرسال العرض المحدث" : "Send the updated proposal";
          row.next_action_due = clock.dayAgo(d - rng.int(2, 10));
        }
      } else if (kind === "task" || kind === "follow_up") {
        const dueDaysAgo = d - rng.int(1, 14);
        row.due_date = clock.dayAgo(dueDaysAgo);
        const done =
          o.status !== "open"
            ? rng.chance(0.9)
            : dueDaysAgo > 0
              ? rng.chance(0.65)
              : rng.chance(0.1);
        if (done) {
          row.completed_at = ts(Math.max(0, dueDaysAgo), 15);
          row.completed_by = uid(o.ownerKey);
          row.updated_at = row.completed_at;
        }
        if (!done && dueDaysAgo < 0 && rng.chance(0.5)) row.reminder_at = ts(dueDaysAgo + 1, 8);
      }
      if (o.customerId !== null && rng.chance(0.4)) row.$contactFrac = contactFrac();
      if (rng.chance(0.2)) row.actor_user_id = uid("owner");
      push("sales_activity", activity(o, j, row));
      if (last === null || createdAt > last) last = createdAt;
    }
    o.lastActivityAt = last;

    // Lifecycle marks the product would have written along the way.
    const open = o.pipeline.open;
    if (o.status !== "open" || o.stageIdx > 0) {
      const from =
        o.status === "open" ? open[o.stageIdx - 1]! : open[Math.floor(open.length * 0.3)]!;
      const to = o.status === "open" ? open[o.stageIdx]! : open[Math.floor(open.length * 0.7)]!;
      const ageDays = rng.int(1, 30);
      const d = Math.max(
        o.activityEndDaysAgo,
        Math.min(o.createdDaysAgo, o.createdDaysAgo - ageDays),
      );
      push(
        "sales_activity",
        activity(o, "stage", {
          kind: "stage_change",
          title: `${from}|${to}`,
          meta: { from, to, reason: null, ageDays },
          created_at: ts(d, 10),
          updated_at: ts(d, 10),
        }),
      );
    }
    if (o.status === "won")
      push(
        "sales_activity",
        activity(o, "won", { kind: "won", created_at: o.closedAt, updated_at: o.closedAt }),
      );
    if (o.status === "lost")
      push(
        "sales_activity",
        activity(o, "lost", {
          kind: "lost",
          body: o.lossReason,
          created_at: o.closedAt,
          updated_at: o.closedAt,
        }),
      );

    // Products: the opportunity's value is the sum of its non-optional lines.
    if (o.valueMinor !== null && rng.chance(0.45)) {
      const k = rng.int(1, 3);
      let net = 0;
      for (let p = 0; p < k; p++) {
        const qty = rng.int(1, 20);
        const unitPrice = priceMinor(rng, Math.max(50, vLo / 40), Math.max(200, vHi / 20));
        const discount = pick(rng, [0, 0, 0, 5, 10, 15]);
        const optional = p > 0 && rng.chance(0.1);
        const line = computeLine({
          qty,
          unitPriceMinor: unitPrice,
          discountPct: discount,
          vatRate,
          unitCostMinor: null,
        });
        if (!optional) net += line.lineNetMinor;
        const item =
          refs.items.length > 0 && rng.chance(0.7)
            ? refs.items[
                Math.min(refs.items.length - 1, Math.floor(rng.next() * refs.items.length))
              ]!
            : null;
        push("crm_opportunity_product", {
          id: ctx.id("crm", "product", o.i, p),
          org_id: orgId,
          opportunity_id: o.id,
          item_id: item?.id ?? null,
          description: `${o.lang === "ar" ? "توريد وتركيب" : "Supply and install"} — ${o.name.slice(0, 200)}`,
          qty,
          unit: item?.unit ?? pick(rng, ["ea", "m", "hr", "set"]),
          unit_price_minor: unitPrice,
          discount_pct: discount,
          vat_rate: vatRate,
          unit_cost_minor: Math.round((unitPrice * rng.int(55, 80)) / 100),
          optional,
          bundle_key: p === 0 ? "core" : null,
          recurrence_months: o.kind === "renewal" ? 12 : null,
          sort: p,
          created_by: uid(o.ownerKey),
          created_at: o.createdAt,
          updated_at: o.createdAt,
        });
      }
      o.valueMinor = net;
    }

    if (rng.chance(0.35)) {
      const k = rng.int(1, 2);
      for (let s = 0; s < k; s++) {
        const pn = personName(rng, o.i + s);
        push("crm_opportunity_stakeholder", {
          id: ctx.id("crm", "stakeholder", o.i, s),
          org_id: orgId,
          opportunity_id: o.id,
          contact_id: null,
          $cust: o.customerId,
          $contactFrac: o.customerId !== null && rng.chance(0.5) ? contactFrac() : null,
          name: o.lang === "ar" ? pn.ar : pn.en,
          role_kind: pick(rng, ROLE_KINDS),
          influence: rng.int(1, 5),
          sentiment: weighted(rng, { supporter: 3, neutral: 3, detractor: 1, unknown: 3 }),
          notes: rng.chance(0.4) ? sentence(rng, o.lang) : null,
          created_by: uid(o.ownerKey),
          created_at: o.createdAt,
          updated_at: o.createdAt,
        });
      }
    }
    if (rng.chance(0.2)) {
      push("crm_opportunity_competitor", {
        id: ctx.id("crm", "competitor", o.i),
        org_id: orgId,
        opportunity_id: o.id,
        name: pick(rng, COMPETITORS),
        strengths: sentence(rng, "en"),
        weaknesses: rng.chance(0.6) ? sentence(rng, "en") : null,
        status:
          o.status === "lost" && o.lossReason === "competitor"
            ? "won_against_us"
            : o.status === "won"
              ? "eliminated"
              : weighted(rng, { active: 6, unknown: 2, eliminated: 1 }),
        created_by: uid(o.ownerKey),
        created_at: o.createdAt,
        updated_at: o.createdAt,
      });
    }
    if (rng.chance(0.25)) {
      const k = rng.int(1, 2);
      for (let r = 0; r < k; r++) {
        const t = pick(rng, RISK_TITLES);
        push("crm_opportunity_risk", {
          id: ctx.id("crm", "risk", o.i, r),
          org_id: orgId,
          opportunity_id: o.id,
          kind: weighted(rng, { risk: 6, blocker: 2, dependency: 2 }),
          title: o.lang === "ar" ? t[1] : t[0],
          severity: weighted(rng, { low: 3, medium: 5, high: 2 }),
          status:
            o.status === "open"
              ? weighted(rng, { open: 7, mitigated: 2, closed: 1 })
              : weighted(rng, { closed: 6, mitigated: 4 }),
          mitigation: rng.chance(0.5) ? sentence(rng, o.lang) : null,
          owner_user_id: rng.chance(0.7) ? uid(o.ownerKey) : null,
          created_by: uid(o.ownerKey),
          created_at: o.createdAt,
          updated_at: o.createdAt,
        });
      }
    }
    if (o.valueMinor !== null && o.valueMinor > 0 && !o.archived && rng.chance(0.03)) {
      const pct = pick(rng, [5, 10, 15, 20]);
      // A pending request only on a row that stays open (the service subset closes or moves).
      const status: string =
        o.status === "open" && o.service === null
          ? weighted(rng, { pending: 3, approved: 4, rejected: 2, withdrawn: 1 })
          : weighted(rng, { approved: 5, rejected: 3, withdrawn: 1 });
      const requestedDaysAgo = Math.max(
        o.activityEndDaysAgo,
        Math.min(o.createdDaysAgo, rng.int(o.activityEndDaysAgo, o.createdDaysAgo)),
      );
      const decidedDaysAgo = Math.max(0, requestedDaysAgo - 1);
      const id = ctx.id("crm", "discount", discountSeq++);
      push("crm_discount", {
        id,
        org_id: orgId,
        opportunity_id: o.id,
        quote_id: null,
        requested_pct: pct,
        list_total_minor: o.valueMinor,
        discounted_total_minor: Math.round(o.valueMinor * (1 - pct / 100)),
        currency,
        reason: sentence(rng, o.lang),
        status,
        approval_id: null,
        decided_at: status === "pending" ? null : ts(decidedDaysAgo, 12),
        requested_by: uid(o.ownerKey),
        created_at: ts(requestedDaysAgo, 11),
        updated_at: status === "pending" ? ts(requestedDaysAgo, 11) : ts(decidedDaysAgo, 12),
      });
      push(
        "sales_activity",
        activity(o, "discount-req", {
          kind: "discount",
          title: "Discount requested",
          body: sentence(rng, o.lang),
          meta: { discountId: id, pct, status: "pending" },
          created_at: ts(requestedDaysAgo, 11),
          updated_at: ts(requestedDaysAgo, 11),
        }),
      );
      if (status === "approved" || status === "rejected")
        push(
          "sales_activity",
          activity(o, "discount-decided", {
            kind: "discount",
            title: status === "approved" ? "Discount approved" : "Discount rejected",
            actor_user_id: uid("owner"),
            meta: { discountId: id, pct, status },
            created_at: ts(decidedDaysAgo, 12),
            updated_at: ts(decidedDaysAgo, 12),
          }),
        );
    }
    if (o.status === "open" && !o.archived && canvasCount < canvasTarget && rng.chance(0.08)) {
      canvasCount++;
      const t = pick(rng, RISK_TITLES);
      push("crm_deal_canvas", {
        id: ctx.id("crm", "canvas", o.i),
        org_id: orgId,
        opportunity_id: o.id,
        doc: {
          nodes: [
            { id: "n1", kind: "stakeholder", label: personName(rng, o.i).en, x: 80, y: 80 },
            {
              id: "n2",
              kind: "decision",
              label: o.lang === "ar" ? "قرار الشراء" : "Buying decision",
              x: 320,
              y: 80,
            },
            { id: "n3", kind: "risk", label: o.lang === "ar" ? t[1] : t[0], x: 320, y: 240 },
            {
              id: "n4",
              kind: "step",
              label: o.lang === "ar" ? "العرض النهائي" : "Final proposal",
              x: 560,
              y: 80,
            },
            { id: "n5", kind: "note", label: sentence(rng, o.lang).slice(0, 200), x: 80, y: 240 },
          ],
          edges: [
            { id: "e1", from: "n1", to: "n2", label: "influences" },
            { id: "e2", from: "n3", to: "n2" },
            { id: "e3", from: "n2", to: "n4", label: "leads to" },
          ],
        },
        row_version: 1,
        updated_by: uid(o.ownerKey),
        created_at: o.createdAt,
        updated_at: o.createdAt,
      });
    }
    if (o.campaignIdx !== null) {
      const k = rng.int(1, 2);
      for (let t = 0; t < k; t++) {
        const d = rng.int(Math.min(o.createdDaysAgo, o.activityEndDaysAgo), o.createdDaysAgo);
        push("crm_touch", {
          id: ctx.id("crm", "touch", "opp", o.i, t),
          org_id: orgId,
          campaign_id: campaignIds[o.campaignIdx]!,
          customer_id: null,
          lead_id: null,
          opportunity_id: o.id,
          kind: pick(rng, ["reply", "visit", "manual", "click"]),
          touched_at: ts(d, 10),
          note: rng.chance(0.3) ? sentence(rng, "en").slice(0, 300) : null,
          created_by: uid(o.ownerKey),
          created_at: ts(d, 10),
        });
      }
    }
  }
  // Values changed by product lines: the expectations come from the final model.
  const wonAfterServices = opps.filter((o) => o.status === "won" || o.service === "win");
  const expectedWonMinor = wonAfterServices.reduce((s, o) => s + (o.valueMinor ?? 0), 0);
  const expectedWonCount = wonAfterServices.length;
  const openAfterServices = opps.filter(
    (o) => o.status === "open" && o.service !== "win" && o.service !== "lose" && !o.archived,
  );
  const expectedOpenCount = openAfterServices.length + convert.length;
  const expectedOpenMinor =
    openAfterServices.reduce((s, o) => s + (o.valueMinor ?? 0), 0) +
    convert.reduce((s, c) => s + c.valueMinor, 0);

  // Opportunity rows (after activities decided last_activity_at and lines decided value).
  const stageEnteredDaysAgo = (o: OppM): number => {
    if (o.status !== "open") return o.closedDaysAgo!;
    if (o.stalled) return Math.min(o.createdDaysAgo, rng.int(60, 200));
    return rng.int(0, Math.min(o.createdDaysAgo, 120));
  };
  for (const o of opps) {
    const entered = stageEnteredDaysAgo(o);
    const born = o.bornStatus;
    push("opportunity", {
      id: o.id,
      org_id: orgId,
      name: o.name,
      customer_id: o.customerId,
      lead_id: o.leadIdx === null ? null : ctx.id("crm", "lead", o.leadIdx),
      owner_user_id: uid(o.ownerKey),
      stage_key: o.stageKey,
      status: born,
      estimated_value_minor: o.valueMinor,
      currency: o.valueMinor === null ? null : currency,
      expected_close_date: o.closeDate,
      probability: o.probability,
      next_action:
        born === "open" && rng.chance(0.7)
          ? o.lang === "ar"
            ? "متابعة العميل بشأن العرض"
            : "Follow up with the client on the proposal"
          : null,
      next_action_due: born === "open" && rng.chance(0.7) ? clock.dayAgo(rng.int(-21, 10)) : null,
      quote_id: null,
      loss_reason: born === "lost" ? o.lossReason : null,
      loss_note: born === "lost" ? o.lossNote : null,
      won_at: born === "won" ? o.closedAt : null,
      lost_at: born === "lost" ? o.closedAt : null,
      archived: o.archived,
      created_by: uid(o.ownerKey),
      created_at: o.createdAt,
      updated_at: o.closedAt ?? o.lastActivityAt ?? o.createdAt,
      pipeline_id: o.pipeline.id,
      forecast_category: o.category,
      campaign_id: o.campaignIdx === null ? null : campaignIds[o.campaignIdx],
      territory_id: o.territoryIdx === null ? null : territoryIds[o.territoryIdx],
      source: o.leadIdx === null ? pick(rng, LEAD_SOURCES)[0] : "lead",
      kind: o.kind,
      amount_kind: o.kind === "renewal" ? "recurring" : "one_time",
      recurring_minor:
        o.kind === "renewal" && o.valueMinor !== null ? Math.round(o.valueMinor / 12) : null,
      recurrence_months: o.kind === "renewal" ? 12 : null,
      decision_criteria: rng.chance(0.3) ? sentence(rng, o.lang) : null,
      needs: rng.chance(0.3) ? paragraph(rng, o.lang, 2) : null,
      buying_process: rng.chance(0.25)
        ? [
            {
              step: o.lang === "ar" ? "الموافقة الفنية" : "Technical approval",
              owner: personName(rng, o.i).en,
              done: true,
              due: clock.dayAgo(o.createdDaysAgo - 10),
            },
            {
              step: o.lang === "ar" ? "اعتماد الميزانية" : "Budget sign-off",
              owner: personName(rng, o.i + 1).en,
              done: born !== "open",
              due: clock.dayAgo(o.createdDaysAgo - 30),
            },
          ]
        : [],
      contract_document_id: null,
      stage_entered_at: ts(entered, 9),
      last_activity_at: o.lastActivityAt,
    });
  }

  // Lead rows: conversion evidence and lead-side activities.
  for (const lead of leads) {
    const row = tables.lead[lead.i]!;
    if (lead.status === "converted" && lead.oppIdx !== null) {
      row.converted_opportunity_id = ctx.id("crm", "opp", lead.oppIdx);
    }
    const leadActivity = (j: string, fields: Row): Row => ({
      id: ctx.id("crm", "lead-act", lead.i, j),
      org_id: orgId,
      lead_id: lead.id,
      opportunity_id: null,
      customer_id: null,
      contact_id: null,
      $contactFrac: null,
      kind: "note",
      custom_kind: null,
      title: null,
      body: null,
      due_date: null,
      completed_at: null,
      completed_by: null,
      owner_user_id: lead.ownerKey ? uid(lead.ownerKey) : null,
      actor_user_id: uid(lead.ownerKey ?? "manager"),
      outcome: null,
      participants: [],
      next_action: null,
      next_action_due: null,
      location: null,
      reminder_at: null,
      recurrence_days: null,
      template_key: null,
      meta: {},
      created_at: lead.createdAt,
      updated_at: lead.createdAt,
      ...fields,
    });
    if (lead.status !== "new") {
      const d = Math.max(0, lead.createdDaysAgo - rng.int(1, 6));
      const kind = weighted(rng, { call: 5, email: 4, message: 1 });
      const { title } = titleFor(kind, lead.lang);
      push(
        "sales_activity",
        leadActivity("first", {
          kind,
          title,
          body: sentence(rng, lead.lang),
          completed_at: ts(d, 12),
          completed_by: uid(lead.ownerKey ?? "manager"),
          outcome: pick(rng, OUTCOMES),
          created_at: ts(d, 11),
          updated_at: ts(d, 12),
        }),
      );
    }
    if (lead.status === "disqualified") {
      const d = Math.max(0, lead.createdDaysAgo - rng.int(3, 30));
      push(
        "sales_activity",
        leadActivity("disq", {
          kind: "note",
          title: "Disqualified",
          body: sentence(rng, lead.lang),
          meta: { disqualifyReason: row.disqualify_reason },
          created_at: ts(d, 15),
          updated_at: ts(d, 15),
        }),
      );
    }
    if (lead.status === "converted" && lead.oppIdx !== null) {
      push(
        "sales_activity",
        leadActivity("conv", {
          kind: "note",
          opportunity_id: ctx.id("crm", "opp", lead.oppIdx),
          body: "Converted to opportunity",
          created_at: lead.convertedAt,
          updated_at: lead.convertedAt,
        }),
      );
    }
    if (lead.campaignIdx !== null) {
      const channel = campaignDefs[lead.campaignIdx]![2];
      push("crm_touch", {
        id: ctx.id("crm", "touch", "lead", lead.i),
        org_id: orgId,
        campaign_id: campaignIds[lead.campaignIdx]!,
        customer_id: null,
        lead_id: lead.id,
        opportunity_id: null,
        kind:
          channel === "referral"
            ? "referral"
            : channel === "event"
              ? "visit"
              : channel === "ads" || channel === "email"
                ? pick(rng, ["exposure", "click"])
                : "click",
        touched_at: lead.createdAt,
        note: null,
        created_by: lead.ownerKey ? uid(lead.ownerKey) : null,
        created_at: lead.createdAt,
      });
    }
  }

  // ── targets: org (monthly + quarterly), owners (quarterly), territories (quarterly) ─
  const wonByMonth = new Map<string, number>();
  for (const o of opps)
    if (o.status === "won" && o.closedAt)
      wonByMonth.set(
        o.closedAt.slice(0, 7),
        (wonByMonth.get(o.closedAt.slice(0, 7)) ?? 0) + (o.valueMinor ?? 0),
      );
  const recent = Array.from({ length: 12 }, (_, k) => wonByMonth.get(monthKey(asOf, k)) ?? 0);
  const monthlyBase = Math.max(vLo * 100 * 3, Math.round(recent.reduce((a, b) => a + b, 0) / 12));
  const targetCreated = ts(firstDayAgo, 10);
  let targetSeq = 0;
  const target = (fields: Row) =>
    push("crm_target", {
      id: ctx.id("crm", "target", targetSeq++),
      org_id: orgId,
      scope_kind: "org",
      scope_id: null,
      metric: "bookings",
      period_start: "",
      period_end: "",
      amount_minor: null,
      count_target: null,
      currency: null,
      effective_from: "",
      note: null,
      created_by: uid("owner"),
      created_at: targetCreated,
      ...fields,
    });
  for (let k = SNAPSHOT_MONTHS - 1; k >= 0; k--) {
    const key = monthKey(asOf, k);
    target({
      metric: "bookings",
      period_start: `${key}-01`,
      period_end: monthEnd(key),
      amount_minor: roundToMajorThousand(monthlyBase * rng.float(0.85, 1.3)),
      currency,
      effective_from: addDays(`${key}-01`, -20),
      note: "Monthly bookings target",
    });
  }
  const quarters = lastQuarters(asOf, TARGET_QUARTERS);
  for (const q of quarters) {
    target({
      metric: "revenue",
      period_start: q.start,
      period_end: q.end,
      amount_minor: roundToMajorThousand(monthlyBase * 3 * rng.float(0.9, 1.2)),
      currency,
      effective_from: addDays(q.start, -30),
      note: "Quarterly invoiced revenue",
    });
    target({
      metric: "new_customers",
      period_start: q.start,
      period_end: q.end,
      count_target: rng.int(5, 40),
      effective_from: addDays(q.start, -30),
      note: null,
    });
    for (const k of OWNER_KEYS)
      target({
        scope_kind: "user",
        scope_id: uid(k),
        metric: "bookings",
        period_start: q.start,
        period_end: q.end,
        amount_minor: roundToMajorThousand(
          monthlyBase * 3 * (OWNER_WEIGHTS[k] / 9) * rng.float(0.9, 1.3),
        ),
        currency,
        effective_from: addDays(q.start, -15),
      });
    target({
      scope_kind: "user",
      scope_id: uid("manager"),
      metric: "activities",
      period_start: q.start,
      period_end: q.end,
      count_target: rng.int(60, 200),
      effective_from: addDays(q.start, -15),
      note: "Completed engagements with an outcome",
    });
    territoryIds.forEach((tid, i) =>
      target({
        scope_kind: "territory",
        scope_id: tid,
        metric: "bookings",
        period_start: q.start,
        period_end: q.end,
        amount_minor: roundToMajorThousand(
          monthlyBase * 3 * [0.5, 0.35, 0.15][i]! * rng.float(0.9, 1.3),
        ),
        currency,
        effective_from: addDays(q.start, -10),
      }),
    );
  }
  // A re-set: the current quarter's org bookings target revised upward (history stays).
  const cur = quarters[quarters.length - 1]!;
  target({
    metric: "bookings",
    period_start: cur.start,
    period_end: cur.end,
    amount_minor: roundToMajorThousand(monthlyBase * 3 * 1.15),
    currency,
    effective_from: addDays(cur.start, 10),
    note: "Revised after the board review",
  });

  // ── forecast snapshots: one per month, frozen on the 1st ──────────────────
  for (let k = SNAPSHOT_MONTHS - 1; k >= 0; k--) {
    const key = monthKey(asOf, k);
    const capturedAt = `${key}-01T03:00:00.000Z`;
    // What the product's snapshot froze: rows open at capture (or closed after it) whose
    // close date falls in the period. Service wins/losses happen after every capture.
    const inPeriod = opps.filter(
      (o) =>
        !o.archived &&
        o.closeDate !== null &&
        o.closeDate.slice(0, 7) === key &&
        o.createdAt <= capturedAt &&
        (o.status === "open" || (o.closedAt !== null && o.closedAt > capturedAt)),
    );
    const active = inPeriod.filter((o) => o.category !== "omitted");
    const value = (o: OppM) => o.valueMinor ?? 0;
    const weightedOf = (o: OppM) => Math.round((value(o) * o.probability) / 100);
    const sum = (rows: OppM[], f: (o: OppM) => number) => rows.reduce((s, o) => s + f(o), 0);
    push("crm_forecast_snapshot", {
      id: ctx.id("crm", "snapshot", key),
      org_id: orgId,
      period_key: key,
      scope_kind: "org",
      scope_id: null,
      captured_at: capturedAt,
      captured_by: k % 3 === 0 ? uid("manager") : null,
      currency,
      totals: {
        count: active.length,
        pipelineMinor: sum(active, value),
        weightedMinor: sum(active, weightedOf),
        commitMinor: sum(
          active.filter((o) => o.category === "commit"),
          value,
        ),
        bestCaseMinor: sum(
          active.filter((o) => o.category === "commit" || o.category === "best_case"),
          value,
        ),
        model: FORECAST_MODEL,
      },
      rows: inPeriod.map((o) => ({
        id: o.id,
        stageKey: o.stageKey,
        category: o.category,
        valueMinor: value(o),
        probability: o.probability,
        weightedMinor: weightedOf(o),
        closeDate: o.closeDate,
        ownerId: uid(o.ownerKey),
      })),
      row_count: inPeriod.length,
      note: k % 3 === 0 ? "Captured before the monthly review" : null,
      created_at: capturedAt,
    });
  }

  // ── scenarios (3): reviewed, draft, applied ───────────────────────────────
  const openWithDates = opps.filter(
    (o) => o.status === "open" && o.closeDate !== null && !o.archived,
  );
  const pickOpen = (n: number, offset: number) =>
    Array.from(
      { length: Math.min(n, openWithDates.length) },
      (_, i) => openWithDates[(offset + i * 7) % openWithDates.length]!,
    );
  const scenarioDefs: Array<[string, string, string, number | null]> = [
    ["Conservative quarter", "ربع متحفظ", "reviewed", null],
    ["Aggressive close", "إغلاق طموح", "draft", null],
    ["Renewals slip one month", "تأجيل التجديدات شهراً", "applied", rng.int(10, 60)],
  ];
  scenarioDefs.forEach(([en, ar, status, appliedDaysAgo], i) => {
    const slips = pickOpen(5, i * 3).map((o) => ({
      opportunityId: o.id,
      months: i === 1 ? -1 : 1,
    }));
    const excludes = pickOpen(2, i * 3 + 40).map((o) => o.id);
    const probabilities = pickOpen(3, i * 3 + 80).map((o) => ({
      opportunityId: o.id,
      probability: Math.min(100, Math.max(0, o.probability + (i === 1 ? 20 : -15))),
    }));
    const categories = pickOpen(2, i * 3 + 120).map((o) => ({
      opportunityId: o.id,
      category: i === 1 ? "commit" : "best_case",
    }));
    const created = ts(appliedDaysAgo === null ? rng.int(5, 90) : appliedDaysAgo + 7, 10);
    push("crm_scenario", {
      id: ctx.id("crm", "scenario", i),
      org_id: orgId,
      name: company.key === "saudimfg" ? ar : en,
      overlay: { slips, excludes, probabilities, categories },
      assumptions: paragraph(rng, company.key === "saudimfg" ? "ar" : "en", 2),
      status,
      applied_at: appliedDaysAgo === null ? null : ts(appliedDaysAgo, 16),
      applied_by: appliedDaysAgo === null ? null : uid("owner"),
      created_by: uid("manager"),
      created_at: created,
      updated_at: appliedDaysAgo === null ? created : ts(appliedDaysAgo, 16),
    });
  });

  // ── automations (4) and their execution history ───────────────────────────
  const ar = company.key === "saudimfg";
  type AutomationDef = {
    key: string;
    name: string;
    description: string;
    trigger: string;
    conditions: Row;
    actions: Row[];
    enabled: boolean;
    dryRun: boolean;
  };
  const automationDefs: AutomationDef[] = [
    {
      key: "stale_leads",
      name: ar ? "العملاء المحتملون الخاملون → مهمة متابعة" : "Stale leads → follow-up task",
      description: ar
        ? "ينشئ مهمة متابعة لكل عميل محتمل موثوق بلا تحديث لأسبوع."
        : "Creates a follow-up task for every trusted lead with no update for a week.",
      trigger: "lead_stale",
      conditions: {
        all: [
          { key: "idle_days", op: "gte", value: 7 },
          { key: "quarantine", op: "eq", value: "trusted" },
        ],
      },
      actions: [
        {
          kind: "create_task",
          title: ar ? "متابعة عميل محتمل خامل" : "Follow up on a quiet lead",
          dueInDays: 1,
          assignToOwner: true,
        },
        {
          kind: "notify",
          toOwner: true,
          title: ar ? "عميل محتمل بلا تحديث" : "A lead has gone quiet",
        },
      ],
      enabled: true,
      dryRun: false,
    },
    {
      key: "stalled_deals",
      name: ar ? "الصفقات المتوقفة → وضع علامة مخاطرة" : "Stalled deals → flag risk",
      description: ar
        ? "يضع علامة مخاطرة على أي فرصة بلا نشاط لثلاثين يوماً (تجريبي)."
        : "Flags a risk on any opportunity with no activity for thirty days (dry run).",
      trigger: "opportunity_stalled",
      conditions: { all: [{ key: "inactive_days", op: "gte", value: 30 }] },
      actions: [
        {
          kind: "flag_risk",
          title: ar ? "لا نشاط منذ ثلاثين يوماً" : "No activity for 30 days",
          severity: "medium",
        },
      ],
      enabled: true,
      dryRun: true,
    },
    {
      key: "slipped_close",
      name: ar
        ? "تجاوز تاريخ الإغلاق → إعادة إلى المسار"
        : "Slipped close dates → back to pipeline",
      description: ar
        ? "يعيد الفرص الملتزم بها التي تجاوزت تاريخ إغلاقها إلى فئة المسار."
        : "Moves committed opportunities past their close date back to the pipeline category.",
      trigger: "opportunity_close_date_passed",
      conditions: {
        all: [
          { key: "close_passed", op: "truthy" },
          { key: "forecast_category", op: "in", value: ["commit", "best_case"] },
        ],
      },
      actions: [
        { kind: "set_forecast_category", category: "pipeline" },
        { kind: "notify", toOwner: true, title: ar ? "تجاوز تاريخ الإغلاق" : "Close date passed" },
      ],
      enabled: false,
      dryRun: true,
    },
    {
      key: "unassigned_leads",
      name: ar ? "العملاء المحتملون بلا مالك → المدير" : "Unassigned leads → manager",
      description: ar
        ? "يسند أي عميل محتمل بلا مالك إلى مدير العمليات."
        : "Assigns any lead without an owner to the operations manager.",
      trigger: "lead_unassigned",
      conditions: { all: [{ key: "unassigned", op: "truthy" }] },
      actions: [{ kind: "assign_owner", userId: uid("manager") }],
      enabled: true,
      dryRun: false,
    },
  ];
  const automationIds = automationDefs.map((a) => ctx.id("crm", "automation", a.key));
  const staleLeads = leads
    .filter(
      (l) =>
        (l.status === "new" || l.status === "contacted") &&
        l.createdDaysAgo >= 7 &&
        l.ownerKey !== null,
    )
    .slice(0, 5);
  const stalledOpps = opps.filter((o) => o.status === "open" && o.stalled).slice(0, 4);
  const unownedLeads = leads
    .filter((l) => l.ownerKey === null && l.status !== "converted")
    .slice(0, 3);
  type RunM = {
    a: number;
    subjectType: string;
    subjectId: string;
    day: number;
    status: string;
    mode: string;
    ownerId: string | null;
  };
  const runs: RunM[] = [];
  for (let d = 0; d < 4; d++)
    for (const l of staleLeads)
      runs.push({
        a: 0,
        subjectType: "lead",
        subjectId: l.id,
        day: 2 + d * 7,
        status: weighted(rng, { applied: 7, skipped: 2, failed: 1 }),
        mode: "live",
        ownerId: l.ownerKey ? uid(l.ownerKey) : null,
      });
  for (let d = 0; d < 3; d++)
    for (const o of stalledOpps)
      runs.push({
        a: 1,
        subjectType: "opportunity",
        subjectId: o.id,
        day: 1 + d * 5,
        status: "matched",
        mode: "dry_run",
        ownerId: uid(o.ownerKey),
      });
  for (let d = 0; d < 2; d++)
    for (const l of unownedLeads)
      runs.push({
        a: 3,
        subjectType: "lead",
        subjectId: l.id,
        day: 3 + d * 9,
        status: d === 0 ? "applied" : "skipped",
        mode: "live",
        ownerId: null,
      });
  const lastRun = new Map<number, string>();
  runs.forEach((r, i) => {
    const a = automationDefs[r.a]!;
    const ranAt = ts(r.day, 2, 15);
    if (!lastRun.has(r.a) || ranAt > lastRun.get(r.a)!) lastRun.set(r.a, ranAt);
    const result =
      r.status === "applied"
        ? a.actions.map((x) =>
            x.kind === "create_task"
              ? { kind: "create_task", owner: r.ownerId ?? uid("manager") }
              : x.kind === "notify"
                ? { kind: "notify", to: r.ownerId ?? uid("manager") }
                : { kind: x.kind, userId: (x as { userId?: string }).userId },
          )
        : r.status === "matched"
          ? a.actions.map((x) => ({ wouldDo: x.kind, subject: r.subjectId }))
          : [];
    push("crm_automation_run", {
      id: ctx.id("crm", "run", i),
      org_id: orgId,
      automation_id: automationIds[r.a]!,
      subject_type: r.subjectType,
      subject_id: r.subjectId,
      occurrence_key: clock.dayAgo(r.day),
      mode: r.mode,
      status: r.status,
      result,
      error: r.status === "failed" ? "notification recipient has no active membership" : null,
      ran_at: ranAt,
      ran_by: r.mode === "live" ? uid("owner") : uid("manager"),
    });
    if (r.status === "applied" && a.actions.some((x) => x.kind === "create_task")) {
      const act = a.actions.find((x) => x.kind === "create_task")!;
      const dueDay = r.day - Number(act.dueInDays ?? 1);
      const done = dueDay > 3 && rng.chance(0.6);
      push("sales_activity", {
        id: ctx.id("crm", "auto-act", i),
        org_id: orgId,
        lead_id: r.subjectType === "lead" ? r.subjectId : null,
        opportunity_id: r.subjectType === "opportunity" ? r.subjectId : null,
        customer_id: null,
        contact_id: null,
        $contactFrac: null,
        kind: "task",
        custom_kind: null,
        title: act.title,
        body: null,
        due_date: clock.dayAgo(dueDay),
        completed_at: done ? ts(dueDay - 1, 14) : null,
        completed_by: done ? (r.ownerId ?? uid("manager")) : null,
        owner_user_id: r.ownerId ?? uid("manager"),
        actor_user_id: uid("owner"),
        outcome: null,
        participants: [],
        next_action: null,
        next_action_due: null,
        location: null,
        reminder_at: null,
        recurrence_days: null,
        template_key: null,
        meta: { automationId: automationIds[r.a], trigger: a.trigger },
        created_at: ranAt,
        updated_at: done ? ts(dueDay - 1, 14) : ranAt,
      });
    }
  });
  automationDefs.forEach((a, i) =>
    push("crm_automation", {
      id: automationIds[i]!,
      org_id: orgId,
      name: a.name,
      description: a.description,
      trigger: a.trigger,
      conditions: a.conditions,
      actions: a.actions,
      enabled: a.enabled,
      dry_run: a.dryRun,
      owner_user_id: uid("manager"),
      last_run_at: lastRun.get(i) ?? null,
      created_by: uid("admin"),
      created_at: ts(120 + i * 3, 10),
      updated_at: lastRun.get(i) ?? ts(120 + i * 3, 10),
    }),
  );

  // ── customer-success signals (on active customers; never the merged one) ──
  const nSig = Math.min(150, Math.max(1, Math.round(pool.length * 0.3)));
  const stride = Math.max(1, Math.floor(pool.length / nSig));
  let sigSeq = 0;
  for (let c = 0; c < nSig; c++) {
    const customerId = customerIds[pool[(c * stride) % pool.length]!]!;
    const k = rng.int(1, 2);
    for (let s = 0; s < k; s++) {
      const kind = weighted(rng, {
        satisfaction: 35,
        churn_risk: 25,
        onboarding: 15,
        adoption: 10,
        success_plan: 10,
        note: 5,
      });
      const d = rng.int(0, Math.min(400, firstDayAgo));
      const lang: "en" | "ar" = ar ? "ar" : "en";
      const score =
        kind === "satisfaction"
          ? rng.int(1, 5)
          : kind === "churn_risk" || kind === "adoption" || kind === "onboarding"
            ? rng.int(0, 100)
            : null;
      const status =
        kind === "churn_risk" || kind === "adoption"
          ? (kind === "churn_risk" ? (score ?? 0) >= 60 : (score ?? 0) < 40)
            ? "at_risk"
            : "healthy"
          : kind === "onboarding"
            ? score === 100
              ? "done"
              : "open"
            : kind === "success_plan"
              ? rng.chance(0.7)
                ? "open"
                : "done"
              : null;
      push("crm_customer_signal", {
        id: ctx.id("crm", "signal", sigSeq++),
        org_id: orgId,
        customer_id: customerId,
        kind,
        score,
        status,
        title:
          kind === "success_plan"
            ? lang === "ar"
              ? "خطة نجاح — التجديد السنوي"
              : "Success plan — annual renewal"
            : kind === "satisfaction"
              ? lang === "ar"
                ? "استبيان ما بعد التسليم"
                : "Post-delivery survey"
              : null,
        body: rng.chance(0.6) ? sentence(rng, lang) : null,
        due_on: kind === "success_plan" ? clock.dayAhead(rng.int(10, 120)) : null,
        recorded_at: ts(d, 13),
        created_by: uid("manager"),
        created_at: ts(d, 13),
        updated_at: ts(d, 13),
      });
    }
  }

  // ── one reviewed merge ────────────────────────────────────────────────────
  // The source is the newest active customer and nothing in this family references
  // it, so the product's "rows re-pointed" evidence is honestly zero everywhere.
  const mergeId = ctx.id("crm", "merge", 0);
  const mergeDaysAgo = rng.int(5, 200);
  const repointed = Object.fromEntries(
    [
      "customer_contact",
      "customer_update",
      "quote",
      "invoice",
      "payment",
      "job",
      "opportunity",
      "lead",
      "sales_activity",
      "crm_consent",
      "crm_touch",
      "crm_customer_signal",
      "doc_document",
    ].map((t) => [t, 0]),
  );
  push("crm_merge", {
    id: mergeId,
    org_id: orgId,
    source_customer_id: merge.sourceId,
    target_customer_id: merge.targetId,
    preview: { conflicts: [], counts: repointed },
    resolutions: {},
    source_snapshot: { $snapshotOf: merge.sourceId },
    target_snapshot: { $snapshotOf: merge.targetId },
    repointed,
    reason: ar
      ? "سجل مكرر أنشئ من نموذج الموقع؛ تمت المراجعة والدمج."
      : "Duplicate record created from the website form; reviewed and merged.",
    applied_at: ts(mergeDaysAgo, 15),
    applied_by: uid("admin"),
    created_at: ts(mergeDaysAgo, 15),
  });
  push("sales_activity", {
    id: ctx.id("crm", "merge-act", 0),
    org_id: orgId,
    lead_id: null,
    opportunity_id: null,
    customer_id: merge.targetId,
    contact_id: null,
    $contactFrac: null,
    kind: "merged",
    custom_kind: null,
    title: "Merged a duplicate into this customer",
    body: ar ? "سجل مكرر أنشئ من نموذج الموقع" : "Duplicate record created from the website form",
    due_date: null,
    completed_at: null,
    completed_by: null,
    owner_user_id: uid("admin"),
    actor_user_id: uid("admin"),
    outcome: null,
    participants: [],
    next_action: null,
    next_action_due: null,
    location: null,
    reminder_at: null,
    recurrence_days: null,
    template_key: null,
    meta: { mergeId, sourceId: merge.sourceId, repointed },
    created_at: ts(mergeDaysAgo, 15),
    updated_at: ts(mergeDaysAgo, 15),
  });

  return {
    company,
    orgId,
    users,
    currency,
    refs,
    territoryIds,
    campaignIds,
    automationIds,
    leads,
    opps,
    tables,
    convert,
    services,
    expectedWonMinor,
    expectedWonCount,
    expectedOpenCount,
    expectedOpenMinor,
    merge,
  };
}

/** The model for a context, built once (ctx.rng is consumed exactly once per context). */
export function model(ctx: LabContext): Model {
  let m = MODEL_CACHE.get(ctx);
  if (!m) {
    m = buildModel(ctx);
    MODEL_CACHE.set(ctx, m);
  }
  return m;
}

/** Rows the service subset creates beyond the batch inserts, per table. */
export function serviceRowsOf(m: Model): Record<string, number> {
  const s = m.services;
  return { opportunity: s.convert, sales_activity: s.win + s.lose + s.move + s.convert };
}

/** Expected row counts from the model alone — the dry-run budget figure. */
export function expectedCounts(m: Model): Record<string, number> {
  const svc = serviceRowsOf(m);
  const out: Record<string, number> = {};
  for (const t of CRM_TABLES) out[t] = m.tables[t].length + (svc[t] ?? 0);
  return out;
}

// ── the live references: contacts and the merged customers' row images ──────

export type LiveRefs = {
  contactsByCustomer: Map<string, string[]>;
  /** Customer id → the row image the merge evidence stores. */
  snapshots: Record<string, Row>;
};
export const EMPTY_LIVE: LiveRefs = { contactsByCustomer: new Map(), snapshots: {} };

async function loadLive(ctx: LabContext, m: Model): Promise<LiveRefs> {
  if (ctx.dryRun) return EMPTY_LIVE;
  const contacts = (await ctx.sql`
    select id::text as id, customer_id::text as customer_id from public.customer_contact
    where org_id = ${ctx.orgId} and active order by created_at, id
  `) as unknown as Array<{ id: string; customer_id: string }>;
  const contactsByCustomer = new Map<string, string[]>();
  for (const c of contacts)
    contactsByCustomer.set(c.customer_id, [...(contactsByCustomer.get(c.customer_id) ?? []), c.id]);
  const ids = [m.merge.sourceId, m.merge.targetId];
  const images = (await ctx.sql`
    select id::text as id, row_to_json(c) as snapshot from public.customer c
    where org_id = ${ctx.orgId} and id = any(${ids}::uuid[])
  `) as unknown as Array<{ id: string; snapshot: Row }>;
  const snapshots: Record<string, Row> = {};
  for (const r of images) snapshots[r.id] = r.snapshot;
  return { contactsByCustomer, snapshots };
}

// ── materialisation: resolve `$…` placeholders, no randomness ───────────────

export function materialize(m: Model, live: LiveRefs): Record<string, Row[]> {
  const contactOf = (customerId: unknown, frac: unknown): string | null => {
    if (!customerId || frac === null || frac === undefined) return null;
    const list = live.contactsByCustomer.get(String(customerId));
    if (!list || list.length === 0) return null;
    return list[Math.min(list.length - 1, Math.floor(Number(frac) * list.length))]!;
  };
  const strip = (row: Row): Row => {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) if (!k.startsWith("$")) out[k] = v;
    return out;
  };
  const snapshotOf = (v: unknown): Row => {
    const id = String((v as Row).$snapshotOf);
    return live.snapshots[id] ?? { id };
  };
  const out: Record<string, Row[]> = {};
  for (const table of CRM_TABLES) {
    out[table] = m.tables[table].map((row) => {
      const r: Row = { ...row };
      switch (table) {
        case "sales_activity":
          r.contact_id = contactOf(r.customer_id, r.$contactFrac);
          break;
        case "crm_opportunity_stakeholder":
          r.contact_id = contactOf(r.$cust, r.$contactFrac);
          break;
        case "crm_merge":
          r.source_snapshot = snapshotOf(r.source_snapshot);
          r.target_snapshot = snapshotOf(r.target_snapshot);
          break;
        default:
          break;
      }
      return strip(r);
    });
  }
  return out;
}

// ── the family ──────────────────────────────────────────────────────────────

function plan(ctx: LabContext): FamilyPlan {
  return { family: "crm", expected: expectedCounts(model(ctx)) };
}

export type SeedOptions = {
  /** Drive the representative subset through the product's services (default: not in dry-run). */
  services?: boolean;
};

export async function seedCrm(ctx: LabContext, opts: SeedOptions = {}): Promise<FamilyReport> {
  const services = opts.services ?? !ctx.dryRun;
  const m = model(ctx);
  const live = await loadLive(ctx, m);
  const rows = materialize(m, live);
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  for (const t of CRM_TABLES) {
    const r = await ctx.insert(t, rows[t] ?? []);
    counts[t] = r.attempted;
    ctx.log(`${t}: ${r.attempted} rows`);
  }

  // The merge retires its source customer exactly as the product's merge does.
  if (!ctx.dryRun) {
    await ctx.sql`
      update public.customer
      set active = false, merged_into_customer_id = ${m.merge.targetId}, updated_at = now()
      where id = ${m.merge.sourceId} and org_id = ${ctx.orgId} and merged_into_customer_id is null
    `;
  }

  // A representative subset through the product's own services (audited, real timestamps).
  const svc = { win: 0, lose: 0, move: 0, convert: 0 };
  if (services && !ctx.dryRun) {
    const mgr = ctx.ctxFor("manager");
    const arch = ctx.archetypeOf("manager");
    for (const o of m.opps) {
      if (o.service === null) continue;
      try {
        if (o.service === "win") {
          const r = await winOpportunity(mgr, arch, o.id);
          if (r.changed) svc.win++;
        } else if (o.service === "lose") {
          const r = await loseOpportunity(mgr, arch, o.id, {
            reason: o.lossReason,
            note: o.lossNote ?? undefined,
          });
          if (r.changed) svc.lose++;
        } else {
          const r = await moveStage(mgr, arch, {
            id: o.id,
            stageKey: o.moveToKey,
            rowVersion: 1,
            reason:
              o.lang === "ar" ? "تأهلت بعد مكالمة الاستكشاف" : "Qualified after the discovery call",
          });
          if (r.moved) svc.move++;
        }
      } catch (e) {
        notes.push(`${o.service} ${o.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    for (const c of m.convert) {
      try {
        const r = await convertLeadSafely(mgr, arch, {
          leadId: c.lead.id,
          opportunityName: c.name,
          customerId: c.customerId,
          estimatedValueMinor: c.valueMinor,
          expectedCloseDate: c.closeDate,
        });
        if (!r.deduped) svc.convert++;
      } catch (e) {
        notes.push(`convert ${c.lead.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    // Service-created rows join the default pipeline the way the product attaches them.
    const owner: Ctx = ctx.ctxFor("owner");
    await withCtx(owner, (tx) => ensurePipelinesIn(tx, owner));
    counts.opportunity = (counts.opportunity ?? 0) + svc.convert;
    counts.sales_activity =
      (counts.sales_activity ?? 0) + svc.win + svc.lose + svc.move + svc.convert;
    notes.push(
      `services: ${svc.win} won, ${svc.lose} lost, ${svc.move} moved, ${svc.convert} converted`,
    );
  }

  const openSample = m.opps
    .filter((o) => o.status === "open" && o.service === null && !o.archived)
    .slice(0, 5)
    .map((o) => o.id);
  return {
    family: "crm",
    counts,
    handoff: {
      pipelineIds: Object.fromEntries(m.refs.pipelines.map((p) => [p.key, p.id])),
      territoryIds: m.territoryIds,
      campaignIds: m.campaignIds,
      automationIds: m.automationIds,
      leadCount: m.leads.length,
      opportunityCount: m.opps.length + m.services.convert,
      openOpportunitySample: openSample,
      wonOpportunitySample: m.opps
        .filter((o) => o.status === "won")
        .slice(0, 5)
        .map((o) => o.id),
      qualifiedLeadSample: m.leads
        .filter((l) => l.status === "qualified" && !l.serviceConvert)
        .slice(0, 3)
        .map((l) => l.id),
      mergedCustomerId: m.merge.sourceId,
      survivorCustomerId: m.merge.targetId,
      idScheme: {
        lead: ["crm", "lead", "<i>"],
        opportunity: ["crm", "opp", "<i>"],
        activity: ["crm", "act", "<oppIdx>", "<j>"],
      },
    },
    notes,
  };
}

async function verify(ctx: LabContext): Promise<Check[]> {
  const m = model(ctx);
  const expected = expectedCounts(m);
  const org = ctx.orgId;
  const checks: Check[] = [];
  const one = async <T extends Record<string, unknown>>(q: Promise<unknown>): Promise<T> =>
    ((await q) as unknown as T[])[0]!;
  const P = ctx.company.profile;

  const counted: Record<string, number> = {};
  for (const t of CRM_TABLES) {
    const r = await one<{ n: number }>(
      ctx.sql.unsafe(`select count(*)::int as n from public.${t} where org_id = $1`, [org]),
    );
    counted[t] = Number(r.n);
    checks.push({
      name: `count ${t}`,
      ok: counted[t] >= expected[t]!,
      detail: `db=${counted[t]} plan=${expected[t]}`,
    });
  }
  if (P.opportunities > 1205)
    checks.push({
      name: "opportunities > 1,205",
      ok: counted.opportunity! > 1205,
      detail: String(counted.opportunity),
    });
  if (P.leads > 1205)
    checks.push({ name: "leads > 1,205", ok: counted.lead! > 1205, detail: String(counted.lead) });
  if (P.opportunities * P.activitiesPerOpportunity[0] > 1205)
    checks.push({
      name: "activities > 1,205",
      ok: counted.sales_activity! > 1205,
      detail: String(counted.sales_activity),
    });

  const stage = await one<{
    unknown_stage: number;
    open_in_closed: number;
    won_off: number;
    lost_off: number;
    no_pipeline: number;
    cross_pipeline: number;
  }>(ctx.sql`
    select
      count(*) filter (where s.key is null)::int as unknown_stage,
      count(*) filter (where o.status = 'open' and s.category <> 'open')::int as open_in_closed,
      count(*) filter (where o.status = 'won' and s.category <> 'won')::int as won_off,
      count(*) filter (where o.status = 'lost' and s.category <> 'lost')::int as lost_off,
      count(*) filter (where o.pipeline_id is null)::int as no_pipeline,
      count(*) filter (where s.pipeline_id is distinct from o.pipeline_id)::int as cross_pipeline
    from public.opportunity o
    left join public.pipeline_stage s on s.org_id = o.org_id and s.key = o.stage_key
    where o.org_id = ${org}
  `);
  checks.push({
    name: "every opportunity sits in a stage of its status's category, in its own pipeline",
    ok:
      Number(stage.unknown_stage) +
        Number(stage.open_in_closed) +
        Number(stage.won_off) +
        Number(stage.lost_off) +
        Number(stage.no_pipeline) +
        Number(stage.cross_pipeline) ===
      0,
    detail: JSON.stringify(stage),
  });

  const byStage = (await ctx.sql`
    select stage_key, count(*)::int as n, coalesce(sum(estimated_value_minor), 0)::bigint as v
    from public.opportunity where org_id = ${org} and status = 'open' and archived = false
    group by stage_key
  `) as unknown as Array<{ stage_key: string; n: number; v: string }>;
  const total = await one<{ n: number; v: string }>(ctx.sql`
    select count(*)::int as n, coalesce(sum(estimated_value_minor), 0)::bigint as v
    from public.opportunity where org_id = ${org} and status = 'open' and archived = false
  `);
  const stageN = byStage.reduce((s, r) => s + Number(r.n), 0);
  const stageV = byStage.reduce((s, r) => s + Number(r.v), 0);
  checks.push({
    name: "pipeline totals by stage equal the open opportunities",
    ok: stageN === Number(total.n) && stageV === Number(total.v) && byStage.length > 0,
    detail: `${byStage.length} stages, ${stageN}/${total.n} open, ${stageV}/${total.v} minor`,
  });
  checks.push({
    name: "open pipeline matches the model (bulk rows + service moves + conversions)",
    ok: Number(total.n) === m.expectedOpenCount && Number(total.v) === m.expectedOpenMinor,
    detail: `db ${total.n} open = ${total.v}; model ${m.expectedOpenCount} open = ${m.expectedOpenMinor}`,
  });

  const won = await one<{ n: number; v: string; without_ts: number; without_mark: number }>(
    ctx.sql`
    select count(*)::int as n, coalesce(sum(estimated_value_minor), 0)::bigint as v,
           count(*) filter (where won_at is null)::int as without_ts,
           count(*) filter (where not exists (
             select 1 from public.sales_activity a
             where a.org_id = o.org_id and a.opportunity_id = o.id and a.kind = 'won'))::int as without_mark
    from public.opportunity o where o.org_id = ${org} and o.status = 'won'
  `,
  );
  checks.push({
    name: "won total matches the model (direct + service wins)",
    ok: Number(won.v) === m.expectedWonMinor && Number(won.n) === m.expectedWonCount,
    detail: `db ${won.n} won = ${won.v}; model ${m.expectedWonCount} won = ${m.expectedWonMinor}`,
  });
  const lost = await one<{ bad: number; without_mark: number }>(ctx.sql`
    select count(*) filter (where lost_at is null or loss_reason is null)::int as bad,
           count(*) filter (where not exists (
             select 1 from public.sales_activity a
             where a.org_id = o.org_id and a.opportunity_id = o.id and a.kind = 'lost'))::int as without_mark
    from public.opportunity o where o.org_id = ${org} and o.status = 'lost'
  `);
  checks.push({
    name: "won/lost rows carry their timestamp, reason and lifecycle activity",
    ok:
      Number(won.without_ts) +
        Number(won.without_mark) +
        Number(lost.bad) +
        Number(lost.without_mark) ===
      0,
    detail: `won without ts ${won.without_ts}, without mark ${won.without_mark}; lost bad ${lost.bad}, without mark ${lost.without_mark}`,
  });

  const conv = await one<{ converted: number; linked: number; broken: number; with_lead: number }>(
    ctx.sql`
    select count(*) filter (where l.status = 'converted')::int as converted,
           count(*) filter (where l.status = 'converted' and l.converted_at is not null
                              and o.id is not null and o.lead_id = l.id)::int as linked,
           count(*) filter (where l.status = 'converted'
                              and (l.converted_at is null or o.id is null or o.lead_id <> l.id))::int as broken,
           (select count(*)::int from public.opportunity x
             where x.org_id = ${org} and x.lead_id is not null) as with_lead
    from public.lead l
    left join public.opportunity o on o.id = l.converted_opportunity_id and o.org_id = l.org_id
    where l.org_id = ${org}
  `,
  );
  checks.push({
    name: "every converted lead links to the opportunity that links back",
    ok:
      Number(conv.broken) === 0 &&
      Number(conv.converted) === Number(conv.linked) &&
      Number(conv.with_lead) === Number(conv.converted),
    detail: JSON.stringify(conv),
  });

  const snaps = (await ctx.sql`
    select s.period_key, s.totals, s.row_count, r.n, r.n_all, r.pipeline, r.weighted, r.commit, r.best
    from public.crm_forecast_snapshot s
    cross join lateral (
      select count(*) filter (where o.forecast_category <> 'omitted')::int as n,
             count(*)::int as n_all,
             coalesce(sum(coalesce(o.estimated_value_minor, 0))
               filter (where o.forecast_category <> 'omitted'), 0)::bigint as pipeline,
             coalesce(sum(round(coalesce(o.estimated_value_minor, 0)
               * coalesce(o.probability, st.default_probability, 0) / 100.0))
               filter (where o.forecast_category <> 'omitted'), 0)::bigint as weighted,
             coalesce(sum(coalesce(o.estimated_value_minor, 0))
               filter (where o.forecast_category = 'commit'), 0)::bigint as commit,
             coalesce(sum(coalesce(o.estimated_value_minor, 0))
               filter (where o.forecast_category in ('commit', 'best_case')), 0)::bigint as best
      from public.opportunity o
      left join public.pipeline_stage st on st.org_id = o.org_id and st.key = o.stage_key
      where o.org_id = s.org_id and o.archived = false and o.created_at <= s.captured_at
        and (o.status = 'open' or coalesce(o.won_at, o.lost_at) > s.captured_at)
        and to_char(o.expected_close_date, 'YYYY-MM') = s.period_key
    ) r
    where s.org_id = ${org}
  `) as unknown as Array<{
    period_key: string;
    totals: Record<string, number>;
    row_count: number;
    n: number;
    n_all: number;
    pipeline: string;
    weighted: string;
    commit: string;
    best: string;
  }>;
  const badSnaps = snaps.filter(
    (s) =>
      Number(s.totals.count) !== Number(s.n) ||
      Number(s.row_count) !== Number(s.n_all) ||
      Number(s.totals.pipelineMinor) !== Number(s.pipeline) ||
      Number(s.totals.weightedMinor) !== Number(s.weighted) ||
      Number(s.totals.commitMinor) !== Number(s.commit) ||
      Number(s.totals.bestCaseMinor) !== Number(s.best),
  );
  checks.push({
    name: "forecast snapshot totals equal the opportunities open at capture for that period",
    ok: snaps.length === SNAPSHOT_MONTHS && badSnaps.length === 0,
    detail: badSnaps.length
      ? `${badSnaps.length} off: ${badSnaps.map((s) => s.period_key).join(", ")}`
      : `${snaps.length} snapshots reconcile`,
  });

  // Product lines: the value the model derived with the product's formula is what the row carries.
  const netByOpp = new Map<string, number>();
  for (const p of m.tables.crm_opportunity_product) {
    if (p.optional) continue;
    const line = computeLine({
      qty: Number(p.qty),
      unitPriceMinor: Number(p.unit_price_minor),
      discountPct: Number(p.discount_pct),
      vatRate: Number(p.vat_rate),
      unitCostMinor: null,
    });
    const id = String(p.opportunity_id);
    netByOpp.set(id, (netByOpp.get(id) ?? 0) + line.lineNetMinor);
  }
  const pricedIds = [...netByOpp.keys()];
  const priced = (await ctx.sql`
    select id::text as id, estimated_value_minor::bigint as v from public.opportunity
    where org_id = ${org} and id = any(${pricedIds}::uuid[])
  `) as unknown as Array<{ id: string; v: string }>;
  const priceOff = priced.filter((r) => Number(r.v) !== netByOpp.get(r.id)).length;
  checks.push({
    name: "opportunity value equals the sum of its non-optional product lines",
    ok: priceOff === 0 && priced.length === pricedIds.length && pricedIds.length > 0,
    detail: `${priced.length}/${pricedIds.length} priced opportunities found, ${priceOff} off`,
  });

  const disc = await one<{ n: number; pending_closed: number; arithmetic_off: number }>(ctx.sql`
    select count(*)::int as n,
           count(*) filter (where d.status = 'pending' and o.status <> 'open')::int as pending_closed,
           count(*) filter (where abs(d.discounted_total_minor
             - round(d.list_total_minor * (1 - d.requested_pct / 100.0))) > 1)::int as arithmetic_off
    from public.crm_discount d join public.opportunity o on o.id = d.opportunity_id
    where d.org_id = ${org}
  `);
  checks.push({
    name: "discounts: pending only on open opportunities, arithmetic reconciles",
    ok: Number(disc.pending_closed) + Number(disc.arithmetic_off) === 0 && Number(disc.n) > 0,
    detail: JSON.stringify(disc),
  });

  const runs = await one<{ n: number; live_on_dry: number; statuses: number }>(ctx.sql`
    select count(*)::int as n,
           count(*) filter (where r.mode = 'live' and (a.dry_run or not a.enabled))::int as live_on_dry,
           count(distinct r.status)::int as statuses
    from public.crm_automation_run r join public.crm_automation a on a.id = r.automation_id
    where r.org_id = ${org}
  `);
  checks.push({
    name: "automation runs: live only for enabled live automations; a mix of outcomes",
    ok: Number(runs.live_on_dry) === 0 && Number(runs.statuses) >= 3,
    detail: JSON.stringify(runs),
  });

  const overdue = await one<{ n: number; done: number }>(ctx.sql`
    select count(*) filter (where kind in ('follow_up', 'task') and completed_at is null
                              and due_date < ${ctx.company.history.asOf}::date)::int as n,
           count(*) filter (where completed_at is not null and outcome is not null)::int as done
    from public.sales_activity where org_id = ${org}
  `);
  checks.push({
    name: "overdue follow-ups and completed engagements with outcomes both exist",
    ok: Number(overdue.n) > 0 && Number(overdue.done) > 0,
    detail: JSON.stringify(overdue),
  });

  const touches = await one<{ n: number; off: number }>(ctx.sql`
    select count(*)::int as n,
           count(*) filter (where coalesce(l.campaign_id, o.campaign_id) is distinct from t.campaign_id)::int as off
    from public.crm_touch t
    left join public.lead l on l.id = t.lead_id and l.org_id = t.org_id
    left join public.opportunity o on o.id = t.opportunity_id and o.org_id = t.org_id
    where t.org_id = ${org}
  `);
  checks.push({
    name: "every attribution touch cites the campaign its lead or opportunity is attributed to",
    ok: Number(touches.n) > 0 && Number(touches.off) === 0,
    detail: JSON.stringify(touches),
  });

  const targets = await one<{ org_n: number; user_n: number; terr_n: number; late: number }>(
    ctx.sql`
    select count(*) filter (where scope_kind = 'org')::int as org_n,
           count(*) filter (where scope_kind = 'user')::int as user_n,
           count(*) filter (where scope_kind = 'territory')::int as terr_n,
           count(*) filter (where effective_from > period_start + 15)::int as late
    from public.crm_target where org_id = ${org}
  `,
  );
  checks.push({
    name: "targets cover org, owners and territories",
    ok:
      Number(targets.org_n) > 0 &&
      Number(targets.user_n) > 0 &&
      Number(targets.terr_n) > 0 &&
      Number(targets.late) === 0,
    detail: JSON.stringify(targets),
  });

  const merge = await one<{ n: number; retired: number; referenced: number }>(ctx.sql`
    select count(*)::int as n,
           count(*) filter (where c.active = false
                              and c.merged_into_customer_id = m.target_customer_id)::int as retired,
           (select count(*)::int from public.opportunity o
             where o.org_id = m.org_id and o.customer_id = m.source_customer_id)
           + (select count(*)::int from public.lead l
               where l.org_id = m.org_id and (l.converted_customer_id = m.source_customer_id
                                              or l.referrer_customer_id = m.source_customer_id))
           + (select count(*)::int from public.crm_customer_signal s
               where s.org_id = m.org_id and s.customer_id = m.source_customer_id) as referenced
    from public.crm_merge m join public.customer c on c.id = m.source_customer_id
    where m.org_id = ${org}
    group by m.org_id, m.source_customer_id, m.target_customer_id
  `);
  checks.push({
    name: "the merged customer is retired, points at its survivor and owns no CRM rows",
    ok: Number(merge.n) === 1 && Number(merge.retired) === 1 && Number(merge.referenced) === 0,
    detail: JSON.stringify(merge),
  });

  const leads = await one<{
    quarantined: number;
    disqualified_without_reason: number;
    money_off: number;
  }>(ctx.sql`
    select count(*) filter (where quarantine <> 'trusted')::int as quarantined,
           count(*) filter (where status = 'disqualified' and disqualify_reason is null)::int as disqualified_without_reason,
           count(*) filter (where (estimated_value_minor is null) <> (currency is null))::int as money_off
    from public.lead where org_id = ${org}
  `);
  checks.push({
    name: "leads: quarantine present, disqualifications reasoned, money paired with currency",
    ok:
      Number(leads.quarantined) > 0 &&
      Number(leads.disqualified_without_reason) === 0 &&
      Number(leads.money_off) === 0,
    detail: JSON.stringify(leads),
  });

  return checks;
}

export const crm: Family = {
  key: "crm",
  deps: ["setup", "people", "masters"],
  appliesTo: (company: Company) => company.profile.enables.revenue,
  plan,
  seed: (ctx) => seedCrm(ctx),
  verify,
};
