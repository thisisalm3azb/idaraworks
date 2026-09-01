/**
 * The UAE country pack — version AE-2026-09-01.
 *
 * Every number below is traceable to docs/H23-EVIDENCE-LOG.md, which records
 * the official source, retrieval date and the adversarial re-verification that
 * confirmed (or corrected, or downgraded) each fact. The load-bearing ones:
 *
 *   - Working time & overtime: Federal Decree-Law 33/2021 Arts 17-21 and
 *     Cabinet Resolution 1/2022 Art 15 (uaelegislation.gov.ae, verified-primary):
 *     8h/48h; Ramadan −2h/day for ALL workers; OT floor 1.25× BASIC; night OT
 *     (22:00–04:00) floor 1.5× basic with shift workers excluded; rest-day work
 *     = substitute day OR day wage + 50% basic; OT cap 2h/day, 144h per 3 weeks.
 *   - Leave: Art 29 annual (30 days after 1y; 2 days/month for 6m–1y);
 *     Cab Res 1/2022 Art 19(1) carryover ≤ half; sick 90 days tiered
 *     15 full / 30 half / 45 unpaid; maternity 45 full + 15 half; parental
 *     5 working days within 6 months (Art 32); bereavement 5/3 days.
 *   - Gratuity: Art 51 — ≥1 year service; 21 days basic per year ≤5 years,
 *     30 days per year beyond; LAST BASIC wage, allowances excluded; total
 *     capped at 2 years' wage; pro-rata for partial years.
 *   - GPSSA (UAE nationals, post-31-Oct-2023 entrants, Law 57/2023): 26% total
 *     = 11% employee + 15% employer, ceiling AED 70,000 (u.ae, official).
 *     The AED 3,000 private-sector floor could NOT be verified (GPSSA WAF) —
 *     left unverified, org-configurable.
 *   - No personal income tax in the UAE (u.ae, official).
 *   - WPS: governed by Ministerial Resolution 340/2026 (the 2022 framing is
 *     superseded). This pack ships a payment-file EXPORT SEAM — it does not
 *     claim WPS compliance, and nothing in the product should.
 */
import type { CountryPack } from "./types";

export const AE_PACK: CountryPack = {
  country: "AE",
  version: "AE-2026-09-01",
  currency: "AED",
  // Convention already used by employee_terms since S1 (salary/208); kept as the
  // org-overridable divisor rather than a new invention.
  monthlyToHourlyDivisor: 208,
  standardWeeklyHours: 48,
  overtime: {
    ordinaryMultiplierFloor: 1.25,
    night: { fromHour: 22, toHour: 4, multiplierFloor: 1.5 },
    restDayMultiplierFloor: 1.5,
    maxOtHoursPerDay: 2,
    maxTotalHoursPer3Weeks: 144,
    base: "basic",
  },
  leave: [
    {
      key: "annual",
      labelEn: "Annual leave",
      labelAr: "إجازة سنوية",
      paid: true,
      requiresAttachment: false,
      countBasis: "working_days",
      annualDays: 30,
      tiers: {
        partialYear: "2 days/month once service exceeds 6 months",
        carryover: "max half, employer approval (Cab Res 1/2022 Art 19(1))",
      },
    },
    {
      key: "sick",
      labelEn: "Sick leave",
      labelAr: "إجازة مرضية",
      paid: true,
      requiresAttachment: true,
      countBasis: "calendar_days",
      annualDays: 90,
      tiers: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
    },
    {
      key: "maternity",
      labelEn: "Maternity leave",
      labelAr: "إجازة أمومة",
      paid: true,
      requiresAttachment: true,
      countBasis: "calendar_days",
      annualDays: 60,
      tiers: { fullPayDays: 45, halfPayDays: 15 },
    },
    {
      key: "parental",
      labelEn: "Parental leave",
      labelAr: "إجازة والدية",
      paid: true,
      requiresAttachment: false,
      countBasis: "working_days",
      annualDays: 5,
      tiers: { window: "within 6 months of birth (Art 32)" },
    },
    {
      key: "bereavement",
      labelEn: "Bereavement leave",
      labelAr: "إجازة حداد",
      paid: true,
      requiresAttachment: false,
      countBasis: "calendar_days",
      annualDays: 5,
      tiers: { spouseDays: 5, closeRelativeDays: 3 },
    },
    {
      key: "unpaid",
      labelEn: "Unpaid leave",
      labelAr: "إجازة بدون راتب",
      paid: false,
      requiresAttachment: false,
      countBasis: "calendar_days",
      annualDays: null,
    },
  ],
  endOfService: {
    minServiceMonths: 12,
    bands: [
      { uptoYears: 5, daysPerYear: 21 },
      { uptoYears: null, daysPerYear: 30 },
    ],
    capMonthsOfWage: 24,
    base: "basic",
    proRataPartialYears: true,
  },
  statutoryComponents: [
    {
      key: "gpssa_employee",
      labelEn: "GPSSA pension (employee)",
      labelAr: "معاش الهيئة العامة (الموظف)",
      kind: "employee_deduction",
      percent: 11,
      appliesToNationalities: ["AE"],
      verified: true,
      note: "Law 57/2023 cohort (joined on/after 31 Oct 2023); ceiling AED 70,000/month. Pre-cohort employees and the AED 3,000 floor are org configuration.",
    },
    {
      key: "gpssa_employer",
      labelEn: "GPSSA pension (employer)",
      labelAr: "معاش الهيئة العامة (صاحب العمل)",
      kind: "employer_contribution",
      percent: 15,
      appliesToNationalities: ["AE"],
      verified: true,
      note: "Same cohort and ceiling as the employee share.",
    },
  ],
  paymentExports: [
    {
      key: "wps_sif",
      label: "WPS salary information file (SIF)",
      note: "Export architecture only. WPS is governed by Ministerial Resolution 340/2026; agent-bank onboarding and MOHRE registration are outside this product, and no compliance is claimed.",
    },
    {
      key: "bank_csv",
      label: "Bank transfer CSV",
      note: "Generic per-employee transfer listing for manual banking.",
    },
  ],
  verification: {
    workingTime: "verified-primary",
    overtime: "verified-primary",
    leave: "verified-primary",
    endOfService: "verified-primary",
    gpssaRates: "official-summary",
    gpssaFloor: "unverified",
    incomeTax: "official-summary",
    wps: "unverified",
  },
};
