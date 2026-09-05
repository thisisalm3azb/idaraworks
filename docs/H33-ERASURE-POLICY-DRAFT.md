# H33 — Personal-data erasure policy: draft with a decision table

**Status: DRAFT for the owner's decision. Not legally approved. Nothing in
production is erased by this document.**

Date 2026-09-05 · branch `verify/h33` · part of the H33 launch-readiness package.

This draft answers owner action **O-4** in `docs/H30-OWNER-CHECKLIST.md` ("decide
the per-person erasure policy") and expands §6 of `docs/H30-PRIVACY-CHECKLIST.md`
(the erasure tension). It does not repeat the sub-processor table (privacy
checklist §2) or the pilot-customer talking points (§7); it builds on them.

Every statement about what the product does **today** was checked against the
migrations, runbooks and code listed in §8. This is the **second pass**: a
fact-check of the first draft found two places where the draft had trusted a
document over the code — the export catalogue had been copied from
`runbooks/exports.md` §2 (which still lists eight entities) instead of
`src/platform/export/service.ts` (which has seventeen), and "void a file" had
been tagged as a product action when it is a database function that nothing in
the product calls. Both are corrected in §3.1, §3.6 and §3.10, and the stale
runbook is flagged there. Nothing was checked against a live database, and no
database was opened while writing this.

---

## How to read this

| Tag | Meaning |
| --- | --- |
| **WORKS TODAY** | The product or a runbook does this now; the file that proves it is named. |
| **PARTIAL** | Part of it exists; the gap is stated. |
| **NEW CODE** | Nothing does this today. It would need a migration, a script or a UI change. |
| **[LEGAL REVIEW]** | A clause that a qualified adviser in the relevant jurisdiction (UAE, KSA, or wherever the tenant is established) must confirm before it is relied on. Every retention period in this document carries this tag. |
| **UNVERIFIED — owner action** | A fact that could not be checked from this machine and needs the owner (dashboard, account, counsel). |

Retention periods are written as **"commonly cited — verify"**. They are the
figures practitioners usually quote; none has been confirmed by counsel for this
product, and the correct figure depends on the tenant's country, free zone and
sector.

---

## 1. The recommended default, in one page

**"Cut access at once. Erase what nothing needs. Keep what the law and the ledger
need, for as long as they need it, and no longer. Never rewrite a financial or
audit record to hide a name; retire the record when its period ends."**

In practice, when a person asks to be erased:

1. **Day 0 — access ends.** Their membership is deactivated in every organisation
   that received the request and their sessions are signed out
   (`runbooks/access-revocation.md`). **WORKS TODAY** for membership; the global
   sign-out is an owner action in the Supabase dashboard.
2. **Day 0 — free identifiers go.** Contact details, emergency contacts, free-text
   notes, ID and passport numbers, bank details and marketing consent records that
   serve no continuing legal purpose are blanked or replaced with a placeholder
   such as `Former employee 7F3A`. **PARTIAL** — the database allows every one of
   these updates, but there is no "erase this person" button; each field is edited
   by hand today (§3.1, §3.2).
3. **Day 0 — the login is closed.** The person's name in `user_profile` is
   cleared and the `auth.users` row is soft-deleted, so nothing readable remains in
   the login system while the opaque id that history points at stays valid.
   **NEW CODE** (§3.8).
4. **Nothing in a statutory record is rewritten.** Invoices, journals, tax
   returns, payslips, employment contracts and audit rows keep the name they were
   issued with, because rewriting them would falsify the record. **WORKS TODAY**
   in the sense that the database refuses to change them.
5. **The audit trail is retained, and it already names people by an opaque id.**
   `audit_log.actor_user_id` is a UUID; the readable name lives in `user_profile`
   and is cleared in step 3. Names that were written into summary text stay until
   the row's retention ends (§3.3). This is the part the owner must decide (D1).
6. **Files are voided at once and physically deleted after a grace period**,
   unless under legal hold. **PARTIAL** — the void function exists in the
   database (`app.void_file`) and is integration-tested, but nothing in the
   product calls it, so today a file is voided only by hand (SQL, by the owner);
   a product action for voiding and the physical deletion are both **NEW CODE**
   (§3.6, N1, N3).
7. **Backups are never edited.** Erasure reaches a backup when the backup expires.
   The window must be recorded (**UNVERIFIED — owner action**, O-2).
8. **When a retention period ends, the record itself becomes disposable** through
   a governed, audited job that skips anything under legal hold. **NEW CODE**
   (§5, N7). Until that job exists, nothing past its period is deleted — which is
   a retention failure in the other direction and must be said plainly to
   counsel. **[LEGAL REVIEW]**

Why this default and not "delete everything on request": the product is a
finance, payroll and HR system. A finance system's value depends on records that
cannot be edited after the fact, and UAE and KSA tax and labour regimes require
those records to be kept for years. Most privacy regimes, as commonly described,
allow personal data to be retained where a legal obligation requires it.
**[LEGAL REVIEW]** — counsel must confirm that "legal obligation" and
"legitimate interest" cover the retained categories in each pilot jurisdiction.

Why not "keep everything": a person who has left a company has no reason to have
their passport number, IBAN, emergency contact and phone number sitting in a
former employer's system indefinitely, and nothing in the product needs them
after the statutory window.

---

## 2. Retention boundaries — what must be kept, and for how long

All periods: **commonly cited — verify. [LEGAL REVIEW]** None has been confirmed
by counsel. Free zones (DIFC, ADGM and others) have their own data-protection
and employment regimes and may differ. **[LEGAL REVIEW]**

| Record family | Tables | UAE, commonly cited — verify | KSA, commonly cited — verify | What the code does today |
| --- | --- | --- | --- | --- |
| VAT and tax records, invoices, credit notes, e-invoice submissions | `invoice`, `invoice_line`, `einvoice_submission`, `einvoice_document`, `tax_entry`, `tax_return` | 5 years after the end of the relevant tax period; 7 years for real-estate records; longer while an audit or refund is pending. The repository's H26 evidence (`docs/H26-TRUTH-MAP.md` B5) cites Federal Decree-Law 28/2022 and Cabinet Decision 74/2023 for this. **[LEGAL REVIEW]** | 6 years for VAT records is the figure the repository already assumes (`runbooks/retention.md`); e-invoices must remain stored and retrievable. **[LEGAL REVIEW]** | Issued invoices, frozen tax entries and locked returns are immutable by grant and trigger (`0042`, `0105`); no DELETE grant; never pruned. |
| General ledger, journals, bank records | `journal_entry`, `journal_line`, `bank_statement*`, `settlement_allocation` | Follows the tax-records period above; company law is commonly cited at 5 years for accounting records. **[LEGAL REVIEW]** | Company law is commonly cited at 10 years for accounting records — longer than the VAT figure. **[LEGAL REVIEW]** | Posted entries are immutable; correction is by reversal only (`0100`); no DELETE grant; never pruned. |
| Payroll: pay runs, payslips, loan repayments | `pay_run`, `pay_run_line`, `payslip`, `loan_repayment`, `payout_batch` | Inherits the accounting-records period; wage-protection files are commonly cited at 2 years after the employment ends. **[LEGAL REVIEW]** | Inherits the accounting-records period; GOSI and wage-protection retention are commonly cited but figures vary by source. **[LEGAL REVIEW]** | Finalised runs and payslips carry `employment_history_is_append_only` triggers (`0097`); frozen JSON snapshots hold the employee's name and pay at issue. |
| Employment records: contracts, lifecycle events, disciplinary records | `employee_contract`, `employee_event`, `disciplinary_record`, `final_settlement_input` | Employee files are commonly cited at 2 years after end of service; end-of-service claims can run longer. **[LEGAL REVIEW]** | Commonly cited as "retain worker files"; no single figure is consistently quoted. **[LEGAL REVIEW]** | `employee_event` is append-only by trigger; contracts have a narrow update grant (status, dates, notes); no DELETE. |
| Identity documents and bank details of employees | `employee_hr`, `employee_document`, `employee_payment_instruction` | Only as long as the employment and any post-employment obligation needs them. **[LEGAL REVIEW]** | Same; visa and iqama copies are sensitive and the KSA PDPL posture item in `docs/pilot/06-launch-criteria-checklist.md` E8 is still open. **[LEGAL REVIEW]** | Every identifying column is in the UPDATE grant (`0020`, `0094`), so it can be blanked; documents can be voided at the database (`app.void_file`), never deleted, and no product screen voids them yet (§3.6). |
| Audit trail | `audit_log`, `activity`, `employee_document_access`, `doc_event` | No statutory figure of its own; it evidences the financial records, so it follows them. The repository floor is ≥ 6 years. **[LEGAL REVIEW]** | Same. **[LEGAL REVIEW]** | No UPDATE or DELETE grant (`0006`); deliberately excluded from `app.prune_retention` (`0064`); the tenant's own CSV export of `audit_log` is add-on gated (§3.10). |
| Customer and supplier master data | `customer`, `customer_contact`, `supplier`, `lead`, `crm_*` | Business-contact data: keep while the relationship and any claim period lasts; marketing consent as long as marketing continues. **[LEGAL REVIEW]** | Same. **[LEGAL REVIEW]** | Deactivate, never delete; consent history is append-only; the suppression list is never edited (`0122`). |
| Login and security records | `auth.users`, `user_profile`, `sign_in_log`, `membership_invite`, `impersonation_session` | Security logs: commonly kept 6–12 months for abuse detection; no statutory figure. **[LEGAL REVIEW]** | Same. **[LEGAL REVIEW]** | `sign_in_log` is append-only and **never pruned** — it holds IP, user agent and, for failed logins, the email typed. This is a gap (§3.3). |
| Ephemeral: notifications, resolved exceptions, digests, AI metering | `notification`, `exception`, `digest`, `ai_interaction` | None. | None. | Pruned at 90 days / 12 months / 24 months / 90 days by `app.prune_retention` — **only when run**, because the nightly cron waits on Inngest (`runbooks/retention.md`). |
| Response deadline for a request | — | Commonly cited around 30 days, with extensions. **[LEGAL REVIEW]** | Commonly cited around 30 days. **[LEGAL REVIEW]** | Nothing tracks requests today (§5, N9). |

Two things the code does **not** do, and counsel should know: it does not
enforce a *maximum* retention on any business table (nothing is ever disposed
of), and it does not enforce a *minimum* either — it simply never deletes. The
"≥ 6 years" floor in `runbooks/retention.md` is a floor by omission.

---

## 3. Category by category

### 3.1 Employee data — `employee`, `employee_hr`, `employee_terms`, contracts, documents, bank details, payslips

**What is personal here.** `employee` holds name, legal name, Arabic name,
email, phone, nationality, residency status, emergency-contact name / phone /
relation, hire and end dates, manager and an optional link to a login
(`user_id`). `employee_hr` holds ID number, passport number, their expiry dates,
visa expiry and free-text notes. `employee_payment_instruction` holds bank name,
IBAN, account number and WPS identifiers. `employee_terms` holds salary and
hourly cost. `employee_document` links passport / ID / visa / medical scans in
Storage. `employee_contract`, `employee_event`, `payslip`, `pay_run_line` and
`disciplinary_record` are the employment and payroll history.

**What can be done today.**

| Action | Status | How |
| --- | --- | --- |
| End the employment and archive the record | **WORKS TODAY** | Lifecycle `active → notice/terminated → archived`, enforced by trigger; `active` is derived from it (`0094`). |
| Blank contact details, emergency contact, ID and passport numbers, visa dates, notes | **WORKS TODAY, by hand** | Every one of these columns is in the `app_user` UPDATE grant (`0020` lines 80 and 149; `0094` line 186). Nullable, so they can be cleared. |
| Blank bank details | **WORKS TODAY, by hand** | `employee_payment_instruction` update grant covers `iban`, `account_no`, `wps_*`, `bank_name` (`0094` line 428). |
| Replace the name | **WORKS TODAY, by hand** | `employee.name` is `not null`, 1–120 characters, so it must be *replaced* (e.g. `Former employee 7F3A`), not blanked. `legal_name`, `name_ar` and `email` can be nulled. |
| Void identity documents | **WORKS TODAY at the database, by hand** | `employee_document.voided_at` + `void_reason` exist (`0094`), but **no code in `src/` writes `employee_document` at all** — only `src/modules/hr/attention.ts` reads it. The underlying `file` row can be voided through `app.void_file` (`0009`), whose sole application caller, `voidFile` (`src/platform/files/storage.ts` line 365), is exported from `src/platform/files/index.ts` but invoked by nothing except `tests/integration/files.test.ts`; `files.void` is in the permission matrix (`src/platform/authz/matrix.ts` line 198) with no action behind it. So voiding today is an owner running SQL, not a tenant action. The scan itself stays in the bucket (§3.6). |
| Delete the employee row, contract, events, payslips | **Refused by design** | No DELETE grant anywhere in the HR migrations; `employee_event`, `payslip`, `loan_repayment`, `employee_document_access` and `pay_run` carry append-only triggers. |
| One "erase this employee" action that does all of the above, writes an audit row and skips legal holds | **NEW CODE** (N1) | — |

**What cannot be pseudonymised even by new code, without a legal decision:**
`payslip.snapshot`, `payslip.issuer_snapshot` and `pay_run_line.snapshot` freeze
the person's name and pay at issue; `employee_event.detail` may hold names;
`employee_contract` keeps its contract number and dates. These are the statutory
record and the recommended policy is to leave them exactly as issued until
their retention period ends, then dispose of them whole. **[LEGAL REVIEW]**

**Recommended default for an employee.** At end of employment: archive, void
nothing yet. At the end of the employment-records period (D3): replace the name
with a placeholder, blank contact, emergency, identity and bank fields, void the
identity-document scans. Payroll and contract records stay until the
accounting-records period ends, then are disposed of whole (N7).

### 3.2 Customer contacts — `customer`, `customer_contact`, leads, consent, suppression

**What is personal here.** `customer.contact_name / phone / email / notes` (the
legacy embedded contact), `customer_contact.name / email / phone / role_title`,
lead and opportunity contacts, `crm_consent` (who consented to what, with
evidence text), `crm_suppression` (an email or phone number that must not be
contacted), `crm_touch` and sales activities.

| Action | Status | How |
| --- | --- | --- |
| Deactivate a contact, blank email and phone, replace the name | **WORKS TODAY, by hand** | `customer_contact` update grant covers `name, email, phone, active` (`0077` line 55). `name` is `not null`, so replace it. Same for `customer.contact_name / phone / email / notes` (`0020` line 178). |
| Record a withdrawal of consent or an objection | **WORKS TODAY** | Insert a `crm_consent` row with status `withdrawn`, and a `crm_suppression` row. Both are append-only; suppressions are never updated or deleted by the application role (`0122`). |
| Remove the person's address from the suppression list | **Refused by design** | The suppression list *is* the mechanism that honours "never contact me again". Keeping the bare address there, with no name, is the usual practice. **[LEGAL REVIEW]** |
| Rewrite the customer name on issued invoices | **Refused by design** | `invoice.customer_name` and `customer_tax_reg_no` are frozen at issue (not in the UPDATE grant, `0042` line 82). A sole trader's name on an invoice is a tax record. **[LEGAL REVIEW]** |
| Delete the customer row | **Refused by design** | No DELETE grant; invoices, quotes and journals reference it with `on delete restrict`. |

**Recommended default for a customer contact.** Deactivate, replace the name,
blank contact fields, keep the consent history and the suppression entry, leave
issued documents alone. Note that a *company* customer's name and tax
registration number are business data, not personal data, and are not touched.

### 3.3 The audit trail — `audit_log`, `activity`, `sign_in_log`, and the pseudonymisation question

**What the trail holds.** `audit_log` has `actor_user_id` (a UUID pointing at
`user_profile`), an `action`, an `entity_type`/`entity_id`, a `summary` string,
and `before_data` / `after_data` JSON. `activity` is the tenant-visible history
with the same actor column. `sign_in_log` holds `user_id`, `ip`, `user_agent`
and a `detail` JSON that, for a failed login, contains the email typed (the
published privacy policy in `src/app/_legal/content.ts` says so).

**What the grants say.** `app_user` has `select, insert` and an explicit
`revoke update, delete` on `audit_log` and `activity` (`0006` lines 34–35 and
59–60). `sign_in_log` is `select, insert` only. None of the three is touched by
`app.prune_retention`.

**The important fact for erasure: the actor is already a pseudonym.** The trail
names the person by UUID. The readable name is looked up from
`user_profile.full_name` when the trail is displayed or exported. Clear that
one field (§3.8) and every audit row that person ever created shows an opaque
id — without editing a single audit row.

**Where names leak into the trail anyway.** The `summary` string is written by
the application and sometimes embeds a name or an email: `membership.invite`
writes `Invited <email> as <role>`, `membership.deactivate` writes
`Deactivated member <name>` (`src/platform/auth/identity.ts` lines 202 and
417). `before_data` / `after_data` can carry whole records, including contact
fields. So "clear the profile" removes the actor's name but not every mention of
a *subject's* name inside summaries.

**The three answers to O-4, stated so the owner can pick one (decision D1):**

| Option | What it means | Engineering | Honest downside |
| --- | --- | --- | --- |
| **A. Retain** | Rows are never edited. The actor becomes opaque when the profile is cleared; names inside summaries stay for the row's retention period, on a legal-obligation / legitimate-interest basis. **[LEGAL REVIEW]** | None beyond §3.8. | Residual names in summary text and JSON for up to the retention period. |
| **B. Pseudonymise in place** | A platform-only function rewrites `summary`, `before_data`, `after_data` for one subject, replacing name and email with the opaque id, and writes its own audit row saying it did so. | **NEW CODE** (N8): a `SECURITY DEFINER` function guarded by `app.assert_platform_task()`, like `app.prune_retention`; a script; a runbook entry. | Breaks the "append-only, ever" promise the pilot documents make about the audit log. Must be disclosed to tenants and to counsel. |
| **C. Remove** | Delete the person's audit rows. | Would need the same platform path. | Destroys the financial evidence floor. **Not recommended under any answer from counsel.** |

**Recommended default: A**, with B built only if counsel says residual names in
summaries are not defensible. `sign_in_log` should be added to the retention
pruner with a 12-month window (**NEW CODE**, N2) — it is the one security log
that grows forever and holds IP addresses and typed emails. **[LEGAL REVIEW]**
on the window.

### 3.4 Financial and tax records — invoices, journals, tax returns

Nothing here is erased or pseudonymised on request. The recommended policy is
retention for the full period in §2, then disposal whole.

What the database already guarantees (**WORKS TODAY**):

- Issued invoices and their lines are immutable except the columns in the
  `app_user` UPDATE grant — `status`, `issued_at`, `due_date`, `cancelled_at`,
  `cancel_reason`, `pdf_file_id`, `updated_at` (`0042` line 82); the customer
  name, tax registration number, amounts and lines are frozen, and corrections
  are credit notes.
- Posted journal entries and lines are immutable; correction is reversal
  (`0100`); a locked fiscal period refuses edits.
- `tax_entry` rows are frozen by trigger; a locked `tax_return` is immutable and
  cannot be deleted; correction is an amending return (`0105`).
- Finalised pay runs and payslips are immutable (§3.1).
- No DELETE grant on any of these tables. The only DELETE grant `app_user`
  holds on a business table anywhere in the schema is `org_holiday_calendar`
  (`0021`); the draft-line deletes on reports were revoked in `0032`.

Personal data inside these records: `customer_name` on invoices (a person's
name when the customer is an individual), `created_by` / `posted_by` /
`prepared_by` / `reviewed_by` UUIDs, and free-text memos and descriptions that
staff typed. The UUIDs go opaque with the profile (§3.8); the free text stays.
**[LEGAL REVIEW]**

Disposal after the period is **NEW CODE** (N7): **no code deletes an issued,
posted, locked or finalised financial record.** Stated precisely, because
counsel will ask what *does* delete rows: `app.delete_draft_journal_line`
(`0100` line 575, granted to `app_user`) deletes a *draft* journal line;
pay-run line regeneration deletes and rebuilds `pay_run_line` for a run that is
not yet finalised (`0097` line 355); cancelling a leave request deletes the
future `attendance` rows it had generated (`0096`); the labour-cost freeze
recomputes `report_labour_cost` (`0029` line 112, `0032` line 49);
`app.prune_retention` (`0064`) deletes from the four ephemeral tables in §2;
and the configuration pipeline rewrites `org_holiday_calendar`
(`src/platform/config/pipeline.ts`, §3.9). Every one of those is a draft,
derived or ephemeral row, and none reaches the tables in this section once a
record is issued, posted or locked. Beyond them, the whole-tenant fixture
scripts in §3.9 are the only code that deletes business rows.

### 3.5 Backups, logs, queues and third parties — copies the product does not control row by row

Backups cannot be edited. Erasure reaches them when they expire. The policy
therefore has to *state the window*, and today the window is not known from
this machine.

| Copy | What it holds | Retention (vendor documentation) | Status |
| --- | --- | --- | --- |
| Supabase daily backups | The database, **not** Storage objects — "Database backups do not include objects you store via the Storage API". | Free: none; Pro: last 7 days; Team: 14 days; Enterprise: up to 30 days. PITR is a paid add-on on Pro and above with 7, 14 or 28-day windows, and replaces daily backups when enabled. Source: https://supabase.com/docs/guides/platform/backups | **UNVERIFIED — owner action.** The plan tier and PITR status of project `anhgeeutrwftsvuzfinf` could not be read from this machine. `runbooks/backup-monitoring.md` records PITR as **not enabled** and the project as holding "default daily backups only"; whether the project is on Free (no backups at all) or Pro (7 days) is the owner's to confirm and write into D7. |
| Second-provider logical backups (`runbooks/backup-monitoring.md` layer B) | A full `pg_dump`. | Whatever the owner sets. | Not provisioned. If it is, its retention becomes part of this policy. |
| Storage replication (layer C) | Copies of both buckets. | Whatever the owner sets. | Not provisioned. Note the consequence: with no backup of Storage, a deleted object is gone immediately. |
| Vercel runtime logs | Request logs tagged `request_id`; whether application log lines include personal data was **not audited** here. | Hobby: 1 hour; Pro: 1 day; Enterprise: 3 days; 30 days with Observability Plus. Source: https://vercel.com/docs/logs/runtime | Plan tier: **UNVERIFIED — owner action.** |
| Inngest (queue) | Event payloads and run history for every background job. | Trace/log history: Free 24 hours; Basic 7 days; Pro 14 days; Enterprise 90 days. Source: https://www.inngest.com/docs/usage-limits/inngest | **Not provisioned** — nothing has ever reached Inngest. The 11 unprocessed `domain_event` rows sit in the database; the relay prunes them 30–90 days *after processing*, which has never happened. |
| Resend (email) | Sent emails, including recipient addresses and bodies. | "Resend retains email data for 30 days across all plans (with flexible retention for Enterprise)". Source: https://resend.com/docs/dashboard/webhooks/how-to-store-webhooks-data | **Not provisioned** — no email has ever been sent. |
| Sentry | Error reports. | — | **Not provisioned.** If provisioned, scrubbing must be confirmed first (`runbooks/sentry-provisioning.md`). |

Region note for counsel: the database and application run in Seoul
(`aws-1-ap-northeast-2`, Vercel `icn1`). Whether UAE or KSA tenants' personal
data may be held there, and on what transfer basis, is the open E8 item in
`docs/pilot/06-launch-criteria-checklist.md`. **[LEGAL REVIEW]**

**Recommended default (D7):** the policy states that erasure completes when the
last backup containing the data expires; the owner records the backup and PITR
window once (O-2) and the number is written into the DPA. Backups are never
restored to "un-erase" a person except under legal hold or incident recovery,
and a restore triggers a re-run of every erasure performed since the backup was
taken. **NEW CODE** for the re-run list (N9).

### 3.6 Files — Storage objects, `file` rows, `legal_hold`

**What exists.**

- Every upload is a `file` row plus an object in a private bucket
  (`tenant-media` or `tenant-docs`). The row carries `legal_hold`, `voided_at`,
  `voided_by`, `void_reason`, `created_by` (`0008`). **WORKS TODAY.**
- **Void** is the only removal, and it exists only at the database.
  `app.void_file` (`0009`) is pinned to the caller's org and user, refuses an
  already-voided file, and **refuses a file under legal hold**; `app_user` has
  no DELETE on `file` and no UPDATE on the hold/void columns except through
  these functions. Its application wrapper `voidFile`
  (`src/platform/files/storage.ts` line 365) is exported from
  `src/platform/files/index.ts` and exercised by
  `tests/integration/files.test.ts`, but **no route, server action or screen
  calls it**; `files.void` is in the permission matrix with nothing behind it.
  **WORKS TODAY at the database, by hand** — the function and its guards are
  real and tested; the product surface is **NEW CODE** (N1, N3).
- **Legal hold** exists at three levels: per file (`app.set_legal_hold`, gated
  by `files.legal_hold` = owner/admin in `src/platform/authz/matrix.ts` line
  199), per Document Studio document (`doc_document.legal_hold`, set by
  `setLegalHold` in `src/modules/docstudio/documents.ts` line 1254, which is
  gated by the **same** `files.legal_hold` permission — `documents.legal_hold`
  is only the `audit_log` action label that path writes, not a permission key),
  and per organisation (`org_plan_state.legal_hold`, which makes
  `app.advance_subscription` refuse purge, `0059`). Placing and lifting a hold
  is a written-instruction action in `runbooks/legal-hold.md`. **WORKS TODAY.**
- Document Studio stamps `retention_until` at issue from the organisation's
  `retentionYears` setting (default 7 years, per `docs/H26-REPORT.md`) and the
  trigger in `0114` only lets it be lengthened.

**What does not exist (NEW CODE).**

- **No product code path deletes a Storage object.** The only
  `storage.from(bucket).remove(...)` call in `src/` or `tooling/` is
  `tooling/scripts/reset-test-db.ts` line 93 — a test-database reset tool that
  runs with the service-role key against a test project, not a tenant or
  platform action, and not something the product can point at production.
  Nothing in `src/` calls `remove`; the nightly `storage-reconcile` worker
  only *counts* orphans. Migration `0010` says voided-but-unpurged objects are
  "expected residue awaiting the later-slice purge pipelines". That slice has
  not been built. A voided passport scan is therefore still in the bucket.
- No job acts on `retention_until` when the date passes.

**Vendor facts that shape the design.** Supabase: deletion through the Storage
API is permanent and unrecoverable; deleting via SQL orphans the object rather
than removing it; the `remove` call takes at most 1,000 objects. Source:
https://supabase.com/docs/guides/storage/management/delete-objects. Database
backups do not contain the objects (§3.5), so there is no backup copy unless the
owner provisions replication.

**Recommended default (D4):** void at once on request; a platform job physically
deletes the objects of files voided more than 30 days ago, skipping any file,
document or organisation under legal hold, and writes an audit row per file
through `app.record_platform_audit`. **NEW CODE** (N3). For identity documents
the 30-day grace is the only "undo" there will ever be, because Storage has no
backup.

### 3.7 A person in several organisations

`membership` is one row per person per organisation (`0003`); deactivation is
per organisation and is performed by that organisation's owner or admin
(`members.deactivate`). `user_profile` is **one row per login, shared by every
organisation** the person belongs to. An employee record, by contrast, is
per organisation and may or may not be linked to a login (`employee.user_id`).

Consequences the policy must state:

- An erasure request received by **one** organisation reaches that
  organisation's employee and contact rows and that membership — and nothing in
  any other organisation. The other organisations are separate controllers.
  **[LEGAL REVIEW]** on the controller/processor split: the working assumption
  in this draft is that each tenant is the controller of its workspace data and
  IdaraWorks is the controller of the login identity (`auth.users`,
  `user_profile`). **[LEGAL REVIEW]**
- The shared profile (name) is cleared only when the person asks IdaraWorks
  directly as the account holder, or when they hold no active membership
  anywhere. Clearing it while another organisation still employs them would
  remove their name from that employer's screens.
- Both cleanup scripts already encode this rule: `tooling/scripts/s7-cleanup.ts`
  removes a login only when the person is a member of nothing else, and
  `tooling/pilot-lab/cleanup.ts` removes only logins on its reserved
  `pilot-lab.invalid` domain. **WORKS TODAY** as a rule; the account-holder
  path itself is §3.8.

### 3.8 Deleting a login — `auth.users` + `user_profile`

**What exists.** No self-service account deletion: the account page offers
language and "sign out other devices" only (`src/app/(auth)/account`,
`src/app/(auth)/actions.ts`). The only writes to `user_profile` in the
application are the locale (`actions.ts` line 55, onboarding line 120).
`runbooks/access-revocation.md` §2 explicitly forbids hard-deleting an auth
user as a revocation step.

**What the schema makes impossible without platform access.**

- `user_profile.id` references `auth.users(id)` **on delete restrict**; about
  270 column definitions across the migrations reference `public.user_profile`,
  none with cascade or set-null. A hard delete of a login fails on the first
  audit row, invoice or file that person ever touched. This is deliberate
  (history survives the person) and it is the opposite of Supabase's generic
  guidance to cascade from `auth.users`, which the schema rejects on purpose.
  Source for the guidance: https://supabase.com/docs/guides/auth/managing-user-data
- The `user_profile` row-level policy allows a person to update **only their
  own** row (`with check (id = current_user_id())`, `0004`). An owner or admin
  cannot clear someone else's name through the application role; only the
  person, or a platform path, can.
- The H30 privacy checklist (§4) says a user's profile "can be cleared". H33
  found no code path that does it. Treat it as **NEW CODE**, small.

**Vendor fact.** `auth.admin.deleteUser(id, shouldSoftDelete)` needs the
service-role key (server only). With `shouldSoftDelete: true` the user is
"soft-deleted from the auth schema. Soft deletion allows user identification
from the hashed user ID but is not reversible." Source:
https://supabase.com/docs/reference/javascript/auth-admin-deleteuser

**Recommended default (D5): account closure, not account deletion.** A
tooling script run with the service-role key from `.env.local` (never Vercel
runtime), in this order: deactivate every membership (audited through the
normal path); global sign-out; set `user_profile.full_name = ''` and locale to
default; null the email in any `membership_invite` rows and `sign_in_log.detail`
entries for that person; soft-delete the `auth.users` row; write one
`app.record_platform_audit` row per organisation the person belonged to; log it
in the ops log. The UUID stays valid, so every historical reference still
resolves — to nothing readable. **NEW CODE** (N4). Whether a soft-deleted auth
row satisfies "erasure" of the login identity is a question for counsel.
**[LEGAL REVIEW]**

### 3.9 Ending a whole organisation — tenant termination

Two mechanisms exist, and only one of them deletes anything.

**The subscription lifecycle (WORKS TODAY, but it is a label).**
`active → cancelled` (read-only, exports still allowed, ~60-day window) →
`purge_pending` (~7-day lead) → `purged` (terminal). Every transition goes
through `app.advance_subscription`, which refuses to reach `purged` while
`org_plan_state.legal_hold` is set (`0059`); the sweep that walks the deadlines
is dormant until Inngest is provisioned (`runbooks/cancellation.md`). **What
`purged` does not do:** delete anything. A search of `src/` finds no statement
that deletes tenant rows wholesale: the only `delete from public.` in the
application is the holiday-calendar rewrite in the configuration pipeline
(`src/platform/config/pipeline.ts`), the database functions the application
calls delete only draft, derived or ephemeral rows (§3.4), and there is no
Storage delete in `src/` (§3.6). `runbooks/exports.md` §4 mentions a "governed org-closure/purge pipeline"
that writes a bundle to a closure prefix before purge; H33 could not find that
code and treats it as **not built**.

**The guarded cleanup pattern (WORKS TODAY, for fixtures only).**
`tooling/scripts/s7-cleanup.ts` deletes an organisation only when
`classifyOrg()` returns `confirmed_fixture` — the suite's own marker
(`app_settings.key = 'test.fixture'`) or three independent kinds of evidence —
and classifies any organisation with a real login as `live`, which it never
deletes. It identifies the target project positively, demands
`--confirm=delete-fixtures-in-<ref>` on production, re-classifies inside the
transaction, deletes every `org_id`-bearing table under
`session_replication_role = replica`, then the organisation, then logins that
belong to nothing else. `tooling/pilot-lab/cleanup.ts` is the same pattern with
its own marker (`h33.pilot_lab`) and an exact-count gate. **Neither script can
terminate a real customer**, and that is correct.

**What a real termination needs (NEW CODE, N5).** A termination script in the
same four-gate shape, where the "marker" is a termination record the owner
writes deliberately (organisation id, requested-by, date, export confirmed,
legal-hold check) rather than fixture evidence, plus the two things the fixture
scripts never needed: deletion of the organisation's Storage objects through the
Storage API (1,000 per call; §3.6), and a platform audit record that survives
the tenant (the tenant's own `audit_log` goes with it). It must refuse while
`org_plan_state.legal_hold` is true and while any of the organisation's files
or documents are held.

**Recommended default (D6).** Export first, always (§3.10). Read-only window of
60 days as already configured; no purge inside it; purge only on the owner's
explicit run of the termination script; IdaraWorks keeps only what its own
accounting needs about the former tenant (billing state history,
`subscription_event`, its invoices to that tenant) for IdaraWorks' own
accounting-records period. **[LEGAL REVIEW]** on what a processor may retain
after the controller leaves, and on whose obligation the tenant's tax records
become once exported.

### 3.10 Export before deletion

**WORKS TODAY.** `Settings → Export` / `GET /api/o/<org>/export?entity=…`:
**seventeen CSV entities** in `EXPORT_ENTITIES` (`src/platform/export/service.ts`
line 62) — `jobs`, `customers`, `suppliers`, `invoices`, `payments`, `expenses`,
`daily_reports`, `audit_log`, `employees`, `leave_requests`, `expense_claims`,
`payslips`, `leads`, `opportunities`, `sales_activities`, `gl_accounts`,
`journal_entries` — paged past the 1,000-row cap, money columns redacted for
callers without price/cost privilege, formula-injection-safe, allowed in every
read-only billing state. Gate: `data.export` = owner, admin, accounts.

A correction to the first draft, and a stale runbook: `runbooks/exports.md` §2
still lists the original **eight** entities, and its verification step reads
"the route's catalogue == the eight keys". The nine HR, CRM and ledger entities
were added in H23H, H24I and H27B (commits `e43e82a`, `7e79363`, `0e1d5a2`)
and the runbook was not updated; the first draft of this document copied the
runbook. The code is the truth: **employees and payslips are exportable
today.** The runbook needs a documentation fix (not code) so that its own
verification step stops asserting eight.

**Limits the policy must be honest about.**

- **`audit_log` is add-on gated.** The `audit_log` entity is hidden unless the
  organisation has `feat.audit_export` (`addon.audit_history`) —
  `src/app/(app)/o/[orgId]/settings/export/page.tsx` line 22 — and the route
  refuses it server-side with `403 addon_required`
  (`src/app/api/o/[orgId]/export/route.ts` line 84). The other sixteen
  data-portability entities are unconditional. A tenant without the add-on
  **cannot export its own audit trail through the product**; for a
  subject-access request or a pre-termination bundle the platform has to pull
  it for them under the break-glass procedure. This must be said in the DPA.
- **Organisation-scoped, not person-scoped.** A subject-access request for one
  employee cannot be answered from the export as it stands: `employees`
  (`employee_no`, `name`, `name_ar`, lifecycle, employment type, …),
  `payslips` (`slip_no`, employee, period, gross, net, issued), `leave_requests`
  and `expense_claims` each have to be filtered to the person by hand, and the
  columns that matter most for erasure — `employee_hr` identity numbers,
  `employee_payment_instruction` bank details, contracts, lifecycle events,
  documents — are in **no** entity.
- **Still outside the catalogue:** documents and files (Document Studio
  documents and every Storage object), stock (warehouses, movements, balances),
  assets, purchase orders and goods receipts, quotes, attendance, the employee
  identity and bank tables, contracts and lifecycle events. A terminated tenant
  that used procurement, stock or Document Studio would lose that history if it
  relied on this export alone; a tenant that ran payroll keeps its payslip
  summaries but not the underlying pay-run lines or loan records. Today the gap
  is closed only by a `DIRECT_URL` dump under the break-glass procedure, or a
  restore-drill-style `pg_dump`.
- **The export itself is not audited** (no `audit_log` row is written for a
  download; `runbooks/exports.md` says so explicitly).

**Recommended default.** Before any termination: the full seventeen-entity
export run by an owner (so money columns are filled), with `audit_log` pulled by
the platform under break-glass if the tenant lacks the add-on; a `pg_dump`-style
bundle for the families outside the catalogue; and a written confirmation from
the tenant that they received it — the termination script (N5) refuses without
that record. Before any real HR pilot: add documents/files, attendance,
contracts and the employee identity and bank tables to the catalogue, add a
**per-person bundle** for subject-access requests, and write an audit row per
download. Stock, assets, purchase orders and quotes follow. **NEW CODE** (N6).

---

## 4. The procedure this policy implies

For the owner to read once and hand to whoever answers the first request.

| Step | Who | What happens | Status |
| --- | --- | --- | --- |
| 1. Receive and log | Named person (D8) | Record who asked, on whose behalf, which organisation(s), the date; start the response clock (D8). | **NEW CODE** for the register (N9); a spreadsheet is acceptable meanwhile. |
| 2. Verify identity | Same | Confirm the requester is the person (or the tenant owner acting for them). | Manual. |
| 3. Classify | Same | Employee of a tenant / customer contact of a tenant / account holder / whole tenant. Each maps to a section above. | Manual. |
| 4. Check holds | Same | `org_plan_state.legal_hold`, `file.legal_hold`, `doc_document.legal_hold` and the hold log in `runbooks/legal-hold.md`. A hold stops everything below except step 5. | **WORKS TODAY** (read). |
| 5. Cut access | Tenant owner/admin; owner for global sign-out | `runbooks/access-revocation.md` layers 1–2. | **WORKS TODAY**. |
| 6. Export if requested | Tenant owner/admin/accounts; platform for `audit_log` when the tenant lacks the add-on | §3.10. `employees`, `payslips`, `leave_requests`, `expense_claims` exist — filter to the person by hand; identity, bank, contract and document tables are not exportable. | **PARTIAL**. |
| 7. Erase the free identifiers | Tenant owner/admin (by hand) or the N1 script | §3.1 / §3.2 field list. | **PARTIAL** today, **NEW CODE** for one action. |
| 8. Close the login | Owner (service-role script) | §3.8. | **NEW CODE** (N4). |
| 9. Void files | Owner, by SQL, today (no product action exists); tenant owner/admin once N1 ships | §3.6 — `app.void_file` refuses held files; physical deletion follows after the grace period (N3). | **PARTIAL** — function exists with no product surface. |
| 10. Reply | Named person | State what was erased, what is retained and why (the §2 category and period), when backups expire (D7). | Manual. |
| 11. Retention end | Platform job | Dispose of records past their period, skipping holds, with an audit row. | **NEW CODE** (N7). |

---

## 5. What would require new code

None of this is started. Sizes are rough and relative.

| # | Build | Why | Size |
| --- | --- | --- | --- |
| N1 | "Erase this person" platform action for an employee or contact: placeholder name, null the identifier columns in §3.1/§3.2, void identity documents (the first product caller of `app.void_file` / `voidFile`, and the first code that writes `employee_document.voided_at`), one audit row, refuses under hold | Today each field is edited by hand, voiding is SQL-only, and nothing records that an erasure happened | Medium |
| N2 | Add `sign_in_log` to `app.prune_retention` with a 12-month window (migration) | The one security log that grows forever and holds IPs and typed emails | Small |
| N3 | Storage purge job: delete objects for files voided > grace days, skip holds, audit per file, 1,000 per call — plus a void action in the product if N1 has not shipped first | Voided files are still in the bucket; migration `0010` promised this slice; `app.void_file` has no caller outside tests | Medium |
| N4 | Account-closure script: deactivate memberships, global sign-out, clear profile, scrub invite/sign-in emails, soft-delete `auth.users`, platform audit rows | No path exists; the H30 claim that a profile "can be cleared" has no code behind it | Small–medium |
| N5 | Tenant-termination script in the four-gate pattern, with Storage deletion and a surviving platform record; refuses under hold or without export confirmation | `purged` is a label; the fixture scripts correctly refuse live tenants | Medium |
| N6 | Export: add documents/files, attendance, contracts, the employee identity and bank tables, stock, assets, purchase orders and goods receipts, quotes; add a per-person bundle; audit the download; give the platform a governed way to pull `audit_log` for a tenant without the add-on (`employees`, `payslips`, `leave_requests`, `expense_claims` already exist — do not rebuild them) | Subject-access and pre-termination bundles are incomplete today | Medium–large |
| N7 | Retention disposal job acting on `retention_until` and on the §2 periods per family, dry-run first, audited, hold-aware | Nothing ever disposes of a record; the floor is a floor by omission | Large, and blocked on D2 |
| N8 | Audit-log in-place pseudonymisation function (platform-only) | Only if counsel rejects option A in §3.3 | Medium, and blocked on D1 |
| N9 | Erasure-request register and "re-run after restore" list | Deadlines (D8) and the backup-restore caveat in §3.5 need a record | Small |

---

## 6. Decision table — only the choices the owner must make

Each row is a genuine choice. Nothing below is decided by this document.

| # | Decision | Options | Recommended default | Consequence of the default |
| --- | --- | --- | --- | --- |
| **D1** | What happens to a person's name in the audit trail after an erasure request (this is O-4) | A. Retain rows as written; the actor goes opaque when the profile is cleared. B. Pseudonymise summaries and JSON in place (N8). C. Delete their rows. | **A**, with B held in reserve pending counsel. **[LEGAL REVIEW]** | Residual names in summary text remain for the retention period; no change to the append-only promise; no new code beyond N4. |
| **D2** | The retention period the product applies to financial, tax and payroll records | Per-country figures (UAE 5 years, KSA 6 or 10 years, commonly cited — verify); or one floor for everyone. | **One floor of 7 years for issued financial and payroll documents, 6 years minimum for the audit log**, matching the H26 default and the existing `retention.md` floor. **[LEGAL REVIEW]** | Longer than the commonly cited UAE minimum; possibly shorter than the commonly cited KSA company-law figure, which counsel must check before a KSA tenant. Blocks N7 until decided. |
| **D3** | When an ex-employee's identifiers (contacts, ID/passport numbers, bank details, scans) are erased | At end of employment; 2 years after (commonly cited UAE employee-file figure — verify); or with the financial records at D2. | **2 years after the employment ends**, with payroll and contracts kept to D2. **[LEGAL REVIEW]** | An ex-employee's passport number and IBAN persist for 2 years; after that only the statutory payroll record remains. |
| **D4** | Physical deletion of voided files | Never (void only); after a grace period; immediately. | **30-day grace, then delete, never under hold** (N3). | A voided identity scan is unrecoverable 30 days after voiding, because Storage has no backup. |
| **D5** | What "delete my account" means | Soft-delete the auth user and clear the profile (N4); hard delete with FK surgery; refuse. | **Soft-delete + clear** (N4). **[LEGAL REVIEW]** on whether that satisfies erasure of the login identity. | The opaque UUID survives in history; nothing readable about the person remains in the login system. |
| **D6** | Tenant termination: window and what IdaraWorks keeps afterwards | 60-day read-only window (current default) or another; keep nothing vs keep IdaraWorks' own billing/accounting records about the tenant. | **60 days; purge only by the owner running N5 after export confirmation; keep only IdaraWorks' own accounting records for the D2 period.** **[LEGAL REVIEW]** | A tenant that never exports still loses its data after 60 days plus the purge lead; IdaraWorks retains billing history about them. |
| **D7** | How the policy treats backups | State the expiry window and accept that erasure completes at expiry; or attempt to scrub backups (not possible with managed backups). | **State the window** — which requires the owner to confirm the Supabase plan tier and PITR status (O-2) and write the number into the DPA. **UNVERIFIED — owner action.** | The promised erasure date is "request date + backup window"; if the project is on the Free tier there are no backups at all and that, too, must be said. |
| **D8** | Who answers erasure requests, and within how many days | A named person or role; deadline commonly cited around 30 days — verify. | **The owner, personally, for the pilot; 30 days.** **[LEGAL REVIEW]** | The owner is the single point of failure for the pilot; acceptable at pilot scale, not beyond. |

---

## 7. Nothing is erased by this document

- **No row, file, backup, login or organisation in production was changed,
  and none will be changed by adopting this draft.** Every action above is
  either a tenant-owner action in the product, an owner action behind a
  confirmation phrase, or new code that does not exist yet.
- No database connection was opened while writing this; the production facts
  used (project, region, buckets, unprovisioned services, the eleven stalled
  events, PO-002) are the read-only Part A facts of `docs/H33-TRUTH-MAP.md`.
- PO-002 (Najolatech) is untouched and must stay so; it is unrelated to
  erasure and is mentioned only because the same rule applies: a change to a
  real customer's records is the owner's call.
- The cleanup scripts named in §3.9 were read, not run.

---

## 8. Sources

### 8.1 Repository files read

`docs/H30-PRIVACY-CHECKLIST.md`, `docs/H30-OWNER-CHECKLIST.md`,
`docs/H30-REPORT.md` (§4–5), `docs/H33-TRUTH-MAP.md`, `docs/H26-TRUTH-MAP.md`
(B5), `docs/pilot/06-launch-criteria-checklist.md` (E6–E8),
`runbooks/retention.md`, `runbooks/legal-hold.md`, `runbooks/data-cleanup.md`,
`runbooks/access-revocation.md`, `runbooks/exports.md`,
`runbooks/cancellation.md`, `runbooks/backup-monitoring.md`,
`runbooks/restore-drill.md`, `runbooks/README.md`;
migrations `0001`, `0003`, `0004`, `0005`, `0006`, `0007`, `0008`, `0009`,
`0010`, `0011`, `0020`, `0021`, `0032`, `0042`, `0052`, `0053`, `0054`, `0056`,
`0059`, `0064`, `0077`, `0094`, `0097`, `0100`, `0105`, `0114`, `0115`,
`0122`, `0124`, `0129`, `0131`, and on the revision pass `0028`, `0029`,
`0096`;
`src/platform/auth/identity.ts`, `src/app/(auth)/actions.ts`,
`src/app/(auth)/account/`, `src/app/_legal/content.ts`,
`src/platform/authz/matrix.ts`, `src/platform/authz/matrix.data.ts`,
`src/platform/export/service.ts` (`EXPORT_ENTITIES` read key by key on the
revision pass — the first draft had taken the catalogue from
`runbooks/exports.md` §2, which is stale; see §3.10),
`src/app/(app)/o/[orgId]/settings/export/page.tsx`,
`src/app/api/o/[orgId]/export/route.ts`,
`src/platform/files/storage.ts`, `src/platform/files/index.ts`,
`src/modules/hr/attention.ts`, `src/platform/config/pipeline.ts`,
`src/modules/docstudio/documents.ts`, `src/modules/subscription/machine.ts`,
`src/modules/subscription/service.ts`,
`src/workers/functions/subscription-worker.ts`,
`src/workers/functions/storage-reconcile.ts`,
`tests/integration/files.test.ts`,
`tooling/scripts/s7-cleanup.ts`, `tooling/scripts/reset-test-db.ts`,
`tooling/fixtures/evidence.ts`,
`tooling/pilot-lab/cleanup.ts`, `tooling/pilot-lab/marker.ts`.

### 8.2 Vendor documentation cited

- https://supabase.com/docs/guides/platform/backups — daily-backup retention by plan, PITR windows, backups exclude Storage objects.
- https://supabase.com/docs/reference/javascript/auth-admin-deleteuser — `shouldSoftDelete`, service-role requirement.
- https://supabase.com/docs/guides/auth/managing-user-data — Supabase's cascade guidance, which this schema deliberately does not follow.
- https://supabase.com/docs/guides/storage/management/delete-objects — permanence of Storage deletion, 1,000-object limit, SQL deletes orphan objects.
- https://vercel.com/docs/logs/runtime — runtime-log retention by plan.
- https://www.inngest.com/docs/usage-limits/inngest — trace and log history retention by plan.
- https://resend.com/docs/dashboard/webhooks/how-to-store-webhooks-data — 30-day email data retention.

### 8.3 Could not be verified from this machine

- Supabase plan tier, PITR status and backup listing for the production project (D7, O-1, O-2). **UNVERIFIED — owner action.**
- Vercel plan tier, and whether application log lines contain personal data. **UNVERIFIED — owner action.**
- Whether any pilot tenant sits in a free zone with its own regime. **UNVERIFIED — owner action.**
- Every retention period and every "commonly cited" legal statement in §2, §3 and §6. **[LEGAL REVIEW]**
