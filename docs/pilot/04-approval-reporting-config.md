# Pilot Guide 04 — Approval Rules & Reporting Configuration

> **Audience:** the operator standing up a pilot org (you), plus the pilot org's Owner/Admin who will run it.
> **Scope:** how to configure approval routing and how the reporting + exception surfaces behave for a pilot. Everything here is **production-operational today** (S3 Report, S4 Approve, S5 Measure, S6 Bill rules, S7 rules — all shipped and deployed). Where a knob is *not* self-service in the MVP, this doc says so plainly rather than pretending it is.

---

## 0. TL;DR for a pilot

1. Approval rules are **org-scoped rows** in `public.approval_rule`, one engine for every draft→decide flow (`src/modules/approvals/service.ts`).
2. Each rule has three parts: a **subject type** (what needs approving), a **mode** (`none` / `always` / `amount_gte` — this is the OP-7 vocabulary), and an optional **auto-approve-below** floor.
3. If **no rule** matches a subject, the safe default fires: **route to the Owner, never auto-approve.** You cannot accidentally leave money un-gated.
4. Approval rules are installed by the **onboarding apply** step (AI ConfigProposal `approval_defaults`, or the manual template path) and by the `createApprovalRule` server action. Both are gated on **`config.manage` (Owner / Admin only)**. There is **no standalone rule-editor screen** in the MVP — see §3.4.
5. The **daily report is a fixed structured document** (summary + work/material/labour lines). Its fields are not per-org-configurable in the MVP; what *is* configurable is terminology, the stage list, custom fields on the *job* entity, and the holiday calendar.
6. **Exception thresholds are code-owned defaults** (E-01…E-13). They are correct out of the box for a GCC project SMB and are **not** exposed as per-org sliders in the MVP. The one org-editable input that changes exception behaviour is the **holiday calendar** (installed from the template, editable afterward).

---

## 1. Who configures what

All configuration authority is capability-gated through the permission matrix (`src/platform/authz/matrix.data.ts`, cross-checked against `matrix.ts`). The capabilities relevant to this guide:

| Capability | Owner | Admin | Manager | Accounts | Foreman | Procurement | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `config.manage` (install/edit approval rules, terminology, fields, calendar) | ✅ | ✅ | | | | | |
| `config.view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `approvals.decide` (act on the inbox) | ✅ (any) | ✅ (any) | ✅ (routed-to-me) | ✅ (routed-to-me) | | | |
| `exceptions.view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | audience-scoped |
| `exceptions.dismiss` | ✅ | ✅ | ✅ | | | | |
| `reports.review` (approve/return a daily report) | ✅ | ✅ | ✅ | | | | |

> **Rule of thumb for a pilot:** the pilot org's **Owner** sets up approval rules once during onboarding; **Owner + Admin** are the anything-goes deciders; **Managers/Accounts** only ever see and decide the approvals routed to their own role.

---

## 2. The approval engine in one paragraph

There is exactly **one** approval engine. Every gated flow — material request, purchase order, expense, quote-send, payment — creates an `approval` row that is the first-class decision record, while the subject keeps its own status. The engine is the **sole writer of both transitions in one transaction** (a CI invariant asserts no subject sits in a decided-implying state without a matching decided approval). A requester can never decide their own approval (self-approval guard F-4); when the requester is the *only* eligible decider, the engine **escalates one role up** until a non-requester exists (terminal Owner self-approval is permitted but stamped `self_approved`). Amounts on the inbox are **redacted per subject type** for non-privileged viewers, and notification bodies carry **no amount at all**.

---

## 3. Configuring approval rules

### 3.1 The rule shape (OP-7 vocabulary)

A rule row (`public.approval_rule`, created via `createApprovalRule` in `src/modules/approvals/service.ts`) has:

- **`subject_type`** — one of `material_request`, `expense`, `quote_send`, `purchase_order`, `payment`.
- **`condition_kind`** — the **mode**:
  - **`none`** — *not a row.* "None" means **install no rule** for that subject. With no rule, the engine's safe default applies (route to Owner, never auto-approve). This is the literal OP-7 "none" mode.
  - **`always`** — every subject of this type needs a decision. At most **one** `always` rule per subject (enforced by the `approval_rule_one_always_per_subject` partial-unique, migration `0063`).
  - **`amount_gte`** — fires only when the subject's amount **≥ `amount_gte_minor`** (a threshold in **minor units**). Below the threshold, if no other rule matches, the safe default (→ Owner) applies.
  - (`urgency_in` also exists for urgency-tagged subjects; not needed for a first pilot.)
