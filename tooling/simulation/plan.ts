/**
 * The deterministic plan builder: Scenario + as-of date → a full Plan of typed
 * rows. Pure and reproducible (seeded PRNG, stable uuidv5 ids, no wall-clock).
 * Financial totals use the app's exact formulas (money.ts) so the seeded data
 * reconciles with what the product computes. The generator deliberately produces
 * the "personality" states each scenario needs: an overdue collection, an
 * upcoming deadline, a pending approval, an active blocker, done-this-week work,
 * and period-representative multi-month/-year history that is lighter in the past
 * and richest in the recent window.
 */
import { SimClock } from "./dates";
import { Rng, uuidv5 } from "./rng";
import { computeTotals, labourCostMinor, poTotals, toMinor } from "./money";
import type {
  BillingPoint,
  InvoiceLine,
  InvoiceRow,
  JobRow,
  Plan,
  QuoteLine,
  QuoteRow,
  Scenario,
  StageRow,
} from "./types";

/** Accumulates the plan and hands out stable ids + per-scope reference numbers. */
class Builder {
  readonly plan: Plan;
  /** (employee|date) keys that already have an attendance row — one row per day. */
  readonly attSeen = new Set<string>();
  private readonly seqs = new Map<string, number>();
  constructor(
    readonly s: Scenario,
    readonly clock: SimClock,
    readonly rng: Rng,
  ) {
    this.plan = {
      scenarioKey: s.key,
      asOf: clock.asOf,
      customers: [],
      suppliers: [],
      items: [],
      employees: [],
      jobs: [],
      reports: [],
      attendance: [],
      issues: [],
      approvalRules: [],
      approvals: [],
      materialRequests: [],
      purchaseOrders: [],
      goodsReceipts: [],
      expenses: [],
      quotes: [],
      invoices: [],
      payments: [],
      activity: [],
      exceptions: [],
      sequences: [],
    };
  }
  id(name: string): string {
    return uuidv5(`${this.s.key}:${name}`);
  }
  /** next per-scope sequence value (1-based). */
  seq(scope: string): number {
    const n = (this.seqs.get(scope) ?? 0) + 1;
    this.seqs.set(scope, n);
    return n;
  }
  ref(prefix: string, scope: string, pad = 3): string {
    return `${prefix}-${String(this.seq(scope)).padStart(pad, "0")}`;
  }
  jobRef(code: string, year: number): string {
    return `${code}-${year}-${String(this.seq(`job.${code}`)).padStart(3, "0")}`;
  }
  finalizeSequences(): void {
    for (const [scope, n] of this.seqs)
      this.plan.sequences.push({ scopeKey: scope, nextValue: n + 1 });
  }
  act(entityType: string, entityId: string, verb: string, summary: string, daysAgo: number): void {
    this.plan.activity.push({
      id: this.id(`act:${entityType}:${entityId}:${verb}`),
      entityType,
      entityId,
      verb,
      summary,
      createdAt: this.clock.tsAgo(daysAgo, 8 + this.rng.int(0, 8), this.rng.int(0, 59)),
    });
  }
}

const YEAR = (dateIso: string): number => Number(dateIso.slice(0, 4));

/** VAT percent for the org (UAE standard rate when registered). */
function vatRate(s: Scenario): number {
  return s.vatRegistered ? 5 : 0;
}

/** Build service-style document lines (free-text descriptions, priced directly). */
function serviceLines(
  b: Builder,
  keyPrefix: string,
  titles: { en: string; ar: string }[],
  priceRangeMajor: [number, number],
  count: number,
): { description: string; qty: number; unit: string; unitPriceMinor: number; vatRate: number }[] {
  const out: {
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    vatRate: number;
  }[] = [];
  for (let i = 0; i < count; i++) {
    const t = b.rng.pick(titles);
    const qty = b.rng.chance(0.7) ? 1 : b.rng.int(2, 6);
    const price = b.rng.int(priceRangeMajor[0], priceRangeMajor[1]);
    out.push({
      description: b.s.locale === "ar" ? t.ar : t.en,
      qty,
      unit: b.s.locale === "ar" ? "خدمة" : "service",
      unitPriceMinor: toMinor(price, b.s.currency),
      vatRate: vatRate(b.s),
    });
  }
  return out;
}

/** Build item-based lines (reference catalog items at selling price). */
function itemLines(
  b: Builder,
  count: number,
): {
  itemId: string;
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  vatRate: number;
}[] {
  const sellable = b.plan.items.filter((it) => (it.sellingPriceMinor ?? 0) > 0);
  const src = sellable.length ? sellable : b.plan.items;
  const out: {
    itemId: string;
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    vatRate: number;
  }[] = [];
  for (let i = 0; i < count; i++) {
    const it = b.rng.pick(src);
    out.push({
      itemId: it.id,
      description: it.name,
      qty: b.rng.int(2, 40),
      unit: it.unit,
      unitPriceMinor: it.sellingPriceMinor ?? it.unitCostMinor ?? toMinor(50, b.s.currency),
      vatRate: vatRate(b.s),
    });
  }
  return out;
}

// ── Masters ───────────────────────────────────────────────────────────────────

