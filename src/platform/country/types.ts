/**
 * H29 — the country-pack contract (ADR-66).
 *
 * A pack is versioned DATA about a jurisdiction: what an establishment there
 * looks like, how its addresses and identifiers are shaped, which tax and
 * payroll pack versions apply, what its documents must carry, and what its
 * electronic-invoicing regime is. It is written as typed code so it can be
 * reviewed, diffed and tested; its lifecycle — status, effective dates,
 * reviews and per-establishment adoption — lives in the database.
 *
 * Three honesty tiers, carried per rule (the convention H23 and H24 set):
 *   verified-primary  — read in the legal text or the authority's own standard
 *   official-summary  — read on the authority's own website
 *   unverified        — configuration only; the product asserts nothing
 *
 * NO pack claims compliance, certification or legal advice. A pack that cannot
 * justify a rule carries configuration and a review flag instead of a number.
 */

export const VERIFICATION_TIERS = ["verified-primary", "official-summary", "unverified"] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

/** Where a rule came from. Every implemented rule carries one. */
export type SourceRef = {
  /** The authority or standards body, in its own name. */
  authority: string;
  /** The document or page, named as it names itself. */
  document: string;
  /** Article, section or table, when the source has one. */
  locator?: string;
  url?: string;
  /** ISO date the source was read. */
  retrieved: string;
  tier: VerificationTier;
  /** The evidence-log entry this rule is recorded under. */
  evidence: string;
};

/** A rule and the source that justifies it. Unverified rules carry `value: null`. */
export type Sourced<T> = {
  value: T;
  source: SourceRef;
  /** Set when the rule needs a person before it may be used. */
  requiresReview?: boolean;
  note?: string;
};

// ── lifecycle ───────────────────────────────────────────────────────────────

export const PACK_STATUSES = [
  "draft",
  "review",
  "approved",
  "active",
  "retired",
  "superseded",
] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

