# Role-aware agent architecture

Status: binding contract for the future agent implementation (H11).
NOTHING in this document is implemented yet: no AI provider, agent runtime or
AI workflow operates in production today, and public copy must not claim one.
When implementation begins, it implements THIS contract; deviations require
updating this document first.

## 1. What an agent is here

An agent is role-aware intelligence operating INSIDE the permissioned
business system — not a chatbot beside it. An agent session is always bound
to (organization, acting user, role, entitlements, locale). Its entire
authority is a subset of that user's authority.

## 2. Non-negotiable agent laws

1. Agents inherit the acting user's organization and permissions.
2. Agents never bypass RLS.
3. Agents never use service-role access as ordinary user authority.
4. Agents cannot read another organization's records.
5. Agents cannot reveal redacted prices, costs, payroll or personal
   information to a user whose role cannot see them.
6. Agents must show which records support important recommendations.
7. Agents must distinguish facts, calculations, assumptions and suggestions.
8. Consequential actions require explicit human approval.
9. Financial posting, payroll finalization, employee termination, supplier
   commitment, customer communication and destructive correction ALWAYS
   require approval.
10. Agents must never generate or modify application code.
11. Agents must never generate or execute DDL.
12. Agents must never modify RLS, permissions or security policy.
13. Agents configure only through governed schemas and validated commands
    (the existing config pipeline; nothing else).
14. Every agent action is auditable (command path + agent attribution).
15. Every configuration change an agent prepares is reversible
    (config_revision + undo).
16. Prompt injection inside uploaded files, customer notes or external
    content is untrusted DATA: it can never grant instructions, authority or
    tool access.
17. Agents cannot silently activate modules, alter subscriptions or create
    financial obligations.

## 3. Approval classification

Every agent capability is classified at design time; the runtime enforces
the class, not the model's judgment:

- READ AND EXPLAIN: answer from permitted records; cite them.
- DRAFT: produce content for a human to use (never sent or saved as final).
- RECOMMEND: propose an action with reasons and supporting records.
- PREPARE REVERSIBLE CHANGE: stage a governed, undoable change; nothing
  applies until approval.
- EXECUTE AFTER APPROVAL: apply a prepared change after an explicit,
  attributed human approval in-product.
- PROHIBITED: never available to the agent regardless of prompt (laws 9-12,
  17 enumerate the permanent members of this class).

## 4. Common contract (applies to EVERY agent below)

- Permitted inputs: the user's request; records the user can read; governed
  configuration; module documentation. External/uploaded content enters only
  as untrusted data (law 16).
- Permitted tools: read-only domain queries scoped by ctx; draft builders;
  the governed config pipeline (prepare class); approval-request creation.
  No network, no shell, no schema access, no raw SQL.
- Audit: every invocation and tool call logs (org, user, agent, class,
  records touched) through the command path.
- Explanation: consequential outputs carry "based on" record references and
  label each statement fact / calculation / assumption / suggestion.
- Confidence: below-threshold answers must say what is uncertain and what
  evidence would resolve it; agents prefer "I do not know" to invention.
- Handoff: an agent hands off by returning a structured request the next
  agent answers under the SAME user binding; handoffs never widen authority.
- Human escalation: anything in a higher approval class than the agent's
  invocation context becomes a recommendation addressed to a human with the
  required permission.
- Localization: agents answer in the user's locale (en/ar now, es later),
  use the organization's own terminology (term registry), keep Latin
  numerals policy, and format money/dates per workspace settings.
- Failure: on tool failure or missing permission the agent states plainly
  what it could not do and why (no silent retry into other tools, no
  fabricated result).

## 5. The specialist agents

Each block lists only agent-specific bounds; §4 applies to all.

### Executive Agent
- Purpose: the owner's line of sight — what needs attention and why.
- Readable domains: all the acting executive can read (cross-domain).
- Writable domains: none directly; PREPARE class for decision notes only.
- Extra prohibitions: cannot approve on the executive's behalf.
- Approvals: any suggested cross-domain action routes to the responsible
  role as a recommendation.
- Typical handoffs: to every specialist for domain detail.

