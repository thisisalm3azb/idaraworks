/**
 * H33 Pilot Lab — sales: quotations, invoices and credit notes, payments and
 * receipts, dunning attempts, customer progress updates and share links.
 *
 * Two layers, deliberately separable:
 *
 *   1. A PURE build (`buildSales`) turns the company profile and the seeded Rng
 *      into every bulk row. Quotes, invoices and payments carry no database
 *      trigger (see the trigger table in docs/H33-TRUTH-MAP.md) — their states
 *      are enforced by CHECK constraints and reached by the product through
 *      reconciliation — so bulk rows are written in the states the constraints
 *      allow AND the product would reach: an invoice is `paid` /
 *      `partially_paid` / `issued` exactly as `reconcileInvoiceStatus` leaves
 *      it given its live payments and credit notes; a payment is `recorded`
 *      (born) or `void` (the voidPayment transition, mirrored field for field);
 *      a quote is never `pending_approval` or `converting` because those imply
 *      an approval row this family does not invent. Every total is
 *      `computeTotals` — the same arithmetic as computeQuoteTotals /
 *      computeInvoiceTotals. plan(), seed(), verify() and the unit test all
 *      read one memoised build, so the dry-run count is the seed count by
 *      construction.
 *
 *   2. A SERVICE-driven sample (20 invoices per company) walks the real
 *      lifecycle — createInvoice → issueInvoice → recordPayment,
 *      createCreditNote, voidPayment — so audit_log, domain_event, approvals,
 *      journal entries and tax entries exist the way the application writes
 *      them. Skipped in dry-run and when `salesRuntime.live` is off (the unit
 *      test); resumable through a progress marker in app_settings so a crash
 *      never mints a second sample.
 *
 * References follow the product's own serials (QT-001, INV-001, CN-001, PMT-001,
 * RCP-001) and `reference_sequence` is advanced past the bulk so the services
 * continue the numbering rather than colliding with it.
 */
import { createHash } from "node:crypto";
import { computeTotals } from "../../simulation/money";
import { SEED_VERSION } from "../marker";
import type { Check, Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import {
  companyName,
  longTitle,
  paragraph,
  pick,
  priceMinor,
  sentence,
  spreadDates,
  taxNo,
  weighted,
} from "./_shared";

const FAMILY = "sales";
type Row = Record<string, unknown>;

/** Tables this family writes in bulk, in dependency order. */
export const SALES_TABLES = [
  "quote",
  "quote_line",
  "invoice",
  "invoice_line",
  "payment",
  "payment_receipt",
  "dunning_attempt",
  "customer_update",
  "share_token",
  "document_share",
  "reference_sequence",
] as const;

/**
 * Switches the parts of seed()/verify() that talk to the database beyond
 * ctx.insert — the master-name enrichment and the service-driven sample. The
 * orchestrator never touches it; the unit test turns it off so the family runs
 * against an in-memory insert with no database at all.
 */
export const salesRuntime = { live: true };

/** The product's {prefix}-{seq} serial (formatRef in @/platform/reference/sequence). */
function serial(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

// ── Handoff readers ─────────────────────────────────────────────────────────
// masters → customerIds / inactiveCustomerIds / itemIds (string arrays)
// work    → jobs as [id, customerId, statusCategory, start, due, preset, isProject, origin]
// setup   → vatProfile ({ registered } for the UAE companies, null for the Saudi one)

export type CustomerRef = { id: string; active: boolean };
export type JobRef = { id: string; customerId: string | null; category: string; origin: string };

function handoffOf(ctx: LabContext, family: string): Record<string, unknown> {
  try {
    return ctx.handoff<Record<string, unknown>>(family) ?? {};
  } catch {
    return {};
  }
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
/** A list of ids given as strings or as objects carrying an id. */
function idList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): string[] => {
    if (typeof x === "string") return [x];
    if (x && typeof x === "object" && !Array.isArray(x) && typeof (x as Row).id === "string")
      return [(x as Row).id as string];
    return [];
  });
}

export function customersFrom(ctx: LabContext): CustomerRef[] {
  const h = handoffOf(ctx, "masters");
  const ids = idList(h.customerIds).length ? idList(h.customerIds) : idList(h.customers);
  const inactive = new Set(idList(h.inactiveCustomerIds));
  return ids.map((id) => ({ id, active: !inactive.has(id) }));
}
export function jobsFrom(ctx: LabContext): JobRef[] {
  const h = handoffOf(ctx, "work");
  const raw = Array.isArray(h.jobs) ? h.jobs : Array.isArray(h.jobIds) ? h.jobIds : [];
  return (raw as unknown[]).flatMap((j): JobRef[] => {
    if (Array.isArray(j) && typeof j[0] === "string") {
      return [
        {
          id: j[0],
          customerId: str(j[1]),
          category: str(j[2]) ?? "active",
          origin: str(j[7]) ?? "direct",
        },
      ];
    }
    if (typeof j === "string")
      return [{ id: j, customerId: null, category: "active", origin: "direct" }];
    if (j && typeof j === "object" && typeof (j as Row).id === "string") {
      const o = j as Row;
      return [
        {
          id: o.id as string,
          customerId: str(o.customerId) ?? str(o.customer_id),
          category: str(o.category) ?? str(o.statusCategory) ?? "active",
          origin: str(o.origin) ?? "direct",
        },
      ];
    }
    return [];
  });
}
export function itemIdsFrom(ctx: LabContext): string[] {
  const h = handoffOf(ctx, "masters");
  return idList(h.itemIds).length ? idList(h.itemIds) : idList(h.items);
}
/**
 * Whether documents carry VAT, and at what rate. The product charges VAT unless
 * `finance.vat_registered` is false (orgIsVatRegistered in the invoices
 * service); the setup family records the profile it installed for the UAE
 * companies and nothing for the Saudi one, whose custom SA-STD code is 15 %.
 */
function vatSetup(ctx: LabContext): { registered: boolean; rate: number } {
  const h = handoffOf(ctx, "setup");
  const profile = h.vatProfile as { registered?: boolean } | null | undefined;
  const registered = profile ? profile.registered !== false : h.vatRegistered !== false;
  return { registered, rate: ctx.company.country === "SA" ? 15 : 5 };
}

// ── Text pools ──────────────────────────────────────────────────────────────

const LINE_EN = [
  "Supply and installation of suspended ceiling panels",
  "Site supervision — senior engineer, per day",
  "Preventive maintenance visit — HVAC and pumps",
  "Electrical works — distribution board and wiring",
  "Consultancy — process review workshop",
  "Delivery, handling and crane hire",
  "Steel fabrication — brackets and supports",
  "Painting works — two coats, emulsion",
  "Plumbing — sanitary fittings and connections",
  "Software configuration and user training",
  "Spare parts — filter set and gaskets",
  "Cleaning services — monthly contract",
  "Landscaping — irrigation network extension",
  "Aluminium and glazing works — ground floor",
  "Project management fee",
  "Testing and commissioning",
];
const LINE_AR = [
  "توريد وتركيب ألواح الأسقف المستعارة",
  "الإشراف على الموقع — مهندس أول، لليوم",
  "زيارة صيانة وقائية — التكييف والمضخات",
  "أعمال كهربائية — لوحة التوزيع والتمديدات",
  "استشارات — ورشة مراجعة العمليات",
  "التوصيل والمناولة واستئجار الرافعة",
  "تصنيع حديدي — حوامل ودعامات",
  "أعمال الدهان — طبقتان، مستحلب",
  "السباكة — الأدوات الصحية والتوصيلات",
  "إعداد البرمجيات وتدريب المستخدمين",
  "قطع غيار — مجموعة فلاتر وحشوات",
  "خدمات النظافة — عقد شهري",
  "تنسيق الحدائق — تمديد شبكة الري",
  "أعمال الألمنيوم والزجاج — الطابق الأرضي",
  "أتعاب إدارة المشروع",
  "الاختبار والتشغيل",
];
const UNITS = ["pcs", "m", "m2", "hr", "day", "set", "lot", "kg", "ltr", "box"];
const SECTIONS = ["materials", "labour", "equipment", "services", null];
const TERMS_EN = [
  "Net 30 days from invoice date.",
  "50% advance, balance on delivery.",
  "Payment within 14 days; prices valid for 30 days.",
  "Net 45 days; retention 5% released on handover.",
];
const TERMS_AR = [
  "الدفع خلال 30 يوماً من تاريخ الفاتورة.",
  "50% مقدماً والباقي عند التسليم.",
  "الدفع خلال 14 يوماً؛ الأسعار سارية لمدة 30 يوماً.",
  "الدفع خلال 45 يوماً؛ يُحرر ضمان 5% عند التسليم.",
];
const REJECT_EN = [
  "Customer chose a competitor on price.",
  "Project postponed to next financial year.",
  "Scope changed; a revised quotation was requested.",
  "Budget not approved by the customer's board.",
];
const REJECT_AR = [
  "اختار العميل منافساً بسبب السعر.",
  "تأجّل المشروع إلى السنة المالية القادمة.",
  "تغيّر النطاق؛ طُلب عرض سعر منقّح.",
  "لم يُعتمد الميزانية من مجلس إدارة العميل.",
];
const CANCEL_EN = ["Duplicate draft raised in error.", "Order withdrawn before issue."];
const CANCEL_AR = ["مسودة مكررة أُنشئت بالخطأ.", "سُحب الطلب قبل الإصدار."];
const CREDIT_EN = [
  "Goods returned — damaged in transit.",
  "Pricing error on the original invoice.",
  "Service not delivered in full; agreed reduction.",
];
const CREDIT_AR = [
  "بضائع مرتجعة — تضررت أثناء النقل.",
  "خطأ في التسعير على الفاتورة الأصلية.",
  "لم تُقدَّم الخدمة كاملة؛ خصم متفق عليه.",
];
const VOID_EN = ["Recorded twice by mistake.", "Cheque returned unpaid."];
const VOID_AR = ["سُجّل مرتين بالخطأ.", "أُعيد الشيك دون صرف."];