function buildMasters(b: Builder): void {
  const { s, clock, rng } = b;
  s.customers.forEach((c, i) => {
    b.plan.customers.push({
      id: b.id(`customer:${i}`),
      name: c.name,
      country: s.country,
      contactName: c.contactName ?? null,
      phone: `${s.contact.phone.slice(0, -2)}${String(10 + i).slice(-2)}`,
      email: null,
      taxRegNo: null,
      notes: c.segment ? `Simulation customer — ${c.segment}` : "Simulation customer",
      active: true,
      createdAt: clock.tsAgo(
        clock.daysAgoOf(clock.monthAgo(Math.min(s.historyMonths, rng.int(1, s.historyMonths)))),
        10,
      ),
    });
  });
  s.suppliers.forEach((sup, i) => {
    b.plan.suppliers.push({
      id: b.id(`supplier:${i}`),
      name: sup.name,
      taxRegNo: null,
      termsText: sup.terms ?? null,
      phone: `${s.contact.phone.slice(0, -2)}${String(30 + i).slice(-2)}`,
      email: null,
      active: true,
      createdAt: clock.tsAgo(clock.daysAgoOf(clock.monthAgo(s.historyMonths)), 11),
    });
  });
  s.items.forEach((it, i) => {
    b.plan.items.push({
      id: b.id(`item:${i}`),
      sku: it.sku,
      name: it.name,
      categoryKey: it.categoryKey,
      unit: it.unit,
      unitCostMinor: toMinor(it.unitCostMajor, s.currency),
      sellingPriceMinor:
        it.sellingPriceMajor > 0 ? toMinor(it.sellingPriceMajor, s.currency) : null,
      active: true,
      createdAt: clock.tsAgo(clock.daysAgoOf(clock.monthAgo(s.historyMonths)), 12),
    });
  });
  s.employees.forEach((e, i) => {
    const salaryMinor = toMinor(e.salaryMajor, s.currency);
    b.plan.employees.push({
      id: b.id(`employee:${i}`),
      name: e.name,
      phone: null,
      active: true,
      createdAt: clock.tsAgo(clock.daysAgoOf(clock.monthAgo(s.historyMonths)), 8),
      salaryMinor,
      // Mirrors setEmployeeTerms default: hourly = round(salary/208); floor at a
      // plausible minimum so a founder on a nominal salary still costs labour.
      hourlyCostMinor: Math.max(toMinor(15, s.currency), Math.round(salaryMinor / 208)),
      otRate: e.otRate,
    });
  });
}

// ── Job + stage construction ────────────────────────────────────────────────

type JobRole =
  | "historical_done"
  | "done_recent_paid"
  | "done_this_week"
  | "active_wip"
  | "active_upcoming"
  | "overdue_active"
  | "on_hold"
  | "overdue_invoice"
  | "blocked_parts";

/** Seed a job's stage snapshot rows given its progress (0..1) and preset skips. */
function buildStages(
  b: Builder,
  jobId: string,
  presetSkips: string[],
  progress: number,
): { stages: StageRow[]; currentStageKey: string | null } {
  const { s, clock } = b;
  const active = s.stages.filter((st) => !presetSkips.includes(st.key));
  const totalWeight = active.reduce((n, st) => n + st.weight, 0);
  // Determine how many stages are complete based on cumulative weight vs progress.
  let acc = 0;
  let currentStageKey: string | null = null;
  const stages: StageRow[] = s.stages.map((st, sort) => {
    const skipped = presetSkips.includes(st.key);
    let status: StageRow["status"] = "not_started";
    let startedAt: string | null = null;
    let completedAt: string | null = null;
    if (skipped) {
      status = "skipped";
    } else {
      const before = acc;
      acc += st.weight / totalWeight;
      if (progress >= 0.999) {
        status = "completed";
        startedAt = clock.tsAgo(30, 9);
        completedAt = clock.tsAgo(20, 15);
      } else if (progress >= acc) {
        status = "completed";
        startedAt = clock.tsAgo(20, 9);
        completedAt = clock.tsAgo(10, 15);
      } else if (progress > before) {
        status = "in_progress";
        startedAt = clock.tsAgo(8, 9);
        currentStageKey = st.key;
      }
    }
    return {
      id: b.id(`job:${jobId}:stage:${st.key}`),
      stageKey: st.key,
      en: st.en,
      ar: st.ar,
      weight: st.weight,
      sort,
      status,
      startedAt,
      completedAt,
    };
  });
  if (!currentStageKey) {
    // done → last active stage; not started → first active stage.
    const done = progress >= 0.999;
    const target = done ? [...active].reverse()[0] : active[0];
    currentStageKey = target?.key ?? null;
  }
  return { stages, currentStageKey };
}

type BuiltJob = { job: JobRow; role: JobRole; sellPriceMinor: number };

function buildJob(
  b: Builder,
  idx: number,
  role: JobRole,
  opts: {
    startAgo: number;
    dueAgo: number; // negative = future
    completedAgo: number | null;
    progress: number;
    statusCategory: JobRow["statusCategory"];
    customerIdx: number;
    sellPriceMajor: number;
  },
): BuiltJob {
  const { s, clock } = b;
  const preset = b.rng.pick(s.presets);
  const wt = b.rng.pick(s.workTitles);
  const startDate = clock.dayAgo(opts.startAgo);
  const jobKey = `job:${idx}`;
  const jobId = b.id(jobKey);
  const { stages, currentStageKey } = buildStages(b, jobKey, preset.skipped, opts.progress);
  const statusKey =
    opts.statusCategory === "done"
      ? "completed"
      : opts.statusCategory === "active"
        ? "in_progress"
        : opts.statusCategory === "on_hold"
          ? "on_hold"
          : opts.statusCategory === "cancelled"
            ? "cancelled"
            : "draft";
  const completedDate = opts.completedAgo != null ? clock.dayAgo(opts.completedAgo) : null;
  const updatedAgo = completedDate ? opts.completedAgo! : Math.max(0, opts.startAgo - 2);
  const customer = b.plan.customers[opts.customerIdx % b.plan.customers.length]!;
  const currentStage = stages.find((st) => st.stageKey === currentStageKey) ?? null;
  const job: JobRow = {
    id: jobId,
    presetCode: preset.code,
    reference: b.jobRef(preset.code, YEAR(startDate)),
    name: s.locale === "ar" ? wt.ar : wt.en,
    customerId: customer.id,
    statusKey,
    statusCategory: opts.statusCategory,
    startDate,
    dueDate: opts.dueAgo != null ? clock.dayAgo(opts.dueAgo) : null,
    completedDate,
    sellingPriceMinor: toMinor(opts.sellPriceMajor, s.currency),
    paymentTerms: s.locale === "ar" ? "الدفع خلال 30 يوماً" : "Net 30",
    billingPoints: preset.billing as BillingPoint[],
    createdAt: clock.tsAgo(opts.startAgo, 9),
    updatedAt: clock.tsAgo(updatedAgo, 16),
    currentStageKey: currentStage ? currentStage.stageKey : null,
    stages,
    crew: b.plan.employees.slice(1, 1 + Math.min(3, b.plan.employees.length - 1)).map((e) => e.id),
  };
  // current_stage_id resolution happens at apply time by matching currentStageKey.
  b.plan.jobs.push(job);
  return { job, role, sellPriceMinor: job.sellingPriceMinor! };
}

