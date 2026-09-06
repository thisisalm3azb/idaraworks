/**
 * H33 Pilot Lab — family "assets": the register of what the company OWNS and
 * uses, as opposed to what it holds to consume or sell.
 *
 *   asset · asset_assignment (the append-only custody trail) · asset_inspection ·
 *   asset_maintenance_plan + asset_maintenance_event (pointing at real H21 jobs
 *   where work was raised) · asset_downtime · asset_disposal + its approval ·
 *   asset_depreciation_run + asset_depreciation_line · reference_sequence.
 *
 * How it is built
 *
 * 1. `buildAssetsModel(ctx)` is PURE: every random choice comes from `ctx.rng`,
 *    every id from `ctx.id`, every date from `ctx.clock`. It is memoised per
 *    context so `plan()`, `seed()` and `verify()` see the same draws — the plan
 *    counts ARE the rows seed writes, which is what makes the dry-run an honest
 *    budget.
 * 2. Every asset is inserted in its BORN state — `draft`, exactly what
 *    `registerAsset` writes — and then moved to its planned state through the
 *    same guarded UPDATE the service issues, so `asset_status_transition` (the
 *    database's state machine) is the law for every row. `disposed` is never
 *    written by hand: it is reached only by completing an approved disposal
 *    through the real service.
 * 3. Bulk history (custody events, inspections, plans, maintenance events,
 *    downtime spells, depreciation lines) is written directly in the states the
 *    product's own paths write, with reconciling values: the custodian on the
 *    asset is the one the latest custody event implies; the condition is what
 *    the latest inspection found; a plan's next due date is its last service
 *    plus its interval; every depreciation line continues the running sum and
 *    never crosses cost − residual; every run's total is the sum of its lines.
 * 4. A representative sample is then driven through the REAL services —
 *    custody (assign / transfer / return), inspection, maintenance plan and
 *    event, downtime, status moves, disposal decisions and completion, and one
 *    depreciation run posted through the finance service — so the audit log,
 *    activity feed, notifications, approval engine and journal posting are all
 *    exercised and those rows are indistinguishable from application writes.
 *    Nothing service-driven runs under `ctx.dryRun`, or when the context
 *    carries `skipServices: true` (the unit test's seam).
 *
 * Historical depreciation runs carry no journal entry: the periods they fall
 * in are locked or soft-closed by the fiscal calendar law, and the product
 * itself could not post there today. The run for the last complete month is
 * made by the finance service and posts a real, balanced entry.
 */
