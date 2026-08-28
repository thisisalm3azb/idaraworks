# IdaraWorks Business OS north star

Status: governing product vision. Adopted 2026-08-29 (micro-step H11).
This document sets direction; it never overrides the truthfulness rules:
nothing here may be presented publicly as available until it ships.

## 1. Product purpose

One business. One system.
Built by managers, for managers.

IdaraWorks is built to replace disconnected business software with one
intelligent, adaptable operating system. A business should not need one tool
for customers, another for projects, another for accounting, another for HR
and a spreadsheet to glue them together. IdaraWorks is the operating system
those tools fragment: one permissioned record of the business, with every
capability operating on it.

"Built by managers, for managers" is a factual founder statement about who
designs this product and for whom. It is never to be decorated with invented
biographies, customer stories or credentials.

## 2. Product promise

The long-term product supports the full business lifecycle:

market opportunity -> lead -> customer -> quote -> contract -> work ->
project -> task -> team -> material -> cost -> invoice -> payment ->
accounting -> reporting -> planning -> decision

The governing law is FORWARD MOTION OF INFORMATION: a fact entered at any
stage is carried into every later stage that needs it, never re-entered.
This is already the shipped behavior for quote -> work -> cost -> invoice ->
payment -> report; the Business OS extends the same law across the whole
lifecycle.

## 3. Complete capability map

Bounded modules of ONE modular monolith. Every module keeps its own domain
boundary (own service layer, own tables, own permission actions, events for
cross-domain effects); nothing becomes an uncontrolled shared model. Status
values: `shipped` (usable production surface today), `partial` (a real subset
ships), `planned` (no implementation yet). Phases refer to §6.

Common to every module: org-scoped tables behind RLS; permission actions in
the central matrix; money/PII redaction rules; EN/AR (and later ES) with RTL;
audit through the command path; configuration only through governed artifacts.

### Customer and CRM
- Purpose: know every customer and the commercial relationship.
- Core entities: customer, contact, lead, opportunity, activity note.
- Primary workflows: capture lead -> qualify -> convert to customer -> track relationship -> feed sales.
- Dependencies: none upstream; feeds Sales, Work, Receivables.
- Permission boundary: customers.*; money figures redacted by privilege.
- Sensitivity: personal data (contacts) — PII rules.
- Status: partial (customers, contacts-on-customer, customer updates ship; leads/opportunities planned).
- Localization: bilingual names/notes; address formats per country.
- Phase: 3.

### Sales and quotations
- Purpose: turn demand into agreed commercial scope.
- Core entities: quote, quote line, price source, acceptance.
- Primary workflows: draft -> send/share -> accept -> carry into contract/work.
- Dependencies: Customer; feeds Contracts, Work, Receivables.
- Permission boundary: quotes.*; price redaction.
- Sensitivity: commercial pricing.
- Status: shipped (quotes with lines, share link, branded print, per-document currency and rate).
- Localization: bilingual documents (en/ar/bilingual), currency per document.
- Phase: shipped; deepened in 3.

### Contracts
- Purpose: the agreed legal frame around work and money.
- Core entities: contract, term, milestone, variation.
- Primary workflows: from accepted quote -> contract -> milestones drive billing points.
- Dependencies: Sales, Customer; feeds Work, Receivables.
- Permission boundary: new contracts.*; legal text restricted to managers.
- Sensitivity: legally binding content — versioned, never silently edited.
- Status: planned.
- Localization: bilingual legal text, per-country requirements.
- Phase: 3.

### Work and project management
- Purpose: the operational center — the record delivery happens against.
- Core entities: work (renameable), stage, preset, assignment.
- Primary workflows: accepted work -> stages/tasks/owner -> delivery -> completion (QC-gated where configured).
- Dependencies: Customer/Sales upstream; feeds Cost, Billing, Reporting.
- Permission boundary: jobs.* with assigned-scope for field roles.
- Sensitivity: low; cost figures on it are redacted by privilege.
- Status: shipped (stage templates, presets, skip keys, weights, weekly view).
- Localization: terminology-renameable in both languages.
- Phase: shipped; deepened in 4.

