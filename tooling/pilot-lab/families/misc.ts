/**
 * H33 Pilot Lab — family `misc`: everything cross-cutting.
 *
 * Notifications (kinds from the platform registry, read/unread by age), each
 * persona's notification preferences, the operational activity timeline,
 * comment threads, the exception engine's materialised rows (open, auto-cleared,
 * actioned, and a representative subset dismissed through the real service with
 * an explanatory note), the owner's morning digests for the past year, one
 * completed CSV import with a few skipped rows, fifteen small REAL storage
 * objects per company with exact byte accounting, customer progress updates
 * (drafts in bulk, a representative subset sent through the real service),
 * sign-in events, a usage ledger, and the organisation's own holiday closures.
 *
 * What is bulk-inserted is born-state data with legal values: exceptions are
 * either open or carry the engine's own plain auto/actioned resolution columns
 * (no trigger, no side effect — indistinguishable from `clearExceptionIn`);
 * dismissals and customer-update sends are state transitions and go through
 * `dismissException` / `sendUpdate`. Nothing here posts, finalises or issues.
 *
 * Plan is pure arithmetic over the company profile and clock; seed consumes
 * `ctx.rng` in one fixed order, so two runs produce identical rows and the
 * second run inserts nothing (ON CONFLICT DO NOTHING).
 */
import { deflateSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Check,
  Company,
  Family,
  FamilyPlan,
  FamilyReport,
  LabContext,
  PersonaKey,
} from "../types";
import type { Rng } from "../../simulation/rng";
import type { SimClock } from "../../simulation/dates";
import { ref as refOf } from "../ids";
import type {
  AttachableType,
  FileAccessClass,
  NotificationKind,
  RoleArchetype,
} from "@/platform/registries";
import { CLASS_MAP } from "@/platform/files/classmap";
import { buildObjectPath } from "@/platform/files/paths";
import {
  companyName,
  doneByAge,
  historyDays,
  paragraph,
  personName,
  pick,
  sentence,
  spreadDates,
  weighted,
} from "./_shared";

type Row = Record<string, unknown>;

// ── Catalogues (mirrors of the product's closed lists) ──────────────────────

/** The exception rule catalogue — the migration check constraint (0045). */
export const MISC_RULE_KEYS = [
  "missing_report",
  "overdue_stage",
  "approval_stuck",
  "blocking_issue",
  "labour_outlier",
  "quote_divergence",
  "billing_point_reopened",
  "billing_point_uninvoiced",
  "overdue_invoice",
  "margin_drift",
  "late_po",
  "late_supplier",
  "unusual_expense",
  "document_expiry",
] as const;
type RuleKey = (typeof MISC_RULE_KEYS)[number];

/** sign_in_log.event check constraint (0003). */
export const SIGN_IN_EVENTS = [
  "login_success",
  "login_failure",
  "logout",
  "mfa_challenge_success",
  "otp_verified",
] as const;

/** Verbs the product's command path actually records (grep of ActivitySpec verbs). */
const VERBS: Record<string, readonly string[]> = {
  job: ["created", "started", "assigned", "moved", "completed", "reopened", "requested"],
  invoice: ["created", "issued", "adjusted", "commented"],
  document: ["created", "submitted", "returned", "issued", "obligation_added"],
  customer: ["created", "updated", "commented"],
  employee: ["created", "assigned", "updated"],
  purchase_order: ["created", "submitted", "requested", "adjusted"],
  supplier: ["created", "updated"],
};

type RuleSpec = {
  key: RuleKey;
  severities: readonly ("info" | "warning" | "critical")[];
  audience: readonly RoleArchetype[];
  subject: "job" | "invoice" | "approval" | "purchase_order" | "supplier" | "employee";
  weight: number;
};
const RULES: readonly RuleSpec[] = [
  {
    key: "missing_report",
    severities: ["warning"],
    audience: ["owner", "manager", "foreman"],
    subject: "job",
    weight: 20,
  },
  {
    key: "overdue_stage",
    severities: ["warning", "critical"],
    audience: ["owner", "manager"],
    subject: "job",
    weight: 14,
  },
  {
    key: "approval_stuck",
    severities: ["warning"],
    audience: ["owner", "admin", "manager"],
    subject: "approval",
    weight: 8,
  },
  {
    key: "blocking_issue",
    severities: ["critical"],
    audience: ["owner", "manager", "foreman"],
    subject: "job",
    weight: 8,
  },
  {
    key: "labour_outlier",
    severities: ["info", "warning"],
    audience: ["owner", "manager"],
    subject: "job",
    weight: 6,
  },
  {
    key: "quote_divergence",
    severities: ["warning"],
    audience: ["owner", "accounts"],
    subject: "job",
    weight: 4,
  },
  {
    key: "billing_point_reopened",
    severities: ["info"],
    audience: ["owner", "accounts"],
    subject: "job",
    weight: 2,
  },
  {
    key: "billing_point_uninvoiced",
    severities: ["warning"],
    audience: ["owner", "accounts"],
    subject: "job",
    weight: 6,
  },
  {
    key: "overdue_invoice",
    severities: ["warning", "critical"],
    audience: ["owner", "accounts"],
    subject: "invoice",
    weight: 12,
  },
  {
    key: "margin_drift",
    severities: ["critical"],
    audience: ["owner", "accounts"],
    subject: "job",
    weight: 5,
  },
  {
    key: "late_po",
    severities: ["warning"],
    audience: ["owner", "procurement"],
    subject: "purchase_order",
    weight: 6,
  },
  {
    key: "late_supplier",
    severities: ["warning"],
    audience: ["owner", "procurement"],
    subject: "supplier",
    weight: 2,
  },
  {
    key: "unusual_expense",
    severities: ["warning"],
    audience: ["owner", "accounts"],
    subject: "job",
    weight: 3,
  },
  {
    key: "document_expiry",
    severities: ["warning"],
    audience: ["owner", "admin"],
    subject: "employee",
    weight: 4,
  },
];

const RULE_LABEL: Record<RuleKey, { en: string; ar: string }> = {
  missing_report: { en: "Daily report missing", ar: "التقرير اليومي مفقود" },
  overdue_stage: { en: "Stage overdue", ar: "المرحلة متأخرة" },
  approval_stuck: { en: "Approval waiting too long", ar: "الموافقة معلّقة لفترة طويلة" },
  blocking_issue: { en: "Blocking issue unactioned", ar: "مشكلة معطِّلة دون إجراء" },
  labour_outlier: { en: "Labour hours outlier", ar: "ساعات عمل غير معتادة" },
  quote_divergence: { en: "Cost diverging from quote", ar: "التكلفة تبتعد عن العرض" },
  billing_point_reopened: { en: "Billing milestone reopened", ar: "أُعيد فتح نقطة الفوترة" },
  billing_point_uninvoiced: { en: "Milestone reached, not invoiced", ar: "بلغت النقطة ولم تُفوتر" },
  overdue_invoice: { en: "Invoice overdue", ar: "فاتورة متأخرة السداد" },
  margin_drift: { en: "Margin drift", ar: "انحراف الهامش" },
  late_po: { en: "Purchase order late", ar: "أمر شراء متأخر" },
  late_supplier: { en: "Supplier repeatedly late", ar: "مورّد متكرر التأخير" },
  unusual_expense: { en: "Unusual expense", ar: "مصروف غير معتاد" },
  document_expiry: { en: "Identity document expiring", ar: "وثيقة هوية قاربت الانتهاء" },
};

const DISMISS_NOTES = [
  {
    en: "Reviewed — the report was filed under the parent job; valid, no action needed.",
    ar: "تمت المراجعة — سُجّل التقرير تحت المشروع الرئيسي؛ صحيح ولا يلزم إجراء.",
  },
  {
    en: "Flagged correctly but expected: the client paused the site for Ramadan hours.",
    ar: "التنبيه صحيح لكنه متوقع: أوقف العميل الموقع مؤقتاً لساعات رمضان.",
  },
  {
    en: "Valid alert; the supplier confirmed delivery in writing, keeping the PO open on purpose.",
    ar: "تنبيه صحيح؛ أكد المورّد التسليم كتابياً، وأُبقي أمر الشراء مفتوحاً عمداً.",
  },
  {
    en: "Known variance — approved variation order covers the extra hours.",
    ar: "فرق معروف — أمر التغيير المعتمد يغطي الساعات الإضافية.",
  },
  {
    en: "Duplicate of an item already being handled in the weekly review.",
    ar: "مكرر لبند تجري معالجته في المراجعة الأسبوعية.",
  },
];

// ── Sizing (pure; the dry-run budget gate) ──────────────────────────────────

export type MiscSizes = {
  notification: number;
  activity: number;
  comment: number;
  exception: number;
  digest: number;
  importRows: number;
  files: number;
  customerUpdate: number;
  signIn: number;
  usage: number;
  holiday: number;
  preference: number;
  /** Exceptions dismissed through the real service (a subset of the open ones). */
  dismissTarget: number;
  /** Customer updates sent through the real service (a subset of the drafts). */
  sendTarget: number;
};

