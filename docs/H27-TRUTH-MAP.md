# H27 — CRM and Revenue Growth Studio: truth map

Facts before code. Parts A–F were written before the first H27 change; Part G is
the progress and evidence log kept while building. Nothing here rewrites a
historical roadmap claim; the approved mandate is recorded in
`phase2/14-POST-MVP-AMENDMENTS.md` §6.

## A. Baseline (read-only, 2026-09-02)

| Fact | Value | Source |
| --- | --- | --- |
| Working tree | clean on `main` at `b415672` (H26 live + report); branch `verify/h27` created from it | `git status`, `git log` |
| Production commit | `b415672` (`/api/health` ok:true; H26 code commit `60f61ce`, later commits docs/tooling only) | `curl /api/health` |
| Migrations | 119 applied on production, 0 pending; local files 0000–0119; next number **0120** | `prod-health.ts`, `ls supabase/migrations` |
| Production flags set | `FEATURE_STOCK_SURFACES`, `FEATURE_HR_SURFACES`, `FEATURE_FINANCE_SURFACES`, `FEATURE_MANAGEMENT_STUDIO`, `FEATURE_DOCUMENT_STUDIO` (`FEATURE_REVENUE_STUDIO` absent) | `vercel env ls production` |
| Historical counts | orgs 39, users 60, jobs 93, quotes 46, invoices 78 | `prod-health.ts` |
| Health verdict | HEALTHY, 0 tables without RLS, no unexpected DELETE grants, 0 new orphans | `prod-health.ts` |

Roadmap position: the north star (§6) lists stage 3 "CRM and sales depth (leads,
opportunities, contracts)" and marks Customer and CRM `partial` (leads and
opportunities "planned" as adopted on 2026-08-29; H20 shipped them on
2026-08-30). H27 is the Owner-approved phase that completes stage 3 and reaches
into stages 8 (forecasting, executive views) and 10 (governed automation, AI
seam). The north star status column is left as adopted (amendment §6).

## B. The mandate, condensed

Full text in the Owner's message of 2026-09-02; the binding rules are in
amendment §6. Eighteen slices: Customer 360; lead and enquiry capture;
interactive pipeline; opportunity deal room (with optional visual canvas);
activities and engagement with fail-closed provider adapters; products, pricing
and commercial configuration; quote/proposal/contract conversion (idempotent);
forecasting with stored snapshots; targets, territories and performance;
campaigns and attribution (models named, never causal); customer success and
renewals; the Revenue Growth Studio; governed automation; fail-closed CRM
intelligence; guided imports; search, command centre and reporting (full-result
aggregates, database-side pagination beyond 1,000 rows); EN/AR and RTL with
country packs; least-privilege permissions proven by tests. Release behind
`FEATURE_REVENUE_STUDIO` (only `"1"` enables). Untouched: historical accounting
conversion, H24 transition ambiguities, PO-002, the H22 stock-posting problem,
H28.

## C. Research consulted (primary sources unless marked)

The purpose of this section is to design consent, suppression and communication
behaviour correctly and to bound the claims the product makes. Nothing here is
legal advice and the product must not present it as such.

### C1. Direct marketing and consent

- **GDPR / UK GDPR Article 21(2)–(3)** (retained EU law text, legislation.gov.uk):
  "Where personal data are processed for direct marketing purposes, the data
  subject shall have the right to object at any time … Where the data subject
  objects to processing for direct marketing purposes, the personal data shall
  no longer be processed for such purposes." → an objection must stop marketing
  processing immediately and permanently (suppression outranks consent).
- **Directive 2002/58/EC Article 13(1), (2), (4)** (legislation.gov.uk):
  electronic mail for direct marketing "may be allowed only in respect of
  subscribers or users who have given their prior consent"; the existing-customer
  exception applies only to the seller's own similar products and only when the
  customer is "clearly and distinctly … given the opportunity to object, free of
  charge and in an easy manner … at the time of their collection and on the
  occasion of each message"; messages that "disguise or conceal the identity of
  the sender" or lack "a valid address to which the recipient may send a request
  that such communications cease" are prohibited.