### Tasks, phases and dependencies
- Purpose: fine-grained execution under work.
- Core entities: task, phase, dependency, checklist.
- Primary workflows: plan tasks -> sequence with dependencies -> track completion into stage progress.
- Dependencies: Work; feeds Planning.
- Permission boundary: follows jobs.* scoping.
- Sensitivity: low.
- Status: partial (stage-level tasks ship; dependencies and cross-work sequencing planned).
- Localization: standard.
- Phase: 4.

### Operations and field activity
- Purpose: what actually happened, recorded where it happened.
- Core entities: daily report, report line, issue, attachment.
- Primary workflows: field report -> review -> approved evidence attaches to work; issues raised and resolved.
- Dependencies: Work; feeds Cost (materials/hours), Reporting.
- Permission boundary: reports.create field-scoped; reports.review manager.
- Sensitivity: low.
- Status: shipped (daily reports, review, issues, offline-tolerant entry).
- Localization: field-first mobile in both languages.
- Phase: shipped; deepened in 4.

### Documents and digital approvals
- Purpose: the papers a business issues and the decisions it records.
- Core entities: document (quote/invoice/PO print), approval, approval subject.
- Primary workflows: generate branded document -> share/export; request approval -> decide with reason.
- Dependencies: identity/branding config; every module that issues documents.
- Permission boundary: approvals.decide; document access follows the record.
- Sensitivity: legal identity on documents.
- Status: shipped (three branded bilingual templates, share link, approvals with configured subjects); e-signature planned.
- Localization: en/ar/bilingual issuance shipped.
- Phase: shipped; e-signature in 6.

### Accounting and general ledger
- Purpose: the books — double-entry truth beneath operational money.
- Core entities: account, journal, journal line, period, chart-of-accounts pack.
- Primary workflows: operational events post (with approval) to journals -> period close -> statements.
- Dependencies: Receivables, Payables, Cash, Payroll; CoA packs per country.
- Permission boundary: new accounting.*; posting is a consequential action.
- Sensitivity: HIGH financial/legal; immutable after posting, corrections by reversal.
- Status: planned (nothing today claims to be accounting; receivables view and cost records are operational, not books).
- Localization: per-country CoA and VAT packs (§5).
- Phase: 6.

### Accounts receivable
- Purpose: what customers owe and collecting it.
- Core entities: invoice, payment, allocation, outstanding balance.
- Primary workflows: invoice -> record payment -> allocate -> outstanding visible.
- Dependencies: Sales/Work; feeds GL when accounting ships.
- Permission boundary: invoices.*/payments.*/ar.view; amount redaction.
- Sensitivity: financial.
- Status: shipped (operational AR: invoices, payments, receivables view, VAT per line).
- Localization: bilingual tax invoice shipped.
- Phase: shipped; GL integration in 6.

### Accounts payable
- Purpose: what the business owes suppliers.
- Core entities: supplier invoice, payment run, allocation.
- Primary workflows: PO/GRN -> supplier invoice match -> approve -> pay.
- Dependencies: Purchasing; feeds GL, Cash.
- Permission boundary: new ap.*; payment release is consequential.
- Sensitivity: HIGH (outgoing money).
- Status: planned (POs and expenses ship; formal AP ledger does not).
- Localization: per-country invoice requirements.
- Phase: 6.

### Cash and treasury
- Purpose: where the money is.
- Core entities: cash/bank account, movement, reconciliation.
- Primary workflows: record movements -> reconcile -> position visible.
- Dependencies: AR, AP, Payroll.
- Permission boundary: new treasury.*; strongest redaction tier.
- Sensitivity: HIGH.
- Status: planned (expenses/cashbook add-on is operational spend capture, not treasury).
- Phase: 6.

