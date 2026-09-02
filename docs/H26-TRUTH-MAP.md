# H26 Document Studio — truth map, decisions and evidence

Status: living document for phase H26. Part A is the verified baseline
before any H26 change. Part B records the primary-source research the
signature, evidence, integrity and retention design rests on. Part C is
the claim policy (what IdaraWorks may and may not say about its
signatures). Parts D-F (inventory, seams, decisions) follow.

## A. Baseline before H26 (verified 2026-09-02, read-only)

| Fact | Value | How verified |
| --- | --- | --- |
| Working tree | clean | `git status --short` empty |
| Branch | `verify/h26` cut from `main` at `3a81d40` | `git branch --show-current`, `git rev-parse` |
| Production code | `04c1093` (H25 code) redeployed as `3a81d40` (docs-only commit on top) | `/api/health` returns commit `3a81d40`, `ok: true` |
| Migrations applied on production | 113 (`0001` … `0113_h25c_view_removal.sql`), none pending | `tooling/scripts/prod-health.ts` |
| Public tables | 208, all with RLS, no unexpected DELETE grants | `prod-health.ts` |
| Historical counts | orgs 39, users 60, jobs 93, quotes 46, invoices 78 | `prod-health.ts` |
| Orphans | 13 identities / 103 sessions, all known historical, 0 new | `prod-health.ts` |
| Health verdict | HEALTHY, no safety regression | `prod-health.ts` |

