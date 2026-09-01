/**
 * H23D — the gross-to-net calculation. Pure, deterministic, integer-only.
 *
 * Every function here takes explicit inputs and returns explicit results with
 * the working shown; the service snapshots the whole thing. NO floating-point
 * money: amounts are bigint-safe integers of minor units end to end, percents
 * are applied with integer rounding (half up) at each defined step, and the
 * order of operations is fixed and recorded.
 */
import type { CountryPack } from "./packs/types";

export type EngineComponent = {
  key: string;
  labelEn: string;
  labelAr: string;
  kind: "earning" | "deduction" | "employer_contribution";
  /** Quantity × rate where meaningful (overtime); else amount only. */
  qty?: number;
  rateMinor?: number;
  amountMinor: number;
};

export type EngineInputs = {
  employeeId: string;
  employeeName: string;
  nationality: string | null;
  periodStart: string;
  periodEnd: string;
  /** From the compensation history, effective at period end. */
  basicMonthlyMinor: number;
  otRate: number;
  hourlyDivisor: number;
  /** Recurring components effective in the period. */
  recurring: Array<{
    key: string;
    labelEn: string;
    labelAr: string;
    kind: "earning" | "deduction" | "employer_contribution";
    calc: "fixed" | "percent_of_basic";
    amountMinor: number | null;
    percent: number | null;
  }>;
  /** Approved overtime minutes in the period. */
  overtimeMinutes: number;
  /** Unpaid-leave days in the period (explicit; never inferred). */
  unpaidLeaveDays: number;
  /** Calendar days in the period — the proration denominator, stated. */
  periodCalendarDays: number;
  /** Manual adjustments (reasoned) for this employee and run. */
  adjustments: Array<{ label: string; kind: "earning" | "deduction"; amountMinor: number }>;
  /** Approved claim reimbursements routed via payroll (claimId settles at finalize). */
  reimbursements: Array<{ claimId: string; label: string; amountMinor: number }>;
  /** Active loan installments due. */
  loanInstallments: Array<{ loanId: string; reference: string; amountMinor: number }>;
};

export type EngineResult = {
  components: EngineComponent[];
  grossMinor: number;
  deductionMinor: number;
  employerMinor: number;
  netMinor: number;
  /** Net after the group's rounding rule; the difference is its own component. */
  netRoundedMinor: number;
  exceptions: string[];
  working: Record<string, unknown>;
};

/** Round half up to the nearest integer — the ONE rounding primitive. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Round half up to the nearest multiple of `unit` minor units. */
export function roundToUnit(minor: number, unit: number): number {
  if (unit <= 1) return minor;
  return roundHalfUp(minor / unit) * unit;
}