// ── Build ───────────────────────────────────────────────────────────────────

type Lang = "en" | "ar";
type Line = {
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  vatRate: number;
  itemId: string | null;
  sectionKey: string | null;
  lineTotalMinor: number;
};

/** Bulk quotes never sit in `pending_approval` / `converting` (approval-owned states). */
export type QuoteStatus =
  "draft" | "approved" | "sent" | "accepted" | "rejected" | "expired" | "converted";
export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "cancelled";
/** Bulk payments are born `recorded` or voided; `confirmed` / `rejected` are approval decisions. */
export type BulkPaymentStatus = "recorded" | "void";

export type QuoteDoc = {
  n: number;
  id: string;
  reference: string;
  customerIdx: number;
  status: QuoteStatus;
  createdAgo: number;
  validUntilAgo: number;
  issuedAgo: number | null;
  acceptedAgo: number | null;
  revisionOfId: string | null;
  convertedJobId: string | null;
  rejectedReason: string | null;
  lines: Line[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
};

export type InvoiceDoc = {
  n: number;
  id: string;
  reference: string;
  kind: "invoice" | "credit_note";
  correctsInvoiceId: string | null;
  customerIdx: number;
  jobId: string | null;
  quoteId: string | null;
  status: InvoiceStatus;
  isExport: boolean;
  createdAgo: number;
  issuedAgo: number | null;
  /** days-ago of the due date; negative means the due date is still ahead. */
  dueAgo: number | null;
  cancelledAgo: number | null;
  cancelReason: string | null;
  notes: string | null;
  lines: Line[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  /** Live money against this invoice (recorded payments + credit notes). */
  paidMinor: number;
  creditedMinor: number;
};

export type PaymentDoc = {
  n: number;
  id: string;
  reference: string;
  invoice: InvoiceDoc | null;
  customerIdx: number;
  status: BulkPaymentStatus;
  method: "cash" | "bank_transfer" | "cheque" | "card" | "other";
  payAgo: number;
  amountMinor: number;
  externalReference: string | null;
  voidAgo: number | null;
  voidReason: string | null;
  receiptId: string;
  receiptRef: string;
};

export type ServiceSample = {
  k: number;
  customerId: string | null;
  jobId: string | null;
  lines: Array<{
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    vatRate: number;
  }>;
  /** What computeInvoiceTotals will produce for these lines (VAT drives journal/tax rows). */
  vatMinor: number;
  totalMinor: number;
  /** null → left open; 1 → paid in full; otherwise a partial payment. */
  payFraction: number | null;
  method: PaymentDoc["method"];
  creditNote: boolean;
  voidPayment: boolean;
};

export type SalesBuild = {
  customers: CustomerRef[];
  customerNames: string[];
  customerTax: Array<string | null>;
  jobs: JobRef[];
  quotes: QuoteDoc[];
  invoices: InvoiceDoc[];
  payments: PaymentDoc[];
  rows: Record<string, Row[]>;
  /** next_value per reference_sequence scope after the bulk. */
  sequences: Record<string, number>;
  /** Outstanding AR per customer id from the bulk rows (issued/partially_paid, floored at 0). */
  arByCustomer: Record<string, number>;
  arTotalMinor: number;
  convertedWithoutJob: number;
  samples: ServiceSample[];
  /** Rows the service sample writes, per table (counted by plan; verified by id). */
  serviceRows: Record<string, number>;
  notes: string[];
};

/** The service-driven sample per company: what the real services will write. */
export const SERVICE_SAMPLE = {
  invoices: 20,
  linesPerInvoice: 2,
  fullPayments: 12, // k 0..11
  partialPayments: 4, // k 12..15
  creditNotes: 3, // k 16..18 (fully credited → settled without cash)
  voidedPayments: 2, // k 10, 11 (their full payment is voided → back to issued)
} as const;

/**
 * Members the pending payment approval notifies: the requester is the finance
 * persona (archetype accounts, the rule's assigned role); with no other
 * accounts member the engine escalates to admin, whose one member — the admin
 * persona — receives the redacted notification. verify() recomputes this from
 * the live memberships.
 */
const APPROVAL_NOTIFIED_MEMBERS = 1;

function sampleApplies(company: Company): boolean {
  return company.profile.invoices >= SERVICE_SAMPLE.invoices * 3;
}

/** Document rows the sample mints — known before the build, so the bulk can leave room. */
export function serviceDocCounts(company: Company): Record<string, number> {
  if (!sampleApplies(company)) return {};
  const s = SERVICE_SAMPLE;
  const payments = s.fullPayments + s.partialPayments;
  return {
    invoice: s.invoices + s.creditNotes,
    invoice_line: (s.invoices + s.creditNotes) * s.linesPerInvoice,
    payment: payments,
    payment_receipt: payments,
  };
}

/**
 * Every row the services write for the sample, side effects included:
 *   createInvoice / issueInvoice / recordPayment / createCreditNote / voidPayment
 *   → one audit_log row per command;
 *   issue / record / credit note → one domain_event each, plus one
 *   approval/submitted per payment (the work family installs a `payment` rule
 *   at amount ≥ 0 with no auto-approve, so every payment opens a pending
 *   approval and notifies the admin);
 *   issue / credit note / record → one posted journal_entry each (finance is
 *   installed by setup; documents are dated today, after the books start),
 *   with DR/CR lines plus a VAT line when the document carries VAT; a void
 *   reverses the receipt entry (a mirror with the same two lines);
 *   UAE companies also capture one tax_entry per VAT-bearing document;
 *   and this family's own progress marker is one app_settings row.
 */
export function serviceRowsFor(company: Company, samples: ServiceSample[]): Record<string, number> {
  if (!sampleApplies(company) || !samples.length) return {};
  const s = SERVICE_SAMPLE;
  const payments = s.fullPayments + s.partialPayments;
  const docs = samples.length + samples.filter((x) => x.creditNote).length;
  const vatDocs =
    samples.filter((x) => x.vatMinor > 0).length +
    samples.filter((x) => x.creditNote && x.vatMinor > 0).length;
  const journalEntries = docs + payments + s.voidedPayments;
  const journalLines = docs * 2 + vatDocs + payments * 2 + s.voidedPayments * 2;
  const outboxEvents = s.invoices + payments + s.creditNotes; // issued / recorded / credit note
  return {
    ...serviceDocCounts(company),
    approval: payments,
    notification: payments * APPROVAL_NOTIFIED_MEMBERS,
    audit_log: s.invoices * 2 + payments + s.creditNotes + s.voidedPayments,
    domain_event: outboxEvents + payments, // + one approval/submitted per payment
    journal_entry: journalEntries,
    journal_line: journalLines,
    tax_entry: company.country === "AE" ? vatDocs : 0,
    app_settings: 1,
  };
}

const builds = new WeakMap<LabContext, SalesBuild>();

/** The pure plan — memoised per context so plan() and seed() see one build. */
export function buildSales(ctx: LabContext): SalesBuild {
  const cached = builds.get(ctx);
  if (cached) return cached;
  const b = doBuild(ctx);
  builds.set(ctx, b);
  return b;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function doBuild(ctx: LabContext): SalesBuild {
  const { rng, clock, company } = ctx;
  const profile = company.profile;
  const vat = vatSetup(ctx);
  const arabicFirst = company.languages[0] === "ar";
  const lang = (): Lang => (rng.chance(arabicFirst ? 0.7 : 0.3) ? "ar" : "en");
  const uid = (key: string, ...ordinal: Array<string | number>) => ctx.id(FAMILY, key, ...ordinal);
  const hash = (key: string, n: number) =>
    createHash("sha256")
      .update(`h33:${SEED_VERSION}:${company.key}:${FAMILY}:${key}:${n}`)
      .digest("hex");
  const notes: string[] = [];

  // ── masters and work ────────────────────────────────────────────────────
  const customers = customersFrom(ctx);
  const jobs = jobsFrom(ctx);
  const itemIds = itemIdsFrom(ctx);
  if (!customers.length) notes.push("no customers in the masters handoff — documents are walk-in");
  if (!jobs.length) notes.push("no jobs in the work handoff — nothing converts or links to work");
  // Snapshot names: generated here, replaced by the masters' real names at seed time.
  const customerNames = customers.map((_, i) => companyName(rng, i).display);
  const customerTax = customers.map((_, i) => (i % 3 === 0 ? null : taxNo(company, 5000 + i)));
  const customerIndexById = new Map(customers.map((c, i) => [c.id, i]));
  /** A few large accounts get most of the paper; recent documents avoid inactive customers. */
  const pickCustomer = (recent = false): number => {
    if (customers.length === 0) return -1;
    let idx = Math.floor(customers.length * rng.next() ** 2);
    for (let t = 0; recent && t < 3 && !customers[idx]!.active; t++)
      idx = Math.floor(customers.length * rng.next() ** 2);
    return idx;
  };
  const customerOfJob = (job: JobRef | null, fallback: number): number => {
    if (!job?.customerId) return fallback;
    return customerIndexById.get(job.customerId) ?? fallback;
  };
  const walkInName = (n: number) => companyName(rng, 9000 + n).display;

  const shuffle = <T>(arr: T[]): T[] => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
    return a;
  };
  // Converted quotes consume distinct jobs: the ones the work family raised
  // from a quotation first, then any other live job.
  const liveJobs = jobs.filter((j) => j.category !== "cancelled");
  const jobPool = [
    ...shuffle(jobs.filter((j) => j.origin === "quotation")),
    ...shuffle(liveJobs.filter((j) => j.origin !== "quotation")),
  ];
  let jobCursor = 0;
  const nextJob = (): JobRef | null => (jobCursor < jobPool.length ? jobPool[jobCursor++]! : null);
  const anyJob = (): JobRef | null => (liveJobs.length ? pick(rng, liveJobs) : null);

  const mkLines = (count: number, vatApplies: boolean, withItems: boolean): Line[] => {
    const lines: Line[] = [];
    for (let i = 0; i < count; i++) {
      const l = lang();
      const base = pick(rng, l === "ar" ? LINE_AR : LINE_EN);
      const qtyRaw = rng.chance(0.2) ? rng.int(1, 40) + 0.5 : rng.int(1, 40);
      const unitPriceMinor = priceMinor(rng, 25, 25000);
      const zeroRated = rng.chance(0.08);
      const vatRate = vatApplies && !zeroRated ? vat.rate : 0;
      lines.push({
        description: longTitle(rng, l, base).slice(0, 300),
        qty: qtyRaw,
        unit: pick(rng, UNITS),
        unitPriceMinor,
        vatRate,
        itemId: withItems && itemIds.length && rng.chance(0.4) ? pick(rng, itemIds) : null,
        sectionKey: pick(rng, SECTIONS),
        lineTotalMinor: 0,
      });
    }
    const t = computeTotals(lines, 1, true);
    lines.forEach((l, i) => (l.lineTotalMinor = t.lines[i]!.lineTotalMinor));
    return lines;
  };
  const totalsOf = (lines: Line[]) => {
    const t = computeTotals(lines, 1, true);
    return { subtotalMinor: t.subtotalMinor, vatMinor: t.vatAmountMinor, totalMinor: t.totalMinor };
  };

  // ── Quotations ──────────────────────────────────────────────────────────
  const Q = profile.quotes;
  const qAgo = spreadDates(rng, company, Q);
  const quotes: QuoteDoc[] = [];
  let convertedWithoutJob = 0;
  for (let n = 0; n < Q; n++) {
    const createdAgo = qAgo[n]!;
    const validity = pick(rng, [14, 30, 45]);
    const validUntilAgo = createdAgo - validity;
    let status: QuoteStatus;
    if (createdAgo <= 30) {
      status = weighted(rng, {
        draft: 30,
        approved: 10,
        sent: 40,
        converted: 8,
        rejected: 5,
        accepted: 4,
        expired: 3,
      });
    } else if (validUntilAgo > 0) {
      status = weighted(rng, { expired: 33, converted: 37, rejected: 22, accepted: 3, sent: 5 });
    } else {
      status = weighted(rng, {
        sent: 40,
        converted: 30,
        rejected: 15,
        accepted: 5,
        approved: 5,
        draft: 5,
      });
    }
    if (status === "expired" && validUntilAgo <= 0) status = "sent";

    let customerIdx = pickCustomer(createdAgo <= 60);
    let revisionOfId: string | null = null;
    if (n > 0 && rng.chance(0.08)) {
      const original = quotes[n - rng.int(1, Math.min(n, 6))]!;
      revisionOfId = original.id;
      customerIdx = original.customerIdx;
    }
    let convertedJobId: string | null = null;
    if (status === "converted") {
      const job = nextJob();
      if (job) {
        convertedJobId = job.id;
        customerIdx = customerOfJob(job, customerIdx);
      } else {
        status = "accepted";
        convertedWithoutJob++;
      }
    }
    const lineCount = weighted(rng, { 1: 20, 2: 35, 3: 25, 4: 12, 5: 8 });
    const lines = mkLines(Number(lineCount), vat.registered, true);
    const sentLike = status !== "draft" && status !== "approved";
    quotes.push({
      n,
      id: uid("quote", n),
      reference: "",
      customerIdx,
      status,
      createdAgo,
      validUntilAgo,
      issuedAgo: sentLike ? Math.max(0, createdAgo - rng.int(0, 2)) : null,
      acceptedAgo:
        status === "accepted" || status === "converted"
          ? clamp(createdAgo - rng.int(1, 20), 0, createdAgo)
          : null,
      revisionOfId,
      convertedJobId,
      rejectedReason:
        status === "rejected" ? pick(rng, lang() === "ar" ? REJECT_AR : REJECT_EN) : null,
      lines,
      ...totalsOf(lines),
    });
  }
  // Serials follow time: the oldest quotation is QT-001.
  quotes
    .slice()
    .sort((a, b2) => b2.createdAgo - a.createdAgo || a.n - b2.n)
    .forEach((q, i) => (q.reference = serial("QT", i + 1)));
  const quoteByJob = new Map(
    quotes.filter((q) => q.convertedJobId).map((q) => [q.convertedJobId!, q]),
  );

  // ── Invoices ────────────────────────────────────────────────────────────
  const svcDocs = serviceDocCounts(company);
  const creditTarget = Math.round(profile.invoices * 0.03);
  const I = Math.max(0, profile.invoices - (svcDocs.invoice ?? 0) - creditTarget);
  const iAgo = spreadDates(rng, company, I);
  const invoices: InvoiceDoc[] = [];
  const payments: PaymentDoc[] = [];

  const addPayment = (
    inv: InvoiceDoc | null,
    customerIdx: number,
    status: BulkPaymentStatus,
    payAgo: number,
    amountMinor: number,
  ): PaymentDoc => {
    const n = payments.length;
    const method = weighted(rng, {
      bank_transfer: 55,
      cheque: 20,
      cash: 12,
      card: 10,
      other: 3,
    }) as PaymentDoc["method"];
    const ext =
      method === "bank_transfer"
        ? `TRF-TEST-${String(n + 1).padStart(6, "0")}`
        : method === "cheque"
          ? `CHQ-000${String(rng.int(100, 999))}`
          : null;
    const voidAgo = status === "void" ? Math.max(0, payAgo - rng.int(1, 5)) : null;
    const p: PaymentDoc = {
      n,
      id: uid("payment", n),
      reference: "",
      invoice: inv,
      customerIdx,
      status,
      method,
      payAgo,
      amountMinor,
      externalReference: ext,
      voidAgo,
      voidReason: status === "void" ? pick(rng, lang() === "ar" ? VOID_AR : VOID_EN) : null,
      receiptId: uid("receipt", n),
      receiptRef: "",
    };
    payments.push(p);
    if (inv && status === "recorded") inv.paidMinor += amountMinor;
    return p;
  };

  for (let n = 0; n < I; n++) {
    const daysAgo = iAgo[n]!;
    let status: InvoiceStatus = "issued";
    if (daysAgo <= 60 && rng.chance(0.25)) status = "draft";
    else if (rng.chance(0.02)) status = "cancelled";

    const job = rng.chance(0.35) ? anyJob() : null;
    let customerIdx = customerOfJob(job, pickCustomer(daysAgo <= 60));
    if (rng.chance(0.03)) customerIdx = -1; // walk-in, snapshot name only
    const quote = job ? quoteByJob.get(job.id) : undefined;
    const quoteId = quote && rng.chance(0.6) ? quote.id : null;
    const isExport = rng.chance(0.04);
    const vatApplies = vat.registered && !isExport;
    const lineCount = weighted(rng, { 1: 35, 2: 35, 3: 20, 4: 10 });
    const lines = mkLines(Number(lineCount), vatApplies, false);
    const totals = totalsOf(lines);
    const l = lang();

    const doc: InvoiceDoc = {
      n,
      id: uid("invoice", n),
      reference: "",
      kind: "invoice",
      correctsInvoiceId: null,
      customerIdx,
      jobId: job?.id ?? null,
      quoteId,
      status,
      isExport,
      createdAgo: daysAgo + (status === "draft" ? 0 : rng.int(0, 3)),
      issuedAgo: null,
      dueAgo: null,
      cancelledAgo: null,
      cancelReason: null,
      notes: rng.chance(0.15) ? sentence(rng, l) : null,
      lines,
      ...totals,
      paidMinor: 0,
      creditedMinor: 0,
    };
    if (status === "cancelled") {
      // A draft cancelled before issue: no issued_at, a reason (voidInvoice's shape).
      doc.cancelledAgo = Math.max(0, daysAgo - rng.int(0, 2));
      doc.cancelReason = pick(rng, l === "ar" ? CANCEL_AR : CANCEL_EN);
    } else if (status === "issued") {
      const net = Number(weighted(rng, { 0: 10, 14: 20, 30: 50, 45: 10, 60: 10 }));
      doc.issuedAgo = daysAgo;
      doc.dueAgo = daysAgo - net;
      // Older invoices are more likely settled; recent ones mostly open.
      const pPaid = Math.min(0.95, 0.15 + (daysAgo / 180) * 0.8);
      const r = rng.next();
      const settle = r < pPaid ? "paid" : r < pPaid + (1 - pPaid) * 0.25 ? "partial" : "open";
      const aroundDue = () => clamp(doc.dueAgo! + rng.int(-10, 25), 0, daysAgo);
      if (settle === "paid") {
        if (rng.chance(0.25) && totals.totalMinor >= 200) {
          const first = Math.round(totals.totalMinor * (0.3 + rng.next() * 0.4));
          addPayment(
            doc,
            customerIdx,
            "recorded",
            clamp(daysAgo - rng.int(1, 10), 0, daysAgo),
            first,
          );
          addPayment(doc, customerIdx, "recorded", aroundDue(), totals.totalMinor - first);
        } else {
          addPayment(doc, customerIdx, "recorded", aroundDue(), totals.totalMinor);
        }
      } else if (settle === "partial" && totals.totalMinor >= 200) {
        addPayment(
          doc,
          customerIdx,
          "recorded",
          aroundDue(),
          Math.round(totals.totalMinor * (0.2 + rng.next() * 0.5)),
        );
      }
      // A voided payment that never counted (recorded twice, cheque bounced).
      if (rng.chance(0.03)) {
        addPayment(doc, customerIdx, "void", aroundDue(), Math.round(totals.totalMinor * 0.5));
      }
    }
    invoices.push(doc);
  }

  // ── Credit notes: correct OPEN invoices (never over-credit a paid one) ───
  const openOlder = invoices.filter(
    (i) =>
      i.status === "issued" && i.paidMinor === 0 && (i.issuedAgo ?? 0) > 30 && i.totalMinor >= 200,
  );
  const creditCount = Math.min(creditTarget, openOlder.length);
  if (creditCount < creditTarget)
    notes.push(`only ${creditCount}/${creditTarget} credit notes had an open invoice to correct`);
  let cnOrdinal = 0;
  for (let c = 0; c < creditCount; c++) {
    // Spread targets over the open set deterministically.
    const target = openOlder[Math.floor((c * openOlder.length) / creditCount)]!;
    if (target.creditedMinor > 0) continue;
    const full = rng.chance(0.6);
    const l = lang();
    let lines: Line[];
    if (full) {
      lines = target.lines.map((x) => ({ ...x }));
    } else {
      const src = target.lines[0]!;
      const qty = src.qty > 1 ? Math.max(1, Math.floor(src.qty / 2)) : src.qty;
      lines = [
        {
          ...src,
          qty,
          description: `${l === "ar" ? "إشعار دائن: " : "Credit: "}${src.description}`.slice(
            0,
            300,
          ),
        },
      ];
      const t = computeTotals(lines, 1, true);
      lines[0]!.lineTotalMinor = t.lines[0]!.lineTotalMinor;
    }
    const totals = totalsOf(lines);
    if (totals.totalMinor > target.totalMinor) continue;
    const cnAgo = rng.int(0, Math.max(0, (target.issuedAgo ?? 0) - 5));
    invoices.push({
      n: cnOrdinal,
      id: uid("credit_note", cnOrdinal),
      reference: "",
      kind: "credit_note",
      correctsInvoiceId: target.id,
      customerIdx: target.customerIdx,
      jobId: target.jobId,
      quoteId: null,
      status: "issued",
      isExport: target.isExport,
      createdAgo: cnAgo,
      issuedAgo: cnAgo,
      dueAgo: null,
      cancelledAgo: null,
      cancelReason: null,
      notes: pick(rng, l === "ar" ? CREDIT_AR : CREDIT_EN),
      lines,
      ...totals,
      paidMinor: 0,
      creditedMinor: 0,
    });
    cnOrdinal++;
    target.creditedMinor += totals.totalMinor;
  }

  // ── Reconcile statuses exactly as reconcileInvoiceStatus would ──────────
  for (const inv of invoices) {
    if (inv.kind !== "invoice" || inv.status === "draft" || inv.status === "cancelled") continue;
    inv.status =
      inv.paidMinor + inv.creditedMinor >= inv.totalMinor
        ? "paid"
        : inv.paidMinor > 0
          ? "partially_paid"
          : "issued";
  }

  // ── Unallocated advances (customer set, no invoice) ────────────────────
  const advances = customers.length ? Math.max(2, Math.round(customers.length * 0.02)) : 0;
  for (let a = 0; a < advances; a++) {
    addPayment(null, pickCustomer(true), "recorded", rng.int(0, 90), priceMinor(rng, 500, 20000));
  }

  // Serials by time.
  invoices
    .filter((i) => i.kind === "invoice")
    .sort((a, b2) => b2.createdAgo - a.createdAgo || a.n - b2.n)
    .forEach((i, k) => (i.reference = serial("INV", k + 1)));
  invoices
    .filter((i) => i.kind === "credit_note")
    .sort((a, b2) => b2.createdAgo - a.createdAgo || a.n - b2.n)
    .forEach((i, k) => (i.reference = serial("CN", k + 1)));
  payments
    .slice()
    .sort((a, b2) => b2.payAgo - a.payAgo || a.n - b2.n)
    .forEach((p, k) => {
      p.reference = serial("PMT", k + 1);
      p.receiptRef = serial("RCP", k + 1);
    });

  // ── Rows ────────────────────────────────────────────────────────────────
  const org = ctx.orgId;
  const users = ctx.users;
  const currency = company.currency;
  const ts = (ago: number, hour = 9) => clock.tsAgo(ago, hour, 0);
  const rows: Record<string, Row[]> = {};
  for (const t of SALES_TABLES) rows[t] = [];
  const push = (table: string, row: Row) => rows[table]!.push(row);
  const custId = (idx: number) => (idx >= 0 ? customers[idx]!.id : null);
  const custName = (idx: number, n: number) => (idx >= 0 ? customerNames[idx]! : walkInName(n));

  for (const q of quotes) {
    const created = ts(q.createdAgo, 8 + (q.n % 8));
    const lastAgo = Math.min(
      q.createdAgo,
      q.acceptedAgo ?? q.createdAgo,
      q.issuedAgo ?? q.createdAgo,
    );
    push("quote", {
      id: q.id,
      org_id: org,
      reference: q.reference,
      customer_id: custId(q.customerIdx),
      customer_name: custName(q.customerIdx, q.n),
      status: q.status,
      revision_of_id: q.revisionOfId,
      currency,
      exchange_rate: 1,
      subtotal_minor: q.subtotalMinor,
      vat_amount_minor: q.vatMinor,
      total_minor: q.totalMinor,
      base_total_minor: q.totalMinor,
      terms: pick(rng, arabicFirst ? TERMS_AR : TERMS_EN),
      valid_until: clock.dayAgo(q.validUntilAgo),
      accepted_at: q.acceptedAgo === null ? null : ts(q.acceptedAgo, 11),
      accepted_note: q.acceptedAgo === null ? null : rng.chance(0.5) ? sentence(rng, lang()) : null,
      rejected_reason: q.rejectedReason,
      converted_job_id: q.convertedJobId,
      notes: rng.chance(0.2) ? sentence(rng, lang()) : null,
      issued_at: q.issuedAgo === null ? null : ts(q.issuedAgo, 10),
      created_by: users.manager,
      created_at: created,
      updated_at: ts(lastAgo, 12),
    });
    q.lines.forEach((l, i) =>
      push("quote_line", {
        id: uid("quote_line", q.n, i),
        org_id: org,
        quote_id: q.id,
        section_key: l.sectionKey,
        item_id: l.itemId,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unit_price_minor: l.unitPriceMinor,
        vat_rate: l.vatRate,
        line_total_minor: l.lineTotalMinor,
        sort: i,
        created_at: created,
      }),
    );
  }

  for (const inv of invoices) {
    const created = ts(inv.createdAgo, 8 + (inv.n % 8));
    const lastPay = payments
      .filter((p) => p.invoice === inv)
      .reduce((m, p) => Math.min(m, p.payAgo), inv.createdAgo);
    push("invoice", {
      id: inv.id,
      org_id: org,
      reference: inv.reference,
      kind: inv.kind,
      corrects_invoice_id: inv.correctsInvoiceId,
      customer_id: custId(inv.customerIdx),
      customer_name: custName(inv.customerIdx, inv.n),
      customer_tax_reg_no: inv.customerIdx >= 0 ? customerTax[inv.customerIdx]! : null,
      job_id: inv.jobId,
      quote_id: inv.quoteId,
      status: inv.status,
      is_export: inv.isExport,
      currency,
      exchange_rate: 1,
      subtotal_minor: inv.subtotalMinor,
      vat_amount_minor: inv.vatMinor,
      total_minor: inv.totalMinor,
      base_total_minor: inv.totalMinor,
      issued_at: inv.issuedAgo === null ? null : ts(inv.issuedAgo, 10),
      due_date: inv.dueAgo === null ? null : clock.dayAgo(inv.dueAgo),
      cancelled_at: inv.cancelledAgo === null ? null : ts(inv.cancelledAgo, 14),
      cancel_reason: inv.cancelReason,
      notes: inv.notes,
      created_by: users.finance,
      created_at: created,
      updated_at: ts(Math.min(lastPay, inv.issuedAgo ?? inv.createdAgo), 15),
    });
    inv.lines.forEach((l, i) =>
      push("invoice_line", {
        id: uid(inv.kind === "invoice" ? "invoice_line" : "credit_note_line", inv.n, i),
        org_id: org,
        invoice_id: inv.id,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unit_price_minor: l.unitPriceMinor,
        vat_rate: l.vatRate,
        line_total_minor: l.lineTotalMinor,
        sort: i,
        created_at: created,
      }),
    );
  }

  for (const p of payments) {
    const created = ts(p.payAgo, 9 + (p.n % 7));
    push("payment", {
      id: p.id,
      org_id: org,
      reference: p.reference,
      invoice_id: p.invoice?.id ?? null,
      job_id: p.invoice?.jobId ?? null,
      customer_id: custId(p.customerIdx),
      customer_name:
        p.customerIdx >= 0
          ? customerNames[p.customerIdx]!
          : p.invoice
            ? custName(-1, p.invoice.n)
            : null,
      status: p.status,
      method: p.method,
      payment_date: clock.dayAgo(p.payAgo),
      amount_minor: p.amountMinor,
      currency,
      exchange_rate: 1,
      base_amount_minor: p.amountMinor,
      external_reference: p.externalReference,
      voided_at: p.voidAgo === null ? null : ts(p.voidAgo, 16),
      void_reason: p.voidReason,
      voided_by: p.voidAgo === null ? null : users.finance,
      created_by: users.finance,
      created_at: created,
      updated_at: p.voidAgo === null ? created : ts(p.voidAgo, 16),
    });
    push("payment_receipt", {
      id: p.receiptId,
      org_id: org,
      payment_id: p.id,
      reference: p.receiptRef,
      issued_at: created,
      created_at: created,
    });
  }

  // ── Dunning attempts for the longest-overdue invoices ───────────────────
  const overdue = invoices
    .filter(
      (i) =>
        i.kind === "invoice" &&
        (i.status === "issued" || i.status === "partially_paid") &&
        (i.dueAgo ?? 0) > 14,
    )
    .sort((a, b2) => (b2.dueAgo ?? 0) - (a.dueAgo ?? 0));
  let dunningN = 0;
  for (const inv of overdue.slice(0, 15)) {
    const attempts = rng.int(1, 3);
    for (let a = 1; a <= attempts; a++) {
      push("dunning_attempt", {
        id: uid("dunning", dunningN++),
        org_id: org,
        cycle_key: `inv:${inv.reference}`.slice(0, 40),
        attempt_no: a,
        created_at: ts(Math.max(0, (inv.dueAgo ?? 0) - a * 7), 9),
      });
    }
  }

  // ── Customer progress updates + share tokens ────────────────────────────
  const updates = Math.min(60, Math.max(12, Math.round(profile.jobs / 50)));
  const uAgo = spreadDates(rng, company, updates);
  let tokenN = 0;
  for (let n = 0; n < updates; n++) {
    const ago = uAgo[n]!;
    const job = anyJob();
    const customerIdx = customerOfJob(job, pickCustomer(ago <= 60));
    const l = lang();
    const sent = ago > 3 ? rng.chance(0.75) : rng.chance(0.3);
    const base = l === "ar" ? `تحديث المشروع رقم ${n + 1}` : `Project update no. ${n + 1}`;
    const title = longTitle(rng, l, base).slice(0, 200);
    const id = uid("customer_update", n);
    const progress = rng.int(10, 95);
    push("customer_update", {
      id,
      org_id: org,
      job_id: job?.id ?? null,
      job_name: null, // the job's real name is read at seed time (enrichFromDb)
      customer_id: custId(customerIdx),
      customer_name: customerIdx >= 0 ? customerNames[customerIdx]! : null,
      title,
      language: l,
      body: paragraph(rng, l, 3),
      content: sent
        ? {
            progressPct: progress,
            stagesCompleted: [{ key: "mobilisation", en: "Mobilisation", ar: "التجهيز" }],
            nextMilestones: [{ en: "Site works", ar: "أعمال الموقع" }],
            photoFileIds: [],
          }
        : null,
      status: sent ? "sent" : "draft",
      ai_drafted: false,
      sent_at: sent ? ts(ago, 13) : null,
      created_by: users.manager,
      created_at: ts(ago, 12),
      updated_at: ts(ago, sent ? 13 : 12),
    });
    if (sent) {
      const revoked = rng.chance(0.1);
      push("share_token", {
        id: uid("share_token", tokenN),
        org_id: org,
        customer_update_id: id,
        token_hash: hash("share_token", tokenN),
        expires_at: ts(ago - 90, 13),
        revoked_at: revoked ? ts(Math.max(0, ago - rng.int(1, 20)), 10) : null,
        revoked_by: revoked ? users.manager : null,
        created_by: users.manager,
        created_at: ts(ago, 13),
      });
      tokenN++;
    }
  }

  // ── Document shares on a few issued invoices and sent quotations ────────
  const shareable: Array<{ type: "invoice" | "quote"; id: string; ago: number; by: string }> = [];
  invoices
    .filter((i) => i.kind === "invoice" && i.issuedAgo !== null && i.status !== "cancelled")
    .forEach((i, k) => {
      if (k % 50 === 0)
        shareable.push({ type: "invoice", id: i.id, ago: i.issuedAgo!, by: users.finance });
    });
  quotes
    .filter((q) => q.issuedAgo !== null)
    .forEach((q, k) => {
      if (k % 50 === 0)
        shareable.push({ type: "quote", id: q.id, ago: q.issuedAgo!, by: users.manager });
    });
  shareable.forEach((s, n) => {
    const days = pick(rng, [7, 30, 90]);
    const createdAgo = Math.max(0, s.ago - rng.int(0, 2));
    const revoked = rng.chance(0.1);
    const views = rng.chance(0.6) ? rng.int(1, 12) : 0;
    push("document_share", {
      id: uid("document_share", n),
      org_id: org,
      subject_type: s.type,
      subject_id: s.id,
      token_hash: hash("document_share", n),
      expires_at: ts(createdAgo - days, 12),
      revoked_at: revoked ? ts(Math.max(0, createdAgo - 1), 12) : null,
      revoked_by: revoked ? s.by : null,
      created_by: s.by,
      created_at: ts(createdAgo, 11),
      last_viewed_at: views
        ? ts(Math.max(0, createdAgo - rng.int(0, Math.min(days, createdAgo))), 18)
        : null,
      view_count: views,
    });
  });

  // ── Sequences continue after the bulk ───────────────────────────────────
  const sequences: Record<string, number> = {
    quote: quotes.length + 1,
    invoice: invoices.filter((i) => i.kind === "invoice").length + 1,
    credit_note: invoices.filter((i) => i.kind === "credit_note").length + 1,
    payment: payments.length + 1,
    payment_receipt: payments.length + 1,
  };
  for (const [scope_key, next_value] of Object.entries(sequences))
    push("reference_sequence", { org_id: org, scope_key, next_value });

  // ── AR from the bulk (the formula behind computeAR) ─────────────────────
  const arByCustomer: Record<string, number> = {};
  let arTotalMinor = 0;
  for (const inv of invoices) {
    if (inv.kind !== "invoice" || (inv.status !== "issued" && inv.status !== "partially_paid"))
      continue;
    const bal = Math.max(0, inv.totalMinor - inv.paidMinor - inv.creditedMinor);
    if (bal === 0) continue;
    arTotalMinor += bal;
    const cid = custId(inv.customerIdx);
    if (cid) arByCustomer[cid] = (arByCustomer[cid] ?? 0) + bal;
  }

  // ── The service sample (pure spec; executed by seed when live) ──────────
  const samples: ServiceSample[] = [];
  if (sampleApplies(company)) {
    const s = SERVICE_SAMPLE;
    for (let k = 0; k < s.invoices; k++) {
      const job = rng.chance(0.5) ? anyJob() : null;
      const cIdx = customerOfJob(job, pickCustomer(true));
      const built = mkLines(s.linesPerInvoice, vat.registered, false);
      const totals = totalsOf(built);
      samples.push({
        k,
        customerId: custId(cIdx),
        jobId: job?.id ?? null,
        lines: built.map((l) => ({
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitPriceMinor: l.unitPriceMinor,
          vatRate: l.vatRate,
        })),
        vatMinor: totals.vatMinor,
        totalMinor: totals.totalMinor,
        payFraction:
          k < s.fullPayments
            ? 1
            : k < s.fullPayments + s.partialPayments
              ? 0.3 + rng.next() * 0.4
              : null,
        method: pick(rng, ["bank_transfer", "cheque", "cash", "card"] as const),
        creditNote:
          k >= s.fullPayments + s.partialPayments &&
          k < s.fullPayments + s.partialPayments + s.creditNotes,
        voidPayment: k >= s.fullPayments - s.voidedPayments && k < s.fullPayments,
      });
    }
  }

  return {
    customers,
    customerNames,
    customerTax,
    jobs,
    quotes,
    invoices,
    payments,
    rows,
    sequences,
    arByCustomer,
    arTotalMinor,
    convertedWithoutJob,
    samples,
    serviceRows: serviceRowsFor(company, samples),
    notes,
  };
}

/** Expected rows per table: bulk rows plus what the service sample will write. */
export function expectedCounts(ctx: LabContext): Record<string, number> {
  const b = buildSales(ctx);
  const out: Record<string, number> = {};
  for (const t of SALES_TABLES) out[t] = b.rows[t]?.length ?? 0;
  for (const [t, n] of Object.entries(b.serviceRows)) out[t] = (out[t] ?? 0) + n;
  return out;
}

// ── Live helpers (seed / verify only; never in dry-run or offline) ──────────

const SEQ_CONFLICT =
  "on conflict (org_id, scope_key) do update set next_value = greatest(reference_sequence.next_value, excluded.next_value)";
const PROGRESS_KEY = "h33.sales.service";

type Progress = {
  invoices: Record<string, string>;
  issued: number[];
  payments: Record<string, string>;
  creditNotes: Record<string, string>;
  voided: number[];
};
const emptyProgress = (): Progress => ({
  invoices: {},
  issued: [],
  payments: {},
  creditNotes: {},
  voided: [],
});

async function readProgress(ctx: LabContext): Promise<Progress> {
  const rows = (await ctx.sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = ${PROGRESS_KEY}
  `) as unknown as Array<{ value: Progress }>;
  return rows[0]?.value ? { ...emptyProgress(), ...rows[0].value } : emptyProgress();
}
async function writeProgress(ctx: LabContext, p: Progress): Promise<void> {
  await ctx.sql`
    insert into public.app_settings (org_id, key, value)
    values (${ctx.orgId}, ${PROGRESS_KEY}, ${ctx.sql.json(p as never)})
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
  `;
}

/** Replace generated snapshots with the masters' real names where they exist. */
async function enrichFromDb(ctx: LabContext, b: SalesBuild): Promise<void> {
  const ids = b.customers.map((c) => c.id);
  if (ids.length) {
    const rows = (await ctx.sql`
      select id::text as id, name, tax_reg_no from public.customer
      where org_id = ${ctx.orgId} and id = any(${ids}::uuid[])
    `) as unknown as Array<{ id: string; name: string; tax_reg_no: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of ["quote", "invoice", "payment", "customer_update"]) {
      for (const r of b.rows[t] ?? []) {
        const c = r.customer_id ? byId.get(r.customer_id as string) : undefined;
        if (!c) continue;
        r.customer_name = c.name;
        if (t === "invoice") r.customer_tax_reg_no = c.tax_reg_no;
      }
    }
  }
  const jobIds = b.jobs.map((j) => j.id);
  if (jobIds.length) {
    const rows = (await ctx.sql`
      select id::text as id, name from public.job where org_id = ${ctx.orgId} and id = any(${jobIds}::uuid[])
    `) as unknown as Array<{ id: string; name: string }>;
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    for (const r of b.rows.customer_update ?? []) {
      const name = r.job_id ? byId.get(r.job_id as string) : undefined;
      if (!name) continue;
      r.job_name = name;
      r.title = `${r.language === "ar" ? "تحديث المشروع: " : "Project update: "}${name}`.slice(
        0,
        200,
      );
    }
  }
}

type ServiceOutcome = {
  invoiceIds: string[];
  creditNoteIds: string[];
  paymentIds: string[];
  voidedPaymentIds: string[];
  failures: string[];
};
const emptyOutcome = (): ServiceOutcome => ({
  invoiceIds: [],
  creditNoteIds: [],
  paymentIds: [],
  voidedPaymentIds: [],
  failures: [],
});

/** Drive the real services for the sample; every step is recorded so a re-run resumes. */
async function driveServices(ctx: LabContext, b: SalesBuild): Promise<ServiceOutcome> {
  const out = emptyOutcome();
  if (!b.samples.length) return out;
  const inv = await import("@/modules/invoices/service");
  const pay = await import("@/modules/payments/service");
  const fin = ctx.ctxFor("finance");
  const arche = ctx.archetypeOf("finance");
  const p = await readProgress(ctx);
  const { clock, company } = ctx;
  const fail = (step: string, k: number, e: unknown) =>
    out.failures.push(`${step} #${k}: ${e instanceof Error ? e.message : String(e)}`);

  for (const s of b.samples) {
    const key = String(s.k);
    try {
      if (!p.invoices[key]) {
        const r = await inv.createInvoice(fin, arche, {
          customerId: s.customerId ?? undefined,
          jobId: s.jobId ?? undefined,
          currency: company.currency,
          dueDate: clock.dayAhead(30),
          lines: s.lines,
        });
        p.invoices[key] = r.id;
        await writeProgress(ctx, p);
      }
    } catch (e) {
      fail("createInvoice", s.k, e);
      continue;
    }
    const invoiceId = p.invoices[key]!;
    out.invoiceIds.push(invoiceId);
    try {
      if (!p.issued.includes(s.k)) {
        await inv.issueInvoice(fin, arche, invoiceId);
        p.issued.push(s.k);
        await writeProgress(ctx, p);
      }
    } catch (e) {
      fail("issueInvoice", s.k, e);
      continue;
    }
    if (s.payFraction !== null && !p.payments[key]) {
      try {
        const [row] = (await ctx.sql`
          select total_minor::text as total from public.invoice where id = ${invoiceId} and org_id = ${ctx.orgId}
        `) as unknown as Array<{ total: string }>;
        const total = Number(row?.total ?? 0);
        const r = await pay.recordPayment(fin, arche, {
          invoiceId,
          jobId: s.jobId ?? undefined,
          customerId: s.customerId ?? undefined,
          method: s.method,
          paymentDate: clock.dayAgo(0),
          amountMinor: s.payFraction === 1 ? total : Math.max(1, Math.round(total * s.payFraction)),
          currency: company.currency,
          idempotencyKey: `h33:${SEED_VERSION}:${company.key}:${FAMILY}:svc-pay:${s.k}`,
        });
        p.payments[key] = r.id;
        await writeProgress(ctx, p);
      } catch (e) {
        fail("recordPayment", s.k, e);
      }
    }
    if (p.payments[key]) out.paymentIds.push(p.payments[key]!);
  }
  for (const s of b.samples.filter((x) => x.creditNote)) {
    const key = String(s.k);
    if (!p.invoices[key] || !p.issued.includes(s.k)) continue;
    try {
      if (!p.creditNotes[key]) {
        const r = await inv.createCreditNote(
          fin,
          arche,
          p.invoices[key]!,
          CREDIT_EN[s.k % CREDIT_EN.length]!,
        );
        p.creditNotes[key] = r.id;
        await writeProgress(ctx, p);
      }
      out.creditNoteIds.push(p.creditNotes[key]!);
    } catch (e) {
      fail("createCreditNote", s.k, e);
    }
  }
  for (const s of b.samples.filter((x) => x.voidPayment)) {
    const key = String(s.k);
    const paymentId = p.payments[key];
    if (!paymentId) continue;
    try {
      if (!p.voided.includes(s.k)) {
        await pay.voidPayment(fin, arche, paymentId, VOID_EN[s.k % VOID_EN.length]!);
        p.voided.push(s.k);
        await writeProgress(ctx, p);
      }
      out.voidedPaymentIds.push(paymentId);
    } catch (e) {
      fail("voidPayment", s.k, e);
    }
  }
  return out;
}

export type SalesHandoff = {
  quoteIds: string[];
  convertedQuoteIds: string[];
  /** Issued invoices (kind = invoice; drafts and cancellations excluded). */
  invoiceIds: string[];
  creditNoteIds: string[];
  /** Live (recorded) payments only; voided ones are listed separately. */
  paymentIds: string[];
  voidedPaymentIds: string[];
  arByCustomerMinor: Record<string, number>;
  arTotalMinor: number;
  sequences: Record<string, number>;
  /** What the real services minted (ids only); empty in dry-run / offline. */
  service: Omit<ServiceOutcome, "failures">;
};

function bulkHandoff(b: SalesBuild): SalesHandoff {
  const invRows = (b.rows.invoice ?? []).filter(
    (r) => r.status !== "draft" && r.status !== "cancelled",
  );
  const payRows = b.rows.payment ?? [];
  return {
    quoteIds: b.quotes.map((q) => q.id),
    convertedQuoteIds: b.quotes.filter((q) => q.status === "converted").map((q) => q.id),
    invoiceIds: invRows.filter((r) => r.kind === "invoice").map((r) => r.id as string),
    creditNoteIds: invRows.filter((r) => r.kind === "credit_note").map((r) => r.id as string),
    paymentIds: payRows.filter((r) => r.status === "recorded").map((r) => r.id as string),
    voidedPaymentIds: payRows.filter((r) => r.status === "void").map((r) => r.id as string),
    arByCustomerMinor: b.arByCustomer,
    arTotalMinor: b.arTotalMinor,
    sequences: b.sequences,
    service: { invoiceIds: [], creditNoteIds: [], paymentIds: [], voidedPaymentIds: [] },
  };
}

/** Fold the service sample's real rows into the handoff and let the database state AR. */
async function liveHandoff(ctx: LabContext, h: SalesHandoff, svc: ServiceOutcome): Promise<void> {
  h.service = {
    invoiceIds: svc.invoiceIds,
    creditNoteIds: svc.creditNoteIds,
    paymentIds: svc.paymentIds,
    voidedPaymentIds: svc.voidedPaymentIds,
  };
  const ids = [...svc.invoiceIds, ...svc.creditNoteIds];
  if (ids.length) {
    const rows = (await ctx.sql`
      select id::text as id, kind, status
      from public.invoice where org_id = ${ctx.orgId} and id = any(${ids}::uuid[])
    `) as unknown as Array<Record<string, string | null>>;
    for (const r of rows) {
      const id = r.id ?? null;
      const status = r.status ?? null;
      if (!id || status === "draft" || status === "cancelled") continue;
      if ((r.kind ?? null) === "credit_note") h.creditNoteIds.push(id);
      else h.invoiceIds.push(id);
    }
  }
  if (svc.paymentIds.length) {
    const rows = (await ctx.sql`
      select id::text as id, status
      from public.payment where org_id = ${ctx.orgId} and id = any(${svc.paymentIds}::uuid[])
    `) as unknown as Array<Record<string, string | null>>;
    for (const r of rows) {
      const id = r.id ?? null;
      const status = r.status ?? null;
      if (!id) continue;
      if (status === "void") h.voidedPaymentIds.push(id);
      else if (status === "recorded" || status === "confirmed") h.paymentIds.push(id);
    }
  }
  const ar = (await ctx.sql`
    select i.customer_id::text as customer_id,
           sum(greatest(0, i.base_total_minor - coalesce(p.paid, 0) - coalesce(c.credited, 0)))::text as bal
    from public.invoice i
    left join lateral (select sum(base_amount_minor) as paid from public.payment
                       where invoice_id = i.id and org_id = i.org_id and status in ('recorded','confirmed')) p on true
    left join lateral (select sum(base_total_minor) as credited from public.invoice cn
                       where cn.corrects_invoice_id = i.id and cn.org_id = i.org_id
                         and cn.kind = 'credit_note' and cn.status <> 'cancelled') c on true
    where i.org_id = ${ctx.orgId} and i.kind = 'invoice' and i.status in ('issued','partially_paid')
    group by 1
  `) as unknown as Array<{ customer_id: string | null; bal: string }>;
  h.arByCustomerMinor = {};
  h.arTotalMinor = 0;
  for (const r of ar) {
    const bal = Number(r.bal);
    h.arTotalMinor += bal;
    const cid = r.customer_id ?? null;
    if (cid) h.arByCustomerMinor[cid] = bal;
  }
}

// ── The family ──────────────────────────────────────────────────────────────

export const sales: Family = {
  key: FAMILY,
  deps: ["setup", "people", "masters", "work"],
  /** Every company sells; nothing in profile.enables gates this family. */
  appliesTo: () => true,

  plan(ctx): FamilyPlan {
    return { family: FAMILY, expected: expectedCounts(ctx) };
  },

  async seed(ctx): Promise<FamilyReport> {
    const b = buildSales(ctx);
    const live = !ctx.dryRun && salesRuntime.live;
    if (live) await enrichFromDb(ctx, b);
    const counts: Record<string, number> = {};
    for (const table of SALES_TABLES) {
      const rows = b.rows[table] ?? [];
      const r = await ctx.insert(
        table,
        rows,
        table === "reference_sequence" ? SEQ_CONFLICT : undefined,
      );
      counts[table] = r.attempted;
      if (rows.length) ctx.log(`${table}: ${r.attempted} rows`);
    }
    const handoff = bulkHandoff(b);
    const notes = [...b.notes];
    if (live) {
      const svc = await driveServices(ctx, b);
      for (const [t, n] of Object.entries(b.serviceRows)) counts[t] = (counts[t] ?? 0) + n;
      await liveHandoff(ctx, handoff, svc);
      ctx.log(
        `services: ${svc.invoiceIds.length} invoices issued, ${svc.paymentIds.length} payments, ${svc.creditNoteIds.length} credit notes, ${svc.voidedPaymentIds.length} voided`,
      );
      notes.push(`service sample ${svc.invoiceIds.length}/${b.samples.length}`);
      if (svc.failures.length)
        notes.push(
          `${svc.failures.length} service calls failed: ${svc.failures.slice(0, 3).join(" | ")}`,
        );
    }
    if (b.convertedWithoutJob)
      notes.push(`${b.convertedWithoutJob} conversions had no job left and were left accepted`);
    return {
      family: FAMILY,
      counts,
      handoff: handoff as unknown as Record<string, unknown>,
      notes,
    };
  },

  async verify(ctx): Promise<Check[]> {
    const b = buildSales(ctx);
    const expected = expectedCounts(ctx);
    const org = ctx.orgId;
    const checks: Check[] = [];
    const count = async (table: string, where = "", params: unknown[] = []): Promise<number> => {
      const [r] = (await ctx.sql.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1 ${where}`,
        [org, ...params] as never[],
      )) as unknown as Array<{ n: number }>;
      return r!.n;
    };
    const violators = async (name: string, sqlText: string) => {
      const [r] = (await ctx.sql.unsafe(sqlText, [org])) as unknown as Array<{ n: number }>;
      checks.push({ name, ok: r!.n === 0, detail: `${r!.n} violating rows` });
    };

    // ── counts vs plan ──────────────────────────────────────────────────────
    for (const t of SALES_TABLES) {
      const n = await count(t);
      const want = expected[t] ?? 0;
      const ok = t === "reference_sequence" ? n >= want : n === want;
      checks.push({ name: `count ${t}`, ok, detail: `${n} live vs ${want} planned` });
    }

    // ── money and states ────────────────────────────────────────────────────
    await violators(
      "invoice total = subtotal + vat",
      `select count(*)::int as n from public.invoice where org_id = $1 and total_minor <> subtotal_minor + vat_amount_minor`,
    );
    await violators(
      "invoice subtotal and vat = sum of lines",
      `select count(*)::int as n from public.invoice i
       join lateral (select coalesce(sum(line_total_minor),0) as sub,
                            coalesce(sum(round(line_total_minor * vat_rate / 100)),0) as vat
                     from public.invoice_line l where l.invoice_id = i.id and l.org_id = i.org_id) s on true
       where i.org_id = $1 and (i.subtotal_minor <> s.sub or i.vat_amount_minor <> s.vat)`,
    );
    await violators(
      "quote totals = sum of lines",
      `select count(*)::int as n from public.quote q
       join lateral (select coalesce(sum(line_total_minor),0) as sub,
                            coalesce(sum(round(line_total_minor * vat_rate / 100)),0) as vat
                     from public.quote_line l where l.quote_id = q.id and l.org_id = q.org_id) s on true
       where q.org_id = $1 and (q.subtotal_minor <> s.sub or q.vat_amount_minor <> s.vat or q.total_minor <> q.subtotal_minor + q.vat_amount_minor)`,
    );
    const settled = `
      from public.invoice i
      left join lateral (select coalesce(sum(base_amount_minor),0) as paid from public.payment p
                         where p.invoice_id = i.id and p.org_id = i.org_id and p.status in ('recorded','confirmed')) p on true
      left join lateral (select coalesce(sum(base_total_minor),0) as credited from public.invoice cn
                         where cn.corrects_invoice_id = i.id and cn.org_id = i.org_id
                           and cn.kind = 'credit_note' and cn.status <> 'cancelled') c on true
      where i.org_id = $1 and i.kind = 'invoice'`;
    await violators(
      "payments + credits never exceed invoice totals",
      `select count(*)::int as n ${settled} and p.paid + c.credited > i.base_total_minor`,
    );
    await violators(
      "invoice status reconciles with live payments and credit notes",
      `select count(*)::int as n ${settled} and i.status in ('issued','partially_paid','paid')
         and i.status <> case when p.paid + c.credited >= i.base_total_minor then 'paid'
                              when p.paid > 0 then 'partially_paid' else 'issued' end`,
    );
    await violators(
      "issued documents carry issued_at; cancelled carry a reason",
      `select count(*)::int as n from public.invoice where org_id = $1
         and ((status in ('issued','partially_paid','paid') and issued_at is null)
           or (status = 'cancelled' and cancel_reason is null))`,
    );
    await violators(
      "credit notes correct issued invoices",
      `select count(*)::int as n from public.invoice cn join public.invoice i
         on i.id = cn.corrects_invoice_id and i.org_id = cn.org_id
       where cn.org_id = $1 and cn.kind = 'credit_note' and (i.status in ('draft','cancelled') or cn.status <> 'issued')`,
    );
    await violators(
      "linked payments share the invoice's customer",
      `select count(*)::int as n from public.payment p join public.invoice i on i.id = p.invoice_id and i.org_id = p.org_id
       where p.org_id = $1 and p.customer_id is distinct from i.customer_id`,
    );
    await violators(
      "voided payments carry voided_at, a reason and who voided",
      `select count(*)::int as n from public.payment where org_id = $1
         and ((status = 'void') <> (voided_at is not null) or (voided_at is not null and (void_reason is null or voided_by is null)))`,
    );
    await violators(
      "every payment has exactly one receipt",
      `select count(*)::int as n from public.payment p where p.org_id = $1
         and (select count(*) from public.payment_receipt r where r.payment_id = p.id and r.org_id = p.org_id) <> 1`,
    );
    await violators(
      "no quote sits in an approval-owned state without an approval",
      `select count(*)::int as n from public.quote q where q.org_id = $1 and q.status in ('converting','pending_approval')
         and not exists (select 1 from public.approval a where a.org_id = q.org_id and a.subject_type = 'quote_send' and a.subject_id = q.id)`,
    );
    await violators(
      "accepted quotes carry accepted_at; rejected carry a reason; converted carry their job",
      `select count(*)::int as n from public.quote where org_id = $1
         and ((status in ('accepted','converted') and accepted_at is null)
           or (status = 'rejected' and rejected_reason is null)
           or (status = 'converted' and converted_job_id is null))`,
    );
    await violators(
      "share tokens hang off sent updates with a frozen snapshot",
      `select count(*)::int as n from public.share_token t join public.customer_update u
         on u.id = t.customer_update_id and u.org_id = t.org_id
       where t.org_id = $1 and (u.status <> 'sent' or u.content is null or u.sent_at is null)`,
    );
    await violators(
      "document shares point at a quote or invoice of this organisation",
      `select count(*)::int as n from public.document_share d
       where d.org_id = $1 and not exists (
         select 1 from public.invoice i where d.subject_type = 'invoice' and i.id = d.subject_id and i.org_id = d.org_id
         union all
         select 1 from public.quote q where d.subject_type = 'quote' and q.id = d.subject_id and q.org_id = d.org_id)`,
    );

    // ── the bulk rows kept their born / reconciled states ───────────────────
    const bulkPaymentIds = b.payments.map((p) => p.id);
    const [bp] = (await ctx.sql`
      select count(*)::int as n from public.payment
      where org_id = ${org} and id = any(${bulkPaymentIds}::uuid[]) and status not in ('recorded','void')
    `) as unknown as Array<{ n: number }>;
    checks.push({
      name: "bulk payments are recorded or void only",
      ok: bp!.n === 0,
      detail: `${bp!.n} in an approval-decided state`,
    });

    const overdue = await count(
      "invoice",
      "and kind = 'invoice' and status in ('issued','partially_paid') and due_date < $2::date",
      [ctx.company.history.asOf],
    );
    checks.push({
      name: "overdue invoices exist",
      ok: overdue > 0,
      detail: `${overdue} overdue at ${ctx.company.history.asOf}`,
    });
    for (const status of ["draft", "issued", "partially_paid", "paid", "cancelled"]) {
      const n = await count("invoice", "and kind = 'invoice' and status = $2", [status]);
      checks.push({ name: `invoice status mix: ${status} present`, ok: n > 0, detail: `${n}` });
    }
    for (const [table, key] of [
      ["invoice", "invoices"],
      ["quote", "quotes"],
    ] as const) {
      const want = ctx.company.profile[key];
      if (want <= 1205) continue;
      const n = await count(table);
      checks.push({ name: `pagination: ${table} > 1,205`, ok: n > 1205, detail: `${n} rows` });
    }

    // ── sequences continue after the bulk serials ───────────────────────────
    const seqRows = (await ctx.sql`
      select scope_key, next_value::int as next_value from public.reference_sequence where org_id = ${org}
    `) as unknown as Array<{ scope_key: string; next_value: number }>;
    const seqOk = Object.entries(b.sequences).every(
      ([scope, next]) => (seqRows.find((r) => r.scope_key === scope)?.next_value ?? 0) >= next,
    );
    checks.push({ name: "reference sequences advanced past the bulk", ok: seqOk });
    await violators(
      "references are unique per document kind",
      `select count(*)::int as n from (
         select reference from public.invoice where org_id = $1 group by reference having count(*) > 1
         union all select reference from public.quote where org_id = $1 group by reference having count(*) > 1
         union all select reference from public.payment where org_id = $1 group by reference having count(*) > 1) d`,
    );

    // ── AR: the bulk reconciles with the build; the book with computeAR ─────
    const arSql = (extra: string) =>
      `select coalesce(sum(greatest(0, i.base_total_minor - coalesce(p.paid, 0) - coalesce(c.credited, 0))), 0)::text as ar
       from public.invoice i
       left join lateral (select sum(base_amount_minor) as paid from public.payment
                          where invoice_id = i.id and org_id = i.org_id and status in ('recorded','confirmed')) p on true
       left join lateral (select sum(base_total_minor) as credited from public.invoice cn
                          where cn.corrects_invoice_id = i.id and cn.org_id = i.org_id
                            and cn.kind = 'credit_note' and cn.status <> 'cancelled') c on true
       where i.org_id = $1 and i.kind = 'invoice' and i.status in ('issued','partially_paid') ${extra}`;
    const bulkIds = b.invoices.filter((i) => i.kind === "invoice").map((i) => i.id);
    const [bulkAr] = (await ctx.sql.unsafe(arSql("and i.id = any($2::uuid[])"), [
      org,
      bulkIds,
    ] as never[])) as unknown as Array<{ ar: string }>;
    checks.push({
      name: "AR of the bulk invoices = the build's AR",
      ok: Number(bulkAr!.ar) === b.arTotalMinor,
      detail: `${bulkAr!.ar} live vs ${b.arTotalMinor} built`,
    });
    const [allAr] = (await ctx.sql.unsafe(arSql(""), [org] as never[])) as unknown as Array<{
      ar: string;
    }>;
    try {
      const { computeAR } = await import("@/modules/invoices/service");
      const ar = await computeAR(
        ctx.ctxFor("finance"),
        ctx.archetypeOf("finance"),
        ctx.company.history.asOf,
      );
      checks.push({
        name: "computeAR agrees with the ledger formula",
        ok: ar.outstandingMinor === Number(allAr!.ar),
        detail: `computeAR ${ar.outstandingMinor} vs sql ${allAr!.ar}`,
      });
    } catch (e) {
      checks.push({
        name: "computeAR agrees with the ledger formula",
        ok: false,
        detail: String(e),
      });
    }

    // ── the service sample left the trail the application leaves ───────────
    if (b.serviceRows.invoice) {
      const p = await readProgress(ctx);
      const invoiceIds = Object.values(p.invoices);
      const cnIds = Object.values(p.creditNotes);
      const paymentIds = Object.values(p.payments);
      const voidedIds = p.voided.map((k) => p.payments[String(k)]).filter((x): x is string => !!x);
      const docIds = [...invoiceIds, ...cnIds];
      const allIds = [...docIds, ...paymentIds];
      const s = SERVICE_SAMPLE;
      const want = (t: string) => b.serviceRows[t] ?? 0;
      checks.push({
        name: "service sample: progress marker names every invoice",
        ok: invoiceIds.length === s.invoices && p.issued.length === s.invoices,
        detail: `${invoiceIds.length} created, ${p.issued.length} issued of ${s.invoices}`,
      });
      const expectIds = async (
        name: string,
        table: string,
        column: string,
        ids: string[],
        wantN: number,
        extra = "",
      ) => {
        const n = ids.length
          ? await count(table, `and ${column} = any($2::uuid[]) ${extra}`, [ids])
          : 0;
        checks.push({
          name: `service sample: ${name}`,
          ok: n === wantN,
          detail: `${n} vs ${wantN}`,
        });
      };
      await expectIds(
        "issued invoices",
        "invoice",
        "id",
        invoiceIds,
        s.invoices,
        "and status <> 'draft'",
      );
      await expectIds(
        "credit notes",
        "invoice",
        "id",
        cnIds,
        s.creditNotes,
        "and kind = 'credit_note'",
      );
      await expectIds("payments", "payment", "id", paymentIds, s.fullPayments + s.partialPayments);
      await expectIds(
        "receipts",
        "payment_receipt",
        "payment_id",
        paymentIds,
        s.fullPayments + s.partialPayments,
      );
      await expectIds(
        "voided payments",
        "payment",
        "id",
        voidedIds,
        s.voidedPayments,
        "and status = 'void'",
      );
      await expectIds(
        "approvals opened for payments",
        "approval",
        "subject_id",
        paymentIds,
        want("approval"),
      );
      await expectIds("audit rows", "audit_log", "entity_id", allIds, want("audit_log"));
      await expectIds(
        "journal entries (postings and reversals)",
        "journal_entry",
        "source_id",
        allIds,
        want("journal_entry"),
      );
      const [jl] = (await ctx.sql`
        select count(*)::int as n from public.journal_line l
        join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
        where l.org_id = ${org} and e.source_id = any(${allIds}::uuid[])
      `) as unknown as Array<{ n: number }>;
      checks.push({
        name: "service sample: journal lines",
        ok: jl!.n === want("journal_line"),
        detail: `${jl!.n} vs ${want("journal_line")}`,
      });
      await expectIds("tax entries", "tax_entry", "source_id", docIds, want("tax_entry"));
      const [ev] = (await ctx.sql`
        select count(*)::int as n from public.domain_event
        where org_id = ${org} and (
          payload->>'invoiceId' = any(${docIds}::text[])
          or payload->>'paymentId' = any(${paymentIds}::text[])
          or payload->>'subjectId' = any(${paymentIds}::text[]))
      `) as unknown as Array<{ n: number }>;
      checks.push({
        name: "service sample: outbox events",
        ok: ev!.n === want("domain_event"),
        detail: `${ev!.n} vs ${want("domain_event")}`,
      });
      // Notifications: one per other member of the role each payment approval landed on.
      const [nt] = (await ctx.sql`
        select count(*)::int as n from public.notification n
        where n.org_id = ${org} and n.kind = 'approval_requested'
          and n.entity_id in (select a.id from public.approval a where a.org_id = ${org} and a.subject_id = any(${paymentIds}::uuid[]))
      `) as unknown as Array<{ n: number }>;
      const [mem] = (await ctx.sql`
        select coalesce(sum(cnt), 0)::int as n from (
          select (select count(*) from public.membership m
                  join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
                  where m.org_id = a.org_id and r.archetype = a.assigned_role
                    and m.deactivated_at is null and m.user_id <> a.requested_by) as cnt
          from public.approval a where a.org_id = ${org} and a.subject_id = any(${paymentIds}::uuid[])) x
      `) as unknown as Array<{ n: number }>;
      checks.push({
        name: "service sample: approval notifications reached the other members of the assigned role",
        ok: nt!.n === mem!.n,
        detail: `${nt!.n} vs ${mem!.n} live (planned ${want("notification")})`,
      });
      for (const [action, wantN] of [
        ["invoice.issue", s.invoices],
        ["payment.record", s.fullPayments + s.partialPayments],
        ["invoice.credit_note", s.creditNotes],
        ["payment.void", s.voidedPayments],
      ] as const) {
        const n = await count("audit_log", "and action = $2 and entity_id = any($3::uuid[])", [
          action,
          allIds,
        ]);
        checks.push({
          name: `service sample: audit ${action}`,
          ok: n === wantN,
          detail: `${n} vs ${wantN}`,
        });
      }
    }
    return checks;
  },
};
