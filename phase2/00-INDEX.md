# IdaraWorks — Phase 2 Architecture & Planning Package

**Status:** Phase 2 deliverable · July 2026 · No production code, no migrations — specification only.
**Audit status:** ✅ **Audited (`12-AUDIT.md`) — CONDITIONAL GO accepted by owner; all §2–§7 amendments APPLIED to docs 00–11.** The package is now internally consistent with the audit.
**Freeze status:** 🧊 **ARCHITECTURE & MVP SCOPE FROZEN** — see `13-ARCHITECTURE-FREEZE.md`. Changes to frozen decisions require one of three justifications: a verified security issue, a proven scalability/reliability issue, or evidence from real pilot customers.
**Engineering constitution:** `../BUILD_BIBLE.md` governs all implementation. Doc 11 is the engineering implementation plan.
**Parent documents:** `../OPERATIONS_FIRST_FOUNDATION_REPORT.md` (v2, master) and `../FOUNDATION_REPORT.md` (v1, carried-forward foundations).
**Design law for every document here:** the **job and its operational event stream are the centre of the system**. Any page of this package that reads like an ERP module, a departmental suite, a no-code builder, or a generic workflow platform is wrong and must be revised.

## Documents (read in order)

| # | Document | Deliverable |
|---|---|---|
| 01 | `01-domain-model.md` | Domain model, ERD, Najolatech gap analysis, semantic anchors, costing spine |
| 02 | `02-container-contract.md` | The WorkContainer contract — the one abstraction built ahead of need |
| 03 | `03-today-screens.md` | Role-specific Today screen specifications (5 roles) |
| 04 | `04-exception-analytics-engine.md` | Deterministic exception rules (E-catalogue), digest assembly, AI narration seam |
| 05 | `05-approvals-model.md` | Unified approvals: registry, rules, inbox, states, audit |
| 06 | `06-permissions-matrix.md` | Role archetypes × capabilities × actions; condition types; field-seat definition |
| 07 | `07-terminology-system.md` | Terminology resolution (template → org → language), key catalogue, coverage tooling |
| 08 | `08-template-boatbuilding.md` | Template #1: Boat Building & Marine Fabrication — full specification |
| 09 | `09-entitlements-config-schemas.md` | Entitlement catalogue v1 + configuration JSON-schema outlines |
| 10 | `10-security-tenancy-checklist.md` | Numbered, testable security & multi-tenancy checklist with CI wiring |
| 11 | `11-mvp-delivery-plan.md` | **Engineering implementation plan** — vertical slices with objectives, deliverables, dependencies, DB/API/UI work, testing, DoD, effort, risks |
| 12 | `12-AUDIT.md` | Final cross-document audit: contradiction register, findings F-1…F-56, pre-build decisions, verdict |
| 13 | `13-ARCHITECTURE-FREEZE.md` | Frozen decisions, intentionally-open decisions, change-control rule |

Each document uses a uniform **Decision block** for major decisions:

> **D-x.y — <decision>** · Why · Alternatives rejected · Risks · Validate in pilots

---

## Unresolved decisions & contradictions — flagged before proceeding

Per instruction, these are surfaced first. **None blocks the package**; each is either resolved here (with the resolution recorded) or explicitly parked with its blast radius stated.

### Resolved in this package (owner may veto before build starts)

| ID | Item | Resolution taken |
|---|---|---|
| U1 | **D11 — canonical object name.** v2 §8.4 left `job` as a "strong default." | **Adopted: `job`.** The domain model (doc 01) is written with it. Veto window closes when S0 of the delivery plan starts — renaming later is a schema-wide migration. |
| U2 | **Field-seat definition** (v1 Q9) was open. | **Defined in doc 06:** one MVP field archetype — *Foreman* (reports, tasks, issues, MRs on assigned jobs; never costs), a free/cheap seat (pending D3 numbers). The *Worker* archetype was **cut from the MVP build by audit F-17** (enum slot reserved for P3). |
| U3 | **Attendance contradiction.** v1 said "attendance-lite via check-in *or* daily reports"; v2 nav lists "attendance" under People; MVP scope was ambiguous. | **Resolved (doc 01/08):** in MVP, **daily-report labour lines ARE attendance** — one write, three reads (attendance register, labour cost, progress evidence). A standalone check-in flow is deferred to P3 and only if pilots show labour lines under-capture presence (e.g., office staff). Operations-first principle applied: capture reality once, where it happens. |
| U4 | **Najolatech's 7 roles vs MVP capability set.** The proven matrix includes an *Inventory* role, but Inventory capability is P3. | **Resolved (docs 06/08):** template #1 ships 7 role presets for continuity; the *Inventory* preset exists but maps to Procurement-scoped permissions until the Inventory capability unlocks at P3 (preset carries forward automatically). |
| U5 | **Approval scope ambiguity** — v2 mentions quotes, MRs, expenses, overrides, stage sign-offs in different places. | **Resolved per audit C-1/F-3 (doc 05 is source of truth):** MVP approvable registry = `material_request`, `expense`, `quote_send`, `purchase_order` (MR-less or over-threshold POs only), `payment_receipt` (template-optional, default **off** pending PB-8). `invoice_issue` is **out of the enum** for MVP. `stage_signoff` and `qc_override` enter with QC at P3. |
| U7 | **Progress model ambiguity** — stage weights (Najolatech, proven) vs task-completion-informed progress (v2 §10 wording). | **Resolved (doc 01):** weighted stages are the progress math (in_progress = 0.5, completed/skipped = 1, auditable override wins); tasks inform humans, not the formula. Revisit only if a non-boatbuilding pilot finds stage grain too coarse. |
| U6 | **Threshold currency.** Approval thresholds and exception thresholds need units; org currency is single in MVP but differs across tenants. | **Resolved (docs 05/08/09):** all thresholds are stored in **org currency minor units**, set during onboarding (AI proposes values scaled from template defaults + intake answers); templates carry *default magnitudes with a currency-scaling hint*, never hard currency amounts. |

