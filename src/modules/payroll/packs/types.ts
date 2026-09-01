/**
 * The country-pack interface (H23D).
 *
 * A pack is versioned DATA, not scattered rules: everything a jurisdiction
 * changes lives here, the engine consumes it, and every calculation snapshot
 * embeds the pack version — so a pack update never rewrites an issued run.
 *
 * Three honesty tiers, carried per field group in `verification`:
 *   verified-primary  — confirmed against the official law text / portal
 *   official-summary  — confirmed against an official summary page
 *   unverified        — encoded as configuration; the product asserts nothing
 *
 * NO pack claims legal compliance. The completion report states exactly which
 * claims are verified and which are configuration.
 */

export type OvertimeRules = {
  /** Multiplier floor on the BASIC wage for ordinary overtime. */
  ordinaryMultiplierFloor: number;
  /** Night window and its multiplier floor (basic wage). Null = no night rule. */
  night: { fromHour: number; toHour: number; multiplierFloor: number } | null;
  /** Rest-day work: cash settlement premium floor on basic (or a day off). */
  restDayMultiplierFloor: number | null;
  /** Statutory caps the schedule validation warns on. */
  maxOtHoursPerDay: number | null;
  maxTotalHoursPer3Weeks: number | null;
  /** The wage base overtime is computed on. */
  base: "basic" | "gross";
};

export type LeavePackEntry = {
  key: string;
  labelEn: string;
  labelAr: string;
  paid: boolean;
  requiresAttachment: boolean;
  countBasis: "working_days" | "calendar_days";
  /** Statutory annual entitlement in days, when fixed. Null = configurable. */
  annualDays: number | null;
  /** Free-text of the statutory tiers (sick pay etc.) for the policy `rules` jsonb. */
  tiers?: Record<string, unknown>;
};

export type EndOfServiceRules = {
  /** Minimum continuous service (months) before any entitlement. */
  minServiceMonths: number;
  /** Days of BASIC wage per year of service, by band. */
  bands: Array<{ uptoYears: number | null; daysPerYear: number }>;
  /** Cap expressed in months of total wage. */
  capMonthsOfWage: number | null;
  base: "basic" | "gross";
  proRataPartialYears: boolean;
};

export type CountryPack = {
  country: string; // ISO-2
  version: string; // e.g. "AE-2026-09-01"
  currency: string;
  /** Standard hours used to derive an hourly basic rate from a monthly one. */
  monthlyToHourlyDivisor: number;
  standardWeeklyHours: number;
  overtime: OvertimeRules;
  leave: LeavePackEntry[];
  endOfService: EndOfServiceRules | null;
  /** Statutory deduction components (e.g. national pension). */
  statutoryComponents: Array<{
    key: string;
    labelEn: string;
    labelAr: string;
    kind: "employee_deduction" | "employer_contribution";
    /** Percentage of the contribution base, when verified. Null = org-configured. */
    percent: number | null;
    /** Who it applies to, resolved by the engine (e.g. nationality codes). */
    appliesToNationalities: string[] | null;
    verified: boolean;
    note: string;
  }>;
  /** Payment-file export formats this pack can produce (architecture, not compliance). */
  paymentExports: Array<{ key: string; label: string; note: string }>;
  /** Field-group verification statement for the completion report. */
  verification: Record<string, "verified-primary" | "official-summary" | "unverified">;
};