// ── Reports (rich recent window) ──────────────────────────────────────────────

function buildReportsForJob(
  b: Builder,
  job: JobRow,
  count: number,
  latestAgo: number,
  everyDays: number,
): void {
  const { s, clock, rng } = b;
  const crew = job.crew.length ? job.crew : b.plan.employees.slice(0, 2).map((e) => e.id);
  const empById = new Map(b.plan.employees.map((e) => [e.id, e]));
  for (let k = 0; k < count; k++) {
    const daysAgo = latestAgo + k * everyDays;
    if (daysAgo < 0) continue;
    const reportDate = clock.dayAgo(daysAgo);
    const activeStage =
      job.stages.find((st) => st.status === "in_progress") ??
      job.stages.find((st) => st.status === "completed");
    const workLines = [
      {
        stageKey: activeStage?.stageKey ?? null,
        description:
          s.locale === "ar"
            ? `تقدم في ${activeStage?.ar ?? job.name}`
            : `Progress on ${activeStage?.en ?? job.name}`,
        progressNote: `~${rng.int(20, 90)}%`,
      },
    ];
    const matCount = rng.int(1, 2);
    const materialLines = Array.from({ length: matCount }, () => {
      const it = rng.pick(b.plan.items);
      return {
        itemId: it.id,
        itemName: it.name,
        qty: rng.int(1, 8),
        unit: it.unit,
        unitCostMinor: it.unitCostMinor,
        costSource: "manual" as const,
      };
    });
    const labCount = Math.min(crew.length, rng.int(1, 2));
    const labourLines = crew.slice(0, labCount).map((eid) => {
      const emp = empById.get(eid)!;
      const normalHours = rng.pick([6, 7, 8, 8, 8]);
      const otHours = rng.chance(0.3) ? rng.int(1, 3) : 0;
      return {
        employeeId: eid,
        normalHours,
        otHours,
        hourlyCostMinor: emp.hourlyCostMinor,
        otRate: emp.otRate,
        labourCostMinor: labourCostMinor(normalHours, otHours, emp.hourlyCostMinor, emp.otRate),
      };
    });
    const reviewed = daysAgo > 3;
    b.plan.reports.push({
      id: b.id(`report:${job.id}:${reportDate}`),
      jobId: job.id,
      reportDate,
      summary:
        s.locale === "ar"
          ? `عمل ميداني على ${job.name} بتاريخ ${reportDate}`
          : `Site work on ${job.name} for ${reportDate}`,
      blockers: rng.chance(0.15)
        ? s.locale === "ar"
          ? "بانتظار توريد مواد"
          : "Awaiting a material delivery"
        : null,
      nextSteps: null,
      status: reviewed ? "reviewed" : "submitted",
      submittedAt: clock.tsAgo(daysAgo, 17),
      reviewedAt: reviewed ? clock.tsAgo(daysAgo - 1, 10) : null,
      createdAt: clock.tsAgo(daysAgo, 17),
      idempotencyKey: `sim:dr:${job.id}:${reportDate}`,
      workLines,
      materialLines,
      labourLines,
    });
    // Derived attendance (present) for each labour employee that day — one row per
    // (employee, day) even when the worker appears on several jobs' reports.
    for (const l of labourLines) {
      const attKey = `${l.employeeId}|${reportDate}`;
      if (b.attSeen.has(attKey)) continue;
      b.attSeen.add(attKey);
      b.plan.attendance.push({
        id: b.id(`att:${l.employeeId}:${reportDate}`),
        employeeId: l.employeeId,
        date: reportDate,
        status: "present",
        source: "labour_line",
        note: null,
      });
    }
  }
}

// ── Invoices + payments ───────────────────────────────────────────────────────

function buildInvoice(
  b: Builder,
  key: string,
  job: JobRow | null,
  customerId: string | null,
  quoteId: string | null,
  lines: {
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    vatRate: number;
  }[],
  issuedAgo: number,
  dueInDaysFromIssue: number,
): InvoiceRow {
  const { s, clock } = b;
  const vatApplies = s.vatRegistered; // is_export=false
  const totals = computeTotals(lines, 1, vatApplies);
  const issuedAt = clock.tsAgo(issuedAgo, 12);
  const issuedDate = clock.dayAgo(issuedAgo);
  const dueDate = clock.dayAgo(issuedAgo - dueInDaysFromIssue);
  const cust = customerId ? (b.plan.customers.find((c) => c.id === customerId) ?? null) : null;
  const inv: InvoiceRow = {
    id: b.id(`invoice:${key}`),
    reference: b.ref("INV", "invoice"),
    kind: "invoice",
    correctsInvoiceId: null,
    customerId,
    customerName: cust?.name ?? null,
    customerTaxRegNo: null,
    jobId: job?.id ?? null,
    quoteId,
    status: "issued",
    isExport: false,
    currency: s.currency,
    exchangeRate: 1,
    subtotalMinor: totals.subtotalMinor,
    vatAmountMinor: totals.vatAmountMinor,
    totalMinor: totals.totalMinor,
    baseTotalMinor: totals.baseTotalMinor,
    issuedAt,
    dueDate,
    cancelledAt: null,
    cancelReason: null,
    notes: null,
    createdAt: issuedAt,
    lines: lines.map((l, i): InvoiceLine => ({
      id: b.id(`invoice:${key}:line:${i}`),
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPriceMinor: l.unitPriceMinor,
      vatRate: vatApplies ? l.vatRate : 0,
      lineTotalMinor: totals.lines[i]!.lineTotalMinor,
      sort: i,
    })),
  };
  b.plan.invoices.push(inv);
  void issuedDate;
  return inv;
}

/** Record a payment against an invoice for a fraction (0..1) of its base total, and
 * set the invoice status by reconciling (partially_paid / paid). Self-caps so the
 * running paid total never exceeds the invoice base total. */