/** Which digest mornings exist: the last fortnight daily, then weekly for a year. */
export function digestDates(company: Company, clock: SimClock): string[] {
  const total = historyDays(company);
  const working = (daysAgo: number) => {
    const d = new Date(clock.dayAgo(daysAgo) + "T00:00:00Z").getUTCDay();
    if (d === 5) return false;
    if (d === 6 && !company.sixDayWeek) return false;
    return true;
  };
  const set = new Set<string>();
  for (let d = 0; d < 14 && d <= total; d++) if (working(d)) set.add(clock.dayAgo(d));
  for (let w = 2; w <= 52; w++) {
    let d = w * 7;
    if (d > total) break;
    while (!working(d)) d++;
    set.add(clock.dayAgo(d));
  }
  return [...set].sort();
}

type HolidayEntry = {
  starts_on: string;
  ends_on: string | null;
  label: { en: string; ar: string };
  kind: "public_holiday" | "eid" | "org";
};

/** The organisation's own calendar rows: the two years the template does not cover, plus closures. */
export function holidayEntries(company: Company): HolidayEntry[] {
  const sa = company.country === "SA";
  const out: HolidayEntry[] = [
    {
      starts_on: "2024-01-01",
      ends_on: null,
      label: { en: "New Year", ar: "رأس السنة" },
      kind: "public_holiday",
    },
    {
      starts_on: "2024-04-09",
      ends_on: "2024-04-12",
      label: { en: "Eid al-Fitr", ar: "عيد الفطر" },
      kind: "eid",
    },
    {
      starts_on: "2024-06-15",
      ends_on: "2024-06-18",
      label: { en: "Eid al-Adha", ar: "عيد الأضحى" },
      kind: "eid",
    },
    {
      starts_on: "2024-07-07",
      ends_on: null,
      label: { en: "Islamic New Year", ar: "رأس السنة الهجرية" },
      kind: "public_holiday",
    },
    {
      starts_on: "2025-01-01",
      ends_on: null,
      label: { en: "New Year", ar: "رأس السنة" },
      kind: "public_holiday",
    },
    {
      starts_on: "2025-03-30",
      ends_on: "2025-04-01",
      label: { en: "Eid al-Fitr", ar: "عيد الفطر" },
      kind: "eid",
    },
    {
      starts_on: "2025-06-05",
      ends_on: "2025-06-08",
      label: { en: "Eid al-Adha", ar: "عيد الأضحى" },
      kind: "eid",
    },
    {
      starts_on: "2025-06-26",
      ends_on: null,
      label: { en: "Islamic New Year", ar: "رأس السنة الهجرية" },
      kind: "public_holiday",
    },
  ];
  if (sa) {
    out.push(
      {
        starts_on: "2024-02-22",
        ends_on: null,
        label: { en: "Founding Day", ar: "يوم التأسيس" },
        kind: "public_holiday",
      },
      {
        starts_on: "2024-09-23",
        ends_on: null,
        label: { en: "National Day", ar: "اليوم الوطني" },
        kind: "public_holiday",
      },
      {
        starts_on: "2025-02-22",
        ends_on: null,
        label: { en: "Founding Day", ar: "يوم التأسيس" },
        kind: "public_holiday",
      },
      {
        starts_on: "2025-09-23",
        ends_on: null,
        label: { en: "National Day", ar: "اليوم الوطني" },
        kind: "public_holiday",
      },
    );
  } else {
    out.push(
      {
        starts_on: "2024-09-15",
        ends_on: null,
        label: { en: "Prophet's Birthday", ar: "المولد النبوي" },
        kind: "public_holiday",
      },
      {
        starts_on: "2024-12-02",
        ends_on: "2024-12-03",
        label: { en: "National Day", ar: "اليوم الوطني" },
        kind: "public_holiday",
      },
      {
        starts_on: "2025-09-05",
        ends_on: null,
        label: { en: "Prophet's Birthday", ar: "المولد النبوي" },
        kind: "public_holiday",
      },
      {
        starts_on: "2025-12-02",
        ends_on: "2025-12-03",
        label: { en: "National Day", ar: "اليوم الوطني" },
        kind: "public_holiday",
      },
    );
  }
  // Company closures (kind = org): year-end stock count and the annual staff day.
  for (const y of [2024, 2025, 2026]) {
    out.push({
      starts_on: `${y}-01-15`,
      ends_on: null,
      label: { en: "Annual stock count — warehouse closed", ar: "الجرد السنوي — المستودع مغلق" },
      kind: "org",
    });
    if (y < 2026)
      out.push({
        starts_on: `${y}-11-20`,
        ends_on: null,
        label: { en: "Staff day", ar: "يوم الموظفين" },
        kind: "org",
      });
  }
  return out.filter(
    (h) => h.starts_on >= company.history.from && h.starts_on <= company.history.asOf,
  );
}

export function miscSizes(company: Company, clock: SimClock): MiscSizes {
  const p = company.profile;
  const r = Math.round;
  const notification = r(
    p.jobs * 0.2 + p.invoices * 0.12 + p.opportunities * 0.15 + p.documents * 1.2 + p.employees * 3,
  );
  const activity = r(p.jobs * 0.35 + p.invoices * 0.2 + p.opportunities * 0.2 + p.documents * 1.2);
  const comment = r(p.jobs * 0.15 + p.invoices * 0.04 + p.opportunities * 0.08 + p.documents * 0.8);
  const exception = r(
    p.jobs * 0.1 + p.invoices * 0.04 + p.purchaseOrders * 0.03 + p.employees * 0.5,
  );
  const importRows = Math.min(80, Math.max(20, r(p.customers * 0.1)));
  const customerUpdate = r(p.projects * 0.1);
  return {
    notification,
    activity,
    comment,
    exception,
    digest: digestDates(company, clock).length,
    importRows,
    files: 15,
    customerUpdate,
    signIn: company.personas.length * 5 + 5,
    usage: 24,
    holiday: holidayEntries(company).length,
    preference: company.personas.length,
    dismissTarget: Math.min(20, Math.floor(exception * 0.06)),
    sendTarget: Math.min(12, r(customerUpdate * 0.3)),
  };
}

export function expectedOf(s: MiscSizes): Record<string, number> {
  return {
    notification: s.notification,
    notification_preference: s.preference,
    activity: s.activity,
    comment: s.comment,
    exception: s.exception,
    digest: s.digest,
    import_batch: 1,
    import_row: s.importRows,
    file: s.files,
    org_storage_usage: 1,
    customer_update: s.customerUpdate,
    sign_in_log: s.signIn,
    usage_event: s.usage,
    org_holiday_calendar: s.holiday,
  };
}

