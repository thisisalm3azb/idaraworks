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
| ADR-70 | **Historical reproducibility by snapshot, not by re-derivation.** Anything issued already carries the version that produced it (H23 payroll snapshots, H24 tax entries, H26 issued documents), and H29 rewrites none of them. **Amended during the build:** H29 does NOT stamp the resolved pack version onto new business records. Asking which version produced an invoice is answered by resolving the establishment's adoption history for that invoice's date. Stamping a column would touch the write path of every money module and was not a change to make at the end of a phase; the report states the difference in §2.2 rather than implying it away. |
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

### I.1 Slices, in the order they were built

| Slice | What it added | Migrations |
| --- | --- | --- |
| H29A | The country-pack substrate (`src/platform/country/`), the UAE and Saudi packs, the establishment and its registrations, pack adoption, the readiness computation | 0130 |
| H29B | One electronic-invoicing framework with ZATCA and UAE PINT adapters, both fail-closed; privacy metadata per establishment | 0131 |
| H29C | The Spanish catalogue in full; the offered-locale gate; translation governance | 0132 |
| H29D | The operator language-release centre (`/platform/languages`) | — |
| H29E | The Country Readiness Centre, the establishment editor, the version timeline and the rule impact simulator; the shipped pack rows | 0133 |

### I.2 Decisions taken during the build, beyond Part E

