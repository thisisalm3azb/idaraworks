# Pilot Launch-Criteria Checklist

**Doc 06 of the pilot-readiness set. Owning slice: S11 (Pilot Readiness).**

This is the **walkable** launch-criteria checklist that satisfies the S11 Definition of Done in
`phase2/11-mvp-delivery-plan.md` §S11: *“launch-criteria checklist walked and signed … every launch
criterion checked by name.”* It is not a summary — it is a ceremony. Two people sit down, read each
criterion aloud, open its named evidence artifact in the repo (or the drill log), and mark the box.
Nothing is “assumed green.” A criterion with no artifact open in front of you is **not** checked.

**When to walk it:** immediately before the P2 pilot phase opens — after S11 regression + the two-org
pilot simulation are green, and after the owner-action items below have their evidence filed. Re-walk it
if any launch-blocking criterion regresses.

---

## How to read a row

Each criterion is a checkbox with three fields:

- **Evidence source** — the exact repo artifact, script, or drill log that proves it. Open it.
- **Verdict code** — from `phase2/10-security-tenancy-checklist.md`: `CI` (automated gate), `CI-mig`
  (migration gate), `REV` (review-checklist item), `DRILL` (scheduled exercise with written evidence),
  `PEN` (external pen-test scope). Tells you *how* it is proven.
- **State** — one of:
  - **GREEN** — shipped and provable from a repo artifact today (code + test + a completion report).
  - **[OWNER ACTION]** — the mechanism is built and green, but the *evidence* requires an owner to
    provision a credential, book a vendor, or run the first live drill. Blocks sign-off until filed.
  - **PENDING** — a scheduled activity of the pilot kickoff itself (e.g. the owner answering the
    thirteen questions live on seeded data). Executed *at* the walk, not before it.

**Sign-off rule (from §S11 DoD):** every GREEN box open-and-verified; every [OWNER ACTION] box has its
evidence filed **or** a dated, owner-approved waiver recorded in §H; every PENDING box executed live and
checked during the walk. **Pen-test criticals = 0 is a hard gate — no waiver.**

---

## Scoreboard (fill during the walk)

| Section | Criteria | GREEN today | Needs owner/live |
| --- | --- | --- | --- |
| A — v2 §12 launch criteria | 6 | 3 | 3 |
| B — Thirteen-questions live pass | 13 (+1 gate) | gate GREEN | live PENDING |
| C — Template-#1 parity | 1 | 1 | 0 |
| D — Restore-drill RPO/RTO | 4 | procedure GREEN | first drill [OWNER] |
| E — doc-10 DRILL/REV green-state | ~19 named | most GREEN | drills + DPA |
| F — Pen-test criticals = 0 | 1 | — | [OWNER] hard gate |
| G — Regression + build gates | 8 | 8 | — |

---

## Section A — v2 §12 launch criteria + success-metric readiness

Source: `OPERATIONS_FIRST_FOUNDATION_REPORT.md` (v2) §12 (“MVP definition”) and §5 (“Product
positioning — the owner’s-question test”). §12 restates the v1 launch criteria and **adds**: *“owner
answers the thirteen questions live from Today in front of us.”* The §12 *success metrics* (time-to-
first-report, weekly-active field users, conversion, retention, the three operations-first metrics) are
**pilot-phase outcomes**, not pre-pilot gates — their targets and measurement live in
`docs/pilot/07-pilot-success-exit-criteria.md`. What Section A gates is that the product is *ready to be
measured against them.*

- [ ] **A1 — The full operational loop runs end-to-end for one company.** Plan → Assign → Report →
  Supply → Measure → Approve → Bill → Improve, on RLS, in Arabic, on a phone.
  *Evidence:* `tooling/scripts/s11-pilot-sim.ts` asserts “full operational + money loop runs for both
  orgs”; the S6 full-loop demo (`docs/S6-BILL-COMPLETION.md`). *Verdict:* CI. *State:* **GREEN.**
- [ ] **A2 — Role-specific Today screens are the landing surface for all five roles** (owner, manager,
  foreman, procurement, accounts).
  *Evidence:* `src/modules/today/service.ts` composer + per-role screens; `docs/S5-*`/S6 completion.
  *Verdict:* CI. *State:* **GREEN.**
