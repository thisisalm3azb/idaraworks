/**
 * H29 — the Kingdom of Saudi Arabia pack, version SA-2026-09-03.
 *
 * Every rule below is recorded in docs/H29-EVIDENCE-LOG.md parts A–D with its
 * source, retrieval date and verification tier. Where an official source could
 * not be found — the GOSI contributory-wage ceiling, the 2024 pension
 * transition, the end-of-service wage base — the pack carries configuration and
 * a review flag rather than a number.
 *
 * This pack does not claim ZATCA, VAT, labour or PDPL compliance. Its
 * electronic-invoicing declaration describes the regime; the adapter that
 * implements it cannot submit anything without credentials the organisation
 * must obtain itself.
 */
import type { CountryPack, SourceRef } from "../types";

const VAT_REGS: SourceRef = {
  authority: "Zakat, Tax and Customs Authority (ZATCA)",
  document: "Implementing Regulations of the Value Added Tax Law",
  url: "https://zatca.gov.sa/en/RulesRegulations/Taxes/Documents/Implmenting%20Regulations%20of%20the%20VAT%20Law_EN.pdf",
  retrieved: "2026-09-03",
  tier: "verified-primary",
  evidence: "A3–A6",
};

const VAT_FRAMEWORK: SourceRef = {
  authority: "Zakat, Tax and Customs Authority (ZATCA)",
  document: "Value Added Tax framework and registration pages",
  url: "https://zatca.gov.sa/en/RulesRegulations/VAT/Pages/default.aspx",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "A1, A2",
};

const SECURITY_STD: SourceRef = {
  authority: "Zakat, Tax and Customs Authority (ZATCA)",
  document: "Electronic Invoice Security Features Implementation Standards",
  locator: "version 1.2",
  url: "https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/E-Invoice-specifications.aspx",
  retrieved: "2026-09-03",
  tier: "verified-primary",
  evidence: "B4–B8",
};

const XML_STD: SourceRef = {
  authority: "Zakat, Tax and Customs Authority (ZATCA)",
  document: "Electronic Invoice XML Implementation Standard",
  locator: "version 1.2",
  url: "https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/E-Invoice-specifications.aspx",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "B2, B3",
};

const MHRSD: SourceRef = {
  authority: "Ministry of Human Resources and Social Development",
  document: "Labour Law knowledge centre (Royal Decree M/51)",
  url: "https://www.hrsd.gov.sa/en/knowledge-centre",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "C1–C6",
};

const GOSI: SourceRef = {
  authority: "General Organization for Social Insurance (GOSI)",
  document: "Contribution, occupational hazard and SANED pages",
  url: "https://www.gosi.gov.sa/GOSIOnline/Contribution_&locale=en_US",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "C7–C9",
};

const NATIONAL_ADDRESS: SourceRef = {
  authority: "Saudi National Address (Saudi Post / SPL)",
  document: "Address format",
  url: "https://address.gov.sa/en/address-format/overview",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "D1",
};

const SDAIA: SourceRef = {
  authority: "Saudi Data & AI Authority (SDAIA)",
  document: "Personal Data Protection Law and its implementing regulations",
  url: "https://sdaia.gov.sa/en/SDAIA/about/Documents/ImplementingRegulationPersonalDataProtectionLaw.pdf",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "D2",
};

const ISO_13616: SourceRef = {
  authority: "ISO / SWIFT IBAN registry",
  document: "ISO 13616 IBAN structure",
  locator: "SA",
  retrieved: "2026-09-03",
  tier: "official-summary",
  evidence: "F2",
};

const UNVERIFIED: SourceRef = {
  authority: "—",
  document: "No official source located during H29",
  retrieved: "2026-09-03",
  tier: "unverified",
  evidence: "C10, C11",
};

