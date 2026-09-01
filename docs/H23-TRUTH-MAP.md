# H23 truth map and locked decisions

Produced by an 8-subsystem audit (full JSON in the session scratchpad) before any
H23 code. The law of the phase: **extend canonical systems, never fork them.**

## What already exists (the canon H23 extends)

| Concept | Canonical home | H23 stance |
| --- | --- | --- |
| Person-as-worker | `employee` (0020) — `user_id` NULLABLE link to `user_profile`; an employee needs no login | EXTEND with columns + side tables |
| Salary | `employee_terms` (salary_minor, hourly_cost_minor, ot_rate) behind the **cost-GUC RLS wall**; costing freezes from it per report | Keep as the CURRENT projection; add effective-dated `employee_compensation` history as payroll's source of truth, one writer updates both |
| Identity docs | `employee_hr` (id/passport/visa expiries) behind the **owner/admin archetype wall**; expiries already feed E-13 exceptions | Extend; files use the existing `hr_doc` access class |
| Day attendance | `attendance` (0029) one row/employee/day, statuses incl. `leave`,`sick`,`half_day`,`late`; manual + report-derived, manual wins | Extend with punches (`attendance_event`), schedules, corrections; leave RESOLVES INTO this table |
| Job timesheets | `report_labour_line` + `report_labour_cost` (frozen rate snapshot per report via `app.freeze_report_labour_costs`) | Payroll AGGREGATES these; never re-derives or re-prices hours |
| Org expense book | `expense` (0038) — immediate cost record, void-not-delete, feeds `app.refresh_cost_rollup` | UNTOUCHED; employee claims are a feeder workflow that posts into it (or payroll) at settlement — one purchase counted once |
| Approvals | One engine (0034); SUBJECTS map in approvals/service.ts; 12-step recipe to add subjects | New subjects: `leave_request`, `overtime_request`, `expense_claim`, `pay_run` |
| Documents/PDF | DOCUMENT_KINDS + builders + issuer snapshot (0082) + working prod PDF routes | New kinds: payslip, salary_certificate, employment_contract, experience_letter, warning_letter, leave_confirmation, expense_claim_summary, payroll_register, final_settlement |
| Files | `file` with class walls (`hr_doc` exists, zero consumers); per-file self access does NOT exist; prod scan seam rejects non-image uploads until SCAN_PROVIDER is set | Receipts/ID docs as images now; PDF upload stays off until a scanner is provisioned (recorded limitation) |
| Notifications | Registry-typed kinds; inbox + computed-on-read attention (Inngest unprovisioned — never design on workers) | New kinds + `src/modules/hr/attention.ts`; email delivery is NOT wired — never promised in UI |
| Authz | Archetype matrix (dual-transcribed), `role_definition` maps org role keys → 7 archetypes + cost/price flags; matrix has NO own-record concept | New actions via the exact matrix recipe; self-service via `employee.user_id = ctx.userId` scoping in RLS + builders |
| Money | bigint minor units, `toMinorUnits`/`formatMoney`, CURRENCIES registry, allocateReference, two idempotency tiers (unique-key replay; advisory-lock multi-row) | Payroll uses the advisory-lock tier; NO floats anywhere |

## Locked decisions (safest conventional choice, reversible)

**D1 — Roles map onto existing archetypes; no new archetype in H23.**
`worker_reserved_p3` stays reserved. The seven required capabilities:
owner→owner; HR administrator→admin (the `employees.hr.manage` precedent);
payroll administrator→accounts archetype with `cost_privileged` (payroll amounts
ride the cost wall, per doc-06 D-6.2 — no new money flag invented);
manager→manager; employee→any member linked to an `employee` row (own-record
scoping, any archetype — foreman is the free field seat); finance
reviewer/auditor→org `role_definition` presets on accounts/viewer archetypes
with flags as needed. Reversible: an archetype can be added later without
rewriting history.

**D2 — Self-service is row scoping, not an archetype.** Payslip/leave/attendance
self-views key on `employee.user_id = ctx.userId` in RLS OR-clauses and in
document builders (the weekPlanModel narrowing precedent). New broadly-granted
actions (`leave.request`, `attendance.clock`, `expenses.claim`,
`payslips.view_own`) + service checks that a non-manager acts only on the
employee row linked to their login.

**D3 — Payroll is org-base-currency only in H23.** Cross-currency payroll is
NOT supported and NOT claimed; no exchange-rate snapshots are minted for pay
runs. Claims may carry foreign currency with the 0087 manual-rate column set.

**D4 — Leave resolves into `attendance`.** Approval writes day rows
(source `leave_request`, wins over manual); cancellation before start reverts
via a SECURITY DEFINER that deletes ONLY rows sourced from that request —
attendance rows here are a projection; the leave request + ledger is the
history. Early return re-marks remaining days through the correction flow.

**D5 — Timesheets are `report_labour_line`.** No second timesheet model.
Payroll reads period aggregates of frozen labour cost + attendance + approved
overtime requests.

**D6 — Compensation history is append-only** (`employee_compensation`,
effective-dated); the same command updates `employee_terms` as the current
projection so costing keeps working unchanged. Payroll snapshots inputs at
calculation (the freeze pattern) — a later comp change never rewrites a run.

**D7 — Country pack is versioned CODE + org policy rows.**
`src/modules/payroll/packs/ae.ts` with a version string embedded in every
calculation snapshot; org policy overrides live in DB. Only facts verified from
official sources are marked verified; everything else is explicit configuration.
No compliance claims (WPS export = file architecture, not a compliance claim).

**D8 — Entitlements**: new keys `cap.leave`, `cap.payroll`, `cap.expense_claims`
seeded TRUE for every plan (missing rows fail closed and the parity test
demands completeness); commercial tightening is a later owner decision. Release
gating is `FEATURE_HR_SURFACES === "1"` (strict), default off everywhere.

**D9 — Sensitivity tiers**: pay/bank/compensation → cost-GUC wall; identity,
disciplinary, medical notes → owner/admin archetype wall; both walls at the
database, and audit summaries for salary-adjacent actions carry identifiers
only, never amounts (§5.9 precedent).

**D10 — No worker-dependent designs.** Everything computed on read or at
command time; nothing waits on Inngest.

## Known constraints inherited (recorded, not fixed here)

- Non-image uploads are rejected in production until `SCAN_PROVIDER` is set —
  claim receipts and ID documents upload as images for now.
- Notification email fan-out is unwired; in-app only.
- Stored notification text is frozen English; only attention items localize.
- `signJobPhotoUpload` passes `originalName` where the signer wants `fileName`
  (pre-existing latent bug; flagged, not H23 scope).
- **H22 blocker docs/H22-BLOCKER-PO002.md stands: Najolatech PO-002 untouched.**
