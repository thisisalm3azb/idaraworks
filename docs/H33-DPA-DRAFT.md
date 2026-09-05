# H33 — Data Processing Agreement (DPA)

## DRAFT FOR PROFESSIONAL REVIEW — NOT FOR SIGNATURE

Prepared 2026-09-05 from the repository (branch `verify/h33`) and the production
facts recorded in `docs/H33-TRUTH-MAP.md` Part A. Nothing in this file has been
reviewed by a lawyer. **It is not legally approved and must not be described as
such.**

---

## Preface — what this draft is, and is not

**What it is.** A first, plain-language draft of the agreement under which
IdaraWorks would process a customer's data on that customer's behalf. It is
written so that a business owner can read it once and understand what is being
promised. The security, retention, export and access statements in it are taken
from the code and runbooks as they stood on 2026-09-05, not from intentions. Where
a promise cannot yet be kept, the draft says so rather than papering over it.

**What it is not.**

- It is **not** a legal opinion, and it is **not** a template that has been
  checked against the UAE Personal Data Protection Law (UAE PDPL), the KSA
  Personal Data Protection Law (KSA PDPL), any free-zone regime (for example
  DIFC or ADGM) or any other law. Every clause that turns on a legal question
  carries a visible **[LEGAL REVIEW]** tag.
- It is **not** a certification. IdaraWorks holds no privacy or security
  certification (`docs/H30-PRIVACY-CHECKLIST.md`). Vendor certifications
  mentioned in Annex 3 belong to the vendors, and were read from their public
  pages, not verified independently.
- It does **not** decide the open owner questions. Those are collected in Annex
  4 with an **[OWNER DECISION]** tag, and cross-referenced to
  `docs/H30-OWNER-CHECKLIST.md` (O-1 to O-15).

**How to read the tags.**

| Tag | Meaning |
| --- | --- |
| **[LEGAL REVIEW]** | A qualified adviser in the relevant jurisdiction must review this clause before signature. |
| **[OWNER DECISION]** | A business decision the owner must make before signature; the draft proposes, it does not decide. |
| **UNVERIFIED — owner action** | A fact this draft could not confirm from the repository or from public vendor documentation. The owner confirms it in the relevant dashboard. |

**How this relates to earlier work.** It builds on, and does not repeat:
`docs/H30-PRIVACY-CHECKLIST.md` (§2 the sub-processor table, §6 the erasure
tension, §7 what a pilot customer must be told), `docs/H30-OWNER-CHECKLIST.md`
(O-3 "have a DPA reviewed and signed", O-4 erasure policy, O-8 sub-processor
list, O-9 breach timeline) and `docs/H30-REPORT.md` §5.

---

## DATA PROCESSING AGREEMENT

between

**[IDARAWORKS LEGAL ENTITY NAME]** — *UNVERIFIED — owner action: the legal name,
registration number, licensing authority and registered address of the entity
that operates IdaraWorks do not appear anywhere in the repository; the owner
supplies them* — (the **"Processor"** or **"IdaraWorks"**)

and

**[CUSTOMER LEGAL NAME]**, [registration number], [registered address]
(the **"Controller"** or **"Customer"**)

each a **"Party"**, together the **"Parties"**.

### 1. Roles and purpose of this Agreement

1.1 The Customer uses the IdaraWorks service (the **"Service"**) to run its
business operations: jobs, daily reports, customers, suppliers, quotes,
invoices, payments, expenses, purchasing, stock, HR (employees, attendance,
leave, claims, payroll), documents and sales pipeline. In doing so the Customer
puts personal data about its own employees, customers, suppliers and contacts
into the Service.

1.2 For that data the **Customer is the Controller**: it decides why the data is
collected and how it is used. **IdaraWorks is the Processor**: it stores and
handles the data only to provide the Service, only on the Customer's
instructions, and only as this Agreement describes.

1.3 Some data is IdaraWorks' own to manage, not the Customer's — for example the
account details of the person who signed up, sign-in records used to protect
accounts, and billing records. IdaraWorks acts as a controller for that data
under its own privacy notice, not under this Agreement. **[LEGAL REVIEW]** — the
adviser confirms this split and whether any of it should be moved under this
Agreement.

1.4 This Agreement forms part of the service agreement between the Parties
(the **"Main Agreement"**). If the two conflict on the handling of personal data,
this Agreement wins. **[LEGAL REVIEW]**

**UNVERIFIED — owner action:** no Main Agreement, terms of service or pilot
agreement exists in the repository. This DPA cannot stand alone; the owner must
have a Main Agreement drafted or identify the document this attaches to.

### 2. Definitions

Plain meanings apply. In particular:

- **"Personal Data"** — any information about an identified or identifiable
  person that the Customer puts into the Service.
- **"Processing"** — anything done with that data: storing, reading, editing,
  exporting, backing up, deleting.