function payInvoice(
  b: Builder,
  inv: InvoiceRow,
  fraction: number,
  paidAgo: number,
  method: PaymentMethod,
): void {
  const { s, clock } = b;
  const already = b.plan.payments
    .filter((p) => p.invoiceId === inv.id && (p.status === "recorded" || p.status === "confirmed"))
    .reduce((n, p) => n + p.baseAmountMinor, 0);
  const remaining = Math.max(0, inv.baseTotalMinor - already);
  const amount = Math.min(remaining, Math.round(inv.baseTotalMinor * fraction));
  if (amount <= 0) return;
  const key = `pay:${inv.id}:${b.plan.payments.length}`;
  b.plan.payments.push({
    id: b.id(key),
    reference: b.ref("PMT", "payment"),
    invoiceId: inv.id,
    customerId: inv.customerId,
    customerName: inv.customerName,
    status: "confirmed",
    method,
    paymentDate: clock.dayAgo(paidAgo),
    amountMinor: amount,
    currency: s.currency,
    exchangeRate: 1,
    baseAmountMinor: amount,
    createdAt: clock.tsAgo(paidAgo, 13),
    receiptId: b.id(`${key}:receipt`),
    receiptReference: b.ref("RCP", "payment_receipt"),
  });
  const paid = already + amount;
  inv.status = paid >= inv.baseTotalMinor ? "paid" : "partially_paid";
}

type PaymentMethod = "cash" | "bank_transfer" | "cheque" | "card" | "other";
const METHODS: PaymentMethod[] = ["bank_transfer", "cash", "cheque", "card"];

// ── Quotes ────────────────────────────────────────────────────────────────────

function buildQuote(
  b: Builder,
  key: string,
  status: QuoteRow["status"],
  customerId: string,
  presetCode: string | null,
  lines: {
    itemId?: string;
    description: string;
    qty: number;
    unit: string;
    unitPriceMinor: number;
    vatRate: number;
  }[],
  createdAgo: number,
  opts: { convertedJobId?: string; validAheadDays?: number; rejectReason?: string } = {},
): QuoteRow {
  const { s, clock } = b;
  const totals = computeTotals(lines, 1, s.vatRegistered);
  const cust = b.plan.customers.find((c) => c.id === customerId)!;
  const converted = status === "converted";
  const accepted = converted;
  const q: QuoteRow = {
    id: b.id(`quote:${key}`),
    reference: b.ref("QT", "quote"),
    customerId,
    customerName: cust.name,
    presetCode,
    status,
    currency: s.currency,
    exchangeRate: 1,
    subtotalMinor: totals.subtotalMinor,
    vatAmountMinor: totals.vatAmountMinor,
    totalMinor: totals.totalMinor,
    baseTotalMinor: totals.baseTotalMinor,
    terms: s.locale === "ar" ? "الدفع خلال 30 يوماً" : "Net 30 from acceptance",
    validUntil:
      opts.validAheadDays != null
        ? clock.dayAhead(opts.validAheadDays)
        : clock.dayAgo(createdAgo - 30),
    acceptedAt: accepted ? clock.tsAgo(Math.max(0, createdAgo - 3), 11) : null,
    acceptedNote: accepted ? (s.locale === "ar" ? "أمر موقّع" : "Signed order") : null,
    rejectedReason:
      status === "rejected" ? (opts.rejectReason ?? "Customer chose another vendor") : null,
    convertedJobId: opts.convertedJobId ?? null,
    notes: null,
    createdAt: clock.tsAgo(createdAgo, 10),
    lines: lines.map((l, i): QuoteLine => ({
      id: b.id(`quote:${key}:line:${i}`),
      sectionKey: null,
      itemId: l.itemId ?? null,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPriceMinor: l.unitPriceMinor,
      vatRate: s.vatRegistered ? l.vatRate : 0,
      lineTotalMinor: totals.lines[i]!.lineTotalMinor,
      sort: i,
    })),
  };
  b.plan.quotes.push(q);
  return q;
}

// ── The scenario assembly ─────────────────────────────────────────────────────

