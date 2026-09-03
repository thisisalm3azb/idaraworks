# H29 — evidence log

Every rule H29 implements is listed here with its source, the date it was
retrieved and the verification tier it was given. The tiers are the ones H23
and H24 established:

- **verified-primary** — read in the official legal text or the authority's own
  technical standard.
- **official-summary** — read on the authority's own website, but not in the
  legal instrument itself.
- **unverified** — could not be confirmed from an official source. Encoded as
  configuration only; the product asserts nothing and requires a person to set
  or review it.

Nothing in this log is legal, tax or payroll advice, and no entry means
IdaraWorks is certified or compliant. Where a rule is ambiguous,
organisation-specific or changing, the pack carries configuration and a review
flag instead of a number.

H23 (`docs/H23-EVIDENCE-LOG.md`) and H24 (`docs/H24-EVIDENCE-LOG.md`) remain
the evidence for the UAE labour and UAE VAT/Corporate Tax rules. H29 reuses
them and does not restate or re-derive them.

---

## A. Saudi Arabia — VAT

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| A1 | Standard VAT rate **15%** | ZATCA, Value Added Tax Framework (`zatca.gov.sa/en/RulesRegulations/VAT`) | 2026-09-03 | official-summary |
| A2 | Mandatory registration threshold **SAR 375,000** of taxable supplies over 12 months; voluntary registration from **SAR 187,500** | ZATCA, VAT framework and VAT registration pages | 2026-09-03 | official-summary |
| A3 | **Tax period is monthly** where the annual value of taxable supplies exceeded **SAR 40,000,000** in the previous twelve months; **three months** for all other taxpayers | ZATCA, *Implementing Regulations of the VAT Law* (English PDF), article on Tax Period | 2026-09-03 | verified-primary |
| A4 | **Tax invoice contents** — date of issue; sequential unique number; supplier's Tax Identification Number; the customer's TIN and a self-accounting statement where the customer must self-account; name and address of supplier and customer; quantity and nature of goods or scope and nature of services; date of supply where it differs from the issue date; taxable amount per rate or exemption, unit price excluding VAT and any discounts not included in it; the rate of tax applied; the amount of tax payable **shown in SAR**; a narration explaining the treatment where tax is not charged at the basic rate; and a profit-margin reference where that method is applied | ZATCA, *Implementing Regulations of the VAT Law*, Article 53(5) | 2026-09-03 | verified-primary |
| A5 | **Tax invoices must show these details in Arabic**, in addition to any other language shown as a translation | ZATCA, *Implementing Regulations of the VAT Law*, Article 53(5) opening words | 2026-09-03 | verified-primary |
| A6 | **Simplified tax invoice contents** — date of issue; name, address and TIN of the supplier; a description of the goods or services; the consideration payable; the tax payable or a statement that the consideration is tax-inclusive | ZATCA, *Implementing Regulations of the VAT Law*, Article 53(8) | 2026-09-03 | verified-primary |

