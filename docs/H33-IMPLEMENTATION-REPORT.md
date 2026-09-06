# H33 — Full-scale pilot simulation: implementation report

**Phase.** H33 — Full-Scale Pilot Simulation and Launch Readiness Closure.
**Branch.** `verify/h33`.
**Where it lives.** The isolated test project `zwnnqaryouevnzuwtyaj`, only.

Companion documents: [H33-DATA-MANIFEST.md](H33-DATA-MANIFEST.md) (what exists,
counted from the database), [H33-SECURITY-AND-ISOLATION-REPORT.md](H33-SECURITY-AND-ISOLATION-REPORT.md)
(what keeps it contained), [H33-PERFORMANCE-REPORT.md](H33-PERFORMANCE-REPORT.md)
(how it behaves at size), [H33-PILOT-LAB.md](H33-PILOT-LAB.md) (how to open it),
[H33-MANUAL-ACCEPTANCE.md](H33-MANUAL-ACCEPTANCE.md) (what to try).

---

## 1. What was built

A **Pilot Lab**: five fictional companies, each with several years of coherent
operating history, in the isolated test project. Not a demo script — a working
dataset the owner can sign into as any of nine roles and use as a customer
would.

The generator is fifteen families, each owning one slice of a company's life and
declaring what it depends on:

| | Family | What it writes |
| --- | --- | --- |
| 1 | `setup` | The organisation's shape: departments, warehouses, units, calendars, chart of accounts, pipelines, folders, branding |
| 2 | `people` | Employees, contracts, compensation, skills, the employment history |
| 3 | `masters` | Customers, suppliers, the catalogue, bills of material |
| 4 | `work` | Jobs and projects, stages, crews, tasks, daily reports, issues, approvals, week plans |
| 5 | `sales` | Quotes, invoices, credit notes, payments, receipts, dunning, shares |
| 6 | `supply` | Material requests, purchase orders, goods receipts, supplier returns |
| 7 | `stock` | The movement ledger, balances, cost layers, counts, transfers, reservations |
| 8 | `crm` | Territories, campaigns, leads, opportunities, activities, forecasts, scenarios |
| 9 | `hr` | Attendance, leave, claims, advances, pay runs, payslips, candidates |
| 10 | `assets` | The register, custody, inspections, maintenance, downtime, disposals, depreciation |
| 11 | `studio` | Management Studio plans, nodes, edges, baselines, versions, scenarios |
| 12 | `docstudio` | Templates, documents in every status, revisions, snapshots, the evidence chain, signatures, obligations, forms |
| 13 | `finance` | Recurring journals, budgets, manual month-end journals, bank statements and reconciliation, VAT working papers |
| 14 | `country` | Country packs, e-invoicing and AI — in their OFF states, provably |
| 15 | `misc` | Notifications, activity, comments, exceptions, digests, imports, files, sign-ins, holidays |

## 2. The laws the generator holds itself to

- **One door.** `guard.ts` refuses any connection that is not the test project.
  No override flag exists.
- **Everything marked.** `app_settings.key = 'h33.pilot_lab'` on every lab
  organisation. Nothing is written to an organisation without it; nothing
  without it is ever deleted.
- **Deterministic identity.** Every id is UUID v5 over (seed version, company,
  family, ordinal). Idempotency is a property of construction, not of a
  de-duplication pass.
- **Legal states only.** Where the database enforces a state machine, the
  generator drives the product's own services and functions rather than
  inserting the end state. Journals are created as drafts and posted through
  `app.post_journal_entry`; assets are born `draft` and walked; stock is
  append-only and cites its source; pay runs move through review.
- **Budgeted.** The seeder stops rather than pass 300 MB, checked after every
  family.
- **Resumable.** A checkpoint per (company, family), plus a progress marker
  inside each service phase, so an interruption resumes rather than repeats.

## 3. Defects this phase found and fixed

Every one of these was found by building the thing, not by reading it.

**D1 — Purchase orders could not be printed at all.** `purchase_order` was
never registered as a document kind, so the document route 404ed and the screen
said "PDF pending" for ever. It now renders on demand through the same
model → HTML → PDF pipeline as every other document, in English and Arabic, with
the issuer, supplier, lines, totals and dates. Eight regression tests, including
one that asserts the downloaded bytes really begin `%PDF-`.