import type { Rng } from "../../simulation/rng";
import type {
  Check,
  Company,
  CompanyKey,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../types";
import {
  city,
  historyDays,
  longTitle,
  paragraph,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  weighted,
} from "./_shared";

export const FAMILY = "assets";
export const PAGINATION_THRESHOLD = 1205;

type Row = Record<string, unknown>;

export type AssetStatus =
  | "draft"
  | "in_service"
  | "in_storage"
  | "under_maintenance"
  | "in_transit"
  | "lost"
  | "retired"
  | "disposed";
export type Condition = "new" | "good" | "fair" | "poor" | "unserviceable";
type Source = "purchase" | "transfer_in" | "donation" | "lease" | "built" | "opening_balance";
type DisposalMethod =
  "sale" | "scrap" | "donation" | "trade_in" | "write_off" | "returned_to_lessor";
type DisposalOutcome = "complete" | "reject" | "pending";

/** The tables this family writes, in foreign-key order. */
export const ASSET_TABLES = [
  "asset",
  "asset_assignment",
  "asset_inspection",
  "asset_maintenance_plan",
  "asset_maintenance_event",
  "asset_downtime",
  "asset_disposal",
  "approval",
  "asset_depreciation_run",
  "asset_depreciation_line",
  "reference_sequence",
] as const;

/** States the family may write directly: the born state of each table. */
export const BORN_STATES = {
  asset: "draft",
  asset_disposal: "submitted",
  approval: "pending",
  asset_depreciation_run: "posted",
} as const;

// ── Category vocabulary (mirrors the setup family's category defaults) ──────

type CatDefault = { life: number; residualPct: number; cost: [number, number] };
/** Useful life / residual defaults are what `registerAsset` copies from the category. Cost in major units. */
const CATEGORY_DEFAULTS: Record<string, CatDefault> = {
  VEH: { life: 60, residualPct: 10, cost: [120_000, 260_000] },
  "VEH-LCV": { life: 60, residualPct: 10, cost: [65_000, 130_000] },
  "VEH-CAR": { life: 60, residualPct: 15, cost: [55_000, 140_000] },
  IT: { life: 36, residualPct: 0, cost: [2_000, 12_000] },
  "IT-LAP": { life: 36, residualPct: 0, cost: [2_500, 9_000] },
  "IT-NET": { life: 48, residualPct: 0, cost: [3_000, 45_000] },
  OFF: { life: 84, residualPct: 0, cost: [400, 9_000] },
  TOOL: { life: 48, residualPct: 0, cost: [250, 18_000] },
  OLD: { life: 12, residualPct: 0, cost: [1_000, 10_000] },
  PLANT: { life: 120, residualPct: 5, cost: [15_000, 120_000] },
  "PLANT-EXC": { life: 120, residualPct: 10, cost: [180_000, 900_000] },
  "PLANT-GEN": { life: 96, residualPct: 5, cost: [45_000, 260_000] },
  "PLANT-CNC": { life: 120, residualPct: 5, cost: [220_000, 1_400_000] },
  "PLANT-WELD": { life: 72, residualPct: 0, cost: [6_000, 40_000] },
  MHE: { life: 84, residualPct: 5, cost: [3_000, 40_000] },
  "MHE-FLT": { life: 84, residualPct: 5, cost: [55_000, 140_000] },
  HVAC: { life: 120, residualPct: 5, cost: [12_000, 160_000] },
  "TOOL-TEST": { life: 48, residualPct: 0, cost: [1_500, 25_000] },
};

/** What each company owns, by weight. `OLD` is the inactive class — its assets are retired. */
const CATEGORY_MIX: Record<CompanyKey, Record<string, number>> = {
  gulfbuild: {
    "VEH-LCV": 18,
    VEH: 6,
    "VEH-CAR": 4,
    "PLANT-EXC": 10,
    "PLANT-GEN": 8,
    PLANT: 8,
    TOOL: 22,
    "IT-LAP": 12,
    "IT-NET": 3,
    OFF: 8,
    OLD: 1,
  },
  tradeline: {
    "MHE-FLT": 15,
    MHE: 10,
    "VEH-LCV": 15,
    "VEH-CAR": 6,
    "IT-LAP": 20,
    "IT-NET": 6,
    OFF: 20,
    TOOL: 7,
    OLD: 1,
  },
  saudimfg: {
    "PLANT-CNC": 12,
    "PLANT-WELD": 12,
    PLANT: 10,
    TOOL: 22,
    "VEH-LCV": 6,
    VEH: 4,
    "IT-LAP": 14,
    "IT-NET": 5,
    OFF: 12,
    OLD: 3,
  },
  consult: { "IT-LAP": 45, "IT-NET": 8, OFF: 35, "VEH-CAR": 8, TOOL: 2, OLD: 2 },
  facilico: {
    HVAC: 15,
    "TOOL-TEST": 10,
    TOOL: 25,
    "VEH-LCV": 22,
    "VEH-CAR": 3,
    "IT-LAP": 12,
    "IT-NET": 3,
    OFF: 8,
    OLD: 2,
  },
};

/** Generic product names — no manufacturer, no model number, no plate. */
const NAMES: Record<string, Array<[string, string]>> = {
  VEH: [
    ["Flatbed truck 7 t", "شاحنة مسطحة 7 طن"],
    ["Water tanker 10,000 l", "صهريج مياه 10,000 لتر"],
    ["Crew bus 26-seat", "حافلة عمال 26 مقعداً"],
  ],
  "VEH-LCV": [
    ["Double-cab pickup 2.4 L", "بيك أب مزدوج الكابينة 2.4 لتر"],
    ["Panel van 3.5 t", "فان مغلق 3.5 طن"],
    ["Crew bus 14-seat", "حافلة طاقم 14 مقعداً"],
    ["Single-cab pickup 2.0 L", "بيك أب مفرد الكابينة 2.0 لتر"],
  ],
  "VEH-CAR": [
    ["Sedan 1.6 L pool car", "سيارة سيدان 1.6 لتر للاستخدام المشترك"],
    ["SUV 2.5 L site car", "سيارة دفع رباعي 2.5 لتر للموقع"],
    ["Hatchback 1.4 L runabout", "سيارة هاتشباك 1.4 لتر"],
  ],
  IT: [
    ["Desktop workstation", "محطة عمل مكتبية"],
    ["Wide-format printer", "طابعة كبيرة الحجم"],
  ],
  "IT-LAP": [
    ["14-inch business laptop", "حاسوب محمول 14 بوصة"],
    ["15-inch engineering workstation", "محطة عمل هندسية 15 بوصة"],
    ["10-inch site tablet (rugged)", "جهاز لوحي 10 بوصة للموقع"],
    ["13-inch ultrabook", "حاسوب محمول خفيف 13 بوصة"],
  ],
  "IT-NET": [
    ["48-port PoE switch", "محول شبكة 48 منفذ PoE"],
    ["Rack server 2U", "خادم رفوف 2U"],
    ["Firewall appliance", "جهاز جدار حماية"],
    ["Wireless access point (outdoor)", "نقطة وصول لاسلكية خارجية"],
    ["UPS 3 kVA rack-mount", "مزود طاقة غير منقطع 3 ك.ف.أ"],
  ],
  OFF: [
    ["Executive desk 180 cm", "مكتب تنفيذي 180 سم"],
    ["Ergonomic task chair", "كرسي مكتب مريح"],
    ["Meeting table 8-seat", "طاولة اجتماعات 8 مقاعد"],
    ["Filing cabinet 4-drawer", "خزانة ملفات 4 أدراج"],
    ["Reception counter", "كاونتر استقبال"],
    ["Whiteboard 240 cm", "سبورة بيضاء 240 سم"],
  ],
  TOOL: [
    ["Cordless drill driver 18 V", "مثقاب لاسلكي 18 فولت"],
    ["Angle grinder 230 mm", "جلاخة زاوية 230 مم"],
    ["Rotary laser level", "مستوى ليزر دوّار"],
    ["Torque wrench 3/4-inch", "مفتاح عزم 3/4 بوصة"],
    ["Concrete mixer 350 l", "خلاطة خرسانة 350 لتر"],
    ["Demolition hammer 30 kg", "مطرقة هدم 30 كجم"],
    ["Scaffold tower 6 m", "برج سقالة 6 م"],
  ],
  OLD: [
    ["Legacy fax unit", "جهاز فاكس قديم"],
    ["CRT monitor 17-inch", "شاشة CRT 17 بوصة"],
    ["Dot-matrix printer", "طابعة نقطية"],
  ],
  PLANT: [
    ["Air compressor 500 l", "ضاغط هواء 500 لتر"],
    ["Scaffold set 100 m²", "طقم سقالات 100 م²"],
    ["Pressure washer 250 bar", "غسالة ضغط 250 بار"],
    ["Dewatering pump 6-inch", "مضخة نزح مياه 6 بوصة"],
  ],
  "PLANT-EXC": [
    ["Tracked excavator 20 t", "حفارة مجنزرة 20 طن"],
    ["Wheel loader 3 m³", "لودر بعجلات 3 م³"],
    ["Backhoe loader", "حفار ولودر"],
    ["Mini excavator 5 t", "حفارة صغيرة 5 طن"],
  ],
  "PLANT-GEN": [
    ["Diesel generator 100 kVA", "مولد ديزل 100 ك.ف.أ"],
    ["Diesel generator 250 kVA", "مولد ديزل 250 ك.ف.أ"],
    ["Tower light 4 × 1000 W", "برج إنارة 4 × 1000 واط"],
  ],
  "PLANT-CNC": [
    ["3-axis CNC milling centre", "مركز تفريز CNC ثلاثي المحاور"],
    ["CNC lathe 8-inch chuck", "مخرطة CNC بظرف 8 بوصة"],
    ["Fibre laser cutter 3 kW", "قاطعة ليزر ليفي 3 ك.و"],
    ["Press brake 100 t", "مكبس ثني 100 طن"],
  ],
  "PLANT-WELD": [
    ["MIG welder 400 A", "ماكينة لحام MIG 400 أمبير"],
    ["TIG welder 300 A AC/DC", "ماكينة لحام TIG 300 أمبير"],
    ["Plasma cutter 100 A", "قاطعة بلازما 100 أمبير"],
  ],
  MHE: [
    ["Pallet racking bay (10 bays)", "رفوف بالتات (10 خلجان)"],
    ["Hand pallet truck 2.5 t", "عربة بالتات يدوية 2.5 طن"],
    ["Platform ladder 3 m", "سلم منصة 3 م"],
  ],
  "MHE-FLT": [
    ["Diesel forklift 3 t", "رافعة شوكية ديزل 3 طن"],
    ["Electric forklift 2 t", "رافعة شوكية كهربائية 2 طن"],
    ["Reach truck 1.6 t", "رافعة مدى 1.6 طن"],
    ["Electric pallet jack", "عربة بالتات كهربائية"],
  ],
  HVAC: [
    ["Package AC unit 10 TR", "وحدة تكييف مركزية 10 طن تبريد"],
    ["Chiller 60 TR (spare)", "مبرّد 60 طن تبريد (احتياطي)"],
    ["Portable AC 5 TR", "مكيف متنقل 5 طن تبريد"],
    ["Refrigerant recovery unit", "وحدة استرداد غاز التبريد"],
    ["Vacuum pump 2-stage", "مضخة تفريغ ثنائية المرحلة"],
  ],
  "TOOL-TEST": [
    ["Thermal imaging camera", "كاميرا تصوير حراري"],
    ["Clamp meter (CAT III)", "مقياس كلامب"],
    ["Refrigerant leak detector", "كاشف تسرب غاز التبريد"],
    ["Air-flow anemometer", "مقياس تدفق الهواء"],
  ],
};

const RETIRE_REASONS: Array<[string, string]> = [
  ["Beyond economical repair", "لا يمكن إصلاحه اقتصادياً"],
  ["Replaced under fleet renewal", "استُبدل ضمن تجديد الأسطول"],
  ["Obsolete — no vendor support", "متقادم — لا يوجد دعم من المورّد"],
  ["Damaged on site; written down", "تضرر في الموقع؛ تم تخفيض قيمته"],
];
const DISPOSAL_REASONS: Array<[string, string]> = [
  [
    "Retired and no longer needed; offered for sale to recover value",
    "متقاعد ولم يعد مطلوباً؛ معروض للبيع لاسترداد القيمة",
  ],
  [
    "Unserviceable after inspection; scrap the unit and clear the yard",
    "غير صالح للخدمة بعد الفحص؛ يُتلف ويُخلى الساحة",
  ],
  [
    "Superseded by newer equipment; trade in against the replacement",
    "استُبدل بمعدات أحدث؛ يُستبدل مقابل البديل",
  ],
  [
    "Written off — cost of repair exceeds book value",
    "شُطب — تكلفة الإصلاح تتجاوز القيمة الدفترية",
  ],
];
const FINDINGS: Array<[string, string]> = [
  [
    "Hydraulic hose weeping at the boom joint; replace before next use.",
    "تسرب في خرطوم الهيدروليك عند مفصل الذراع؛ يُستبدل قبل الاستخدام التالي.",
  ],
  [
    "Brake pads at 20 %; tyres within limits; lights all working.",
    "فحمات الفرامل عند 20٪؛ الإطارات ضمن الحدود؛ الأضواء تعمل.",
  ],
  [
    "Calibration drift 1.8 % against reference; adjusted and re-checked.",
    "انحراف المعايرة 1.8٪ عن المرجع؛ تم الضبط وإعادة الفحص.",
  ],
  [
    "Guard missing on the blade; taken out of use until refitted.",
    "الواقي مفقود عن الشفرة؛ أُخرج من الاستخدام حتى إعادة تركيبه.",
  ],
  [
    "Battery health 71 %; charger cable frayed — replaced.",
    "صحة البطارية 71٪؛ كابل الشاحن متآكل — تم استبداله.",
  ],
];
const PLAN_NAMES: Record<
  string,
  Array<
    [
      string,
      string,
      "preventive" | "calibration" | "inspection" | "statutory",
      number,
      string | null,
    ]
  >
> = {
  vehicle: [
    ["Service every 10,000 km / 90 days", "صيانة كل 10,000 كم / 90 يوماً", "preventive", 90, "km"],
    ["Annual registration & inspection", "تجديد التسجيل والفحص السنوي", "statutory", 365, null],
  ],
  plant: [
    ["Preventive service (500 h)", "صيانة وقائية (500 ساعة)", "preventive", 180, "hours"],
    ["Third-party lifting certificate", "شهادة رفع من طرف ثالث", "statutory", 365, null],
    ["Safety inspection", "فحص السلامة", "inspection", 90, null],
  ],
  tool: [
    ["Calibration", "معايرة", "calibration", 365, null],
    ["Quarterly condition check", "فحص الحالة ربع السنوي", "inspection", 90, null],
  ],
  it: [["Patch & health check", "تحديث وفحص الحالة", "preventive", 180, null]],
  hvac: [
    ["Filter change & coil clean", "تغيير الفلاتر وتنظيف الملفات", "preventive", 90, null],
    ["Refrigerant pressure test", "اختبار ضغط غاز التبريد", "statutory", 365, null],
  ],
};

// ── Small pure helpers ──────────────────────────────────────────────────────

function planFamily(cat: string): keyof typeof PLAN_NAMES | null {
  if (cat.startsWith("VEH")) return "vehicle";
  if (cat.startsWith("PLANT") || cat.startsWith("MHE")) return "plant";
  if (cat === "HVAC") return "hvac";
  if (cat.startsWith("TOOL")) return "tool";
  if (cat.startsWith("IT")) return "it";
  return null;
}
function inspectionKinds(
  cat: string,
): Array<"routine" | "safety" | "calibration" | "pre_use" | "handover" | "incident"> {
  if (cat.startsWith("VEH")) return ["routine", "safety", "pre_use", "safety"];
  if (cat.startsWith("PLANT") || cat.startsWith("MHE") || cat === "HVAC")
    return ["safety", "routine", "calibration", "pre_use"];
  if (cat.startsWith("TOOL")) return ["calibration", "routine", "pre_use"];
  return ["routine", "handover"];
}
function inspectionsWanted(rng: Rng, cat: string): number {
  if (cat.startsWith("VEH") || cat.startsWith("PLANT") || cat.startsWith("MHE") || cat === "HVAC")
    return rng.int(1, 4);
  if (cat.startsWith("TOOL")) return rng.int(0, 3);
  return rng.int(0, 1);
}
function planChance(cat: string): number {
  if (cat.startsWith("VEH") || cat.startsWith("PLANT") || cat.startsWith("MHE")) return 0.9;
  if (cat === "HVAC") return 0.8;
  if (cat.startsWith("TOOL")) return 0.5;
  if (cat.startsWith("IT")) return 0.15;
  return 0.05;
}

/** Month index (year × 12 + month0) of a YYYY-MM-DD string. */
function monthIdx(date: string): number {
  return Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1);
}
function monthStart(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = idx - y * 12;
  return `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
function monthEnd(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = idx - y * 12;
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}
/** `k` distinct days-ago values inside [lo, hi], oldest first. */
function distinctDays(rng: Rng, lo: number, hi: number, k: number): number[] {
  if (hi < lo || k <= 0) return [];
  const want = Math.min(k, hi - lo + 1);
  const set = new Set<number>();
  let guard = 0;
  while (set.size < want && guard++ < want * 30) set.add(rng.int(lo, hi));
  for (let d = lo; set.size < want && d <= hi; d++) set.add(d);
  return [...set].sort((a, b) => b - a);
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
/** The legal hops from `draft` to a planned state (the trigger's own table). */
export function pathTo(target: AssetStatus): AssetStatus[] {
  switch (target) {
    case "draft":
      return [];
    case "in_service":
    case "in_storage":
    case "lost":
    case "retired":
      return [target];
    case "under_maintenance":
    case "in_transit":
      return ["in_service", target];
    case "disposed":
      return ["retired"]; // the last hop is the disposal service's alone
  }
}
function safeHandoff(ctx: LabContext, family: string): Record<string, unknown> {
  try {
    return ctx.handoff(family) ?? {};
  } catch {
    return {};
  }
}

// ── The model ───────────────────────────────────────────────────────────────

export type AssetSpec = {
  i: number;
  id: string;
  assetNo: string;
  cat: string;
  nameEn: string;
  source: Source;
  acquiredOn: string;
  /** Days ago the asset entered the register (the history start for opening balances). */
  registeredDaysAgo: number;
  /** Effective depreciation start (depreciation_start_on ?? acquired_on). */
  startOn: string;
  cost: number | null;
  baseCost: number | null;
  residual: number | null;
  life: number | null;
  /** State after the bulk guarded updates (`draft` for sample assets, which the service moves). */
  preFinal: AssetStatus;
  /** State after the whole seed, including the service phase. */
  final: AssetStatus;
  retiredDaysAgo: number | null;
  retiredReason: string | null;
  lostDaysAgo: number | null;
  /** Date depreciation stops accruing (retired / lost), null while live. */
  stopOn: string | null;
  sample: boolean;
  custodian: string | null;
  custodianSince: string | null;
  warehouseId: string | null;
  locationId: string | null;
  condition: Condition;
  updatedAt: string;
};

export type ServicePlan = {
  custody: Array<{
    assetId: string;
    toUser: string;
    reason: string;
    transfer: {
      toWarehouseId: string | null;
      toLocationId: string | null;
      toUserId: string | null;
      reason: string;
    } | null;
    ret: boolean;
  }>;
  inspections: Array<{
    assetId: string;
    inspectedOn: string;
    kind: string;
    passed: boolean;
    conditionFound: Condition;
    findings: string;
    nextDueOn: string;
  }>;
  maintenance: Array<{
    assetId: string;
    plan: {
      nameEn: string;
      nameAr: string;
      kind: string;
      intervalDays: number;
      nextDueOn: string;
      instructions: string;
    };
    event: { kind: string; performedOn: string; costMinor: number | null; notes: string };
  }>;
  downtime: Array<{
    assetId: string;
    startedAt: string;
    endedAt: string | null;
    reason: string;
    detail: string;
  }>;
  statusMoves: Array<{ assetId: string; steps: Array<{ to: AssetStatus; reason?: string }> }>;
  disposals: Array<{
    disposalId: string;
    approvalId: string;
    assetId: string;
    outcome: DisposalOutcome;
    method: DisposalMethod;
    disposedOn: string;
    actualProceedsMinor: number | null;
    buyerName: string | null;
    note: string;
  }>;
  depreciation: { periodStart: string; periodEnd: string; lines: number; totalMinor: number };
  /** Rows the service phase adds on top of the direct inserts, per table. */
  counts: Record<string, number>;
};

export type AssetsModel = {
  assets: AssetSpec[];
  rows: Record<string, Row[]>;
  counts: Record<string, number>;
  service: ServicePlan;
  /** [from, to, ids] — the guarded status updates for non-sample assets, in order. */
  statusMoves: Array<[AssetStatus, AssetStatus, string[]]>;
  sequences: Array<{ scope: string; next: number }>;
  finalDistribution: Record<string, number>;
};

const MODELS = new WeakMap<LabContext, AssetsModel>();

export function buildAssetsModel(ctx: LabContext): AssetsModel {
  const cached = MODELS.get(ctx);
  if (cached) return cached;
  const m = build(ctx);
  MODELS.set(ctx, m);
  return m;
}

function build(ctx: LabContext): AssetsModel {
  const { company, orgId, rng, clock } = ctx;
  const id = (...ordinal: Array<string | number>) => ctx.id(FAMILY, ...ordinal);
  const H = historyDays(company);
  const N = company.profile.assets;
  const users = ctx.users;
  const cur = company.currency;
  const arabicFirst = company.languages[0] === "ar";
  const lang = (): "en" | "ar" =>
    arabicFirst ? (rng.chance(0.8) ? "ar" : "en") : rng.chance(0.25) ? "ar" : "en";

  // ── references from the families this one depends on ────────────────────
  const setup = safeHandoff(ctx, "setup");
  const people = safeHandoff(ctx, "people");
  const work = safeHandoff(ctx, "work");
  const categoryIds = (setup.assetCategories ?? {}) as Record<string, string>;
  const warehouses = Object.values(
    (setup.warehouses ?? {}) as Record<string, { id: string; locations?: Record<string, string> }>,
  ).map((w) => ({
    id: w.id,
    bins: Object.entries(w.locations ?? {})
      .filter(([code]) => /-\d\d$/.test(code))
      .map(([, lid]) => lid),
  }));
  const personaEmployees = (people.personaEmployees ?? {}) as Partial<Record<PersonaKey, string>>;
  const jobs = (
    (work.jobs ?? []) as Array<
      [string, string | null, string, string, string, string, 0 | 1, string]
    >
  )
    .map((j) => ({ id: j[0], start: j[3] }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  /** A job that had started by `date` — the work an inspection or repair belongs to. */
  const jobStartedBy = (date: string): string | null => {
    const r = rng.int(0, 19);
    let hi = -1;
    for (let k = 0; k < jobs.length && jobs[k]!.start <= date; k++) hi = k;
    if (hi < 0) return null;
    return jobs[Math.max(0, hi - r)]!.id;
  };

  const EMPLOYEE_PERSONAS: PersonaKey[] = [
    "owner",
    "admin",
    "manager",
    "finance",
    "hr",
    "warehouse",
    "field",
    "restricted",
  ];
  const custodianPool = EMPLOYEE_PERSONAS.filter(
    (p) => personaEmployees[p] || !Object.keys(personaEmployees).length,
  );
  const custodianWeights: Record<PersonaKey, number> = {
    field: 26,
    restricted: 20,
    warehouse: 15,
    manager: 12,
    hr: 7,
    finance: 7,
    admin: 7,
    owner: 4,
    auditor: 0,
  };
  const pickCustodian = (): string => {
    const w: Record<string, number> = {};
    for (const p of custodianPool) w[p] = custodianWeights[p];
    return users[weighted(rng, w as Record<PersonaKey, number>)];
  };
  const recorders: string[] = [users.manager, users.warehouse, users.hr];
  const inspectors: string[] = [users.field, users.warehouse, users.manager];

  const rows: Record<string, Row[]> = {};
  for (const t of ASSET_TABLES) rows[t] = [];
  const push = (table: string, row: Row) => rows[table]!.push(row);

  // ── sizing ────────────────────────────────────────────────────────────────
  const obCount = Math.max(1, Math.round(N * 0.08));
  const sampleCount = Math.min(24, Math.max(10, Math.round(N * 0.06)));
  const sampleIdx = new Set<number>();
  const step = Math.max(1, Math.floor((N - obCount) / sampleCount));
  for (let k = 0; k < sampleCount; k++) {
    const i = obCount + k * step;
    if (i < N) sampleIdx.add(i);
  }
  const spread = spreadDates(rng, company, N - obCount);
  const mix = CATEGORY_MIX[company.key];

  const assets: AssetSpec[] = [];
  const service: ServicePlan = {
    custody: [],
    inspections: [],
    maintenance: [],
    downtime: [],
    statusMoves: [],
    disposals: [],
    depreciation: { periodStart: "", periodEnd: "", lines: 0, totalMinor: 0 },
    counts: {},
  };
  const svc = (table: string, n = 1) => (service.counts[table] = (service.counts[table] ?? 0) + n);

  for (let i = 0; i < N; i++) {
    const sample = sampleIdx.has(i);
    const aid = id("asset", i);
    const assetNo = `AST-${String(i + 1).padStart(3, "0")}`;
    const cat = weighted(rng, mix);
    const def = CATEGORY_DEFAULTS[cat]!;
    const names = NAMES[cat] ?? NAMES.TOOL!;
    const [baseEn, baseAr] = pick(rng, names);
    const nameEn = longTitle(rng, "en", `${baseEn} #${i + 1}`);
    const nameAr = `${baseAr} #${i + 1}`;

    // Acquisition. Opening balances predate the history and start depreciating on day one.
    const ob = i < obCount;
    const source: Source = ob
      ? "opening_balance"
      : weighted(rng, { purchase: 74, transfer_in: 8, lease: 7, built: 7, donation: 4 });
    const registeredDaysAgo = ob ? H : spread[i - obCount]!;
    const acquiredOn = ob ? clock.dayAgo(H + rng.int(60, 900)) : clock.dayAgo(registeredDaysAgo);
    const depreciationStartOn = ob
      ? company.history.from
      : rng.chance(0.6)
        ? rng.chance(0.5)
          ? acquiredOn
          : monthStart(monthIdx(acquiredOn) + 1)
        : null;
    const startOn = depreciationStartOn ?? acquiredOn;

    // Money: cost in the company currency (a few in USD at a fixed fake rate), residual from the category.
    const foreign = source === "purchase" && rng.chance(0.05);
    const rate = foreign ? (cur === "SAR" ? 3.75 : 3.6725) : 1;
    const currency = foreign ? "USD" : cur;
    const cost =
      source === "donation"
        ? 0
        : rng.chance(0.04)
          ? null
          : priceMinor(
              rng,
              foreign ? Math.round(def.cost[0] / 3.6) : def.cost[0],
              foreign ? Math.round(def.cost[1] / 3.6) : def.cost[1],
            );
    const baseCost = cost === null ? null : Math.round(cost * rate);
    const residual = cost === null ? null : Math.round((cost * def.residualPct) / 100);
    const life =
      source === "lease" ? null : rng.chance(0.9) ? def.life : def.life + rng.int(-6, 12);

    // Lifecycle. Older things are likelier to be retired; the inactive class always is.
    const ageFactor = Math.min(1, registeredDaysAgo / Math.max(1, H));
    let final: AssetStatus =
      cat === "OLD"
        ? "retired"
        : weighted(rng, {
            in_service: 60,
            in_storage: 14,
            under_maintenance: 5,
            in_transit: 2,
            lost: 1.5,
            retired: 3 + 12 * ageFactor,
          });
    if (registeredDaysAgo < 2 && (final === "retired" || final === "lost")) final = "in_service";
    let retiredDaysAgo: number | null = null;
    let retiredReason: string | null = null;
    let lostDaysAgo: number | null = null;
    if (final === "retired") {
      retiredDaysAgo = rng.int(0, Math.max(0, Math.min(registeredDaysAgo - 1, 700)));
      const [en, ar] = pick(rng, RETIRE_REASONS);
      retiredReason = cat === "OLD" ? "Asset class discontinued" : lang() === "ar" ? ar : en;
    }
    if (final === "lost")
      lostDaysAgo = rng.int(0, Math.max(0, Math.min(registeredDaysAgo - 1, 400)));
    const stopOn =
      retiredDaysAgo !== null
        ? clock.dayAgo(retiredDaysAgo)
        : lostDaysAgo !== null
          ? clock.dayAgo(lostDaysAgo)
          : null;
    const endDaysAgo = retiredDaysAgo ?? lostDaysAgo ?? 0;
    const lo = endDaysAgo;
    const hi = registeredDaysAgo - 1;

    // Where it lives.
    const wh = warehouses.length ? pick(rng, warehouses) : null;
    const bin = wh && wh.bins.length ? pick(rng, wh.bins) : null;
    const inStore =
      final === "in_storage" || final === "retired" || (final === "in_service" && rng.chance(0.3));
    const warehouseId = inStore && wh ? wh.id : null;
    const locationId = inStore && wh ? bin : null;
    const siteNote =
      !inStore && rng.chance(0.5)
        ? `${arabicFirst ? "موقع العميل، " : "Client site, "}${city(company, rng)[arabicFirst ? "ar" : "en"]}`
        : null;

    const initialCondition: Condition =
      registeredDaysAgo < 120 && source === "purchase"
        ? rng.chance(0.7)
          ? "new"
          : "good"
        : rng.chance(0.75)
          ? "good"
          : "fair";
    const createdBy = rng.chance(0.6) ? users.admin : users.manager;
    const createdAt = clock.tsAgo(registeredDaysAgo, rng.int(8, 15), rng.int(0, 59));
    let updatedAt = createdAt;
    let condition: Condition = initialCondition;

    // ── inspections (bulk) — what was found is the asset's condition now ────
    type Insp = { day: number; cond: Condition };
    const inspTimeline: Insp[] = [];
    if (!sample) {
      const kinds = inspectionKinds(cat);
      const days = distinctDays(rng, lo, hi, inspectionsWanted(rng, cat));
      let cond: Condition = initialCondition;
      for (const d of days) {
        const passed = rng.chance(0.85);
        if (!passed) cond = rng.chance(0.7) ? "poor" : "unserviceable";
        else if (cond === "new" && d < registeredDaysAgo - 200) cond = "good";
        else if (cond === "good" && rng.chance(0.15)) cond = "fair";
        else if ((cond === "poor" || cond === "unserviceable") && rng.chance(0.6)) cond = "fair";
        const kind = pick(rng, kinds);
        const interval =
          kind === "safety" || kind === "calibration"
            ? pick(rng, [180, 365])
            : pick(rng, [90, 180]);
        const inspectedOn = clock.dayAgo(d);
        const findingsLang = lang();
        const [fen, far] = pick(rng, FINDINGS);
        const jobId = !passed && rng.chance(0.6) ? jobStartedBy(inspectedOn) : null;
        const by = pick(rng, inspectors);
        inspTimeline.push({ day: d, cond });
        push("asset_inspection", {
          id: id("inspection", i, d),
          org_id: orgId,
          asset_id: aid,
          inspected_on: inspectedOn,
          inspected_by: by,
          kind,
          passed,
          condition_found: cond,
          findings: !passed || rng.chance(0.4) ? (findingsLang === "ar" ? far : fen) : null,
          next_due_on: rng.chance(0.85) ? addDays(inspectedOn, interval) : null,
          job_id: jobId,
          recorded_by: by,
          created_at: clock.tsAgo(d, 16, rng.int(0, 59)),
        });
        updatedAt = clock.tsAgo(d, 16, 30);
      }
      condition = cond;
    }
    const conditionAt = (day: number): Condition => {
      let c: Condition = initialCondition;
      for (const x of inspTimeline) if (x.day >= day) c = x.cond;
      return c;
    };

    // ── custody (bulk) — an append-only chain whose last event is the truth ──
    let custodian: string | null = null;
    let custodianSince: string | null = null;
    let curWh = warehouseId;
    let curLoc = locationId;
    if (!sample) {
      type Ev = {
        event: string;
        from: string | null;
        to: string | null;
        toWh: string | null;
        toLoc: string | null;
        cond: Condition | null;
        reason: string | null;
      };
      const evs: Ev[] = [];
      const k =
        final === "in_storage"
          ? weighted(rng, { 0: 30, 1: 25, 2: 30, 3: 15 })
          : weighted(rng, { 0: 12, 1: 36, 2: 25, 3: 16, 4: 11 });
      const wantedDays = distinctDays(rng, lo, hi, Number(k) + 2);
      let holder: string | null = null;
      const lostFound = final === "in_storage" && rng.chance(0.05) && wantedDays.length >= 3;
      const bodyCount = Math.min(Number(k), wantedDays.length);
      for (let e = 0; e < bodyCount; e++) {
        if (holder === null) {
          holder = pickCustodian();
          evs.push({
            event: "assigned",
            from: null,
            to: holder,
            toWh: curWh,
            toLoc: curLoc,
            cond: null,
            reason: rng.chance(0.5) ? sentence(rng, lang()) : null,
          });
        } else if (rng.chance(0.5)) {
          evs.push({
            event: "returned",
            from: holder,
            to: null,
            toWh: curWh,
            toLoc: curLoc,
            cond: rng.chance(0.5) ? ("keep" as unknown as Condition) : null,
            reason: null,
          });
          holder = null;
        } else {
          const next: string | null = rng.chance(0.6) ? pickCustodian() : holder;
          const nw = wh && rng.chance(0.4) ? wh.id : curWh;
          const nl = nw === wh?.id && wh?.bins.length ? pick(rng, wh.bins) : curLoc;
          evs.push({
            event: "transferred",
            from: holder,
            to: next,
            toWh: nw,
            toLoc: nl,
            cond: null,
            reason: sentence(rng, lang()),
          });
          holder = next;
          curWh = nw;
          curLoc = nl;
        }
      }
      if (lostFound) {
        if (holder === null) {
          holder = pickCustodian();
          evs.push({
            event: "assigned",
            from: null,
            to: holder,
            toWh: curWh,
            toLoc: curLoc,
            cond: null,
            reason: null,
          });
        }
        evs.push({
          event: "lost",
          from: holder,
          to: null,
          toWh: null,
          toLoc: null,
          cond: null,
          reason: "Not returned at demobilisation; reported missing",
        });
        evs.push({
          event: "found",
          from: null,
          to: null,
          toWh: wh?.id ?? null,
          toLoc: bin,
          cond: "fair",
          reason: "Found in the site container during stocktake",
        });
        holder = null;
        curWh = wh?.id ?? null;
        curLoc = bin;
      }
      if (final === "lost") {
        evs.push({
          event: "lost",
          from: holder,
          to: null,
          toWh: null,
          toLoc: null,
          cond: null,
          reason: "Reported missing after site handover",
        });
        holder = null;
      } else if ((final === "in_storage" || final === "retired") && holder !== null) {
        evs.push({
          event: "returned",
          from: holder,
          to: null,
          toWh: warehouseId,
          toLoc: locationId,
          cond: "keep" as unknown as Condition,
          reason: final === "retired" ? "Returned for retirement" : null,
        });
        holder = null;
        curWh = warehouseId;
        curLoc = locationId;
      } else if (final === "in_service" && holder === null && rng.chance(0.8)) {
        holder = pickCustodian();
        evs.push({
          event: "assigned",
          from: null,
          to: holder,
          toWh: curWh,
          toLoc: curLoc,
          cond: null,
          reason: null,
        });
      } else if (final === "in_transit") {
        const nw = wh?.id ?? null;
        evs.push({
          event: "transferred",
          from: holder,
          to: holder,
          toWh: nw,
          toLoc: null,
          cond: null,
          reason: "In transit between sites",
        });
        curWh = nw;
        curLoc = null;
      }
      // Spread the events over distinct days in the window; a tail added above may exceed the days drawn.
      const days = distinctDays(rng, lo, hi, evs.length);
      const spacing = days.length ? days : [];
      for (let e = 0; e < evs.length; e++) {
        const ev = evs[e]!;
        const d = spacing[e] ?? Math.max(lo, (spacing[spacing.length - 1] ?? lo) - 1);
        const at = clock.tsAgo(d, rng.int(7, 17), rng.int(0, 59));
        const cond: Condition | null =
          ev.cond === ("keep" as unknown as Condition) ? conditionAt(d) : ev.cond;
        push("asset_assignment", {
          id: id("assignment", i, e),
          org_id: orgId,
          asset_id: aid,
          event: ev.event,
          from_user_id: ev.from,
          to_user_id: ev.to,
          from_warehouse_id: e === 0 ? warehouseId : evs[e - 1]!.toWh,
          from_location_id: e === 0 ? locationId : evs[e - 1]!.toLoc,
          to_warehouse_id: ev.toWh,
          to_location_id: ev.toLoc,
          condition_at_event: cond,
          reason: ev.reason,
          corrects_id: null,
          effective_at: at,
          recorded_by: pick(rng, recorders),
          created_at: at,
        });
        if (ev.event === "assigned" || ev.event === "transferred") {
          custodian = ev.to;
          custodianSince = at;
        } else {
          custodian = null;
          custodianSince = null;
        }
        if (at > updatedAt) updatedAt = at;
      }
      if (custodian === null) custodianSince = null;
    }
    if (final === "in_transit" && !sample) {
      curLoc = null;
    }

    // ── maintenance plans and their events (bulk, live assets) ──────────────
    const live =
      final === "in_service" ||
      final === "in_storage" ||
      final === "under_maintenance" ||
      final === "in_transit";
    const fam = planFamily(cat);
    type EventRef = { id: string; day: number };
    const eventRefs: EventRef[] = [];
    if (!sample && live && fam && rng.chance(planChance(cat))) {
      const specs = PLAN_NAMES[fam]!;
      const count = specs.length > 1 && rng.chance(0.5) ? 2 : 1;
      for (let p = 0; p < count; p++) {
        const [pen, par, kind, interval, usageUnit] = specs[p]!;
        const pid = id("plan", i, p);
        const active = rng.chance(0.92);
        const withUsage = usageUnit !== null && rng.chance(0.4);
        // Occurrences: every `interval` days since registration, at most five.
        // The loop counts DOWN in days-ago, so occ[0] is the OLDEST and the
        // last entry is the most recent — the comment used to claim the
        // opposite, and last_done_on believed it.
        const occ: number[] = [];
        if (active) {
          const offset = rng.int(0, Math.max(0, interval - 1));
          for (
            let d = registeredDaysAgo - interval - offset;
            d >= lo && occ.length < 5;
            d -= interval
          )
            occ.push(Math.max(d, lo));
        }
        // The most recent occurrence is the smallest days-ago, not the first.
        const lastDone = occ.length ? clock.dayAgo(Math.min(...occ)) : null;
        const nextDue = lastDone
          ? addDays(lastDone, interval)
          : addDays(clock.dayAgo(registeredDaysAgo), interval);
        const pCreated = clock.tsAgo(registeredDaysAgo, 15, rng.int(0, 59));
        push("asset_maintenance_plan", {
          id: pid,
          org_id: orgId,
          asset_id: aid,
          name_en: pen,
          name_ar: par,
          kind,
          interval_days: interval,
          interval_usage: withUsage ? (usageUnit === "km" ? 10000 : 500) : null,
          usage_unit: withUsage ? usageUnit : null,
          instructions: rng.chance(0.6) ? paragraph(rng, lang(), 2) : null,
          next_due_on: active ? nextDue : null,
          last_done_on: lastDone,
          active,
          created_by: users.manager,
          created_at: pCreated,
          updated_at: lastDone ? clock.tsAgo(occ[0]!, 17, 0) : pCreated,
        });
        let meter = withUsage ? rng.int(100, 5000) : null;
        for (let o = occ.length - 1; o >= 0; o--) {
          const d = occ[o]!;
          const eid = id("event", i, p, o);
          const vendor = rng.chance(0.35);
          if (meter !== null)
            meter += usageUnit === "km" ? rng.int(2000, 12000) : rng.int(150, 600);
          const performedOn = clock.dayAgo(d);
          push("asset_maintenance_event", {
            id: eid,
            org_id: orgId,
            asset_id: aid,
            plan_id: pid,
            kind,
            job_id: rng.chance(0.25) ? jobStartedBy(performedOn) : null,
            task_id: null,
            performed_on: performedOn,
            performed_by: vendor ? null : pick(rng, [users.field, users.warehouse]),
            vendor_supplier_id: null,
            cost_minor: vendor
              ? priceMinor(rng, 150, 4500)
              : rng.chance(0.3)
                ? priceMinor(rng, 50, 900)
                : null,
            currency: vendor || rng.chance(0.3) ? cur : null,
            meter_reading: meter,
            notes: rng.chance(0.5) ? sentence(rng, lang()) : null,
            recorded_by: pick(rng, recorders),
            created_at: clock.tsAgo(d, 17, rng.int(0, 59)),
          });
          eventRefs.push({ id: eid, day: d });
        }
      }
    }

    // ── corrective work and the downtime around it (bulk) ───────────────────
    type Spell = {
      id: string;
      startDay: number;
      startTs: string;
      endTs: string | null;
      reason: string;
      detail: string;
      eventId: string | null;
      created: string;
    };
    const spells: Spell[] = [];
    if (!sample && final !== "lost" && rng.chance(0.35)) {
      const days = distinctDays(rng, lo, hi, rng.int(1, 2));
      days.forEach((d, c) => {
        const eid = id("corrective", i, c);
        const performedOn = clock.dayAgo(d);
        const vendor = rng.chance(0.5);
        push("asset_maintenance_event", {
          id: eid,
          org_id: orgId,
          asset_id: aid,
          plan_id: null,
          kind: "corrective",
          job_id: rng.chance(0.35) ? jobStartedBy(performedOn) : null,
          task_id: null,
          performed_on: performedOn,
          performed_by: vendor ? null : pick(rng, [users.field, users.warehouse]),
          vendor_supplier_id: null,
          cost_minor: vendor
            ? priceMinor(rng, 300, 9000)
            : rng.chance(0.5)
              ? priceMinor(rng, 50, 1200)
              : null,
          currency: vendor ? cur : null,
          meter_reading: null,
          notes: sentence(rng, lang()),
          recorded_by: pick(rng, recorders),
          created_at: clock.tsAgo(d, 17, rng.int(0, 59)),
        });
        eventRefs.push({ id: eid, day: d });
        if (rng.chance(0.6)) {
          const before = rng.int(0, 5);
          const startDay = d + before;
          const startTs = clock.tsAgo(startDay, rng.int(6, 12), rng.int(0, 59));
          const endTs = clock.tsAgo(d, rng.int(13, 18), rng.int(0, 59));
          const reason = weighted(rng, {
            breakdown: 55,
            awaiting_parts: 25,
            awaiting_approval: 10,
            other: 10,
          });
          spells.push({
            id: id("downtime", i, c),
            startDay,
            startTs,
            endTs,
            reason,
            detail: sentence(rng, lang()),
            eventId: eid,
            created: startTs,
          });
        }
      });
    }
    if (!sample && final === "under_maintenance") {
      const startDay = rng.int(1, 15);
      const startTs = clock.tsAgo(startDay, rng.int(7, 11), rng.int(0, 59));
      spells.push({
        id: id("downtime", i, "open"),
        startDay,
        startTs,
        endTs: null,
        reason: weighted(rng, { maintenance: 70, awaiting_parts: 30 }),
        detail: sentence(rng, lang()),
        eventId: null,
        created: startTs,
      });
      if (startTs > updatedAt) updatedAt = startTs;
    }
    // One spell at a time: drop any that would overlap an earlier one (and the open one).
    spells.sort((a, b) => (a.startTs < b.startTs ? -1 : 1));
    let lastEnd: string | null = null;
    const kept: Spell[] = [];
    for (const s of spells) {
      if (lastEnd !== null && s.startTs <= lastEnd) continue;
      if (lastEnd === null && kept.length) continue; // an open spell stays the last one
      kept.push(s);
      lastEnd = s.endTs;
    }
    for (const s of kept) {
      push("asset_downtime", {
        id: s.id,
        org_id: orgId,
        asset_id: aid,
        started_at: s.startTs,
        ended_at: s.endTs,
        reason: s.reason,
        detail: s.detail,
        maintenance_event_id: s.eventId,
        recorded_by: pick(rng, [users.field, users.warehouse, users.manager]),
        created_at: s.created,
        updated_at: s.endTs ?? s.created,
      });
    }

    const retiredAt = retiredDaysAgo !== null ? clock.tsAgo(retiredDaysAgo, 11, 0) : null;
    if (retiredAt && retiredAt > updatedAt) updatedAt = retiredAt;

    // ── the asset row, born draft ───────────────────────────────────────────
    const descLang = lang();
    const warranty = source === "purchase" && rng.chance(0.6);
    const warrantyMonths = pick(rng, [12, 24, 36]);
    push("asset", {
      id: aid,
      org_id: orgId,
      asset_no: assetNo,
      category_id: categoryIds[cat] ?? null,
      name_en: nameEn,
      name_ar: nameAr,
      description_en: descLang === "en" ? paragraph(rng, "en", rng.int(1, 2)) : null,
      description_ar: descLang === "ar" ? paragraph(rng, "ar", rng.int(1, 2)) : null,
      serial_no: rng.chance(0.7)
        ? `SN-TEST-${company.key.toUpperCase()}-${String(i + 1).padStart(5, "0")}`
        : null,
      barcode: rng.chance(0.45) ? `AST-BC-${String(i + 1).padStart(6, "0")}` : null,
      code_kind: rng.chance(0.45) ? "internal" : "none",
      qr_key: `AQR-${aid.replace(/-/g, "").slice(0, 20).toUpperCase()}`,
      acquisition_source: source,
      acquired_on: acquiredOn,
      acquisition_cost_minor: cost,
      currency: cost === null ? null : currency,
      exchange_rate: cost === null ? null : rate,
      base_acquisition_cost_minor: baseCost,
      residual_value_minor: residual,
      useful_life_months: life,
      depreciation_start_on: depreciationStartOn,
      supplier_id: null,
      purchase_order_id: null,
      goods_receipt_line_id: null,
      item_id: null,
      stock_serial_id: null,
      warranty_start_on: warranty ? acquiredOn : null,
      warranty_end_on: warranty ? monthEnd(monthIdx(acquiredOn) + warrantyMonths) : null,
      warranty_provider: warranty
        ? descLang === "ar"
          ? "مزوّد الضمان الافتراضي (تجريبي)"
          : "Fictional Warranty Provider (test)"
        : null,
      warranty_terms: warranty && rng.chance(0.4) ? sentence(rng, descLang) : null,
      warehouse_id: sample ? warehouseId : curWh,
      location_id: sample ? locationId : curLoc,
      site_note: siteNote,
      custodian_user_id: null,
      custodian_since: null,
      status: BORN_STATES.asset,
      condition: initialCondition,
      retired_at: null,
      retired_reason: null,
      disposed_at: null,
      notes: rng.chance(0.3) ? sentence(rng, descLang) : null,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: createdAt,
    });

    // ── the service sample ──────────────────────────────────────────────────
    if (sample) {
      const toUser = pickCustodian();
      const transfer = rng.chance(0.3);
      const ret =
        final === "in_storage" || final === "retired" || final === "lost" || rng.chance(0.2);
      service.custody.push({
        assetId: aid,
        toUser,
        reason: sentence(rng, lang()),
        transfer: transfer
          ? rng.chance(0.5) && wh
            ? {
                toWarehouseId: wh.id,
                toLocationId: bin,
                toUserId: null,
                reason: "Moved with the crew to the new site",
              }
            : {
                toWarehouseId: null,
                toLocationId: null,
                toUserId: pickCustodian(),
                reason: "Handed to the relieving technician",
              }
          : null,
        ret,
      });
      svc("asset_assignment", 1 + (transfer ? 1 : 0) + (ret ? 1 : 0));
      const passed = rng.chance(0.8);
      const insp = {
        assetId: aid,
        inspectedOn: clock.dayAgo(rng.int(0, 20)),
        kind: pick(rng, inspectionKinds(cat)),
        passed,
        conditionFound: (passed ? (rng.chance(0.7) ? "good" : "fair") : "poor") as Condition,
        findings: pick(rng, FINDINGS)[lang() === "ar" ? 1 : 0],
        nextDueOn: "",
      };
      insp.nextDueOn = addDays(insp.inspectedOn, 90);
      service.inspections.push(insp);
      svc("asset_inspection");
      if (live && fam) {
        const [pen, par, kind, interval] = PLAN_NAMES[fam]![0]!;
        const performedOn = clock.dayAgo(rng.int(1, 30));
        service.maintenance.push({
          assetId: aid,
          plan: {
            nameEn: pen,
            nameAr: par,
            kind,
            intervalDays: interval,
            nextDueOn: addDays(performedOn, interval),
            instructions: paragraph(rng, lang(), 1),
          },
          event: {
            kind,
            performedOn,
            costMinor: rng.chance(0.5) ? priceMinor(rng, 100, 3000) : null,
            notes: sentence(rng, lang()),
          },
        });
        svc("asset_maintenance_plan");
        svc("asset_maintenance_event");
      }
      if (final === "under_maintenance") {
        service.downtime.push({
          assetId: aid,
          startedAt: clock.tsAgo(rng.int(1, 10), 8, 0),
          endedAt: null,
          reason: "maintenance",
          detail: sentence(rng, lang()),
        });
        svc("asset_downtime");
      } else if (final !== "lost" && rng.chance(0.3)) {
        const d = rng.int(5, 60);
        service.downtime.push({
          assetId: aid,
          startedAt: clock.tsAgo(d, 8, 0),
          endedAt: clock.tsAgo(d - rng.int(0, 3), 16, 0),
          reason: "breakdown",
          detail: sentence(rng, lang()),
        });
        svc("asset_downtime");
      }
      const steps = pathTo(final).map((to) =>
        to === "retired" ? { to, reason: retiredReason ?? "Retired by the manager" } : { to },
      );
      service.statusMoves.push({ assetId: aid, steps });
    }

    assets.push({
      i,
      id: aid,
      assetNo,
      cat,
      nameEn,
      source,
      acquiredOn,
      registeredDaysAgo,
      startOn,
      cost,
      baseCost,
      residual,
      life,
      preFinal: sample ? "draft" : final,
      final,
      retiredDaysAgo,
      retiredReason,
      lostDaysAgo,
      stopOn,
      sample,
      custodian,
      custodianSince,
      warehouseId: sample ? warehouseId : curWh,
      locationId: sample ? locationId : curLoc,
      condition,
      updatedAt,
    });
  }

  // ── disposals: born submitted with their pending approval; decided by the service ──
  const disposalCount = Math.min(18, Math.max(4, Math.round(N * 0.05)));
  const candidates = assets.filter(
    (a) => !a.sample && (a.preFinal === "retired" || a.preFinal === "in_storage"),
  );
  candidates.sort((a, b) =>
    a.preFinal === b.preFinal ? a.i - b.i : a.preFinal === "retired" ? -1 : 1,
  );
  const chosen = candidates.slice(0, disposalCount);
  chosen.forEach((a, n) => {
    const outcome: DisposalOutcome = n === 0 ? "reject" : n === 1 ? "pending" : "complete";
    const method: DisposalMethod =
      a.source === "lease"
        ? "returned_to_lessor"
        : weighted(rng, { sale: 40, scrap: 30, write_off: 15, trade_in: 10, donation: 5 });
    const requestedDaysAgo = rng.int(3, 60);
    const requestedAt = clock.tsAgo(requestedDaysAgo, rng.int(8, 14), rng.int(0, 59));
    const proceeds =
      method === "sale" || method === "trade_in"
        ? priceMinor(rng, 100, Math.max(200, Math.round(((a.cost ?? 100_000) / 100) * 0.3)))
        : null;
    const did = id("disposal", n);
    const apid = id("disposal_approval", n);
    const [ren, rar] = pick(rng, DISPOSAL_REASONS);
    const reason = lang() === "ar" ? rar : ren;
    push("asset_disposal", {
      id: did,
      org_id: orgId,
      asset_id: a.id,
      reference: `ADP-${String(n + 1).padStart(3, "0")}`,
      method,
      reason,
      status: BORN_STATES.asset_disposal,
      proposed_proceeds_minor: proceeds,
      actual_proceeds_minor: null,
      currency: proceeds !== null ? cur : null,
      buyer_name: null,
      disposed_on: null,
      requested_by: users.admin,
      requested_at: requestedAt,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      completed_by: null,
      completed_at: null,
      cancelled_at: null,
      created_at: requestedAt,
      updated_at: requestedAt,
    });
    push("approval", {
      id: apid,
      org_id: orgId,
      subject_type: "asset_disposal",
      subject_id: did,
      subject_summary: { title: `Dispose of ${a.assetNo} by ${method}`, amountMinor: proceeds },
      rule_id: null,
      requested_by: users.admin,
      assigned_role: "owner",
      assigned_user_id: null,
      state: BORN_STATES.approval,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      self_approved: false,
      expires_hint: null,
      created_at: requestedAt,
      updated_at: requestedAt,
    });
    service.disposals.push({
      disposalId: did,
      approvalId: apid,
      assetId: a.id,
      outcome,
      method,
      disposedOn: clock.dayAgo(rng.int(0, Math.max(0, requestedDaysAgo - 2))),
      actualProceedsMinor:
        proceeds !== null ? Math.round(proceeds * (0.8 + rng.next() * 0.3)) : null,
      buyerName:
        method === "sale"
          ? lang() === "ar"
            ? "مشترٍ افتراضي (تجريبي)"
            : "Fictional Buyer (test)"
          : null,
      note:
        outcome === "reject"
          ? "Keep as a spare until the replacement is commissioned"
          : "Approved — proceed with the disposal",
    });
    if (outcome === "complete") a.final = "disposed";
  });

  // ── depreciation: straight-line monthly, the service's own formula ────────
  const asOfIdx = monthIdx(company.history.asOf);
  const serviceIdx = asOfIdx - 1; // the last complete month — the finance service's run
  const lastBulkIdx = asOfIdx - 2;
  const fromIdx = monthIdx(company.history.from);
  const depreciable = assets.filter(
    (a) =>
      a.life !== null && a.life > 0 && a.baseCost !== null && a.baseCost - (a.residual ?? 0) > 0,
  );
  let firstIdx = lastBulkIdx + 1;
  for (const a of depreciable)
    firstIdx = Math.min(firstIdx, Math.max(fromIdx, monthIdx(a.startOn)));
  const accumulated = new Map<string, number>();
  let runNo = 0;
  for (let mi = firstIdx; mi <= lastBulkIdx; mi++) {
    runNo++;
    const rid = id("depreciation_run", monthStart(mi));
    const pEnd = monthEnd(mi);
    let total = 0;
    for (const a of depreciable) {
      if (a.startOn > pEnd) continue;
      if (a.stopOn !== null && a.stopOn <= pEnd) continue;
      const base = a.baseCost! - (a.residual ?? 0);
      const acc = accumulated.get(a.id) ?? 0;
      if (acc >= base) continue;
      const amount = Math.min(Math.floor(base / a.life!), base - acc);
      if (amount <= 0) continue;
      accumulated.set(a.id, acc + amount);
      total += amount;
      push("asset_depreciation_line", {
        id: id("depreciation_line", monthStart(mi), a.i),
        org_id: orgId,
        run_id: rid,
        asset_id: a.id,
        amount_minor: amount,
        accumulated_after_minor: acc + amount,
        created_at: clock.tsAgo(Math.max(0, clock.daysAgoOf(pEnd) - 2), 10, 0),
      });
    }
    push("asset_depreciation_run", {
      id: rid,
      org_id: orgId,
      reference: `DEP-${String(runNo).padStart(4, "0")}`,
      period_start: monthStart(mi),
      period_end: pEnd,
      method: "straight_line",
      status: BORN_STATES.asset_depreciation_run,
      total_minor: total,
      journal_entry_id: null,
      created_by: users.finance,
      created_at: clock.tsAgo(Math.max(0, clock.daysAgoOf(pEnd) - 2), 10, 0),
    });
  }
  // What the finance service will compute for the last complete month, given the final states.
  {
    const pEnd = monthEnd(serviceIdx);
    let lines = 0;
    let total = 0;
    for (const a of depreciable) {
      if (a.final !== "in_service" && a.final !== "in_storage" && a.final !== "under_maintenance")
        continue;
      if (a.startOn > pEnd) continue;
      const base = a.baseCost! - (a.residual ?? 0);
      const acc = accumulated.get(a.id) ?? 0;
      if (acc >= base) continue;
      const amount = Math.min(Math.floor(base / a.life!), base - acc);
      if (amount <= 0) continue;
      lines++;
      total += amount;
    }
    service.depreciation = {
      periodStart: monthStart(serviceIdx),
      periodEnd: pEnd,
      lines,
      totalMinor: total,
    };
    svc("asset_depreciation_run");
    svc("asset_depreciation_line", lines);
  }

  // ── sequences the services continue from ───────────────────────────────
  const sequences = [
    { scope: "asset", next: N + 1 },
    { scope: "asset_disposal", next: chosen.length + 1 },
    { scope: "asset_depreciation_run", next: runNo + 1 },
  ];
  for (const s of sequences)
    push("reference_sequence", { org_id: orgId, scope_key: s.scope, next_value: s.next });

  // ── the guarded status updates for everything that is not in the sample ──
  const group = (
    from: AssetStatus,
    to: AssetStatus,
    test: (a: AssetSpec) => boolean,
  ): [AssetStatus, AssetStatus, string[]] => [
    from,
    to,
    assets.filter((a) => !a.sample && test(a)).map((a) => a.id),
  ];
  const statusMoves: AssetsModel["statusMoves"] = [
    group(
      "draft",
      "in_service",
      (a) =>
        a.preFinal === "in_service" ||
        a.preFinal === "under_maintenance" ||
        a.preFinal === "in_transit",
    ),
    group("draft", "in_storage", (a) => a.preFinal === "in_storage"),
    group("draft", "lost", (a) => a.preFinal === "lost"),
    group("draft", "retired", (a) => a.preFinal === "retired"),
    group("in_service", "under_maintenance", (a) => a.preFinal === "under_maintenance"),
    group("in_service", "in_transit", (a) => a.preFinal === "in_transit"),
  ].filter((g) => g[2].length > 0);

  const counts: Record<string, number> = {};
  for (const t of ASSET_TABLES) if (rows[t]!.length) counts[t] = rows[t]!.length;
  const finalDistribution: Record<string, number> = {};
  for (const a of assets) finalDistribution[a.final] = (finalDistribution[a.final] ?? 0) + 1;

  return { assets, rows, counts, service, statusMoves, sequences, finalDistribution };
}

