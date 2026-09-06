# H33 — Full-scale pilot simulation: implementation report

**Phase.** H33 — Full-Scale Pilot Simulation and Launch Readiness Closure.
**Branch.** `verify/h33`.
**Where it lives.** The isolated test project `zwnnqaryouevnzuwtyaj`, only.

Companion documents: [H33-DATA-MANIFEST.md](H33-DATA-MANIFEST.md) (what exists,
counted from the database), [H33-SECURITY-AND-ISOLATION-REPORT.md](H33-SECURITY-AND-ISOLATION-REPORT.md)
(what keeps it contained), [H33-PERFORMANCE-REPORT.md](H33-PERFORMANCE-REPORT.md)
(how it behaves at size), [H33-RECONCILIATION-FINDINGS.md](H33-RECONCILIATION-FINDINGS.md)
(what verification found, and why), [H33-PILOT-LAB.md](H33-PILOT-LAB.md) (how to
open it), [H33-MANUAL-ACCEPTANCE.md](H33-MANUAL-ACCEPTANCE.md) (what to try).

---

## 1. What was built

A **Pilot Lab**: five fictional companies, each with about three years of
coherent operating history, in the isolated test project. Not a demo script — a
working dataset the owner can sign into as any of nine roles and use as a
customer would.

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

## 3. What this phase found

Fifteen defects, and every one was found by **running** something — not by
reading code. Nine of them were only reachable once a real database was on the
other end.

### Shipped as its own fix

**D1 — Purchase orders could not be printed at all.** `purchase_order` was never
registered as a document kind, so the route 404ed and the screen said "PDF
pending" for ever. It now renders through the same model → HTML → PDF pipeline as
every other document, in English and Arabic, with the issuer, supplier, lines,
totals and dates. Eight regression tests, including one asserting the downloaded
bytes really begin `%PDF-`.

**D2 — A product defect in Studio: an edge could name a dependency that was
never written.** Two causes, and the second needs no transaction trouble at all:
`addEdge` materialised the dependency by calling `addDependency(ctx, …)` from
*inside* its own transaction, so the two writes could not commit or fail
together; and `addDependency` inserts with `on conflict … do nothing` but
returned the uuid it had just minted rather than the row's, so asking twice for
the same dependency handed back an id that had never been inserted. Four such
edges existed in the lab. Fixed with `addDependencyIn(tx, …)`, which returns the
id of the row that actually exists; all three Studio call sites now use it. The
regression test was verified by reinstating the old behaviour — it fails with
the bug and passes without it.

### Repository and tooling

**D3 — The secret-scanning allowlist had never worked.** gitleaks matches
allowlist regexes against the *secret*, not the line, so the `key: "..."`
patterns the file was built around could never fire. Five findings repo-wide
were being suppressed by luck. Fixed with `regexTarget = "match"`.

**D4 — Unit tests were silently connecting to the test database.** Importing
`run.ts` for one exported helper executed the whole orchestrator. In CI it
exited 1; locally it had been opening a database connection on every unit-test
run.

### Only a real database could have found these

**D5 — The batch writer had never worked.** Postgres infers a parameter's type
from its cast, so `$1::json` made postgres.js JSON-encode the already-stringified
payload a second time — the server received one JSON string where an array of
rows was meant. `$1::text::json` sends and parses it once. The unit tests
substitute an in-memory insert and a dry run writes nothing, so the seed was the
first real exercise of that function.

**D6 — Four classes of value the schema refuses.** An invented vocabulary
(`supplier_return_line.disposition`, `stock_reservation.status`), a missing
required value (`stock_movement.idempotency_key`, `stock_cost_layer.currency`,
`candidate.requisition_id`), a negated figure (`pay_run.employer_total_minor` —
a reversal carries the same money, because the sign lives in `run_kind`), and a
column that is not there (`stock_movement_lot.qty_delta`, which is `qty`).

Rather than keep discovering these one slow seed at a time, **the dry run now
lints against the live schema**: every single-column enumeration and sign floor
from `pg_constraint`, every NOT NULL column without a default, and every column
of every table. It turned a five-minute failure cycle into a five-second one and
reports clean across all fifteen families and five companies.

**D7 — Deferred constraint triggers need one transaction.**
`stock_movement_tracking_is_complete` fires at commit and counts the lots or
serials a movement names; inserting one table per statement committed the
movements before any link row existed, so it refused every tracked movement.
`insertGroup` writes such tables together.

**D8 — `created_at` is when the row was written, not when the event happened.**
Backdating `stock_movement.created_at` made every movement look already-posted,
and the tracking triggers refuse to attach units to a posted movement.

**D9 — Tracked stock has to name what it moves.** Serials were minted but never
linked; lots were attached on a coin flip regardless of whether the item was
lot-tracked. Both now follow the catalogue, and tracked items are received and
held rather than issued, so no movement can be short of what it must name.