- [ ] **A3 — Approvals inbox is a first-class top-level surface** with fixed threshold rules and the
  self-approval guard.
  *Evidence:* `src/modules/approvals/service.ts`; S4 completion. *Verdict:* CI. *State:* **GREEN.**
- [ ] **A4 — Arabic + English, RTL, mobile-first — zero open sev-1 language issues.** AI review pass
  complete; **human native-reviewer sign-off is an owner action** (`phase2/11` §S10 F-50).
  *Evidence:* `docs/S10-HARDENING-COMPLETION.md` (i18n/a11y area, Arabic sev-1 fixes; locale switcher
  wired); `phase2/10` #the i18n audit lens in `docs/S10-AUDIT-REGISTER.md`. *Verdict:* REV. *State:*
  **[OWNER ACTION]** — Arabic native reviewer confirms sev-1 = 0 across surfaces before sign-off.
- [ ] **A5 — Uninstallable-trust / full export works for every tier** (portability is a launch
  criterion, v1 P10 · §12).
  *Evidence:* `/api/o/[orgId]/export` (`src/app/api/o/[orgId]/export/route.ts`), paged +
  redaction-aware + formula-injection-safe (`csvEscape`); export column-probe 8/8;
  `docs/S10-HARDENING-COMPLETION.md` (doc-10 #42/#25). *Verdict:* CI. *State:* **GREEN.**
- [ ] **A6 — The added §12 criterion: the owner answers the thirteen questions live from Today, on
  seeded pilot-like data, unprompted, in front of us.**
  *Evidence:* executed during the walk — see Section B for the per-question checklist. The CI gate
  (Section B) is GREEN; the *live* pass is done here. *Verdict:* the S7 gate. *State:* **PENDING**
  (execute live at the walk).

---

## Section B — The thirteen-questions live pass (S7)

Source: v2 §5 (the owner’s-question test) mapped to data in `src/modules/digest/service.ts` (each digest
section is annotated with the question numbers it answers) and the owner Today screen. The **CI gate**
asserts each question’s mapped card against a golden fixture dataset; the S7 production DoD demo scored
**13/13** answered from the deterministic digest (`docs/S7-IMPROVE-COMPLETION.md`,
`tooling/scripts/s7-prod-demo.ts`). The digest/Today are deterministic analytics — they do **not**
depend on the (owner-gated, disabled-in-prod) AI narration seam, so this gate holds with zero AI
credentials.

**Gate row:**

- [ ] **B0 — CI thirteen-questions gate green (13/13).**
  *Evidence:* `docs/S7-IMPROVE-COMPLETION.md` (“thirteen-questions gate: 13/13”); the S7 golden-fixture
  CI assertion. *Verdict:* CI. *State:* **GREEN.**

**Live pass — walk each one, owner reads the answer off Today/the digest (State: PENDING until walked):**

- [ ] **Q1 — What is happening today?** → Today “this week / active jobs” card (digest § “this week”,
  `service.ts` Q1/Q5).
- [ ] **Q2 — What is behind schedule?** → owner-audience risk exceptions (Q2/Q4/Q10).
- [ ] **Q3 — What needs my approval?** → pending-approvals card (Q3/Q13).
- [ ] **Q4 — Which job is at risk?** → at-risk jobs (late stages, margin drift, missing reports) (Q2/Q4).
- [ ] **Q5 — What materials are missing?** → approved MRs awaiting conversion / missing-items signal (Q5).
- [ ] **Q6 — What purchases are delayed?** → supply-lateness / late-supplier (E-06) card (Q6).
- [ ] **Q7 — Who is working on what?** → distinct report submitters / crew activity (Q7).
- [ ] **Q8 — What issues block progress?** → open blockers (`is_blocker` issues) surfaced on Today (Q8).
- [ ] **Q9 — What was finished yesterday?** → yesterday’s reports summary + completions (Q9).
- [ ] **Q10 — What is this job costing?** → live job costing / margin (privileged) (Q10).
- [ ] **Q11 — Which customers await an update?** → active jobs at a billing milestone with no update sent (Q11).
- [ ] **Q12 — Which invoices are overdue?** → collections: overdue invoice count + AR outstanding (Q12).
- [ ] **Q13 — What should I decide now?** → needs-my-decision (approvals + flagged risk) (Q3/Q13).

> Freshness discipline (v2 §13 R19): every card shows **data age**; “no report from Hull 24C-003 since
> Tuesday” is itself an at-risk answer, displayed, never hidden. During the walk, confirm stale cards
> read as signals, not as blanks.

---

## Section C — Template-#1 parity test (S8)

Source: `phase2/11` §S8 DoD (“reproduce a real historical boat, costing within rounding of legacy
`boatFinance()`”) and the doc-08 costing gate.

- [ ] **C1 — The AI-onboarded template-#1 configuration reproduces the S5 costing golden to the minor
  unit.** A cold org onboarded through the Layer-A pipeline, then a real first job costed, matches the
  hand-computed / legacy figures.
  *Evidence:* `docs/S8-ONBOARDING-COMPLETION.md` production DoD demo — **“PARITY: ex-labour = 290000,
  total = 395000 → MATCH”**; `tooling/scripts/s8-prod-demo.ts`; the S5 costing golden fixtures
  (`docs/S5-*`). *Verdict:* CI. *State:* **GREEN.**

---

## Section D — Restore-drill evidence: RPO ≤ 1h / RTO ≤ 4h (S10)

Source: `runbooks/restore-drill.md` (full executable procedure, DB **and** storage → plain Postgres 17 +
plain S3; doubles as the vendor-exit rehearsal) and `phase2/10` #47/#48. The recovery objectives are
published internally: **RPO ≤ 1 hour, RTO ≤ 4 hours.** The **first drill must run before pilot start.**

- [ ] **D1 — Restore-drill procedure exists and is executable** (DB dump/restore with role bootstrap +
  storage S3→S3 sync + verification queries + measured-evidence tables).
  *Evidence:* `runbooks/restore-drill.md`. *Verdict:* DRILL (procedure). *State:* **GREEN.**
- [ ] **D2 — First live drill executed; DB verification all-pass** (per-org counts match source; RLS
  policy count = reference; RLS enabled on the 6 sensitive tables; `app_user` NOBYPASSRLS + narrow
  DELETE allowlist only; migration ledger complete).
  *Evidence:* the completed §1f table + §4 drill log in `runbooks/restore-drill.md`. *Verdict:* DRILL.
  *State:* **[OWNER ACTION]** — requires owner to confirm PITR add-on active + supply the nightly backup
  location + `STORAGE_S3_*` + a throwaway S3 target (runbook §0 OWNER ACTIONS 1–4).
- [ ] **D3 — First live drill; storage verification all-pass** (object counts source=target; per-org
  bytes reconcile to `org_storage_usage`; 30 sampled image-variant objects present at expected size).
  *Evidence:* the completed §2d table in `runbooks/restore-drill.md`. *Verdict:* DRILL. *State:*
  **[OWNER ACTION]** — same credentials as D2.
- [ ] **D4 — Measured RPO ≤ 1h and RTO ≤ 4h, filed in the drill log.** If PITR is not active at drill
  time, RPO is bounded by the nightly cadence — record that as a finding, not a pass.
  *Evidence:* `runbooks/restore-drill.md` §3 evidence table + §4 log row (operator + witness co-sign).
  *Verdict:* DRILL. *State:* **[OWNER ACTION].**

---

## Section E — doc-10 DRILL/REV items at pre-launch green-state

Source: `phase2/10-security-tenancy-checklist.md` (items 1–51; verdict codes DRILL/REV). The full green-
state verification list is ~41 items (S11 scope D); the code-shipped `CI`/`CI-mig` items are proven by
the Section G gates and `docs/S10-HARDENING-COMPLETION.md` / `docs/S10-AUDIT-REGISTER.md`. Named here are
the **DRILL** and **REV** items that require a human to execute or review — these are the ones the walk
must check by name.

**REV items (review-checklist — confirm the shipped state):**

- [ ] **E1 (#3) — No service-layer query path accepts an unscoped table handle; repo fns require tenant
  ctx as arg 1.** *Evidence:* boundary/raw-client lint in CI; `phase2/10` #3. *Verdict:* CI+REV.
  *State:* **GREEN.**
- [ ] **E2 (#10) — Search/list queries tenant-filtered at the repository layer.** *Evidence:* tenancy
  lint + bleed harness 17/17. *Verdict:* REV. *State:* **GREEN.**
- [ ] **E3 (#13) — AI layer: Layer-A context = intake+templates only; Layer-B payloads are closed
  structured docs; no cross-tenant retrieval; every AI interaction logged with org.** *Evidence:*
  `src/platform/ai/*`, `ai_interaction` metering; S7/S8 completion. *Verdict:* CI+REV. *State:* **GREEN.**
- [ ] **E4 (#17) — Cost redaction at every serialization boundary** (Today, costing reads, approval
  inbox, push bodies, digest, exports, file classes); labour side-tables privileged at RLS.
  *Evidence:* S10 tightened this to **per-subject-type** redaction; `docs/S10-HARDENING-COMPLETION.md`
  (redaction walls); redaction-lens findings in `docs/S10-AUDIT-REGISTER.md`. *Verdict:* CI+PEN.
  *State:* **GREEN.**
- [ ] **E5 (#29) — TOTP MFA available, org-enforceable, admin MFA-reset audited.** *Evidence:*
  `src/app/(auth)/*`; S0/S9. *Verdict:* CI+REV. *State:* **GREEN.**
- [ ] **E6 (#34) — Audit rows append-only, not editable by org owners** (no UPDATE/DELETE grants).
  *Evidence:* migration grants; tenancy audit lens. *Verdict:* CI-mig+REV. *State:* **GREEN.**
- [ ] **E7 (#36) — Retention policies per doc-01 App-B** (notifications/exceptions/AI/digests pruned;
  **financial-mutation audit rows ≥ 6 years regardless of tier**; `audit_log`/`activity`/`domain_event`
  floors respected). *Evidence:* migration `0064` `prune_retention` + `retentionPruneCron`;
  `docs/S10-HARDENING-COMPLETION.md`. *Verdict:* CI+REV. *State:* **GREEN** (cron dormant until Inngest
  keys — [OWNER ACTION] to activate; the DEFINER runs on demand meanwhile).
- [ ] **E8 (#43) — PDPL posture recorded; KSA lawful-transfer basis documented in the DPA before any
  KSA pilot holding visa/ID documents; PII inventory.** *Evidence:* the DPA/PDPL posture doc.
  *Verdict:* REV before pilot. *State:* **[OWNER ACTION]** — DPA + KSA lawful-transfer basis authored
  before a KSA pilot onboards ID documents.
- [ ] **E9 (#45) — Break-glass: two-party approval, DIRECT_URL-only access, post-hoc tenant
  notification — as a runbook.** *Evidence:* `runbooks/break-glass.md`. *Verdict:* REV. *State:*
  **GREEN.**
- [ ] **E10 (#51) — Dependency + secret scanning in CI; review required on money-path and authz diffs.**
  *Evidence:* `ci.yml` gitleaks secret scan + `pnpm audit --prod --audit-level high`; `phase2/10` #51.
  (The external pen test half of #51 is Section F.) *Verdict:* CI+REV. *State:* **GREEN.**

**DRILL items (scheduled exercises — execute and file evidence):**

- [ ] **E11 (#37) — Secret-rotation runbook + quarterly rotation drill.** *Evidence:*
  `runbooks/secret-rotation.md`; drill-log entry. *Verdict:* DRILL. *State:* **GREEN** (runbook);
  first rotation drill is an owner/operator execution before pilot.
- [ ] **E12 (#40) — Recycle-bin (30d drafts) + account-closure export-first purge; closure enumerates
  and verifies storage-object deletion — walkthrough before the first paying customer.** *Evidence:*
  the closure runbook path (`docs/S10-HARDENING-COMPLETION.md` notes closure runbook + storage-object
  deletion; unvoid-UI deferred with the 30-day window + legal hold live). *Verdict:* REV+DRILL. *State:*
  **[OWNER ACTION]** — walkthrough executed and logged before month-2 conversion (first paying customer).
- [ ] **E13 (#44) — Zero standing staff access; consent-gated, time-boxed impersonation with persistent
  banner, dual-logged — staff-access drill.** *Evidence:* `src/modules/support/service.ts`;
  `tooling/scripts/s11-pilot-sim.ts` asserts an impersonation session is visible in the **tenant’s own**
  audit log and dual-logged. *Verdict:* CI+DRILL. *State:* **GREEN** (code + sim); the live staff-access
  drill is executed and logged at the walk.
- [ ] **E14 (#47/#48) — Restore drill + published RPO/RTO.** Cross-reference Section D. *Verdict:*
  DRILL. *State:* **[OWNER ACTION].**
- [ ] **E15 (#50) — Incident-response runbook (detect → contain → per-tenant scope → notify →
  post-mortem), tabletop tested before launch.** *Evidence:* `runbooks/incident-response.md`; tabletop
  evidence entry. *Verdict:* DRILL. *State:* **GREEN** (runbook); tabletop executed and logged before
  launch.
- [ ] **E16 (#46) — Backup monitors verified** (PITR, nightly logical backup, bucket replication +
  manifest). *Evidence:* `runbooks/backup-monitoring.md`; the automated backup-status monitor is a seam
  (`docs/S10-AUDIT-REGISTER.md` line 17 — code not built; owner confirms manually until then). *Verdict:*
  DRILL/CI. *State:* **[OWNER ACTION]** — owner confirms PITR active + nightly backup readable +
  second-provider replication (credential-gated).

> Remaining doc-10 items with `CI`/`CI-mig`/`PEN` codes (RLS wall #1–2, IDOR sweep #5, storage class-map
> #7, unbounded-list pagination #12, share-surface tokens #14, offline replay re-auth #20, upload
> validation/malware seam #27, session mgmt #30, trial-abuse controls #32, legal hold #41, self-service
> export #42, CSV formula guard #25, egress cache #13, quota metering #2) are proven GREEN by the
> Section G gates + `docs/S10-AUDIT-REGISTER.md` + `docs/S10-HARDENING-COMPLETION.md`. Confirm the audit
> register shows no open MATERIAL before signing E.

---

## Section F — Pen-test criticals = 0 (OWNER, hard gate)

Source: `phase2/11` §S11 DoD (**“pen-test criticals = 0”**) and `phase2/10` #51 (external pen test before
public launch, scope = items 1–14, 15–22, 27, 30; **booked by S6** for lead time).

- [ ] **F1 — External penetration test booked.** Booking was due at S6 and is an escalated owner action
  (`docs/S10-HARDENING-COMPLETION.md` owner actions). *Verdict:* PEN. *State:* **[OWNER ACTION].**
- [ ] **F2 — Pen-test executed against the frozen scope** (tenancy isolation, IDOR, storage access
  classes, share surface, auth/session, upload validation). *Evidence:* the pen-test report. *Verdict:*
  PEN. *State:* **[OWNER ACTION].**
- [ ] **F3 — Criticals = 0. HARD GATE — no waiver.** Mediums get dated fix commitments; **any
  unresolved critical blocks the pilot.** *Evidence:* pen-test report criticals count + remediation
  log. *Verdict:* PEN. *State:* **[OWNER ACTION].**

---

## Section G — Regression + build gates (S0–S11)

Source: `phase2/11` §S11 (“full regression — money, tenancy, offline, RTL suites”) and `.github/
workflows/ci.yml`. These are automated and must be green on the deployed commit.

- [ ] **G1 — Format + lint (boundaries, tenancy tripwires, banned domain nouns) = 0 errors.** *Evidence:*
  `ci.yml` “Format check” + “Lint”; `pnpm format:check`, `pnpm lint`. *State:* **GREEN.**
- [ ] **G2 — Typecheck clean.** *Evidence:* `ci.yml` “Typecheck”; `pnpm typecheck`. *State:* **GREEN.**
- [ ] **G3 — Unit suite green (312/312 at S10 close).** *Evidence:* `ci.yml` “Unit tests”; `pnpm test`;
  `docs/S10-HARDENING-COMPLETION.md` gates. *State:* **GREEN.**
- [ ] **G4 — Build passes; dependency audit (high+) clean; gitleaks secret scan clean.** *Evidence:*
  `ci.yml` “Build” / “Dependency audit” / “Secret scan”. *State:* **GREEN.**
- [ ] **G5 — Hosted integration: tenancy + bleed 17/17, s8 5/5, events-outbox 10/10, export
  column-probe 8/8.** *Evidence:* `ci.yml` integration job (`pnpm test:integration`);
  `docs/S10-HARDENING-COMPLETION.md`. *State:* **GREEN.**
- [ ] **G6 — E2E + offline/RTL suites green.** *Evidence:* `ci.yml` “E2E smoke” (`pnpm test:e2e`,
  Playwright); the S3 airplane-mode outbox test. *State:* **GREEN.**
- [ ] **G7 — Perf budgets enforced at synthetic volume** (report submit < 10s, nightly < 5min enforced;
  Today/costing p95 reported; the tight per-request p95 validated on a co-located `PERF_COLOCATED=1`
  run — an owner/pilot-time check). *Evidence:* `ci.yml` “Perf budgets” (`pnpm perf`,
  `tooling/scripts/s5-perf-harness.ts`); `docs/S10-HARDENING-COMPLETION.md` “CI perf gate note.”
  *State:* **GREEN** (CI budgets); full-volume p95 is an [OWNER ACTION] co-located run.
- [ ] **G8 — Two-org synthetic pilot simulation passes** (tenant isolation, financial/labour redaction,
  full loop + money, subscription read-only states, consent-gated support impersonation tenant-audited,
  self-service export + money-wall, AI/provider disabled seams — self-cleaning, never touches Alpha
  Marine / TESTING). *Evidence:* `tooling/scripts/s11-pilot-sim.ts`. *State:* **GREEN.**
- [ ] **G9 — Production smoke 18/18 at the deployed commit** (routing, auth gate, health dependencies,
  readiness, inngest status, security headers; `EXPECTED_COMMIT` match). *Evidence:*
  `tooling/scripts/smoke-prod.ts` (`pnpm smoke:prod`) against `https://idaraworks.vercel.app`; `/api/
  health`. *State:* **GREEN.**

---

## Section H — Sign-off

The walk is complete when: every GREEN box was opened and verified; every [OWNER ACTION] box has filed
evidence **or** a dated owner-approved waiver recorded below; every PENDING box (Section A6, all of
Section B’s live pass) was executed live; and **F3 (pen-test criticals = 0) is satisfied with no
waiver.** On sign-off, the P2 pilot phase opens.

| Field | Value |
| --- | --- |
| Walk date (UTC) | _____ |
| Deployed commit walked | _____ |
| Owner / signer | _____ |
| Operator (evidence driver) | _____ |
| Witness | _____ |
| GREEN verified | ___ / ___ |
| [OWNER ACTION] evidence filed | ___ / ___ |
| PENDING executed live | ___ / ___ |
| **Pen-test criticals** | **___ (MUST be 0)** |
| Result | GO / NO-GO |

**Recorded waivers (dated, owner-approved; never for F3):**

| # | Criterion | Reason | Owner approval | Date | Follow-up commitment |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

**Consolidated owner-action dependencies for this walk** (see the final owner-action checklist,
`docs/pilot/` consolidated doc): pen-test booking + execution (F); Arabic native reviewer (A4); first
restore drill + PITR/backup/S3 credentials (D, E14, E16); DPA/PDPL + KSA lawful-transfer basis (E8);
incident tabletop + secret-rotation + closure walkthrough execution (E11/E12/E15); Inngest keys to
activate the retention/lifecycle/nightly crons (E7); plus the carried commercial set (D1 merchant/entity,
D3 pricing + tier limits, tax mechanism, provider/Sentry/Upstash credentials, PDF runtime, password
rotation, delete junk Vercel projects) which gate real billing but not the operational pilot.

---

*Traceability:* this checklist is the artifact named in `phase2/11-mvp-delivery-plan.md` §S11 DoD and
composes v2 §12 (`OPERATIONS_FIRST_FOUNDATION_REPORT.md`), the S7 thirteen-questions gate
(`docs/S7-IMPROVE-COMPLETION.md`), the S8 template-#1 parity gate (`docs/S8-ONBOARDING-COMPLETION.md`),
the S10 restore drill (`runbooks/restore-drill.md`) + hardening evidence
(`docs/S10-HARDENING-COMPLETION.md`, `docs/S10-AUDIT-REGISTER.md`), and the doc-10 launch checklist
(`phase2/10-security-tenancy-checklist.md`). Pilot success/exit criteria live in the companion doc
`docs/pilot/07-pilot-success-exit-criteria.md`.