- **15 U.S.C. § 7704(a)(3)–(5)** (Cornell LII): commercial email needs "a
  functioning return electronic mail address or other Internet-based mechanism,
  clearly and conspicuously displayed" to opt out; no message "more than 10
  business days after the receipt of such request"; and "clear and conspicuous
  identification that the message is an advertisement or solicitation" plus "a
  valid physical postal address of the sender".
- **UAE Federal Decree-Law No. 45 of 2021** (official portal u.ae, summary
  level; the statute PDF on uaelegislation.gov.ae is Arabic-only and the host
  refused automated retrieval): it "prohibits the processing of personal data
  without the consent of its owner, except for some cases …" and "came into
  force on 2 January 2022". The right to withdraw consent and to object to
  direct marketing are stated in the statute (Articles 6–7 and 13 in the
  Arabic text); this map cites only what the official portal states in English.
- **Saudi PDPL (Royal Decree M/19, as amended) and its Implementing
  Regulation** (SDAIA; the PDF hosts refused automated retrieval, so the
  citation is to SDAIA's published summary): direct marketing requires the data
  subject's consent, the controller must provide a mechanism to stop marketing
  material whenever desired, and stopping must be "as simple and easy as
  obtaining consent to receive the material".

Design consequences (ADR-36): consent is recorded per person and channel with
its source and evidence; an objection or unsubscribe creates a suppression that
no consent can override; every outbound marketing action requires an explicit
authorised human action and a consent check at send time; provider adapters
carry sender identity and an unsubscribe path as mandatory fields; nothing is
sent without credentials (fail closed).

### C2. Forecasting and attribution practice (secondary, industry convention)

Forecast categories commit / best case / pipeline (and omitted), weighted
pipeline as value × stage or per-opportunity probability, coverage as pipeline ÷
target, velocity as (opportunities × value × win rate) ÷ cycle length, and
first-touch / last-touch / linear multi-touch attribution are conventions, not
standards. Design consequences (ADR-38, ADR-40): every number carries the model
that produced it; weighted amounts are labelled as expectations, never revenue;
attribution never claims causal impact; forecast snapshots are stored so a
prediction can be compared with what happened.

### C3. Audit and integrity (carried from H26)

Every commercial decision goes through the `command()` path (audit log +
activity); stage moves, forecast category changes, discount approvals, merges
and automation runs are recorded with actor, reason and before/after values.

## D. Inventory: what already exists (reuse, never compete)

| Concept | Owner module / table | State | H27 use |
| --- | --- | --- | --- |
| Customer | `masters` / `customer` (0020; name, country, contact, phone, email, tax_reg_no, notes, active; issuer fields in 0102) | shipped | extend additively: owner, territory, tags, segment, `merged_into_customer_id` |
| Contacts | `masters` / `customer_contact` (0077; role_title, preferred_method, is_primary) | shipped | extend: relationship role, consent link |
| Duplicate detection | `masters.findPossibleDuplicates` (E.164-aware phone contract) | shipped | reuse for leads, imports and merge preview |
| Customer 360 | `crm/service.ts` `gatherCustomer360`, `listCustomerTimeline` (quotes, jobs, opportunities, work, money, attention) | shipped (H19) | extend the composition: contacts, documents, obligations, issues, activities, health, consent |
| Lead | `crm/sales.ts` / `lead` (0078; status new→contacted→qualified→disqualified→converted; conversion evidence) | shipped (H20) | extend: source kind, campaign, value/timeframe, interest, qualification, quarantine, duplicate_of, disqualify reason |
| Opportunity | `opportunity` (0078; stage_key, status open/won/lost, value/currency/probability, expected close, next action, quote link, loss reason) | shipped (H20) | extend: pipeline_id, forecast category, stakeholders, products, competitors, risks, decision criteria, campaign, deal canvas |
| Pipeline stages | `pipeline_stage` (0078; one pipeline per org, org-editable labels/order, won/lost terminals) | shipped | multiple pipelines via `crm_pipeline` + `pipeline_stage.pipeline_id`; stage requirements and exit criteria |
| Stage history | `sales_activity` kind `stage_change`, body `from|to` | shipped | add structured `meta` (from, to, reason) and reason capture; ageing and cycle time derive from it |
| Activities | `sales_activity` (note, call, meeting, email, follow_up; lifecycle marks) | shipped | widen: customer/contact subjects, task, message, site visit, demo, custom; participants, outcome, next action, reminders, recurrence, templates |
| Quotes | `quotes` (`createQuote` links an open opportunity; `acceptQuote` wins it and creates the job from a preset; issuer snapshot) | shipped | the proposal path; discount approvals via a new approval subject |
| Invoices, payments | `invoices` (`customerMoney`, `computeAR`), `payments` | shipped | read-only in the 360 and revenue timeline |
| Work | `jobs` (`startWorkFromOpportunity`, idempotent) | shipped | "deliver into downstream systems" seam |
| Documents and contracts | `docstudio` (H26: contracts, signature room, obligations, renewals, forms) | shipped | contracts, renewals, obligations, public enquiry forms → leads |
| Approvals | `approvals` engine (`quote_send`, `document_step`, …) | shipped | discount / commercial-exception approvals (`crm_discount`) |
| Notifications, inbox, today | `platform/notifications`, `today.composeToday`, `/inbox`, `/my-work` | shipped | reminders, stalled alerts, "my work" commercial queue |
| Imports | `imports` (customers, employees, items; stage → apply with row errors) | shipped | extend kinds: contacts, leads, opportunities; mapping preview, duplicate preview, dry run |
| Exports | `platform/export` (`EXPORT_ENTITIES`, CSV) + document catalogue | shipped | CRM CSV exports and a branded PDF report |
| Rules | `platform/rules/conditions.ts` (pure evaluator) | shipped (H26) | automation conditions |
| Agent seam | `platform/agents` (`getAgentProvider()`, fails closed) | shipped | CRM intelligence |
| Presence | H25 private Realtime channels (`usePlanPresence`) | shipped | deal room presence |
| Public tokens | H26 hashed one-time tokens, definer resolvers, rate limiting | shipped | enquiry forms (reuse `doc_form_link`) |
| Items | `item` (sku, unit, cost/price minor, redacted by privilege) | shipped | products and services on opportunities |
| Currency, VAT | `quotes.computeQuoteTotals` (minor units, VAT per line, exchange rate); `CURRENCY_CODES` registry | shipped | no new tax or rate logic; opportunity products carry VAT rate as entered on the eventual quote |
| Archetypes | owner, admin, manager, foreman, procurement, accounts, viewer (closed registry) | shipped | H27 roles map onto archetypes plus ownership scoping (ADR-41) |

Nothing in H27 creates a second customer, lead, opportunity, activity, quote,
invoice, job or document model.

## E. Transition seams (exact)

| From → To | Existing seam | H27 change |
| --- | --- | --- |
| Enquiry → Lead | H26 form submission → `convertSubmission` (target lead) → `createLead` | lead gains `source_kind='form'`, campaign, consent capture from the form |
| Lead → Customer + Opportunity | `convertLead` (advisory lock, idempotent; may reuse an existing customer) | duplicate preview before convert; never creates a second customer when a match is chosen |
| Opportunity → Quote | `createQuote({ opportunityId })` (open-status guard, activity `quote_created`) | products on the opportunity pre-fill quote lines; discounts route through `crm_discount` approval before submit |
| Quote → Won | `acceptQuote` wins the opportunity inside its own transaction | unchanged; stage requirements may require a quote before "Proposal" |
| Won → Work | `startWorkFromOpportunity` (idempotent by opportunity) | surfaced from the deal room |
| Opportunity → Contract | `createDocument` (Document Studio) with `recordType='opportunity'` link | link stored on the opportunity; issued snapshot immutable |
| Contract → Obligations, renewals | H26 obligations seeded at issue | renewal opportunities created from renewal obligations (explicit action) |
| Work → Invoice → Payment | invoices and payments modules | read-only in revenue timeline and 360 |
| Customer merge | none today | `mergeCustomers` (preview, conflicts, re-point FKs, immutable evidence) |

## F. Decisions (ADR-32 onward)

**ADR-32 — Extend, do not replace.** H27 adds columns and satellite tables to the
H19/H20 models; no parallel CRM tables for customers, leads, opportunities or
activities. Single-writer rules: opportunity stage and status change only
through `moveOpportunityStage`, `winOpportunity`, `loseOpportunity`; customer
money and work facts are read from their owners.

**ADR-33 — Multiple pipelines by reference.** `crm_pipeline` (key, name, kind,
default) and `pipeline_stage.pipeline_id`; an organisation's existing stages
are attached to a default pipeline lazily on first write (same pattern as
`ensurePipelineStages`). Stage rows gain `requirements` (fields that must be
present to enter), `exit_criteria` (text), `default_probability`, `max_age_days`.

**ADR-34 — Governed stage moves.** A move validates the target stage's
requirements against the opportunity, records `sales_activity` kind
`stage_change` with structured `meta {from, to, reason, ageDays}`, and bumps
`row_version`; the board is optimistic with server reconciliation and refuses a
stale move (conflict, never silent overwrite).

**ADR-35 — Activities widen in place.** `sales_activity` gains customer and
contact subjects, `title`, `outcome`, `participants`, `next_action`,
`next_action_due`, `location`, `recurrence_days`, `template_key`,
`custom_kind`, `completed_by`, `meta`; kinds widen to task, message, site_visit,
demo, custom. Provider adapters (email, calendar, messaging) are declared
interfaces that fail closed; manual logging and internal reminders work fully.

**ADR-36 — Consent and suppression.** `crm_consent` (subject, channel, status,
source, evidence, effective_at, actor) and `crm_suppression` (channel, address,
reason). Suppression outranks consent. Outbound marketing requires an explicit
action, a consent check at send time, sender identity and an unsubscribe path;
without provider credentials nothing is sent.

**ADR-37 — Products on opportunities.** `crm_opportunity_product` (item or free
text, qty, unit, unit price minor, discount percent, VAT rate, optional, bundle
key, recurring months). Pricing uses the existing minor-unit arithmetic; no tax
rates or exchange rates are invented; the quote created from an opportunity is
pre-filled from these lines and remains the priced document of record.

**ADR-38 — Deterministic forecasting with snapshots.** `opportunity.forecast_category`
(pipeline, best_case, commit, omitted). The forecast workspace computes, on
read and in SQL, pipeline value, weighted value (value × probability, where the
probability is the opportunity's own or the stage default), category totals,
expected close by week/month/quarter, breakdowns by owner, team, territory,
source, product, conversion rates, velocity, stage ageing and win/loss.
`crm_forecast_snapshot` stores a period's numbers and per-opportunity rows when a
person or the nightly job captures it; accuracy compares snapshots with won
outcomes. Weighted amounts are never labelled revenue.

**ADR-39 — Targets and territories.** `crm_target` (scope org/team/user, metric
revenue/bookings/margin/activities, period, amount, currency, effective_from;
new rows for changes) and `crm_territory` (key, name, rules: countries, tags);
`customer.owner_user_id`, `customer.territory_id`. Performance views explain
results; no per-keystroke activity surveillance.

**ADR-40 — Campaigns and attribution.** `crm_campaign`, `lead.campaign_id`,
`opportunity.campaign_id`, `crm_touch` (subject, campaign, kind, at). Models:
first_touch, last_touch, linear (equal split); every figure names its model.

**ADR-41 — Roles map onto archetypes plus ownership.** Sales representative =
`manager`/`admin` archetype holders scoped by ownership and team where the lane
says so; sales manager = `manager` with `crm.forecast.view`; account manager =
customer owner; marketing user = `crm.campaigns.manage` (admin/owner); finance
reviewer = `accounts` (invoices/payments read, no pipeline edits); owner = all;
external participant = H26 public tokens only. Field-level margin protection
uses the existing `costPrivileged` serializer wall. New lanes: `crm.forecast.view`,
`crm.targets.manage`, `crm.campaigns.manage`, `crm.automations.manage`,
`crm.consent.manage`, `crm.merge`, `crm.import`, `crm.export`.

**ADR-42 — Merge is a reviewed command.** `crm_merge` stores the preview, the
chosen field resolutions, the source row snapshot and the re-pointed record
counts; the source customer becomes inactive with `merged_into_customer_id`; no
row is deleted; reads follow the pointer.

**ADR-43 — Automation is governed and idempotent.** `crm_automation` (owner,
trigger, conditions via `platform/rules`, actions from a closed list, enabled,
dry-run) and `crm_automation_run` (idempotency key unique per automation ×
subject × trigger occurrence, status, result, error). Actions: assign owner,
create task, notify, request approval, create reminder, flag risk. Never: send
campaigns, sign, post accounting, move stages without review.

**ADR-44 — Health is evidence.** Customer health is computed on read from named
signals (overdue invoices, open issues, stalled opportunities, overdue
obligations, activity recency, satisfaction records, renewal proximity) with
each contribution shown; `crm_customer_signal` stores satisfaction and success
records; unknown facts are shown as unknown, never guessed.

**ADR-45 — Scenarios are overlays.** The studio's what-if (slip deals, exclude
deals, change probabilities) is computed client-side over the loaded forecast;
`crm_scenario` saves overlays for comparison; applying one is an explicit
reviewed action that replays the changes through the governed opportunity
commands with audit.

**ADR-46 — Intelligence fails closed.** The CRM assistant reuses the platform
agent seam with a `read.crm_context` tool; outputs are proposals with evidence
links; nothing is written by the assistant.

**ADR-47 — Imports are staged.** Import kinds gain contacts, leads and
opportunities; mapping preview, validation, duplicate preview (against
customers and leads), dry run, row-level errors, explicit approval,
idempotent apply keyed by batch and row hash, and an audit report. No claim of
third-party format compatibility beyond the documented CSV/XLSX columns.

**ADR-48 — Release.** Flag `FEATURE_REVENUE_STUDIO` (strict `"1"`, page-level
404 for every new surface, nav group hidden, public routes 404). Entitlement
`cap.revenue_studio` on every plan (no pricing decision taken). Data-layer
changes are additive and safe while the flag is off.


## Part G — What was built (implementation record)

Written after the slices landed; every claim below is backed by a test, a
script, or a migration in the repository. Deployment evidence lives in
`docs/H27-REPORT.md`.

### G.1 Migrations (0120–0127, additive)

| File | What it adds |
| --- | --- |
| `0120_h27a_revenue_foundation.sql` | `cap.revenue_studio` entitlement on every plan; approval subject `crm_discount`; `crm_territory`, `crm_pipeline` (one default per org), `crm_campaign`; `pipeline_stage.pipeline_id/requirements/exit_criteria/default_probability/max_age_days`; CRM columns on `customer`, `customer_contact`, `lead`, `opportunity`, `sales_activity` (widened `kind`, customer-only subject allowed) |
| `0121_h27b_opportunity_context.sql` | stakeholders, product lines, competitors, risks, `crm_discount` (one live request per opportunity), `crm_deal_canvas` (row-versioned) |
| `0122_h27c_consent_attribution.sql` | `crm_consent` (append-only), `crm_suppression` (unique per org/channel/address, never deleted by the app role), `crm_touch` |
| `0123_h27d_forecast_targets.sql` | `crm_forecast_snapshot`, `crm_scenario`, `crm_target` (dated rows; latest `effective_from` wins) |
| `0124_h27e_success_merge_automation.sql` | `crm_customer_signal`, `crm_merge` (immutable evidence), `crm_automation`, `crm_automation_run` (unique per automation × subject × occurrence × mode) |
| `0125_h27f_merge_grants_imports.sql` | column-scoped `update (customer_id)` grants for the merge re-point, `update (status, result, error)` on runs, `import_batch.kind` widened to contacts/leads/opportunities |
| `0126_h27f_automation_run_update_policy.sql` | the UPDATE policy the run finaliser needs (kept separate: 0125 was already applied on TEST) |
| `0127_h27g_automation_sweep_discovery.sql` | `app.orgs_with_crm_automations()` platform discovery (guarded by `app.assert_platform_task()`) |

Every table carries `org_id` + RLS, composite `(id, org_id)` foreign keys,
column-scoped UPDATE grants and no DELETE grant. Nothing existing was
replaced: H19 customers/contacts and H20 leads/opportunities/activities/
stages were extended in place (ADR-32).

### G.2 Modules (`src/modules/crm/`, one door: `service.ts`)

| File | Owns |
| --- | --- |
| `pipelines.ts` | pipelines, stage settings, `unmetRequirements` (pure), `moveStage` (requirements → row version → history row → audit), `boardPage` (paged cards, aggregates across the full filtered result) |
| `dealroom.ts` | stakeholders, product lines (`computeLine` in minor units; lines own the deal value once they exist), competitors, risks, commercial context, canvas, `gatherDealRoom`, `getOpportunityCommercial` |
| `activities.ts` | widened activity model, templates, recurrence, `myCommercialQueue`, provider adapters declared and honestly disabled |
| `leads.ts` | capture with quarantine for outside sources, duplicate lookup, qualification, disqualify with reason, quarantine review, `convertLeadSafely` (duplicate-safe, idempotent), paged lead list, source adapters (disabled until credentials exist) |
| `customers.ts` | CRM fields, contact roles, `scoreHealth` (pure, evidence per signal, unknown never counts), `gatherRevenue360`, signals |
| `consent.ts` | append-only consent, suppression, `canContact` (suppression outranks consent), marketing preview and the explicit send that fails closed without a provider |
| `campaigns.ts` | campaigns, touches, `attribute` (first / last / linear, pure), attribution report naming the model |
| `targets.ts` | territories with rules (`matchTerritory` pure), rule application only for unassigned customers, targets with a stated basis |
| `forecast.ts` | deterministic forecast with named models, ISO week/quarter buckets, snapshots, accuracy, overlays (`applyOverlay`, `summarise` pure), scenarios applied only by an owner through the governed commands |
| `merge.ts` | preview (conflicts + counts), one-transaction re-point across every referencing table plus Document Studio counterparties, immutable evidence, source pointer |
| `automation.ts` | owner / trigger / conditions / actions / enabled / dry-run, idempotent claim per occurrence, savepoint per subject, explicit patch schema (a partial never re-applies defaults), bounded actions (task, notify, risk flag, forecast category, review request, owner assignment) |
| `intelligence.ts` | the assistant behind `platform/agents`: fails closed, reads a bounded context, validates every evidence reference, never writes |
| `reports.ts` | funnel, activity and win/loss aggregates with a basis sentence |
| `success.ts` | paged success overview scored with the same model as the 360; band counts over the full set |
| `discounts.ts` | discount requests routed through the shared approvals engine |

The importer (`src/modules/imports`) gained contacts / leads / opportunities
kinds, a read-only dry-run preview (in-batch and existing duplicates,
unresolved customers), reviewer skip, and stays idempotent on apply. The
export catalogue gained `leads`, `opportunities`, `sales_activities` CSVs
with price redaction.

### G.3 Screens (`src/app/(app)/o/[orgId]/revenue/`)

Hub (command centre with database-side search, KPIs, funnel, lazy SVG
charts, queue, stalled deals, targets, campaigns), pipeline (drag-and-drop
with a keyboard/select path, governed move dialog with requirements and
reason, bulk review, paged cards with full-result column aggregates), leads
(capture, quarantine review, qualification, duplicate-aware conversion,
disqualify), deal room (overview, stakeholders, products, risks and
competitors, commercial, history, lazy React Flow canvas, fail-closed
assistant), Customer 360 (ownership, contacts with buying roles and consent,
documents, obligations, renewals, issues, signals, health evidence, timeline)
and the reviewed merge screen, forecast (totals with model statements,
buckets, conversion, snapshots and accuracy, scenario builder and compare,
owner-only apply), campaigns (list, attribution by named model, touches,
consent-checked explicit send), targets and territories, customer success,
automations (create, dry run, enable, run history), reports (funnel, win/loss,
activity, CSV exports, branded PDF through the platform renderer), pipeline
and stage settings. Every list pages from the database; every count and
total is computed across the full filtered result.

### G.4 Gates and proofs

Unit: `tests/unit/crm-pure.test.ts` (pricing, requirements, health,
overlays, ISO buckets, territory rules, attribution, evidence validation),
`flags.test.ts` (exact `"1"` gate), registries/nav/workspace laws.
Integration (TEST project, wiped): `h27a-foundation`, `h27b-capture-forecast`,
`h27c-merge-automation-ai`, `h27d-imports`, `h27e-reports-success-sweep`.
Fixture + headless walk: `tooling/scripts/h27-ui-fixture.ts` (1,250 leads,
1,150 deals) and `h27-ui-shots.ts` (desktop, Arabic, 375 px, PDF bytes,
pagination past 1,000, governed move, capture, quarantine review, dry run,
merge preview). Production: `h27-deploy-preflight.ts` (read-only),
`h27-prod-smoke.ts` (module lifecycle + HTTP, flag off/on, residue 0),
`h27-prod-ui-walk.ts` (screenshots, residue 0).

### G.5 Honest limits

- Email, calendar and messaging providers are declared and disabled until an
  owner provisions credentials; marketing sends fail closed.
- Inbound lead adapters (mailbox, messaging, API keys) are declared and
  disabled; the public form path from H26 remains the only outside entry,
  and it lands in quarantine.
- The assistant is off until a model provider is configured for the
  organisation.
- Health scores use one shared, weighted model; a single churn record lowers
  the score but does not by itself force the "at risk" band.
- Attribution reports correlation only.
- No exchange rates: a deal keeps its own currency; org totals are shown in
  the deal's currency field or the base currency and never converted.

### G.6 Shipped (2026-09-03)

| Fact | Value | Source |
| --- | --- | --- |
| Shipped commit | `17ba434` on `main` (= `verify/h27`); CI run 33719403743 green | GitHub Actions |
| Deploy of record | 6DU63eU3HSV7pTMgF7Q6XYe6dSiC (10:17 local), `/api/health` commit 17ba434, HEALTHY | Vercel, `prod-health.ts` |
| Migrations | 0120–0127 applied; 127 applied, 0 pending, 244 public tables, 0 without RLS | `prod-health.ts` |
| Flag | `FEATURE_REVENUE_STUDIO=1` in Vercel production; smoke 38/38 off, 39/39 on | `h27-prod-smoke.ts` |
| UI walk | clean on the shipped code (EN 1440 px, AR RTL, 375 px, PDF about 28 KB) | `h27-prod-ui-walk.ts` |
| Residue | 22 studio tables 0 rows; 0 markers, 0 fixture orgs/users/imports/objects | read-only sweep |
| Last finding | mobile pipeline 622 px: absolutely positioned `sr-only` labels escaping the board's clip; every H27 scroller is now `relative` | 17ba434 |
| Untouched | accounting history, H24 ambiguities, PO-002, H22 stock posting, H28 | mandate |