export function calculateLine(
  inputs: EngineInputs,
  pack: CountryPack,
  roundingMinor: number,
): EngineResult {
  const exceptions: string[] = [];
  const components: EngineComponent[] = [];

  if (!Number.isSafeInteger(inputs.basicMonthlyMinor) || inputs.basicMonthlyMinor < 0) {
    throw new RangeError(`basic pay out of range for ${inputs.employeeId}`);
  }

  // 1. Basic, prorated for unpaid leave on the stated calendar-day basis.
  const unpaidDeduction =
    inputs.unpaidLeaveDays > 0
      ? roundHalfUp((inputs.basicMonthlyMinor * inputs.unpaidLeaveDays) / inputs.periodCalendarDays)
      : 0;
  const basic = inputs.basicMonthlyMinor;
  components.push({
    key: "basic",
    labelEn: "Basic salary",
    labelAr: "الراتب الأساسي",
    kind: "earning",
    amountMinor: basic,
  });
  if (unpaidDeduction > 0) {
    components.push({
      key: "unpaid_leave",
      labelEn: `Unpaid leave (${inputs.unpaidLeaveDays}d of ${inputs.periodCalendarDays})`,
      labelAr: `إجازة بدون راتب (${inputs.unpaidLeaveDays} من ${inputs.periodCalendarDays})`,
      kind: "deduction",
      qty: inputs.unpaidLeaveDays,
      amountMinor: unpaidDeduction,
    });
  }

  // 2. Recurring components. percent_of_basic applies to the FULL monthly basic
  //    (stated policy, snapshotted) — proration affects pay, not the base.
  for (const rc of inputs.recurring) {
    let amount = 0;
    if (rc.calc === "fixed") {
      amount = rc.amountMinor ?? 0;
    } else {
      if (rc.percent == null) {
        exceptions.push(`component ${rc.key} is percent-based but has no percent`);
        continue;
      }
      amount = roundHalfUp((basic * rc.percent) / 100);
    }
    if (amount === 0) continue;
    components.push({
      key: rc.key,
      labelEn: rc.labelEn,
      labelAr: rc.labelAr,
      kind: rc.kind,
      amountMinor: amount,
    });
  }

  // 3. Overtime: minutes × hourly basic × the employee's rate, floored by the
  //    pack — a rate below the statutory floor is an EXCEPTION, never silently
  //    raised, because pay rules are explicit or they are wrong.
  if (inputs.overtimeMinutes > 0) {
    const hourlyBasic = inputs.basicMonthlyMinor / inputs.hourlyDivisor;
    const rate = inputs.otRate;
    if (pack.overtime.base === "basic" && rate < pack.overtime.ordinaryMultiplierFloor) {
      exceptions.push(
        `overtime rate ${rate} is below the ${pack.country} statutory floor ${pack.overtime.ordinaryMultiplierFloor}`,
      );
    }
    const amount = roundHalfUp((hourlyBasic * rate * inputs.overtimeMinutes) / 60);
    components.push({
      key: "overtime",
      labelEn: `Overtime (${inputs.overtimeMinutes} min @ ${rate}x)`,
      labelAr: `عمل إضافي (${inputs.overtimeMinutes} دقيقة × ${rate})`,
      kind: "earning",
      qty: inputs.overtimeMinutes,
      rateMinor: roundHalfUp((hourlyBasic * rate) / 60),
      amountMinor: amount,
    });
  }

  // 4. Reimbursements and adjustments.
  for (const r of inputs.reimbursements) {
    components.push({
      key: "reimbursement",
      labelEn: r.label,
      labelAr: r.label,
      kind: "earning",
      amountMinor: r.amountMinor,
    });
  }
  for (const a of inputs.adjustments) {
    components.push({
      key: a.kind === "earning" ? "adjustment_earning" : "adjustment_deduction",
      labelEn: a.label,
      labelAr: a.label,
      kind: a.kind,
      amountMinor: a.amountMinor,
    });
  }

  // 5. Loan installments.
  for (const l of inputs.loanInstallments) {
    components.push({
      key: "loan_repayment",
      labelEn: `Loan repayment ${l.reference}`,
      labelAr: `سداد قرض ${l.reference}`,
      kind: "deduction",
      amountMinor: l.amountMinor,
    });
  }

  // 6. Statutory components from the pack (verified rates only; anything
  //    unverified never auto-applies).
  for (const s of pack.statutoryComponents) {
    if (!s.verified || s.percent == null) continue;
    if (
      s.appliesToNationalities &&
      (!inputs.nationality || !s.appliesToNationalities.includes(inputs.nationality))
    ) {
      continue;
    }
    const amount = roundHalfUp((basic * s.percent) / 100);
    if (amount === 0) continue;
    components.push({
      key: s.key,
      labelEn: s.labelEn,
      labelAr: s.labelAr,
      kind: s.kind === "employee_deduction" ? "deduction" : "employer_contribution",
      amountMinor: amount,
    });
  }

  // 7. Totals, in a fixed order.
  const grossMinor = components
    .filter((c) => c.kind === "earning")
    .reduce((a, c) => a + c.amountMinor, 0);
  const deductionMinor = components
    .filter((c) => c.kind === "deduction")
    .reduce((a, c) => a + c.amountMinor, 0);
  const employerMinor = components
    .filter((c) => c.kind === "employer_contribution")
    .reduce((a, c) => a + c.amountMinor, 0);
  const netMinor = grossMinor - deductionMinor;
  if (netMinor < 0) {
    exceptions.push(`net pay is negative (${netMinor} minor units)`);
  }
  const netRoundedMinor = roundToUnit(netMinor, roundingMinor);
  if (netRoundedMinor !== netMinor) {
    components.push({
      key: "rounding",
      labelEn: "Rounding",
      labelAr: "تقريب",
      kind: netRoundedMinor > netMinor ? "earning" : "deduction",
      amountMinor: Math.abs(netRoundedMinor - netMinor),
    });
  }

  return {
    components,
    grossMinor: grossMinor + Math.max(0, netRoundedMinor - netMinor),
    deductionMinor: deductionMinor + Math.max(0, netMinor - netRoundedMinor),
    employerMinor,
    netMinor,
    netRoundedMinor,
    exceptions,
    working: {
      basis: {
        basicMonthlyMinor: inputs.basicMonthlyMinor,
        hourlyDivisor: inputs.hourlyDivisor,
        otRate: inputs.otRate,
        periodCalendarDays: inputs.periodCalendarDays,
        unpaidLeaveDays: inputs.unpaidLeaveDays,
        overtimeMinutes: inputs.overtimeMinutes,
        roundingMinor,
      },
      packVersion: pack.version,
      order: [
        "basic",
        "unpaid_leave_proration",
        "recurring",
        "overtime",
        "reimbursements",
        "adjustments",
        "loans",
        "statutory",
        "totals",
        "net_rounding",
      ],
    },
  };
}