- **"Data Subject"** — the person the data is about (an employee, a customer's
  contact, a supplier's contact).
- **"Sub-processor"** — another company IdaraWorks uses to help provide the
  Service and which therefore handles Customer data (Annex 3).
- **"Personal Data Breach"** — a security incident that leads to Customer data
  being lost, destroyed, altered, disclosed to or accessed by someone who should
  not have it.
- **"Applicable Data Protection Law"** — the data protection law that applies to
  the Customer. For a UAE customer this is expected to be the UAE PDPL; for a KSA
  customer the KSA PDPL; a customer in a free zone may be subject to that zone's
  own law. **[LEGAL REVIEW]** — the adviser inserts the exact statute and
  implementing-regulation references per customer and confirms whether any
  definition above must follow the statutory wording.

### 3. Subject matter, duration, nature and purpose

3.1 **Subject matter.** The Personal Data the Customer enters into the Service,
described in Annex 1.

3.2 **Duration.** From the date the Customer's organisation is created in the
Service until all Customer data has been returned or deleted under clause 12.
This is longer than the Main Agreement, because a read-only export window and a
deletion step follow termination (clause 12).

3.3 **Nature.** Hosting, storage, display, editing, calculation (for example
totals, payroll and stock figures), PDF generation, export, backup and deletion —
all performed by the Service on the Customer's own actions. No profiling and no
automated decisions with legal effect are performed. **AI features are switched
off** in production (`FEATURE_IDARA_INTELLIGENCE` off, no provider configured)
and cannot be used until the owner enables them and the Customer completes its
own privacy register in the Service (clause 7.6).

3.4 **Purpose.** To provide the Service to the Customer. IdaraWorks does not use
Customer data for its own purposes, does not sell it, does not use it to train
any model, and does not combine it with other customers' data.

### 4. Processing on the Customer's instructions

4.1 IdaraWorks processes Personal Data **only on the Customer's documented
instructions**. The Customer's instructions are: (a) this Agreement; (b) the
Main Agreement; (c) the actions the Customer's users take in the Service
(creating, editing, exporting, voiding, deleting); and (d) written instructions
the Customer sends later, which IdaraWorks may decline if they would need work
that is not part of the Service.

4.2 If IdaraWorks believes an instruction breaks Applicable Data Protection Law,
it will tell the Customer before acting on it. **[LEGAL REVIEW]**

4.3 If a law that binds IdaraWorks requires it to process Customer data beyond
those instructions (for example a court order), IdaraWorks will inform the
Customer before doing so, unless that law forbids it. **[LEGAL REVIEW]** — the
adviser confirms how UAE and KSA law treat government access requests and
whether the notice promise here is permitted.

4.4 **Support access is on instruction, not by default.** IdaraWorks staff do
not see Customer records in the ordinary course. When a Customer asks for help
that needs a staff member to look inside its organisation, that access is opened
as a recorded "support session" and treated as an instruction from the Customer
(clause 6.4 and Annex 2 §A5).

### 5. Confidentiality

5.1 IdaraWorks keeps Customer data confidential and gives access only to people
who need it to provide the Service, each of whom is bound by a confidentiality
obligation. **UNVERIFIED — owner action:** the repository contains no staff
confidentiality agreement or contractor NDA. At pilot stage IdaraWorks is a
solo operator (`runbooks/incident-response.md` §1); the owner confirms whether any
other person — contractor, developer, adviser — has or will have access, and
puts a written confidentiality obligation in place for each.

5.2 The technical shape of this promise is in Annex 2: platform staff are an
explicit allow-list (`public.platform_staff`), every entry into a Customer's
organisation is recorded in the Customer's own audit log, and raw database
access requires a two-person approval written down before the connection is
opened.

### 6. Security of processing

6.1 IdaraWorks maintains the technical and organisational measures in **Annex
2**. Annex 2 lists only measures that were **read from the code and the runbooks
on 2026-09-05**. It does not list intentions.

6.2 Annex 2 §B lists, with equal honesty, the measures that are **not yet in
place**. The Customer should read §B before signing. Under
`docs/H30-PRIVACY-CHECKLIST.md` §7 the owner has undertaken to tell a pilot
customer these things in conversation as well as in writing. **[OWNER
DECISION]** (O-5)

6.3 IdaraWorks may improve the measures over time and will not reduce the
overall level of protection during the term without telling the Customer.

6.4 **Access by IdaraWorks staff.** Staff may enter a Customer's organisation
only through a recorded support session that (a) is opened by a person on the
platform-staff allow-list, (b) either records the user id of a Customer user who
granted consent — **by policy an owner/admin; the database checks only that a
consenting user id is present, and whether that user is in fact an owner/admin
of the organisation is confirmed by IdaraWorks' periodic review, not by the
code** (Annex 2 §A5, `runbooks/impersonation-history.md` §4) — or is flagged as
an emergency "break-glass" override, (c) runs under the same row-level security
as any Customer user, (d)
shows the Customer a persistent banner while it is open, and (e) writes a start
and an end entry into the Customer's own audit log, which the Customer can view
and export at any time. Every emergency override must be followed by a written
notice to the Customer (clause 9.6).

6.5 **Direct database access ("break-glass").** Access to the production
database outside the Service is permitted only under `runbooks/break-glass.md`:
two named people, approval recorded before access, read-only by default, no
deletion without a separate written approval, a tenant-visible audit row written
afterwards, and a notice to every Customer whose data was viewed (clause 9.6).

### 7. Sub-processors

7.1 The Customer gives IdaraWorks **general written authorisation** to use the
Sub-processors listed in **Annex 3**. Annex 3 distinguishes Sub-processors that
are **active today** from those that are **built into the Service but not
switched on**, and says plainly what each would receive. **[LEGAL REVIEW]** —
the adviser confirms whether general authorisation with notice is acceptable
under the Applicable Data Protection Law or whether specific prior authorisation
is required for each Sub-processor.

7.2 IdaraWorks will give the Customer **at least [30] days' written notice**
before adding a new Sub-processor or switching on one of the conditional ones in
Annex 3. **[OWNER DECISION]** on the number of days. The notice goes by email to
the Customer's owner user. **UNVERIFIED — owner action:** no transactional email
provider is active (Resend key not set), so today this notice would be sent by
hand from an ordinary mailbox; the owner confirms the channel.

7.3 If the Customer reasonably objects within the notice period and the Parties
cannot agree a way round it, the Customer may terminate the Main Agreement for
the affected part of the Service without penalty and take its data out under
clause 12. **[LEGAL REVIEW]**

7.4 IdaraWorks will put obligations on each Sub-processor that protect Customer
data at least as well as this Agreement does, and stays responsible to the
Customer for what each Sub-processor does. **UNVERIFIED — owner action:** the
owner must actually accept or execute each vendor's data processing terms
(Annex 3 gives the location of each). None has been confirmed as executed.

7.5 **What Sub-processors never receive.** No Sub-processor receives Customer
data for its own purposes. The application sends only what each needs to do its
job (Annex 3, column "What it receives").

7.6 **AI providers are a special case.** The Service contains adapters for two
AI providers (OpenAI and Anthropic — `src/platform/ai/adapters/`). They are
**not active**: the feature flag is off and no key is configured. Before any AI
provider can be used for a Customer's organisation, the Customer's own
administrator must record in the Service the lawful basis, the processor
agreement reference, the transfer mechanism, a confirmation of data
minimisation and a retention note (`src/platform/ai/privacy.ts`,
`public.ai_privacy_register`), and the owner must have switched the feature on.
Switching it on counts as adding a Sub-processor under clause 7.2. **[LEGAL
REVIEW]** — the adviser confirms that this register meets the record-keeping
duties of the Applicable Data Protection Law.

### 8. International transfers

8.1 **Where the data lives, stated plainly.** The Customer's data is stored and
processed in **Seoul, South Korea**:

- the database, the authentication service and the file storage run in the
  Supabase project `anhgeeutrwftsvuzfinf`, region `aws-1-ap-northeast-2`
  (Seoul) — Supabase states that the chosen region determines where the primary
  Postgres database, Auth service and Storage objects are hosted
  (`supabase.com/docs/guides/security/gdpr-compliance`, read 2026-09-05);
- the application code runs on Vercel with its functions pinned to region
  `icn1` (Seoul) in `vercel.json`
  (`vercel.com/docs/functions/configuring-functions/region`,
  `vercel.com/docs/edge-network/regions`, read 2026-09-05).

The Service itself copies nothing to any other region: H29's country packs
change rules, not where rows live (`docs/H30-PRIVACY-CHECKLIST.md` §2).

8.2 **Seoul is neither the UAE nor Saudi Arabia.** For a UAE or KSA Customer,
putting employee and customer data into the Service is a **transfer of personal
data outside the country**. **[LEGAL REVIEW]** — this is the single most
important legal question in this draft. The adviser must confirm, per Customer
country: (a) whether the UAE PDPL permits this transfer and on what basis
(adequacy decision, contractual clauses, consent, or another mechanism); (b)
whether the KSA PDPL and its transfer regulations permit it and on what basis,
and whether any data category (for example national ID or visa documents)
carries a stricter rule; (c) whether a free-zone regime applies instead; and
(d) whether a transfer impact assessment or regulator notification is required.
`docs/pilot/PILOT_OWNER_ACTIONS.md` A6 already records that a KSA pilot holding
visa/ID documents needs a documented lawful-transfer basis **before** such
documents are uploaded.

8.3 **Where else data may go, beyond IdaraWorks' control.** The Customer should
know that:

- Supabase states that backups, logs, data exported to external systems, Edge
  Function execution and its own sub-processors "can affect your data residency
  and international transfer analysis" (same GDPR page). The Service uses no
  Supabase Edge Functions; it does rely on Supabase's backups and logs.
- Vercel operates a global content network: requests from the Customer's users
  are terminated at the nearest Vercel point of presence and routed to the Seoul
  region over Vercel's private network; Vercel states it "may transfer data to
  and in the United States and anywhere else in the world where Vercel or its
  service providers maintain data processing operations"
  (`vercel.com/docs/security/compliance`, read 2026-09-05). Vercel's runtime logs
  hold request metadata (path, status, request id, user agent, and the
  identifiers IdaraWorks logs — see Annex 2 §A9).
- The **conditional** Sub-processors in Annex 3 (Resend, Inngest, Sentry, an AI
  provider, Upstash) are, where their documentation states it, **hosted in the
  United States**. Switching any of them on adds a US transfer and triggers
  clause 7.2.

8.4 **Relocation is possible for one layer only.** Vercel offers a Dubai region
(`dxb1`); the application could be re-pinned there by a configuration change.
The Supabase regions page read on 2026-09-05 listed regions in North America,
Europe, Asia-Pacific and South America; **no Gulf region appeared in the summary
read — UNVERIFIED — owner action** to confirm on `supabase.com/docs/guides/platform/regions`.
Moving the database would be a migration project, not a setting.
**[OWNER DECISION]** — whether to pursue relocation of either layer before or
during a pilot; **[LEGAL REVIEW]** on whether it changes the analysis.

8.5 IdaraWorks will not move the Customer's primary data to a different country
without the notice and objection right in clause 7.2.

### 9. Personal Data Breach

9.1 IdaraWorks handles security incidents under
`runbooks/incident-response.md`: detect, declare severity, contain, establish
exactly which organisations were affected and in what time window, notify,
remediate, and write a blameless post-mortem with a regression test before the
incident is closed.

9.2 **Notice to the Customer.** IdaraWorks will notify the Customer of a
Personal Data Breach affecting its data **without undue delay and in any event
within [ 24 / 48 / 72 ] hours** of becoming aware of it. **[OWNER DECISION]
(O-9)** — the runbook deliberately does not hard-code a number; it records the
clock start (the SEV-1 declaration time, in UTC) and leaves the window to the
owner because the regulatory window differs by Customer country. The owner picks
one figure to promise contractually. **[LEGAL REVIEW]** — the adviser confirms
the regulator and data-subject notification windows under the UAE PDPL and the
KSA PDPL so that the contractual promise to the Customer leaves the Customer
enough time to meet its own duty.

9.3 "Becoming aware" means the time the incident is declared under the runbook
(§3), recorded in the evidence log (§10). IdaraWorks names the owner as the
person who declares a breach and decides notification (`runbooks/incident-response.md`
§1). **[OWNER DECISION]** — confirm, and name a deputy if one exists.

9.4 The notice will state, as far as known at the time: what happened; which of
the Customer's data was involved; the time window; what IdaraWorks has done to
contain it; what the Customer should do; and a contact for follow-up. It will not
name any other customer. IdaraWorks may send an initial notice with partial
information and follow up as facts are established.

9.5 IdaraWorks will assist the Customer with the Customer's own notifications
to a regulator or to Data Subjects, at the Customer's reasonable request.

9.6 **Access notices that are not breaches.** Independently of clause 9.2,
IdaraWorks will notify the Customer, after the event, of every emergency
"break-glass" support session and every direct database access under which the
Customer's data was viewed (`runbooks/impersonation-history.md` §4,
`runbooks/break-glass.md` §7b). **[OWNER DECISION]** — the window for these
notices, which the runbooks tie to the same undecided timeline as clause 9.2.