### Budgeting and forecasting
- Purpose: intended numbers beside actual numbers.
- Core entities: budget, budget line, forecast, variance.
- Primary workflows: set budget -> actuals accrue from operations -> variance -> reforecast.
- Dependencies: Accounting/Cost; feeds Planning.
- Permission boundary: new budgeting.*; manager+.
- Sensitivity: financial-strategic.
- Status: planned (quote-vs-actual on work ships as the operational seed).
- Phase: 6-8.

### Purchasing and suppliers
- Purpose: buying what the work needs, accountably.
- Core entities: material request, purchase order, goods receipt, supplier.
- Primary workflows: MR -> approval -> PO -> GRN -> cost lands on work.
- Dependencies: Work, Items; feeds Cost, AP.
- Permission boundary: mr.*/po.*; supplier commitment is consequential.
- Sensitivity: commercial commitments.
- Status: shipped.
- Localization: bilingual LPO shipped.
- Phase: shipped; deepened in 5.

### Inventory and warehousing
- Purpose: stock on hand, where, and its value.
- Core entities: warehouse, stock level, movement, valuation.
- Primary workflows: receive -> store -> issue to work -> count -> value.
- Dependencies: Items, Purchasing; feeds Cost, Accounting.
- Permission boundary: new inventory.*.
- Sensitivity: valuation feeds the books.
- Status: planned (items catalogue and GRNs ship; stock ledger does not).
- Phase: 5.

### Assets and maintenance
- Purpose: the equipment the business owns and its upkeep.
- Core entities: asset, assignment, maintenance schedule, work order.
- Primary workflows: register -> assign -> maintain -> depreciate (with accounting).
- Dependencies: Purchasing; feeds Accounting.
- Status: planned.
- Phase: 5.

### HR and employee records
- Purpose: the people file.
- Core entities: employee, document, contract of employment.
- Primary workflows: hire -> record -> role/team assignment -> leave/exit.
- Dependencies: none; feeds Attendance, Payroll, Permissions.
- Permission boundary: employees.*; PII strongly restricted.
- Sensitivity: HIGH personal data.
- Status: partial (people directory ships; HR documents/contracts planned).
- Phase: 7.

### Attendance, leave and scheduling
- Purpose: who is working, when, and who is away.
- Core entities: attendance mark, shift, leave request, balance.
- Primary workflows: mark/import attendance -> feeds labour cost; request leave -> approve -> balance.
- Dependencies: HR; feeds Payroll, Cost.
- Status: partial (attendance ships and feeds labour costing; leave and shift scheduling planned).
- Phase: 7.

### Payroll
- Purpose: paying people correctly and provably.
- Core entities: payroll run, payslip, component, per-country pack (e.g. WPS-style file formats where applicable).
- Primary workflows: prepare run from attendance/leave -> review -> approve -> finalize -> post to GL.
- Dependencies: HR, Attendance, Accounting.
- Permission boundary: new payroll.*; finalization always human-approved.
- Sensitivity: MAXIMUM (salaries = money + PII + legal).
- Status: planned.
- Localization: country payroll packs required before any country claim.
- Phase: 7.

### Performance and objectives
- Purpose: what good looks like, per person and team.
- Core entities: objective, review, note.
- Status: planned. Phase: 8. Sensitivity: personal.

### Planning
- Purpose: the forward view — capacity, schedule, commitments.
- Core entities: plan, planned item, capacity line.
- Primary workflows: plan from pipeline + work + team capacity -> compare to actual -> adjust.
- Dependencies: reads most domains; writes none of their records.
- Status: planned (weekly view ships as the operational seed).
- Phase: 8.

### Analytics and statistics
- Purpose: the business, measured.
- Core entities: report definition, snapshot, export.
- Status: partial (operational reports, owner digest, CSV exports ship; cross-domain analytics planned).
- Phase: 8.