Roadmap position: the north star (`docs/product/IDARAWORKS_BUSINESS_OS_NORTH_STAR.md`)
lists "Documents and digital approvals" as shipped (three branded bilingual
templates, share link, approvals with configured subjects) with
"e-signature planned … in 6", and "Contracts" as planned ("legally binding
content — versioned, never silently edited"; "legal text restricted to
managers"). H26 delivers both: the document object with governed
lifecycle, and the signature capability behind a fail-closed provider seam.

Untouched by H26 (mandate): historical accounting records, the H24
transition ambiguities, PO-002, H22 inventory fixes, H27.

## B. Standards and law consulted (primary sources unless marked)

The purpose of this section is to design the evidence record and the
integrity mechanism correctly, and to bound the claims IdaraWorks makes.
Nothing here is legal advice, and the product must not present it as such.

### B1. eIDAS, Regulation (EU) No 910/2014

Source: EUR-Lex (https://eur-lex.europa.eu/eli/reg/2014/910/oj/eng); article
text read from the legislation.gov.uk retained-law mirror, which reproduces
the regulation verbatim (https://www.legislation.gov.uk/eur/2014/910/article/3,
/article/25, /article/26).

- Art. 3(10) "electronic signature": data in electronic form which is
  attached to or logically associated with other data in electronic form
  and which is used by the signatory to sign.
- Art. 3(11) "advanced electronic signature": one that meets Art. 26.
- Art. 3(12) "qualified electronic signature": an advanced signature created
  by a qualified signature creation device, based on a qualified certificate.
- Art. 3(33) "electronic time stamp": data binding other data to a
  particular time, establishing evidence that the data existed at that time.
- Art. 3(35) "electronic document": any content stored in electronic form.
- Art. 25(1): an electronic signature shall not be denied legal effect and
  admissibility solely because it is electronic or not qualified.
  Art. 25(2): a qualified electronic signature has the equivalent legal
  effect of a handwritten signature.
- Art. 26 (advanced signature requirements): (a) uniquely linked to the
  signatory; (b) capable of identifying the signatory; (c) created using
  signature creation data the signatory can, with a high level of
  confidence, use under their sole control; (d) linked to the signed data so
  that any subsequent change in the data is detectable.

### B2. UAE Federal Decree-Law No. 46 of 2021 on Electronic Transactions and Trust Services

Sources: the official UAE government overview
(https://u.ae/en/about-the-uae/digital-uae/regulatory-framework/electronic-transactions-and-trust-services-law,
which links the decree PDF and names TDRA as the licensing regulator for
trust service providers); article text read from a hosted copy of the
decree (https://legaladviceme.com/legislation/160/uae-federal-decree-law-46-2021-electronic-transactions-trust-services,
secondary hosting of the primary text; the official PDF is
https://uaelegislation.gov.ae/en/legislations/1539/download).

- Art. 1: "Electronic Signature" is a signature of letters, numbers,
  symbols, voice, fingerprint or processing system in electronic form,
  attached or logically linked to an electronic document. An advanced
  signature meets Art. 19; a qualified signature is an advanced signature
  created by a qualified device on a qualified certificate issued by a
  licensed Trust Service Provider (a TDRA licensee).
- Art. 5: an electronic document is not without legal force merely because
  it is electronic.
- Art. 19 (advanced signature): exclusively controlled by the signatory;
  identifies the signatory; detects later modification of the data; uses
  approved technical security methods; meets the executive regulation.
- Consequence: "approved"/"qualified" status in the UAE requires a
  certificate from a TDRA-licensed provider. IdaraWorks holds no such
  licence and integrates no such provider in H26.

### B3. United States, 15 U.S.C. § 7001 (E-SIGN)

Source: Legal Information Institute (https://www.law.cornell.edu/uscode/text/15/7001).

- § 7001(a)(1)-(2): a signature, contract or record may not be denied legal
  effect, validity or enforceability solely because it is in electronic
  form or because an electronic signature was used in its formation.
- § 7001(d)(1): a retention requirement is satisfied by an electronic
  record that accurately reflects the information and remains accessible to
  all entitled persons for the required period in a form capable of being
  accurately reproduced for later reference. This is the design basis for
  the immutable issued snapshot plus the stored PDF bytes.

### B4. PDF signature standards (PAdES, ETSI EN 319 142; ISO 32000)

ETSI's PDF deliverables refuse automated fetches (HTTP 403), so the
description below is from the PAdES overview (https://en.wikipedia.org/wiki/PAdES,
secondary) cross-checked with the ETSI listing
(https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf).

- A PAdES signature embeds CMS SignedData in the PDF signature dictionary
  (`/Contents`, `/ByteRange`), the signer certificate chain, optionally an
  RFC 3161 time-stamp, and, for long-term levels, a Document Security Store
  with validation data. Baseline levels: B-B (basic), B-T (time-stamped),
  B-LT (long-term validation data), B-LTA (archival re-time-stamping).
- Consequence: a PAdES/advanced/qualified signature needs a certificate and
  private key held by or for the signatory (or a trust service provider).
  H26 does not produce PAdES signatures. What H26 produces is an electronic
  signature in the eIDAS Art. 3(10) / UAE Art. 1 sense, with an
  integrity mechanism (SHA-256 content hash of the immutable snapshot,
  hash-chained events) and an evidence record, rendered visibly into the
  PDF. The PDF is not cryptographically signed unless a provider adapter
  that does so is provisioned.

### B5. Record retention (UAE tax law)

Primary text: Federal Decree-Law No. 28 of 2022 on Tax Procedures
(https://uaelegislation.gov.ae/en/legislations/1625/download) with Cabinet
Decision No. 74 of 2023 (executive regulation). Summaries consulted
(secondary): Crowe UAE and Bloomberg Tax coverage of the 2026 amendments.
Rule applied: accounting records and supporting documents are retained for
five years after the relevant tax period (seven years for real estate
records; longer while a refund determination is pending). Design basis:
document retention policy is a per-organisation setting with a default of
seven years for issued documents, retention can only lengthen the earliest
disposal date, and disposal is a governed, audited, reversible-until-final
action, never automatic deletion (the platform grants no DELETE).

### B6. Integrity primitives

- Hashing: SHA-256 (FIPS 180-4) over a canonical JSON serialisation of the
  snapshot, computed server-side with Node's OpenSSL-backed `crypto`.
- Tamper evidence: every document event row carries `prev_hash` and
  `event_hash = sha256(prev_hash || canonical(event))`; the chain root is
  the snapshot hash. Verification recomputes the chain.
- Time: server time (`now()` in the database) recorded on every event; this
  is NOT an RFC 3161 qualified time-stamp and the receipt says so.
- Invitations: 256-bit random tokens; only the SHA-256 of the token is
  stored; single use; explicit expiry; revocation; constant-time compare.

## C. Claim policy (binding for every screen, PDF and copy string)

1. IdaraWorks provides an **electronic signature with an evidence record**.
   Copy may say: "electronic signature", "signed electronically",
   "evidence record", "tamper-evident", "content hash".
2. IdaraWorks must not say: "qualified", "advanced", "approved",
   "government-certified", "legally guaranteed", "equivalent to a
   handwritten signature", "PAdES", "digitally signed certificate", unless a
   provisioned provider adapter genuinely delivers that level and the
   adapter reports it in the evidence record. Pinned by a unit test over the
   EN/AR catalogs and the PDF copy.
3. The signing receipt states plainly what was captured (signer identity as
   asserted and how it was verified, time from the server clock, IP and
   user agent as reported by the client, the snapshot hash) and what was not
   (no certificate, no qualified time-stamp) unless a provider supplies them.
4. No AI output is presented as legal advice; assistance answers cite the
   exact clause or state that evidence was not found.

## D. Inventory of document-like records before H26 (read 2026-09-02)

### D1. The derived-print pipeline (reused as-is)

- `src/modules/documents/service.ts`: `DOCUMENT_KINDS` (22 kinds: quote,
  invoice, week_plan, nine HR papers, eleven finance papers), one entry
  point `documentModel(ctx, archetype, {kind, id, language})` guarded by a
  per-kind `VIEW_ACTION` map, `ISSUED_STATUSES`, `WATERMARK_FOR`,
  `captureDocumentIssuerIn(tx, ctx, table, id)` (first-writer-wins issuer
  snapshot), share tokens (`createDocumentShare`, `revokeDocumentShare`,
  `resolveDocumentShare`; `SHAREABLE_KINDS = quote, invoice`).
- `src/platform/documents/issuer.ts`: `IssuerSnapshot` (strict Zod,
  version 1, logo by file id), `captureIssuerSnapshot`,
  `formatIssuerAddress`. `issuer-resolve.ts`: draft → current profile,
  issued → stored snapshot with an explicit notice when a legacy row has none.
- `src/platform/documents/shell.ts`: `renderDocumentShell(props)` — the one
  A4 frame: header with logo data URI (never a URL), bilingual label pairs,
  watermark (draft/cancelled/void/credit/sample), RTL via `dir`/`lang`,
  logical CSS properties, `@page { size: A4; margin: 14mm 12mm 18mm }`, an
  unused `coverMode` (letterhead) branch.
- `src/platform/documents/render.ts`: `DocumentRenderModel` (fields,
  sections of pre-formatted lines, totals, notes, terms) → `renderDocument`.
  Fonts: `NotoSans` and `NotoNaskhArabic` regular/bold from `public/fonts`,
  `documentFontCss(delivery)`; PDFs embed the TTFs as base64 (`pdf.ts`
  `embeddedDocumentFonts()`), because the print page has no base URL.
- `src/platform/documents/pdf.ts`: real server-side PDF via
  `playwright-core` ~1.61 + `@sparticuz/chromium` ^149 on Vercel
  (`isServerless()`), `renderPdf(html, {title, printBackground,
  pageNumbers, rtl})`, page numbers only through Chrome's footer template
  (digits only), `MAX_CONCURRENT_RENDERS = 4`, `PdfBusyError`,
  one-retry resurrection of a frozen serverless browser.
- Routes: `src/app/api/o/[orgId]/documents/[kind]/[id]/route.ts`
  (`?format=pdf`, `?print=1`, `?lang=ar`; `maxDuration = 60`; filename from
  the reference; `private, no-store`, `noindex`) and the public share
  `src/app/d/[token]/route.ts` (rate-limited buckets `share` 30/min and
  `share_pdf` 6/min; same page for unknown/expired/revoked). Failure
  taxonomy in `failure.ts`: PDF failure → 503 plus a link to printable
  HTML, never 404.
- `src/platform/documents/catalogue.ts`: `EXPORT_CATALOGUE` with the
  honesty law (an entry is `available` only when its route ships);
  `doc_letterhead` is `foundation_ready` and unwired.
- Legacy second render stack, not to be extended: `quote-template.ts`,
  `invoice-template.ts`, workers `lpo-pdf.ts`, `quote-pdf.ts`.

### D2. Branding and legal identity

`src/modules/branding/service.ts`: `getDocumentProfile(ctx)` composes
`org` + default `company` (legal name, TRN `tax_reg_no`, licence, addresses
EN/AR, signatory, payment instructions, `doc_language`) + `org_branding`
(logo file id, accent colour, display name, footer). Logo bytes are
re-encoded on upload (`sharp`), stored in bucket `tenant-media`, read back
for PDFs as a data URI (`resolveLogoDataUri`, degrades to a text header).
Advanced styling is entitlement `feat.branding_docs`.

### D3. Files, storage and tokens

`src/platform/files`: two buckets (`tenant-media`, `tenant-docs`), four
access classes (`job_media`, `financial_doc`, `hr_doc`, `customer_share`),
`ALLOWED_UPLOAD_MIMES` = JPEG/PNG/WebP only, `signUpload` (quota, billing
read-only gate, sweep-then-reserve), `signRead` (TTL 300 s; denial reads
as not found), `voidFile`, `setLegalHold`; mirrored authorisation walls
(`canAccessFileClass` in TypeScript and `app.can_access_file_class` in
SQL, parity-tested). `ATTACHABLE_TYPES` (25 entries) is the closed
registry `signUpload` validates against. Token precedents, all
`token_hash` + `expires_at` + revocation: `document_share` (0082/0083,
SECURITY DEFINER resolver), `share_token` (customer updates),
`membership_invite`.

### D4. Comments, notifications, events, workers

Comments platform (`createComment`, `listComments`, `softDeleteComment`;
`entity_type` free string; action `comments.create`). Notifications
(`createNotificationIn(tx, …)`, closed `NOTIFICATION_KINDS`: system,
approval_requested, approval_decided, exception_raised, payslip_issued;
recipient-only RLS). Email seam `sendEmail` posts to Resend when
`RESEND_API_KEY` is set (owner action OA-4), otherwise a dev sink that
returns `delivered: false`. Domain events through the outbox
(`emitEvent(tx, ctx, event)`, closed `EVENT_DEFS`). Workers are Inngest
functions (`src/workers/index.ts`), unprovisioned in production
(`runbooks/inngest-provisioning.md`); no Vercel crons. Attention/inbox
feeds are per module and computed on read (`src/modules/hr/attention.ts`,
`src/modules/inventory/attention.ts`, `today`).

### D5. Quotes, invoices, numbering, money

Quotes: draft → pending_approval → approved → sent → accepted → converting →
converted (+ rejected, expired); approval subject `quote_send`;
`computeQuoteTotals` in minor units; lines `{sectionKey, itemId,
description, qty, unit, unitPriceMinor, vatRate}`. Invoices: immutable once
issued (`issueInvoice` guarded by `status = 'draft'`), corrections by
credit note born issued; `invoice_issue` is a direct permission, not an
approval subject; VAT registration from `app_settings`
`finance.vat_registered`. Numbering `allocateReference(tx, ctx, scopeKey)`
+ `formatRef(prefix, n)` on `reference_sequence`. Money helpers in
`src/platform/format` with `minorUnitExponent`.

### D6. HR papers and forms

`hr-documents.ts` builds nine papers with the "self unless the wider
action also holds" pattern (`assertSelfOr`). Safe printable employee
fields: id, name, name_ar, legal_name, employee_no, nationality, hire_date,
lifecycle, end_date, position, department. Sensitive walls: `employee_terms`
(salary) behind the `costPrivileged` GUC and `employees.terms.manage`;
`employee_hr` (ID/passport/visa) behind owner/admin RLS and
`employees.hr.manage`; HR files in class `hr_doc`. Payslips freeze both
`issuer_snapshot` and the full calculation `snapshot` (0097): the content
freeze precedent H26 generalises. Employment contracts exist as HR rows
(`createContract`, `issueContract`, `recordContractAcceptance`) without a
governed body, signature or PDF; H26 links to them rather than replacing
them. Leave and claim forms are approval subjects (`leave_request`,
`overtime_request`, `expense_claim`, `pay_run`).

### D7. Templates and settings

`app_settings (org_id, key, value jsonb)` with no DELETE; the bounded
org-template precedent is `studio.templates` (`PlanTemplate` Zod, ≤20 per
org, built-ins in code, `listTemplates` merges both). Config artifacts and
industry templates go through `src/platform/config/pipeline.ts`
(`applyConfigChange`, revisions, undo). No message templates exist.

### D8. Permissions, registries, flags, nav, i18n, search

Actions are `<lane>.<verb>` in `src/platform/authz/matrix.ts`, transcribed
in `matrix.data.ts` for seven archetypes (owner, admin, manager, foreman,
procurement, accounts, viewer). Existing document actions: `documents.share`,
per-kind view lanes. Registries: `ATTACHABLE_TYPES` (25), `AUDIT_ENTITY_TYPES`
(75), `APPROVABLE_TYPES` (14). Flags: strict `"1"`, default off everywhere,
enforced at the page (404). Nav: pure builder `buildNavGroups` with groups
work, materials, money, finance, studio, customers, people, settings; every
item mirrored in the workspace registry (`NAV_ITEM_KEYS`, laws test). No
`documents` group. i18n: flat dotted keys in `en.json`/`ar.json`, parity
test, no domain nouns in values. Search: none across entities (one GIN
index on assets); no global command palette (the Studio palette is
plan-scoped and in-memory).

### D9. Gaps H26 must fill (and the traps)

- No authored document object, no content revisions, no supersession, no
  content freeze outside payslips, no signature, no obligations.
- Uploads are images only: attaching a signed scan or a generated PDF needs
  a new MIME/access-class decision.
- HR/finance kinds have routes but no UI mount; there is no documents hub.
- Reminders cannot rely on a live worker: compute on read, and register an
  Inngest function that becomes live when the fleet is provisioned.
- `DOCUMENT_KINDS` is duplicated as a literal union in `render.ts`.

## E. Integration seams (from the second inventory, 2026-09-02)

| Seam | Where | H26 obligation |
| --- | --- | --- |
| Approvals engine | `src/modules/approvals/service.ts` `SUBJECTS` (table/live/onApprove/onReject/onWithdraw), `submitForApproval(tx, …)`, `decideApproval`, `supersedeApprovalsForSubjectIn`; one live approval per subject (`approval_one_live_per_subject`); single step only; rules `always / amount_gte / urgency_in`; escalation ladder; self-approval guard | subject `document_step` whose subject id is the step-run row (so parallel approvers are distinct subjects); widen `approval_subject_type_check` and `approval_rule_subject_type_check`; add to `APPROVABLE_TYPES`, the activity switch, and `SUBJECT_PATH` on the approvals page; add an `afterDecide` hook to `SubjectConfig` so the decision transaction advances the run |
| Audit | `command(ctx, {audit, activity?, events?}, fn)`; `audit_log` append-only; before/after explicit | every material action through `command()`; `document`, `document_template`, `document_workflow`, `document_signature`, `document_obligation`, `document_form` entity types |
| Tenancy | GUCs `app.org_id`, `app.user_id`, `app.cost_priv`; RLS template with `(select app.current_org_id())`; `(id, org_id)` unique + composite FKs; column-scoped UPDATE; no DELETE; `row_version` conflicts | copy exactly; triggers for immutability |
| Files | classes `job_media`, `financial_doc`, `hr_doc`, `customer_share`; buckets allow images only; `app.can_access_file_class` mirrors `canAccessFileClass`; scanner seam refuses documents in production unless `SCAN_PROVIDER` is provisioned | new class `document_file` in both walls and storage RLS; bucket spec gains `application/pdf`; PDF uploads fail closed in production until a scanner is provisioned (owner action) |
| Notifications | `createNotificationIn(tx, …)`; kinds closed in `NOTIFICATION_KINDS` (no DB CHECK) | kinds `document_review_requested`, `document_signature_requested`, `document_signed`, `document_obligation_due` |
| Events | closed `EVENT_DEFS` with Zod payloads | `document/issued`, `document/signed`, `document/terminated` |
| Attention | computed on read (`src/modules/hr/attention.ts` pattern, facts not sentences, cap 30) | document attention feed the same way |
| Entitlement/module | `cap.studio` precedent: `FEATURE_KEYS`, `WORKSPACE_MODULE_KEYS`/`MODULE_INFO`, `NAV_ITEM_INFO`, migration inserting `entitlement_def` and plan features; segment `layout.tsx` with `ModuleGate module="cap.…"` | `cap.documents` the same way (keeps ADR-28's "no paid gate" intent: granted to every plan like `cap.studio`) |
| Bleed harness | every `org_id` table needs a seeder in `SEEDERS` (`seed-two-orgs.ts`), teardown under replica role | `tooling/scripts/seed-h26.ts` |
| PDF | Chromium renderer, `outputFileTracingIncludes` route globs, `check-traced-payloads.ts` | new PDF route under `/api/o/**/documents/**` (already traced) |
| UI | `ActionResult`, `run()` action helper, `settle()`, notices, `CommandPalette`, `BottomNav` ≤5, light theme only (dark mode is accepted debt UI-1) | same conventions; H26 does not add app-wide dark mode |

## F. Decisions (ADR-19 onward; H25 ended at ADR-18)

**ADR-19 — One authored document object, no competing print model.**
The existing 22 kinds are derived prints of records and stay derived. H26
adds the *authored* document (`doc_document`) as the single canonical
business object for contracts, letters, proposals, policies and forms. A
Studio document can bind live records (quote lines, invoice totals,
customer identity, employee identity, job facts) through typed bindings
that are resolved at read time while drafting and frozen into the issued
snapshot. Studio documents render through the same shell
(`renderDocumentShell`) and the same PDF renderer, so branding, fonts, RTL
and page geometry have exactly one implementation.

**ADR-20 — Lifecycle and immutability.** Statuses: `draft`, `review`,
`approval`, `signature`, `active`, `expired`, `terminated`, `superseded`,
`archived`. Content lives in `doc_revision` rows; exactly one `working`
revision is editable; submitting for review freezes it (`frozen`, content
hash recorded) and any later edit opens a new revision based on it.
Issuing (leaving approval, or directly from draft when no workflow applies
and the actor holds `documents.issue`) writes one immutable `doc_snapshot`
(resolved blocks, resolved bindings, issuer identity, branding, fonts,
language, content hash). Database triggers refuse UPDATE on frozen
revisions, snapshots and events. A signed or active document is never
edited: changes happen by creating a successor (`supersedes_document_id`)
whose issue marks the predecessor `superseded`.

**ADR-21 — Evidence is a hash chain, and the claim is bounded.**
`doc_event` is append-only with `prev_hash`/`event_hash` (SHA-256 over
the canonical event and the previous hash; chain root = snapshot hash).
Signing records identity as asserted, verification method (member session
or invitation token delivered to an address), server time, client IP and
user agent, consent text version, and the snapshot hash. Copy follows Part C.

**ADR-22 — Workflows orchestrate above the approvals engine.** A
`doc_workflow` definition (reusable, versioned by copy) has ordered steps
of kind review / approval / signature, each sequential or parallel, with
conditions over document facts (`amount`, `category`, `counterparty_type`,
`risk_score`, `language`, `has_binding:<type>`, `field:<key>`), due days,
delegation, escalation and separation-of-duties flags. Starting a run
copies the definition into `doc_workflow_run.definition`, so editing the
workflow never changes an in-flight run. Every approval step materialises
an `approval` row through the approvals engine (subject
`document_step`) so the existing inbox, notifications, self-approval
guard and decide UI apply; the engine's callbacks advance the run. Review
steps are comments-with-decision; signature steps hand over to the
signature room.

**ADR-23 — Signature providers are adapters; the native adapter is the
only one shipped, and nothing external is simulated.** `SignatureProvider`
interface: `capabilities()`, `createEnvelope`, `recordSignature`,
`verify`. `native` captures a typed or drawn electronic signature in the
IdaraWorks signing page with an evidence record. `external` adapters
(qualified/TSP providers) are declared but not provisioned; selecting one
fails closed with a provisioning message. Invitations are 32 random bytes,
SHA-256 stored, single use, expiring, revocable; resolved by a SECURITY
DEFINER function like `app.resolve_document_share`. Email delivery uses
`sendEmail`; when `RESEND_API_KEY` is absent the invitation is created with
`delivery = link`, the link is shown once to the requester, and the
evidence record states that delivery was manual. The exact owner action to
enable email invitations is OA-4 (`RESEND_API_KEY` + `EMAIL_FROM`).

**ADR-24 — Forms are documents.** A form is a document whose body holds
field blocks; a `doc_form_link` (hashed token, expiry, use cap, revocation)
lets an outside party submit answers into `doc_form_submission` under the
org's id through a SECURITY DEFINER insert. Submissions are quarantined
(`received`) and become records only through explicit reviewed actions
(`convert` to a customer, a lead, or a new document from a template) that
run under the reviewer's own permissions and validation.

**ADR-25 — Obligations are rows, reminders are computed on read.**
`doc_obligation` (obligation, renewal, payment, risk, milestone, notice)
with due dates, amounts, owners, evidence requirement, reminder offsets
and escalation. Because the worker fleet is unprovisioned, due-soon and
overdue states are derived at read time in the command centre, the
document page and the attention feed; an Inngest function
(`docObligationReminders`) is registered and becomes live when OA-4
(Inngest) is completed. Completion with `requires_evidence` needs a file
or a note; the mandate's evidence gate.

**ADR-26 — Assistance is a seam, disabled until provisioned.**
`assistant.ts` builds `ProviderRequest`s for summarise, question with
clause citations, and obligation extraction (proposals only); it calls
`getAgentProvider()`, which is `DisabledAgentProvider` today, and the UI
shows the disabled state. No path lets assistance issue, approve, sign,
alter or terminate a document.

**ADR-27 — Search and views.** A generated `tsvector` column on
`doc_document` (title, reference, tags, counterparty name) and a
service-maintained `body_text` on `doc_revision` with GIN indexes give
real search in both languages (`simple` configuration). Folders, tags and
saved views are org-scoped rows.

**ADR-28 — Release and permissions.** Flag `FEATURE_DOCUMENT_STUDIO`
(strict `"1"`, default off, page-level 404). New lanes: `documents.view`,
`documents.create`, `documents.edit`, `documents.review`,
`documents.issue`, `documents.sign`, `documents.terminate`,
`documents.archive`, `documents.templates.manage`,
`documents.workflows.manage`, `documents.obligations.manage`,
`documents.forms.manage` (plus the existing `documents.share`). Foreman
holds none (legal text is not a field-floor surface); viewer holds
`documents.view`. No new billing entitlement in H26 (a paid `cap.documents`
is a pricing decision for the owner); advanced styling keeps
`feat.branding_docs`.

**ADR-29 — Attachments.** `document` joins `ATTACHABLE_TYPES`; a new file
access class `document_file` (bucket `tenant-docs`, PDF/JPEG/PNG/WebP)
is added to both authorisation walls, so signed scans and supporting
papers can be attached. Generated PDFs are rendered from the immutable
snapshot on demand (deterministic inputs), not stored.

**ADR-30 — Retention.** `documents.retention_years` in `app_settings`
(default 7, minimum 5, can only be raised for issued documents);
`retention_until` is stamped at issue; nothing is deleted (no DELETE
grant); the command centre lists "eligible for disposal" for a human,
audited decision, and legal hold (`legal_hold`) blocks it.

**ADR-31 — Collaboration.** Comments are anchored to a block of a
revision in `doc_comment` (threads, mentions, resolution, suggested
changes with accept/reject). Presence uses the H25 private Realtime
channel pattern with a document predicate. Concurrent edits are guarded
by `row_version` on the working revision; conflicts are surfaced, never
merged silently.


## Part G — Progress and evidence log (branch `verify/h26` from `main` 3a81d40)

Every slice was built on the TEST project (`zwnnqaryouevnzuwtyaj`), verified with
the gates (`prettier`, `tsc`, `eslint`, unit, integration on TEST, headless
Playwright walk against the dev server), and committed. Production was not
touched until the deployment section of `docs/H26-REPORT.md`.

| Slice | Commit | What shipped | Evidence |
| --- | --- | --- | --- |
| H26A foundation | d08d2c7 | 0114/0115; doc_document, revisions, immutable snapshot, hash chain, folders, tags, saved views, retention, audit | `h26a-foundation` 12 tests; unit `docstudio-core` |
| H26B/C builder + templates | 0d8e389 | drag-and-drop block builder, inspector, autosave with row_version, 6 built-in templates, org templates with immutable published versions | walk shots `builder*`, `templates-list`; `h26a` template test |
| H26D workflows | 55576df | 0116; visual designer, sequential/parallel steps, conditions, delegation, escalation, SoD; runs orchestrated above the approvals engine (`document_step`) | `h26d-workflows` 6 tests; walk `workflow-designer*`, `doc-workflow` |
| H26E collaboration | fe377de | comments, mentions, suggestions accept/reject, revision compare, presence | `h26e-collab` 4 tests; walk `doc-review`, `doc-revisions` |
| H26F signature room | 511996a | 0117; native electronic signature with evidence record, one-time hashed invitations, in-app member signing, public signing page, activation on last signature, evidence in PDF; external providers declared and fail closed | `h26f-signatures` 6 tests; walk `sign-page*`, `doc-signatures` |
| H26G forms | ffde557 | 0118; hashed expiring use-capped links, party-filled fields with answer-driven conditional sections, definer-only quarantined insert, reviewer inbox, explicit mapped conversion | `h26g-forms` 5 tests; walk `form-page*`, `forms-inbox`, `doc-forms-tab` |
| H26H obligations | ca9e5f0 | 0119; kinds, evidence-gated completion immutable once done, recurrence, waive/cancel/reopen with reasons, escalation, renewal seeded at issue, due states on read, daily reminder worker, attention feed; list/timeline/calendar/by-document | `h26h-obligations` 5 tests; walk `obligations-*`, `doc-obligations`, `obligation-complete-dialog` |
| H26I/J assistant + command centre | 8d9bdd9 | provider-neutral seam through `getAgentProvider()` (fails closed, validated citations, no-evidence answer, proposals persist nothing); attention strip on the hub | `h26i-ai` 2 tests; walk `doc-assistant` (unavailable state), `hub-list` |
| H26K/L PDF + invariants | a9f452b | vitest PDF byte tests; invariants suite; revision ownership pinned in `getRevision` and the route; export catalogue entry; English runs in bilingual documents in Noto Sans | `h26k-pdf` 2 tests (7-page bilingual PDF, both faces embedded); `h26l-invariants` 5 tests |
| H26M UX | bba0560 | document command palette (Ctrl/Cmd+K), mobile walk for obligations and forms | walk `palette`, `mobile-*` |
| H26N deployment tooling | b15c9fa | read-only pre-flight, production smoke, production UI walk | pre-flight CLEAR on production 2026-09-02 (6 pending, 113 applied, baseline orgs 39 / users 60 / jobs 93 / quotes 46 / invoices 78) |

**Bleed harness:** re-run after every new tenant table; 2/2 green with the
17 doc_* seeders. **Unit suite:** 94 files, 1455 tests green. **Build:**
`next build` green (all documents routes dynamic). **Format:** prettier clean.

**Fixes found by verification (not by review):** the issued snapshot dropped
sections gated on party-filled answers (fixed in `visibleBlocks`); the public
token pages nested `<html>` under the root layout (fixed with a full-height
`div`); a foreign revision could be rendered under another document through
`?rev=` (fixed in `getRevision` and the route); English runs in bilingual PDFs
fell back to the Naskh Latin glyphs (fixed with a per-language rule).

**Deliberately not built:** the optional lazy-loaded 3D relationship view (the
2D React Flow graph is lazy-loaded and sufficient; a 3D view would add a
799 KB chunk for no operational gain). External signature providers (UAE PASS)
and the assistant's model provider are declared seams that fail closed with
one owner action each.
