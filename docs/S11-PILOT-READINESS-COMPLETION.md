# S11 — Pilot Readiness — Completion Report

**Status:** COMPLETE — external-validation + documentation + simulation slice. No new product features.
S11 code + the full S0–S11 regression are **CI-green at `562db75`** (prod-smoke-verified); this report
finalization lands in a trailing docs commit (re-verified CI + deploy). Production baseline =
[Alpha Marine, TESTING]. Opens the P2 pilot phase (subject to the owner completing the external/legal
items in the owner-action checklist).

## What shipped

**Two-org synthetic pilot simulation** (`tooling/scripts/s11-pilot-sim.ts`, Arabic, self-cleaning) —
two isolated orgs **قوارب الخليج** (AE/AED) + **مراكب الشرق** (SA/SAR), each driven through the full
operational→money loop, then cross-checked. **11/11 assertions PASS · 0 leftovers · Alpha Marine +
TESTING untouched:** (1) full operational+money loop for both orgs; (2) tenant isolation — org A's ctx
reads 0 of org B's job (RLS second wall); (3) redaction — privileged costing exposes total, a
non-cost/-price ctx gets labour/total nulled; (4) export shows totals to a privileged reader; (5)
export money-wall — totals redacted for a non-price exporter; (6) subscription trial→active→**suspended**
via the dunning ladder; (7) read-only blocks an ADD (`BillingReadOnlyError`, FR-9); (8) read-only never
blocks reads/exports (FR-9); (9) support impersonation session visible in the **tenant's own** view;
(10) impersonation **dual-logged to the tenant's own audit_log**; (11) the provider seam resolves
(fake off-prod, prod default disabled via `isProd`).

**Pilot-readiness documentation (all NEW):**
- **Operational runbooks:** `migration`, `data-cleanup`, `retention`, `legal-hold`, `cancellation`,
  `access-revocation`, `impersonation-history`, `exports`, `credential-disabled-operations`,
  `queue-worker-recovery` — joining the existing S10/Phase-I set (deploy-and-rollback,
  incident-response, restore-drill, backup-monitoring, dead-letter-recovery, secret-rotation,
  break-glass, inngest/sentry-provisioning).
- **Pilot playbook (`docs/pilot/`):** 00 org-setup workflow · 01 onboarding+template checklist ·
  02 roles+invitations · 03 initial imports · 04 approval+reporting config · 05 operational
  billing-readiness · 06 launch-criteria checklist · 07 pilot success/exit criteria · 08 consolidated
  owner-action checklist.
- **Guides (`docs/guides/`):** admin guide · per-role guides · English quick-start · Arabic quick-start.
- **MVP readiness report** (`docs/MVP-READINESS-REPORT.md`): templates included, capability
  classification (production-operational / via-manual-process / credential-gated / D1-gated / deferred),
  owner actions, and the pilot-ready verdict.

## Launch criteria (doc 11 §S11 — walked by name in docs/pilot/06)

- **v2 §12 launch/success metrics** — walked in the checklist.
- **thirteen-questions live pass** (S7 gate) — CI-asserted per question; re-verified.
- **template-#1 parity test** (S8/doc-08 gate) — costing reproduces the Najolatech `boatFinance()`
  golden within rounding; green.
- **restore-drill evidence** (S10, doc 10 #47/#48) — the runbook + RPO≤1h/RTO≤4h evidence template;
  the FIRST live drill is the pre-pilot owner action.
- **doc-10 DRILL/REV items** — green in code; the DRILL executions (restore, incident tabletop,
  staff-access, break-glass, backup verification) are operator/owner runs per their runbooks.
- **pen-test criticals = 0** — OWNER action (external window; booked at S6).

## Regression + gates

The complete S0–S11 standing regression runs in GitHub CI on this commit: money (golden files incl.
Najolatech parity), tenancy (two-org bleed + matrix), offline/idempotency, RTL/i18n, the full hosted
integration suite, e2e, and the perf gate. Local: format · lint 0 · typecheck · unit · build.

## Adversarial review

An independent 2-lens review (pilot-sim rigor · docs accuracy) raised **4 material findings — all
fixed:** (1) the export money-wall assertion only proved the two CSVs *differed* → now asserts every
6+-digit money value in the privileged CSV is **absent** from the non-price export; (2) the costing-
redaction assertion could pass via the app-flag even if the DB wall were removed → now proves the
redaction is *selective* (nulls labour+total, keeps ex-labour material) and notes the DB RLS wall is
separately proven by the tenancy/bleed harness; (3) `legal-hold.md` referenced a non-existent
`app.set_file_legal_hold` → corrected to the real `app.set_legal_hold(file, bool)` with the org-GUC
requirement; (4) `cancellation.md` claimed two purge-warning `dunning_attempt` rows that the
cancellation path never writes → corrected to the real read-only-export-window guarantee. Plus minors
fixed: pilot-sim positive-control for isolation, a meaningful provider-seam check, self-cleanup
registration order, the legal-hold "verify" no longer instructs a live terminal purge, and a
data-cleanup `reconciliation` column correction. Final pilot sim: **11/11 PASS**.

## Owner actions (the pre-pilot checklist)

`docs/pilot/08-owner-action-checklist.md` — consolidated + categorised. Blocking for a controlled
no-payment pilot: pen test (criticals→0), DPA/PDPL for KSA, Arabic native review, the first restore
drill + incident tabletop, Inngest keys (live automation), PITR confirmation. Blocking for real money:
D1, D3 pricing, tax mechanism, e-invoice/payment credentials, PB-3.

## Alpha Marine & TESTING

Never read for deletion or written by the S11 simulation, tests, or docs. The pilot simulation runs on
its own synthetic orgs and self-cleans; post-S11 org baseline = [Alpha Marine, TESTING].