## B. Saudi Arabia — electronic invoicing (ZATCA / Fatoora)

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| B1 | Phase 1 (generation) from **4 December 2021**; Phase 2 (integration) from **1 January 2023**, rolled out in waves | ZATCA E-Invoicing pages | 2026-09-03 | official-summary |
| B2 | The invoice is **UBL 2.1 XML** (`urn:oasis:names:specification:ubl:schema:xsd:Invoice-2`), aligned to EN 16931 | ZATCA, *Electronic Invoice XML Implementation Standard* v1.2 | 2026-09-03 | official-summary |
| B3 | **Standard tax invoices are cleared** (submitted to ZATCA before delivery to the buyer); **simplified tax invoices are reported** after issuance | ZATCA, *E-invoicing Detailed Technical Guidelines* | 2026-09-03 | official-summary |
| B4 | The **cryptographic stamp** follows XAdES digital signatures under ETSI EN 319 132-1; a PDF/A-3 signature dictionary uses `ETSI.CAdES.detached` | ZATCA, *Electronic Invoice Security Features Implementation Standards* v1.2 | 2026-09-03 | verified-primary |
| B5 | The **previous invoice hash (PIH)** is produced by the same transform as the cryptographic stamp, using **SHA-256** | ZATCA, *Security Features Implementation Standards* v1.2 §3 | 2026-09-03 | verified-primary |
| B6 | **QR code**: Base64-encoded, up to 700 characters, fields encoded **Tag-Length-Value**; tag in one byte, length as an unsigned 8-bit integer, value UTF-8; the byte array is then Base64-encoded and rendered as the QR image | ZATCA, *Security Features Implementation Standards* v1.2 §4.1 | 2026-09-03 | verified-primary |
| B7 | **QR tags, in order**: 1 seller name; 2 VAT registration number of the seller; 3 timestamp of the invoice (ISO 8601); 4 invoice total with VAT; 5 VAT total — enforced from 4 December 2021. Then 6 hash of the XML invoice (SHA-256, 32 bytes); 7 ECDSA signature of the XML hash; 8 ECDSA public key extracted from the signing private key; 9 for **simplified** tax invoices and their notes, the ECDSA signature of the cryptographic stamp's public key — enforced from 1 January 2023 | ZATCA, *Security Features Implementation Standards* v1.2, Table 3 | 2026-09-03 | verified-primary |
| B8 | ZATCA's integration APIs are secured with **OAuth 2.0 (RFC 6749)**; the client id is the digital certificate issued during onboarding and the secret is issued with it | ZATCA, *Security Features Implementation Standards* v1.2 §5 | 2026-09-03 | verified-primary |
| B9 | Onboarding issues a **compliance CSID** and then a **production CSID**, with an OTP from the Fatoora portal | ZATCA, *E-invoicing Detailed Technical Guidelines* | 2026-09-03 | official-summary |
| B10 | An **invoice counter value (ICV)** increments per invoice and is protected from system users | ZATCA, *Security Features Implementation Standards* and technical guidelines | 2026-09-03 | official-summary |

## C. Saudi Arabia — employment and social insurance

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| C1 | **Working hours**: not more than 8 hours a day, or 48 hours a week | Ministry of Human Resources and Social Development, knowledge centre "Actual working hours" | 2026-09-03 | official-summary |
| C2 | **Ramadan**: actual working hours reduced for Muslims to not more than 6 hours a day or 36 hours a week | MHRSD knowledge centre | 2026-09-03 | official-summary |
| C3 | **Weekly rest day is Friday**, replaceable by another day for certain work on notice to the competent labour office | MHRSD, work organisation (working hours and weekly rest) | 2026-09-03 | official-summary |
| C4 | **Annual leave**: not less than 21 days, rising to not less than 30 days after five consecutive years with the same employer, paid in advance | MHRSD knowledge centre, holidays and leaves | 2026-09-03 | official-summary |
| C5 | **End-of-service award**: half a month's wage for each of the first five years and one month's wage for each following year, calculated on the **last wage**, pro-rated for part years | MHRSD, end-of-service award regulations (Labour Law Royal Decree M/51, Art 84) | 2026-09-03 | official-summary |
| C6 | **Resignation scale**: one third of the award after two but not more than five consecutive years; two thirds above five and below ten; the full award at ten years or more | MHRSD, end-of-service award regulations (Art 85) | 2026-09-03 | official-summary |
| C7 | **GOSI annuities**: 18% of the contributory wage — 9% employer, 9% contributor (Saudi nationals) | General Organization for Social Insurance, contributions pages | 2026-09-03 | official-summary |
| C8 | **GOSI occupational hazards**: 1.5% of the wage, paid by the employer alone, mandatory for Saudis and non-Saudis | GOSI, occupational hazard branch | 2026-09-03 | official-summary |
| C9 | **SANED unemployment insurance**: 1.5% of the contributory wage, borne equally by the employer and the contributor (0.75% each) from 1 January 2022 | GOSI, unemployment insurance (SANED) | 2026-09-03 | official-summary |
| C10 | The contributory-wage **ceiling and floor**, and the 2024 pension-reform transition for new entrants | **not verified** from an official page during H29 | 2026-09-03 | unverified — organisation configuration, never auto-applied |
| C11 | What counts as the **"wage"** base for the end-of-service award (basic only or basic plus regular allowances) | Labour Law definitions read broadly; **not resolved** to a single product default | 2026-09-03 | unverified — explicit configuration with a review flag |