// ── Database state beyond the inserts: the guarded updates and the services ──

type LiveContext = LabContext & { skipServices?: boolean };
function isLive(ctx: LabContext): boolean {
  return !ctx.dryRun && (ctx as LiveContext).skipServices !== true;
}

/** Move every non-sample asset to its planned state through the trigger, and settle custody / condition. */
async function applyGuardedUpdates(ctx: LabContext, model: AssetsModel): Promise<number> {
  const org = ctx.orgId;
  let statements = 0;
  const settle = model.assets.filter((a) => !a.sample);
  for (let i = 0; i < settle.length; i += 2000) {
    const chunk = settle.slice(i, i + 2000);
    await ctx.sql.unsafe(
      `update public.asset a
       set custodian_user_id = p.custodian, custodian_since = p.since,
           warehouse_id = p.wh, location_id = p.loc, condition = p.cond, updated_at = p.upd
       from unnest($1::uuid[], $2::uuid[], $3::timestamptz[], $4::uuid[], $5::uuid[], $6::text[], $7::timestamptz[])
         as p(id, custodian, since, wh, loc, cond, upd)
       where a.id = p.id and a.org_id = $8 and a.status <> 'disposed'
         and (a.custodian_user_id is distinct from p.custodian or a.condition <> p.cond
              or a.warehouse_id is distinct from p.wh or a.location_id is distinct from p.loc)`,
      [
        chunk.map((a) => a.id),
        chunk.map((a) => a.custodian),
        chunk.map((a) => a.custodianSince),
        chunk.map((a) => a.warehouseId),
        chunk.map((a) => a.locationId),
        chunk.map((a) => a.condition),
        chunk.map((a) => a.updatedAt),
        org,
      ],
    );
    statements++;
  }
  const byId = new Map(model.assets.map((a) => [a.id, a]));
  for (const [from, to, ids] of model.statusMoves) {
    for (let i = 0; i < ids.length; i += 2000) {
      const chunk = ids.slice(i, i + 2000).map((x) => byId.get(x)!);
      await ctx.sql.unsafe(
        `update public.asset a
         set status = $2, updated_at = p.upd,
             retired_at = case when $2 = 'retired' then p.rat else a.retired_at end,
             retired_reason = case when $2 = 'retired' then p.rr else a.retired_reason end
         from unnest($3::uuid[], $4::timestamptz[], $5::timestamptz[], $6::text[]) as p(id, upd, rat, rr)
         where a.id = p.id and a.org_id = $1 and a.status = $7`,
        [
          org,
          to,
          chunk.map((a) => a.id),
          chunk.map((a) => a.updatedAt),
          chunk.map((a) =>
            a.retiredDaysAgo !== null ? ctx.clock.tsAgo(a.retiredDaysAgo, 11, 0) : null,
          ),
          chunk.map((a) => a.retiredReason),
          from,
        ],
      );
      statements++;
    }
  }
  return statements;
}

