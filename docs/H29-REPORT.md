# H29 — International Expansion and Versioned Country Packs: delivery report

Status: **technical platform complete and merged; country and language
activation pending the owner reviews and providers listed in section 4.** The
production database carries H29's migrations and the production smoke passes
against it. The merged code is not yet the live build — see §3.6 — and that
changes nothing a user can see, because every H29 surface is behind a release
flag that is off. Nothing here files a tax return, submits an invoice to an
authority, or claims a legal, tax, labour, privacy or electronic-invoicing
certification.

Mandate: `phase2/14-POST-MVP-AMENDMENTS.md` §8 (owner direction, 2026-09-03).
Truth map: `docs/H29-TRUTH-MAP.md` (Parts A–I).
Evidence: `docs/H29-EVIDENCE-LOG.md` (every rule, its source and its tier).

---

## 1. What was built

### 1.1 A country-pack engine, not country conditionals

A **country pack** is a typed, reviewed definition in
`src/platform/country/packs/`: address schema, identifier specifications,
banking rules, working week, format rules, document rules, an
electronic-invoicing declaration, privacy metadata, and *references* to the tax
and payroll pack versions the existing engines already own. It never restates
another module's rules.

Nothing in the application asks `country === "AE"`. Every country-dependent
answer comes from `resolvePack(establishment, date)`, and the packs live behind
one platform surface so no module reaches into a pack file.

### 1.2 The establishment is the jurisdictional unit

An organisation is not one country, one branch, one VAT registration or one
payroll establishment. Each **establishment** carries its own legal name (in
both the Latin and local scripts, each stored exactly as typed), country,
timezone, currency, working days, address in that country's own shape,
registrations, invoice identity and banking.

The country is fixed when the establishment is created and is **not in the
UPDATE grant**, so no application path — and no form field anyone could add
later — can reinterpret history by changing a dropdown.

An organisation that never creates a second establishment behaves exactly as it
did before: `effectiveConfig` derives one from the organisation's own settings.

### 1.3 Effective-dated rule versions

Pack versions have non-overlapping validity windows, enforced by a **btree_gist
exclusion constraint** rather than by an assertion in application code. An
establishment **adopts** a version from a date an authorised person chooses,
having seen an impact preview; adoption rows are append-only, and only the
pointer marking one superseded may ever move.

A transaction dated in an earlier period keeps resolving through the version
that applied on **its** date. Adopting a newer version changes what happens from
its own date forward and rewrites nothing behind it. The establishment page
reads the whole world as at a date, so "what applied in October" is a question
the product answers rather than one a person reconstructs.

### 1.4 The Country Readiness Centre

Six independent states per establishment — technically configured, reviewed
internally, provider connected, reviewed by a professional, ready for a pilot,
generally available — each shown as its own yes or no. **They are never averaged
into a percentage.** "Technically configured" and "legally reviewed" answer
different questions, and one number would let a workspace look 83% legal.

Every unmet check names what is missing in words, in the reader's own language,
and outstanding external actions (an unappointed service provider, an
unperformed professional review) are listed as what they are: waiting on someone
outside IdaraWorks.

Whether a version has been reviewed is a recorded fact, not something the
configuration can imply, so it needs somewhere to be recorded. `/platform/countries`
is that place: one operator screen per shipped version with its four review
kinds, each demanding a named reviewer before it can be marked passed or failed.
Without it the only way to record a professional review would be to write SQL
against production.

### 1.5 The rule impact simulator

Reads, overlays, and writes nothing. It shows what would change, what is still
missing afterwards, which new outside providers the version needs, and — as
prominently as the diff — **what the change cannot touch**: issued invoices,
finalised pay runs and posted journal entries, with their real counts. Applying
is a separate act by someone holding `country.adopt`, and the module recomputes
the same preview at that moment and stores it on the adoption row, so what was
shown and what was applied cannot drift.

### 1.6 One electronic-invoicing framework, two adapters

