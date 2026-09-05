# H33 — Full-Scale Pilot Simulation and Launch Readiness Closure: truth map

What is actually true, measured before anything was generated. Everything here
is checkable in the repository or in the two databases, and every number below
was read, not assumed.

---

## Part A — baseline and capacity

### Repository and production

| | |
| --- | --- |
| Repository | `C:\Users\abdul\Desktop\idaraworks`, remote `thisisalm3azb/idaraworks` |
| Branch | `verify/h33`, cut from `main` at `ff97c80` (H32 owner-accepted close) |
| Production | www.idaraworks.com serving `ff97c80`, `/api/health` ok |
| Production business counts | 41 orgs / 62 users / 51 customers / 78 invoices / 93 jobs / 670 audit rows |
| Production H33 traces | **0** orgs named `H33…`, **0** `h33*` app_settings keys, **0** `.invalid` users |
| PO-002 | untouched (see Part M facts below) |
| Flags on in production | `FEATURE_BRANDED_COMPANY_APPS`, `FEATURE_GUIDED_ONBOARDING`, plus the surface flags already live; AI, country packs and Spanish **off** |

### The isolated test project — positively identified

| | |
| --- | --- |
| Project ref | `zwnnqaryouevnzuwtyaj` (`.env.test.local`; pooler host `aws-0-ap-northeast-1`) |
| Production ref, which every H33 tool refuses | `anhgeeutrwftsvuzfinf` (`aws-1-ap-northeast-2`) |
| Guard already in the repo | `tests/integration/guard-env.ts` — `targetsOnlyTestProject()` / `assertNotProduction()` |
| Database size now | **57 MB** (59,755,667 bytes) — almost entirely index overhead across 280 tables; ~2,076 live rows |
| Tables | 280 public base tables; **257 tenant-owned** (carry `org_id`) |
| Storage | buckets `tenant-media` (private, 15 MB/file) and `tenant-docs` (private, 25 MB/file); 12 objects, 3.6 KB |
| Existing orgs | 19 — leftovers from other integration suites (`R2FIX…` ×11 unmarked, `H22…`/`H25…` marked `test.fixture`, `S2 Org`). Tiny. **Not H33's to delete**; recorded, left alone |
| Existing `.invalid` users | 74 (prior simulation/test accounts) — not H33's; H33 uses its own deterministic pattern |
| Outbound side effects reachable from the test env | **none** — `.env.test.local` carries no `RESEND_API_KEY`, no `INNGEST_*`, no `SENTRY_*`, no AI keys. Email, relay, error reporting and AI are structurally impossible from this environment |
| Supabase management access | **none here** — the CLI has no access token, so plan, PITR and backup status cannot be read programmatically from this machine (Part L records this as an owner action) |

### Measured throughput (test project, from this machine)

| | |
| --- | --- |
| Round trip | ~180 ms |
| One batched `unnest` insert of 5,000 rows | 1.56 s (~3,200 rows/s) |
| Single-row insert | ~192 ms each |

Consequence: bulk families are written in batches of a few thousand rows; anything
driven through a domain service (one to several round trips each) is kept to
hundreds of representative transitions per company, not thousands.

### The capacity budget, and why

Supabase's free tier allows 500 MB of database and 1 GB of storage. The test
project sits at 57 MB.

| Budget | Value | Reason |
| --- | --- | --- |
| Database ceiling for H33 | **≤ 300 MB total** (60 % of 500 MB) — i.e. **≤ ~240 MB** added | Leaves 40 % for indexes bloating under updates, autovacuum, other suites, and the owner's own manual-testing writes |
| Row target | **~150,000 coherent rows** across the five companies, measured by dry-run before writing | At a measured ~1–1.5 KB per row including indexes this is 150–225 MB; the mandate's 100k–300k range is honoured at its lower-middle rather than its top |
| Storage ceiling | **≤ 60 MB** of rendered PDFs and attachments | A representative matrix, not one file per document |
| Hard stop | The seeder checks `pg_database_size` after every family and refuses to continue past 300 MB | A stalled seed is recoverable; a full free-tier database is not |

The dry-run prints projected rows and bytes per family before any write, and the
verify mode reports the actual size afterwards.

---

## Part A — inventory

### User-facing surfaces (`src/app/(app)/o/[orgId]/…`)