/** The representative sample, through the real services. Resumable: every call checks the live state first. */
async function driveServices(ctx: LabContext, model: AssetsModel): Promise<string[]> {
  const notes: string[] = [];
  const failures: string[] = [];
  let done = 0;
  const s = model.service;
  const org = ctx.orgId;
  const manager = ctx.ctxFor("manager");
  const field = ctx.ctxFor("field");
  const owner = ctx.ctxFor("owner");
  const admin = ctx.ctxFor("admin");
  const finance = ctx.ctxFor("finance");
  const mArch = ctx.archetypeOf("manager");
  const fArch = ctx.archetypeOf("field");
  const oArch = ctx.archetypeOf("owner");
  const aArch = ctx.archetypeOf("admin");
  const finArch = ctx.archetypeOf("finance");
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      done++;
    } catch (e) {
      failures.push(`${label}: ${(e as Error).message}`);
    }
  };
  const one = async <T>(q: Promise<unknown>): Promise<T | null> => ((await q) as T[])[0] ?? null;
  const exists = async (table: string, assetId: string): Promise<boolean> =>
    (await one<{ id: string }>(
      ctx.sql.unsafe(
        `select id::text as id from public.${table} where org_id = $1 and asset_id = $2 limit 1`,
        [org, assetId],
      ),
    )) !== null;

  const assetsSvc = await import("@/modules/assets/service");
  const approvals = await import("@/modules/approvals/service");
  const subledgers = await import("@/modules/finance/subledgers");

  // Custody first, while the sample assets are still draft and may be handed out.
  for (const c of s.custody) {
    if (await exists("asset_assignment", c.assetId)) continue;
    await attempt("assign", () =>
      assetsSvc.assignAsset(manager, mArch, {
        assetId: c.assetId,
        toUserId: c.toUser,
        reason: c.reason,
      }),
    );
    if (c.transfer) {
      const t = c.transfer;
      await attempt("transfer", () =>
        assetsSvc.transferAsset(manager, mArch, {
          assetId: c.assetId,
          toWarehouseId: t.toWarehouseId ?? undefined,
          toLocationId: t.toLocationId ?? undefined,
          toUserId: t.toUserId ?? undefined,
          reason: t.reason,
        }),
      );
    }
    if (c.ret)
      await attempt("return", () =>
        assetsSvc.returnAsset(manager, mArch, {
          assetId: c.assetId,
          reason: "Returned to the store",
        }),
      );
  }
  for (const i of s.inspections) {
    if (await exists("asset_inspection", i.assetId)) continue;
    await attempt("inspection", () =>
      assetsSvc.recordInspection(field, fArch, {
        assetId: i.assetId,
        inspectedOn: i.inspectedOn,
        kind: i.kind,
        passed: i.passed,
        conditionFound: i.conditionFound,
        findings: i.findings,
        nextDueOn: i.nextDueOn,
      }),
    );
  }
  for (const m of s.maintenance) {
    let planId =
      (
        await one<{ id: string }>(
          ctx.sql.unsafe(
            `select id::text as id from public.asset_maintenance_plan where org_id = $1 and asset_id = $2 limit 1`,
            [org, m.assetId],
          ),
        )
      )?.id ?? null;
    if (!planId) {
      await attempt("maintenance plan", async () => {
        const r = await assetsSvc.createMaintenancePlan(manager, mArch, {
          assetId: m.assetId,
          nameEn: m.plan.nameEn,
          nameAr: m.plan.nameAr,
          kind: m.plan.kind,
          intervalDays: m.plan.intervalDays,
          nextDueOn: m.plan.nextDueOn,
          instructions: m.plan.instructions,
        });
        planId = r.id;
      });
    }
    if (planId && !(await exists("asset_maintenance_event", m.assetId))) {
      const pid = planId;
      await attempt("maintenance event", () =>
        assetsSvc.recordMaintenance(field, fArch, {
          assetId: m.assetId,
          planId: pid,
          kind: m.event.kind,
          performedOn: m.event.performedOn,
          performedBy: field.userId,
          // Explicit, though it is also the default: this plan is created
          // with this single event, so the plan moves with it.
          advancePlan: true,
          costMinor: m.event.costMinor ?? undefined,
          currency: m.event.costMinor !== null ? ctx.company.currency : undefined,
          notes: m.event.notes,
        }),
      );
    }
  }
  for (const d of s.downtime) {
    if (await exists("asset_downtime", d.assetId)) continue;
    await attempt("downtime start", () =>
      assetsSvc.startDowntime(field, fArch, {
        assetId: d.assetId,
        startedAt: d.startedAt,
        reason: d.reason,
        detail: d.detail,
      }),
    );
    if (d.endedAt)
      await attempt("downtime end", () =>
        assetsSvc.endDowntime(field, fArch, d.assetId, { endedAt: d.endedAt! }),
      );
  }
  // Then the lifecycle moves, which the database's own state machine checks.
  for (const mv of s.statusMoves) {
    const cur = await one<{ status: AssetStatus }>(
      ctx.sql.unsafe(`select status from public.asset where org_id = $1 and id = $2`, [
        org,
        mv.assetId,
      ]),
    );
    if (!cur) continue;
    const at = mv.steps.findIndex((st) => st.to === cur.status);
    for (const st of mv.steps.slice(at + 1)) {
      await attempt(`status ${st.to}`, () =>
        assetsSvc.setAssetStatus(
          manager,
          mArch,
          mv.assetId,
          st.to as Exclude<AssetStatus, "disposed">,
          st.reason,
        ),
      );
    }
  }
  // Disposals: the owner decides, the administrator carries out.
  for (const d of s.disposals) {
    const cur = await one<{ status: string; state: string | null }>(
      ctx.sql.unsafe(
        `select d.status, (select p.state from public.approval p where p.org_id = d.org_id and p.id = $3) as state
         from public.asset_disposal d where d.org_id = $1 and d.id = $2`,
        [org, d.disposalId, d.approvalId],
      ),
    );
    if (!cur) continue;
    if (d.outcome === "pending") continue;
    if (cur.state === "pending") {
      await attempt(`disposal ${d.outcome}`, () =>
        approvals.decideApproval(owner, oArch, {
          approvalId: d.approvalId,
          decision: d.outcome === "reject" ? "rejected" : "approved",
          note: d.note,
        }),
      );
    }
    if (d.outcome === "complete") {
      const now = await one<{ status: string }>(
        ctx.sql.unsafe(`select status from public.asset_disposal where org_id = $1 and id = $2`, [
          org,
          d.disposalId,
        ]),
      );
      if (now?.status === "approved") {
        await attempt("disposal complete", () =>
          assetsSvc.completeDisposal(admin, aArch, {
            disposalId: d.disposalId,
            disposedOn: d.disposedOn,
            actualProceedsMinor: d.actualProceedsMinor ?? undefined,
            buyerName: d.buyerName ?? undefined,
          }),
        );
      }
    }
  }
  // The last complete month's depreciation, computed and posted by the finance service.
  const dep = s.depreciation;
  const run = await one<{ id: string }>(
    ctx.sql.unsafe(
      `select id::text as id from public.asset_depreciation_run where org_id = $1 and period_start = $2 and period_end = $3`,
      [org, dep.periodStart, dep.periodEnd],
    ),
  );
  if (!run)
    await attempt("depreciation run", () =>
      subledgers.runDepreciation(finance, finArch, {
        periodStart: dep.periodStart,
        periodEnd: dep.periodEnd,
      }),
    );

  notes.push(
    `${done} service calls (custody, inspection, maintenance, downtime, status, disposal, depreciation)`,
  );
  if (failures.length)
    notes.push(`${failures.length} service calls failed: ${failures.slice(0, 4).join(" | ")}`);
  return notes;
}