export function buildPlan(scenario: Scenario, asOf: string): Plan {
  const clock = new SimClock(asOf);
  const rng = new Rng(`${scenario.key}:${asOf}`);
  const b = new Builder(scenario, clock, rng);
  const s = scenario;
  const isWholesale = s.itemCategories.some((c) =>
    ["beverages", "packaging_crates", "dry_goods"].includes(c),
  );

  buildMasters(b);
  const nCust = b.plan.customers.length;
  const rich = s.richDays;
  const histDays = s.historyMonths * 30;
  // The one aged/overdue invoice must sit INSIDE this business's history window
  // (a 2-month-old bakery cannot have a 4-month-old invoice).
  const overdueStartAgo = Math.min(130, histDays - 8);
  const overdueCompletedAgo = Math.max(rich - 15, overdueStartAgo - rng.int(6, 14));

  // Price bands per business (major units) for service jobs.
  const band: [number, number] =
    s.key === "home_cupcakes"
      ? [250, 1500]
      : s.key === "auto_workshop"
        ? [400, 4000]
        : s.key === "palm_farm"
          ? [3000, 30000]
          : s.key === "shortstay_ops"
            ? [400, 6000]
            : [800, 12000];

  const workTitles = s.workTitles;
  const quoteLinesFor = (n: number) =>
    isWholesale && b.plan.items.some((i) => i.sellingPriceMinor)
      ? itemLines(b, n)
      : serviceLines(b, "q", workTitles, band, n);

  let jobIdx = 0;
  const nextIdx = () => jobIdx++;

  // ── 1) Recent "role" jobs (the rich window) ────────────────────────────────
  const small = s.key === "home_cupcakes";
  const roles: Array<{
    role: JobRole;
    startAgo: number;
    dueAgo: number;
    completedAgo: number | null;
    progress: number;
    cat: JobRow["statusCategory"];
    sell: number;
    fromQuote: boolean;
    invoice: "paid" | "partial" | "unpaid" | "overdue" | "none";
    deadline?: boolean;
  }> = [
    {
      role: "done_recent_paid",
      startAgo: rich - 5,
      dueAgo: 25,
      completedAgo: 22,
      progress: 1,
      cat: "done",
      sell: rng.int(band[0], band[1]),
      fromQuote: true,
      invoice: "paid",
    },
    {
      role: "done_this_week",
      startAgo: 20,
      dueAgo: 3,
      completedAgo: rng.int(2, 5),
      progress: 1,
      cat: "done",
      sell: rng.int(band[0], band[1]),
      fromQuote: true,
      invoice: "partial",
    },
    {
      role: "active_wip",
      startAgo: 24,
      dueAgo: -12,
      completedAgo: null,
      progress: 0.45,
      cat: "active",
      sell: rng.int(band[0], band[1]),
      fromQuote: true,
      invoice: "partial",
    },
    {
      role: "active_upcoming",
      startAgo: 16,
      dueAgo: -6,
      completedAgo: null,
      progress: 0.7,
      cat: "active",
      sell: rng.int(band[0], band[1]),
      fromQuote: true,
      invoice: "partial",
      deadline: true,
    },
    {
      role: "overdue_active",
      startAgo: 40,
      dueAgo: 8,
      completedAgo: null,
      progress: 0.6,
      cat: "active",
      sell: rng.int(band[0], band[1]),
      fromQuote: false,
      invoice: "none",
    },
    {
      role: "on_hold",
      startAgo: 30,
      dueAgo: -20,
      completedAgo: null,
      progress: 0.35,
      cat: "on_hold",
      sell: rng.int(band[0], band[1]),
      fromQuote: false,
      invoice: "none",
    },
    {
      role: "overdue_invoice",
      startAgo: overdueStartAgo,
      dueAgo: overdueStartAgo - 22,
      completedAgo: overdueCompletedAgo,
      progress: 1,
      cat: "done",
      sell: rng.int(band[0], band[1]),
      fromQuote: true,
      invoice: "overdue",
    },
    {
      role: "blocked_parts",
      startAgo: 22,
      dueAgo: -4,
      completedAgo: null,
      progress: 0.5,
      cat: "active",
      sell: rng.int(band[0], band[1]),
      fromQuote: false,
      invoice: "none",
    },
  ];
  const chosen = small
    ? roles.filter((r) =>
        [
          "done_recent_paid",
          "done_this_week",
          "active_upcoming",
          "overdue_invoice",
          "blocked_parts",
        ].includes(r.role),
      )
    : roles;

  const built: BuiltJob[] = [];
  const byRole = new Map<JobRole, BuiltJob>();
  chosen.forEach((r, i) => {
    const bj = buildJob(b, nextIdx(), r.role, {
      startAgo: r.startAgo,
      dueAgo: r.dueAgo,
      completedAgo: r.completedAgo,
      progress: r.progress,
      statusCategory: r.cat,
      customerIdx: i,
      sellPriceMajor: r.sell,
    });
    built.push(bj);
    byRole.set(r.role, bj);
    b.act(
      "job",
      bj.job.id,
      r.cat === "done" ? "completed" : "created",
      bj.job.name,
      Math.min(r.startAgo, 9),
    );

    // Quote origin (converted) for quote-originated jobs.
    if (r.fromQuote) {
      const q = buildQuote(
        b,
        `for:${bj.job.id}`,
        "converted",
        bj.job.customerId!,
        bj.job.presetCode,
        quoteLinesFor(rng.int(2, 4)),
        r.startAgo + 4,
        { convertedJobId: bj.job.id },
      );
      bj.job.sellingPriceMinor = q.baseTotalMinor; // frozen base total becomes selling price
      b.act(
        "quote",
        q.id,
        "accepted",
        `${q.reference} → ${bj.job.reference}`,
        Math.min(r.startAgo, 8),
      );
    }

    // Reports for jobs currently/recently worked (rich window).
    if (
      r.role === "active_wip" ||
      r.role === "active_upcoming" ||
      r.role === "overdue_active" ||
      r.role === "blocked_parts" ||
      r.role === "done_this_week"
    ) {
      buildReportsForJob(b, bj.job, small ? rng.int(3, 5) : rng.int(5, 9), 1, 3);
      b.act("daily_report", bj.job.id, "submitted", bj.job.name, 1);
    } else if (r.role === "done_recent_paid") {
      buildReportsForJob(b, bj.job, rng.int(3, 5), 22, 4);
    }

    // Invoices + payments.
    if (r.invoice !== "none") {
      const invLines = r.fromQuote
        ? quoteLinesFor(rng.int(1, 3))
        : serviceLines(b, "inv", workTitles, band, rng.int(1, 2));
      if (r.invoice === "overdue") {
        // Issued at completion, Net 30 → genuinely overdue relative to as-of.
        const inv = buildInvoice(
          b,
          `${bj.job.id}`,
          bj.job,
          bj.job.customerId,
          null,
          invLines,
          overdueCompletedAgo,
          30,
        );
        b.act("invoice", inv.id, "issued", inv.reference, 9);
      } else {
        const inv = buildInvoice(
          b,
          `${bj.job.id}`,
          bj.job,
          bj.job.customerId,
          null,
          invLines,
          r.role === "done_recent_paid" ? 20 : 10,
          30,
        );
        b.act(
          "invoice",
          inv.id,
          "issued",
          inv.reference,
          Math.min(r.role === "done_recent_paid" ? 20 : 10, 9),
        );
        if (r.invoice === "paid") {
          payInvoice(b, inv, 1, 12, rng.pick(METHODS));
          b.act("payment", inv.id, "recorded", inv.reference, 8);
        } else if (r.invoice === "partial") {
          payInvoice(b, inv, rng.float(0.4, 0.6, 2), 6, rng.pick(METHODS));
          b.act("payment", inv.id, "recorded", inv.reference, 5);
        }
      }
    }
  });

  // ── 2) Historical jobs (lighter; period-representative revenue) ─────────────
  const olderStart = rich + 20;
  const olderEnd = s.historyMonths * 30;
  const span = Math.max(0, olderEnd - olderStart);
  const histCount = Math.min(30, Math.floor(span / 40));
  for (let h = 0; h < histCount; h++) {
    const startAgo = olderStart + Math.floor((span * h) / Math.max(1, histCount)) + rng.int(0, 15);
    const completedAgo = Math.max(rich + 5, startAgo - rng.int(10, 25));
    const bj = buildJob(b, nextIdx(), "historical_done", {
      startAgo,
      dueAgo: startAgo - 20,
      completedAgo,
      progress: 1,
      statusCategory: "done",
      customerIdx: h,
      sellPriceMajor: rng.int(band[0], band[1]),
    });
    const invLines = quoteLinesFor(rng.int(1, 2));
    const inv = buildInvoice(
      b,
      `${bj.job.id}`,
      bj.job,
      bj.job.customerId,
      null,
      invLines,
      completedAgo,
      30,
    );
    // Most historical invoices are settled; a few remain partly paid for realism.
    if (rng.chance(0.85))
      payInvoice(b, inv, 1, Math.max(1, completedAgo - rng.int(5, 20)), rng.pick(METHODS));
    else
      payInvoice(b, inv, rng.float(0.5, 0.8, 2), Math.max(1, completedAgo - 10), rng.pick(METHODS));
  }

  // ── 3) Standalone quotes in various lifecycle states ───────────────────────
  const standalone: Array<{
    st: QuoteRow["status"];
    ago: number;
    validAhead?: number;
    reason?: string;
  }> = [
    { st: "sent", ago: 5, validAhead: 20 }, // customer request awaiting a decision + healthy opportunity
    { st: "pending_approval", ago: 2 }, // quotes-awaiting (internal)
    { st: "draft", ago: 1 },
    {
      st: "rejected",
      ago: 26,
      reason: s.locale === "ar" ? "اختار العميل مورّداً آخر" : "Customer chose another vendor",
    },
  ];
  if (s.key === "auto_workshop") standalone.push({ st: "expired", ago: 50, validAhead: -10 });
  standalone.forEach((sq, i) => {
    const q = buildQuote(
      b,
      `standalone:${i}`,
      sq.st,
      b.plan.customers[i % nCust]!.id,
      rng.pick(s.presets).code,
      quoteLinesFor(rng.int(2, 4)),
      sq.ago,
      { validAheadDays: sq.validAhead, rejectReason: sq.reason },
    );
    if (sq.st === "sent") b.act("quote", q.id, "sent", q.reference, sq.ago);
  });

  // ── 4) Procurement: material request → PO → goods receipt, + the parts blocker
  buildProcurement(
    b,
    byRole.get("blocked_parts") ?? built[0]!,
    byRole.get("active_wip") ?? built[0]!,
  );

  // ── 5) Expenses (job costs + overhead; some unpaid) ────────────────────────
  buildExpenses(b, built);

  // ── 6) Issues (one current blocker + resolved history) ─────────────────────
  buildIssues(b, byRole);

  // ── 7) Approvals (rule + one aged pending + approved history) ──────────────
  buildApprovals(b);

  // ── 8) A credit note correcting one settled invoice (return/cancellation) ──
  buildCreditNote(b);

  // ── 9) A couple of manual attendance exceptions in the recent window ───────
  buildManualAttendance(b);

  // ── 10) At-risk exceptions that drive the owner dashboard attention zone ───
  buildExceptions(b, byRole);

  b.finalizeSequences();
  return b.plan;
}