Channel, environment, credential *reference* (the NAME of a server variable,
never a secret), lifecycle, idempotency, hash chain, counter, evidence archive
and event log are shared. **ZATCA** (Saudi Arabia, clearance model, UBL 2.1 with
the Article 53 field checks, SHA-256 document hash, previous-invoice-hash chain,
TLV QR payload in the standard's tag order) and **UAE PINT AE** (five-corner
model) are adapters.

Both **fail closed**. With no credential the lifecycle stops at *unavailable* —
deliberately not *failed*, which would invite a retry — and names the exact
owner action. No adapter simulates an authority response, and no genuine
invoice has been sent anywhere.

### 1.7 Spanish, and translation governance

The message catalogue is complete in Spanish: of 5,163 keys, 5,097 are
translated and 66 are recorded as legitimately identical (product names,
standard acronyms, keyboard shortcuts, bare placeholders). **None is left in
English.** Arabic gained the same kind
of record (`ar.same.json`, 25 keys), so the leakage test covers every translated
locale rather than only the newest.

Which languages *exist* and which languages are *offered* are now different
questions. `SUPPORTED_LOCALES` is the registry every catalogue and test is
checked against; `offeredLocales()` is what the switcher shows, gated by
`FEATURE_LOCALE_ES`. Every locale decision a cookie or form field can influence
resolves through that one gate, including sign-in — a profile cannot resurrect a
language the deployment has withdrawn.

`locale_release` records, per language, **how it was produced** and **what review
it has had**, with a named reviewer and a date. Completeness is measured from
the catalogue files on every read and never stored: a stored percentage drifts
from the thing it describes; a count taken from the file cannot.

---

## 2. What is NOT live

| Not live | Why |
| --- | --- |
| Any tax filing or return submission | Never built. IdaraWorks does not file. |
| ZATCA submission, clearance or reporting | No compliance or production CSID exists. The adapter is contract-tested against the published standards with deterministic fixtures and stays `unavailable`. |
| Cryptographic stamping | Needs a certificate issued through ZATCA onboarding. The stamping seam refuses without one, and QR tags 7–9 are reported absent rather than filled with placeholders. |
| UAE electronic invoicing | No Accredited Service Provider is appointed. No phase date is encoded anywhere, because none could be read from an official text. |
| Spanish in the language switcher | `FEATURE_LOCALE_ES` is off. The catalogue is complete; the native review the mandate requires is not done. |
| The country surfaces | `FEATURE_COUNTRY_PACKS` is off. |
| A legal pack for any Spanish-speaking country | Spanish-language support does not create a Spain, Mexico or Latin American legal pack, and none was built. |
| Spanish as a document-issuance language | `DOC_LANGUAGES` stays `en / ar / bilingual`. No shipped pack requires or permits Spanish documents. |
| Contributory-wage ceilings, the GOSI 2024 transition, the Saudi end-of-service wage base | Could not be confirmed on an official page. Encoded as explicit configuration with a review flag; the engine never applies a value the organisation has not set. |
| The pack version stamped onto each new invoice, pay run or journal entry | Not built. See 2.2 — the reproducibility that exists today is real, and it is not this. |

### 2.2 What "historical reproducibility" means here, exactly

The pack layer resolves by date and nothing else: `app.establishment_pack_on`
answers for the date it is asked about, adopting a newer version never re-answers
an earlier date, and the integration suite proves both.

What H29 does **not** yet do is write the resolved pack version onto each new
business record. Records issued today therefore stay reproducible the way they
already were — H23's payroll runs carry their own calculation snapshot, H24's tax
entries carry theirs, H26's issued documents are immutable — and nothing H29
adds rewrites any of them. But asking "which country-pack version produced this
invoice?" is, today, answered by resolving the establishment's adoption history
for the invoice's date, not by reading a column on the invoice.

That is a real difference. Resolving through history is correct while the
adoption record is intact, and a stamped column would survive even a corrupted
one. Stamping it means touching the write path of every money module, which is
not a change to make in the last hour of a phase; it is named here rather than
implied away.

### 2.1 Claims deliberately not made