approvals · ar · assets · attendance · claims · costing · customer-updates ·
customers · documents (templates, forms, workflows, obligations, step) ·
expenses · finance (accounts, banking, budgets, journals, payables, receivables,
reports, setup, tally, tax) · idara · imports · inbox · invoices · issues ·
items · jobs · leads · leave · material-requests · my-pay · my-work ·
onboarding · onboarding-tour · opportunities · payments · payroll · people ·
purchase-orders · quotes · reports · revenue (pipeline, deals, leads, forecast,
campaigns, targets, success, automations, reports, customers, settings) · sales ·
settings (ai, app, branding, configuration, countries, export, members,
notifications, pipeline, subscription, workspace) · stock · studio (plans,
registers) · suppliers · week.

API: manifest, icon, documents PDF, studio PDF, export, revenue report, health,
ready, inngest, billing webhook, cron.

### Feature flags (exact string `"1"` enables)

`FEATURE_STOCK_SURFACES`, `FEATURE_HR_SURFACES`, `FEATURE_FINANCE_SURFACES`,
`FEATURE_MANAGEMENT_STUDIO`, `FEATURE_DOCUMENT_STUDIO`, `FEATURE_REVENUE_STUDIO`,
`FEATURE_BRANDED_COMPANY_APPS`, `FEATURE_GUIDED_ONBOARDING` — the Pilot Lab
launcher exports these for the local test server.
`FEATURE_IDARA_INTELLIGENCE`, `FEATURE_COUNTRY_PACKS`, `FEATURE_LOCALE_ES` — **stay
off** everywhere; the lab tests their disabled / fail-closed states.

### Tenant-owned tables, by family (257)

crm (19) · ai (17) · doc (17) · stock (15) · employee (14) · asset (10) ·
studio (8) · org (7) · bank (5) · job (5) · pay (5) · einvoice (4) ·
establishment (4) · goods (4) · leave (4) · report (4) · assembly (3) ·
attendance (3) · candidate (3) · cost (3) · customer (3) · expense (3) ·
journal (3) · supplier (3) · task (3) · tax (3) · and 60 singletons/pairs
(approval, bom, budget, currency, fiscal, import, invoice, material, membership,
notification, onboarding, payment, purchase, quote, week, work, activity,
audit_log, comment, department, digest, domain_event, exception, file,
gl_account, issue, item, lead, opportunity, sales_activity, warehouse, …).

Full list produced by the inventory query and re-derived by the seeder at run
time; the seeder's manifest records the exact table set it wrote to.

### Entitlements

Every plan in the test project (`free`, `starter`, `growth`, `business`) carries
all 39 capability/feature entitlements enabled. The factory's proven technique —
`billing_state = internal_pilot`, `plan_key = growth`, no trial deadline — gives a
lab company every product area. Surfaces are additionally gated by the deploy
flags above.

### State machines the seeder must respect (triggers, not conventions)

Bulk inserts cannot create impossible states; these guards enforce it at the
database:

| Guard | Consequence for the generator |
| --- | --- |
| `journal_entry_born_draft`, `journal_line_frozen` | Journals are created as drafts and posted through `app.post_journal_entry`; the seeder posts in batches through that function, never by writing `posted_at` |
| `stock_movement_validate_source`, `*_no_update`, `*_no_delete` | Every movement cites a real source row (`goods_receipt_line`, `report_material_line`, …) that exists first; the ledger is append-only |
| `stock_cost_layer_value_default`, `stock_layer_consumption_*` | Cost layers are born from receipts; consumption rows are immutable |
| `employee_lifecycle_guard` | draft → active → suspended/notice → terminated → archived only |
| `pay_run_status_guard`, `pay_run_line_frozen`, `payslip_immutable` | Pay runs move draft → review → awaiting_approval → finalized; finalized is immutable |
| `purchase_order_money_defaults`, `purchase_order_freeze_money` | Money on a PO is derived at insert and frozen after |
| `doc_document_guard`, `doc_snapshot_immutable`, `doc_revision_guard` | An issued document keeps its snapshot; snapshots never change |
| `asset_status_transition`, `asset_disposed_read_only` | Legal asset transitions only |
| `bom_frozen_once_active`, `budget_line_frozen`, `tax_entry_frozen`, `expense_claim_guard`, `fiscal_period_guard`, `leave_ledger_append_only`, `employee_event_append_only` | as named |

