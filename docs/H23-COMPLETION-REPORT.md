# H23 — People, Time, Leave, Claims & Payroll: completion report

_Date: 2026-09-01 · Branch: `verify/h23` · Author: automated build session (owner-authorized)_

## What was built, in plain language

H23 turns the employee records that already existed into one connected system:
a person is hired once, their pay history is dated and append-only, their
attendance and leave resolve into the same canonical day records the reports
use, their expense claims are approved through the same approval inbox as
everything else, and payroll reads all of it, calculates deterministically,
freezes what it calculated, and issues immutable payslips as real PDF documents
in English and Arabic.

### What each role can do

| Role (archetype) | What H23 gives them |
| --- | --- |
| **Owner / Admin** | Everything below, plus: approve pay runs, finalize them (issuing payslips), create reversal runs, see the payroll register, warning letters, final-settlement previews. |
| **Accounts** (payroll admin) | Create pay groups and runs, calculate, submit for approval, reopen refused runs, record cash advances and mileage rates, settle expense-book claims, export payroll/claims CSVs. Cannot approve or finalize (separation of duties). |
| **Manager** | See team leave requests and balances, decide leave/OT/claim approvals routed to them, view payroll lists (amounts only with cost privilege), employee attention feed in the inbox. |
| **Employee (any linked login, incl. foreman/viewer)** | `hr.self`: request leave and overtime, see their balances, file and submit expense claims (receipt lines + mileage), read their own payslips (EN/AR PDF), generate their own salary certificate and experience letter, cancel their own pending requests. They can never see anyone else's pay — enforced by database row policies, not just screens. |
| **Finance reviewer / Auditor** | Every money mutation is a `command()` audit row (identifiers only, never amounts, §5.9); pay run lines carry complete calculation snapshots with the working shown; exports leave through one paged, redacted door. |

### Deployed scope (what exists behind `FEATURE_HR_SURFACES`)

- **People foundation (H23A):** departments/positions/locations, employee
  lifecycle with a database guard, append-only compensation history projected
  into current terms, contracts with unique serials, restricted bank details,
  employee documents with expiry + versioning, disciplinary records behind the
  owner/admin wall, no destructive deletion anywhere.
- **Recruitment & offboarding (H23B):** requisition → candidate → interview →
  offer (cost-walled, one live offer) → one-transaction hire; offboarding
  checklist + final-settlement inputs.
- **Time & leave (H23C):** work patterns/shifts/schedules, punch clock with
  org-timezone day attribution, corrections as approved manual truth, overtime
  requests, versioned leave types/policies, append-only leave ledger, database
  EXCLUSION constraint so two live requests can never share a day, approval
  resolving leave into attendance, cancellation refunding only future days.
- **Payroll (H23D):** pure integer gross-to-net engine (fixed order, half-up
  rounding, stated proration basis, below-floor OT is an exception never a
  silent fix), pay runs with a database status machine, one active pay group
  per org, non-overlapping regular periods, off-cycle runs restricted to
  adjustments + reimbursements, advisory-lock + guarded one-winner
  finalization, immutable payslips with the frozen issuer identity, loans
  capped at balance, reversal runs negating pay AND employer cost.
- **Claims (H23E):** claims with receipt/mileage lines, duplicate warnings
  surfaced to the approver (never silently blocked), payroll OR expense-book
  settlement latched exactly once (per-line canonical expenses preserve job
  costing), cash advances settled against claims or converted to loans.
- **Documents (H23F):** payslip, salary certificate, employment contract,
  experience letter, warning letter, leave confirmation, claim summary,
  payroll register, final-settlement preview — all through the one
  model→HTML→PDF pipeline, EN + AR, self-narrowed, never shareable via public
  links.
- **Screens (H23G):** /leave, /claims (+new/detail), /payroll (+run detail),
  /my-pay — EN/AR, RTL, 375 px-first; nav + workspace registry + blueprint
  aware; approvals inbox deep-links every subject and runs the leave follow-up.
- **Attention & reports (H23H):** computed-on-read inbox feed (probation
  ending, contracts ending, documents expiring/expired, runs waiting),
  payslip-issued notifications (no amounts), CSV exports for employees /
  leave / claims / payslips proven accurate above 1,000 rows.

### Jurisdictions

- **United Arab Emirates (`AE-2026-09-01` pack):** overtime floors and caps,
  leave entitlements (annual, sick tiers, maternity/parental), end-of-service
  gratuity bands with cap and pro-rata, GPSSA pension percentages for UAE
  nationals — researched from official sources with an evidence log
  (`docs/H23-EVIDENCE-LOG.md`), adversarially re-verified, and embedded as
  versioned CODE stamped into every calculation snapshot.
- **No other jurisdiction is claimed.** An org from any other country runs the
  core engine (`core-unpacked`) with org-configured components and NO statutory
  claims. **This system does not claim WPS, tax or labour-law compliance**;
  the WPS export surface is an explicitly labelled seam, not a certified file.

### Configurable / unverified items (left honest, not defaulted)

- GPSSA minimum-salary floor: downgraded to unverified during research —
  configurable, never auto-applied.