/** The six readiness states. Independent, never averaged into one number (ADR-74). */
export const READINESS_STATES = [
  "technically_configured",
  "reviewed_internally",
  "provider_connected",
  "legally_reviewed",
  "pilot_ready",
  "generally_available",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const REVIEW_KINDS = ["internal", "native_language", "professional", "provider"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATES = ["not_started", "in_progress", "passed", "failed"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

// ── address, identity, banking ──────────────────────────────────────────────

/** One field of a country's address form. Order is the country's own order. */
export type AddressField = {
  key: string;
  /** Message key for the label — never a literal, so every locale can name it. */
  labelKey: string;
  required: boolean;
  /** A shape the authority publishes. Absent means "accept what was entered". */
  pattern?: string;
  maxLength: number;
  /** Example shown to the person filling the form. */
  example?: string;
};

export type AddressSchema = {
  fields: AddressField[];
  /** How the fields are laid out on a document, one line per array entry. */
  documentLayout: string[][];
  source: SourceRef;
};

export const IDENTIFIER_KINDS = [
  "tax_registration",
  "commercial_registration",
  "payroll_establishment",
  "national_id",
  "other",
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export type IdentifierSpec = {
  key: string;
  kind: IdentifierKind;
  labelKey: string;
  /** The authority that issues it, in its own name. */
  authority: string;
  pattern?: string;
  length?: number;
  /** Checked with a published algorithm rather than a regular expression. */
  checksum?: "iban_mod97" | "none";
  required: boolean;
  source: SourceRef;
};

export type BankingSpec = {
  /** ISO 13616 IBAN length for the country, when published. */
  ibanLength: number | null;
  ibanPrefix: string;
  /** Local clearing identifiers the pack knows about. */
  localIdentifiers: IdentifierSpec[];
  source: SourceRef;
};

// ── week, holidays, formats ─────────────────────────────────────────────────

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type WeekRules = {
  /** The day a week starts on for calendars and reports. */
  weekStartsOn: Weekday;
  /** The default working days for a new establishment. */
  defaultWorkingDays: Weekday[];
  /**
   * Days the law NAMES as rest days. Empty where the law sets a count but
   * leaves the day to the contract, which is not the same as having none.
   */
  statutoryRestDays: Sourced<Weekday[]>;
  /** The statutory floor on paid rest days per week, where one is set. */
  minimumRestDaysPerWeek: Sourced<number | null>;
  standardDailyHours: Sourced<number | null>;
  standardWeeklyHours: Sourced<number | null>;
};

export type FormatRules = {
  currency: string;
  /** ISO 4217 minor-unit exponent, mirrored from the platform registry. */
  currencyExponent: number;
  defaultTimezone: string;
  /** Languages the pack's own documents can be produced in. */
  documentLanguages: string[];
  /** Languages a document of this kind MUST carry, where the law says so. */
  requiredDocumentLanguages: Sourced<string[]>;
  /** Whether a Hijri date may be shown alongside the Gregorian one. */
  hijriDisplay: boolean;
};

// ── tax, payroll, documents, electronic invoicing ───────────────────────────

/**
 * The pack REFERENCES the tax engine's pack versions; it never restates their
 * rules (ADR-79). `null` means the jurisdiction has no such pack yet.
 */
export type TaxModuleRef = {
  key: string;
  labelKey: string;
  /** The version string the finance tax engine knows, e.g. "AE-VAT-2026-09-01". */
  engineVersion: string | null;
  standardRatePercent: Sourced<number | null>;
  registrationThresholds: Sourced<{ mandatory: number | null; voluntary: number | null } | null>;
  /** How long a tax period runs, and what decides it. */
  periodRule: Sourced<string | null>;
  /** Mandatory fields the jurisdiction requires on a tax document. */
  documentFields: Sourced<string[]>;
  /**
   * What a person must set or confirm before this module can be used, as
   * MESSAGE KEYS, not sentences. A pack is read by people in three languages,
   * and a rule stated only in English becomes English text on an Arabic or
   * Spanish screen the moment a surface renders it.
   */
  requiresConfiguration: string[];
};

export type PayrollModuleRef = {
  /** The payroll engine pack this country resolves to, when one exists. */
  engineVersion: string | null;
  endOfService: Sourced<{
    bands: Array<{ uptoYears: number | null; daysPerYear: number }>;
    base: "basic" | "wage" | "configured";
    proRataPartialYears: boolean;
    /** Reductions on resignation, where the law sets a scale. */
    resignationScale: Array<{ fromYears: number; toYears: number | null; fraction: number }> | null;
  } | null>;
  statutoryContributions: Array<
    Sourced<{
      key: string;
      labelKey: string;
      employerPercent: number | null;
      employeePercent: number | null;
      appliesTo: "nationals" | "all" | "configured";
      ceiling: number | null;
      floor: number | null;
    }>
  >;
  annualLeave: Sourced<{ minimumDays: number; afterYearsDays: Array<[number, number]> } | null>;
  /** Payment-file or wage-protection seams; architecture, never a compliance claim. */
  paymentSeams: Array<{ key: string; labelKey: string; note: string }>;
  /** What a person must set or confirm, as MESSAGE KEYS (see TaxModuleRef). */
  requiresConfiguration: string[];
};

export const EINVOICE_MODELS = ["none", "clearance", "reporting", "peppol_network"] as const;
export type EInvoiceModel = (typeof EINVOICE_MODELS)[number];

export type EInvoiceSpec = {
  /** The adapter that implements it, from the electronic-invoicing registry. */
  adapterKey: string | null;
  model: EInvoiceModel;
  /** The document standard, named as the authority names it. */
  standard: Sourced<string | null>;
  /** The legal instruments, quoted by name and number only. */
  instruments: Sourced<string[]>;
  /** What the organisation must obtain before anything can be sent, as message keys. */
  requiredCredentials: string[];
  /** What an external party must do, as message keys (appoint, onboard). */
  requiredProviders: string[];
  /** Dates are encoded ONLY where an official source states them (D2). */
  phaseDates: Sourced<Array<{ label: string; on: string }> | null>;
};

export type DocumentRules = {
  /** Document kinds this pack has an opinion about. */
  kinds: Array<{
    kind: string;
    requiredFields: Sourced<string[]>;
    requiredLanguages: string[];
    /** A structured block the document must carry, e.g. a ZATCA QR. */
    structuredBlock: string | null;
  }>;
};

export type PrivacyMetadata = {
  /** The law, named and numbered, with no compliance claim attached. */
  regime: Sourced<string | null>;
  authority: string | null;
  /** Whether a transfer outside the country has its own published regime. */
  crossBorderRegime: Sourced<string | null>;
  /** What an organisation must do itself before processing personal data here, as message keys. */
  organisationActions: string[];
};

// ── the pack ────────────────────────────────────────────────────────────────

export type CountryPack = {
  /** Stable identity, e.g. "AE-2026-09-03". */
  packKey: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The jurisdiction the pack speaks for, when narrower than the country. */
  jurisdiction: string;
  version: string;
  status: PackStatus;
  /** Inclusive ISO date the version becomes applicable. */
  effectiveFrom: string;
  /** Exclusive ISO date it stops applying. Null means open-ended. */
  effectiveTo: string | null;
  supersedes: string | null;
  owner: string;
  /** Who must review it, and in what state that review is. */
  reviews: Array<{ kind: ReviewKind; state: ReviewState; note: string }>;
  supportedLanguages: string[];
  format: FormatRules;
  week: WeekRules;
  address: AddressSchema;
  identifiers: IdentifierSpec[];
  banking: BankingSpec;
  tax: TaxModuleRef[];
  payroll: PayrollModuleRef | null;
  documents: DocumentRules;
  einvoicing: EInvoiceSpec;
  privacy: PrivacyMetadata;
  /** Configuration the organisation must supply before the pack is usable. */
  requiredConfiguration: Array<{ key: string; labelKey: string; why: string }>;
  /** Said plainly, in the product and in every language, as message keys. */
  knownLimitations: string[];
  changeHistory: string[];
};
