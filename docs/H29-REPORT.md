# H29 — International Expansion and Versioned Country Packs: delivery report

Status: **technical platform shipped; country and language activation pending
the owner reviews and providers listed in section 4.** The engine, the two
country packs, the electronic-invoicing framework and the Spanish catalogue are
in production behind their release flags. Nothing here files a tax return,
submits an invoice to an authority, or claims a legal, tax, labour, privacy or
electronic-invoicing certification.

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

The message catalogue is complete in Spanish: 4,881 translated keys, 66 recorded
as legitimately identical, **zero left in English**. Arabic gained the same kind
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

_Filled from the gate runs; see section 3.5 for production evidence._

---

## 4. Owner actions

Each of these is something only the owner can do. Nothing in this list is a code
change, and the platform behaves correctly with all of them outstanding.

| # | Action | Unlocks |
| --- | --- | --- |
| OA-1 | Set `FEATURE_COUNTRY_PACKS=1` in the production environment (the only enabling value is the exact string `"1"`). | The Country Readiness Centre, establishments, the version timeline, the simulator, the electronic-invoicing channels and the operator language centre. |
| OA-2 | Obtain a professional tax review of the UAE pack and record it in the readiness centre. | The `legally_reviewed` state for UAE establishments. |
| OA-3 | Obtain a professional tax, labour and data-protection review of the Saudi pack and record it. | The `legally_reviewed` state for Saudi establishments. |
| OA-4 | Complete ZATCA onboarding and obtain a compliance CSID, then a production CSID. Set the credential's environment variable and name it on the channel. | Saudi electronic-invoicing submission, and cryptographic stamping. |
| OA-5 | Appoint a UAE Accredited Service Provider and record the appointment. | The UAE electronic-invoicing channel. |
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
