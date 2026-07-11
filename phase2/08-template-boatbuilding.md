# 08 — Template #1: Boat Building & Marine Fabrication

**Purpose:** the full specification of the launch template, extracted from the Najolatech production system (not from its original spec — the extraction found real drift, and *the running system wins*). This template is simultaneously: the reference config bundle, the AI-onboarding grounding for marine/fabrication intakes (v2 §14 step 2), and the acceptance fixture for the whole config system — if this template can't express Najolatech's operation, the config layer is wrong.

Format: every block below is data conforming to a doc 09 schema. Values shown `en / ar` where terminology applies. *(AR values are working drafts — final Arabic passes native review, R12.)*

---

## Identity & terminology

- Template key `boatbuilding_marine_v1`; object kind `project`.
- Terms: job → **Boat / قارب** (pl. Boats / قوارب, m.) · job_stage → **Production Stage / مرحلة الإنتاج** · daily_report → **Daily Report / التقرير اليومي** · week_plan → **Weekly Plan / الخطة الأسبوعية** · material_request → **Material Request / طلب مواد** · purchase_order → **LPO / أمر شراء** (the house term, carried deliberately) · quote → **Quotation / عرض سعر** · employee → **Worker / عامل** · team → **Team / فريق**.
- Job reference pattern: `{preset_code}-{seq:3}` → `24C-001`, `D46-002` (hull numbers). Serials: LPO/invoice/receipt/contract patterns `{DOC}-{year}-{seq:4}` with **org-set starting numbers** (paper-continuity requirement).

## Stages (weights sum 100 — production-proven values)

| # | Stage (en / ar draft) | Weight | Phase semantic |
|---|---|---|---|
| 1 | Mould Prep / تجهيز القالب | 5 | preparation |
| 2 | Lamination / التصفيح | 16 | production |
| 3 | Below Deck Rigging / تجهيزات تحت السطح | 10 | production |
| 4 | 3-part Assembly / التجميع الثلاثي | 12 | production |
| 5 | Over Deck Assembly / تجميع السطح | 12 | production |
| 6 | Hardware Rigging / تركيب التجهيزات | 10 | production |
| 7 | Electrical Rigging / التمديدات الكهربائية | 10 | production |
| 8 | Upholstery / التنجيد | 7 | production |
| 9 | Finishing & Polishing / التشطيب والتلميع | 10 | finishing |
| 10 | Sea Trial / التجربة البحرية | 4 | verification |
| 11 | Delivery / التسليم | 4 | handover |

Stage statuses: platform semantics used directly (`not_started / in_progress / completed / skipped`). Progress = weighted (doc 01 U7). Skips come from presets (below) — e.g. small skiffs skip Upholstery.

## Job presets (from the 9 BoatModels; each = defaults bundle)