// ── Sub-builders that need the full masters/jobs context ──────────────────────

function buildProcurement(b: Builder, blocked: BuiltJob, wip: BuiltJob): void {
  const { s, clock, rng } = b;
  const supForParts = b.plan.suppliers[0]!;
  const partItems = b.plan.items.slice(0, 3);

  // (a) A received PO feeding a completed/active job's costing.
  const poRecvLines = partItems.map((it, i) => ({
    id: b.id(`po:recv:line:${i}`),
    itemId: it.id,
    itemName: it.name,
    qty: rng.int(4, 20),
    unit: it.unit,
    unitCostMinor: it.unitCostMinor ?? toMinor(20, s.currency),
    lineTotalMinor: 0,
    sort: i,
  }));
  const t1 = poTotals(
    poRecvLines.map((l) => ({ qty: l.qty, unitCostMinor: l.unitCostMinor })),
    0,
  );
  poRecvLines.forEach((l, i) => (l.lineTotalMinor = t1.lineTotals[i]!));
  const vat1 = s.vatRegistered ? Math.round(t1.subtotalMinor * 0.05) : 0;
  const poRecv = {
    id: b.id("po:recv"),
    reference: b.ref("PO", "purchase_order"),
    supplierId: b.plan.suppliers[Math.min(1, b.plan.suppliers.length - 1)]!.id,
    jobId: wip.job.id,
    mrId: null,
    status: "received" as const,
    vatMinor: vat1,
    totalMinor: t1.subtotalMinor + vat1,
    approvedAt: clock.tsAgo(20, 10),
    createdAt: clock.tsAgo(22, 9),
    lines: poRecvLines,
  };
  b.plan.purchaseOrders.push(poRecv);
  b.plan.goodsReceipts.push({
    id: b.id("grn:recv"),
    reference: b.ref("GRN", "goods_receipt"),
    poId: poRecv.id,
    jobId: wip.job.id,
    status: "recorded",
    receivedDate: clock.dayAgo(16),
    createdAt: clock.tsAgo(16, 11),
    lines: poRecvLines.map((l, i) => ({
      poLineId: l.id,
      orderedQty: l.qty,
      previouslyReceived: 0,
      receivedQty: l.qty,
      damagedQty: 0,
      rejectedQty: 0,
      sort: i,
    })),
  });
  b.act("purchase_order", poRecv.id, "approved", poRecv.reference, 20);

  // (b) The parts blocker: an approved MR converted to a PO still awaiting delivery.
  const mrLines = partItems.slice(0, 2).map((it, i) => ({
    itemId: it.id,
    itemName: it.name,
    qty: rng.int(2, 6),
    unit: it.unit,
    estUnitCostMinor: it.unitCostMinor,
    sort: i,
  }));
  const mrTotal = mrLines.reduce((n, l) => n + Math.round(l.qty * (l.estUnitCostMinor ?? 0)), 0);
  const mr = {
    id: b.id("mr:blocker"),
    reference: b.ref("MR", "material_request"),
    jobId: blocked.job.id,
    status: "converted" as const,
    urgency: "high" as const,
    requiredDate: clock.dayAgo(2),
    totalMinor: mrTotal,
    convertedPoId: b.id("po:blocker"),
    createdAt: clock.tsAgo(9, 9),
    lines: mrLines,
  };
  b.plan.materialRequests.push(mr);
  const poBlkLines = partItems.slice(0, 2).map((it, i) => ({
    id: b.id(`po:blocker:line:${i}`),
    itemId: it.id,
    itemName: it.name,
    qty: mrLines[i]!.qty,
    unit: it.unit,
    unitCostMinor: it.unitCostMinor ?? toMinor(20, s.currency),
    lineTotalMinor: 0,
    sort: i,
  }));
  const t2 = poTotals(
    poBlkLines.map((l) => ({ qty: l.qty, unitCostMinor: l.unitCostMinor })),
    0,
  );
  poBlkLines.forEach((l, i) => (l.lineTotalMinor = t2.lineTotals[i]!));
  const vat2 = s.vatRegistered ? Math.round(t2.subtotalMinor * 0.05) : 0;
  b.plan.purchaseOrders.push({
    id: b.id("po:blocker"),
    reference: b.ref("PO", "purchase_order"),
    supplierId: supForParts.id,
    jobId: blocked.job.id,
    mrId: mr.id,
    status: "sent",
    vatMinor: vat2,
    totalMinor: t2.subtotalMinor + vat2,
    approvedAt: clock.tsAgo(6, 10),
    createdAt: clock.tsAgo(7, 9),
    lines: poBlkLines,
  });
}