IdaraWorks does not file tax returns, does not give tax, legal or labour advice,
does not guarantee compliance in any jurisdiction, and holds no certification
for electronic invoicing, data protection or anything else. Where a rule could
not be verified from a primary source, the product says so rather than guessing:
the ZATCA adapter, for example, reports that the previous-invoice-hash value
required for a chain's **first** document is not encoded, because the evidence
log records the transform and not that value.

---

## 3. Verification

### 3.1 Local gates

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` (with the boundary and tenancy rules) | clean |
| `npm run build` | compiled; the four country routes and `/platform/languages` are in the route table |
| `npx vitest run tests/unit` | 1,604 tests in 105 files, all passing |

The boundary rule earned its keep twice. `src/platform/export/context.ts` was
written importing the country module and was refused: the platform layer may not
reach into a module, so the route resolves the establishment's configuration and
hands the facts in. `src/platform/i18n/release.ts` was split for the same
reason in reverse — the laws are pure so they can be unit-tested against the real
catalogues, and the database and flag reads live in `release-store.ts`.

### 3.2 What the new tests actually assert

The i18n suite grew from 3 tests to 14 and now covers three catalogues:
identical key sets; no translation inventing an ICU argument its caller does not
supply (one documented exception, with its call site named); Spanish declaring
exactly the English arguments; no English leakage in any translated locale; a
`*.same.json` unable to hide a later English-only edit; and — a re-audit of
H22–H28 in one assertion — every Arabic value that should carry Arabic script
doing so. That last one passes at zero, across the whole catalogue.

`tests/unit/locale-release-law.test.ts` fixes the governance laws: a language
with no recorded review reads identically to one recorded as "not started"; a
complete catalogue is not readiness; a review recorded before the last batch of
keys stops counting the moment the catalogue changes.

`tests/unit/import-date-format.test.ts` exercises the real date reader, not a
copy: the same string read two ways, a two-digit year refused rather than given
a century, 31 April refused in either reading, and the ambiguous case naming the
value it could not read.

`tests/unit/export-context.test.ts` covers what a downloaded file carries: a
filesystem-safe timezone, no newline in any response header, and redaction
stated as two facts rather than one, so a blank money column is never read as a
zero.

### 3.3 Integration and adversarial evidence

Three new suites run against a real database, plus the harness that already
existed and now covers H29's tables.

**`h29a-establishments` (34 tests).** An organisation holds establishments in
two countries at once and each keeps its name in the script it was typed in.
`country` is absent from the UPDATE grant, so no application path can change it;
passing one to the module is dropped before the write. Two resolvable versions
cannot cover one day — the database refuses the overlap. An adoption applies
from its own date and not before; adding an earlier adoption afterwards does not
change what a later date resolves to. Adoption rows carry INSERT and SELECT
grants and no DELETE, and the only updatable column is `superseded_by`. A
version cannot be applied from before it exists. The preview adds no adoption
row and no audit row, and reports what it cannot touch with real counts. A
registration matching a published shape is recorded as **unverified**, because
matching a pattern is not verification. An identifier the country does not have
is refused by name. Another tenant sees nothing, cannot adopt against an
establishment it cannot see, and gets an empty readiness rather than a borrowed
one. A viewer reads and cannot write.

**`h29b-einvoicing` (15 tests).** A channel is born with no credential; a
credential *reference* that looks like a secret is refused; naming a variable
that does not exist is not the same as having one, and an empty or whitespace
value counts as absent. A document is still prepared, hashed, chained and given
a QR payload without any credential, the counter increments per channel, and
preparing the same source twice returns the same document. Article 53's fields
are enforced by name. Submission is **`unavailable`** — never a fabricated
success and never `failed`, which would invite a retry — every recorded attempt
says `unavailable`, nothing claims a cleared or reported state, and the event
log carries no UPDATE or DELETE grant. Another tenant can neither prepare nor
submit.

**`h29c-locale-release` (13 tests).** Only a platform operator can record a
review; a non-operator's attempt writes nothing. A decided review with no named
reviewer is refused by the function AND by a table constraint, so a direct owner
UPDATE fails too. `app_user` holds SELECT and nothing else. Every change lands
in the platform audit with the operator's identity.

**The two-org bleed harness.** H29's seven new tenant tables are registered with
seeders, so the cross-org sweep now proves their isolation with the rest of the
schema. This was found by CI, not by the local run — see §3.5.

### 3.4 The interface, in three languages, on desktop and phone

`tooling/scripts/h29-ui-shots.ts` drives the real screens against the dev
preview with both flags on, and captures thirteen screenshots. It passes with no
errors, and it fails on the things that matter rather than on appearance:

- the six readiness states each appear by name, and **a percentage anywhere on
  the readiness page is an error**;
- the disclaimer that a pack files nothing and certifies nothing is present;
- the Saudi establishment shows *Building number*, *District* and *Postal code*,
  and the presence of a generic "Address line 1" is an error;
- reading the establishment as at a date before the version's start must NOT
  mark it in force and must show it as starting later;
- the simulator shows its diff, its "what this cannot touch" panel and its
  statement that nothing on the page changes anything;
- the switcher offers English, العربية and Español, each named in itself;
- Arabic renders `dir="rtl"` with Arabic script; Spanish renders `lang="es"`
  `dir="ltr"` and specific English strings from those screens are errors, as is
  the Spanish title failing to render;
- a visible `⟦key⟧` marker anywhere is an error, as is horizontal overflow, a
  console error, or a control under 40px inside the page's own content.

That last check found a 16px checkbox: the house pattern puts it inside a
`min-h-11` label row, and these forms were missing it. The Spanish pass found
four defects a text-only check could not — an English rule dropped into a
translated sentence, a literal `{credential}{provider}`, a raw locale code shown
to a person, and a storage key where the country's own name for a registration
belongs. All four are fixed, and a unit test now requires every pack string a
surface renders to be a message key with copy in all three catalogues.

### 3.5 CI on the exact commit

The full pipeline ran on GitHub Actions for every candidate: format, lint with
the boundary and tenancy rules, typecheck, unit tests, a dependency audit, the
production build and the end-to-end smoke in one job; and in a second job a fresh
local Supabase stack, every migration applied in order, and the complete
integration suite including the two-org bleed harness.

| Run | Commit | Result |
| --- | --- | --- |
| 33816554731 | `bebe7d4` | both jobs failed. The bleed harness refused seven unregistered tenant tables; the dependency audit exited 2 on an endpoint error |
| 33820052692 | `c7a092b` | **both jobs green** |
| 33823120403 | `5f295cb` | superseded by the next push |
| 33823298825 | `6ab0d6e` | integration failed at "Apply all migrations" |
| 33824367582 | `389cbf4` | superseded |
| 33824730697 | `dc2a26a` | superseded |
| 33825083511 | `2102482` | **both jobs green** |
| 33825630946 | `30402e0` | superseded by the docs push |
| 33826067196 | `4aef8c7` | **both jobs green — the deployed commit** |

Both failures were worth having, and neither was cosmetic.

The bleed harness enumerates every table carrying an `org_id` and fails when one
has no seeder, so H29's seven new tenant tables would have shipped with nothing
proving their isolation. The local run had not reached that suite.

The migrations failure was a guard added the same day to stop the plain
migration runner reaching production. `targetsOnlyProductionProject` returns a
verdict object, and the guard read it as a boolean — so it refused every
environment, including CI's local stack. Reading it the other way round, which
is what four pre-existing pre-flight and smoke scripts did, makes the guard
vacuous instead: it can never refuse anything. All five now read `.ok`.

### 3.6 Production

| Step | Result |
| --- | --- |
| Merge | `verify/h29` fast-forwarded into `main` at `4aef8c7`, the CI-green commit |
| Deployment | **not live yet.** `/api/health` still reports `a49ca12`. No production deployment has been created for `4aef8c7`; four *other* Vercel projects built previews of it and the main project built nothing, which is what the daily deployment limit looked like when H28 hit it. Raising that limit is a purchase, so it was left alone |
| What that means | Nothing a user can see. Every H29 surface is behind `FEATURE_COUNTRY_PACKS`, which is unset, so the live build and the merged build present the same product. The database is already migrated and the smoke below ran the merged code against it |
| Migrations | 0130–0133 applied; 129 → 133. **Applied before the pre-flight ran**, through a runner that loads `.env.local`; see truth map I.3.1 and §3.5 |
| Read-only pre-flight afterwards | CLEAR: 133 migrations applied, all 10 H29 tables present, every new tenant table at zero rows, both flags unset |
| Production smoke | **all 22 checks passed** with the flags off |
| Residue | 0 rows: the smoke's organisation, its user, establishment, adoptions, registration, channel, document and events are all gone |
| Business data | unchanged, counted before and after: 40 organisations, 61 users, 51 customers, 93 jobs, 78 invoices, 646 audit rows |

The smoke proves, against the production database, that both shipped pack
versions exist as rows agreeing with the registry; that no pack claims a
professional or provider review and no locale claims a review without a named
reviewer; that Spanish is recorded as machine-assisted and unreviewed; that an
establishment can be created in a country that is not the organisation's own and
keeps its local-script name exactly as typed; that a version applies from its own
date and not before, and that adding an earlier adoption does not re-answer a
later date; that a preview adds no adoption row and no audit row; that readiness
reports six independent states, claims no legal review and names the outstanding
professional one; that a document is prepared, hashed and given a QR payload with
no credential, that the unknown initial previous-invoice-hash is reported rather
than invented, that submission is `unavailable`, that nothing claims a cleared or
reported state and every recorded attempt says `unavailable`; and that every
country and invoicing operation left audit evidence.

---

---

## 4. Owner actions

Each of these is something only the owner can do. Nothing in this list is a code
change, and the platform behaves correctly with all of them outstanding.

| # | Action | Unlocks |
| --- | --- | --- |
| OA-1 | Set `FEATURE_COUNTRY_PACKS=1` in the production environment (the only enabling value is the exact string `"1"`). | The Country Readiness Centre, establishments, the version timeline, the simulator, the electronic-invoicing channels and the operator language centre. |
| OA-2 | Obtain a professional tax review of the UAE pack and record it at `/platform/countries` with the reviewer's name. | The `legally_reviewed` state for UAE establishments. |
| OA-3 | Obtain a professional tax, labour and data-protection review of the Saudi pack and record it at `/platform/countries`. | The `legally_reviewed` state for Saudi establishments. |
| OA-4 | Complete ZATCA onboarding and obtain a compliance CSID, then a production CSID. Set the credential's environment variable and name it on the channel. | Saudi electronic-invoicing submission, and cryptographic stamping. |
| OA-5 | Appoint a UAE Accredited Service Provider and record the provider review at `/platform/countries`. | The UAE electronic-invoicing channel. |
| OA-6 | Confirm the UAE e-invoicing phase dates from an official text and record them. | A dated UAE activation instead of an organisation decision. |
| OA-7 | Confirm the ZATCA previous-invoice-hash value required for a chain's first document. | Removes the `pih-initial-unknown` warning from first documents. |
| OA-8 | Confirm the GOSI contributory-wage ceiling, the 2024 pension transition and the Saudi end-of-service wage base, and record them as configuration. | Saudi payroll calculating without a review flag. |
| OA-9 | Commission a native Spanish review of the catalogue and record it at `/platform/languages` with the reviewer's name. | Honest grounds for OA-10. |
| OA-10 | Set `FEATURE_LOCALE_ES=1` after OA-9. | Spanish in the language switcher, the public site and onboarding. |
| OA-11 | Commission a native Arabic review and record it. The Arabic catalogue has shipped since phase F and is in daily production use, but no formal review is on record and usage is not review. | An accurate Arabic review record. |
| OA-12 | Put the PDPL and UAE data-protection agreements in place. | Privacy metadata becoming a described arrangement rather than a description of a gap. |

---

## 5. Untouched

Per the mandate, none of the following was changed: historical accounting
records were not converted; the H24 transition ambiguities were not resolved;
PO-002 was not modified; the deferred H22 stock-posting issue was not repaired;
H28 external AI was not activated; no tax filing was created; no invoice was
submitted to any authority; no subscription price was invented and no payment
was collected. Genuine production data was preserved, and the production counts
before and after every gate are recorded in section 3.5.