`13ft Skiff (13S)`, `18ft Skiff (18S)`, `21ft Panga GW (21P)`, `24ft Catamaran (24C)`, `27ft Panga GW (27P)`, `34ft Catamaran (34C)`, `35ft EQM (35E)`, `46ft Dustour (D46)`, `20m Catamaran (20M)`. Each preset: code (feeds reference pattern), default skipped stages (e.g. 13S/18S skip Upholstery), default quote template (line items by section, prices maintained from the per-model build sheets — the existing Build-a-Quote pattern), **default `billing_points`** (template #1 default for all presets: `on_acceptance: 60%, stage delivery: 40%` — the real 60/40 contract terms encoded per audit F-1; editable per job), optional dedicated team ("24ft Team": team.kind=`line`, preset-linked).

**Custom fields on job (template-defined, doc 09 field schema):** `engine_package` (text), `colour_scheme` (text), `delivery_status` view — modelled as the job status_set below rather than a parallel field (cleanup vs Najolatech, where deliveryStatus was a second status axis).

**Status set (job):** Draft→`draft` · In Production→`active` · On Hold — awaiting decision→`on_hold` · Sea Trial→`active` (phase carries the nuance) · Delivered→`done` · Closed→`done` · Cancelled→`cancelled`. (Semantic category in the arrow notation.)

## Roles (7 presets — doc 06 mapping)

Admin · Manager · Workshop Manager (Manager variant: stages/reports/issues/week-plan M; no quotes/invoices; `finance.viewCosts` **off**) · Foreman (field seat, assigned boats) · Procurement · Inventory (Procurement-scoped until P3 — U4) · Viewer. `finance.viewCosts`: Owner/Admin/Accounts only by default (Najolatech's labour-cost boundary preserved; note: template #1 routes the Accounts archetype to the people who held Najolatech's "Inventory=back-office accountant" duties).

## Daily report form (the heartbeat, configured)

Header: boat, date, summary (required), blockers, next steps — **stages are referenced per work line, not on the header** (audit C-5); at least one work line with a stage is required while the boat is in a reportable phase. Lines: **work** (stage + description + optional % note) · **labour** (worker + normal/OT hours; snapshot per D-1.5; feeds attendance per U3) · **materials** (catalog item or free text, qty, unit, cost with source; `cost_only` default **on** until Inventory capability goes live — encoding the real Najolatech operating mode as template default, not accident). Photos: min 1 encouraged (soft prompt), stage-tagged. Review: manager/admin reviews; edit-own-draft window until review (own_record condition).

## Approval rules (doc 05; thresholds in org currency at onboarding — U6 scaling hints shown as AED-magnitude defaults)

| Subject | Rule |
|---|---|
| material_request | ≥ 5,000 → Owner/Admin · < 5,000 → Manager · auto-approve: off |
| expense | ≥ 2,000 → Owner/Admin · < 2,000 → Accounts |
| quote_send | always → Owner/Admin |
| payment_receipt | **default OFF pending PB-8** (audit F-20 — the Najolatech draft→approve ritual is preserved as a toggle; when on: always → Owner/Admin) |
| purchase_order (MR-less or ≥ threshold) | Owner/Admin (audit F-3; MR-converted POs auto-approve) |
| *(P3)* stage_signoff | Manager; QC items must be pass/na (E-15) |
| *(P3)* qc_delivery_override | Owner/Admin, reason required — **the "no delivery with open QC unless override" invariant finally gets its enforcement surface** (extraction found it documented but unenforced; this template makes it real) |

## Category sets

- **Item categories (17, from BomCategory):** Fiberglass, Resins & Gelcoat, Core Materials, Adhesives & Sealants, Fasteners, Plumbing, Electrical, Electronics, Hardware, Upholstery, Paint & Finish, Safety Equipment, Engine & Steering, Fuel System, Deck Fittings, Consumables, Motors. *(Exact list reconciled against constants.ts at build time.)*
- **Expense categories (13, from ExpenseCategory)** with `costing_mapping` per the reconciled dedup rule (audit F-2): Materials, Accessories, Engines, Upholstery, Electrical, Paint & Finish → `job_materials`; Fuel, Salaries, Rent, Utilities, Visa & Government, Maintenance, Other → `overhead`. Expenses may never reference a PO (disjoint channels); job costs are **ex-VAT** for VAT-registered orgs (audit F-53, pending PB-3 accountant sign-off).
- **Quote sections (9, from QuotationSection):** Boat package, Engine package, Electronics, … (verbatim from constants at build).

Default quote terms: VAT **country-derived at onboarding** (UAE/Oman 5%, Bahrain 10%, KSA 15%; Qatar/Kuwait get the VAT-disabled org mode — audit F-45), payment terms default "60% initial, 40% prior to delivery" (encoded as the preset billing points above), warranty text slot.

## Today cards & exception thresholds (docs 03/04)

Card selections per role exactly as doc 03 (this template defines the default order; Owner card 4 "Money now" enabled). Thresholds: E-01 missing report = 1 working day (3 → critical); E-02 overdue stage = any (7d critical); E-03 stuck approval = 8h/3d; E-05 margin drift = 15 points or cost > 90% of quote pre-finishing; E-08 unusual expense = 3× category median; E-09 billing grace = 3 days; E-13 visa/ID expiry = 30 days. Digest: owner morning edition on working days (week-close edition deferred per audit F-20). **Working week is set at onboarding with country-aware defaults** (audit C-4 corrected the earlier Sat–Thu error): UAE default Mon–Fri, KSA Sun–Thu, with a 6-day workshop option offered — Najolatech itself runs 6 days. Template seeds the **org holiday calendar** (national days + Eid al-Fitr/al-Adha per country) and a Ramadan working-hours profile (audit F-41).

## Required documents & QC (P3 content, specified now)

Document types: contract, spec sheet, drawings, engine certificate, sea-trial report, delivery note. QC: per-stage checklist items seeded from the Najolatech *planned* QC design (per-stage `qc_template_items`, optional per-preset variants; fail → auto-issue) — **flagged for pilot design review before P3 build** since it never ran in production (doc 01 gap analysis).

## Reports pack & customer updates

Curated reports: job cost vs quote (owner/accounts), boat progress board, materials spend by category, supplier performance, AR aging, attendance month grid. Customer updates: safe-by-construction rules on (no costs, workers as counts, curated photos only), bilingual drafts.

---

**Template acceptance test (build gate, doc 11 S8):** a fresh org onboarded with this template + Najolatech's presets can reproduce one real historical boat end-to-end — quote → boat → stages with correct skips → daily reports with labour/material lines → MR→LPO→GRN chain → expenses → costing within rounding of the legacy system's `boatFinance()` for the same inputs → milestone invoice → payment. That parity check is the strongest possible proof the generalisation lost nothing that mattered.