function buildExpenses(b: Builder, built: BuiltJob[]): void {
  const { s, clock, rng } = b;
  const overhead: Array<{ cat: string; map: "overhead"; desc: [string, string] }> = [
    {
      cat: "rent_facility",
      map: "overhead",
      desc: ["Monthly rent & utilities", "إيجار ومرافق شهرية"],
    },
    { cat: "fuel", map: "overhead", desc: ["Vehicle fuel", "وقود المركبات"] },
    { cat: "tools_equipment", map: "overhead", desc: ["Tools & equipment", "عدد ومعدات"] },
  ];
  const months = Math.min(s.historyMonths, 8);
  for (let m = 0; m < months; m++) {
    const daysAgo = m === 0 ? 6 : m * 30 + rng.int(0, 8);
    const o = overhead[m % overhead.length]!;
    const amount = toMinor(rng.int(1500, 9000), s.currency);
    const vat = s.vatRegistered ? Math.round(amount * 0.05) : 0;
    b.plan.expenses.push({
      id: b.id(`expense:oh:${m}`),
      reference: b.ref("EXP", "expense"),
      jobId: null,
      jobName: null,
      categoryKey: o.cat,
      costingMapping: "overhead",
      description: s.locale === "ar" ? o.desc[1] : o.desc[0],
      expenseDate: clock.dayAgo(daysAgo),
      amountMinor: amount,
      vatAmountMinor: vat,
      totalMinor: amount + vat,
      paymentStatus: m < 2 ? "unpaid" : "paid", // a couple recent unpaid → dashboard tile
      createdAt: clock.tsAgo(daysAgo, 14),
    });
  }
  // Job-linked material costs on a few recent jobs (feed costing).
  built
    .filter(
      (bj) =>
        bj.role === "active_wip" || bj.role === "done_recent_paid" || bj.role === "blocked_parts",
    )
    .forEach((bj, i) => {
      const amount = toMinor(rng.int(300, 2500), s.currency);
      const vat = s.vatRegistered ? Math.round(amount * 0.05) : 0;
      b.plan.expenses.push({
        id: b.id(`expense:job:${i}`),
        reference: b.ref("EXP", "expense"),
        jobId: bj.job.id,
        jobName: bj.job.name,
        categoryKey: "materials",
        costingMapping: "job_materials",
        description: s.locale === "ar" ? `مواد لـ ${bj.job.name}` : `Materials for ${bj.job.name}`,
        expenseDate: clock.dayAgo(rng.int(3, 18)),
        amountMinor: amount,
        vatAmountMinor: vat,
        totalMinor: amount + vat,
        paymentStatus: "paid",
        createdAt: clock.tsAgo(rng.int(3, 18), 15),
      });
    });
}

function buildIssues(b: Builder, byRole: Map<JobRole, BuiltJob>): void {
  const { s, clock } = b;
  const blocked = byRole.get("blocked_parts") ?? byRole.get("active_wip");
  const overdue = byRole.get("overdue_active");
  const currentTitle: Record<string, [string, string]> = {
    coffee_catering: [
      "Espresso machine fault at event venue",
      "عطل مكينة إسبريسو في موقع الفعالية",
    ],
    shortstay_ops: [
      "Urgent: water leak at Marina Heights villa",
      "عاجل: تسرب مياه في فيلا مارينا هايتس",
    ],
    auto_workshop: [
      "Waiting for brake parts — vehicle on lift",
      "بانتظار قطع الفرامل — المركبة على الرافعة",
    ],
    home_cupcakes: ["Rush order — fondant colour needs redo", "طلب عاجل — إعادة لون الفوندان"],
    palm_farm: ["Irrigation pump failure on north block", "تعطل مضخة الري في القطعة الشمالية"],
  };
  const t = currentTitle[s.key] ?? ["Current operational blocker", "معوق تشغيلي حالي"];
  b.plan.issues.push({
    id: b.id("issue:current"),
    jobId: blocked?.job.id ?? null,
    title: s.locale === "ar" ? t[1] : t[0],
    description: null,
    severity: s.key === "shortstay_ops" || s.key === "palm_farm" ? "critical" : "high",
    isBlocker: true,
    status: "open",
    resolvedAt: null,
    createdAt: clock.tsAgo(2, 9),
  });
  b.act("issue", b.id("issue:current"), "raised", s.locale === "ar" ? t[1] : t[0], 2);
  // A second, in-progress issue on the overdue job.
  if (overdue) {
    b.plan.issues.push({
      id: b.id("issue:secondary"),
      jobId: overdue.job.id,
      title: s.locale === "ar" ? "تأخر بانتظار موافقة العميل" : "Delay pending customer approval",
      description: null,
      severity: "medium",
      isBlocker: false,
      status: "in_progress",
      resolvedAt: null,
      createdAt: clock.tsAgo(6, 10),
    });
  }
  // Resolved history.
  for (let i = 0; i < 2; i++) {
    b.plan.issues.push({
      id: b.id(`issue:resolved:${i}`),
      jobId: null,
      title: s.locale === "ar" ? "مشكلة سابقة تم حلها" : "Past issue (resolved)",
      description: null,
      severity: "low",
      isBlocker: false,
      status: "resolved",
      resolvedAt: clock.tsAgo(20 + i * 15, 12),
      createdAt: clock.tsAgo(25 + i * 15, 9),
    });
  }
}