- Unverified statutory components never enter a calculation (`verified` flag).
- Net rounding (1/5/10/25/50/100 minor units) is org-chosen per pay group.
- Mileage rates are org-entered with effective dates; no invented defaults.
- Claims are org-base-currency only (locked decision D3); the FX column set
  exists for a future manual-rate path.

## Defects found by the adversarial audit pass (all fixed before release)

1. Approval engine: auto/pre-approved submissions never advanced the subject
   row (approved leave would silently not debit). Fixed in the engine with the
   same guarded transition a human decision uses.
2. Finalize settled claims by employee match — a claim approved between
   calculate and finalize would be marked paid without being paid. Fixed:
   settlement is by snapshot claim id.
3. Two runs snapshotting the same claim could both pay it. Fixed twice over:
   finalize verifies its snapshot claims are still payable **with row locks**
   (`FOR UPDATE`), so concurrent finalizes of different runs serialize and the
   loser aborts with "recalculate".
4. Off-cycle runs recomputed full salaries — finalizing one next to the regular
   run would double-pay every employee. Fixed: off-cycle/final-settlement runs
   carry only adjustments + claim reimbursements.
5. A second active pay group would pay every employee twice (no group
   membership exists). Fixed with a database partial unique index.
6. Overlapping regular periods would double-count overtime and days. Fixed with
   an advisory-lock + overlap refusal at run creation.
7. `ensurePeriod` mutated a shared period's end date, silently changing what an
   existing run covered. Fixed: exact-span identity, insert-or-reuse.
8. Reversal runs did not negate employer contributions and left run totals
   stale. Fixed.
9. The claims form hard-coded ×100 minor-unit conversion (wrong for 3-decimal
   currencies). Fixed with the currency-exponent helper.
10. The approvals inbox deep-linked every non-PO subject to material requests.
    Fixed with a per-subject map (no link rather than a wrong link).

## Evidence

- **Migrations:** `0094`–`0099` (six), applied to the test project via the
  guarded test runner; production untouched at the time of writing.
- **Tests:** unit suite 1,399 passing (incl. release-gate law, nav matrix,
  registry parity, export catalogue honesty); H23 integration suites:
  h23a (16), h23b (5), h23c (15), h23de (16 — incl. two-user concurrent
  finalize with exactly one winner), h23f (8), h23h (4); two-org bleed harness
  covering all 44 new tables; approvals/S4/S5 regression suites green.
- **UI verification (test project, real browser):** owner and employee logins;
  EN + AR with correct RTL; 375 px mobile; leave request submitted through the
  real form (Arabic reason intact in the database); payslip/register/letters
  returned HTTP 200 `application/pdf` with `%PDF` bytes in both languages;
  foreman denied /payroll (404, zero data in the response body).
- **Fixtures:** the browse fixture was marker-tagged and fully wiped
  (`h23-ui-fixture.ts --wipe` — 1 org, 2 users removed).

## Production deployment status

**DEPLOYED AND LIVE — 2026-09-01.**

- CI green on the exact commit `c37ef70` (quality + fresh-stack integration
  including all H23 suites + e2e). Two earlier CI failures were real and were
  fixed first: prettier formatting; DELETE grants on two H23 tables (D-1.7 —
  recalculation now goes through a guarded SECURITY DEFINER wipe); btree_gist
  installed into public (moved to the extensions schema); and a dollar-quote
  delimiter mangled by an automated edit.
- Pre-flight: HEALTHY, no new auth residue. The protected dry-run listed
  exactly the six H23 migrations; they were applied through the guarded
  production runner only (93 → 99). Post-verify: 0 tables without RLS, only
  the allow-listed `org_holiday_calendar` DELETE grant, btree_gist in the
  extensions schema, 12 HR entitlement rows (3 keys × 4 plans), business
  counts unchanged.
- `main` fast-forwarded to `c37ef70`; Vercel deployed it (the health endpoint
  confirmed the hash) with `FEATURE_HR_SURFACES` still unset.
- Production smoke (marked fixture, removed in `finally`): **ALL 15 CHECKS
  PASSED** — compensation projection, leave applied exactly once, mileage
  pricing, deterministic calculation, concurrent double-finalize with exactly
  one winner, claim latched + second settlement refused, payslip immutable to
  the table owner, deployed payslip PDFs EN (23,335 B) and AR (24,110 B) as
  real 200/application/pdf/%PDF responses fetched by the signed-in employee,
  self-service salary certificate PDF, and the release gate hiding every HR
  screen. Zero residue; historical counts identical before and after.
- `FEATURE_HR_SURFACES=1` was then set in the Vercel production environment
  (the CLI was authenticated as the owner, so this did not block) and the same
  code redeployed. Post-enable verification with a second marked fixture:
  /leave, /my-pay and /claims render live, the navigation shows the
  people-group items, cleanup residue 0.

**H23 is live in production.** The exact production application commit is
`c37ef706631466377e63caca209fd0192640eed4` (any later commits on `main` are
docs/tooling only).

## Known blockers carried forward (NOT part of H23)

- **PO-002 (Najolatech, pre-launch H22 blocker):** two receipts with zero stock
  movements; documented in `docs/H22-BLOCKER-PO002.md`; deliberately untouched.
- Production upload scanning stays image-only until `SCAN_PROVIDER` is set.
- Notification email fan-out remains unwired (in-app only), and there is no
  background worker — every H23 reminder is computed on read by design.
