# H29 — International Expansion and Versioned Country Packs: truth map

Written before any code changed, as the mandate requires. It records what is
already true, what the owner approved, what the primary sources say, what was
decided and, just as importantly, what H29 does not do.

Evidence for every implemented rule: `docs/H29-EVIDENCE-LOG.md`.
Owner direction: `phase2/14-POST-MVP-AMENDMENTS.md` §8.

---

## Part A. Baseline (read-only, 2026-09-03)

| Fact | Value |
| --- | --- |
| Branch | `main`, clean working tree |
| Head commit | `b4e953c` |
| Live production commit | `a49ca12` (`/api/health` reports it; commits after it are merged, green in CI and awaiting the hosting plan's daily deployment limit) |
| Migrations applied in production | 129 (`0001` … `0129_h28b_conversations_runs_actions.sql`) |
| Production health | `ok: true`, database and storage healthy, Inngest unconfigured |
| Feature flags in production | `FEATURE_FINANCE_SURFACES`, `FEATURE_HR_SURFACES`, `FEATURE_STOCK_SURFACES`, `FEATURE_MANAGEMENT_STUDIO`, `FEATURE_DOCUMENT_STUDIO`, `FEATURE_REVENUE_STUDIO` on; `FEATURE_IDARA_INTELLIGENCE` unset and no AI provider configured |
| Business data | 39 organisations, 60 users, 51 customers, 93 jobs, 78 invoices, 623 audit rows — untouched by H29's truth phase |

Phase reports read before starting: H23 (payroll and HR), H24 (accounting,
finance, banking, tax), H25 (Management Studio), H26 (Document Studio), H27
(CRM and Revenue Studio), H28 (Idara Intelligence), plus the north star, the
architecture rules and the amendments log.

## Part B. The approved mandate, condensed

The owner's direction is recorded verbatim in the amendments log §8. Its
binding points, in the form the build must satisfy:

1. **A reusable country-pack engine**, not country conditionals. Behaviour
   resolves through the active pack and the effective date.
2. **A complete UAE pack** that reuses and strengthens what H23 and H24 already
   built, rather than duplicating it.
3. **A Saudi pack** with sourced tax, payroll, address, banking and ZATCA
   foundations, with external submission safely disabled.
4. **Complete Spanish** for the universal product, honestly marked for native
   review, creating no Spanish-speaking country's legal pack.
5. **Continued complete English and Arabic**, re-audited across H22–H28.
6. **Effective-dated rules** with historical reproducibility: a pack update
   never rewrites an issued invoice, payroll run or working paper.
7. **Establishments**: an organisation may have more than one country, branch,
   tax registration and payroll establishment.
8. **Honest readiness**: technically configured, internally reviewed, provider
   connected, legally reviewed, pilot-ready and generally available are
   different states, never one percentage.
9. **No invented facts** and **no compliance claims**.
10. **Fail closed** on every external authority; nothing genuine is submitted.

## Part C. What already exists (reuse, never compete)

### C.1 Internationalisation seams

| Area | What exists today | H29 position |
| --- | --- | --- |
| Locales | `SUPPORTED_LOCALES = ["en","ar"]` in the closed registry; `t()` over ICU MessageFormat; two catalogues of **4,867 keys each**, key sets asserted identical by a unit test; direction derived from the locale; numerals pinned to Latin even under `ar` | Extend to `es`; the parity test extends to three catalogues |
| Currencies | Closed registry of eight currencies with ISO 4217 minor units (KWD/BHD/OMR at three decimals); amounts stored as bigint minor units; one shared money formatter | Reuse unchanged; the pack names the establishment's currency and precision |
| Exchange rates | `src/modules/finance/fx.ts` — recorded rates, never invented | Reuse unchanged; H29 invents no rate |
| Dates and times | `src/platform/format/datetime.ts` formats in an org timezone | **Defect**: the default parameter is the literal `"Asia/Dubai"`. H29 removes the silent UAE default |
| Organisation | `org` carries `country`, `timezone` (defaulting to `Asia/Dubai` in the schema), `base_currency`, `languages`, `working_week` | Kept as the organisation's own defaults; the establishment becomes the jurisdictional unit |
| Branch / establishment | **Does not exist**. No table models a legal establishment, a second registration or a second payroll establishment | New in H29 |
| Holidays | `org_holiday_calendar` per organisation, bilingual `{en, ar}` labels | Reused; H29 scopes a calendar to an establishment and adds `es` labels |
| Tax | `src/modules/finance/tax.ts` — a versioned tax engine with UAE VAT (`AE-VAT-2026-09-01`) and Corporate Tax (`AE-CT-2026-09-01`) packs, VAT201 box map, tax entries captured as facts, returns as reviewable working papers | Reused as the tax engine. The country pack **references** these pack versions; H29 writes no second tax engine |
| Payroll | `src/modules/payroll/packs/{types,ae}.ts` — a versioned UAE pack (working time, overtime, leave, gratuity, GPSSA, payment-export seam) with a three-tier verification convention | Reused as the payroll pack shape. H29 lifts the tier convention to the country pack and adds a Saudi pack alongside |
| Documents | H26 Document Studio: versioned templates, issued snapshots, real PDF rendering with Noto Sans and Noto Naskh Arabic embedded | Reused. `es` needs only a language rule and tests; the Latin font already carries Spanish diacritics |
| Banking | `src/modules/finance/banking.ts` — bank accounts with a free-text `iban` (max 40) | Reused; H29 adds pack-driven IBAN length and the ISO 13616 mod-97 check |
| Imports | `src/modules/imports/service.ts` | Reused; H29 adds explicit source date format and establishment context |
| Privacy | H28 built `ai_privacy_register` for AI providers | Its shape is the model for country privacy metadata; H29 does not move or duplicate data |
| Approvals, audit, permissions | The platform's approval engine, `command()` audit wrapper, `can()`/`assertCan()` matrix, RLS on every tenant table | Reused for pack adoption, reviews and establishment changes |

### C.2 Hard-coded assumptions found

| Assumption | Where | Disposition |
| --- | --- | --- |
| `"Asia/Dubai"` as a default | 13 occurrences across the date formatter, HR time, onboarding, workspace registry, identity and three pages | The formatter's silent default is removed; callers pass the establishment's timezone. Onboarding keeps it as a *suggested* default for a UAE organisation, which is a different thing |
| `country ?? "AE"` | `src/modules/docstudio/forms.ts` public form submissions | Resolved from the establishment instead |
| `"AE"` literals | 18 occurrences, mostly onboarding defaults and the payroll pack's own identity | Onboarding defaults stay (they are defaults, not rules); the pack identity is correct |
| `AED` literals | 41 occurrences, largely price catalogues and seed data | Out of scope: subscription pricing is a separate concern the mandate excludes |
| Emirate list | `src/modules/finance/tax.ts` VAT201 box map | Correct and stays: it is a UAE VAT rule, inside the UAE tax pack |
| Bilingual `{en, ar}` content columns and `_en`/`_ar` pairs | 36 jsonb sites plus item, warehouse and unit name columns | **Deliberately unchanged.** These hold *customer-entered* content, not product copy. H29 adds a third product language, not a third content column |

### C.3 Sources consulted

Recorded with retrieval dates and verification tiers in
`docs/H29-EVIDENCE-LOG.md`: ZATCA (VAT law implementing regulations, XML
implementation standard, security features standard, technical guidelines), the
UAE Ministry of Finance (Electronic Invoicing Guidelines v1.1 of 1 June 2026
and the eInvoicing initiative), the Saudi Ministry of Human Resources and
Social Development, GOSI, the Saudi National Address authority, SDAIA, and the
existing H23 and H24 evidence logs for the UAE labour and tax rules.

## Part D. Conflicts and gaps

| # | Conflict or gap | Resolution |
| --- | --- | --- |
| D1 | A secondary summary put the ZATCA QR tags in a different order (invoice counter at tag 6) than the authority's own standard (hash at tag 6). | The primary standard wins. Tags follow evidence-log entry B7, and the fixture tests pin them. |
| D2 | The UAE MoF publishes its implementation timeline as an image, and MD 244 of 2025 could not be read as text. | **No UAE phase dates are encoded anywhere.** The UAE e-invoicing channel carries the model, the standard and the legal instruments, and its activation date is an explicit organisation decision. |
| D3 | `org.country` exists but nothing scopes a *jurisdiction* below the organisation, while the mandate requires several establishments. | The establishment becomes the jurisdictional unit. `org.country` stays as the organisation's home country and its default for a first establishment. |
| D4 | The Saudi end-of-service base ("wage") is defined broadly in the Labour Law, and practice varies. | Not resolved to a product default. The Saudi pack carries the base as explicit configuration with a review flag, and the working paper shows which base produced the number. |
| D5 | GOSI's contributory-wage ceiling and the 2024 pension transition for new entrants could not be confirmed on an official page. | Encoded as unverified configuration. The engine never applies a ceiling the organisation has not set. |
| D6 | Saudi law requires tax-invoice details **in Arabic**; the Document Studio renders a chosen language. | The Saudi pack marks Arabic as a required document language for tax invoices, and the readiness centre blocks "ready" while a Saudi establishment has no Arabic invoice template. |
| D7 | Spanish is a language with many jurisdictions. | `es` is a product locale only. Every country-specific surface says plainly that a country pack does not exist for that jurisdiction. |
| D8 | The existing payroll pack lives inside the payroll module while H29 introduces a platform-level pack registry. | The country pack **references** the payroll pack by version rather than absorbing it, so H23's engine and its snapshots keep working untouched. |

## Part E. Decisions (ADR-66 onward)

| ADR | Decision |
| --- | --- |
| ADR-66 | **A country pack is code, its lifecycle is data.** Pack content is a typed, reviewed, testable definition in `src/platform/country/packs/`; the database records versions, status, effective dates, reviews and per-establishment adoption. Rejected: pack content as free-form rows, which would let an ordinary user edit a legal rule. |
| ADR-67 | **The establishment is the jurisdictional unit.** Country, registrations, addresses, currency, timezone, working week, holiday calendar, invoice identity, banking and pack adoption hang off it. An organisation with one establishment behaves exactly as it does today. |
| ADR-68 | **Resolution is always (establishment, date).** Every country-dependent answer comes from `resolvePack(establishment, on)`, which returns the version whose validity window contains that date, never "the latest". |
| ADR-69 | **Adoption is explicit and additive.** A new pack version does not apply to an establishment until an authorised person adopts it, from a date they choose, having seen an impact preview. Adoption rows are append-only. |
| ADR-70 | **Historical reproducibility by snapshot, not by re-derivation.** Anything issued already carries the version that produced it (H23 payroll snapshots, H24 tax entries, H26 issued documents). H29 adds the pack version to new records and never rewrites old ones. |
| ADR-71 | **The simulator reads, overlays and never writes.** It computes against a snapshot with a candidate pack overlaid, returns what would change and what would not, and can only be turned into a change through the normal governed adoption path. |
| ADR-72 | **One electronic-invoicing framework, per-country adapters.** Channel, environment, credential reference, lifecycle, idempotency, retry, evidence archive and kill switch are shared; ZATCA and UAE PINT are adapters. An adapter with no credential is *unavailable*, not *failing*. |
| ADR-73 | **Fail closed and never fabricate.** No adapter simulates an authority response. Without a credential the lifecycle stops at "not configured" and names the owner action. |
| ADR-74 | **Readiness is a set of named states, not a percentage.** Six independent states per establishment, each with its own evidence, and the centre shows blocking issues in words. |
| ADR-75 | **Spanish is added to the closed locale registry**, gated by `FEATURE_LOCALE_ES`, with a governance record that marks it machine-assisted and not yet natively reviewed. The switcher does not offer it until the flag is on. |
| ADR-76 | **Translation governance is data about catalogues, not a second catalogue.** Per-locale completeness, review states, reviewer, timestamp and machine-assisted flag live in one operator-visible table; the catalogues stay the single source of strings. |
| ADR-77 | **Identity and address validation is pack-driven and permissive.** A pack supplies the schema and the checks it can justify; anything it cannot justify is accepted as entered. Valid real-world addresses are never rejected for not matching a template. |
| ADR-78 | **Scripts are preserved.** Names and addresses keep the script they were entered in. Nothing transliterates Arabic into Latin or the reverse. |
| ADR-79 | **The UAE pack references the existing UAE tax and payroll packs**; it does not restate their rules. Its own content is the establishment-level material: address schema, registrations, banking, week, document rules and the e-invoicing declaration. |

## Part F. Legal and provider dependencies

| Dependency | State | Consequence |
| --- | --- | --- |
| ZATCA compliance / production CSID | Not provisioned | The Saudi e-invoicing channel cannot leave "not configured". Contract tests run against the published standards with deterministic fixtures |
| A UAE Accredited Service Provider | Not appointed | The UAE channel is declared and disabled |
| Professional tax review (UAE and Saudi) | Not obtained | Tax configuration is available and marked "not legally reviewed"; no return is filed and no advice is given |
| Professional labour/payroll review | Not obtained | Payroll produces labelled working papers; nothing is finalised on an unreviewed rule |
| Native Spanish review | Not obtained | `es` is marked machine-assisted throughout, and the governance record says so |
| Native Arabic legal-terminology review | Not obtained | Arabic tax and legal terms carry a review state rather than a claim |
| PDPL / UAE data-protection agreements | Not in place | Privacy metadata is descriptive. No data is moved or duplicated across regions |

## Part G. Assumptions stated

1. An organisation that never creates a second establishment keeps exactly its
   current behaviour, with a single implicit establishment derived from
   `org.country`, `org.timezone`, `org.base_currency` and `org.working_week`.
2. Adding `es` to the product does not add Spanish to customer-entered
   bilingual content columns; those keep the language the customer typed.
3. Saudi commercial-registration and VAT identifiers are validated for shape
   and check-digit where the shape is published, and accepted as entered
   otherwise.
4. The Saudi weekend defaults to Friday and Saturday, of which only **Friday**
   is cited as the statutory weekly rest day; Saturday is a configurable
   non-working day, not a legal claim.
5. Hijri dates are a **display** capability, not a second accounting calendar.
   Every stored business date stays Gregorian.

## Part H. Rules deliberately not implemented

Listed with reasons in the evidence log, Part G: any Spanish-speaking
country's legal pack; UAE or Saudi submission to an authority; cryptographic
stamping with a real device; any filing or return submission; contributory-wage
ceilings; the GOSI 2024 transition; and the end-of-service wage base.

## Part I. Implementation record

_Filled as the build proceeds._