**D2 — The repository's secret-scanning allowlist had never worked.** gitleaks
matches allowlist regexes against the *secret*, not the whole line, so the
`key: "..."` patterns the file was built around could never fire. Five findings
repo-wide were being suppressed by luck rather than by the allowlist. Fixed with
`regexTarget = "match"` and patterns that match what is actually scanned.

**D3 — Unit tests were silently connecting to the test database.** Importing
`run.ts` for one exported helper executed the whole orchestrator. In CI it
exited 1; locally it had been opening a database connection on every unit-test
run. Guarded like `migrate.ts`.

**D4 — The batch writer never actually worked.** Postgres infers a parameter's
type from its cast, so `$1::json` declared the parameter as json and postgres.js
JSON-encoded the already-stringified payload a second time — the server received
one JSON string where an array of rows was meant. Casting through
`$1::text::json` sends and parses it once. Nothing caught it earlier because the
unit tests substitute an in-memory insert and a dry run writes nothing: the
first real exercise of that function was the seed itself.

**D5 — A relabelled job kept the wrong history.** The generator guarantees that
every job category appears, by converting a job when a category did not come up
naturally. It changed the label without touching the stages, tasks and daily
reports that job had already accumulated, so a `draft` job could carry completed
stages and a fortnight of site diaries. Invisible at the original scale because
every category came up on its own. A conversion now prefers a job whose content
already suits the category, and otherwise brings the content into line.

**D6 — Two invented vocabularies.** `supplier_return_line.disposition` as
"return_to_supplier" where the schema allows accepted / damaged / quarantine,
and `stock_reservation.status` as "consumed" where a fulfilled reservation is
"issued". Both failed at insert time, deep into a slow seed. The dry run now
loads every single-column enumeration from `pg_constraint` and checks every
generated value against it, so this class of mistake is caught in seconds
instead of minutes.

**D7 — A handoff read as the wrong shape.** `supply` and `stock` read the
catalogue as an array where `masters` hands it over as a map keyed by item id. A
live seed would have died at `supply` — the first family after `sales`. The unit
tests were green only because their fixtures had been written against the same
wrong shape; both now mirror the real contract.

## 4. What the scale-down cost, and what it did not

The first whole-chain dry run projected ~437,000 rows ≈ 500 MB against a 300 MB
ceiling. The five volume profiles were rescaled to ~198,000 rows ≈ 227 MB.

Scaling down starved a dozen things that had been met by volume alone: a company
with fewer than twenty manufactured parents kept only active bills of material,
a company whose work is mostly closed had no approvals waiting, a sixty-week
plan board missed its one cancelled week. Each is now met **by construction** —
deterministic top-ups that walk in index order and consume no randomness — so
every state a pilot needs to look at is present at any scale.

What the smaller size does change, honestly stated: the operations boards carry
tens of open jobs rather than hundreds, and only one company crosses the 1,205
row pagination boundary on each major surface. That is the deliberate trade: one
company past the boundary proves the pagination, and five would have cost half a
gigabyte.

## 5. Verification

| Gate | Result |
| --- | --- |
| Unit tests (`tests/unit/pilot-lab-*`) | 1,195 across the fifteen families |
| Typecheck, lint, format | clean |
| Value vocabularies vs `pg_constraint` | every generated value satisfies the schema |
| Dry run | all fifteen families, all five companies, no family unestimated |
| Seed | see the data manifest |
| Reconciliation (`npm run lab:verify`) | see §6 |
| Tenant isolation (`npm run test:lab`) | see the security report |
| Production residue (`npm run lab:residue-check`) | see the security report |

## 6. Reconciliation

Filled from `npm run lab:verify` once the seed completed — see the data
manifest for the counts and this section for the checks that compare them
against each other (ledger balance, stock ledger against balances, payroll
against its lines, receivables against the invoices, the document evidence
chain, and the absences the `country` family exists to prove).

## 7. What H33 deliberately did not do

- No pilot customer was invited; no real person was contacted.
- No legally gated feature was enabled in production; AI, country packs,
  Spanish and authority submission remain off.
- No tax, invoice or report was submitted to any authority.
- PO-002 was not touched. The remedy exists and is idempotent; it has not been
  run.
- No production record was read, written or copied.