- **`assigned_role`** — the archetype the approval routes to (`owner`, `admin`, `manager`, `accounts`, …).
- **`auto_approve_below_minor`** — optional **auto-approve floor**. When set, a subject whose amount is **strictly below** this value is **auto-approved** at submission (recorded as an already-approved approval with note *"auto-approved (below configured threshold)"*, `self_approved = false` because it is a *rule* decision, not a human one). **Off by default** (D-5.3).

> **OP-7 (payment) closure, verbatim intent:** payment approval is *"org-configurable modes via the standard rule vocabulary: none / every payment (`always`) / above threshold (`amount_gte`) → owner/admin."* The `payment_receipt` is only the printable wrapper — it is **never separately approved**. (`phase2/05-approvals-model.md`.)

### 3.2 Resolution & safety guarantees

- **Most-specific wins.** Specificity order: `amount_gte` (by threshold) > `urgency_in` > `always`. Exactly one rule fires.
- **Ties are rejected at config time, not resolved at runtime.** `assertRuleSetUnambiguous` runs *inside* the create transaction — two `always` rules, or two `amount_gte` rules at the same threshold, roll the insert back with `RuleValidationError`. You cannot persist an ambiguous set.
- **No matching rule ⇒ route to Owner, never auto-approve** (`resolveRule`). This is the backstop that makes "none" safe.
- **`auto_approve_below` is the OPPOSITE of a threshold rule.** An `amount_gte` rule *adds* an approval above X; an `auto_approve_below` floor *removes* an approval below X. Do not confuse the two when configuring.

### 3.3 Recommended pilot starting configuration

For a boat-building / project-SMB pilot on template #1, a safe, low-friction default set:

| Subject | Suggested rule | Effect |
|---|---|---|
| `material_request` | `always` → `manager` | every MR gets a workshop-manager decision |
| `purchase_order` | `amount_gte` at a mid-value threshold → `owner`/`admin` | small direct POs auto-flow; large ones gate to Owner. (Converting an already-approved MR auto-approves its PO — no double gate.) |
| `payment` | `amount_gte` → `owner`/`admin`, **or** `none` for a first pilot | choose per the pilot's appetite; `none` = payments recorded but not separately confirmed |
| `quote_send` | `always` → `owner`/`admin` | nothing goes to a customer without a price-privileged sign-off |
| `expense` | `none` initially | expenses are recorded + costed; add `amount_gte` later if the pilot wants gating |

The onboarding default the platform ships (`applyOnboarding`, `src/modules/onboarding/service.ts`) installs `always → manager` rules from the proposal's `approval_defaults` with the org's `auto_approve_below_minor` floor when the AI onboarding supplies one.

### 3.4 How to actually set them (and the honest MVP limitation)

- **Primary path — onboarding.** The AI onboarding produces a `ConfigProposal` whose `approval_defaults` are turned into rules by the apply step. The manual/guided onboarding fallback does the same. This is the intended pilot path: **rules are decided once, at onboarding, by the Owner.**
- **Server action — `createApprovalRule(ctx, archetype, input)`**, `config.manage`-gated. This is what onboarding calls and is the supported programmatic way to add or change a rule.
- **There is no dedicated "approval rules" settings screen in the MVP.** The in-app `/o/{orgId}/approvals` page is the **decision inbox**, not a rule editor. Consequence for the pilot: **adjusting rules mid-pilot is an operator action** — re-run the relevant onboarding apply, or invoke `createApprovalRule` — not something the pilot Owner self-serves from a form. Flag this to the pilot Owner up front so mid-pilot changes are routed to you.
- `listApprovalRules(ctx, archetype)` (`config.view`) lets you read back the installed set to verify.

### 3.5 The decision inbox (what deciders see)

`/o/{orgId}/approvals` (`listInbox`, `approvals.decide`):

- **Owner/Admin** see every pending approval; **Manager/Accounts** see only those routed to their role (or assigned to them personally).
- Ordered **age × amount** (older + bigger first). The amount is used server-side for the sort but **redacted from the payload** per subject type: supply money (MR/PO/expense) needs `po.view`; a `quote_send` amount is a *selling* price behind `pricePrivileged`; a `payment` amount needs `payments.view`. A Foreman/Viewer never sees any figure.
- A **rejection requires a reason** (`decision_note`). Approve/reject advances both the approval and the subject atomically; a decision that lands after the subject already moved (e.g. a voided payment) is a guarded **no-op**, never a resurrection.
- **Stuck approvals** self-surface: E-03 raises `approval_stuck` at **8 working-ish hours → warning, 3 days → critical** (see §5).

---

## 4. Reporting configuration (the daily report)

### 4.1 The report is a fixed structured document

The daily report (`src/modules/reports/service.ts`) is **the heartbeat** of the system and its structure is **fixed by design** — it is not a per-org form builder in the MVP. Every report has:

