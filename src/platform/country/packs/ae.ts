/**
 * H29 — the United Arab Emirates pack, version AE-2026-09-03.
 *
 * It does NOT restate the UAE VAT, Corporate Tax or labour rules: those live in
 * the H24 tax engine (`AE-VAT-2026-09-01`, `AE-CT-2026-09-01`) and the H23
 * payroll pack (`AE-2026-09-01`), each with its own evidence log. This pack
 * carries the establishment-level material — address shape, registrations,
 * banking, week, document rules and the electronic-invoicing declaration — and
 * REFERENCES those versions (ADR-79).
 *
 * Sources and tiers: docs/H29-EVIDENCE-LOG.md part E, plus H23 and H24.
 */
import type { CountryPack, SourceRef } from "../types";

const MOF_GUIDELINES: SourceRef = {
  authority: "UAE Ministry of Finance",
  document: "UAE Electronic Invoicing Guidelines",
  locator: "v1.1, 1 June 2026",
  url: "https://mof.gov.ae/en/about-us/initiatives/einvoicing/",
  retrieved: "2026-09-03",
  tier: "verified-primary",
  evidence: "E1–E6, E8",
};

const H24_VAT: SourceRef = {
  authority: "UAE Federal Tax Authority",
  document: "VAT rate and VAT201 return structure, as recorded for the H24 tax engine",
  url: "https://tax.gov.ae/en/taxes/vat.aspx",
  retrieved: "2026-09-01",
  tier: "official-summary",
  evidence: "H24 evidence log 1–5",
};

const H23_LABOUR: SourceRef = {
  authority: "UAE legislation portal and u.ae",
  document: "Federal Decree-Law 33/2021 and Cabinet Resolution 1/2022, as recorded for H23",
  url: "https://uaelegislation.gov.ae/en/legislations/1541",
  retrieved: "2026-09-01",
  tier: "verified-primary",
  evidence: "H23 evidence log 2, 3, 8, 9",
};

const ISO_13616: SourceRef = {
  authority: "ISO / SWIFT IBAN registry",
  document: "ISO 13616 IBAN structure",
  locator: "AE",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "F2",
};

const NOT_PUBLISHED_AS_TEXT: SourceRef = {
  authority: "UAE Ministry of Finance",
  document: "Ministerial Decision No. 244 of 2025 (phased implementation plan)",
  url: "https://mof.gov.ae/en/about-us/initiatives/einvoicing/",
  retrieved: "2026-09-03",
  tier: "unverified",
  evidence: "E7",
};