export const SA_PACK: CountryPack = {
  packKey: "SA-2026-09-03",
  country: "SA",
  jurisdiction: "Kingdom of Saudi Arabia",
  version: "2026-09-03",
  status: "approved",
  effectiveFrom: "2026-09-03",
  effectiveTo: null,
  supersedes: null,
  owner: "platform",
  reviews: [
    { kind: "internal", state: "passed", note: "Built from ZATCA, MHRSD, GOSI and SDAIA sources." },
    {
      kind: "professional",
      state: "not_started",
      note: "No Saudi tax or labour professional has reviewed this pack.",
    },
    {
      kind: "native_language",
      state: "not_started",
      note: "Arabic legal terminology has not been reviewed by a native reviewer.",
    },
    {
      kind: "provider",
      state: "not_started",
      note: "No ZATCA compliance or production CSID has been obtained.",
    },
  ],
  supportedLanguages: ["ar", "en"],

  format: {
    currency: "SAR",
    currencyExponent: 2,
    defaultTimezone: "Asia/Riyadh",
    documentLanguages: ["ar", "en"],
    requiredDocumentLanguages: {
      value: ["ar"],
      source: VAT_REGS,
      note: "A tax invoice must show the required details in Arabic; another language may appear as a translation (Art 53(5)).",
    },
    hijriDisplay: true,
  },

  week: {
    weekStartsOn: "sun",
    defaultWorkingDays: ["sun", "mon", "tue", "wed", "thu"],
    statutoryRestDays: {
      value: ["fri"],
      source: MHRSD,
      note: "Friday is the weekly rest day, replaceable for certain work on notice to the competent labour office. Saturday is customary, not statutory.",
    },
    minimumRestDaysPerWeek: { value: 1, source: MHRSD },
    standardDailyHours: {
      value: 8,
      source: MHRSD,
      note: "Six hours a day, or 36 a week, for Muslim workers during Ramadan.",
    },
    standardWeeklyHours: { value: 48, source: MHRSD },
  },

  address: {
    source: NATIONAL_ADDRESS,
    fields: [
      {
        key: "buildingNumber",
        labelKey: "country.address.building_number",
        required: true,
        pattern: "^[0-9]{4}$",
        maxLength: 4,
        example: "8228",
      },
      { key: "street", labelKey: "country.address.street", required: true, maxLength: 120 },
      { key: "district", labelKey: "country.address.district", required: true, maxLength: 80 },
      { key: "city", labelKey: "country.address.city", required: true, maxLength: 80 },
      {
        key: "postalCode",
        labelKey: "country.address.postal_code",
        required: true,
        pattern: "^[0-9]{5}$",
        maxLength: 5,
        example: "12345",
      },
      {
        key: "additionalNumber",
        labelKey: "country.address.additional_number",
        required: false,
        pattern: "^[0-9]{4}$",
        maxLength: 4,
        example: "2727",
      },
    ],
    documentLayout: [
      ["buildingNumber", "street"],
      ["district", "city"],
      ["postalCode", "additionalNumber"],
    ],
  },

  identifiers: [
    {
      key: "vat_number",
      kind: "tax_registration",
      labelKey: "country.identifier.sa_vat",
      authority: "Zakat, Tax and Customs Authority",
      pattern: "^3[0-9]{13}3$",
      length: 15,
      required: false,
      source: VAT_FRAMEWORK,
    },
    {
      key: "commercial_registration",
      kind: "commercial_registration",
      labelKey: "country.identifier.sa_cr",
      authority: "Ministry of Commerce",
      pattern: "^[0-9]{10}$",
      length: 10,
      required: false,
      source: {
        authority: "Ministry of Commerce",
        document: "Commercial registration number shape as used on Saudi tax documents",
        retrieved: "2026-09-03",
        tier: "unverified",
        evidence: "H29 assumption G3",
      },
    },
    {
      key: "gosi_establishment",
      kind: "payroll_establishment",
      labelKey: "country.identifier.sa_gosi",
      authority: "General Organization for Social Insurance",
      required: false,
      source: GOSI,
    },
  ],

  banking: {
    ibanLength: 24,
    ibanPrefix: "SA",
    localIdentifiers: [],
    source: ISO_13616,
  },

  tax: [
    {
      key: "vat",
      labelKey: "country.tax.vat",
      engineVersion: null,
      standardRatePercent: { value: 15, source: VAT_FRAMEWORK },
      registrationThresholds: {
        value: { mandatory: 375_000, voluntary: 187_500 },
        source: VAT_FRAMEWORK,
        note: "Shown as guidance in SAR. Registration is never inferred from turnover.",
      },
      periodRule: {
        value:
          "Monthly where taxable supplies exceeded SAR 40,000,000 in the previous twelve months; three months for every other taxpayer.",
        source: VAT_REGS,
      },
      documentFields: {
        value: [
          "date_of_issue",
          "sequential_unique_number",
          "supplier_tax_identification_number",
          "customer_tin_and_self_accounting_statement_where_applicable",
          "supplier_and_customer_name_and_address",
          "quantity_and_nature_of_goods_or_scope_of_services",
          "date_of_supply_where_different",
          "taxable_amount_per_rate_or_exemption",
          "unit_price_excluding_vat",
          "discounts_not_in_unit_price",
          "rate_of_tax",
          "amount_of_tax_payable_in_sar",
          "narration_where_not_charged_at_the_basic_rate",
          "profit_margin_reference_where_applied",
        ],
        source: VAT_REGS,
      },
      requiresConfiguration: [
        "country.item.registration_status",
        "country.item.tax_period_choice",
        "country.item.supply_treatment",
      ],
    },
  ],

  payroll: {
    engineVersion: null,
    endOfService: {
      value: {
        bands: [
          { uptoYears: 5, daysPerYear: 15 },
          { uptoYears: null, daysPerYear: 30 },
        ],
        base: "configured",
        proRataPartialYears: true,
        resignationScale: [
          { fromYears: 2, toYears: 5, fraction: 1 / 3 },
          { fromYears: 5, toYears: 10, fraction: 2 / 3 },
          { fromYears: 10, toYears: null, fraction: 1 },
        ],
      },
      source: MHRSD,
      requiresReview: true,
      note: "Half a month's wage for each of the first five years and one month for each following year, on the last wage, pro-rated. What counts as the wage is not resolved to a product default: the organisation configures it and a reviewer approves the working paper.",
    },
    statutoryContributions: [
      {
        value: {
          key: "gosi_annuities",
          labelKey: "country.payroll.sa_annuities",
          employerPercent: 9,
          employeePercent: 9,
          appliesTo: "nationals",
          ceiling: null,
          floor: null,
        },
        source: GOSI,
        note: "18% of the contributory wage in total. The contributory-wage ceiling is organisation configuration.",
      },
      {
        value: {
          key: "gosi_occupational_hazards",
          labelKey: "country.payroll.sa_hazards",
          employerPercent: 1.5,
          employeePercent: 0,
          appliesTo: "all",
          ceiling: null,
          floor: null,
        },
        source: GOSI,
        note: "Paid by the employer alone, for Saudis and non-Saudis.",
      },
      {
        value: {
          key: "saned",
          labelKey: "country.payroll.sa_saned",
          employerPercent: 0.75,
          employeePercent: 0.75,
          appliesTo: "nationals",
          ceiling: null,
          floor: null,
        },
        source: GOSI,
        note: "1.5% of the contributory wage, borne equally, from 1 January 2022.",
      },
      {
        value: {
          key: "contributory_wage_bounds",
          labelKey: "country.payroll.sa_wage_bounds",
          employerPercent: null,
          employeePercent: null,
          appliesTo: "configured",
          ceiling: null,
          floor: null,
        },
        source: UNVERIFIED,
        requiresReview: true,
        note: "The ceiling, the floor and the 2024 pension transition for new entrants could not be confirmed from an official page. Nothing is applied until the organisation sets them.",
      },
    ],
    annualLeave: {
      value: { minimumDays: 21, afterYearsDays: [[5, 30]] },
      source: MHRSD,
      note: "Not less than 21 days, rising to not less than 30 after five consecutive years with the same employer, paid in advance.",
    },
    paymentSeams: [
      {
        key: "wps_export",
        labelKey: "country.payroll.sa_wps",
        note: "A payment-file export seam. It is not a Wage Protection System certification and claims none.",
      },
    ],
    requiresConfiguration: [
      "country.item.eos_wage_base",
      "country.item.gosi_bounds",
      "country.item.annuities_saned",
    ],
  },

  documents: {
    kinds: [
      {
        kind: "tax_invoice",
        requiredFields: {
          value: [
            "date_of_issue",
            "sequential_unique_number",
            "supplier_tax_identification_number",
            "supplier_and_customer_name_and_address",
            "taxable_amount_per_rate",
            "rate_of_tax",
            "amount_of_tax_payable_in_sar",
          ],
          source: VAT_REGS,
        },
        requiredLanguages: ["ar"],
        structuredBlock: "zatca_qr",
      },
      {
        kind: "simplified_tax_invoice",
        requiredFields: {
          value: [
            "date_of_issue",
            "supplier_name_address_and_tin",
            "description_of_goods_or_services",
            "consideration_payable",
            "tax_payable_or_tax_inclusive_statement",
          ],
          source: VAT_REGS,
        },
        requiredLanguages: ["ar"],
        structuredBlock: "zatca_qr",
      },
      {
        kind: "tax_credit_note",
        requiredFields: {
          value: ["reference_to_original_invoice", "reason", "amount_of_tax_payable_in_sar"],
          source: VAT_REGS,
        },
        requiredLanguages: ["ar"],
        structuredBlock: "zatca_qr",
      },
    ],
  },

  einvoicing: {
    adapterKey: "zatca",
    model: "clearance",
    standard: {
      value:
        "UBL 2.1 XML aligned to EN 16931, stamped with a XAdES cryptographic stamp (ETSI EN 319 132-1)",
      source: SECURITY_STD,
    },
    instruments: {
      value: [
        "E-Invoicing Regulation and its Controls, Requirements, Technical Specifications and Procedural Rules",
        "Electronic Invoice XML Implementation Standard v1.2",
        "Electronic Invoice Security Features Implementation Standards v1.2",
      ],
      source: XML_STD,
    },
    requiredCredentials: [
      "country.credential.sa_compliance_csid",
      "country.credential.sa_production_csid",
    ],
    requiredProviders: ["country.provider.sa_onboarding"],
    phaseDates: {
      value: [
        { label: "Phase 1 (generation)", on: "2021-12-04" },
        { label: "Phase 2 (integration)", on: "2023-01-01" },
      ],
      source: {
        authority: "Zakat, Tax and Customs Authority (ZATCA)",
        document: "E-Invoicing programme pages",
        url: "https://zatca.gov.sa/en/E-Invoicing/Pages/default.aspx",
        retrieved: "2026-09-03",
        tier: "official-summary",
        evidence: "B1",
      },
      note: "Phase 2 is rolled out in waves by taxpayer size; which wave an organisation falls in is notified by ZATCA and is not inferred here.",
    },
  },

  privacy: {
    regime: {
      value:
        "Personal Data Protection Law, Royal Decree M/19 (amended by M/148), in force from 14 September 2023",
      source: SDAIA,
      requiresReview: true,
    },
    authority: "Saudi Data & AI Authority (SDAIA)",
    crossBorderRegime: {
      value:
        "Regulation on Personal Data Transfer outside the Kingdom, with standard contractual clauses and binding common rules",
      source: SDAIA,
      requiresReview: true,
    },
    organisationActions: [
      "country.privacy_action.controller_registration",
      "country.privacy_action.lawful_basis_purpose",
      "country.privacy_action.transfer_review",
    ],
  },

  requiredConfiguration: [
    {
      key: "vat_number",
      labelKey: "country.identifier.sa_vat",
      why: "A tax invoice must carry the supplier's tax identification number.",
    },
    {
      key: "address",
      labelKey: "country.config.address",
      why: "A tax invoice must carry the supplier's address, and the National Address has a published shape.",
    },
    {
      key: "arabic_template",
      labelKey: "country.config.arabic_template",
      why: "The required details of a tax invoice must appear in Arabic.",
    },
    {
      key: "eos_wage_base",
      labelKey: "country.config.eos_wage_base",
      why: "The wage base for the end-of-service award is not resolved to a product default.",
    },
  ],

  knownLimitations: [
    "country.limit.sa_no_credential",
    "country.limit.sa_no_stamp",
    "country.limit.sa_configuration",
    "country.limit.sa_no_professional_review",
    "country.limit.sa_no_filing",
  ],

  changeHistory: [
    "2026-09-03: first version, from ZATCA, MHRSD, GOSI, National Address and SDAIA sources.",
  ],
};
