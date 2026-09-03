# 14 — Post-MVP Amendments & Owner Directions

**Purpose.** `13-ARCHITECTURE-FREEZE.md` is the historical baseline; its amendment log ends
2026-07-11. Implementation continued well past that date under explicit owner direction, but the
freeze trail was not extended — so the change-control record stopped describing governed history.
This document restores traceability **without rewriting the frozen baseline**: it records what was
implemented after the freeze (linking to the completion reports rather than copying them), the
known implementation divergences awaiting a decision, and the owner's product directions of
2026-08-26 that are **approved but not yet implemented**.

The change-control rule of doc 13 is unchanged and still applies: changes to frozen decisions
require a verified security issue, a proven scalability/reliability issue, or real pilot evidence —
approved by the owner and recorded here (or in a successor log).

---

## 1. Post-freeze implementation record (2026-07-12 → 2026-07-16)

Each entry was owner-directed at the time and is documented in a completion report; they are listed
here so they are discoverable from the architecture trail. They post-date the freeze and were **not**
part of the original frozen baseline.

| Date | Change | Freeze impact | Authoritative record |
| --- | --- | --- | --- |
| 2026-07-12 → 14 | Slices **S1–S11** built, verified, deployed (MVP complete) | Executes doc 11 as planned | `../docs/MVP-READINESS-REPORT.md`, `../docs/S11-PILOT-READINESS-COMPLETION.md`, `../S6_S9_PROGRESS.md`, `../S10_S11_PROGRESS.md` |
| 2026-07-15 | **Template catalogue expanded to 8** (marine preserved verbatim + manufacturing, service, construction, food & beverage, online store, agriculture, generic) — all data manifests over `object_kind: "job"` | **Supersedes FS-1's "template #1 only" MVP scope** (post-MVP work, not an MVP-scope violation). FR-3 (no universal engine, no new object kinds) **held**. Doc 08 remains accurate for template #1 only. | `../docs/POST_MVP_TEMPLATE_ADDON_COMPLETION.md`, `../docs/templates/` |
| 2026-07-15 | **Commercial model replaced**: Free base + individually purchasable add-ons + Medium/High tier **bundles** (bundles expand to the same add-on keys) + Custom; migrations 0065–0072 | **Supersedes doc 09's Starter/Growth/Business tier framing** (keys survive as legacy plan rows). FR-9 (central entitlements, plans-as-data, reads never blocked, free field/viewer seats) **held and extended** — explicitly no second entitlement system. Pricing remains `is_placeholder` pending D3. | `../docs/commercial/` (catalogue, bundles, free plan, pricing rationale, owner decisions), `../docs/ux/SUBSCRIPTION_SELECTION_FLOW.md` |
| 2026-07-15 | **Organization branding capability** (logo upload, accent, UI + LPO/quote/invoice document placements; entitlement-gated), migration 0071; reverses the earlier honesty-deferral of the branding add-ons **with** real enforcement | New capability, additive; honesty law held (sold keys have enforcement sites, unit-tested) | `../docs/ux/BRANDING_AND_LOGO.md` |
| 2026-07-15 | **Pre-org onboarding wizard** (welcome → questionnaire → template recommendation → proposal → subscription selection → branding → review → explicit confirm), user-scoped `onboarding_draft`, migration 0073; deterministic classifier; nothing applied before the explicit confirm | Amends doc 11's S8 shape (org-scoped intake → pre-org wizard). FR-8 AI boundary **held conservatively**: no LLM is wired anywhere; the "AI onboarding" path is fully deterministic | `../docs/ux/ONBOARDING_FLOW.md`, `../docs/ux/FOUNDER_UX_COMPLETION_REPORT.md` |
| 2026-07-15 | **Viewer role receives a read-only Today screen** (`today.view` granted to viewer) | Amends doc 03 (5 roles → 6 screens) and doc 06's viewer row — additive read grant, composed only from the viewer's existing read permissions | `../docs/ux/ROLE_DASHBOARDS.md` (note: its "viewer coming soon" line pre-dates this change), adversarial-review record in `../docs/ux/FOUNDER_UX_COMPLETION_REPORT.md` |
| 2026-07-15 → 16 | **Dashboard/navigation redesign** (sidebar, role dashboards, mobile nav), **auth-callback + password-recovery fixes**, **founder fix round 2** (logo upload, master-data error quality, quick-create menu, subscription self-service management via a governed no-payment trial path) | Presentation + defect fixes; provider-events-remain-sole-writer-of-real-paid-state **held** (governed trial changes are audited `via='owner_action', trial=true`) | `../docs/ux/FOUNDER_UX_COMPLETION_REPORT.md`, `../docs/ux/FOUNDER_FIX_ROUND_2_REPORT.md`, `../FOUNDER_FIX_ROUND_2_PROGRESS.md` |