export const AE_PACK: CountryPack = {
  packKey: "AE-2026-09-03",
  country: "AE",
  jurisdiction: "United Arab Emirates (federal)",
  version: "2026-09-03",
  status: "active",
  effectiveFrom: "2026-09-03",
  effectiveTo: null,
  supersedes: null,
  owner: "platform",
  reviews: [
    { kind: "internal", state: "passed", note: "Built from the H23 and H24 evidence logs." },
    {
      kind: "professional",
      state: "not_started",
      note: "country.limit.ae_no_professional_review",
    },
    {
      kind: "native_language",
      state: "not_started",
      note: "Arabic legal terminology has not been reviewed by a native reviewer.",
    },
    { kind: "provider", state: "not_started", note: "No Accredited Service Provider appointed." },
  ],
  supportedLanguages: ["en", "ar"],

  format: {
    currency: "AED",
    currencyExponent: 2,
    defaultTimezone: "Asia/Dubai",
    documentLanguages: ["en", "ar"],
    requiredDocumentLanguages: {
      value: [],
      source: H24_VAT,
      note: "No single document language is mandated federally; both are supported.",
    },
    hijriDisplay: false,
  },

  week: {
    weekStartsOn: "mon",
    defaultWorkingDays: ["mon", "tue", "wed", "thu", "fri"],
    statutoryRestDays: {
      value: [],
      source: H23_LABOUR,
      note: "The law fixes a count, not a day: the rest day is set by contract or work regulations (Art 21). Saturday and Sunday are custom, not statute.",
    },
    minimumRestDaysPerWeek: { value: 1, source: H23_LABOUR },
    standardDailyHours: { value: 8, source: H23_LABOUR },
    standardWeeklyHours: { value: 48, source: H23_LABOUR },
  },

  address: {
    source: {
      authority: "UAE government portal",
      document: "Business address conventions as used on UAE tax documents",
      retrieved: "2026-09-03",
      tier: "unverified",
      evidence: "H29 assumption G3",
      url: "https://u.ae/",
    },
    fields: [
      { key: "line1", labelKey: "country.address.line1", required: true, maxLength: 120 },
      { key: "line2", labelKey: "country.address.line2", required: false, maxLength: 120 },
      {
        key: "poBox",
        labelKey: "country.address.po_box",
        required: false,
        maxLength: 20,
        example: "P.O. Box 12345",
      },
      { key: "area", labelKey: "country.address.area", required: false, maxLength: 80 },
      { key: "city", labelKey: "country.address.city", required: true, maxLength: 80 },
      {
        key: "emirate",
        labelKey: "country.address.emirate",
        required: true,
        maxLength: 40,
        example: "Dubai",
      },
    ],
    documentLayout: [["line1"], ["line2"], ["poBox"], ["area", "city"], ["emirate"]],
  },

  identifiers: [
    {
      key: "trn",
      kind: "tax_registration",
      labelKey: "country.identifier.ae_trn",
      authority: "Federal Tax Authority",
      pattern: "^[0-9]{15}$",
      length: 15,
      required: false,
      source: H24_VAT,
    },
    {
      key: "tin",
      kind: "tax_registration",
      labelKey: "country.identifier.ae_tin",
      authority: "Federal Tax Authority",
      pattern: "^[0-9]{10}$",
      length: 10,
      required: false,
      source: MOF_GUIDELINES,
    },
    {
      key: "trade_licence",
      kind: "commercial_registration",
      labelKey: "country.identifier.ae_trade_licence",
      authority: "The issuing emirate's licensing authority",
      required: false,
      source: {
        authority: "UAE government portal",
        document: "Trade licence issued by the relevant emirate",
        retrieved: "2026-09-03",
        tier: "unverified",
        evidence: "H29 assumption G3",
      },
    },
  ],

  banking: {
    ibanLength: 23,
    ibanPrefix: "AE",
    localIdentifiers: [],
    source: ISO_13616,
  },

  tax: [
    {
      key: "vat",
      labelKey: "country.tax.vat",
      engineVersion: "AE-VAT-2026-09-01",
      standardRatePercent: { value: 5, source: H24_VAT },
      registrationThresholds: {
        value: { mandatory: 375_000, voluntary: 187_500 },
        source: H24_VAT,
        note: "Shown as guidance. Registration is never inferred from turnover.",
      },
      periodRule: {
        value:
          "Monthly or quarterly as assigned by the authority; the return is due on the 28th of the following month.",
        source: H24_VAT,
      },
      documentFields: {
        value: [
          "supplier_name",
          "supplier_address",
          "supplier_trn",
          "customer_name",
          "customer_trn_where_registered",
          "sequential_number",
          "date_of_issue",
          "date_of_supply_where_different",
          "description",
          "unit_price_excluding_tax",
          "taxable_amount",
          "tax_rate",
          "tax_amount_in_aed",
          "total_payable",
        ],
        source: H24_VAT,
      },
      requiresConfiguration: [
        "country.item.registration_status",
        "country.item.tax_period",
        "country.item.emirate_of_supply",
      ],
    },
    {
      key: "corporate_tax",
      labelKey: "country.tax.corporate",
      engineVersion: "AE-CT-2026-09-01",
      standardRatePercent: { value: 9, source: H24_VAT, note: "0% up to AED 375,000." },
      registrationThresholds: { value: null, source: H24_VAT },
      periodRule: {
        value:
          "The taxable person's own financial year, for years starting on or after 1 June 2023.",
        source: H24_VAT,
      },
      documentFields: { value: [], source: H24_VAT },
      requiresConfiguration: [
        "country.item.free_zone_status",
        "country.item.small_business_relief",
        "country.item.adjustment_lines",
      ],
    },
  ],

  payroll: {
    engineVersion: "AE-2026-09-01",
    endOfService: {
      value: {
        bands: [
          { uptoYears: 5, daysPerYear: 21 },
          { uptoYears: null, daysPerYear: 30 },
        ],
        base: "basic",
        proRataPartialYears: true,
        resignationScale: null,
      },
      source: H23_LABOUR,
      note: "Computed by the H23 payroll engine, which owns the rule; repeated here only so the readiness centre can show it.",
    },
    statutoryContributions: [
      {
        value: {
          key: "gpssa",
          labelKey: "country.payroll.ae_gpssa",
          employerPercent: 15,
          employeePercent: 11,
          appliesTo: "nationals",
          ceiling: 70_000,
          floor: null,
        },
        source: {
          authority: "u.ae",
          document: "Pensions and social security (Federal Law 57/2023)",
          url: "https://u.ae/",
          retrieved: "2026-09-01",
          tier: "official-summary",
          evidence: "H23 evidence log, GPSSA",
        },
        note: "Applies to UAE nationals who joined after 31 October 2023. The private-sector floor could not be verified and is organisation configuration.",
      },
    ],
    annualLeave: {
      value: { minimumDays: 30, afterYearsDays: [] },
      source: H23_LABOUR,
      note: "Thirty days after one year; two days a month between six months and a year.",
    },
    paymentSeams: [
      {
        key: "wps_export",
        labelKey: "country.payroll.ae_wps",
        note: "A payment-file export seam. It is not a Wage Protection System certification and claims none.",
      },
    ],
    requiresConfiguration: ["country.item.contractual_rest_days", "country.item.gpssa_floor"],
  },

  documents: {
    kinds: [
      {
        kind: "tax_invoice",
        requiredFields: {
          value: ["supplier_trn", "sequential_number", "date_of_issue", "tax_amount_in_aed"],
          source: H24_VAT,
        },
        requiredLanguages: [],
        structuredBlock: null,
      },
      {
        kind: "tax_credit_note",
        requiredFields: {
          value: ["reference_to_original_invoice", "reason", "tax_amount_in_aed"],
          source: H24_VAT,
        },
        requiredLanguages: [],
        structuredBlock: null,
      },
    ],
  },

  einvoicing: {
    adapterKey: "uae_peppol",
    model: "peppol_network",
    standard: {
      value: "PINT AE (the UAE specialisation of the OpenPeppol PINT standard)",
      source: MOF_GUIDELINES,
    },
    instruments: {
      value: [
        "Cabinet Decision No. 106 of 2025",
        "Ministerial Decision No. 243 of 2025 (scope and exclusions, Article 4)",
        "Ministerial Decision No. 244 of 2025 (phased implementation and the voluntary phase)",
      ],
      source: MOF_GUIDELINES,
    },
    requiredCredentials: ["country.credential.ae_participant_id"],
    requiredProviders: ["country.provider.ae_asp"],
    phaseDates: {
      value: null,
      source: NOT_PUBLISHED_AS_TEXT,
      note: "The Ministry publishes its timeline as an image and the decision could not be read as text, so no date is encoded. Activation is an explicit, dated decision the organisation makes.",
      requiresReview: true,
    },
  },

  privacy: {
    regime: {
      value: "Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data",
      source: {
        authority: "UAE government portal",
        document: "Data protection law listing",
        url: "https://u.ae/",
        retrieved: "2026-09-03",
        tier: "official-summary",
        evidence: "H29 part F",
      },
      requiresReview: true,
    },
    authority: "UAE Data Office",
    crossBorderRegime: {
      value: null,
      source: {
        authority: "UAE government portal",
        document: "Cross-border transfer provisions",
        retrieved: "2026-09-03",
        tier: "unverified",
        evidence: "H29 part F",
      },
      note: "Not researched in H29. Nothing in the product asserts a transfer basis.",
    },
    organisationActions: [
      "country.privacy_action.lawful_basis",
      "country.privacy_action.processor_agreement",
      "country.privacy_action.cross_border_review",
    ],
  },

  requiredConfiguration: [
    {
      key: "trn",
      labelKey: "country.identifier.ae_trn",
      why: "A tax invoice must carry the supplier's TRN.",
    },
    {
      key: "address",
      labelKey: "country.config.address",
      why: "A tax invoice must carry the supplier's address.",
    },
    {
      key: "working_days",
      labelKey: "country.config.working_days",
      why: "The law fixes a count of rest days, not a day; the contract fixes the day.",
    },
  ],

  knownLimitations: [
    "country.limit.ae_no_phase_date",
    "country.limit.ae_asp_required",
    "country.limit.ae_no_professional_review",
    "country.limit.ae_no_filing",
  ],

  changeHistory: ["2026-09-03: first version, assembled from the H23 and H24 evidence logs."],
};