// ── The family ──────────────────────────────────────────────────────────────

export const assets: Family = {
  key: FAMILY,
  deps: ["setup", "people", "work"],
  appliesTo: (company: Company) => company.profile.enables.assets,

  plan(ctx): FamilyPlan {
    return { family: FAMILY, expected: { ...buildAssetsModel(ctx).counts } };
  },

  async seed(ctx): Promise<FamilyReport> {
    const model = buildAssetsModel(ctx);
    const counts: Record<string, number> = {};
    for (const table of ASSET_TABLES) {
      const list = model.rows[table]!;
      if (!list.length) continue;
      const r =
        table === "reference_sequence"
          ? await ctx.insert(
              table,
              list,
              "on conflict (org_id, scope_key) do update set next_value = greatest(reference_sequence.next_value, excluded.next_value)",
            )
          : await ctx.insert(table, list);
      counts[table] = r.attempted;
      ctx.log(`${table}: ${r.inserted}/${r.attempted} inserted`);
    }
    const notes: string[] = [
      `${model.assets.filter((a) => a.sample).length} sample assets, ${model.service.disposals.length} disposals and one depreciation run planned through the services`,
    ];
    if (isLive(ctx)) {
      const statements = await applyGuardedUpdates(ctx, model);
      ctx.log(
        `asset: ${statements} guarded status/custody updates through the state-machine trigger`,
      );
      notes.push(...(await driveServices(ctx, model)));
    }
    const handoff = {
      assetIds: model.assets.map((a) => a.id),
      liveAssetIds: model.assets
        .filter(
          (a) =>
            a.final === "in_service" ||
            a.final === "in_storage" ||
            a.final === "under_maintenance" ||
            a.final === "in_transit",
        )
        .map((a) => a.id),
      disposedAssetIds: model.assets.filter((a) => a.final === "disposed").map((a) => a.id),
      disposalIds: model.service.disposals.map((d) => d.disposalId),
      depreciationRunIds: model.rows.asset_depreciation_run!.map((r) => r.id as string),
      finalDistribution: model.finalDistribution,
    };
    return { family: FAMILY, counts, handoff, notes };
  },

  async verify(ctx): Promise<Check[]> {
    const model = buildAssetsModel(ctx);
    const org = ctx.orgId;
    const checks: Check[] = [];
    const count = async (text: string, params: unknown[] = [org]) =>
      Number(
        (
          (await ctx.sql.unsafe(text, params as never[])) as unknown as Array<{
            n: number | string;
          }>
        )[0]?.n ?? 0,
      );
    const zero = async (name: string, text: string) => {
      const n = await count(text);
      checks.push({ name, ok: n === 0, detail: n === 0 ? undefined : `${n} offending rows` });
    };

    // 1) Counts: the plan, plus what the services were asked to add.
    for (const table of ASSET_TABLES) {
      const planned = model.counts[table] ?? 0;
      const extra = model.service.counts[table] ?? 0;
      if (!planned && !extra) continue;
      /*
       * `approval` is written by work and sales as well, so counting every row
       * in the organisation says nothing about this family. Count the ones it
       * owns — the disposals it raised — and leave reference_sequence, which
       * everyone advances, to its own scoped query.
       */
      const n =
        table === "reference_sequence"
          ? await count(
              `select count(*)::int as n from public.reference_sequence where org_id = $1 and scope_key in ('asset', 'asset_disposal', 'asset_depreciation_run')`,
            )
          : table === "approval"
            ? await count(
                `select count(*)::int as n from public.approval where org_id = $1 and subject_type = 'asset_disposal'`,
              )
            : await count(`select count(*)::int as n from public.${table} where org_id = $1`);
      const want = planned + extra;
      checks.push({
        name: `${table} count`,
        ok: n === want,
        detail: `${n} rows, planned ${planned}${extra ? ` + ${extra} by the services` : ""}`,
      });
    }
    for (const s of model.sequences) {
      const row = (
        (await ctx.sql.unsafe(
          `select next_value::int as n from public.reference_sequence where org_id = $1 and scope_key = $2`,
          [org, s.scope],
        )) as unknown as Array<{ n: number }>
      )[0];
      checks.push({
        name: `reference_sequence ${s.scope} is past the seeded numbers`,
        ok: !!row && row.n >= s.next,
        detail: `${row?.n ?? "missing"} vs ${s.next}`,
      });
    }
    const distinctNos = await count(
      `select count(distinct asset_no)::int as n from public.asset where org_id = $1`,
    );
    checks.push({
      name: "asset numbers are unique",
      ok: distinctNos === model.assets.length,
      detail: `${distinctNos} distinct of ${model.assets.length}`,
    });

    // 2) The state machine ran: no draft survives, and the mix is the planned one.
    const got = (await ctx.sql.unsafe(
      `select status, count(*)::int as n from public.asset where org_id = $1 group by status`,
      [org],
    )) as unknown as Array<{ status: string; n: number }>;
    const gotMap = Object.fromEntries(got.map((g) => [g.status, Number(g.n)]));
    const want = model.finalDistribution;
    const distOk = Object.keys({ ...want, ...gotMap }).every(
      (k) => (want[k] ?? 0) === (gotMap[k] ?? 0),
    );
    checks.push({
      name: "status distribution matches the plan (transitions and disposals ran)",
      ok: distOk,
      detail: `got ${JSON.stringify(gotMap)} planned ${JSON.stringify(want)}`,
    });
    await zero(
      "retired assets carry a retirement date",
      `select count(*)::int as n from public.asset where org_id = $1 and status = 'retired' and retired_at is null`,
    );
    await zero(
      "disposed assets were retired first and carry a disposal date",
      `select count(*)::int as n from public.asset where org_id = $1 and status = 'disposed' and (retired_at is null or disposed_at is null)`,
    );
    await zero(
      "an asset is disposed exactly when it has a completed disposal",
      `select count(*)::int as n from public.asset a where a.org_id = $1
       and (a.status = 'disposed') <> exists (select 1 from public.asset_disposal d where d.org_id = a.org_id and d.asset_id = a.id and d.status = 'completed')`,
    );

    // 3) Custody: a member, and the one the trail implies.
    await zero(
      "every custodian is an active member of the organisation",
      `select count(*)::int as n from public.asset a where a.org_id = $1 and a.custodian_user_id is not null
       and not exists (select 1 from public.membership m where m.org_id = a.org_id and m.user_id = a.custodian_user_id and m.deactivated_at is null)`,
    );
    await zero(
      "asset.custodian_user_id is what the latest custody event implies",
      `select count(*)::int as n from public.asset a
       left join lateral (select s.event, s.to_user_id from public.asset_assignment s where s.org_id = a.org_id and s.asset_id = a.id
                          order by s.effective_at desc, s.created_at desc limit 1) e on true
       where a.org_id = $1 and a.status <> 'disposed'
         and a.custodian_user_id is distinct from (case when e.event in ('assigned', 'transferred') then e.to_user_id else null end)`,
    );
    await zero(
      "assigned events name a receiver and returns name a giver",
      `select count(*)::int as n from public.asset_assignment where org_id = $1 and ((event = 'assigned' and to_user_id is null) or (event = 'returned' and from_user_id is null))`,
    );
    await zero(
      "no custody event predates the asset's registration",
      `select count(*)::int as n from public.asset_assignment s join public.asset a on a.id = s.asset_id where s.org_id = $1 and s.effective_at < a.created_at - interval '1 day'`,
    );

    // 4) Inspections drive the condition; work raised by a failed inspection had started.
    await zero(
      "asset.condition is what the latest inspection found",
      `select count(*)::int as n from public.asset a
       join lateral (select i.condition_found from public.asset_inspection i where i.org_id = a.org_id and i.asset_id = a.id
                     order by i.inspected_on desc, i.created_at desc limit 1) i on true
       where a.org_id = $1 and a.condition <> i.condition_found`,
    );
    await zero(
      "inspections that raised work point at a job that had started",
      `select count(*)::int as n from public.asset_inspection i join public.job j on j.id = i.job_id and j.org_id = i.org_id where i.org_id = $1 and j.start_date > i.inspected_on`,
    );

    // 5) Maintenance: plans roll forward from the last event; events belong to their plan's asset.
    await zero(
      "a serviced plan's next due date is its last service plus its interval",
      `select count(*)::int as n from public.asset_maintenance_plan where org_id = $1 and active and last_done_on is not null and interval_days is not null
       and next_due_on is distinct from (last_done_on + interval_days)`,
    );
    await zero(
      "a plan's last_done_on is the date of its latest event",
      `select count(*)::int as n from public.asset_maintenance_plan p where p.org_id = $1
       and p.last_done_on is distinct from (select max(e.performed_on) from public.asset_maintenance_event e where e.org_id = p.org_id and e.plan_id = p.id)`,
    );
    await zero(
      "maintenance events name the same asset as their plan",
      `select count(*)::int as n from public.asset_maintenance_event e join public.asset_maintenance_plan p on p.id = e.plan_id where e.org_id = $1 and p.asset_id <> e.asset_id`,
    );
    await zero(
      "maintenance events that name a job name one that had started",
      `select count(*)::int as n from public.asset_maintenance_event e join public.job j on j.id = e.job_id and j.org_id = e.org_id where e.org_id = $1 and j.start_date > e.performed_on`,
    );
    const overdue = await count(
      `select count(*)::int as n from public.asset_maintenance_plan where org_id = $1 and active and next_due_on < $2::date`,
      [org, ctx.company.history.asOf],
    );
    checks.push({
      name: "some maintenance is overdue (the due list has something to show)",
      ok: overdue > 0,
      detail: `${overdue} overdue plans`,
    });

    // 6) Downtime: one spell at a time, open only while under maintenance, linked to this asset's work.
    await zero(
      "downtime spells never overlap",
      `select count(*)::int as n from public.asset_downtime d1 join public.asset_downtime d2
         on d2.org_id = d1.org_id and d2.asset_id = d1.asset_id and d2.id <> d1.id
        and d1.started_at < coalesce(d2.ended_at, 'infinity'::timestamptz) and d2.started_at < coalesce(d1.ended_at, 'infinity'::timestamptz)
       where d1.org_id = $1`,
    );
    await zero(
      "an asset under maintenance has an open spell and nothing else does",
      `select count(*)::int as n from public.asset a where a.org_id = $1
       and (a.status = 'under_maintenance') <> exists (select 1 from public.asset_downtime d where d.org_id = a.org_id and d.asset_id = a.id and d.ended_at is null)`,
    );
    await zero(
      "downtime linked to maintenance names this asset's event",
      `select count(*)::int as n from public.asset_downtime d join public.asset_maintenance_event e on e.id = d.maintenance_event_id where d.org_id = $1 and e.asset_id <> d.asset_id`,
    );

    // 7) Disposals and their approvals agree.
    await zero(
      "a submitted disposal has exactly one pending approval",
      `select count(*)::int as n from public.asset_disposal d where d.org_id = $1 and d.status = 'submitted'
       and (select count(*) from public.approval p where p.org_id = d.org_id and p.subject_type = 'asset_disposal' and p.subject_id = d.id and p.state = 'pending') <> 1`,
    );
    await zero(
      "an approved or completed disposal has an approved approval",
      `select count(*)::int as n from public.asset_disposal d where d.org_id = $1 and d.status in ('approved', 'completed')
       and not exists (select 1 from public.approval p where p.org_id = d.org_id and p.subject_type = 'asset_disposal' and p.subject_id = d.id and p.state = 'approved')`,
    );
    await zero(
      "a rejected disposal has a rejected approval with a reason",
      `select count(*)::int as n from public.asset_disposal d where d.org_id = $1 and d.status = 'rejected'
       and not exists (select 1 from public.approval p where p.org_id = d.org_id and p.subject_type = 'asset_disposal' and p.subject_id = d.id and p.state = 'rejected' and p.decision_note is not null)`,
    );
    await zero(
      "a completed sale records what it fetched",
      `select count(*)::int as n from public.asset_disposal where org_id = $1 and status = 'completed' and method = 'sale' and actual_proceeds_minor is null`,
    );
    const disposalStates = (await ctx.sql.unsafe(
      `select status, count(*)::int as n from public.asset_disposal where org_id = $1 group by status`,
      [org],
    )) as unknown as Array<{ status: string; n: number }>;
    const ds = Object.fromEntries(disposalStates.map((d) => [d.status, Number(d.n)]));
    const wantD = {
      completed: model.service.disposals.filter((d) => d.outcome === "complete").length,
      rejected: model.service.disposals.filter((d) => d.outcome === "reject").length,
      submitted: model.service.disposals.filter((d) => d.outcome === "pending").length,
    };
    checks.push({
      name: "disposal outcomes match the plan",
      ok:
        (ds.completed ?? 0) === wantD.completed &&
        (ds.rejected ?? 0) === wantD.rejected &&
        (ds.submitted ?? 0) === wantD.submitted,
      detail: `got ${JSON.stringify(ds)} planned ${JSON.stringify(wantD)}`,
    });

    // 8) Depreciation reconciles: running sums, the cap, the formula, the run totals, the posted entry.
    await zero(
      "every depreciation run's total is the sum of its lines",
      `select count(*)::int as n from public.asset_depreciation_run r where r.org_id = $1 and r.total_minor <> coalesce((select sum(l.amount_minor) from public.asset_depreciation_line l where l.org_id = r.org_id and l.run_id = r.id), 0)`,
    );
    await zero(
      "accumulated_after continues the running sum per asset",
      `select count(*)::int as n from (
         select l.accumulated_after_minor, sum(l.amount_minor) over (partition by l.asset_id order by r.period_end rows unbounded preceding) as running
         from public.asset_depreciation_line l join public.asset_depreciation_run r on r.id = l.run_id and r.org_id = l.org_id
         where l.org_id = $1) x where x.accumulated_after_minor <> x.running`,
    );
    await zero(
      "accumulated depreciation never exceeds cost minus residual",
      `select count(*)::int as n from public.asset_depreciation_line l join public.asset a on a.id = l.asset_id and a.org_id = l.org_id
       where l.org_id = $1 and l.accumulated_after_minor > coalesce(a.base_acquisition_cost_minor, a.acquisition_cost_minor, 0) - coalesce(a.residual_value_minor, 0)`,
    );
    await zero(
      "no monthly charge exceeds the straight-line amount",
      `select count(*)::int as n from public.asset_depreciation_line l join public.asset a on a.id = l.asset_id and a.org_id = l.org_id
       where l.org_id = $1 and (a.useful_life_months is null
         or l.amount_minor > floor((coalesce(a.base_acquisition_cost_minor, a.acquisition_cost_minor, 0) - coalesce(a.residual_value_minor, 0)) / a.useful_life_months))`,
    );
    await zero(
      "no line precedes the asset's depreciation start",
      `select count(*)::int as n from public.asset_depreciation_line l join public.asset_depreciation_run r on r.id = l.run_id join public.asset a on a.id = l.asset_id
       where l.org_id = $1 and r.period_end < coalesce(a.depreciation_start_on, a.acquired_on)`,
    );
    await zero(
      "no run covers the same period twice",
      `select count(*)::int as n from (select period_start, count(*) c from public.asset_depreciation_run where org_id = $1 group by period_start) x where c > 1`,
    );
    const sumLines = await count(
      `select coalesce(sum(amount_minor), 0)::bigint as n from public.asset_depreciation_line where org_id = $1`,
    );
    const sumRuns = await count(
      `select coalesce(sum(total_minor), 0)::bigint as n from public.asset_depreciation_run where org_id = $1`,
    );
    const plannedLines =
      model.rows.asset_depreciation_line!.reduce((a, r) => a + (r.amount_minor as number), 0) +
      model.service.depreciation.totalMinor;
    checks.push({
      name: "depreciation sums: lines = run totals = plan",
      ok: sumLines === sumRuns && sumLines === plannedLines,
      detail: `lines ${sumLines}, runs ${sumRuns}, planned ${plannedLines}`,
    });
    const dep = model.service.depreciation;
    const svcRun = (
      (await ctx.sql.unsafe(
        `select r.total_minor::bigint as total, r.journal_entry_id::text as je, j.status as je_status, j.total_debit_minor::bigint as dr, j.total_credit_minor::bigint as cr
       from public.asset_depreciation_run r left join public.journal_entry j on j.id = r.journal_entry_id
       where r.org_id = $1 and r.period_start = $2 and r.period_end = $3`,
        [org, dep.periodStart, dep.periodEnd],
      )) as unknown as Array<{
        total: string;
        je: string | null;
        je_status: string | null;
        dr: string;
        cr: string;
      }>
    )[0];
    checks.push({
      name: `the ${dep.periodStart.slice(0, 7)} run was made by the finance service and posted its entry`,
      ok:
        !!svcRun &&
        Number(svcRun.total) === dep.totalMinor &&
        (dep.totalMinor === 0 ||
          (svcRun.je_status === "posted" &&
            Number(svcRun.dr) === dep.totalMinor &&
            Number(svcRun.cr) === dep.totalMinor)),
      detail: svcRun
        ? `total ${svcRun.total} (planned ${dep.totalMinor}), entry ${svcRun.je ?? "none"} ${svcRun.je_status ?? ""} dr ${svcRun.dr ?? "-"} cr ${svcRun.cr ?? "-"}`
        : "no run",
    });

    // 9) Pagination: where the profile pushes a table past the threshold, prove it landed.
    for (const [table, planned] of Object.entries(model.counts)) {
      if (planned + (model.service.counts[table] ?? 0) <= PAGINATION_THRESHOLD) continue;
      const n = await count(`select count(*)::int as n from public.${table} where org_id = $1`);
      checks.push({
        name: `${table} crosses the ${PAGINATION_THRESHOLD}-row pagination threshold`,
        ok: n > PAGINATION_THRESHOLD,
        detail: String(n),
      });
    }
    return checks;
  },
};