### Executive management
- Purpose: the owner's single line of sight and decisions log.
- Core entities: overview surface, decision, exception.
- Status: partial (owner Today overview and exception surfacing ship; decision log and exec pack planned).
- Phase: 8.

### Audit, security and administration
- Purpose: boundary, permissions, history, undo.
- Status: shipped (RLS boundary, permission matrix, redaction, audit log, config revisions with undo, security headers, validated uploads).
- Phase: shipped; continuous.

### Automation
- Purpose: the business's own rules running reliably (notifications, escalations, recurring records).
- Core entities: rule, trigger, action, run log.
- Primary workflows: define governed rule -> runs -> logged -> reversible where the action allows.
- Permission boundary: rules can never exceed their author's permissions.
- Status: planned (the outbox/queue substrate ships; user-defined automation does not).
- Phase: 10.

### Role-aware intelligence
- Purpose: agents that help each role inside the same permissioned system.
- Contract: docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md.
- Status: planned. NO production AI runs today (verified: the onboarding and
  narration "providers" are unimplemented seams over deterministic code; no
  AI SDK exists in the codebase).
- Phase: 2 (foundation), 10 (advanced).

## 4. Intelligent clay laws

1. Capabilities exist underneath as modules; presence in the platform is not
   presence on the screen.
2. Navigation is composed from enabled capabilities, role and permission
   (already the shipped nav builder's law).
3. Each role sees its own operating surface.
4. Users can add, remove, rename, reorder and configure workspace areas
   through governed configuration.
5. Complexity appears progressively: depth arrives when the business's
   records need it.
6. The system may suggest changes; the user approves them.
7. Configuration is reversible and audited (shipped: revisions + undo).
8. Empty modules never create empty dashboards.
9. Homepage, dashboard and navigation adapt to actual operational evidence,
   not to the module list.
10. Mobile, Arabic, English, RTL and future Spanish are first-class in every
    module from its first release.
11. Accessibility is not optional.
12. A cupcake business must feel powerful without seeing factory complexity;
    a large industrial company must gain depth without leaving the platform.

## 5. International architecture

International-first; the UAE and GCC are the first launch market, not the
product boundary. The core stays unbranched; countries arrive as PACKS:

- Languages: en and ar shipped with full RTL; es planned first-class.
- Formats: numbers, dates, addresses per locale (Latin numerals policy holds).
- Money: workspace currency + per-document currency and rate shipped;
  multi-currency accounting arrives with the GL.
- Legal entities: issuer identity per organization shipped; multi-entity
  planned with accounting.
- Country packs (all PLANNED until each ships): tax packs (rates, labels,
  document requirements), chart-of-accounts packs, payroll packs, invoice
  requirement packs. A pack is data + governed config, never a fork.
- No country pack may be claimed publicly before it ships.

## 6. Delivery sequence

Each stage independently useful and deployable:

1. Shared business record and intelligent workspace foundation (shipped:
   the connected record, config system, nav composition; continuing).
2. Role-aware agent foundation (the architecture contract, capability flag,
   audit/approval plumbing; no public "powered by AI" until live).
3. CRM and sales depth (leads, opportunities, contracts).
4. Project and operational depth (dependencies, scheduling, richer QC).
5. Inventory, purchasing and assets (stock ledger, valuations, assets).
6. Accounting and finance (GL, AP, treasury, budgeting; per-country packs).
7. HR, scheduling and payroll (leave, shifts, payroll runs with packs).
8. Planning, analytics and executive management.
9. International localization packs (es + country packs at production grade).
10. Cross-domain automation and advanced agents.

## 7. Truth line for public messaging

Public copy may say IdaraWorks is BUILT TO REPLACE disconnected business
software and may show the direction, but must always distinguish:
Available now / Expanding into the complete Business OS / Planned role-aware
agents. "Powered by AI" is prohibited until a real production agent exists
behind a tested capability flag (enforced in tests).