Migration ledger after the above: **0000–0073 applied (74 files); next migration number 0074.**

## 2. Known implementation divergences — recorded, decision pending

These are flagged per the AGENTS.md rule (divergences are recorded, never silently resolved). None
is to be refactored without an explicit owner decision.

1. **No repository layer.** The plan's `service → repository → database` layering was never built;
   services execute parameterized SQL directly (hundreds of `tx.execute(sql…)` calls across the
   module services) through the enforced chokepoints `src/platform/tenancy` (`withCtx`/`withUserCtx`)
   and `src/platform/audit` (`command()`), with ESLint banning driver imports and ad-hoc DB access
   elsewhere. The tenancy, audit, and isolation guarantees hold; the cost is SQL distributed through
   service files rather than a swappable repository abstraction. **Decision needed later:** adopt the
   2-layer pattern as the documented rule, or introduce repositories incrementally.
2. **"AI onboarding" is deterministic.** The S8 AI seam exists but no LLM provider is wired; the
   deterministic grounded classifier/validator is the shipped path (a conservative posture inside
   FR-8, not a violation).
3. **Manager costing access.** Doc 06 wording ("granted only with a finance toggle") was
   reinterpreted: `costing.view` is granted to manager, with labour/margin redacted at the
   serialization and RLS boundaries instead (consistent with audit F-23's boundary-redaction rule).

## 3. Owner product directions — **2026-08-26** (approved; **implementation pending**)

Recorded verbatim as accepted direction. **Neither the Setup Studio nor the new dashboard exists in
the codebase today** — these are forward directions, not status.

1. IdaraWorks will move away from presenting built-in industry templates as the primary customer
   onboarding experience.
2. The intended customer experience is a guided **Setup Studio** where each organization builds its
   own operating setup.
3. Existing template/configuration machinery must **not** be deleted prematurely. It remains intact
   until the Setup Studio architecture, migration path and compatibility rules are formally
   specified.
4. Existing industry setups may later be retained as internal demo/reference configurations for
   approximately five or six fictional businesses used in marketing.
5. No generated setup may produce executable code, SQL, DDL, RLS policies or migrations — the
   FR-8/doc-09 configuration boundary (validated schemas + config revisions only) is constitutional
   and carries into the Setup Studio unchanged.
6. The Owner dashboard will receive a modern, premium, technology-oriented visual redesign,
   potentially including restrained 3D/depth effects. This is a **visual direction only** and must
   not weaken accessibility, performance, responsiveness, RTL support, permissions or server-side
   data boundaries.

**Implementation gate:** direction 1–4 (Setup Studio / template repositioning) requires a formal
architecture amendment (successor to FS-1 and to doc 11's S8 onboarding shape) specifying the
custom-manifest builder, validation rules, install path, template-compatibility rules and the demo-
workspace model **before** any template-facing removal begins. Direction 6 (dashboard visuals)
requires no amendment — it is presentation-layer only — but must pass the standard review gates.

## 4. Owner product directions — **2026-08-27** (approved; implementation begins with 003B.1)

Context: the Interaction Completeness Audit (`docs/ux/INTERACTION_COMPLETENESS_AUDIT.md`) was
accepted; its §12 records this amendment in full. Summary of the binding direction:

1. **Universal export contract.** Every record or report that reasonably requires a formal document
   or a data export must be exportable in an appropriate format (print/PDF for formal documents,
   CSV — later XLSX — for data). The typed catalogue at `src/platform/documents/catalogue.ts` is
   authoritative and may never claim an export is available before its route ships.
2. **Organization identity on documents is a core capability.** All formal documents use the
   organization's actual identity — onboarding logo, legal/trading name, TRN, address, configured
   document details — for every organization regardless of entitlements. `feat.branding_docs` is
   redefined as *advanced document styling* (accent/letterhead controls), never the presence of
   issuer identity. `feat.branding_app` (in-app placements) keeps its existing behavior.
3. **Canonical issuer model.** `company` (default row) owns legal identity incl. the only TRN
   source; `org_branding` owns visual identity; document-profile reads compose the two;
   `org_branding.legal_name` is frozen as a legacy fallback (no writer remains).
4. **Historical integrity.** Formal documents capture an immutable issuer snapshot at
   formalization (writers land in 003B.2); issued documents are never re-branded by later profile
   changes; pre-snapshot documents use an explicit legacy fallback.
5. **Interaction-audit decisions D1–D8** are all ruled (audit §12.2): quote cancel with reason
   approved; preset chosen at acceptance; manual expiry with 30-day default validity; partial
   credit notes required before real paid billing (not in 003B.1); print-fallback-first document
   strategy; member role changes required; approval-rule UI view-only first; no hard-delete for
   the pilot.

**Implementation status:** microstep 003B.1 ships the shared foundation — migration `0074`
(structured company identity fields), the composed document-profile service, the issuer-snapshot
schema, the branded document shell, the Brand & Documents settings surface with sample preview, and
the honest entitlement re-copy. Print/export routes, lifecycle snapshot writers and customer
completeness follow as separate microsteps (003B.2+).

## 6. Owner product direction — **2026-09-02** (approved; implementation begins with H27)

Recorded verbatim in intent; the full mandate text is held in `docs/H27-TRUTH-MAP.md` Part A.
Nothing in this section rewrites a historical roadmap claim: the north star (`docs/product/
IDARAWORKS_BUSINESS_OS_NORTH_STAR.md`, adopted 2026-08-29) keeps its stage list and its status
column as adopted; this entry records what the Owner approved on 2026-09-02.

**H27 — CRM and Revenue Growth Studio.** Build the customer relationship, sales and revenue-growth
system as a flagship tool: visual, interactive, intelligent, connected to the whole business.
Core outcome: one company manages the complete commercial journey Enquiry → Lead → Qualification →
Opportunity → Proposal/Quote → Approval → Contract → Project/Order → Invoice → Payment →
Retention/Renewal, every stage connected to the systems already built (customers, contacts,
projects, quotes, Document Studio, approvals, planning, finance, communications, reporting).

Binding rules carried from the mandate:

1. **Reuse, never compete.** Existing customer, contact, lead, opportunity, pipeline stage, sales
   activity, quote, invoice, payment, job, document, approval, notification and import models are
   the sources of truth; H27 extends them additively and reads financial and project facts from
   their owning modules (Bible P4/P5, architecture rule 3).
2. **Stage moves are governed.** A stage move validates stage requirements, records who moved it
   and why, preserves history, and triggers only authorised downstream actions.
3. **Conversion is idempotent.** Repeated clicks or retries never create duplicate customers,
   projects, quotes, contracts or invoices (H20's advisory-locked `convertLead` is the pattern).
4. **Consent is law.** No marketing communication without an explicit authorised action; consent,
   unsubscribe, suppression and channel preferences are respected; mass delivery stays behind
   provider adapters that fail closed without credentials.
5. **Forecasts are explainable and never guaranteed.** Deterministic calculations, stored forecast
   snapshots for prediction-versus-outcome comparison, attribution models labelled by name and never
   presented as causal impact.
6. **Automation and AI are governed.** Automations carry owner, trigger, conditions, actions, state,
   preview, history, idempotency, failure reporting, permissions and audit; the AI seam fails closed
   until a provider is configured and never autonomously sends, moves stages, approves discounts,
   creates financial records, signs, merges, changes consent or fabricates interactions.
7. **Release and untouched matters.** Every H27 surface sits behind `FEATURE_REVENUE_STUDIO`
   (strict `"1"`). Historical accounting is not converted, the H24 transition ambiguities are not
   resolved, PO-002 is not modified, the deferred H22 stock-posting problem is not mixed in, H28 is
   not begun, and production data is preserved.

**Implementation gate:** the H27 truth map (`docs/H27-TRUTH-MAP.md`) records the baseline, the
inventory of existing models, the transition seams, the research consulted and the decisions
(ADR-32 onward) before code changes; the completion report (`docs/H27-REPORT.md`) records the
shipped commit, migrations, evidence and the exact owner actions for provider-backed capabilities.

## 7. Owner product direction — **2026-09-03** (approved; implementation begins with H28)

Recorded verbatim in intent; the full mandate text is held in `docs/H28-TRUTH-MAP.md` Part B.
The north star keeps its stage list and status column as adopted; this entry records what the
Owner approved on 2026-09-03.

**H28 — Idara Intelligence: Multi-Agent Platform and Governed Automation.** Build a
state-of-the-art AI agent platform across IdaraWorks: an ambient, trusted intelligence layer (the
**Idara Dock**, mounted in the authenticated shell, never in the navigation sidebar) that follows
people through their work, understands the page and record they are viewing, calls governed
specialists when required, explains its evidence and turns intentions into reviewed outcomes.

Binding rules carried from the mandate:

1. **Reuse, never compete.** The H12 agent substrate (`src/platform/agents`), the approval engine,
   the H27 automation engine and workers, notifications, the command palette, the permission
   service, entitlements and the audit command path are extended additively; no parallel approval,
   automation, audit or notification engine.
2. **The H11 agent contract is amended, not replaced.** Idara becomes the orchestrator (the
   `manager` id is retired and resolved to `idara`); the ten canonical specialists remain and four
   domains are added (customer success, tax, document and contract, organisation administration);
   every agent carries the governance fields the mandate lists; delegation is bounded, traced and
   cost-limited. The public homepage showcase keeps the H13 canonical set and its "planned"
   wording until the Owner refreshes public copy (recorded divergence).
3. **One server-side provider-neutral gateway** with registries, an effective-dated price book,
   metering, budgets, kill switches and deterministic providers for tests; keys stay server-side;
   no vendor lock-in; no failover claim without adapter-boundary tests.
4. **No provider means fail closed.** No credentials exist; nothing is invented or purchased; the
   platform ships behind `FEATURE_IDARA_INTELLIGENCE` (strict `"1"`) with provider availability,
   organisation entitlement, agent state and a global stop as separate controls.
5. **Grounding, risk classes, previews, confirmation, idempotency, drift refusal and human control**
   as enumerated in the mandate; the platform never approves its own work, signs, files, releases,
   posts, finalises payroll, hires or dismisses, changes permissions, sends campaigns, deletes
   history or hides uncertainty.
6. **Metering before any paid model; credits separate from tokens; no charging** until the payment
   provider, legal setup, pricing and tax treatment exist.
7. **Untouched matters.** Historical accounting, the H24 transition ambiguities, PO-002, the deferred
   H22 stock-posting issue, real pricing and payments, provider contracts, production secrets and
   genuine production data; H29 is not begun.

**Implementation gate:** the H28 truth map (`docs/H28-TRUTH-MAP.md`) records the baseline, the
inventory, the seams, the research consulted and the decisions (ADR-49 onward) before code changes;
the completion report (`docs/H28-REPORT.md`) records the shipped commit, migrations, evidence, the
exact live/disabled state and every owner action required before paid AI can be enabled.

## 8. Owner product direction — **2026-09-03** (approved; implementation begins with H29)

**H29 — International Expansion and Versioned Country Packs.** Approved by the owner, recorded
verbatim in `docs/H29-TRUTH-MAP.md` Part B. IdaraWorks must be able to enter a new market without
scattering country assumptions through the product. The approved initial scope:

1. A reusable global country-pack engine.
2. A complete UAE pack that reuses and strengthens the existing UAE functionality.
3. A Saudi Arabia pack with safe ZATCA, tax, payroll and business-localisation foundations.
4. Complete Spanish-language support for the universal product.
5. Continued complete English and Arabic support.
6. No claim that every Spanish-speaking country shares one legal or tax system.
7. No unsupported compliance, certification, filing or legal-advice claims.

**Binding rules carried into the build**

1. **Packs, not conditionals.** Country behaviour resolves through the active pack and the effective
   date. `country === "AE"` checks do not spread through unrelated application code. Shared regional
   modules exist only where the rules are genuinely identical and sourced; GCC countries are not
   assumed to share laws.
2. **Effective-dated rules.** Non-overlapping validity, draft and approved versions, future
   scheduled versions, supersession, historical reproducibility, impact preview before activation,
   per-organisation adoption state, rollback where valid, full audit. A transaction dated in an
   earlier period keeps the rule version applicable to that date; a pack update never rewrites an
   issued invoice, payroll run, working paper or document.
3. **Establishments.** An organisation may operate through more than one legal establishment, with
   its own country, registrations, addresses, currency, timezone, working week, holiday calendar,
   invoice identity, banking and pack version. Changing a country or establishment after business
   records exist is a governed operation with an impact preview.
4. **Readiness, honestly staged.** Technically configured, reviewed internally, provider connected,
   legally reviewed, ready for controlled pilot and ready for general availability are distinct
   states. Legal readiness is never reduced to a single percentage.
5. **No invented facts.** No tax rate, threshold, exchange rate, filing status or legal conclusion is
   invented. Every implemented rule records its source, retrieval date and effective date. Ambiguous
   or organisation-specific rules become configuration or a review flag.
6. **Fail closed on external authorities.** Electronic-invoicing adapters are contract-tested against
   official schemas with deterministic fixtures; submission stays disabled without credentials. No
   genuine production invoice is sent to any authority during H29.
7. **Spanish is a language, not a jurisdiction.** A complete `es` locale for the universal product,
   machine-assisted and marked for native review, creates no Spain, Mexico or Latin American legal
   pack.
8. **Untouched matters.** Historical accounting, the H24 transition ambiguities, PO-002, the deferred
   H22 stock-posting issue, H28 external AI activation, real tax filings, authority submissions,
   pricing and payments, and genuine production data; H30 is not begun.

**Flags:** `FEATURE_COUNTRY_PACKS`, `FEATURE_LOCALE_ES`, plus per-country activation, per-
establishment pack state and per-provider state. The only enabling value is the exact string `"1"`.

**Implementation gate:** the H29 truth map (`docs/H29-TRUTH-MAP.md`) and evidence log
(`docs/H29-EVIDENCE-LOG.md`) record the baseline, inventory, sources, decisions and limitations
before code changes; the completion report (`docs/H29-REPORT.md`) records the shipped commit,
migrations, evidence, the exact enabled/disabled state and every review or provider action still
outstanding.

## 5. Amendment log (this document, append-only)

| Date | Entry | Approved |
| --- | --- | --- |
| 2026-08-26 | Document created: post-freeze implementation record (§1), divergence register (§2), owner directions recorded pending implementation (§3). Baseline audit at commit `d9c884c` accepted by owner. | Owner |
| 2026-08-27 | §4 added: universal document/export contract, core document identity, canonical issuer model, historical-integrity rule, interaction-audit decisions D1–D8 ruled. Interaction Completeness Audit accepted (its §12 carries the full amendment). Implementation begins with microstep 003B.1. | Owner |
| 2026-09-02 | §6 added: H27 CRM and Revenue Growth Studio approved as the next phase (reuse-first over the H19/H20 customer, lead, opportunity, pipeline and activity models; governed stage moves; idempotent conversion; consent as law; explainable forecasts; governed automation and fail-closed AI; `FEATURE_REVENUE_STUDIO`). North star status column intentionally left as adopted. | Owner |
| 2026-09-03 | §7 added: H28 Idara Intelligence approved (ambient Idara Dock in the shell; Idara orchestrator with governed specialists over the H12 substrate; provider-neutral gateway with metering, credits and kill switches; fail-closed without credentials; flag `FEATURE_IDARA_INTELLIGENCE`; untouched matters restated). Public showcase divergence recorded. | Owner |
| 2026-09-03 | §8 added: H29 International Expansion and Versioned Country Packs approved (country-pack engine with effective-dated versions and adoption state; establishments; UAE pack reusing H23/H24 foundations; Saudi pack with a fail-closed ZATCA adapter; complete machine-assisted Spanish marked for native review; Arabic and English parity re-audited; flags `FEATURE_COUNTRY_PACKS` and `FEATURE_LOCALE_ES`; untouched matters restated). | Owner |
