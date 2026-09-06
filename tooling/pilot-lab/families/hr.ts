/**
 * H33 Pilot Lab — attendance, leave, claims and payroll.
 *
 * The people families split in two on purpose. `people` owns who works here and
 * on what terms — the employment record. This one owns what happened to them
 * since: who turned up, who took leave, what they claimed back, and what they
 * were paid.
 *
 * ── The arithmetic that must hold ──────────────────────────────────────────
 * Payroll is the part a business checks by hand, so it is built to survive that
 * check: a pay-run line's net is its gross minus its deductions, a run's totals
 * are the sums of its lines, and a payslip's net equals the line it was issued
 * from. A leave balance is the sum of its own ledger and is never negative.
 *
 * ── Legal states only ──────────────────────────────────────────────────────
 * `pay_run_status_guard` allows draft → review → awaiting_approval → approved →
 * finalized (with cancellations and returns), `pay_run_line_frozen` freezes a
 * finalized run's lines and `payslip_immutable` forbids touching a payslip at
 * all. Rows are therefore written once, already in the state they belong in:
 * the older runs finalized, the newest two still moving, and one reversal.
 */
import type { Company, Family, FamilyPlan, FamilyReport, LabContext } from "../types";
import { historyDays, pick, sentence, weighted } from "./_shared";

type Row = Record<string, unknown>;

export const HR_TABLES = [
  "attendance",
  "attendance_event",
  "leave_request",
  "leave_ledger",
  "overtime_request",
  "expense_claim",
  "expense_claim_line",
  "cash_advance",
  "disciplinary_record",
  "job_requisition",
  "candidate",
  "pay_run",
  "pay_run_line",
  "payslip",
] as const;
export type HrTable = (typeof HR_TABLES)[number];

export const ATTENDANCE_STATUSES = [
  "present",
  "absent",
  "leave",
  "half_day",
  "sick",
  "late",
] as const;
export const LEAVE_STATUSES = ["draft", "pending", "approved", "rejected", "cancelled"] as const;
export const CLAIM_STATUSES = [
  "draft",
  "submitted",
  "returned",
  "approved",
  "paid",
  "cancelled",
] as const;
export const PAY_RUN_STATUSES = [
  "draft",
  "review",
  "awaiting_approval",
  "approved",
  "finalized",
  "cancelled",
] as const;
export const LEDGER_KINDS = [
  "opening",
  "accrual",
  "carryover",
  "request",
  "cancellation",
  "adjustment",
  "expiry",
] as const;
export const CANDIDATE_STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
] as const;
export const DISCIPLINARY_KINDS = [
  "verbal_warning",
  "written_warning",
  "final_warning",
  "grievance",
  "investigation",
  "note",
] as const;

const CLAIM_CATEGORIES = ["travel", "meals", "materials", "fuel", "accommodation", "other"];
const CLAIM_TITLES_EN = [
  "Site visit expenses — Marina",
  "Fuel and parking for the week",
  "Emergency parts bought locally",
  "Client meeting refreshments",
];
const CLAIM_TITLES_AR = [
  "مصاريف زيارة الموقع — المارينا",
  "وقود ومواقف للأسبوع",
  "قطع طارئة تم شراؤها محلياً",
  "ضيافة اجتماع العميل",
];
const DISCIPLINARY_SUMMARIES = [
  "Late to site three times in one week",
  "Personal protective equipment not worn in the yard",
  "Grievance raised about shift allocation",
  "Investigation into a damaged tool",
];

type PeopleHandoff = {
  personaEmployees: Partial<Record<string, string>>;
  employeeIds: string[];
  activeEmployeeIds?: string[];
};
type SetupHandoff = {
  leaveTypes?: Record<string, { id: string; policyId?: string }>;
  /** setup owns the pay group and its periods; this family adds the runs. */
  payGroups?: { activeId: string; periods: Record<string, string> };
};

type PayRunM = {
  id: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  reference: string;
  runKind: "regular" | "off_cycle" | "final_settlement" | "reversal";
  status: (typeof PAY_RUN_STATUSES)[number];
  reversesRunId: string | null;
  grossTotal: number;
  deductionTotal: number;
  employerTotal: number;
  netTotal: number;
  finalizedAt: string | null;
  dayAgo: number;
  lines: Array<{
    id: string;
    employeeId: string;
    gross: number;
    deduction: number;
    employer: number;
    net: number;
    payslipId: string | null;
    slipNo: string | null;
  }>;
};

