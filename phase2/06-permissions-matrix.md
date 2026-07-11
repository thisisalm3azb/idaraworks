# 06 — Permissions Matrix

**Purpose:** role archetypes × capabilities × actions, the condition vocabulary, and the field-seat definition (resolves U2/v1 Q9). Grounded in the production-proven Najolatech matrix (44 actions, `can(role, action)` + one condition `canOnProject(assigned)`) — generalised, not reinvented.

## D-6.1 — Platform archetypes + template presets; `can(ctx, action, resource?)` with a fixed condition vocabulary

**Decision:** eight platform **archetypes** (below). Templates ship role **presets** = archetype + capability scoping + label (doc 08 maps Najolatech's 7 roles). Orgs clone/rename presets and toggle per-capability access; they cannot invent new *actions* or conditions. All checks go through one `can(ctx, action, resource?)`; UI gates mirror, server enforces, RLS backstops (v1 §11–12).
**Why:** Najolatech proves a flat action matrix + one assignment condition covers a real industrial operation; archetypes keep AI onboarding proposals safe (Layer A proposes presets, never raw grants — v2 §14).
**Alternatives rejected:** full custom role builder (SMB admins can't debug it; AI proposing raw permission sets is the §14 safety anti-pattern); pure fixed roles with no cloning (real orgs need "Foreman but can also raise expenses"); ABAC policy engine (v1 §12 already rejected).
**Risks:** preset sprawl per org — capped (≤ 12 roles/org) and diffable in config revisions.
**Validate in pilots:** zero requests that require a new *condition type* (new togglable actions are fine); admins successfully self-serve one role adjustment without support.

**Condition vocabulary (closed):** `assigned_job`, `own_record` (author-only edit windows, e.g. own draft or returned report), `amount_threshold` (routes via approval rules, doc 05 — not a permission per se), `cost_visibility` (below).

**`assigned_job(user)` — precise definition (audit F-6):** true iff `user = job.manager_id` ∨ `user = job.foreman_id` (both are **user** references) ∨ the user's linked employee (`employee.user_id`) has a `job_crew` membership on the job. One resolver function; no other assignment source exists in MVP.

## D-6.2 — Cost visibility is a permission flag, not a role

**Decision:** `finance.viewCosts` (labour + margins + full costing) and `finance.viewPrices` (selling prices, quotes, invoices) are separate grants attached to archetypes but individually togglable. Redaction happens **server-side at every serialization boundary** (audit F-23) — the Today composer, every costing read, **approval inbox subject summaries, push-notification bodies, digest payload collection, exports, and file access** — never client-side. File access is classed per `attached_to` type (`job_media` / `financial_doc` requires `finance.viewPrices` / `hr_doc` privileged / `customer_share` watermarked) and enforced at signed-URL minting (doc 01 Appendix A). Response-shape snapshot tests cover all boundaries (doc 10).
**Why:** Najolatech's hardest-won boundary (admin-only labour side-tables, `totalExLabour` for everyone else, ×1.20 partner views enforced in DB) generalises to: *who may know what work costs* is orthogonal to *who manages work*. A workshop manager may run everything and still not see salaries.
**Alternatives rejected:** cost visibility baked into role rank (real orgs differ: some owners show managers margins, some don't); client-side hiding (a cost leak = trust catastrophe, R-class).
**Validate in pilots:** owner comfort interview — "who can see what" explainable in one sentence; attempted-access logs show the server boundary being exercised, not bypassed.

## D-6.3 — Field seats (resolves U2)

**Decision (amended per audit F-17/C-3):** one MVP field archetype. **Foreman** — full field participant: daily reports, tasks, issues, photos, MRs, goods-receipt recording on **assigned jobs only**; sees progress, never costs/prices. The **Worker** archetype is **cut from the MVP build** — after the U3 attendance resolution its only remaining right was viewing own tasks; the enum slot is reserved and its column below documents the P3 definition. Field seats are free or near-free in every pricing hypothesis (doc 09), because per-seat charging of field staff is the churn pattern v1 research proved and JobTread's free field users disproved the need for.
**Why:** renewal is decided by field adoption (v2 research, twice over); seat friction is the adoption killer.
**Alternatives rejected:** one field archetype (foremen and labourers have genuinely different write rights); charging reduced-price worker seats (still friction; the marginal cost is ~0).
**Risks:** free-seat abuse (orgs classifying office staff as field) — entitlements cap *paid-capability actions*, not bodies; a "worker" who tries to approve or quote hits the archetype wall anyway.
**Validate in pilots:** foremen activate without training (< 10 min shadowing); worker archetype demand — if no pilot uses it, it ships dark.

---

## The matrix (MVP capabilities × archetypes)

Legend: **A**=approve/decide · **M**=manage (create/edit) · **C**=create/contribute · **V**=view · **v**=view redacted (no costs) · **−**=none. Conditions in ( ).

| Capability · action | Owner | Admin | Manager | Foreman | Procurement | Accounts | ~~Worker~~¹ | Viewer² |
|---|---|---|---|---|---|---|---|---|
| Jobs: create/edit core | M | M | M | − | − | − | − | − |
| Jobs: view | V | V | V | v (assigned) | v | V | v (assigned) | v |
| Stages: update status | M | M | M | C (assigned; request-complete) | − | − | − | − |
| Tasks: manage / update own status | M | M | M | C (assigned) | − | − | C (own) | − |
| Daily reports: create/edit own draft | C | C | C | C (assigned, own) | − | − | − | − |
| Daily reports: review; edit materials post-submit | A/M | A/M | A/M | − | − | − | − | − |
| Reports: backfill history | − | M | − | − | − | − | − | − |
| Issues: raise / resolve | C/M | C/M | C/M | C (assigned) | C | C | C (own) | − |
| Photos: add / delete | C/M | C/M | C/M | C (assigned) | − | − | C | − |
| Week plan: manage / view published | M | M | M | V | V | V | V | V |
| Approvals: decide (per doc 05 rules) | A | A | A (rule-scoped) | − *(GRN recording is creation, not approval — audit C-2)* | − | A (rule-scoped) | − | − |
| Material requests: create / convert | C | C | C | C (assigned) | C+convert | − | − | − |
| POs: manage / view | A/M | A/M | M | − | M | V | − | − |
| Goods receipts: create / cancel | C | C/M | C | C (assigned) | C | − | − | − |
| Suppliers, item catalog: manage | M | M | M | − | M | V | − | − |
| Customers: manage | M | M | M | − | − | V | − | − |
| Quotes: draft / approve-send | M/A | M/A | M | − | − | V | − | − |
| Invoices & payments: manage | M | M | − | − | − | M | − | − |
| Expenses: create / approve | C/A | C/A | C | − | C | M/A (rule) | − | − |
| Job costing / margins | V | V | 🔒 | − | − | V | − | − |
| Employees: manage / HR docs✱ | M/✱ | M/✱ | M | − | − | V | − | − |
| Attendance: mark / view | M | M | M (manual grid for non-job staff, per U3) | − *(labour lines are the write — audit C-3)* | − | V | − | V |
| Customer updates: draft/send | M | M | C | − | − | − | − | − |
| Reports (analytics) area | V | V | v→V(🔒) | − | v (supply) | V | − | v |
| Settings, roles, entitlements, config revisions | M | M | − | − | − | − | − | − |
| AI: onboarding/config proposals · digest · drafts | M · V · C | M · V · C | − · V · C | − · V · − | − · V · − | − · V · C | − | − |

¹ Worker archetype **cut from the MVP build** (audit F-17); the column is retained as the reserved P3 archetype definition — no Worker seats exist or are grantable in MVP.
² Viewer is a **free read-only seat class** in the entitlement model (audit F-11, doc 09).

🔒 = granted only with `finance.viewCosts` toggle (default **off** for Manager in template #1 — matching Najolatech's labour-cost boundary; owner can enable). Owner ≡ Admin in MVP permissions; Owner additionally holds billing/plan actions (doc 09) and cannot be removed by Admin. Hard-delete is denied to **every** archetype (D-1.7 — archive/void only, the Najolatech rule). Membership deactivation (audit F-7): open approvals reassign by rule; active crew roles flag to the manager; history untouched.

**Najolatech preset mapping (template #1, doc 08):** Admin→Admin, Manager→Manager, Workshop manager→Manager preset variant (stage/report powers, no commercial M, no 🔒), Foreman→Foreman, Procurement→Procurement, Inventory→Procurement-scoped preset labelled "Inventory" until P3 unlocks stock actions (U4), Viewer→Viewer.

**Enforcement stack (test targets, doc 10):** every action string appears in ≥1 server check; permission unit tests iterate matrix × archetype (deny-by-default asserted); condition tests for `assigned_job`/`own_record`/`cost_visibility`; RLS mirrors the V column only (row visibility), never the action semantics — actions live in the service layer.