9.7 **Honest limits on detection today.** Error reporting (Sentry) is not
provisioned, the background-job service (Inngest) is not provisioned, and there
is no scheduled production check that re-tests tenant isolation on a timer. Until
those are in place, IdaraWorks' detection of some incidents depends on health
checks, Vercel logs and user reports (`runbooks/incident-response.md` §2).
The Customer accepts this for the pilot period. **[OWNER DECISION]** — whether
to close these before signature (O-6, O-7).

### 10. Rights of Data Subjects

10.1 The Customer, as Controller, answers requests from its employees, customers
and contacts. IdaraWorks does not answer them directly; if a Data Subject writes
to IdaraWorks about Customer data, IdaraWorks will pass the request to the
Customer within [5] working days and will not respond on the substance unless
the Customer asks it to. **[OWNER DECISION]** on the number of days.

10.2 **What the Service already lets the Customer do itself** (no request to
IdaraWorks needed):

| Right | How | Limits stated plainly |
| --- | --- | --- |
| Access / portability | **Settings → Export** downloads CSV files per record type, complete (paged, never truncated), for owner/admin/accounts users (`runbooks/exports.md`, `src/platform/export/service.ts`). | The export is **organisation-scoped, not person-scoped**. To answer one person the Customer exports the relevant files and filters them, removing other people's data before handing over. The export catalogue in code holds 17 record types (jobs, customers, suppliers, invoices, payments, expenses, daily reports, audit log, employees, leave requests, expense claims, payslips, leads, opportunities, sales activities, GL accounts, journal entries); the runbook's table still lists the original eight and should be updated. Money columns are blanked for users without price/cost privilege. |
| Rectification | Records are editable in the Service by users with the right role. | Issued documents keep their issued snapshot by design; a correction is a new revision or a credit note, not an edit. |
| Restriction / objection | Deactivate the person's user membership; place a legal hold on a file or on the organisation (`runbooks/legal-hold.md`). | — |
| Erasure of the whole organisation | Clause 12. | See clause 12.5 for what "deleted" currently means. |
| Erasure of **one person** within an organisation | **Partial.** A user can be deactivated and their profile cleared. | Their authored history — audit log entries naming them, documents they wrote, reports they submitted — is **retained**. See 10.3. |

10.3 **The erasure tension, stated plainly** (`docs/H30-PRIVACY-CHECKLIST.md`
§6). The audit log has no delete permission for the application, on purpose: a
finance system's value depends on its history being unalterable, and the
retention runbook keeps financial audit rows for at least six years to satisfy
VAT record-keeping rules it cites as KSA ≥ 6 years and UAE ≥ 5 years
(`runbooks/retention.md`). A request to erase one person therefore cannot remove
that person's name from historical audit entries today. **[OWNER DECISION]
(O-4)** — the owner must choose one of three policies before the first request
arrives: remove the name from history, replace it with an opaque identifier, or
retain it under a legal-obligation / legitimate-interest basis. **[LEGAL
REVIEW]** — the adviser confirms which of the three is permitted under the
Applicable Data Protection Law, confirms the retention floors the runbook cites,
and confirms how this clause should be worded once decided. Until decided, this
Agreement promises **retention** and says so to the Customer.

10.4 IdaraWorks will give reasonable help with requests the Customer cannot
satisfy itself through the Service, including reading data the Customer cannot
export today (record types outside the export catalogue).

### 11. Assistance, records and impact assessments

11.1 IdaraWorks will help the Customer, at the Customer's reasonable request,
with security questions, impact assessments and consultations with a regulator,
to the extent the answer depends on how the Service works. Annex 2 and
`docs/H30-PRIVACY-CHECKLIST.md` are the starting material.

11.2 IdaraWorks keeps a record of the processing it performs for the Customer:
this Agreement, Annex 1, Annex 3, the Customer's own audit log inside the
Service, the impersonation-session table, the break-glass log, the incident
evidence logs and the secret-rotation log. **[LEGAL REVIEW]** — whether a formal
record of processing activities in a prescribed form is required of the
Processor.

### 12. Return and deletion of data

12.1 **During the term** the Customer can export its data at any time (clause
10.2). A read-only billing state — suspended, cancelled, pending deletion — never
blocks reading or exporting; it blocks only adding (`runbooks/exports.md` §4,
`src/platform/audit/command.ts`).

12.2 **On cancellation** the organisation enters a **read-only export window of
60 days** (`SUB_READONLY_DAYS`, default 60, `src/modules/subscription/windows.ts`),
then a **7-day** "purge pending" lead (`SUB_PURGE_WARN_DAYS`, default 7), after
which its billing state becomes **"purged"** (`runbooks/cancellation.md`).
**[OWNER DECISION]** — whether 60 + 7 days is the window to promise; it is a
setting, not a law of the code. The Customer is expected to run the export
before the window closes; the state changes are written to the Customer's audit
log. **UNVERIFIED — owner action:** the nightly sweep that moves these deadlines
is an Inngest job and Inngest is not provisioned, so today an operator runs it
by hand (`runbooks/cancellation.md`, "run on demand meanwhile").