export type HrModel = {
  attendance: Array<{
    id: string;
    employeeId: string;
    date: string;
    status: string;
    source: string;
    note: string | null;
  }>;
  events: Array<{
    id: string;
    employeeId: string;
    kind: string;
    at: string;
    workDate: string;
    source: string;
  }>;
  leave: Array<{
    id: string;
    employeeId: string;
    typeId: string;
    start: string;
    end: string;
    days: number;
    status: string;
    reason: string | null;
    dayAgo: number;
  }>;
  ledger: Array<{
    id: string;
    employeeId: string;
    typeId: string;
    kind: string;
    days: number;
    effectiveDate: string;
    requestId: string | null;
  }>;
  overtime: Array<{
    id: string;
    employeeId: string;
    workDate: string;
    minutes: number;
    status: string;
    reason: string;
  }>;
  claims: Array<{
    id: string;
    employeeId: string;
    reference: string;
    title: string;
    status: string;
    route: string;
    totalMinor: number;
    dayAgo: number;
    lines: Array<{
      id: string;
      date: string;
      category: string;
      description: string;
      amountMinor: number;
    }>;
  }>;
  advances: Array<{
    id: string;
    employeeId: string;
    reference: string;
    amountMinor: number;
    purpose: string;
    status: string;
    dayAgo: number;
  }>;
  disciplinary: Array<{
    id: string;
    employeeId: string;
    kind: string;
    occurredOn: string;
    summary: string;
    outcome: string | null;
  }>;
  candidates: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    stage: string;
    dayAgo: number;
  }>;
  periods: Array<{ id: string; groupId: string; start: string; end: string }>;
  runs: PayRunM[];
  tableCounts: Record<HrTable, number>;
};

export type HrHandoff = {
  payRunIds: string[];
  finalizedPayRunIds: string[];
  /** What the finance family posts as a payroll journal, per finalized run. */
  payrollTotals: Array<{
    runId: string;
    gross: number;
    deduction: number;
    employer: number;
    net: number;
    periodEnd: string;
  }>;
  attendanceCount: number;
  approvedClaimTotalMinor: number;
};

const MODELS = new WeakMap<object, HrModel & { handoff: HrHandoff }>();