## D. Saudi Arabia — address, identity and privacy

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| D1 | The **National Address** has six parts: building number, street name, district, city, postal code and the additional (secondary) number; the postal code is five digits and each building carries both a building number and an additional number | Saudi National Address (`address.gov.sa`) and Saudi Post (SPL) | 2026-09-03 | official-summary |
| D2 | **Personal Data Protection Law** issued by Royal Decree M/19 (9/2/1443H), amended by M/148 (5/9/1444H), in force from 14 September 2023; the competent authority is **SDAIA**; separate regulations govern transfer of personal data outside the Kingdom, standard contractual clauses and binding common rules | SDAIA data-governance portal and published regulations | 2026-09-03 | official-summary |

## E. United Arab Emirates — electronic invoicing

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| E1 | The UAE eInvoicing model is a **decentralised five-corner model**: corner 1 supplier, corner 2 the supplier's UAE Accredited Service Provider, corner 3 the buyer's Accredited Service Provider, corner 4 the buyer, corner 5 the Federal Tax Authority | Ministry of Finance, *UAE Electronic Invoicing Guidelines* v1.1 (1 June 2026) and the MoF eInvoicing initiative page | 2026-09-03 | verified-primary |
| E2 | The data format is **PINT AE**, the UAE specialisation of the OpenPeppol PINT standard | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |
| E3 | Electronic invoicing is **mandatory for any Person conducting business in the UAE regardless of VAT registration status**, unless excluded under Article 4 of **Ministerial Decision No. 243 of 2025** | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |
| E4 | The legal instruments are **Cabinet Decision No. 106 of 2025**, **Ministerial Decision No. 243 of 2025** (scope and exclusions) and **Ministerial Decision No. 244 of 2025** (phased implementation plan and the voluntary phase) | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |
| E5 | The **Participant Identifier / TIN is the first ten digits of the TRN**; a person in scope who is not required to register for a tax must still register with the FTA to obtain a TIN | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |
| E6 | The roll-out **commences with a voluntary onboarding phase** in which a person may exchange and report electronic invoices without penalty exposure; MD 244 of 2025 sets out how to participate | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |
| E7 | The **phase dates and taxpayer bands** in MD 244 of 2025 | The decision's own PDF could not be read as text, and the MoF timeline is published as an image | 2026-09-03 | **unverified** — the pack carries no dates; activation is an explicit, dated organisation decision |
| E8 | Documents in scope include tax invoices, tax credit notes and self-billing; margin-scheme supplies do not display the VAT amount even though PINT AE carries VAT information; a negative payable total must be a credit note, not a negative invoice | MoF, *UAE Electronic Invoicing Guidelines* v1.1 | 2026-09-03 | verified-primary |

## F. Standards

| # | Rule | Source | Retrieved | Tier |
| --- | --- | --- | --- | --- |
| F1 | Country codes are **ISO 3166-1 alpha-2**; currency codes and minor units are **ISO 4217**; language codes are **ISO 639-1**; the platform already encodes the three-decimal Gulf currencies | Existing platform registry (`src/platform/registries.ts`), frozen 2026-07-11 | 2026-09-03 | reused, not re-derived |
| F2 | **IBAN** structure and the mod-97 check are **ISO 13616**; the per-country length comes from the pack, not from a global table | ISO 13616 as implemented; per-country lengths recorded in each pack with their own citation | 2026-09-03 | see each pack |
| F3 | Timezones are IANA identifiers (`Asia/Dubai`, `Asia/Riyadh`) | IANA time zone database as shipped with the runtime | 2026-09-03 | reused |

## G. What H29 deliberately did not implement

| Area | Why |
| --- | --- |
| Any Spanish-speaking country pack | Spanish is a language in H29, not a jurisdiction. No Spain, Mexico or Latin American tax, payroll or invoicing rule was researched or written, and the product says so where a country pack would be required. |
| UAE e-invoicing submission | The UAE model requires an Accredited Service Provider. None is appointed and no credential exists, so the UAE channel is declared and disabled. |
| ZATCA submission | No sandbox or production CSID exists. The adapter is contract-tested against the published standards with deterministic fixtures and cannot submit. |
| Cryptographic stamping with a real device | Signing requires a certificate issued through ZATCA onboarding, which is an owner action. The stamping seam is defined and refuses without a credential. |
| Any filing, return submission or authority notification | Out of scope in every phase so far and restated here. |
| Contributory-wage ceilings, the GOSI 2024 transition, and the end-of-service wage base | Not verified from an official page; configuration with a review flag rather than an invented number. |