function buildApprovals(b: Builder): void {
  const { s, clock } = b;
  // A rule: purchase orders always route to the owner for approval.
  b.plan.approvalRules.push({
    id: b.id("rule:po"),
    subjectType: "purchase_order",
    conditionKind: "always",
    amountGteMinor: null,
    urgencyIn: null,
    assignedRole: "owner",
    autoApproveBelowMinor: null,
  });
  // One aged PENDING approval (the "aged approval" / "purchasing approval" state).
  const pendingPo =
    b.plan.purchaseOrders.find((p) => p.status === "sent") ?? b.plan.purchaseOrders[0];
  if (pendingPo) {
    b.plan.approvals.push({
      id: b.id("approval:pending"),
      subjectType: "purchase_order",
      subjectId: pendingPo.id,
      subjectSummary: { title: pendingPo.reference, amountMinor: pendingPo.totalMinor },
      assignedRole: "owner",
      state: "pending",
      decidedAt: null,
      decisionNote: null,
      selfApproved: false,
      createdAt: clock.tsAgo(3, 9),
    });
    b.act("approval", b.id("approval:pending"), "requested", pendingPo.reference, 3);
  }
  // Approved history.
  const approvedPo = b.plan.purchaseOrders.find((p) => p.status === "received");
  if (approvedPo) {
    b.plan.approvals.push({
      id: b.id("approval:approved"),
      subjectType: "purchase_order",
      subjectId: approvedPo.id,
      subjectSummary: { title: approvedPo.reference, amountMinor: approvedPo.totalMinor },
      assignedRole: "owner",
      state: "approved",
      decidedAt: clock.tsAgo(20, 10),
      decisionNote: s.locale === "ar" ? "معتمد" : "Approved",
      selfApproved: true,
      createdAt: clock.tsAgo(21, 9),
    });
  }
}

function buildCreditNote(b: Builder): void {
  const { s, clock, rng } = b;
  // A historical cancellation: an invoice was issued, then the order was cancelled
  // and fully credited (a credit note copies the invoice's full value). We create a
  // DEDICATED unpaid invoice for this so no already-paid invoice is over-credited.
  const cust = b.plan.customers[Math.min(2, b.plan.customers.length - 1)]!;
  const priceMajor = s.key === "home_cupcakes" ? rng.int(300, 900) : rng.int(1500, 8000);
  const lines = [
    {
      description: s.locale === "ar" ? "طلب مُلغى" : "Cancelled order",
      qty: 1,
      unit: s.locale === "ar" ? "خدمة" : "service",
      unitPriceMinor: toMinor(priceMajor, s.currency),
      vatRate: vatRate(s),
    },
  ];
  const target = buildInvoice(b, "cancelled", null, cust.id, null, lines, 45, 30);
  target.status = "paid"; // fully credited below → balance 0
  b.plan.invoices.push({
    id: b.id("creditnote:1"),
    reference: b.ref("CN", "credit_note"),
    kind: "credit_note",
    correctsInvoiceId: target.id,
    customerId: target.customerId,
    customerName: target.customerName,
    customerTaxRegNo: null,
    jobId: target.jobId,
    quoteId: null,
    status: "issued",
    isExport: false,
    currency: s.currency,
    exchangeRate: 1,
    subtotalMinor: target.subtotalMinor,
    vatAmountMinor: target.vatAmountMinor,
    totalMinor: target.totalMinor,
    baseTotalMinor: target.baseTotalMinor,
    issuedAt: clock.tsAgo(4, 12),
    dueDate: null,
    cancelledAt: null,
    cancelReason: null,
    notes:
      s.locale === "ar" ? "إشعار دائن لتصحيح فاتورة" : "Credit note correcting an earlier invoice",
    createdAt: clock.tsAgo(4, 12),
    lines: target.lines.map((l, i) => ({ ...l, id: b.id(`creditnote:1:line:${i}`) })),
  });
}

function buildManualAttendance(b: Builder): void {
  const { clock } = b;
  const emps = b.plan.employees;
  if (emps.length < 2) return;
  const marks: Array<{ e: number; d: number; st: "leave" | "sick" }> = [
    { e: 1, d: 3, st: "sick" },
    { e: Math.min(2, emps.length - 1), d: 5, st: "leave" },
  ];
  for (const m of marks) {
    const date = clock.dayAgo(m.d);
    const emp = emps[m.e]!;
    // Manual wins: replace any derived row for that (emp,date).
    b.plan.attendance = b.plan.attendance.filter(
      (a) => !(a.employeeId === emp.id && a.date === date),
    );
    b.plan.attendance.push({
      id: b.id(`att:manual:${emp.id}:${date}`),
      employeeId: emp.id,
      date,
      status: m.st,
      source: "manual",
      note: m.st === "sick" ? "Sick leave" : "Annual leave",
    });
  }
}

function buildExceptions(b: Builder, byRole: Map<JobRole, BuiltJob>): void {
  const { clock } = b;
  const overdue = byRole.get("overdue_active");
  if (overdue) {
    b.plan.exceptions.push({
      id: b.id("exc:overdue_stage"),
      ruleKey: "overdue_stage",
      severity: "critical",
      audienceRoles: ["owner", "admin", "manager"],
      dedupKey: `overdue_stage:${overdue.job.id}`,
      subjectType: "job",
      subjectId: overdue.job.id,
      title: overdue.job.reference,
      createdAt: clock.tsAgo(3, 8),
    });
  }
  const upcoming = byRole.get("active_upcoming");
  if (upcoming) {
    b.plan.exceptions.push({
      id: b.id("exc:missing_report"),
      ruleKey: "missing_report",
      severity: "warning",
      audienceRoles: ["owner", "admin", "manager"],
      dedupKey: `missing_report:${upcoming.job.id}`,
      subjectType: "job",
      subjectId: upcoming.job.id,
      title: upcoming.job.reference,
      createdAt: clock.tsAgo(1, 8),
    });
  }
}