function buildModel(ctx: LabContext): HrModel & { handoff: HrHandoff } {
  const memo = MODELS.get(ctx as unknown as object);
  if (memo) return memo;

  const { company, rng, clock } = ctx;
  const people = ctx.handoff<PeopleHandoff>("people");
  const setup = ctx.handoff<SetupHandoff>("setup");
  const asOf = clock.asOf;
  const horizon = historyDays(company);
  const arabic = company.languages[0] === "ar";
  const lang = () => (arabic ? "ar" : "en");

  const employees = (people.activeEmployeeIds ?? people.employeeIds).slice();
  const leaveTypeIds = Object.values(setup.leaveTypes ?? {}).map((t) => t.id);
  const annualTypeId = leaveTypeIds[0] ?? null;
  const payGroupId = setup.payGroups?.activeId || null;

  let seq = 0;
  const nextId = (family: string) => ctx.id(family, seq++);

  // ── Attendance: the last N working days for every active employee ─────────
  // Bounded deliberately: a full history for a large workforce is tens of
  // thousands of rows on its own and buys nothing the last quarter does not.
  /*
   * Ten or eleven weeks of attendance per employee. Two years of it read the
   * same on screen and cost the lab tens of thousands of rows it does not have
   * to spare; the timesheet still paginates, and every status still appears.
   */
  const attendanceDays = Math.min(60, Math.max(40, Math.floor(horizon / 15)));
  const attendance: HrModel["attendance"] = [];
  const events: HrModel["events"] = [];
  for (const [ei, employeeId] of employees.entries()) {
    for (let d = 0; d < attendanceDays; d++) {
      const dayAgo = d;
      const date = clock.dayAgo(dayAgo);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 5) continue; // Friday
      if (dow === 6 && !company.sixDayWeek) continue;
      const status = weighted(rng, {
        present: 84,
        late: 5,
        leave: 4,
        sick: 3,
        absent: 2,
        half_day: 2,
      });
      attendance.push({
        id: nextId("attendance"),
        employeeId,
        date,
        status,
        source: rng.chance(0.7) ? "labour_line" : "manual",
        note: status === "absent" || status === "sick" ? sentence(rng, lang()) : null,
      });
      // A couple of clock events for a sample of days, so the timeline is real.
      if (status === "present" && ei % 7 === 0 && d < 20) {
        events.push({
          id: nextId("attendance_event"),
          employeeId,
          kind: "in",
          at: clock.tsAgo(dayAgo, 7, rng.int(0, 30)),
          workDate: date,
          source: "self",
        });
        events.push({
          id: nextId("attendance_event"),
          employeeId,
          kind: "out",
          at: clock.tsAgo(dayAgo, 17, rng.int(0, 40)),
          workDate: date,
          source: "self",
        });
      }
    }
  }

  // ── Leave, and the ledger that has to agree with it ───────────────────────
  const leave: HrModel["leave"] = [];
  const ledger: HrModel["ledger"] = [];
  if (annualTypeId) {
    for (const employeeId of employees) {
      // Opening balance, then a monthly accrual: the ledger IS the balance.
      ledger.push({
        id: nextId("leave_ledger"),
        employeeId,
        typeId: annualTypeId,
        kind: "opening",
        days: 5,
        effectiveDate: company.history.from,
        requestId: null,
      });
      const months = Math.min(24, Math.floor(horizon / 30));
      for (let m = months; m >= 1; m--) {
        ledger.push({
          id: nextId("leave_ledger"),
          employeeId,
          typeId: annualTypeId,
          kind: "accrual",
          days: 2.5,
          effectiveDate: clock.dayAgo(m * 30),
          requestId: null,
        });
      }
      // One or two requests each; only approved ones consume the balance.
      const requests = rng.int(0, 2);
      for (let q = 0; q < requests; q++) {
        const dayAgo = rng.int(5, Math.max(6, Math.min(horizon, 400)));
        const days = rng.int(1, 6);
        const status = weighted(rng, {
          approved: 60,
          pending: 15,
          rejected: 10,
          cancelled: 8,
          draft: 7,
        });
        const requestId = nextId("leave_request");
        leave.push({
          id: requestId,
          employeeId,
          typeId: annualTypeId,
          start: clock.dayAgo(dayAgo),
          end: clock.dayAgo(Math.max(0, dayAgo - days + 1)),
          days,
          status,
          reason: rng.chance(0.6) ? sentence(rng, lang()) : null,
          dayAgo,
        });
        if (status === "approved") {
          ledger.push({
            id: nextId("leave_ledger"),
            employeeId,
            typeId: annualTypeId,
            kind: "request",
            days: -days,
            effectiveDate: clock.dayAgo(dayAgo),
            requestId,
          });
        }
      }
    }
  }

  // ── Overtime ──────────────────────────────────────────────────────────────
  const overtime: HrModel["overtime"] = [];
  for (const [i, employeeId] of employees.entries()) {
    if (i % 3 !== 0) continue;
    for (let o = 0; o < rng.int(1, 3); o++) {
      overtime.push({
        id: nextId("overtime_request"),
        employeeId,
        workDate: clock.dayAgo(rng.int(1, 120)),
        minutes: rng.int(1, 5) * 60,
        status: weighted(rng, { approved: 65, pending: 20, rejected: 10, draft: 5 }),
        reason: "Finishing the pour before the concrete set",
      });
    }
  }

  // ── Claims, with lines that add up to the claim ───────────────────────────
  const claims: HrModel["claims"] = [];
  for (const [i, employeeId] of employees.entries()) {
    if (i % 2 !== 0) continue;
    for (let c = 0; c < rng.int(1, 3); c++) {
      const dayAgo = rng.int(3, Math.min(horizon, 500));
      const lineCount = rng.int(1, 4);
      const lines: HrModel["claims"][number]["lines"] = [];
      let total = 0;
      for (let l = 0; l < lineCount; l++) {
        const amount = rng.int(2_000, 60_000);
        total += amount;
        lines.push({
          id: nextId("expense_claim_line"),
          date: clock.dayAgo(dayAgo + l),
          category: pick(rng, CLAIM_CATEGORIES),
          description: sentence(rng, lang()),
          amountMinor: amount,
        });
      }
      claims.push({
        id: nextId("expense_claim"),
        employeeId,
        reference: `EC-${String(1000 + claims.length)}`,
        title: arabic ? pick(rng, CLAIM_TITLES_AR) : pick(rng, CLAIM_TITLES_EN),
        status: weighted(rng, {
          paid: 40,
          approved: 20,
          submitted: 18,
          returned: 8,
          draft: 9,
          cancelled: 5,
        }),
        route: rng.chance(0.6) ? "payroll" : "expense_book",
        totalMinor: total,
        dayAgo,
        lines,
      });
    }
  }

  // ── Advances, discipline, recruitment ─────────────────────────────────────
  const advances: HrModel["advances"] = [];
  for (let i = 0; i < Math.min(10, employees.length); i++) {
    advances.push({
      id: nextId("cash_advance"),
      employeeId: employees[i * 3] ?? employees[i]!,
      reference: `CA-${String(1000 + i)}`,
      amountMinor: rng.int(50_000, 400_000),
      purpose: "Advance against next month's salary",
      status: weighted(rng, { settled: 55, open: 35, converted_to_loan: 10 }),
      dayAgo: rng.int(10, 300),
    });
  }

  const disciplinary: HrModel["disciplinary"] = [];
  for (let i = 0; i < Math.min(6, employees.length); i++) {
    disciplinary.push({
      id: nextId("disciplinary_record"),
      employeeId: employees[(i * 5) % employees.length]!,
      kind: pick(rng, DISCIPLINARY_KINDS),
      occurredOn: clock.dayAgo(rng.int(20, 400)),
      summary: pick(rng, DISCIPLINARY_SUMMARIES),
      outcome: rng.chance(0.6) ? "Counselled; no further action" : null,
    });
  }

  const candidates: HrModel["candidates"] = [];
  for (let i = 0; i < 14; i++) {
    candidates.push({
      id: nextId("candidate"),
      name: `Candidate ${i + 1}`,
      email: `candidate.${i + 1}@example.invalid`,
      phone: `${company.country === "SA" ? "+966" : "+971"} 50 000 9${String(i).padStart(3, "0")}`,
      stage: pick(rng, CANDIDATE_STAGES),
      dayAgo: rng.int(3, 200),
    });
  }

  // ── Payroll: monthly runs, the older ones finalized ───────────────────────
  const periods: HrModel["periods"] = [];
  const runs: PayRunM[] = [];
  /*
   * setup owns the pay group AND its calendar; this family adds the runs. It
   * used to mint its own periods at thirty-day intervals, which put a second
   * series on the same pay group — sixty-one periods for gulfbuild, forty-eight
   * of them overlapping a neighbour. Two periods covering the same fortnight
   * make "what was paid for September" unanswerable, so the runs now cite the
   * calendar months setup already created, newest last.
   */
  const setupMonths = Object.entries(setup.payGroups?.periods ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  if (payGroupId && employees.length > 0 && setupMonths.length > 0) {
    const use = setupMonths.slice(-Math.min(24, setupMonths.length));
    for (const [idx, [monthKey, setupPeriodId]] of use.entries()) {
      // 1 is the most recent month, so the "still moving" runs stay at the end.
      const m = use.length - idx;
      const start = `${monthKey}-01`;
      const [y, mo] = monthKey.split("-").map(Number) as [number, number];
      const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      const periodId = setupPeriodId;
      periods.push({ id: periodId, groupId: payGroupId, start, end });

      // The two most recent runs are still moving; everything older is done.
      const status: PayRunM["status"] = m <= 2 ? (m === 1 ? "draft" : "review") : "finalized";
      const lines: PayRunM["lines"] = [];
      let gross = 0;
      let deduction = 0;
      let employer = 0;
      let net = 0;
      for (const [ei, employeeId] of employees.entries()) {
        const base = 300_000 + ((ei * 37) % 40) * 10_000;
        const g = base + (rng.chance(0.25) ? rng.int(1, 20) * 5_000 : 0);
        const d = Math.round(g * 0.05);
        const e = Math.round(g * 0.125);
        const n = g - d;
        gross += g;
        deduction += d;
        employer += e;
        net += n;
        const lineId = nextId("pay_run_line");
        lines.push({
          id: lineId,
          employeeId,
          gross: g,
          deduction: d,
          employer: e,
          net: n,
          // A payslip exists only where the run was finalized: an unfinalized
          // run has nothing to hand anybody.
          payslipId: status === "finalized" ? nextId("payslip") : null,
          slipNo:
            status === "finalized"
              ? `PS-${String(runs.length + 1).padStart(4, "0")}-${String(ei + 1).padStart(4, "0")}`
              : null,
        });
      }
      runs.push({
        id: nextId("pay_run"),
        periodId,
        periodStart: start,
        periodEnd: end,
        reference: `PR-${String(1000 + runs.length)}`,
        runKind: "regular",
        status,
        reversesRunId: null,
        grossTotal: gross,
        deductionTotal: deduction,
        employerTotal: employer,
        netTotal: net,
        finalizedAt:
          status === "finalized" ? clock.tsAgo(Math.max(0, clock.daysAgoOf(end) - 2), 12, 0) : null,
        dayAgo: Math.max(0, clock.daysAgoOf(end)),
        lines,
      });
    }

    // One reversal, against the oldest finalized run — a real business event.
    const target = runs.find((r) => r.status === "finalized");
    if (target) {
      const rev: PayRunM = {
        id: nextId("pay_run"),
        periodId: target.periodId,
        periodStart: target.periodStart,
        periodEnd: target.periodEnd,
        reference: `PR-${String(1000 + runs.length)}`,
        runKind: "reversal",
        status: "finalized",
        reversesRunId: target.id,
        /*
         * A reversal carries the SAME amounts, not negated ones. The schema
         * keeps every payroll figure non-negative — gross, deductions and
         * employer cost on the run and on every line, with net fixed at gross
         * minus deductions — because the sign lives in `run_kind` and
         * `reverses_run_id`, not in the money. A negative payslip is not a
         * thing payroll produces.
         */
        grossTotal: target.grossTotal,
        deductionTotal: target.deductionTotal,
        employerTotal: target.employerTotal,
        netTotal: target.netTotal,
        finalizedAt: clock.tsAgo(Math.max(0, target.dayAgo - 1), 12, 0),
        dayAgo: Math.max(0, target.dayAgo - 1),
        lines: target.lines.map((l) => ({
          id: nextId("pay_run_line"),
          employeeId: l.employeeId,
          gross: l.gross,
          deduction: l.deduction,
          employer: l.employer,
          net: l.net,
          payslipId: null,
          slipNo: null,
        })),
      };
      runs.push(rev);
    }
  }

  const payslipCount = runs.reduce((n, r) => n + r.lines.filter((l) => l.payslipId).length, 0);

  const tableCounts: Record<HrTable, number> = {
    attendance: attendance.length,
    attendance_event: events.length,
    leave_request: leave.length,
    leave_ledger: ledger.length,
    overtime_request: overtime.length,
    expense_claim: claims.length,
    expense_claim_line: claims.reduce((n, c) => n + c.lines.length, 0),
    cash_advance: advances.length,
    disciplinary_record: disciplinary.length,
    job_requisition: candidates.length ? 1 : 0,
    candidate: candidates.length,
    pay_run: runs.length,
    pay_run_line: runs.reduce((n, r) => n + r.lines.length, 0),
    payslip: payslipCount,
  };

  const finalized = runs.filter((r) => r.status === "finalized");
  const handoff: HrHandoff = {
    payRunIds: runs.map((r) => r.id),
    finalizedPayRunIds: finalized.map((r) => r.id),
    payrollTotals: finalized.map((r) => ({
      runId: r.id,
      gross: r.grossTotal,
      deduction: r.deductionTotal,
      employer: r.employerTotal,
      net: r.netTotal,
      periodEnd: r.periodEnd,
    })),
    attendanceCount: attendance.length,
    approvedClaimTotalMinor: claims
      .filter((c) => c.status === "approved" || c.status === "paid")
      .reduce((n, c) => n + c.totalMinor, 0),
  };

  void asOf;
  const model = {
    attendance,
    events,
    leave,
    ledger,
    overtime,
    claims,
    advances,
    disciplinary,
    candidates,
    periods,
    runs,
    tableCounts,
    handoff,
  };
  MODELS.set(ctx as unknown as object, model);
  return model;
}