12.3 **No purge warning is emailed** on the cancellation path — the runbook says
so explicitly, and no email provider is active. The export window is the
guarantee, not a reminder. **[OWNER DECISION]** — whether to promise a reminder
in this Agreement (which would need Resend switched on and a small build).

12.4 **Legal hold suspends deletion.** While an organisation or a file is under
legal hold, the database refuses to advance the organisation to "purged" and
refuses to void the held file (`runbooks/legal-hold.md`, migration
`0059_s9_legal_hold_purge_guard.sql`). A hold is placed only on the owner's or
counsel's written instruction and recorded in the hold register. **[LEGAL
REVIEW]** — the wording of a legal-hold clause for UAE/KSA litigation and
regulator requests.

12.5 **What "purged" currently means — read this carefully.** Reaching the
"purged" state **changes a status field; it does not yet delete rows or files.**
`docs/S10-AUDIT-REGISTER.md` (item #12) records the closure pipeline as
"PARTIAL: 'purged' is a billing_state flip only; no data/storage purge executor,
no export-first bundle, no verify step", and a search of the code on 2026-09-05
found no executor since. The tooling that does delete organisations
(`tooling/scripts/s7-cleanup.ts`, `runbooks/data-cleanup.md`) was deliberately
rewritten in H30 so that it deletes **only organisations that prove they are
test fixtures** — it will refuse to delete a real Customer, which is the correct
safety property but means **there is no built path today to physically delete a
real Customer's data**. Physical deletion would be a bespoke, two-person
break-glass operation under `runbooks/break-glass.md`. **[OWNER DECISION]** —
either (a) build the governed purge executor before promising deletion within a
fixed time, or (b) promise deletion "by a documented manual procedure within
[N] days of the window closing", or (c) disclose that data is retained
read-only until the executor exists. This draft takes option (b) as the
placeholder and marks it. **[LEGAL REVIEW]**

12.6 **Backups.** Deleted data persists in the hosting provider's backups until
those backups expire. Supabase's documentation lists daily backups retained for
7 days (Pro), 14 days (Team) or 30 days (Enterprise), and states that database
backups **exclude files stored via the Storage API**
(`supabase.com/docs/guides/platform/backups`, read 2026-09-05). **UNVERIFIED —
owner action (O-2):** the production project's plan, whether daily backups exist
at all, and whether the Point-in-Time Recovery add-on is enabled could not be
read from this machine; `runbooks/backup-monitoring.md` §0 recorded PITR as
"NOT ENABLED" when it was written. The Free plan did not appear on the backups
page's retention table; **if production is on the Free plan it may have no
vendor backups at all.** Whether Supabase Storage objects are separately backed
up by the vendor is **UNVERIFIED — owner action**. There is no second-provider
backup (`runbooks/backup-monitoring.md`). The Customer should read this as: the
promise about backups cannot be written until O-1 and O-2 are done.

12.7 **Return.** Return of data is by the Customer's own export (clause 10.2).
Record types not in the export catalogue can be supplied on request by
IdaraWorks in CSV; there is no other format today.

12.8 IdaraWorks will confirm deletion in writing when it has happened.

### 13. Audit and evidence

13.1 IdaraWorks will make available to the Customer the information needed to
show it meets this Agreement. The evidence that exists today:

| Evidence | Where | Who can see it |
| --- | --- | --- |
| The Customer's own audit log, including every support session start/end | `Settings → Export`, entity `audit_log`; audit rows are written in the same transaction as the change they record | The Customer, self-service |
| List of support sessions into the organisation, with reason and whether consent or an emergency override was used | `Settings → Subscription` banner and `listImpersonations`; the table is readable by the Customer under row-level security | Customer owner/admin/accounts |
| Row-level-security isolation proof | The two-organisation "bleed harness" (`tests/integration/bleed-harness.test.ts`) that seeds every organisation-scoped table for two organisations and asserts neither sees the other's rows; it runs in the CI `integration` job on every push to `main` and `verify/**`. It does **not** technically gate deploys: production deploys are a manual `vercel deploy --prod --yes` whose runbook precondition is a green `main` (`runbooks/deployment-and-rollback.md`) — a procedural gate (Annex 2 §A1) | IdaraWorks; CI results on request |
| Restore-drill log with measured recovery objectives | `runbooks/restore-drill.md` §4 — **pending first drill (O-1)** | On request, once run |
| Incident and tabletop evidence logs | `runbooks/incident-response.md` §10 — **tabletop not yet filed** (`docs/pilot/08-owner-action-checklist.md`) | On request |
| Break-glass access records | `runbooks/break-glass.md` §9 | On request, for the Customer's own organisation |
| Secret-rotation log | `runbooks/secret-rotation.md` | On request |
| Vendor certifications | Supabase: SOC 2 Type 2, ISO 27001 (`supabase.com/security`); Vercel: SOC 2 Type 2, ISO 27001:2022 (`vercel.com/docs/security/compliance`); Inngest: SOC 2 Type II (`inngest.com/security`) — vendor statements, not verified by IdaraWorks | Vendor trust centres |

13.2 **Not available today.** IdaraWorks holds no certification of its own and
has not yet had an external penetration test (`docs/pilot/08-owner-action-checklist.md`
§A lists it as blocking; **UNVERIFIED — owner action** whether it has been
booked). Backups are not monitored (`runbooks/backup-monitoring.md` §7). The
Customer should not be told otherwise.

13.3 **On-site or third-party audits.** [The Customer may, once per year and on
30 days' notice, have an independent auditor bound by confidentiality review
IdaraWorks' compliance with this Agreement, at the Customer's cost, without
access to other customers' data.] **[LEGAL REVIEW]** and **[OWNER DECISION]** —
whether to offer this at pilot scale, and on what terms.

### 14. Term and termination

14.1 This Agreement lasts as long as IdaraWorks processes any Customer data,
including the export window and the deletion step in clause 12.

14.2 Either Party may terminate the Main Agreement under its own terms; this
Agreement then continues until clause 12 is complete.

14.3 If IdaraWorks cannot comply with this Agreement — including because a
change in law or a Sub-processor change makes the Seoul hosting unlawful for the
Customer — it will tell the Customer promptly, and the Customer may terminate
and take its data out under clause 12 without penalty. **[LEGAL REVIEW]**

14.4 **Service discontinuation.** If IdaraWorks stops providing the Service, it
will give the Customer at least [90] days' notice and keep the export available
throughout. **[OWNER DECISION]** on the notice period. The restore drill doubles
as a vendor-exit rehearsal (plain Postgres and plain S3, `runbooks/restore-drill.md`
§5), which is the technical basis for this promise, but it has not yet been run.

### 15. Liability

15.1 [Placeholder.] Each Party's liability under this Agreement is subject to
the limitations and exclusions in the Main Agreement, except that [nothing
limits liability for a Party's deliberate breach of clauses 5 to 9 / regulatory
fines caused by a Party's own breach are borne by that Party / other allocation].
**[LEGAL REVIEW]** — the adviser drafts this clause; it depends on the Main
Agreement, on what the UAE PDPL and KSA PDPL allow to be limited, and on
IdaraWorks' insurance position. **UNVERIFIED — owner action:** whether
IdaraWorks holds any professional-indemnity or cyber insurance.

### 16. Governing law and disputes

16.1 [Placeholder.] This Agreement is governed by the law of [the United Arab
Emirates / the Kingdom of Saudi Arabia / a named free zone / other], and
disputes go to [the courts of … / arbitration under …]. **[LEGAL REVIEW]** —
the adviser advises which law and forum suit a UAE-facing and a KSA-facing
customer, whether the data-protection duties of the Customer's own country
apply regardless of the chosen law (they usually do), and whether an Arabic
version must be the binding one. **[OWNER DECISION]** on the commercial
preference.

### 17. General

17.1 Changes to this Agreement must be in writing and signed by both Parties.

17.2 If any clause is unenforceable, the rest stays in force. **[LEGAL REVIEW]**

17.3 This Agreement is written in English. [An Arabic translation is provided
for convenience / the Arabic version prevails.] **[LEGAL REVIEW]**

---

## Annex 1 — Details of the processing

| Item | Description |
| --- | --- |
| **Controller** | The Customer organisation. |
| **Processor** | IdaraWorks (legal entity **UNVERIFIED — owner action**). |
| **Data Subjects** | The Customer's employees and workers; the Customer's own customers and their contact persons; the Customer's suppliers and their contact persons; sales leads and prospects; the Customer's users of the Service. |
| **Categories of Personal Data** | *Identity and contact:* names (English and Arabic), email addresses, phone numbers, postal addresses, job titles. *Workforce:* employee number, employment type, hire date, lifecycle status, attendance, leave, expense claims, pay (gross/net, payslips, pay runs). *Commercial:* invoices, payments, quotes, purchase orders, expenses and their references to named people. *Content people typed:* daily reports, notes, comments, document bodies. *Files people uploaded:* photographs (JPEG, PNG, WebP only — the only formats the Service accepts today), which may include signed documents or ID pages photographed. *Behavioural:* the Customer's own audit log and activity feed, listing which user did what and when. (Source: `docs/H30-PRIVACY-CHECKLIST.md` §1 and the tables named in `docs/H33-TRUTH-MAP.md`.) |
| **Special or sensitive categories** | The Service has no field designed for government ID numbers, health data, biometrics or location tracking, and holds no payment-card data (no billing provider is connected). **However**, an `hr_doc` upload may be a photograph of a passport, visa or national ID, and payroll data is financially sensitive. **[LEGAL REVIEW]** — whether either is a "sensitive" category under the UAE PDPL or KSA PDPL attracting extra conditions, and see clause 8.2 for KSA ID documents. |
| **Nature of processing** | Clause 3.3. |
| **Purpose** | Clause 3.4. |
| **Duration** | Clause 3.2 and clause 12. |
| **Retention while active** | Business records: for the life of the organisation. Financial audit rows: never pruned, at least six years (`runbooks/retention.md`). Notifications: read ones after 90 days, all after 12 months. Resolved exceptions: after 24 months. AI usage metadata: after 12 months. Digests: after 90 days. Processed background events: 30–90 days. Sign-in log (event, IP address, browser string, and a free-form `detail` field — `public.sign_in_log`, `supabase/migrations/0003_identity.sql`; **on a failed login the `detail` field records the email address that was tried**, `src/app/(auth)/actions.ts`, so the log holds email addresses of failed attempts, including mistyped or non-member addresses, with no user id attached): **no pruning window is defined — [OWNER DECISION]**. Pending (never completed) uploads: released after 24 hours. Note: the pruning job is dormant until Inngest is provisioned and is run by hand until then. |

---

## Annex 2 — Technical and organisational measures

### A. Measures in place (read from the code and runbooks on 2026-09-05)

**A1. Tenant isolation at the database.** Every table that holds a Customer's
data carries the organisation's id and is protected by PostgreSQL row-level
security (RLS): **257 tenant-owned tables per the migration set, as measured on
the isolated test project** (`docs/H33-TRUTH-MAP.md` Part A, ref
`zwnnqaryouevnzuwtyaj`; the count was not read from production, which every H33
tool refuses to touch — the production schema is expected to match because both
are built from the same migrations, but that expectation is
**UNVERIFIED — owner action** until checked in the production dashboard). The
application connects as a dedicated role `app_user` that is marked
`NOBYPASSRLS`, and every request runs inside one transaction whose organisation
and user are set as transaction-local settings (`src/platform/tenancy/withCtx.ts`),
so nothing leaks between pooled connections. A CI test seeds every
organisation-scoped table for two organisations and proves neither can see the
other's rows. **How that test relates to deploys, stated plainly:** it runs in
the CI `integration` job on every push to `main` and to `verify/**` branches
(`.github/workflows/ci.yml`). Production deploys are **not** performed by CI:
they are a manual `vercel deploy --prod --yes` from an operator machine, and the
runbook makes "`main` is green in both CI jobs" a precondition the operator
checks (`runbooks/deployment-and-rollback.md`). Nothing technically blocks a
deploy on a red run — the gate is **procedural, not enforced by tooling**.

**A2. No delete permission for the application.** `app_user` holds no DELETE
grant on business tables, with **one** exception: `org_holiday_calendar`
(`supabase/migrations/0021_config_presets.sql`). Migrations 0028/0029 briefly
granted DELETE on the three daily-report line tables (`report_work_line`,
`report_material_line`, `report_labour_line`); migration
`0032_s3_line_soft_delete.sql` **revoked** those grants and replaced line
removal with a soft delete (`superseded_at`), and no later migration re-grants
them. (`runbooks/restore-drill.md` §1f still lists the four-table exception; that
list is stale and should be corrected to the one table.) One further, narrow
delete path exists through a guarded database function rather than a grant:
`app.delete_draft_journal_line` (`0100_h24b_ledger.sql`) removes a single line
from a journal entry **only while the entry is still a draft**, inside the
caller's own organisation. Otherwise "delete" in the Service is a status change
(void / supersede) or a platform task behind a database guard
(`app.assert_platform_task()`). This is why records cannot be silently destroyed
by a bug or a compromised session.

**A3. Tamper-evident audit log.** `public.audit_log` is granted `select, insert`
only (`supabase/migrations/0006_audit_activity.sql`); the application cannot
update or delete it. Every audited change and its audit row are written in the
**same transaction** (`src/platform/audit/command.ts`): if either fails, both roll
back. A lint rule forbids feature code from writing audit rows directly. The
Customer can export the whole log at any time.

**A4. Role-based access inside an organisation.** A permission matrix
(`src/platform/authz/matrix.ts`) is checked in the module code, never only by
hiding a button. Price and cost visibility are separate privileges; exports blank
money columns for users who lack them. HR documents can be uploaded and read by
owner/admin only; financial documents are readable only with price privilege
(`src/platform/files/access.ts`, mirrored by a database function so the two walls
cannot disagree — a CI parity test asserts it).

**A5. Recorded support access.** Clause 6.4. Enforced in the database: a session
row must carry either **a** consenting user id or the break-glass flag
(`impersonation_consent_ck`, and the same check repeated in
`app.start_impersonation`), the actor must be on the active `platform_staff`
allow-list, and start/end write into the Customer's own audit log through a
`SECURITY DEFINER` writer (`supabase/migrations/0056_s9_impersonation.sql`,
`0054_s9_usage_audit.sql`). The session runs under RLS as `app_user`, not as the
database owner. There is no operator console that opens sessions; opening one is
a deliberate tooling action by platform staff. **What the database does not
check:** neither the constraint, `app.start_impersonation`
(`0056_s9_impersonation.sql`) nor `src/modules/support/service.ts` verifies that
the consenting user id belongs to an **owner/admin of that organisation** — the
database enforces "some user id", and confirming the grantor's role is a manual
step in the periodic review under `runbooks/impersonation-history.md` §4. Clause
6.4(b) is worded accordingly.

**A6. Two-person direct database access.** `runbooks/break-glass.md`: approval
recorded before connection, approver must differ from operator, `DIRECT_URL`
credential only (never in the application runtime), read-only transactions by
default, no deletion without a separate approval, tenant-visible audit row
written afterwards, post-hoc notice to the Customer.

**A7. Multi-factor authentication.** Users can enrol a TOTP authenticator
(`/mfa`). An organisation can **require** it for all its users by setting
`auth.mfa_required` (`src/platform/auth/resolve.ts`); when required, every
mutating action re-checks on the server that the session reached the second
factor and fails closed to the MFA page if it has not. MFA enrolment, success
and failure are recorded in the append-only sign-in log. Passwords are at least
10 characters. Refresh-token rotation is on (`runbooks/access-revocation.md` §2).
**UNVERIFIED — owner action:** whether the hosted Supabase Auth settings
(rotation, email confirmation) match the repository's expectations; the
repository's own notes record pending dashboard changes.

**A8. Private file storage and short-lived links.** Two Supabase Storage
buckets, `tenant-media` (15 MB per file) and `tenant-docs` (25 MB per file),
both private; no public bucket exists. Every object path starts with the
organisation id and storage RLS keys on it; a financial or HR document cannot be
placed in the media bucket. Upload and read links are signed **as the requesting
user** after the role check; read links expire after **300 seconds** (thumbnails
3,600) (`src/platform/files/storage.ts`). Only JPEG, PNG and WebP are accepted.
Every image is re-encoded, which removes EXIF and GPS metadata; the original is
discarded for job photos and retained (never served) only for financial, HR and
document-attached files (`src/workers/functions/image-derivatives.ts`,
`src/platform/files/classmap.ts`). A document malware-scanning interface exists
and is set to **refuse** any non-image document in production until a scanner is
provisioned (`src/platform/files/scan.ts`).

**A9. Logging discipline.** Application logs are structured; every
request-scoped line carries a request id, organisation id and user id and **no
business values at info level or above** (`runbooks/README.md`). If Sentry is
ever enabled, its scrubber removes cookies, request bodies, query strings and all
headers except the request id, reduces the user to an id, and strips breadcrumb
content (`src/platform/observability/sentry.ts`, unit-tested).

**A10. Secrets.** The privileged service-role key and the direct database
credential never enter the application runtime (lint-guarded); secrets live only
in Vercel's environment store, `.env.local` and CI; the repository is scanned for
leaked secrets in CI; rotation is quarterly and immediate on any exposure
(`runbooks/secret-rotation.md`). AI bring-your-own keys, if ever stored, are
encrypted in the application with AES-256-GCM under a server-side key
(`src/platform/ai/byok.ts`) — not active.

**A11. Encryption by the hosting vendors (vendor statements).** Supabase:
"All customer data is encrypted at rest with AES-256 and in transit via TLS"
(`supabase.com/security`, read 2026-09-05). Vercel: data at rest encrypted with
AES-256, in transit HTTPS/TLS 1.3 (`vercel.com/docs/security/compliance`, read
2026-09-05). The Service serves every page over HTTPS with a content-security
policy restricting connections to its own origin, the Supabase host and (if ever
enabled) the Sentry ingest host (`next.config.ts`).

**A12. Export safety.** Exports are complete (paged), organisation-scoped by two
walls (explicit filter plus RLS), redact money by privilege, and guard every
cell against spreadsheet formula injection (`src/platform/export/csv.ts`).

**A13. Rate limiting.** Login, sign-up, password reset, invitations, public share
links and health endpoints are rate-limited per IP (`src/platform/http/rateLimit.ts`).
See §B for the store.

**A14. Read-only states never block reading.** A suspended, cancelled or
pending-deletion organisation can always read and export; only adding is
blocked (`src/platform/audit/command.ts`).

**A15. Access revocation.** Deactivating a member removes their role and their
row access at the next request and writes an audit row; a compromised account is
also signed out of every device by the owner through the Supabase dashboard
(`runbooks/access-revocation.md`).

### B. Measures NOT yet in place (say these to the Customer)

| Gap | Consequence for the Customer | Owner reference |
| --- | --- | --- |
| **Restore has never been rehearsed.** | Backups are unverified; recovery time and data-loss window are unmeasured. | O-1, `runbooks/restore-drill.md` |
| **Plan tier, daily-backup existence and PITR status unknown from here.** | The backup promise in clause 12.6 cannot be written. If the project is on a Free plan there may be no vendor backups. | O-2, `runbooks/backup-monitoring.md` |
| **No second-provider backup; backups not monitored.** | A provider-level loss takes the backups with it; a failed backup would not raise an alarm. | `runbooks/backup-monitoring.md` §7 |
| **No physical purge executor.** | "Purged" is a status, not a deletion (clause 12.5). | `docs/S10-AUDIT-REGISTER.md` #12 |
| **Per-person erasure is partial.** | Authored history is retained (clause 10.3). | O-4 |
| **Background jobs do not run.** | Inngest unprovisioned: 11 queued events have waited since 2026-09-01; retention pruning, storage reconciliation, the lifecycle sweep and reminders are run by hand or not at all. Purchase-order and quote PDFs do not render — and **provisioning Inngest alone will not fix that**: the PDF workers (`src/workers/functions/lpo-pdf.ts`, `quote-pdf.ts`) build HTML and stop at an unbuilt render-and-store seam, so "pending render" persists after Inngest is on (`docs/H33-INNGEST-READINESS.md` §5 E). | O-6, `runbooks/inngest-provisioning.md`; `docs/H33-INNGEST-READINESS.md` §5 E |
| **No error reporting.** | Sentry unprovisioned: failures are learned from logs and users. (Also means no data leaves to Sentry today.) | O-7 |
| **No scheduled production isolation canary.** | Isolation is proven at deploy time by CI, not continuously in production. | `runbooks/incident-response.md` §2 |
| **Rate-limit store is in-memory unless Upstash is configured.** | Limits reset on each deploy and per instance. **UNVERIFIED — owner action** whether Upstash is configured in production. | `src/platform/http/rateLimit.ts` |
| **The act of exporting is not audited.** | The audit log shows contents, not who downloaded a CSV; Vercel request logs are the only record. | `runbooks/exports.md` §8 |
| **No external penetration test filed.** | — | `docs/pilot/08-owner-action-checklist.md` §A |
| **Incident tabletop not filed.** | The notification path has not been walked. | same |
| **No transactional email.** | Invitations, notices and reminders that the code would send are not sent; notices under clauses 7.2, 9 and 12 are manual. | Resend key not set |
| **Confidentiality paperwork.** | No staff/contractor NDA exists in the repository (clause 5.1). | **UNVERIFIED — owner action** |

---

## Annex 3 — Sub-processor register

Read on 2026-09-05. "Active" means the production application is configured to
use it today. "Conditional" means the code path exists but the credential or
flag is absent, so **no data flows to it today**; switching it on is a
Sub-processor change under clause 7.2. Vendor terms and locations are quoted
from the vendors' public pages and have not been executed or verified —
**UNVERIFIED — owner action** for every row's "Terms" cell.

| Sub-processor | Status | Service provided | What it receives | Location (vendor statement) | Vendor terms and certifications (as published) |
| --- | --- | --- | --- | --- | --- |
| **Supabase, Inc.** | **Active** | Managed PostgreSQL database, authentication (user emails, password hashes, MFA factors, sessions), file storage (both private buckets), daily backups and logs. | All Customer data in the Service. | Project region `aws-1-ap-northeast-2`, **Seoul, South Korea** — "the region you choose also determines where your primary project data is stored"; primary database, Auth and Storage objects hosted in-region; backups, logs and Supabase's own sub-processors "can affect your data residency" (`supabase.com/docs/guides/platform/regions`, `supabase.com/docs/guides/security/gdpr-compliance`). Supabase's own infrastructure provider is AWS. | DPA "request or view" at `supabase.com/legal/dpa`; SOC 2 Type 2, ISO 27001, HIPAA and DPA availability (`supabase.com/security`, `supabase.com/docs/guides/security`); AES-256 at rest / TLS in transit is stated on `supabase.com/security` only (the docs security guide does not discuss encryption). Supabase sub-processor list is referenced from its DPA page — **owner to obtain**. |
| **Supabase Auth email sender** | **Active, UNVERIFIED** | Sends sign-up confirmation and password-reset emails triggered by `supabase.auth.signUp`, `.resend` and `resetPasswordForEmail` (`src/app/(auth)/actions.ts`). | Recipient email address and the confirmation/reset link. | Whether these go through Supabase's built-in sender or a custom SMTP provider is a dashboard setting — **UNVERIFIED — owner action**; if a custom provider is configured it is a further Sub-processor. | As above. |
| **Vercel Inc.** | **Active** | Hosts and runs the application; serves pages; runtime logs. | Every request and response in transit; runtime logs containing request metadata (path, status, request id, IP-derived filters, user agent) plus the identifiers IdaraWorks logs (request, organisation, user ids). The application itself writes Customer records only to Supabase and uses no Vercel storage product (no `@vercel/kv`, `@vercel/blob` or `@vercel/postgres` dependency in `package.json`); however, what Vercel's edge cache and runtime logs retain of request and response content is held by Vercel and **cannot be verified from the repository — UNVERIFIED — owner action** (confirm in the Vercel dashboard and Vercel's DPA). | Functions pinned to `icn1`, **Seoul** (`vercel.json`; `vercel.com/docs/functions/configuring-functions/region`). Global points of presence terminate connections and route to Seoul (`vercel.com/docs/edge-network/regions`). Vercel "may transfer data to and in the United States and anywhere else in the world where Vercel or its service providers maintain data processing operations" (`vercel.com/docs/security/compliance`). | DPA at `vercel.com/legal/dpa`; SOC 2 Type 2, ISO 27001:2022, EU-U.S. DPF, AES-256 at rest / TLS 1.3 (`vercel.com/docs/security/compliance`). Runtime-log retention depends on plan: Hobby 1 hour, Pro 1 day, Enterprise 3 days, 30 days with Observability Plus (`vercel.com/docs/observability/runtime-logs`) — **plan UNVERIFIED — owner action**. |
| **Resend, Inc.** | **Conditional — NOT active** (`RESEND_API_KEY` unset) | Transactional email on **three** code paths: (1) member invitations (`src/platform/auth/identity.ts`); (2) CRM consent/campaign messages that a Customer user composes and sends to the Customer's own customer and lead contacts — marketing messages to third parties (`src/modules/crm/consent.ts`); (3) signature-request emails to the external signers of Document Studio documents (`src/modules/docstudio/signatures.ts`). **No background worker sends email**: the subscription worker records dunning notices in the Service only and its email step is a disabled seam (`src/workers/functions/subscription-worker.ts`; `docs/H33-TRUTH-MAP.md`). | Recipient email address, subject and plain-text body in every case. For invitations: fixed wording plus the invitation link. For campaigns: **a subject and body typed by the Customer's user**, addressed to third-party contacts, with an opt-out footer. For signature requests: the **document reference and title**, a **personal signing link** and its expiry date. Resend would therefore carry tenant-authored message content and document titles/links, not only invitation links. | **United States**: "Region selection controls where your emails are routed and sent from. It does not control where customer data is stored" (`resend.com/docs/dashboard/domains/regions`). | DPA pre-signed for every account (`resend.com/legal/dpa`); its own sub-processor list of 22 US companies including AWS, Supabase, Vercel, Inngest and Anthropic (`resend.com/legal/subprocessors`). |
| **Inngest Inc.** | **Conditional — NOT active** (`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` unset) | Runs scheduled and event-driven background jobs (PDF rendering, cost roll-ups, reminders, retention pruning, storage reconciliation). | Event payloads validated against `src/platform/events/registry.ts`: organisation, actor and record identifiers (UUIDs) and short type keys, **and also short business strings** — job and purchase-order references (up to 40 characters), report dates, and **free text typed by a user as a reason** (up to 500 characters when a job stage is reopened, `JobStageReopenedData`; up to 2,000 characters when a daily report is returned, `DailyReportReturnedData`); plus function-run state and step outputs held by Inngest. Payloads are therefore **not identifiers-only**. The consumers read the actual records from the database in Seoul, not from Inngest. | **United States** AWS (`inngest.com/security`). | SOC 2 Type II; encrypted at rest and in transit; optional encryption middleware so payloads are encrypted before leaving IdaraWorks' servers (`inngest.com/docs/learn/security`). **DPA: UNVERIFIED — owner action** — neither `inngest.com/docs/learn/security` nor `inngest.com/security` states whether or how a DPA is offered (the trust centre is referenced there only for the SOC 2 report); the owner asks the vendor. |
| **Sentry** (Functional Software, Inc.) | **Conditional — NOT active** (`SENTRY_DSN` unset) | Error reporting. | Scrubbed error events: identifiers only (Annex 2 §A9). | **UNVERIFIED — owner action** (hosting region is selectable at project creation; the owner would choose). | **UNVERIFIED — owner action**; see `runbooks/sentry-provisioning.md`. |
| **AI provider — OpenAI or Anthropic** | **Conditional — NOT active** (flag off, no key, no organisation register entry) | AI narration/agents (H28). | Only what the gateway sends for a permitted domain after the Customer's administrator has recorded lawful basis, agreement, transfer mechanism and minimisation (`src/platform/ai/privacy.ts`); numeric outputs are validated against the deterministic figures (`src/platform/ai/numbers-subset.ts`). | **UNVERIFIED — owner action** per provider. | **UNVERIFIED — owner action** per provider. |
| **Upstash** (Redis) | **Conditional — UNVERIFIED whether active** | Durable rate-limit counters. | Counter keys of the form scope + client IP address. | **UNVERIFIED — owner action**. | **UNVERIFIED — owner action**. |
| **Document malware scanner** | **None provisioned** | Would scan uploaded documents. | — | — | — |
| *Twilio* | *Not a Sub-processor* | Listed in `.env.example` only; **no code references it**. Included so nobody lists it by mistake. | — | — | — |
| *Billing provider* | *None connected* | No payment data exists (`docs/H30-PRIVACY-CHECKLIST.md` §1). | — | — | — |

**Publication.** `docs/H30-OWNER-CHECKLIST.md` O-8 asks the owner to publish
the sub-processor list. This Annex is the current list; publishing it is still
an **[OWNER DECISION]** on where (a page on www.idaraworks.com is the obvious
place).

---

## Annex 4 — Decisions and confirmations required before signature

| # | Item | Type | Reference |
| --- | --- | --- | --- |
| 1 | Legal entity name, registration and address of IdaraWorks | UNVERIFIED — owner action | Parties |
| 2 | A Main Agreement / pilot agreement for this DPA to attach to | UNVERIFIED — owner action | 1.4 |
| 3 | Transfer basis for Seoul hosting per Customer country (UAE, KSA, free zone) | [LEGAL REVIEW] | 8.2 |
| 4 | Whether to relocate the Vercel layer to `dxb1`; whether a Gulf database region exists | [OWNER DECISION], UNVERIFIED | 8.4 |
| 5 | Breach-notification window to promise, and who declares | [OWNER DECISION] O-9, [LEGAL REVIEW] | 9.2, 9.3 |
| 6 | Per-person erasure policy (remove / pseudonymise / retain) | [OWNER DECISION] O-4, [LEGAL REVIEW] | 10.3 |
| 7 | Retention floors for audit/VAT records per country | [LEGAL REVIEW] | 10.3, Annex 1 |
| 8 | Sign-in log retention window (the log also stores the email address tried on every failed login) | [OWNER DECISION] | Annex 1 |
| 9 | Deletion promise: build the purge executor, or promise a manual procedure, or disclose retention | [OWNER DECISION], [LEGAL REVIEW] | 12.5 |
| 10 | Confirm plan tier, daily backups and PITR; run the restore drill | UNVERIFIED — owner action, O-1, O-2 | 12.6 |
| 11 | Sub-processor notice period; accept each vendor's DPA | [OWNER DECISION], UNVERIFIED — owner action | 7.2, 7.4, Annex 3 |
| 12 | Whether Supabase Auth uses a custom SMTP provider; whether Upstash is configured | UNVERIFIED — owner action | Annex 3 |
| 13 | Whether to provision Inngest and Sentry before signature | [OWNER DECISION] O-6, O-7 | 9.7 |
| 14 | Confidentiality obligations for any person with access | UNVERIFIED — owner action | 5.1 |
| 15 | Audit rights to offer | [OWNER DECISION], [LEGAL REVIEW] | 13.3 |
| 16 | Liability allocation and insurance position | [LEGAL REVIEW], UNVERIFIED — owner action | 15 |
| 17 | Governing law, forum, binding language | [LEGAL REVIEW], [OWNER DECISION] | 16, 17.3 |
| 18 | Whether ID photographs and payroll are "sensitive" data under the applicable law | [LEGAL REVIEW] | Annex 1 |
| 19 | Tell the pilot customer the uncomfortable facts in Annex 2 §B in conversation | [OWNER DECISION] O-5 | 6.2 |
| 20 | Do not apply the PO-002 stock repair as part of any of this | Standing instruction | `docs/H33-TRUTH-MAP.md` Part M |

---

## Signature block

### NOT FOR SIGNATURE UNTIL REVIEWED

This draft has not been reviewed by a qualified legal adviser. Do not sign it,
and do not present it to a customer as final, until every **[LEGAL REVIEW]** tag
has been resolved by such an adviser and every **[OWNER DECISION]** and
**UNVERIFIED — owner action** item in Annex 4 has been closed.

| | **For the Processor (IdaraWorks)** | **For the Controller (Customer)** |
| --- | --- | --- |
| Legal entity | [UNVERIFIED — owner action] | [ ] |
| Signed by | | |
| Name | | |
| Title | | |
| Date | | |
| Signature | ______________________ | ______________________ |

---

## Sources

**Repository files read (branch `verify/h33`, 2026-09-05):**
`docs/H33-TRUTH-MAP.md`, `docs/H30-PRIVACY-CHECKLIST.md`,
`docs/H30-OWNER-CHECKLIST.md`, `docs/H30-REPORT.md`, `docs/S10-AUDIT-REGISTER.md`,
`docs/pilot/PILOT_OWNER_ACTIONS.md`, `docs/pilot/08-owner-action-checklist.md`,
`runbooks/README.md`, `runbooks/incident-response.md`, `runbooks/exports.md`,
`runbooks/retention.md`, `runbooks/data-cleanup.md`, `runbooks/access-revocation.md`,
`runbooks/legal-hold.md`, `runbooks/impersonation-history.md`,
`runbooks/break-glass.md`, `runbooks/secret-rotation.md`, `runbooks/restore-drill.md`,
`runbooks/backup-monitoring.md`, `runbooks/sentry-provisioning.md`,
`runbooks/inngest-provisioning.md`, `runbooks/cancellation.md`,
`src/platform/audit/command.ts`, `src/platform/tenancy/withCtx.ts`,
`src/platform/tenancy/storage.ts`, `src/platform/files/access.ts`,
`src/platform/files/storage.ts`, `src/platform/files/scan.ts`,
`src/platform/files/paths.ts`, `src/platform/files/classmap.ts`,
`src/platform/export/service.ts`, `src/platform/auth/resolve.ts`,
`src/platform/auth/password.ts`, `src/platform/notifications/email.ts`,
`src/platform/observability/sentry.ts`, `src/platform/ai/privacy.ts`,
`src/platform/ai/byok.ts`, `src/platform/ai/numbers-subset.ts`,
`src/platform/http/rateLimit.ts`, `src/platform/http/fetchWithPolicy.ts`,
`src/platform/events/registry.ts`, `src/platform/env.ts`,
`src/modules/support/service.ts`, `src/modules/subscription/windows.ts`,
`src/modules/subscription/machine.ts`, `src/workers/functions/subscription-worker.ts`,
`src/workers/functions/image-derivatives.ts`, `src/app/(auth)/actions.ts`,
`supabase/migrations/0003_identity.sql`, `0006_audit_activity.sql`,
`0008_files_storage.sql`, `0021_config_presets.sql`, `0053_s9_subscription_events.sql`,
`0059_s9_legal_hold_purge_guard.sql`, `.env.example`, `vercel.json`,
`next.config.ts`, `package.json`.

**Added in the fact-check revision (2026-09-05, same branch):**
`supabase/migrations/0028_s3_daily_report_lines.sql`, `0029_s3_labour_attendance.sql`,
`0032_s3_line_soft_delete.sql`, `0056_s9_impersonation.sql`, `0100_h24b_ledger.sql`,
`src/platform/auth/identity.ts`, `src/modules/crm/consent.ts`,
`src/modules/docstudio/signatures.ts`, `src/platform/events/registry.ts`
(`JobStageReopenedData`, `DailyReportReturnedData`, `JobCreatedData`,
`PurchaseOrderApprovedData`), `runbooks/deployment-and-rollback.md`,
`.github/workflows/ci.yml`, `docs/H33-INNGEST-READINESS.md` §5 E,
`runbooks/impersonation-history.md` §4. Corrections made in that pass: the DELETE
exception list (A2), the Resend and Inngest payload descriptions and the Inngest
DPA statement (Annex 3), the sign-in-log inventory (Annex 1), the table-count
provenance and the deploy-gate wording (A1, 13.1), the impersonation consent
check (6.4, A5), the PDF-rendering consequence (Annex 2 §B), the Vercel
storage statement and the Supabase encryption citation (Annex 3).

**Vendor documentation read (2026-09-05):**
`https://supabase.com/docs/guides/platform/regions`,
`https://supabase.com/docs/guides/platform/backups`,
`https://supabase.com/docs/guides/security`,
`https://supabase.com/docs/guides/security/gdpr-compliance`,
`https://supabase.com/security`,
`https://vercel.com/docs/edge-network/regions`,
`https://vercel.com/docs/security`,
`https://vercel.com/docs/security/compliance`,
`https://vercel.com/docs/functions/configuring-functions/region`,
`https://vercel.com/docs/observability/runtime-logs`,
`https://resend.com/docs/dashboard/domains/regions`,
`https://resend.com/legal/subprocessors`,
`https://www.inngest.com/docs/learn/security`,
`https://www.inngest.com/security`.

No database connection was opened, no script touching a database was run, no
`.env.local` or `.env.test.local` was read, no CLI command that changes anything
was run, and nothing was sent anywhere in preparing this draft.