### Parked — do not block architecture; block later steps as stated

| ID | Item | Blast radius | Must close by |
|---|---|---|---|
| P1 | **D1 — incorporation & merchant of record** | Blocks Stripe wiring (slice S9) and DPA/data-residency final choice; does NOT block any schema or capability design | Before S9 (billing) — realistically during P1 build |
| P2 | **D3 — pricing numbers** | Doc 09 uses *tier hypotheses* (Starter/Growth/Business) with placeholder limits; entitlement *keys* are final, *values* are not | Before pilot invoicing (P2) |
| P3 | **D4 — e-invoicing partner** | Doc 01 defines the invoice entity with a provider-agnostic compliance seam (`einvoice_submission` satellite); partner choice fills in the adapter | Before S6 (invoicing slice) |
| P4 | **D2′ — name check (IdaraWorks)** | Cosmetic to this package; blocks pilot-facing branding | Before pilot recruitment |
| P5 | **D14 — digest channel (WhatsApp?)** | Doc 04 specs in-app + push + email digest; WhatsApp is an adapter decision later | Pilot behaviour data |
| P6 | **Najolatech migration path (D6)** | Doc 01's gap analysis informs it; the actual migration plan is a P2/P3 task, not in this package | Before Najolatech goes live as tenant #1 |

### Contradictions checked and found benign

- **"Customer progress" MVP status:** v2 §10 marks it 🔸 and §14 lists AI drafts in MVP — consistent: MVP = AI-drafted, human-sent progress summaries; no client portal. Docs 03/04 spec accordingly.
- **Timesheets:** v2 marks timesheets "🔸 via daily-report labour lines" — same resolution as U3; no separate timesheet entity in MVP (doc 01).
- **"Dashboards" language:** v1 promised curated role dashboards; v2 replaces them with Today screens. Doc 03 is the successor spec; the word "dashboard" survives only in the Reports area for job/company report views.
- **QC in the loop table** (v2 §7 marks Inspect ⬜) vs stage progress in MVP: stage completion in MVP is manager-asserted without QC gates; the QC gate strengthens the same transition at P3 rather than changing it — designed for in doc 01 (stage status transitions carry an optional guard slot).

---

## Package-wide constants (so documents don't re-litigate them)

- Stack & guardrails: v1 §9–10 (Next.js + Supabase + Vercel; modular monolith; server-side data access only; RLS second wall; one schema for all tenants).
- Tenancy: v1 §11 five-layer model; every entity in doc 01 is org-scoped unless explicitly platform-level.
- IDs: UUIDv7 everywhere; human references (job numbers, invoice numbers) are separate, per-org, template-patterned strings.
- Money: integer minor units, org currency, no multi-currency documents in MVP (doc 01 D-1.3).
- Languages: `en` + `ar` from day one; all times stored UTC, displayed in org timezone. **Working week is an onboarding question with country-aware defaults** (UAE: Mon–Fri weekend Sat–Sun; KSA: Sun–Thu weekend Fri–Sat; 6-day workshop weeks offered as a template hint) — audit C-4 corrected the earlier Sat–Thu error. Org holiday calendar (template-seeded per country, incl. Eid) + Ramadan working-hours profile feed all working-day math (audit F-41).
- Naming: `job` (U1); background execution infrastructure is called the *task-queue/worker*, never "jobs," to avoid collision.