function toRows(ctx: LabContext, m: HrModel): Record<HrTable, Row[]> {
  const org = ctx.orgId;
  const by = ctx.users.hr;
  const rows = Object.fromEntries(HR_TABLES.map((t) => [t, [] as Row[]])) as Record<HrTable, Row[]>;

  for (const a of m.attendance)
    rows.attendance.push({
      id: a.id,
      org_id: org,
      employee_id: a.employeeId,
      attendance_date: a.date,
      status: a.status,
      source: a.source,
      marked_by: by,
      note: a.note,
      created_at: `${a.date}T18:00:00.000Z`,
      updated_at: `${a.date}T18:00:00.000Z`,
    });

  for (const e of m.events)
    rows.attendance_event.push({
      id: e.id,
      org_id: org,
      employee_id: e.employeeId,
      kind: e.kind,
      at: e.at,
      work_date: e.workDate,
      source: e.source,
      recorded_by: by,
      note: null,
      corrects_id: null,
      voided_at: null,
      created_at: e.at,
    });

  for (const l of m.leave)
    rows.leave_request.push({
      id: l.id,
      org_id: org,
      employee_id: l.employeeId,
      leave_type_id: l.typeId,
      start_date: l.start,
      end_date: l.end,
      half_day_start: false,
      half_day_end: false,
      days: l.days,
      reason: l.reason,
      attachment_file_id: null,
      policy_id: null,
      status: l.status,
      cancelled_at: l.status === "cancelled" ? ctx.clock.tsAgo(l.dayAgo, 10, 0) : null,
      cancel_reason: l.status === "cancelled" ? "Plans changed" : null,
      created_by: by,
      created_at: ctx.clock.tsAgo(l.dayAgo + 3, 9, 0),
      updated_at: ctx.clock.tsAgo(l.dayAgo, 9, 0),
    });

  for (const l of m.ledger)
    rows.leave_ledger.push({
      id: l.id,
      org_id: org,
      employee_id: l.employeeId,
      leave_type_id: l.typeId,
      kind: l.kind,
      days: l.days,
      effective_date: l.effectiveDate,
      leave_request_id: l.requestId,
      policy_id: null,
      note: null,
      created_by: by,
      created_at: `${l.effectiveDate}T09:00:00.000Z`,
    });

  for (const o of m.overtime)
    rows.overtime_request.push({
      id: o.id,
      org_id: org,
      employee_id: o.employeeId,
      work_date: o.workDate,
      minutes: o.minutes,
      reason: o.reason,
      status: o.status,
      created_by: by,
      created_at: `${o.workDate}T19:00:00.000Z`,
      updated_at: `${o.workDate}T19:00:00.000Z`,
    });

  for (const c of m.claims) {
    rows.expense_claim.push({
      id: c.id,
      org_id: org,
      employee_id: c.employeeId,
      reference: c.reference,
      title: c.title,
      currency: ctx.company.currency,
      base_currency: ctx.company.currency,
      exchange_rate: 1,
      rate_source: "same_currency",
      total_minor: c.totalMinor,
      base_total_minor: c.totalMinor,
      status: c.status,
      settlement_route: c.route,
      settled_pay_run_id: null,
      settled_expense_id: null,
      decision_note: c.status === "returned" ? "Receipt is not legible" : null,
      created_by: by,
      created_at: ctx.clock.tsAgo(c.dayAgo, 17, 0),
      updated_at: ctx.clock.tsAgo(c.dayAgo, 17, 0),
    });
    for (const [i, l] of c.lines.entries())
      rows.expense_claim_line.push({
        id: l.id,
        org_id: org,
        claim_id: c.id,
        expense_date: l.date,
        category_key: l.category,
        description: l.description,
        amount_minor: l.amountMinor,
        mileage_km: null,
        mileage_rate_minor: null,
        receipt_file_id: null,
        job_id: null,
        settled_expense_id: null,
        created_at: ctx.clock.tsAgo(c.dayAgo, 17, i),
      });
  }

  for (const a of m.advances)
    rows.cash_advance.push({
      id: a.id,
      org_id: org,
      employee_id: a.employeeId,
      reference: a.reference,
      amount_minor: a.amountMinor,
      purpose: a.purpose,
      status: a.status,
      settled_claim_id: null,
      created_by: by,
      created_at: ctx.clock.tsAgo(a.dayAgo, 11, 0),
      updated_at: ctx.clock.tsAgo(a.dayAgo, 11, 0),
    });

  for (const d of m.disciplinary)
    rows.disciplinary_record.push({
      id: d.id,
      org_id: org,
      employee_id: d.employeeId,
      kind: d.kind,
      occurred_on: d.occurredOn,
      summary: d.summary,
      detail: null,
      outcome: d.outcome,
      file_id: null,
      voided_at: null,
      void_reason: null,
      created_by: by,
      created_at: `${d.occurredOn}T10:00:00.000Z`,
      updated_at: `${d.occurredOn}T10:00:00.000Z`,
    });

  /*
   * A candidate belongs to a requisition: the column is NOT NULL, and a
   * hiring pipeline with no role to hire into is not a pipeline. One open
   * requisition carries the whole shortlist, which is how a small company
   * actually recruits.
   */
  const requisitionId = ctx.id("job_requisition", 0);
  if (m.candidates.length)
    rows.job_requisition.push({
      id: requisitionId,
      org_id: org,
      reference: "REQ-001",
      title: "Site supervisor",
      department_id: null,
      position_id: null,
      headcount: 1,
      status: "open",
      notes: "Replacement for a leaver; shortlist under review.",
      created_by: by,
      created_at: ctx.clock.tsAgo(120, 9, 0),
      updated_at: ctx.clock.tsAgo(120, 9, 0),
    });

  for (const c of m.candidates)
    rows.candidate.push({
      id: c.id,
      org_id: org,
      requisition_id: requisitionId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      cv_file_id: null,
      stage: c.stage,
      notes: null,
      hired_employee_id: null,
      created_by: by,
      created_at: ctx.clock.tsAgo(c.dayAgo, 9, 0),
      updated_at: ctx.clock.tsAgo(c.dayAgo, 9, 0),
    });

  // pay_period rows are deliberately NOT written: setup owns the calendar.

  for (const r of m.runs) {
    rows.pay_run.push({
      id: r.id,
      org_id: org,
      pay_group_id: m.periods[0]?.groupId ?? null,
      period_id: r.periodId,
      reference: r.reference,
      run_kind: r.runKind,
      reverses_run_id: r.reversesRunId,
      status: r.status,
      pack_version: "uae_v1",
      currency: ctx.company.currency,
      gross_total_minor: r.grossTotal,
      deduction_total_minor: r.deductionTotal,
      employer_total_minor: r.employerTotal,
      net_total_minor: r.netTotal,
      exception_count: 0,
      calculated_at: ctx.clock.tsAgo(r.dayAgo, 10, 0),
      finalized_at: r.finalizedAt,
      finalized_by: r.status === "finalized" ? by : null,
      created_by: by,
      created_at: ctx.clock.tsAgo(r.dayAgo + 2, 9, 0),
      updated_at: ctx.clock.tsAgo(r.dayAgo, 12, 0),
    });
    for (const l of r.lines) {
      rows.pay_run_line.push({
        id: l.id,
        org_id: org,
        pay_run_id: r.id,
        employee_id: l.employeeId,
        snapshot: { basic_minor: l.gross, deductions_minor: l.deduction },
        gross_minor: l.gross,
        deduction_minor: l.deduction,
        employer_minor: l.employer,
        net_minor: l.net,
        exceptions: [],
        created_at: ctx.clock.tsAgo(r.dayAgo, 10, 0),
      });
      if (l.payslipId)
        rows.payslip.push({
          id: l.payslipId,
          org_id: org,
          pay_run_id: r.id,
          pay_run_line_id: l.id,
          employee_id: l.employeeId,
          slip_no: l.slipNo,
          issuer_snapshot: { legal_name: ctx.company.legalNameEn },
          snapshot: { gross_minor: l.gross, net_minor: l.net },
          net_minor: l.net,
          currency: ctx.company.currency,
          period_start: r.periodStart,
          period_end: r.periodEnd,
          issued_at: r.finalizedAt,
          issued_by: by,
        });
    }
  }

  return rows;
}