**D10 — A relabelled job kept the wrong history.** The guarantee that every job
category appears converted a job's label without touching the stages, tasks and
daily reports it had already accumulated, so a `draft` job could carry completed
work. Invisible at the original scale because every category came up naturally.

**D11 — A handoff read as the wrong shape.** `supply` and `stock` read the
catalogue as an array where `masters` hands over a map keyed by item id. The unit
tests were green only because their fixtures had the same wrong shape.

**D12 — Pointers to rows written later.** `doc_document.working_revision_id` and
`issued_snapshot_id` are foreign keys to rows the same family writes afterwards,
and neither constraint is deferrable. The product has the same problem and
solves it the same way: create, then point.

**D13 — A budget is born a draft**, because approving one is what freezes its
figures; `budget_line_frozen` refuses a line on anything else.

### Found by reconciliation, after the data existed

**D14 — A comment that lied, and a plan that believed it.** Maintenance
occurrences are generated by a loop counting **down** in days-ago from
registration toward today, so its first entry is the OLDEST. The comment above
it said "latest first", and `last_done_on = dayAgo(occ[0])` took it at its word:
every plan with more than one service claimed its first as its last, and
`next_due_on` inherited the error. Now `dayAgo(Math.min(...occ))`.

Worth recording that **the first diagnosis of this was wrong**, and published
before it was checked: that the lab had omitted `advancePlan` when recording
each plan's newest event. `advancePlan` is
`z.boolean().optional().default(true)` — already on, and never capable of
causing this. Checking the claim is what produced the dates that made the real
cause obvious (`last_done` equal to the plan's oldest event in every sampled
row). The corrected account is in the findings document.

**D15 — Two families writing one payroll calendar.** `setup` owns the pay group
and its periods; `hr` was minting a second series at thirty-day intervals onto
the same group — 61 periods for gulfbuild where 37 are real, 48 overlapping a
neighbour. Two periods covering the same fortnight make "what was paid for
September" unanswerable. `hr` now cites setup's months.

**D16 - The repair tool would have deleted every payroll calendar.** Its
preview reported 122 of about 122 pay periods as ones `setup` did not derive.
`setup` mints them as `ctx.id(FAMILY, "pay_period", start)`, which is
`labId(key, "setup", "pay_period", start)`; the repair recomputed
`labId(key, "pay_period", start)`, one segment short, so every genuine period
derived a different uuid and looked like an orphan. `--confirm` would have
deleted the whole calendar of every lab company and the pay runs citing it,
and `pay_run` is append-only, so nothing but a rebuild would have brought it
back.

It was caught by running the preview instead of trusting the tool that had
been written to fix something else. A destructive tool now also refuses when
the rows it wants to delete are ALL of the rows, because that is the signature
of a derivation that has drifted from the generator, never of bad data.

**D17 - The lab was dismissing almost no exceptions, and its own check hid
it.** saudimfg verified 0 dismissed against a target of 3. Two compounding
causes: age resolves most exceptions, so the pool of open, manager-visible
rows had fallen to 2 / 1 / 0 across the companies; and the candidate walk then
took every THIRD of that pool. The check asked only for `>= 1`, so gulfbuild
passed at 2 of 3 and tradeline at 1 of 7 - the weak floor this phase had
already written a law about, sitting in its own code. Now met by construction
(re-open the first few manager-visible exceptions in index order, consuming no
randomness), every candidate walked, and the target asserted in the family and
in a unit test that fails on all five companies with the stride reinstated. A
skipped dismissal now logs the error's message; it logged `.name`, which is
"Error" for everything, and that is why it stayed invisible.

**D18 - A demoted report kept its inventory deductions.** Two facilico
material lines were flagged as having deducted stock on reports whose status
is "returned". The generator gates that flag on submitted-or-reviewed, but the
top-up guaranteeing every report status appears demotes a submitted report
without taking the deduction with it - so the diary showed stock moved by a
report nobody had accepted. The same shape as D10, and only facilico has
enough reports to reach that top-up.

**D19 - A correct fix emptied a screen.** Taking `last_done_on` from the
plan's newest event instead of its oldest (D14) moved every due date forward
with it, and consult - the smallest asset register - was left with no overdue
maintenance at all. The due list is a screen the owner opens; an empty one
shows nothing. The generator now shifts one plan's history back by an interval
so a company always has something due, walked in index order and consuming no
randomness.

It SHIFTS the dates rather than truncating the series, and that distinction
cost a round trip: the first attempt replaced the occurrence list with a single
entry, which changed how many rows the family plans. The checks compare seeded
counts against a plan recomputed from the build, so nine of them began failing
on data that was perfectly fine. **Changing a generator after the seed makes
the verifier's expectations disagree with the data** - a family can only be
changed after seeding if the change leaves the row counts alone, or if the
family is re-seeded.

The repair that went with it was wrong too, and is worth recording rather than
quietly fixing: it forced `next_due_on` into the past, which broke the
family's own invariant that a serviced plan's next due date is its last
service plus its interval. It was removed and replaced by a repair that
restores that invariant.

