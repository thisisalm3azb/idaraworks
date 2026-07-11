# 05 — Unified Approvals Model

**Purpose:** one approval engine for every "draft → decide" flow. The gap analysis (doc 01) shows Najolatech implemented this pattern five separate times (material requests, LPOs, receipts, quotes, report certification) with per-feature status fields and stamps — proof of demand and of the cost of not unifying. This engine is the Approve step of the loop (v2 §7) and the owner's primary lever.

---

## D-5.1 — Approval is a first-class entity referencing the approvable, not a status field on each document

**Decision:** `approval` rows: `org_id`, `subject_type` (closed registry), `subject_id`, `subject_summary` (denormalised: title, amount_minor?, job ref — per D-1.6), `rule_id?`, `requested_by`, `assigned_role` + `assigned_user_id?`, `state`, `decided_by/at`, `decision_note` (required on reject), `expires_hint?`. The subject document keeps its own status enum (e.g. MR `submitted`), advanced by the engine on decision — **the approval owns the decision record; the document owns its lifecycle.**
**Why:** one inbox (Today card + Approvals nav) needs one query; audit needs one shape; stuck-approval detection (E-03) needs one age field; future chains extend one engine instead of five features.
**Alternatives rejected:** per-document status-only (Najolatech's five copies — no inbox, no unified audit); a generic workflow engine with approval as a node type (banned direction: this is one node shape, not a platform); approvals as tasks (conflates doing with deciding; wrong permissions, wrong metrics).
**Risks:** state duplication between approval and subject — mitigated: the engine is the **only** writer of both transitions, in one transaction; a CI invariant test asserts no subject in a decided-implying state lacks a matching decided approval.
**Validate in pilots:** median decision time (target < 4 working hours, §12 metric); zero "I decided but the document didn't move" reports.

## D-5.2 — MVP is single-approver with threshold rules; chains are deliberately deferred

**Decision:** `approval_rule` (template-seeded, org-editable via config revisions): `subject_type`, `condition` = fixed vocabulary (`always` | `amount_gte(minor)` | `urgency_in(...)`), `assigned_role`, `auto_approve_below?` (amount threshold under which submission auto-approves with an activity note). One matching rule fires per submission (most-specific-condition wins; ties = validation error at config time, not runtime).
**Why:** the extraction shows the real approval topology at a 50-person operation is "staff draft, one accountable role decides" — single-level covers 100% of observed cases. Chains (multi-step, quorum, delegation) are P4 workflow-builder territory (v2 §10).
**Alternatives rejected:** configurable chains now (weeks of engine + UI for zero observed MVP demand — R16 in workflow form); hardcoded "admin approves" (loses the template's ability to route MRs to manager below a threshold, and blocks the P4 growth path).
**Risks:** a pilot with a genuine two-step need (owner + accountant) — escape hatch documented: model as two rules on different subject types (expense entry vs payment) or accept and log as P4 evidence.
**Validate in pilots:** count of requests that needed more than one decider (target: ~0); auto-approve threshold usage and comfort.

## D-5.3 — MVP approvable registry

| subject_type | Subject status advanced | Default rule (template #1 — doc 08) |
|---|---|---|
| `material_request` | submitted → approved/rejected (→ converted by procurement) | amount ≥ threshold → owner/admin; below → manager; tiny → auto-approve (off by default) |
| `expense` | submitted → approved/rejected | amount ≥ threshold → owner/admin; below → accounts |
| `quote_send` | pending_approval → approved (then sendable) | always → owner/admin |
| `purchase_order` *(audit F-3)* | draft → approved — **only for MR-less (direct) or over-threshold POs**; converting an approved MR auto-approves its PO | MR-less or amount ≥ threshold → owner/admin |
| `payment` *(OP-7 closure 2026-07-11 — supersedes the pending-PB-8 `payment_receipt` approval)* | recorded → confirmed/rejected | **org-configurable modes via the standard rule vocabulary:** none (no rule installed) / every payment (`always`) / above threshold (`amount_gte`) → owner/admin. `payment_receipt` is the printable wrapper only — never separately approved |
| `stage_signoff` *(P3, with QC)* | stage complete-request → completed | manager; failures block via E-15 |
| `qc_delivery_override` *(P3)* | delivery gate bypass | owner/admin only, reason required, critical-audit logged |

`invoice_issue` is **explicitly out of the enum** for MVP (audit C-1). Goods-receipt confirmation is **not an approval** — it is GRN creation under its own permission (audit C-2).

**Self-approval guard (audit F-4):** the engine enforces `decided_by ≠ requested_by`. When the only rule-eligible approver is the requester, the approval escalates one role up; at the terminal role (Owner), self-approval is permitted but stamped `self_approved` in activity and audit.

Registry is code-owned (D-2.1 principle); templates choose *which* registered types are active and their rules — they cannot invent types.

## Engine behaviour

- **Submission:** service layer creates subject in its pending state + approval row atomically; notification pushed to the assigned role's members (push — approvals are the "act within hours" class, doc 03).
- **Inbox:** one query — open approvals where `assigned_role ∈ my roles` (or `assigned_user_id = me`), ordered by age × amount; renders subject_summary without loading subjects (denormalisation earns its keep); **subject_summary passes through the same server-side cost-redaction boundary as the Today composer** (doc 06 serialization rule; audit F-23 — amounts never reach viewers without `finance.viewCosts`, including notification bodies); deep-links to the full document for context before deciding.
- **Decision:** approve/reject (+ note), one transaction advancing both records, activity + audit writes (D-1.8), notification to requester; **reject always carries a reason** (Najolatech's rejectedReason kept — rejection without a reason teaches nothing and re-submissions loop).
- **Offline:** **approvals are online-only in MVP** — the audit's scope correction (§5) narrows the offline outbox to daily reports + photos. When offline decisions arrive (P3), they must carry the safeguards specified by audit F-24: the replay endpoint re-runs `can()` at execution time (revoked roles can't replay), and each queued decision binds a subject content hash — mismatch → "changed since you reviewed" rejection; first decision wins.
- **Escalation:** no auto-reassignment in MVP; E-03 (stuck approval) surfaces age to the approver and, at critical, to the owner — social escalation before mechanical escalation.
- **Cancellation:** requester may withdraw while pending (state `withdrawn`, subject reverts to draft).

**States:** `pending → approved | rejected | withdrawn` (+ terminal `superseded` when a re-submission replaces a rejected one, keeping the chain navigable).

## What this engine is not

Not a general workflow system (no arbitrary states, no scripting, no tenant-defined subject types); not a task system; not an SLA engine (E-03 handles time pressure). Extension path to P4 chains: `approval.step_no` + rule `next_rule_id` are the two columns reserved — noted, not built.