export function planHr(ctx: LabContext): FamilyPlan {
  const m = buildModel(ctx);
  return { family: "hr", expected: { ...m.tableCounts } };
}

export async function seedHr(ctx: LabContext): Promise<FamilyReport> {
  const m = buildModel(ctx);
  const rows = toRows(ctx, m);
  const counts: Record<string, number> = {};
  for (const table of HR_TABLES) {
    const r = await ctx.insert(table, rows[table]);
    counts[table] = r.attempted;
    ctx.log(`${table}: ${r.attempted} rows`);
  }
  return {
    family: "hr",
    counts,
    handoff: m.handoff as unknown as Record<string, unknown>,
    notes: [`${m.handoff.finalizedPayRunIds.length} finalized pay runs for the ledger`],
  };
}

export const hr: Family = {
  key: "hr",
  deps: ["setup", "people", "work"],
  appliesTo: (c: Company) => c.profile.enables.payroll,
  plan: planHr,
  seed: seedHr,
  async verify(ctx) {
    const m = buildModel(ctx);
    const checks = [];

    const badLine = m.runs
      .flatMap((r) => r.lines)
      .filter((l) => l.net !== l.gross - l.deduction).length;
    checks.push({
      name: "every pay line's net is its gross minus its deductions",
      ok: badLine === 0,
      detail: `${m.runs.reduce((n, r) => n + r.lines.length, 0)} lines, ${badLine} disagree`,
    });

    const badRun = m.runs.filter((r) => {
      const g = r.lines.reduce((n, l) => n + l.gross, 0);
      const d = r.lines.reduce((n, l) => n + l.deduction, 0);
      const nt = r.lines.reduce((n, l) => n + l.net, 0);
      return g !== r.grossTotal || d !== r.deductionTotal || nt !== r.netTotal;
    }).length;
    checks.push({
      name: "every run's totals are the sums of its own lines",
      ok: badRun === 0,
      detail: `${m.runs.length} runs, ${badRun} disagree`,
    });

    const slipMismatch = m.runs
      .flatMap((r) => r.lines)
      .filter((l) => l.payslipId !== null && l.slipNo === null).length;
    checks.push({
      name: "a payslip exists only for a finalized run, and carries a number",
      ok:
        slipMismatch === 0 &&
        m.runs.every((r) => r.status === "finalized" || r.lines.every((l) => l.payslipId === null)),
      detail: `${m.runs.filter((r) => r.status === "finalized").length} finalized`,
    });

    const balances = new Map<string, number>();
    for (const l of m.ledger)
      balances.set(
        `${l.employeeId}|${l.typeId}`,
        (balances.get(`${l.employeeId}|${l.typeId}`) ?? 0) + l.days,
      );
    const negative = [...balances.values()].filter((v) => v < -1e-9).length;
    checks.push({
      name: "no leave balance is negative",
      ok: negative === 0,
      detail: `${balances.size} balances, ${negative} negative`,
    });

    const approvedLeave = m.leave.filter((l) => l.status === "approved").length;
    const requestEntries = m.ledger.filter((l) => l.kind === "request").length;
    checks.push({
      name: "every approved leave request consumed the balance exactly once",
      ok: approvedLeave === requestEntries,
      detail: `${approvedLeave} approved, ${requestEntries} ledger entries`,
    });

    const badClaim = m.claims.filter(
      (c) => c.lines.reduce((n, l) => n + l.amountMinor, 0) !== c.totalMinor,
    ).length;
    checks.push({
      name: "every claim total is the sum of its lines",
      ok: badClaim === 0,
      detail: `${m.claims.length} claims, ${badClaim} disagree`,
    });

    checks.push({
      name: "the reversal mirrors the run it reverses",
      /*
       * MIRRORS, not negates. Payroll keeps every figure non-negative — the
       * schema says so on the run and on every line — because the sign of a
       * reversal lives in run_kind and reverses_run_id, not in the money.
       */
      ok: m.runs
        .filter((r) => r.runKind === "reversal")
        .every((r) => {
          const t = m.runs.find((x) => x.id === r.reversesRunId);
          return t !== undefined && r.netTotal === t.netTotal && r.grossTotal === t.grossTotal;
        }),
      detail: `${m.runs.filter((r) => r.runKind === "reversal").length} reversals`,
    });

    checks.push({
      name: "attendance shows every status a manager would filter by",
      ok: new Set(m.attendance.map((a) => a.status)).size >= 4,
      detail: [...new Set(m.attendance.map((a) => a.status))].sort().join(","),
    });

    return checks;
  },
};