**consult keeps the empty due list in this build.**
`asset_maintenance_event` is append-only at the database, so the seeded history
cannot be moved and the company cannot be re-run; only a full rebuild would
correct it. The check is left failing rather than relaxed.

### Found, reproducible, and NOT explained

**One Studio scenario refuses to apply.** facilico plans three scenario
applications through the real services; two succeed and the third stops at
`approved`. Driving `applyScenario` directly returns
`date outside scheduling window: 2027-03-17`.

What was checked and ruled out: it is **not** drift - every change the
scenario records still matches the node's current value, which is the
condition `applyScenario` tests before that point. It is **not** an obviously
short horizon either: the engine sizes its working-day window as
`min(max(totalDur * 2 + 260, 400), 15000)` working days from the earliest
dated input, which for facilico's four plans is 992-1,304 working days,
roughly four to five years, and every plan's own span (2025-03 to 2027-06)
sits inside that.

So the refusal is real and reproducible, and the cause is **not established**.
It is recorded here rather than guessed at, because two diagnoses in this
phase were published before they were checked and both were wrong. The check
is left failing rather than relaxed - it is reporting something true. Whether
this is a product limit worth fixing or lab data worth changing is an open
question, and the reproduction above is enough to answer it.

## 4. What the scale-down cost, and what it did not

The first whole-chain dry run projected ~437,000 rows ≈ 500 MB against a 300 MB
ceiling. The five volume profiles were rescaled to ~195,000 rows; the first
complete seed wrote 156,019 and took the database to 160 MB, so the 1,200 B/row
estimate was conservative by nearly half.

Scaling down starved a dozen things that had been met by volume alone: fewer
than twenty manufactured parents kept only active bills of material, a company
whose work is mostly closed had no approvals waiting, a sixty-week plan board
missed its one cancelled week. Each is now met **by construction** —
deterministic top-ups that walk in index order and consume no randomness — so
every state a pilot needs to look at is present at any scale.

What the smaller size does change, stated plainly: the operations boards carry
tens of open jobs rather than hundreds, and only one company crosses the 1,205
row pagination boundary on each major surface. That is the deliberate trade —
one company past the boundary proves the pagination, and five would have cost
half a gigabyte.

## 5. Verification

| Gate | Result |
| --- | --- |
| Unit tests | 2,897 across the repository, 1,195 of them the lab's own |
| Typecheck, lint, format | clean |
| Value vocabularies vs the live schema | every generated row satisfies it |
| Dry run | all fifteen families, all five companies |
| Seed | five companies, fifteen families each — see the data manifest |
| Idempotency | a second seed writes nothing; every family checkpointed and skipped, database unchanged |
| Reconciliation | 2,115 / 2,124 on the first build; see §6 |
| Tenant isolation | 8 / 8 |
| Production residue | 0 |
| CI | green on the branch |

## 6. Reconciliation, and the rebuild

The first complete seed verified at **2,115 / 2,124** checks. The nine failures
are set out with their diagnoses in
[H33-RECONCILIATION-FINDINGS.md](H33-RECONCILIATION-FINDINGS.md): three lab
defects, two checks that asserted more than the product promises, one product
defect, and three smaller data observations.

Two of the fixes could be applied to the rows that already existed, and were: 62
maintenance plans recomputed from their own events, and 4 dangling Studio edges.
The payroll calendar could not — `pay_run` is append-only by trigger, so the
runs citing the overlapping periods, and the periods themselves, cannot be
removed.

**The owner chose a clean rebuild.** The five companies were deleted through the
guarded cleanup — exactly five organisations and their 45 logins, nothing else —
and seeded again with every fix in place, so the current lab has one payroll
calendar per company, plans that agree with their own events, and no dangling
edges, corrected at source rather than after the fact.

## 7. Two "leaks" that were the policy working

The isolation sweep reported a restricted foreman reading 22 payslips and 25
pay-run lines. Neither is a leak. Both policies read "cost wall **or** the
employee's own row", and the migration for `pay_run_line` says so in as many
words: *"the line that pays THEM, and nobody else's."* The lab holds 946
payslips across 43 employees — exactly 22 each — so 22 is precisely one person's
own.

Asserting zero was asserting against the product's stated design. The check now
asserts the half that matters: a restricted employee sees their own rows and not
one belonging to anybody else, which is a stronger claim than the one it
replaced.

## 8. What H33 deliberately did not do

- No pilot customer was invited; no real person was contacted.
- No legally gated feature was enabled in production; AI, country packs,
  Spanish and authority submission remain off.
- No tax, invoice or report was submitted to any authority.
- PO-002 was not touched. The remedy exists and is idempotent; it has not been
  run.
- No production record was read, written or copied.
- Payments are not approval-gated in this lab. `approval_rule.subject_type`
  allows it and the engine would gate them if a rule existed, but the lab
  configures approval for task completions and asset disposals instead — a
  configuration a real organisation may equally choose.