- **Header:** `summary` (required, ≤2000 chars), `blockers` (optional), `nextSteps` (optional), `reportDate`, an `idempotencyKey` (stable across offline retries — exactly-once submit), and an `isBackfill` flag.
- **Work lines** (≤50): `stageKey`/`stageId` + `description` + optional `progressNote`.
- **Material lines** (≤100): `itemName` (or `itemId`) + `qty` + `unit`.
- **Labour lines** (≤100): `employeeId` + `normalHours` + `otHours`.

**Labour lines ARE attendance** (decision U3): one write, three reads — the attendance register, the labour cost, and progress evidence. There is no separate check-in flow in the MVP.

### 4.2 The cost wall (important for a pilot's trust)

A Foreman **enters hours** but never sees cost. On submit, the labour **cost snapshot** (`report_labour_cost`) is written by the `SECURITY DEFINER` function `app.freeze_report_labour_costs`, so a non-cost-privileged submit freezes cost **without the foreman ever reading it** — the RLS select wall stays intact. Confirm this holds in the pilot demo (it is asserted in the S3/S10 suites).

### 4.3 The review loop

`submitted → reviewed | returned`. A Manager/Owner/Admin (`reports.review`) reviews; a reviewed report is **immutable** (C-6). A returned report can be re-edited under the same idempotency identity. Configure nothing here — it is fixed behaviour; just make sure the pilot has at least one `reports.review` holder (Manager) staffed.

### 4.4 What you CAN configure around reporting

These are the org-editable levers (`config.manage`, via `/o/{orgId}/settings/configuration` and the onboarding install):

- **Terminology** — e.g. "Daily Report", "Boat", "LPO" (English + Arabic, with Arabic gender). Template #1 ships the marine terms.
- **The stage list & weights** — the 11 production stages (Σ weight = 100) that work lines attach to.
- **Custom fields on the *job*** (and customer) entity — `text/number/money/date/boolean/photo/select/multiselect`, required/optional, retire-not-delete (`src/platform/config/customFields.ts`). Template #1 seeds `engine_package` and `colour_scheme` on the job. **Note:** custom fields attach to *jobs/customers*, **not** to the daily report in the MVP.
- **The holiday calendar** — installed per country (AE/SA seeded for 2026, incl. Ramadan hours) and **org-editable after install**. This is the one config that materially changes exception timing (§5).

Config changes go through the **revision workflow** (preview → apply → undo), visible on the configuration page; every change is audited.

---

## 5. Exception rules & thresholds

The exception engine (`src/modules/exceptions/service.ts`) is the **sole writer** of `public.exception`, with a deterministic **raise / age / self-heal** lifecycle, **dedup-by-key** (one open row per condition that *ages* rather than duplicating daily), and **working-calendar awareness** (F-41) so the daily rules don't storm during Eid.

### 5.1 The catalogue and its default thresholds

| Rule | Key | Trigger | Default thresholds | Severity | Audience | Lane |
|---|---|---|---|---|---|---|
| E-01 Missing report | `missing_report` | active job with no submitted report | gap **≥1** working day → warning; **≥3** → critical | warn/crit | owner, admin, manager | nightly |
| E-02 Overdue stage/job | `overdue_stage` | active job past `due_date` | **>7** working days → critical | warn/crit | owner, admin, manager | nightly |
| E-03 Approval stuck | `approval_stuck` | pending approval ageing | **8h** → warning; **3 days** → critical (wall-clock MVP) | warn/crit | owner, admin, +routed role | event/push |
| E-04 Blocking issue | `blocking_issue` | unassigned blocking issue | **4h** unactioned → warning | warning | owner, admin, manager | nightly/push |
| E-05 Margin drift | `margin_drift` | cost% vs progress% divergence | **15** points, or cost **≥90%** of quote while **<90%** progress | critical | owner, accounts | nightly |
| E-06 Late PO / supplier | `late_po` / `late_supplier` | PO open past lead time | **14** lead days; aggregate at **≥3** late POs / 90 days | warning | procurement (+owner aggregate) | nightly |
| E-07 Labour outlier | `labour_outlier` | report submit anomaly | person **>12h**, or **0h** logged while work lines exist | info | manager | event |
| E-08 Unusual expense | `unusual_expense` | expense vs category median on the job | **>3×** trailing median, min **4** priors | warning | accounts, owner | event |
| E-09 Billing point uninvoiced | `billing_point_uninvoiced` | completed billing-milestone stage, no invoice | — | warning | owner, admin, accounts | nightly |
| E-10 Overdue invoice | `overdue_invoice` | issued/partly-paid invoice past due with positive net balance | **>30** working days → critical | warn/crit | owner, admin, accounts | nightly |
| E-13 Document expiry | `document_expiry` | ID/passport/visa expiring | within **30** calendar days | warning | owner, admin | nightly |
| C-10 Quote divergence | `quote_divergence` | selling price vs quote divergence | — | warning | owner, admin | costing |