| # | Decision | Why |
| --- | --- | --- |
| I.2.1 | **The `country_pack` table carries only what the database must reason about** — which versions exist, their country, and their validity window — while the registry in code stays the source of truth for content. | 0130 created the table but no rows, so the first adoption failed on a foreign key. The fix could have been to drop the table and keep everything in code, but then the non-overlap rule would be an assertion in TypeScript rather than an exclusion constraint, and the reviews would have nowhere to live. Adding a pack version is now a two-part release, and an integration test fails if the two halves disagree. |
| I.2.2 | **A language being offered is separate from a language having a catalogue.** `SUPPORTED_LOCALES` is the registry every catalogue and test is checked against; `offeredLocales()` is what the switcher shows. | The catalogue can be complete while the native review the mandate requires is still outstanding. Conflating the two would mean either shipping an unreviewed language or keeping the catalogue out of the registry and therefore out of the tests. |
| I.2.3 | **Copy that lists the interface languages takes them as an ICU variable.** | Several marketing and onboarding strings said "Arabic and English" in prose. That was true only while there were exactly two; the day a third is released those sentences become false claims in three catalogues at once. `Intl.DisplayNames` plus `Intl.ListFormat` name and join them in the reader's own language. |
| I.2.4 | **Spanish is a product language, not a document-issuance language.** `DOC_LANGUAGES` stays `en / ar / bilingual`. | No shipped country pack requires or permits Spanish documents, and the issuer identity has no Spanish address field. Adding Spanish to document issuance would be a claim about jurisdictions H29 has no pack for. The renderer does carry a `[lang="es"]` font rule, so customer-authored Spanish inside a document renders in a Latin face rather than falling through to the Arabic one. |
| I.2.5 | **The language switcher became a list, and in the workspace header a menu.** | A two-way toggle cannot express three languages: a single button labelled "العربية" says nothing about where Spanish went. |
| I.2.6 | **`ar.same.json` was created alongside `es.same.json`.** | Twenty-five Arabic strings are byte-identical to their English ones. Nineteen are explained by the shared-token rule (product names, standard acronyms, bare placeholders); six were reviewed by hand and recorded (a keyboard shortcut, a bilingual document's own English sample title, and strings that are only punctuation and placeholders). Without the record, the leakage test could only be run for the newest locale. |
| I.2.7 | **The adoption history is paged; the establishment list is not.** | Adoptions are insert-only and accumulate for the life of an establishment. Establishments are bounded by design, the way teams and templates are, and readiness has to be computed across all of them at once. |

### I.3 Defects found and fixed during the build

| Defect | How it surfaced | Fix |
| --- | --- | --- |
| `country_pack` had no rows, so `adoptPack` failed on `establishment_pack_adoption_pack_key_fkey`. | The first integration run of the adoption path. | Migration 0133 seeds the shipped versions and their review records; an integration test asserts registry/table parity. |
| `jobs.limit_reached` renders a literal `{jobs}` under Arabic if the call site ever stops passing it. | The new ICU-argument parity test. | Recorded as the one documented exception, naming its call site, so the test protects the invariant rather than being weakened. |
| The Arabic catalogue restructures plurals, so it legitimately uses fewer arguments than English. | The same test, at first written as strict equality. | The law became "no translation may invent an argument", with strict equality kept for Spanish, which preserves English's plural shape. |
| `home.gcc.n1`, `home.pricing.s2` and five other strings hard-coded the language pair. | Reading the catalogue for language claims while wiring the switcher. | Parameterised (I.2.3), with a test that fails if a marketing string ever names the pair literally again. |
| H29's seven new tenant tables shipped with no entry in the two-org bleed harness, so nothing proved their isolation. | CI's integration job, which the local run had not yet reached. | `tooling/scripts/seed-h29.ts` registers all seven; each seeder builds its own chain so none depends on another. The three platform tables stay outside the sweep by construction. |
| The ZATCA adapter emitted an empty previous-invoice-hash for a chain's first document, silently. | Reading the prepared payload while writing the integration suite. | The gap is reported on the document as `pih-initial-unknown`; the evidence log and the report carry it with its owner action. Inventing the value would have been a fabrication in a field an authority checks. |
| The readiness centre rendered English rules inside translated sentences, printed a literal `{credential}{provider}`, showed the raw locale code `ar` to a person, and named a registration by its storage key. | Reading the Spanish screenshots from the UI walk. A text-only check passed all four. | Everything a surface renders from a pack is a message key with copy in all three catalogues, enforced by a unit test. `needs_owner` and `needs_person` are retired — the item keys state the action themselves and so cannot lose an argument. |
| Five production guards read a verdict object as a boolean. `if (!guard(...))` could never refuse; `if (guard(...))` refused everything. | The second form, added to stop the plain migration runner reaching production, failed CI's "Apply all migrations" step. The first form had been latent since H28. | All five read `.ok` and print the reasons. Proved against four environments: production reads as production; the test project, CI's local stack and an empty environment do not. |

### I.3.1 The migration-runner accident

`tooling/scripts/migrate.ts` loads `.env.local`, which on a maintainer's machine
is **production**. It was run during this phase in the belief that it targeted
the TEST project, and H29's four migrations reached production before the
read-only pre-flight had been run.

What that did and did not do:

- **Did not** change any business data. The migrations create tables, functions,
  policies and grants, and seed platform metadata (two country-pack versions,
  their review records, three locale rows). No organisation, user, customer,
  job, invoice, approval or audit row was created, changed or deleted.
- **Left** all seven new tenant tables at zero rows, confirmed by direct count.
- **Put** production's schema ahead of its code, which is the normal
  expand-then-deploy order. No H29 surface exists in production until the code
  deploys and its flag is set.

The pre-flight was then run and reported CLEAR with the business counts intact.
The hazard itself is fixed: the plain runner now refuses when the environment
points at production and names `migrate-prod.ts`, which prints the target and
the exact pending files and demands a phrase containing the project reference.
CI is unaffected — neither its local stack nor the test project is production.

### I.4 What was not built, and why

| Not built | Reason |
| --- | --- |
| Spanish as a document-issuance language | I.2.4. No pack requires it; adding it would imply a jurisdiction claim. |
| A Spanish-speaking country pack | The mandate forbids it: Spanish-language support does not create a Spain, Mexico or Latin American legal pack. |
| ZATCA submission, clearance or reporting | No credential exists. The adapter is contract-tested against the published standards with deterministic fixtures and stays `unavailable`. |
| UAE electronic-invoicing activation | No Accredited Service Provider is appointed and no phase date could be read from an official text (D2). |
| Conversion of historical accounting records, the H24 transition rulings, PO-002, the H22 stock-posting issue, H28 external AI activation | Explicitly out of scope in the mandate. Untouched. |