Several guards are skipped under `session_replication_role = replica`. **The
seeder does not use replica mode to write.** Where a guard exists, the seeder
either drives the real service or calls the same database function the service
calls (`app.post_journal_entry`), so seeded rows are indistinguishable from
application writes. Replica mode is used by the guarded cleanup only, to delete.

### External side effects in the product, and their state in the lab

| Seam | Mechanism | In the lab |
| --- | --- | --- |
| Transactional email | Resend when `RESEND_API_KEY` set | key absent → no-op |
| Background jobs | Inngest crons + event consumers, fed by the `domain_event` outbox relay | keys absent → nothing dispatched; outbox rows accumulate harmlessly |
| Error reporting | Sentry when configured | absent |
| AI | provider keys | absent; `FEATURE_IDARA_INTELLIGENCE` off |
| E-invoicing / country authorities | fail-closed registries | flags off; only preview/simulated paths |
| Billing | provider webhook | no provider |

---

## Part L / Part M facts read during Part A (read-only, production)

### Stalled background jobs

`public.domain_event` in production: **11 rows, all unprocessed, all
`attempts = 0`**, all from one organisation on 2026-09-01:

| Event | Count | Consumer that would run |
| --- | --- | --- |
| `approval/submitted` | 3 | none (informational) |
| `approval/decided` | 3 | `payment-reconcile-on-decision` |
| `goods_receipt/recorded` | 2 | `cost-rollup-on-goods-receipt` |
| `job/created` | 1 | none (informational) |
| `purchase_order/approved` | 1 | `lpo-pdf-renderer` (renders and stores a PDF) |
| `quote/accepted` | 1 | `quote-pdf-renderer` (renders and stores a PDF) |

`attempts = 0` is the whole diagnosis: the relay never ran. The relay is itself
an Inngest cron (`outbox-relay`, every minute), and Inngest is unprovisioned in
production (`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` unset; `/api/inngest`
answers `503 inngest_unconfigured`). No worker sends email. Full classification
and replay preview: `docs/H33-INNGEST-READINESS.md`.

### PO-002 (Najolatech)

Status `received`; one line "screws ss316" × 34 pcs @ 0.10; GRN-001 received 20
and GRN-002 received 14 (34 in total, both `recorded`, none damaged or
rejected); the organisation has **0 warehouses, 0 locations, 0 units, 0 stock
movements, 0 balances** — the receipts could never post. Repair preview:
`docs/H33-PO-002-REPAIR-PREVIEW.md`. Nothing modified.

---

## Part A — decisions recorded

1. **A new generator, not the old factory.** `tooling/simulation/` is a mature,
   marker-guarded factory — but it is hard-wired to the **production** project
   ref, covers only the early core (customers, suppliers, items, employees,
   jobs, reports, quotes, invoices, payments), and writes rows one at a time.
   H33 builds `tooling/pilot-lab/` for the **test** project only, reusing the
   factory's pure utilities (`rng`, `dates`, `money`, `uuidv5`) and its two
   proven ideas: a marker in `app_settings` that alone authorises writes and
   deletes, and find-or-create idempotency keyed on that marker.
2. **Marker:** `app_settings.key = 'h33.pilot_lab'`, value
   `{ is_h33_pilot_lab: true, seed_version, company_key, generated_at }`.
   Every auth user is `h33.<company>.<persona>@pilot-lab.invalid`.
3. **Deterministic identity:** every row id is `uuidv5("h33:<seed_version>:<company>:<family>:<n>")`,
   so a second run finds the same ids and `ON CONFLICT DO NOTHING` makes the
   seed idempotent by construction, not by bookkeeping.
4. **Checkpoints:** per (company, family) in `app_settings` under
   `h33.checkpoint.<family>` and mirrored to a local, gitignored
   `.pilot-lab/state.json`; an interrupted run resumes at the first
   incomplete family.
5. **Budget stop:** `pg_database_size` checked after every family; refuse past
   300 MB.
6. **Cleanup:** deletes exactly the orgs carrying the H33 marker with the exact
   seed version, requires the test project ref and an explicit phrase, and
   refuses if fewer or more than five marked orgs are found.