// ── Tiny real objects (deterministic bytes) ─────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit RGB PNG: horizontal stripes of the given colours plus a tEXt comment. */
export function tinyPng(
  width: number,
  height: number,
  stripes: Array<[number, number, number]>,
  comment: string,
): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    const [r, g, b] = stripes[Math.floor(y / 8) % stripes.length]!;
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const text = Buffer.concat([
    Buffer.from("Comment", "latin1"),
    Buffer.from([0]),
    Buffer.from(comment.replace(/[^\x20-\x7e]/g, "?"), "latin1"),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A valid single-page PDF 1.4 with Helvetica text lines and a correct xref table. */
export function tinyPdf(lines: string[]): Buffer {
  const esc = (s: string) =>
    s
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const content = [
    "BT",
    "/F1 11 Tf",
    "50 790 Td",
    "15 TL",
    ...lines.map((l) => `(${esc(l)}) Tj T*`),
    "ET",
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ── Targets: the rows other families wrote that this one links to ───────────

export type TargetRef = { id: string; label: string; name?: string; customerId?: string | null };
export type MiscTargets = {
  jobs: TargetRef[];
  invoices: TargetRef[];
  customers: TargetRef[];
  employees: TargetRef[];
  documents: TargetRef[];
  opportunities: TargetRef[];
  leads: TargetRef[];
  approvals: TargetRef[];
  purchaseOrders: TargetRef[];
  suppliers: TargetRef[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handoffIds(ctx: LabContext, family: string, keys: string[]): string[] {
  let h: Record<string, unknown>;
  try {
    h = ctx.handoff(family);
  } catch {
    return [];
  }
  for (const k of keys) {
    const v = h[k];
    const arr = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
    const ids = arr.filter((x): x is string => typeof x === "string" && UUID.test(x));
    if (ids.length) return ids;
  }
  return [];
}

async function rows(
  ctx: LabContext,
  text: string,
  params: unknown[] = [ctx.orgId],
): Promise<Row[]> {
  try {
    return (await ctx.sql.unsafe(text, params as never)) as unknown as Row[];
  } catch (e) {
    ctx.log(`misc: query failed — ${(e as Error).message.slice(0, 100)}`);
    return [];
  }
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

async function loadRefs(
  ctx: LabContext,
  table: string,
  labelCol: string | null,
  extra = "",
  limit = 1500,
): Promise<TargetRef[]> {
  const cols = ["id::text as id", labelCol ? `${labelCol}::text as label` : "null as label", extra]
    .filter(Boolean)
    .join(", ");
  const r = await rows(
    ctx,
    `select ${cols} from public.${table} where org_id = $1 order by created_at limit ${limit}`,
  );
  return r.map((x) => ({
    id: str(x.id),
    label: str(x.label, str(x.id).slice(0, 8)),
    name: typeof x.name === "string" ? x.name : undefined,
    customerId: typeof x.customer_id === "string" ? x.customer_id : null,
  }));
}

async function resolveTargets(ctx: LabContext): Promise<MiscTargets> {
  const fromHandoff = (family: string, keys: string[]): TargetRef[] =>
    handoffIds(ctx, family, keys).map((id) => ({ id, label: id.slice(0, 8) }));
  const jobs = await loadRefs(ctx, "job", "reference", "name, customer_id::text as customer_id");
  const invoices = await loadRefs(ctx, "invoice", "reference");
  const customers = await loadRefs(ctx, "customer", "name");
  const employees = await loadRefs(ctx, "employee", "name", "", 600);
  const documents = await loadRefs(ctx, "doc_document", "reference", "", 600);
  const opportunities = await loadRefs(ctx, "opportunity", null);
  const leads = await loadRefs(ctx, "lead", null);
  const approvals = await loadRefs(ctx, "approval", null, "", 600);
  const purchaseOrders = await loadRefs(ctx, "purchase_order", null);
  const suppliers = await loadRefs(ctx, "supplier", "name", "", 600);
  return {
    jobs: jobs.length ? jobs : fromHandoff("work", ["jobIds", "jobs", "sampleJobIds"]),
    invoices: invoices.length ? invoices : fromHandoff("sales", ["invoiceIds", "invoices"]),
    customers: customers.length ? customers : fromHandoff("masters", ["customerIds", "customers"]),
    employees: employees.length
      ? employees
      : fromHandoff("people", ["employeeIds", "employees", "personaEmployees"]),
    documents,
    opportunities: opportunities.length
      ? opportunities
      : fromHandoff("sales", ["opportunityIds", "opportunities"]),
    leads: leads.length ? leads : fromHandoff("sales", ["leadIds", "leads"]),
    approvals,
    purchaseOrders: purchaseOrders.length
      ? purchaseOrders
      : fromHandoff("work", ["purchaseOrderIds", "purchaseOrders"]),
    suppliers: suppliers.length ? suppliers : fromHandoff("masters", ["supplierIds", "suppliers"]),
  };
}

// ── The build (pure given the rng state) ────────────────────────────────────

export type MiscObject = { bucket: string; path: string; mime: string; body: Buffer };
export type MiscBuild = {
  notifications: Row[];
  preferences: Row[];
  activities: Row[];
  comments: Row[];
  exceptions: Row[];
  digests: Row[];
  importBatch: Row[];
  importRows: Row[];
  files: Row[];
  objects: MiscObject[];
  myBytes: number;
  customerUpdates: Row[];
  signIns: Row[];
  usage: Row[];
  holidays: Row[];
  /** Open exception ids to dismiss through the service, with the persona and note. */
  dismiss: Array<{ id: string; persona: PersonaKey; note: string }>;
  /** Draft customer-update ids to send through the service. */
  send: Array<{ id: string; persona: PersonaKey }>;
};

const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const monthKey = (iso: string) => iso.slice(0, 7);

function archetypeOf(company: Company, persona: PersonaKey): RoleArchetype {
  return company.personas.find((p) => p.key === persona)!.archetype;
}
function localeOf(company: Company, persona: PersonaKey): "en" | "ar" {
  return company.personas.find((p) => p.key === persona)!.locale;
}

const KINDS_BY_ARCHETYPE: Record<RoleArchetype, Record<string, number>> = {
  owner: {
    approval_requested: 22,
    approval_decided: 6,
    exception_raised: 20,
    document_signature_requested: 8,
    document_obligation_due: 8,
    document_signed: 5,
    crm_customer_at_risk: 6,
    crm_renewal_due: 6,
    crm_discount_requested: 6,
    system: 4,
  },
  admin: {
    approval_requested: 12,
    approval_decided: 8,
    exception_raised: 14,
    document_review_requested: 14,
    document_signature_requested: 10,
    document_signed: 10,
    document_obligation_due: 8,
    system: 8,
  },
  manager: {
    approval_requested: 18,
    approval_decided: 14,
    exception_raised: 22,
    document_review_requested: 8,
    crm_lead_assigned: 8,
    crm_follow_up_due: 10,
    crm_opportunity_stalled: 8,
    crm_discount_requested: 4,
    system: 3,
  },
  accounts: {
    approval_requested: 16,
    approval_decided: 10,
    exception_raised: 28,
    document_obligation_due: 12,
    crm_discount_requested: 8,
    crm_renewal_due: 6,
    system: 4,
  },
  procurement: { approval_requested: 20, approval_decided: 30, exception_raised: 30, system: 5 },
  foreman: { approval_decided: 40, payslip_issued: 30, exception_raised: 15, system: 10 },
  viewer: { system: 60, document_signed: 40 },
  worker_reserved_p3: { system: 1 },
};

function notificationText(
  rng: Rng,
  kind: NotificationKind,
  lang: "en" | "ar",
  t: MiscTargets,
): { title: string; body: string | null; entityType: string | null; entityId: string | null } {
  const job = t.jobs.length ? pick(rng, t.jobs) : null;
  const doc = t.documents.length ? pick(rng, t.documents) : null;
  const cust = t.customers.length ? pick(rng, t.customers) : null;
  const opp = t.opportunities.length ? pick(rng, t.opportunities) : null;
  const lead = t.leads.length ? pick(rng, t.leads) : null;
  const appr = t.approvals.length ? pick(rng, t.approvals) : null;
  const mrRef = refOf("MR", rng.int(1, 900), 4);
  const withBody = rng.chance(0.55);
  const body = withBody ? sentence(rng, lang) : null;
  const ar = lang === "ar";
  switch (kind) {
    case "approval_requested":
      return {
        title: ar ? `طلب موافقة — ${mrRef}` : `Approval requested — ${mrRef}`,
        body,
        entityType: appr ? "approval" : job ? "job" : null,
        entityId: appr?.id ?? job?.id ?? null,
      };
    case "approval_decided": {
      const ok = rng.chance(0.8);
      return {
        title: ar
          ? `${ok ? "تمت الموافقة" : "تم الرفض"}: ${mrRef}`
          : `${ok ? "Approved" : "Rejected"}: ${mrRef}`,
        body,
        entityType: appr ? "approval" : job ? "job" : null,
        entityId: appr?.id ?? job?.id ?? null,
      };
    }
    case "exception_raised":
      // Entity is patched to one of this family's exception rows by the caller.
      return { title: "", body: null, entityType: "exception", entityId: null };
    case "payslip_issued":
      return {
        title: ar ? "صدرت قسيمة راتبك" : "Your payslip has been issued",
        body: null,
        entityType: null,
        entityId: null,
      };
    case "document_review_requested":
      return {
        title: ar
          ? `طلب مراجعة: ${doc?.label ?? "مستند"}`
          : `Review requested: ${doc?.label ?? "document"}`,
        body,
        entityType: doc ? "document" : null,
        entityId: doc?.id ?? null,
      };
    case "document_signature_requested":
      return {
        title: ar
          ? `بانتظار توقيعك: ${doc?.label ?? "مستند"}`
          : `Awaiting your signature: ${doc?.label ?? "document"}`,
        body,
        entityType: doc ? "document" : null,
        entityId: doc?.id ?? null,
      };
    case "document_signed":
      return {
        title: ar ? `تم التوقيع: ${doc?.label ?? "مستند"}` : `Signed: ${doc?.label ?? "document"}`,
        body: null,
        entityType: doc ? "document" : null,
        entityId: doc?.id ?? null,
      };
    case "document_obligation_due":
      return {
        title: ar
          ? `التزام مستحق قريباً: ${doc?.label ?? "مستند"}`
          : `Obligation due soon: ${doc?.label ?? "document"}`,
        body,
        entityType: doc ? "document" : null,
        entityId: doc?.id ?? null,
      };
    case "crm_lead_assigned":
      return {
        title: ar ? "أُسند إليك عميل محتمل جديد" : "A new lead was assigned to you",
        body,
        entityType: lead ? "lead" : null,
        entityId: lead?.id ?? null,
      };
    case "crm_follow_up_due":
      return {
        title: ar
          ? `متابعة مستحقة: ${cust?.label ?? "عميل"}`
          : `Follow-up due: ${cust?.label ?? "customer"}`,
        body,
        entityType: opp ? "opportunity" : cust ? "customer" : null,
        entityId: opp?.id ?? cust?.id ?? null,
      };
    case "crm_opportunity_stalled":
      return {
        title: ar ? "فرصة متوقفة منذ 14 يوماً" : "Opportunity stalled for 14 days",
        body,
        entityType: opp ? "opportunity" : null,
        entityId: opp?.id ?? null,
      };
    case "crm_discount_requested":
      return {
        title: ar ? "طلب خصم بانتظار قرار" : "Discount request awaiting a decision",
        body: null,
        entityType: opp ? "opportunity" : null,
        entityId: opp?.id ?? null,
      };
    case "crm_customer_at_risk":
      return {
        title: ar
          ? `عميل معرّض للخطر: ${cust?.label ?? ""}`.trim()
          : `Customer at risk: ${cust?.label ?? ""}`.trim(),
        body,
        entityType: cust ? "customer" : null,
        entityId: cust?.id ?? null,
      };
    case "crm_renewal_due":
      return {
        title: ar
          ? `تجديد مستحق: ${cust?.label ?? ""}`.trim()
          : `Renewal due: ${cust?.label ?? ""}`.trim(),
        body,
        entityType: cust ? "customer" : null,
        entityId: cust?.id ?? null,
      };
    default:
      return {
        title: pick(
          rng,
          ar
            ? ["مرحباً بك في IdaraWorks", "اكتملت الصيانة المجدولة", "تم تحديث إعدادات المؤسسة"]
            : [
                "Welcome to IdaraWorks",
                "Scheduled maintenance completed",
                "Organisation settings were updated",
              ],
        ),
        body: null,
        entityType: null,
        entityId: null,
      };
  }
}

export function buildMisc(ctx: LabContext, t: MiscTargets): MiscBuild {
  const { company, rng, clock, orgId } = ctx;
  const s = miscSizes(company, clock);
  const arabicFirst = company.languages[0] === "ar";
  const total = historyDays(company);
  const langFor = () => (rng.chance(arabicFirst ? 0.7 : 0.3) ? "ar" : "en") as "en" | "ar";
  const stamp = (daysAgo: number) => clock.tsAgo(daysAgo, rng.int(6, 18), rng.int(0, 59));
  const users = ctx.users;

  // ── exceptions (first: notifications and digests link to them) ────────────
  const exceptions: Row[] = [];
  const excMeta: Array<{
    id: string;
    rule: RuleKey;
    jobId: string | null;
    sev: string;
    raised: string;
    resolved: string | null;
    audience: readonly RoleArchetype[];
  }> = [];
  const dedup = new Set<string>();
  const excDates = spreadDates(rng, company, s.exception);
  for (let i = 0; i < s.exception; i++) {
    const id = ctx.id("misc.exception", i);
    const spec = weighted(
      rng,
      Object.fromEntries(RULES.map((r) => [r.key, r.weight])) as Record<RuleKey, number>,
    );
    const rule = RULES.find((r) => r.key === spec)!;
    const sev = pick(rng, rule.severities);
    let daysAgo = excDates[i]!;
    const job = t.jobs.length ? pick(rng, t.jobs) : null;
    let jobId: string | null = null;
    let subjectType: string | null = null;
    let subjectId: string | null = null;
    switch (rule.subject) {
      case "job":
        jobId = job?.id ?? null;
        break;
      case "approval":
        jobId = job?.id ?? null;
        subjectType = "approval";
        subjectId = t.approvals.length ? pick(rng, t.approvals).id : null;
        break;
      case "invoice":
        subjectType = "invoice";
        subjectId = t.invoices.length ? pick(rng, t.invoices).id : null;
        break;
      case "purchase_order":
        subjectType = "purchase_order";
        subjectId = t.purchaseOrders.length ? pick(rng, t.purchaseOrders).id : null;
        break;
      case "supplier":
        subjectType = "supplier";
        subjectId = t.suppliers.length ? pick(rng, t.suppliers).id : null;
        break;
      case "employee":
        subjectType = "employee";
        subjectId = t.employees.length ? pick(rng, t.employees).id : null;
        break;
    }
    // One open row per (rule, subject, period): the real dedup shape, made unique by construction.
    let key = "";
    for (let tries = 0; tries < 400; tries++) {
      key = `${rule.key}:${subjectId ?? jobId ?? "org"}:${clock.dayAgo(daysAgo)}`;
      if (!dedup.has(key)) break;
      daysAgo = Math.max(0, daysAgo - 1);
      if (tries === 399) key = `${key}:${i}`;
    }
    dedup.add(key);
    const raised = stamp(daysAgo);
    const resolved = daysAgo >= 2 && doneByAge(rng, daysAgo, 45);
    const resolvedAt = resolved
      ? addMs(raised, rng.int(1, Math.min(30, daysAgo)) * DAY + rng.int(0, 8) * HOUR)
      : null;
    const resolution = resolved ? (rng.chance(0.8) ? "auto" : "actioned") : null;
    const evidence: unknown[] = [];
    if (jobId) evidence.push({ type: "job", id: jobId });
    if (subjectType && subjectId) evidence.push({ type: subjectType, id: subjectId });
    if (rule.key === "missing_report")
      evidence.push({ type: "date", value: clock.dayAgo(daysAgo) });
    exceptions.push({
      id,
      org_id: orgId,
      rule_key: rule.key,
      severity: sev,
      job_id: jobId,
      subject_type: subjectType,
      subject_id: subjectId,
      evidence_refs: evidence,
      audience_roles: [...rule.audience],
      dedup_key: key,
      raised_at: raised,
      last_evaluated_at: resolvedAt ?? clock.tsAgo(rng.int(0, 1), 2, 15),
      resolved_at: resolvedAt,
      resolution,
      resolved_by: null,
      resolution_note: null,
      created_at: raised,
    });
    excMeta.push({
      id,
      rule: rule.key,
      jobId,
      sev,
      raised,
      resolved: resolvedAt,
      audience: rule.audience,
    });
  }
  // Representative dismissals through the real service (open rows the manager may see).
  const dismiss: MiscBuild["dismiss"] = [];
  const dismissable = excMeta.filter((e) => e.resolved === null && e.audience.includes("manager"));
  for (let k = 0; k < dismissable.length && dismiss.length < s.dismissTarget; k += 3) {
    const note = DISMISS_NOTES[dismiss.length % DISMISS_NOTES.length]!;
    dismiss.push({
      id: dismissable[k]!.id,
      persona: "manager",
      note: arabicFirst ? note.ar : note.en,
    });
  }

  // ── notifications ─────────────────────────────────────────────────────────
  const notifications: Row[] = [];
  const nDates = spreadDates(rng, company, s.notification);
  for (let i = 0; i < s.notification; i++) {
    const recipient = weighted(rng, {
      owner: 18,
      admin: 12,
      manager: 22,
      finance: 16,
      hr: 8,
      warehouse: 10,
      field: 8,
      restricted: 3,
      auditor: 3,
    } as Record<PersonaKey, number>);
    const archetype = archetypeOf(company, recipient);
    const lang = localeOf(company, recipient);
    const kind = weighted(rng, KINDS_BY_ARCHETYPE[archetype]) as NotificationKind;
    const text = notificationText(rng, kind, lang, t);
    let { title, entityId } = text;
    if (kind === "exception_raised") {
      const e = pick(rng, excMeta);
      const label = RULE_LABEL[e.rule];
      title = lang === "ar" ? label.ar : label.en;
      entityId = e.id;
    }
    const daysAgo = nDates[i]!;
    const created = stamp(daysAgo);
    const read = daysAgo < 3 ? rng.chance(0.25) : daysAgo < 14 ? rng.chance(0.6) : rng.chance(0.92);
    const readAt = read ? addMs(created, rng.int(5, 72 * 60) * 60_000) : null;
    notifications.push({
      id: ctx.id("misc.notification", i),
      org_id: orgId,
      user_id: users[recipient],
      kind,
      title: title.slice(0, 200),
      body: text.body,
      entity_type: text.entityType,
      entity_id: entityId,
      read_at: readAt && readAt < clock.tsAgo(0, 18) ? readAt : read ? created : null,
      created_at: created,
    });
  }

  // ── notification preferences (one per persona) ────────────────────────────
  const preferences: Row[] = company.personas.map((p) => {
    const heavy = p.archetype === "owner" || p.archetype === "accounts";
    const channels: Record<string, Record<string, boolean>> = {
      approval_requested: { in_app: true, email: heavy, push: p.archetype === "foreman" },
      approval_decided: { in_app: true, email: false, push: true },
      exception_raised: { in_app: true, email: heavy, push: false },
      document_obligation_due: { in_app: true, email: p.archetype !== "foreman" },
      crm_follow_up_due: { in_app: p.archetype === "manager", email: false },
      system: { in_app: true, email: false, push: false },
    };
    if (p.archetype === "viewer") channels.system = { in_app: true, email: false };
    return {
      org_id: orgId,
      user_id: users[p.key],
      channels,
      updated_at: clock.tsAgo(rng.int(5, Math.min(200, total)), 10, rng.int(0, 59)),
    };
  });

  // ── activity timeline ─────────────────────────────────────────────────────
  const pools: Record<string, TargetRef[]> = {
    job: t.jobs,
    invoice: t.invoices,
    document: t.documents,
    customer: t.customers,
    employee: t.employees,
    purchase_order: t.purchaseOrders,
    supplier: t.suppliers,
  };
  const actorFor: Record<string, Record<PersonaKey, number>> = {
    job: { manager: 50, field: 25, owner: 10, restricted: 10, admin: 5 } as Record<
      PersonaKey,
      number
    >,
    invoice: { finance: 80, owner: 10, manager: 10 } as Record<PersonaKey, number>,
    document: { admin: 45, manager: 30, owner: 15, finance: 10 } as Record<PersonaKey, number>,
    customer: { manager: 50, admin: 25, owner: 25 } as Record<PersonaKey, number>,
    employee: { hr: 70, admin: 20, owner: 10 } as Record<PersonaKey, number>,
    purchase_order: { warehouse: 70, manager: 20, finance: 10 } as Record<PersonaKey, number>,
    supplier: { warehouse: 70, admin: 30 } as Record<PersonaKey, number>,
  };
  const pickEntity = (
    weights: Record<string, number>,
  ): { type: AttachableType; ref: TargetRef } | null => {
    const type = weighted(rng, weights);
    const pool = pools[type]!.length ? pools[type]! : t.jobs.length ? t.jobs : [];
    const realType = pools[type]!.length ? type : "job";
    if (!pool.length) return null;
    // Cluster on a "hot" subset so timelines and threads have depth.
    const hot = Math.min(pool.length, 160);
    const ref = rng.chance(0.7) ? pool[rng.int(0, hot - 1)]! : pick(rng, pool);
    return { type: realType as AttachableType, ref };
  };
  const activities: Row[] = [];
  const aDates = spreadDates(rng, company, s.activity);
  for (let i = 0; i < s.activity; i++) {
    const e = pickEntity({
      job: 45,
      invoice: 15,
      document: 12,
      customer: 10,
      employee: 6,
      purchase_order: 8,
      supplier: 4,
    });
    const type = e?.type ?? "job";
    const verb = pick(rng, VERBS[type] ?? ["updated"]);
    const actor = weighted(rng, actorFor[type] ?? actorFor.job!);
    const lang = langFor();
    const label = e?.ref.label ?? "—";
    const summary =
      lang === "ar"
        ? `${verbAr(verb)} ${typeAr(type)} ${label}. ${sentence(rng, "ar")}`
        : `${verb} ${type.replace("_", " ")} ${label}. ${sentence(rng, "en")}`;
    activities.push({
      id: ctx.id("misc.activity", i),
      org_id: orgId,
      actor_user_id: users[actor],
      entity_type: type,
      entity_id: e?.ref.id ?? ctx.id("misc.activity.orphan", i),
      verb,
      summary: summary.slice(0, 600),
      created_at: stamp(aDates[i]!),
    });
  }

  // ── comment threads ───────────────────────────────────────────────────────
  const comments: Row[] = [];
  const cDates = spreadDates(rng, company, s.comment);
  for (let i = 0; i < s.comment; i++) {
    const e = pickEntity({ job: 50, invoice: 10, document: 20, customer: 10, purchase_order: 10 });
    const type = e?.type ?? "job";
    const author = weighted(rng, actorFor[type] ?? actorFor.job!);
    const lang = langFor();
    const created = stamp(cDates[i]!);
    const edited = rng.chance(0.08);
    const deleted = rng.chance(0.03);
    comments.push({
      id: ctx.id("misc.comment", i),
      org_id: orgId,
      entity_type: type,
      entity_id: e?.ref.id ?? ctx.id("misc.comment.orphan", i),
      author_user_id: users[author],
      body: paragraph(rng, lang, rng.int(1, 3)).slice(0, 4000),
      edited_at: edited ? addMs(created, rng.int(3, 180) * 60_000) : null,
      deleted_at: deleted ? addMs(created, rng.int(1, 48) * HOUR) : null,
      deleted_by: deleted ? users[rng.chance(0.5) ? author : "admin"] : null,
      created_at: created,
    });
  }

  // ── owner digests ─────────────────────────────────────────────────────────
  const digests: Row[] = [];
  const RISK = new Set([
    "overdue_stage",
    "margin_drift",
    "missing_report",
    "approval_stuck",
    "billing_point_uninvoiced",
  ]);
  for (const date of digestDates(company, clock)) {
    const morning = `${date}T02:30:00.000Z`;
    const openAt = (rules: Set<string> | null, ownerOnly: boolean) =>
      excMeta.filter(
        (e) =>
          e.raised <= morning &&
          (e.resolved === null || e.resolved > morning) &&
          (!ownerOnly || e.audience.includes("owner")) &&
          (rules === null || rules.has(e.rule)),
      );
    const risk = openAt(RISK, true);
    const overdue = openAt(new Set(["overdue_invoice"]), false);
    const supply = openAt(new Set(["late_po", "late_supplier"]), false);
    const yReports = rng.int(0, Math.max(1, Math.round(company.profile.employees / 8)));
    const sections = [
      {
        key: "needs_decision",
        labelKey: "digest.section.needs_decision",
        count: rng.int(0, 6),
        moneyMinor: null,
        items: [],
      },
      {
        key: "at_risk",
        labelKey: "digest.section.at_risk",
        count: risk.length,
        moneyMinor: null,
        items: risk
          .slice(0, 10)
          .map((e) => ({ id: e.id, ruleKey: e.rule, jobId: e.jobId, severity: e.sev })),
      },
      {
        key: "collections",
        labelKey: "digest.section.collections",
        count: overdue.length,
        moneyMinor: overdue.length ? overdue.length * rng.int(40, 900) * 5000 : 0,
        items: [],
      },
      {
        key: "supply",
        labelKey: "digest.section.supply",
        count: supply.length,
        moneyMinor: null,
        items: [],
      },
      {
        key: "yesterday",
        labelKey: "digest.section.yesterday",
        count: yReports,
        moneyMinor: null,
        items: [],
      },
      {
        key: "crew",
        labelKey: "digest.section.crew",
        count: Math.min(yReports, rng.int(0, yReports + 1)),
        moneyMinor: null,
        items: [],
      },
      {
        key: "customers_awaiting",
        labelKey: "digest.section.customers_awaiting",
        count: rng.int(0, 4),
        moneyMinor: null,
        items: [],
      },
      {
        key: "this_week",
        labelKey: "digest.section.this_week",
        count: rng.int(0, 12),
        moneyMinor: null,
        items: [],
      },
    ];
    const numbers = new Set<number>();
    for (const sec of sections) {
      numbers.add(sec.count);
      if (sec.moneyMinor !== null) numbers.add(sec.moneyMinor);
    }
    digests.push({
      id: ctx.id("misc.digest", date),
      org_id: orgId,
      audience: "owner",
      digest_date: date,
      payload: { audience: "owner", computedAt: morning, sections, numbers: [...numbers] },
      narration: null,
      narration_lang: null,
      narration_status: "disabled",
      computed_at: morning,
      created_at: morning,
      updated_at: morning,
    });
  }

  // ── one completed CSV import ──────────────────────────────────────────────
  const batchId = ctx.id("misc.import_batch", 0);
  const batchDay = Math.max(0, total - 25);
  const batchAt = clock.tsAgo(batchDay, 10, 12);
  const skipped = 3;
  const invalid = 2;
  const importRows: Row[] = [];
  for (let i = 0; i < s.importRows; i++) {
    const n = i + 1;
    const person = personName(rng, i + 400);
    const co = companyName(rng, i + 900);
    const status = i < invalid ? "invalid" : i < invalid + skipped ? "skipped" : "applied";
    const rawName = i === 0 ? "" : co.display;
    const rawEmail =
      i === 1
        ? "not-an-email"
        : `${co.en.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${n}@example.invalid`;
    const raw = {
      "Customer Name": rawName,
      Country: company.country,
      "Contact Name": person.en,
      Phone: `${company.country === "SA" ? "+966" : "+971"} 50 000 ${String(7000 + n).padStart(4, "0")}`,
      Email: rawEmail,
      TRN:
        company.country === "SA"
          ? `399999${String(n).padStart(9, "0")}`
          : `1999${String(n).padStart(11, "0")}`,
      Notes: rng.chance(0.4) ? sentence(rng, "en") : "",
    };
    const mapped = {
      name: rawName,
      country: company.country,
      contactName: person.en,
      phone: raw.Phone,
      email: rawEmail,
      taxRegNo: raw.TRN,
      notes: raw.Notes || undefined,
    };
    const created =
      status === "applied" && t.customers.length
        ? t.customers[(i * 7) % t.customers.length]!.id
        : null;
    importRows.push({
      id: ctx.id("misc.import_row", i),
      org_id: orgId,
      batch_id: batchId,
      row_number: n,
      raw,
      mapped,
      status,
      error:
        i === 0
          ? "name: Required"
          : i === 1
            ? "email: Invalid email"
            : status === "skipped"
              ? "Possible duplicate of an existing customer — skipped by the reviewer"
              : null,
      created_entity_id: created,
      created_at: batchAt,
      updated_at: addMs(batchAt, 40 * 60_000),
    });
  }
  const importBatch: Row[] = [
    {
      id: batchId,
      org_id: orgId,
      kind: "customers",
      status: "applied",
      source_filename: "customers-legacy-export.csv",
      row_count: s.importRows,
      applied_count: s.importRows - skipped - invalid,
      error_count: invalid,
      created_by: users.admin,
      created_at: batchAt,
      updated_at: addMs(batchAt, 45 * 60_000),
    },
  ];

  // ── files: fifteen small real objects ─────────────────────────────────────
  type FileSpec = {
    cls: FileAccessClass;
    pool: TargetRef[];
    type: AttachableType;
    kind: "png" | "pdf";
    uploader: PersonaKey;
  };
  const fileSpecs: FileSpec[] = [
    ...Array.from({ length: 6 }, (_, k): FileSpec => ({
      cls: "job_media",
      pool: t.jobs,
      type: "job",
      kind: "png",
      uploader: k % 2 ? "manager" : "field",
    })),
    ...Array.from({ length: 4 }, (): FileSpec => ({
      cls: "financial_doc",
      pool: t.invoices,
      type: "invoice",
      kind: "png",
      uploader: "finance",
    })),
    ...Array.from({ length: 2 }, (): FileSpec => ({
      cls: "hr_doc",
      pool: t.employees,
      type: "employee",
      kind: "pdf",
      uploader: "admin",
    })),
    ...Array.from({ length: 3 }, (_, k): FileSpec => ({
      cls: "document_file",
      pool: t.documents,
      type: "document",
      kind: "pdf",
      uploader: k % 2 ? "manager" : "admin",
    })),
  ];
  const files: Row[] = [];
  const objects: MiscObject[] = [];
  const fDates = spreadDates(rng, company, fileSpecs.length);
  let myBytes = 0;
  fileSpecs.forEach((spec, i) => {
    const fileId = ctx.id("misc.file", i);
    const pool = spec.pool.length ? spec.pool : t.jobs.length ? t.jobs : null;
    const type: AttachableType = spec.pool.length ? spec.type : "job";
    const target = pool ? pick(rng, pool) : { id: orgId, label: "org" };
    const bucket = CLASS_MAP[spec.cls].bucket;
    const ext = spec.kind;
    const path = buildObjectPath({
      orgId,
      accessClass: spec.cls,
      attachedToType: type,
      attachedToId: target.id,
      fileId,
      ext,
    });
    const label = target.label.replace(/[^A-Za-z0-9-]+/g, "-").slice(0, 24) || "ref";
    let body: Buffer;
    let name: string;
    let mime: string;
    let variants: Row;
    if (spec.kind === "png") {
      const [w, h] = pick(rng, [
        [320, 240],
        [240, 320],
        [160, 120],
      ] as const);
      const stripes: Array<[number, number, number]> = Array.from({ length: rng.int(2, 4) }, () => [
        rng.int(20, 235),
        rng.int(20, 235),
        rng.int(20, 235),
      ]);
      body = tinyPng(w, h, stripes, `H33 pilot lab fixture ${company.key} file ${i} ${label}`);
      mime = "image/png";
      name =
        spec.cls === "job_media" ? `site-photo-${label}-${i + 1}.png` : `receipt-scan-${label}.png`;
      const v = { path, bytes: body.length, width: w, height: h, mime };
      variants = { main: v, medium: v, thumb: v };
    } else {
      body = tinyPdf([
        "IdaraWorks - H33 Pilot Lab fixture (fictional)",
        company.legalNameEn,
        `Reference: ${target.label}`,
        `File ${i + 1} of ${fileSpecs.length} - ${spec.cls}`,
        "",
        ...Array.from({ length: rng.int(2, 5) }, () => sentence(rng, "en")),
      ]);
      mime = "application/pdf";
      name = spec.cls === "hr_doc" ? `id-copy-${i + 1}.pdf` : `signed-scan-${label}.pdf`;
      variants = { main: { path, bytes: body.length, mime } };
    }
    const created = stamp(fDates[i]!);
    myBytes += body.length;
    objects.push({ bucket, path, mime, body });
    files.push({
      id: fileId,
      org_id: orgId,
      access_class: spec.cls,
      attached_to_type: type,
      attached_to_id: target.id,
      bucket,
      object_path: path,
      original_name: name,
      mime,
      status: "ready",
      bytes: body.length,
      reserved_bytes: 0,
      variants,
      exif_stripped: spec.kind === "png",
      legal_hold: i === 12,
      voided_at: null,
      voided_by: null,
      void_reason: null,
      created_by: users[spec.uploader],
      created_at: created,
      updated_at: addMs(created, 90_000),
    });
  });

  // ── customer updates (drafts; a subset is sent through the service) ───────
  const customerUpdates: Row[] = [];
  const cuDates = spreadDates(rng, company, s.customerUpdate);
  const custName = new Map(t.customers.map((c) => [c.id, c.label]));
  const cuMeta: Array<{ id: string; daysAgo: number }> = [];
  for (let i = 0; i < s.customerUpdate; i++) {
    const id = ctx.id("misc.customer_update", i);
    const job = t.jobs.length ? pick(rng, t.jobs) : null;
    const lang: "en" | "ar" = rng.chance(arabicFirst ? 0.8 : 0.3) ? "ar" : "en";
    const refText = job?.label ?? "";
    const stagesEn = pick(rng, [
      "mobilisation, site works",
      "design approval, procurement",
      "structure, envelope",
    ]);
    const stagesAr = pick(rng, [
      "التحرك، أعمال الموقع",
      "اعتماد التصميم، المشتريات",
      "الهيكل، الغلاف الخارجي",
    ]);
    const pct = rng.int(15, 95);
    const created = stamp(cuDates[i]!);
    customerUpdates.push({
      id,
      org_id: orgId,
      job_id: job?.id ?? null,
      job_name: job?.name ?? null,
      customer_id: job?.customerId ?? null,
      customer_name: job?.customerId ? (custName.get(job.customerId) ?? null) : null,
      title: lang === "ar" ? `تحديث المشروع ${refText}`.trim() : `Project update ${refText}`.trim(),
      language: lang,
      body:
        lang === "ar"
          ? `نودّ إطلاعكم على آخر مستجدات مشروعكم. المراحل المكتملة: ${stagesAr}. نسبة الإنجاز: ${pct}%. ${sentence(rng, "ar")} نشكر ثقتكم.`
          : `Here is the latest on your project. Completed so far: ${stagesEn}. Progress: ${pct}%. ${sentence(rng, "en")} Thank you for your trust.`,
      content: null,
      status: "draft",
      ai_drafted: false,
      sent_at: null,
      created_by: users[rng.chance(0.8) ? "manager" : "owner"],
      created_at: created,
      updated_at: created,
    });
    cuMeta.push({ id, daysAgo: cuDates[i]! });
  }
  const send: MiscBuild["send"] = [...cuMeta]
    .sort((a, b) => a.daysAgo - b.daysAgo)
    .slice(0, s.sendTarget)
    .map((m) => ({ id: m.id, persona: "manager" as PersonaKey }));

  // ── sign-in events ────────────────────────────────────────────────────────
  const signIns: Row[] = [];
  const agents = {
    phone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    android:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
    desktop:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  };
  let si = 0;
  const pushSignIn = (persona: PersonaKey, event: string, daysAgo: number, detail: Row) => {
    const mobile = persona === "field" || persona === "restricted";
    signIns.push({
      id: ctx.id("misc.sign_in", si++),
      org_id: orgId,
      user_id: users[persona],
      event,
      detail,
      ip: `203.0.113.${rng.int(1, 254)}`,
      user_agent: mobile ? (rng.chance(0.5) ? agents.phone : agents.android) : agents.desktop,
      created_at: clock.tsAgo(daysAgo, rng.int(6, 20), rng.int(0, 59)),
    });
  };
  for (const p of company.personas) {
    const method = p.key === "field" || p.key === "restricted" ? "magic_link" : "password";
    for (let k = 0; k < 4; k++)
      pushSignIn(p.key, "login_success", rng.int(0, Math.min(45, total)), {
        method,
        locale: p.locale,
      });
    pushSignIn(p.key, "logout", rng.int(0, Math.min(45, total)), { method });
  }
  pushSignIn("owner", "mfa_challenge_success", rng.int(0, 30), { factor: "totp" });
  pushSignIn("admin", "mfa_challenge_success", rng.int(0, 30), { factor: "totp" });
  pushSignIn("finance", "mfa_challenge_success", rng.int(0, 30), { factor: "totp" });
  pushSignIn("field", "login_failure", rng.int(0, 30), {
    method: "magic_link",
    reason: "expired_link",
  });
  pushSignIn("restricted", "login_failure", rng.int(0, 30), {
    method: "password",
    reason: "bad_password",
  });

  // ── usage ledger: trial-period narration credits, the product's one metered key ─
  const usage: Row[] = [];
  const firstMonth = new Date(company.history.from + "T00:00:00Z");
  let ui = 0;
  for (let m = 1; m <= 6; m++) {
    const d = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + m, 1));
    const period = d.toISOString().slice(0, 7);
    const n = 3 + (m % 3);
    for (let k = 0; k < n; k++) {
      const at = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), rng.int(2, 27), rng.int(6, 18)),
      ).toISOString();
      usage.push({
        id: ctx.id("misc.usage", ui),
        org_id: orgId,
        meter_key: "ai_credits",
        period_key: period,
        dedup_key: `ai_interaction:${ctx.id("misc.usage.interaction", ui)}`,
        delta: rng.int(1, 3),
        created_at: at,
      });
      ui++;
    }
  }
  void monthKey;

  // ── the organisation's holiday closures ───────────────────────────────────
  const holidays: Row[] = holidayEntries(company).map((h, i) => ({
    id: ctx.id("misc.holiday", i),
    org_id: orgId,
    starts_on: h.starts_on,
    ends_on: h.ends_on,
    label: h.label,
    kind: h.kind,
    created_at: `${company.history.from}T08:00:00.000Z`,
    updated_at: `${company.history.from}T08:00:00.000Z`,
  }));

  return {
    notifications,
    preferences,
    activities,
    comments,
    exceptions,
    digests,
    importBatch,
    importRows,
    files,
    objects,
    myBytes,
    customerUpdates,
    signIns,
    usage,
    holidays,
    dismiss,
    send,
  };
}

function verbAr(verb: string): string {
  const m: Record<string, string> = {
    created: "أُنشئ",
    started: "بدأ",
    assigned: "أُسند",
    moved: "نُقل",
    completed: "اكتمل",
    reopened: "أُعيد فتح",
    requested: "طُلب",
    issued: "صدر",
    adjusted: "عُدّل",
    commented: "عُلّق على",
    submitted: "قُدّم",
    returned: "أُعيد",
    obligation_added: "أُضيف التزام إلى",
    updated: "حُدّث",
  };
  return m[verb] ?? verb;
}
function typeAr(type: string): string {
  const m: Record<string, string> = {
    job: "المشروع",
    invoice: "الفاتورة",
    document: "المستند",
    customer: "العميل",
    employee: "الموظف",
    purchase_order: "أمر الشراء",
    supplier: "المورّد",
  };
  return m[type] ?? type;
}

// ── Storage ─────────────────────────────────────────────────────────────────

export async function uploadObjects(admin: SupabaseClient, objects: MiscObject[]): Promise<number> {
  let n = 0;
  for (const o of objects) {
    const { error } = await admin.storage
      .from(o.bucket)
      .upload(o.path, o.body, { contentType: o.mime, upsert: true, cacheControl: "3600" });
    if (error) throw new Error(`storage upload failed for ${o.bucket}/${o.path}: ${error.message}`);
    n++;
  }
  return n;
}

const USAGE_SUM_SQL = `select coalesce(sum(case when status = 'ready' then coalesce(bytes, 0) else reserved_bytes end), 0)::bigint as total
  from public.file where org_id = $1 and voided_at is null`;

async function storedBytes(ctx: LabContext): Promise<number> {
  const r = await rows(ctx, USAGE_SUM_SQL);
  return Number(r[0]?.total ?? 0);
}

// ── Service-driven transitions (skipped in dry-run and in unit tests) ───────

async function dismissViaService(ctx: LabContext, list: MiscBuild["dismiss"]): Promise<number> {
  if (!list.length) return 0;
  const { dismissException } = await import("@/modules/exceptions/service");
  let n = 0;
  for (const d of list) {
    try {
      await dismissException(ctx.ctxFor(d.persona), ctx.archetypeOf(d.persona), {
        exceptionId: d.id,
        note: d.note,
      });
      n++;
    } catch (e) {
      // Already dismissed on a previous run, or out of audience — both are fine to skip.
      ctx.log(`misc: dismiss ${d.id.slice(0, 8)} skipped — ${(e as Error).name}`);
    }
  }
  return n;
}

async function sendViaService(ctx: LabContext, list: MiscBuild["send"]): Promise<number> {
  if (!list.length) return 0;
  const { sendUpdate } = await import("@/modules/customer-updates/service");
  let n = 0;
  for (const s of list) {
    try {
      await sendUpdate(ctx.ctxFor(s.persona), ctx.archetypeOf(s.persona), s.id);
      n++;
    } catch (e) {
      ctx.log(`misc: send ${s.id.slice(0, 8)} skipped — ${(e as Error).name}`);
    }
  }
  return n;
}

// ── The family ──────────────────────────────────────────────────────────────

export const misc: Family = {
  key: "misc",
  // docstudio too: resolveTargets reads doc_document, so the documents must
  // exist before the notifications, comments and activities that point at them.
  deps: ["setup", "people", "masters", "work", "sales", "docstudio"],
  appliesTo: () => true,

  plan(ctx: LabContext): FamilyPlan {
    return { family: "misc", expected: expectedOf(miscSizes(ctx.company, ctx.clock)) };
  },

  async seed(ctx: LabContext): Promise<FamilyReport> {
    const targets = await resolveTargets(ctx);
    const b = buildMisc(ctx, targets);
    const counts: Record<string, number> = {};
    let fresh = 0;
    const put = async (table: string, r: Row[], conflict?: string) => {
      const res = await ctx.insert(table, r, conflict);
      counts[table] = res.attempted;
      fresh += res.inserted;
      ctx.log(`${table}: ${res.attempted} rows (${res.inserted} new)`);
    };

    await put("exception", b.exceptions);
    await put("notification", b.notifications);
    await put("notification_preference", b.preferences);
    await put("activity", b.activities);
    await put("comment", b.comments);
    await put("digest", b.digests);
    await put("import_batch", b.importBatch);
    await put("import_row", b.importRows);
    await put("file", b.files);
    if (!ctx.dryRun) {
      const n = await uploadObjects(ctx.admin, b.objects);
      ctx.log(`storage: ${n} objects (${b.myBytes} bytes)`);
    }
    const bytesUsed = ctx.dryRun ? b.myBytes : await storedBytes(ctx);
    await put(
      "org_storage_usage",
      [{ org_id: ctx.orgId, bytes_used: bytesUsed, reconciled_at: ctx.clock.tsAgo(0, 4) }],
      "on conflict (org_id) do update set bytes_used = excluded.bytes_used, reconciled_at = excluded.reconciled_at",
    );
    await put("customer_update", b.customerUpdates);
    await put("sign_in_log", b.signIns);
    await put("usage_event", b.usage);
    await put("org_holiday_calendar", b.holidays);

    let dismissed = 0;
    let sent = 0;
    if (!ctx.dryRun) {
      dismissed = await dismissViaService(ctx, b.dismiss);
      sent = await sendViaService(ctx, b.send);
    }

    return {
      family: "misc",
      counts,
      handoff: {
        importBatchId: b.importBatch[0]!.id,
        fileIds: b.files.map((f) => f.id as string),
        exceptionSample: b.exceptions.slice(0, 5).map((e) => e.id as string),
        notificationCount: b.notifications.length,
      },
      notes: [
        `${fresh} rows new`,
        `${b.objects.length} storage objects, usage set to ${bytesUsed} bytes`,
        `${dismissed}/${b.dismiss.length} exceptions dismissed via service`,
        `${sent}/${b.send.length} customer updates sent via service`,
      ],
    };
  },

  async verify(ctx: LabContext): Promise<Check[]> {
    const s = miscSizes(ctx.company, ctx.clock);
    const expected = expectedOf(s);
    const checks: Check[] = [];
    const ck = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
    const count = async (text: string, params: unknown[] = [ctx.orgId]) => {
      const r = await rows(ctx, text, params);
      return Number(r[0]?.n ?? -1);
    };
    const ids = (family: string, n: number) =>
      Array.from({ length: n }, (_, i) => ctx.id(family, i));

    // 1) Counts of this family's own rows against the plan.
    const own: Array<[string, string, number]> = [
      ["notification", "misc.notification", expected.notification!],
      ["activity", "misc.activity", expected.activity!],
      ["comment", "misc.comment", expected.comment!],
      ["exception", "misc.exception", expected.exception!],
      ["import_row", "misc.import_row", expected.import_row!],
      ["file", "misc.file", expected.file!],
      ["customer_update", "misc.customer_update", expected.customer_update!],
      ["sign_in_log", "misc.sign_in", expected.sign_in_log!],
      ["usage_event", "misc.usage", expected.usage_event!],
      ["org_holiday_calendar", "misc.holiday", expected.org_holiday_calendar!],
      ["import_batch", "misc.import_batch", 1],
    ];
    for (const [table, fam, n] of own) {
      const got = await count(
        `select count(*)::int as n from public.${table} where org_id = $1 and id = any($2::uuid[])`,
        [ctx.orgId, ids(fam, n)],
      );
      ck(`${table} rows match plan`, got === n, `${got}/${n}`);
    }
    const digestIds = digestDates(ctx.company, ctx.clock).map((d) => ctx.id("misc.digest", d));
    const gotDigests = await count(
      `select count(*)::int as n from public.digest where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, digestIds],
    );
    ck(
      "digest rows match plan",
      gotDigests === digestIds.length,
      `${gotDigests}/${digestIds.length}`,
    );
    const prefs = await count(
      `select count(*)::int as n from public.notification_preference where org_id = $1 and user_id = any($2::uuid[])`,
      [ctx.orgId, Object.values(ctx.users)],
    );
    ck("notification_preference per persona", prefs === s.preference, `${prefs}/${s.preference}`);

    // 2) Storage accounting: the counter equals the sum of accounted file bytes.
    const sum = await storedBytes(ctx);
    const usageRows = await rows(
      ctx,
      `select bytes_used::bigint as bytes_used from public.org_storage_usage where org_id = $1`,
    );
    const used = Number(usageRows[0]?.bytes_used ?? -1);
    ck("org_storage_usage == sum(file.bytes)", used === sum, `${used} vs ${sum}`);

    // 3) Every file row has a real object of the recorded size.
    const fileRows = await rows(
      ctx,
      `select id::text as id, bucket, object_path, bytes::bigint as bytes from public.file where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, ids("misc.file", s.files)],
    );
    let missing = 0;
    let wrongSize = 0;
    for (const f of fileRows) {
      const path = str(f.object_path);
      const dir = path.slice(0, path.lastIndexOf("/"));
      const name = path.slice(path.lastIndexOf("/") + 1);
      const { data, error } = await ctx.admin.storage
        .from(str(f.bucket))
        .list(dir, { search: name, limit: 10 });
      const hit = !error && data ? data.find((o) => o.name === name) : undefined;
      if (!hit) missing++;
      else {
        const size = Number((hit.metadata as Record<string, unknown> | null)?.size ?? -1);
        if (size !== Number(f.bytes)) wrongSize++;
      }
    }
    ck(
      "every file row has a storage object",
      fileRows.length === s.files && missing === 0,
      `${missing} missing of ${fileRows.length}`,
    );
    ck("object sizes equal file.bytes", wrongSize === 0, `${wrongSize} mismatched`);

    // 4) Pagination thresholds where the profile implies them.
    const nAll = await count(
      `select count(*)::int as n from public.notification where org_id = $1`,
    );
    ck(
      expected.notification! > 1205
        ? "notifications exceed 1,205 (pagination)"
        : "notifications at least the plan",
      expected.notification! > 1205 ? nAll > 1205 : nAll >= expected.notification!,
      `${nAll}`,
    );
    const aAll = await count(`select count(*)::int as n from public.activity where org_id = $1`);
    ck(
      expected.activity! > 1205
        ? "activity exceeds 1,205 (pagination)"
        : "activity at least the plan",
      expected.activity! > 1205 ? aAll > 1205 : aAll >= expected.activity!,
      `${aAll}`,
    );

    // 5) Exceptions: legal lifecycle, one open row per dedup key, dismissals carry notes.
    const badRes = await count(
      `select count(*)::int as n from public.exception where org_id = $1 and ((resolved_at is null) <> (resolution is null))`,
    );
    ck("exception resolution ⇔ resolved_at", badRes === 0, `${badRes} inconsistent`);
    const dupOpen = await count(
      `select count(*) - count(distinct dedup_key) as n from public.exception where org_id = $1 and resolved_at is null`,
    );
    ck("one open exception per dedup key", dupOpen === 0, `${dupOpen} duplicates`);
    const dismissed = await count(
      `select count(*)::int as n from public.exception where org_id = $1 and id = any($2::uuid[]) and resolution = 'dismissed' and resolution_note is not null and resolved_by is not null`,
      [ctx.orgId, ids("misc.exception", s.exception)],
    );
    ck(
      "dismissed exceptions carry a note and a resolver",
      s.dismissTarget === 0 || dismissed >= 1,
      `${dismissed} dismissed (target ${s.dismissTarget})`,
    );
    const orphanJobs = await count(
      `select count(*)::int as n from public.exception e where e.org_id = $1 and e.job_id is not null and not exists (select 1 from public.job j where j.id = e.job_id and j.org_id = e.org_id)`,
    );
    ck("exception.job_id resolves", orphanJobs === 0, `${orphanJobs} orphans`);

    // 6) Cross-links from the timeline and threads to real rows.
    const linkTables: Record<string, string> = {
      job: "job",
      invoice: "invoice",
      document: "doc_document",
      customer: "customer",
      employee: "employee",
      purchase_order: "purchase_order",
      supplier: "supplier",
    };
    for (const [table, fam, n] of [
      ["activity", "misc.activity", s.activity],
      ["comment", "misc.comment", s.comment],
    ] as const) {
      let orphans = 0;
      for (const [type, target] of Object.entries(linkTables)) {
        orphans += Math.max(
          0,
          await count(
            `select count(*)::int as n from public.${table} a where a.org_id = $1 and a.id = any($2::uuid[]) and a.entity_type = '${type}' and not exists (select 1 from public.${target} x where x.id = a.entity_id and x.org_id = a.org_id)`,
            [ctx.orgId, ids(fam, n)],
          ),
        );
      }
      ck(`${table} entity links resolve`, orphans === 0, `${orphans} orphans`);
    }
    const nOrphans = await count(
      `select count(*)::int as n from public.notification x where x.org_id = $1 and x.id = any($2::uuid[]) and x.entity_type = 'exception' and not exists (select 1 from public.exception e where e.id = x.entity_id and e.org_id = x.org_id)`,
      [ctx.orgId, ids("misc.notification", s.notification)],
    );
    ck("exception notifications link to exception rows", nOrphans === 0, `${nOrphans} orphans`);

    // 7) The import reconciles.
    const batch = await rows(
      ctx,
      `select row_count, applied_count, error_count, status, (select count(*) from public.import_row r where r.batch_id = b.id and r.org_id = b.org_id) as rows, (select count(*) from public.import_row r where r.batch_id = b.id and r.org_id = b.org_id and r.status = 'skipped') as skipped from public.import_batch b where b.org_id = $1 and b.id = $2`,
      [ctx.orgId, ctx.id("misc.import_batch", 0)],
    );
    const bt = batch[0];
    ck(
      "import batch reconciles",
      !!bt &&
        bt.status === "applied" &&
        Number(bt.rows) === Number(bt.row_count) &&
        Number(bt.applied_count) + Number(bt.error_count) + Number(bt.skipped) ===
          Number(bt.row_count),
      bt
        ? `${bt.applied_count} applied + ${bt.error_count} invalid + ${bt.skipped} skipped = ${bt.row_count}`
        : "no batch",
    );

    // 8) Customer updates: drafts in bulk, sends through the service.
    const sent = await count(
      `select count(*)::int as n from public.customer_update where org_id = $1 and id = any($2::uuid[]) and status = 'sent' and content is not null and sent_at is not null`,
      [ctx.orgId, ids("misc.customer_update", s.customerUpdate)],
    );
    ck(
      "customer updates sent via service",
      s.sendTarget === 0 || sent >= 1,
      `${sent} sent (target ${s.sendTarget})`,
    );
    const cuOrphans = await count(
      `select count(*)::int as n from public.customer_update c where c.org_id = $1 and ((c.job_id is not null and not exists (select 1 from public.job j where j.id = c.job_id and j.org_id = c.org_id)) or (c.customer_id is not null and not exists (select 1 from public.customer k where k.id = c.customer_id and k.org_id = c.org_id)))`,
    );
    ck("customer_update links resolve", cuOrphans === 0, `${cuOrphans} orphans`);

    // 9) Digest payloads keep the numbers allow-list invariant and link to real exceptions.
    const dg = await rows(
      ctx,
      `select payload from public.digest where org_id = $1 and id = any($2::uuid[])`,
      [ctx.orgId, digestIds],
    );
    let badNumbers = 0;
    const riskIds = new Set<string>();
    for (const d of dg) {
      const p = d.payload as {
        sections: Array<{
          count: number;
          moneyMinor: number | null;
          items: Array<{ id?: string }>;
        }>;
        numbers: number[];
      };
      const want = new Set<number>();
      for (const sec of p.sections) {
        want.add(sec.count);
        if (sec.moneyMinor !== null) want.add(sec.moneyMinor);
        for (const it of sec.items) if (typeof it.id === "string") riskIds.add(it.id);
      }
      const have = new Set(p.numbers);
      if (want.size !== have.size || [...want].some((x) => !have.has(x))) badNumbers++;
    }
    ck("digest numbers == section figures", badNumbers === 0, `${badNumbers} bad of ${dg.length}`);
    const riskFound = riskIds.size
      ? await count(
          `select count(*)::int as n from public.exception where org_id = $1 and id = any($2::uuid[])`,
          [ctx.orgId, [...riskIds]],
        )
      : 0;
    ck(
      "digest at-risk items link to exceptions",
      riskFound === riskIds.size,
      `${riskFound}/${riskIds.size}`,
    );

    return checks;
  },
};