Thresholds live as **named code constants** — `S7_DEFAULTS` in the exception service plus the E-01…E-04 constants. The comment on `S7_DEFAULTS` states they are *"named so a future config-tuning pass can override per org without touching the rules"* — i.e. **the override mechanism is not wired in the MVP**. **Do not promise the pilot per-org threshold sliders; they don't exist yet.** The defaults are the values above.

### 5.2 What the pilot Owner *can* influence

- **The holiday calendar** (org-editable) directly changes E-01/E-02/E-10 working-day counts and prevents Eid storms. Set it correctly for the pilot's country before go-live.
- **Staffing the audience roles.** An exception only reaches someone whose archetype is in its `audience_roles`. If the pilot has no `accounts` seat, E-05/E-08/E-09/E-10 land only on Owner/Admin. Make sure the audiences are staffed for the signals the pilot wants to see.

### 5.3 Behaviour to expect

- **Raise / age / self-heal are automatic.** A resolved condition auto-clears; an exception on a job that leaves `active` self-heals. Nothing to configure.
- **Push vs pull.** Only `approval_stuck` and `blocking_issue` push a notification (redacted title, **no amount/cost body**). The rest surface on the **Today** screens (pull).
- **Manual dismiss** — Owner/Admin/Manager, **audience + scope gated at the DB**, audited (`dismissException`). A Manager cannot dismiss an exception outside their audience.
- **Nightly cadence** — E-01/E-02/E-04/E-05/E-06/E-09/E-10/E-13 run in the nightly sweep. This sweep runs as an Inngest cron and is **dormant until Inngest keys are provisioned** — see the owner action below and `runbooks/inngest-provisioning.md`.

---

## 6. Pre-pilot verification checklist

- [ ] Approval rules installed and read back with `listApprovalRules`; confirm the ambiguity guard by attempting a second `always` on one subject (must reject).
- [ ] Confirm the **no-rule safe default**: submit a subject with no matching rule → routes to Owner, not auto-approved.
- [ ] Confirm **auto-approve-below** (if used) fires below the floor and gates at/above it.
- [ ] Inbox redaction: a Manager sees the MR amount; a Foreman/Viewer sees none; a `quote_send` amount is hidden from non-price-privileged.
- [ ] Self-approval guard: the requester cannot decide their own approval; escalation lands on the next role up.
- [ ] Daily report: a Foreman submits with labour lines; confirm cost is frozen but **not readable** by the Foreman; confirm labour lines appear in attendance.
- [ ] Review loop: a Manager reviews → report immutable; a return re-opens for edit.
- [ ] Holiday calendar set for the pilot country; spot-check that an Eid date is not counted as a working day.
- [ ] At least one seat staffed for every exception audience the pilot cares about.
- [ ] Nightly exception cron is live **or** the pilot accepts that nightly rules (E-01/E-02/E-05/E-06/E-09/E-10/E-13) don't fire until Inngest is provisioned.

---

## 7. Owner / operator actions

- **[OWNER ACTION] Inngest provisioning** — the nightly exception sweep, dunning, and retention crons are dormant until `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` are set (owner action OA-4; `runbooks/inngest-provisioning.md`). Event-lane exceptions (E-03 on evaluate, E-07 on submit, E-08 on expense create) fire without it; **nightly** rules do not.
- **[OWNER ACTION] Approval-rule policy** — the pilot Owner must decide the actual thresholds (PO gate value, whether payments are gated, quote-send sign-off). Capture these before onboarding so the rules are installed once.
- **[OWNER ACTION] Holiday calendar** — confirm/adjust the AE or SA calendar for the pilot's real closure days.
- **Operator note** — mid-pilot approval-rule changes are an operator task (no self-service editor); route pilot requests to whoever runs `createApprovalRule` / onboarding apply.

---

## 8. Source-of-truth references

- Approval engine: `src/modules/approvals/service.ts`; onboarding rule install: `src/modules/onboarding/service.ts`; matrix: `src/platform/authz/matrix.data.ts`.
- Reports: `src/modules/reports/service.ts`; custom fields: `src/platform/config/customFields.ts`; template #1: `src/platform/config/templates/boatbuilding.ts`.
- Exceptions: `src/modules/exceptions/service.ts`; governance: `phase2/04-exception-analytics-engine.md`, `phase2/05-approvals-model.md` (OP-7), `phase2/06-permissions-matrix.md`.
- Completion evidence: `docs/S5-*` (via `S6_S9_PROGRESS.md`), `docs/S6-BILL-COMPLETION.md` (E-09/E-10), `docs/S10-HARDENING-COMPLETION.md` (redaction-wall + concurrency hardening).