/**
 * End-of-service gratuity per the pack's bands: days of BASIC wage per year,
 * pro-rata for partial years, capped in months of wage. Inputs are explicit —
 * the caller supplies service days and the last basic wage; nothing is
 * inferred from tables the caller did not name.
 */
export function calculateGratuity(
  pack: CountryPack,
  serviceDays: number,
  lastBasicMonthlyMinor: number,
): { amountMinor: number; working: Record<string, unknown> } | null {
  const eos = pack.endOfService;
  if (!eos) return null;
  const serviceMonths = serviceDays / 30.4375; // mean Gregorian month, stated
  if (serviceMonths < eos.minServiceMonths) {
    return { amountMinor: 0, working: { serviceDays, belowMinimum: true } };
  }
  const dailyBasic = lastBasicMonthlyMinor / 30; // days-of-wage convention, stated
  const serviceYears = serviceDays / 365.25;

  let remaining = serviceYears;
  let uptoPrev = 0;
  let days = 0;
  const bands: Array<Record<string, number>> = [];
  for (const band of eos.bands) {
    const span =
      band.uptoYears === null ? remaining : Math.min(remaining, band.uptoYears - uptoPrev);
    if (span <= 0) continue;
    days += span * band.daysPerYear;
    bands.push({ years: span, daysPerYear: band.daysPerYear });
    remaining -= span;
    uptoPrev = band.uptoYears ?? uptoPrev;
    if (remaining <= 0) break;
  }
  let amount = roundHalfUp(days * dailyBasic);
  const cap =
    eos.capMonthsOfWage != null
      ? eos.capMonthsOfWage * lastBasicMonthlyMinor
      : Number.MAX_SAFE_INTEGER;
  const capped = amount > cap;
  if (capped) amount = cap;
  return {
    amountMinor: amount,
    working: {
      serviceDays,
      serviceYears,
      dailyBasic: roundHalfUp(dailyBasic),
      gratuityDays: days,
      bands,
      capMonthsOfWage: eos.capMonthsOfWage,
      capped,
      packVersion: pack.version,
    },
  };
}