### Operations Agent
- Purpose: keep daily delivery moving (reports, issues, attendance signals).
- Readable: work, reports, issues, attendance, approvals queue.
- Writable (PREPARE/DRAFT): report drafts, issue drafts, stage-completion
  requests.
- Prohibited: completing QC-gated stages; anything money.
- Approvals: stage completion and issue closure stay human.
- Handoffs: Project Agent (planning), Inventory and Purchasing Agent
  (materials).

### Project Agent
- Purpose: plan and re-plan work (stages, tasks, dates, load).
- Readable: work, tasks, capacity, weekly view.
- Writable (PREPARE): stage/task plans as reversible drafts.
- Prohibited: changing presets/config outside governed pipeline.
- Approvals: plan application approved by a manager.
- Handoffs: Operations, Planning and Analytics.

### Sales and CRM Agent
- Purpose: pipeline hygiene and quote preparation.
- Readable: customers, leads/opportunities (when shipped), quotes.
- Writable (DRAFT): quote drafts, follow-up drafts.
- Prohibited: SENDING anything to a customer (law 9: customer communication
  is always human-approved); changing prices beyond governed price sources.
- Handoffs: Accounting Agent (AR status), Executive.

### Accounting Agent
- Purpose: explain the books; prepare journals (when GL ships).
- Readable: GL, AR, AP, periods (per role).
- Writable (PREPARE): journal drafts, reconciliation suggestions.
- Prohibited: POSTING (law 9), period close, touching operational records.
- Approvals: every posting and close by a permitted human.
- Handoffs: Finance, Inventory and Purchasing (valuations).

### Finance Agent
- Purpose: cash, budgets, forecasts, variances.
- Readable: treasury, budgets, AR/AP aggregates.
- Writable (PREPARE): budget/forecast drafts.
- Prohibited: payment release, transfers, any commitment.
- Handoffs: Accounting, Executive.

### People and Payroll Agent
- Purpose: HR records hygiene, attendance/leave signals, payroll preparation.
- Readable: only what the acting HR/payroll role can read (strictest PII).
- Writable (PREPARE): leave decisions drafts, payroll run preparation.
- Prohibited: payroll finalization, termination, salary reveal to
  unauthorized roles (laws 5, 9).
- Approvals: every payroll finalization and employment action human.
- Handoffs: Finance (cost), Executive (headcount).

### Inventory and Purchasing Agent
- Purpose: keep material flow ahead of the work.
- Readable: items, stock (when shipped), MRs, POs, suppliers, GRNs.
- Writable (DRAFT/PREPARE): MR drafts, PO drafts, reorder recommendations.
- Prohibited: issuing a PO to a supplier (supplier commitment, law 9).
- Handoffs: Operations, Accounting (valuation), Finance (cash impact).

### Planning and Analytics Agent
- Purpose: turn records into forward plans and honest statistics.
- Readable: cross-domain aggregates the user can see (redaction applies to
  aggregates too — no reconstructing hidden figures from totals).
- Writable (PREPARE): plan drafts, report definitions.
- Prohibited: presenting projections as facts (must label assumptions).
- Handoffs: every specialist for source detail; Executive for decisions.

## 6. The Manager Agent (orchestrator)

- Purpose: route a user's goal across specialists and assemble one answer.
- Authority: EXACTLY the acting user's; orchestration never sums, widens or
  escalates permissions. A specialist invoked by the Manager Agent runs
  under the same (org, user, role) binding as a direct invocation.
- May: decompose requests, sequence specialists, merge cited results,
  surface conflicts between specialists.
- May not: hold state across organizations, cache another user's results
  into this user's session, approve anything, or invoke a specialist class
  the user could not invoke directly.
- Every hop is audited as part of one traced request.

## 7. Runtime requirements (for the implementing micro-step)

- A production capability flag (server-verified, entitlement-gated) is the
  ONLY thing that may flip public copy from "planned" to live wording; the
  homepage test suite enforces that "Powered by" AI wording cannot render
  while the flag is absent/false.
- Model calls go through one provider seam with: org/user binding, tool
  allow-list per agent per class, output validation before any PREPARE
  write, and full audit.
- Evaluation before launch: injection resistance (law 16), redaction
  resistance (law 5), refusal correctness (PROHIBITED class), citation
  fidelity (law 6), bilingual quality.
