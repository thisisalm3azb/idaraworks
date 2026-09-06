# H33 — reconciliation findings

`npm run lab:verify` after the seed. Working notes; the settled version of this
lives in the implementation report.

First full pass on **gulfbuild**: **410 / 422 checks ok**, twelve failures.

They divide into two kinds, and the difference matters: a check that is wrong
tells you nothing about the data, and a check that is right tells you the data
is wrong. Six of each.

---

## A — the check is wrong: families share tables

`approval`, `customer_update`, `share_token` and `task_dependency` are each
written by more than one family, but each family's count check counts **every**
row in the organisation. The counts are not wrong; the expectations are.

| Check | Live | Planned | Also written by |
| --- | ---: | ---: | --- |
| `work: approval count` | 28 | 22 | assets, sales |
| `assets: approval count` | 28 | 4 | work, sales |
| `sales: count customer_update` | 25 | 12 | misc |
| `sales: count share_token` | 12 | 8 | misc |
| `work: task_dependency count` | 153 | 152 | studio (materialises one) |

**Fix:** scope each check to the rows the family actually owns —
`approval` by `subject_type`, `customer_update` and `share_token` by the ids the
family handed on — or assert a floor rather than an equality where the
discriminator does not exist. An equality check on a shared table is a check
that will fail every time another family touches it.

## B — the check is right: the data is wrong

| Check | What it found |
| --- | --- |
| `hr: the reversal mirrors the run it reverses` | The family's own `verify()` still expects the negated amounts that the schema refuses. The generator and its unit test were corrected; this was missed. |
| `studio: materialised dependencies cite live task_dependency rows` | 2 materialised of 8 attempted, **1 dangling** — a Studio edge cites a `task_dependency` row that is not there. |
| `assets: a plan's last_done_on is the date of its latest event` | **18 rows** where a maintenance plan's `last_done_on` disagrees with its most recent event. |
| `sales: service sample: approvals opened for payments` | **0 of 16.** Every recorded payment should have opened a pending approval; none did. |
| `sales: service sample: outbox events` | 39 of 55 domain events. |
| `finance: the reconciliation matched something and left something unmatched` | **0 matched of 3** statement lines. The bank statement was built from ledger movements, but the account has none of its own, so nothing could match. |
| `setup: monthly pay periods are contiguous through as-of` | 61 periods, with a gap or an overlap. |

---

## Diagnoses so far

### The two sales failures are one cause

The sales family expects every recorded payment to open a pending approval,
and its comment says the work family installs a `payment` rule for that. It
does not: work installs exactly one rule, for `task_completion`. So no payment
is approval-gated, no approval opens, and the sixteen `approval/submitted`
domain events that would have followed are never emitted either —
**55 − 39 = 16, exactly the number of payments.** One missing rule, two failing
checks.

The product is not at fault: `approval_rule.subject_type` allows `payment`,
and the engine would gate them if a rule existed. The lab simply never
configured one.

Adding the rule now would mean re-running `work` AND the `sales` service phase
for all five companies — most of the lab — to gain a queue the Approvals screen
already demonstrates through task completions and asset disposals. The
proportionate fix is to correct the expectation and say plainly that payments
are not approval-gated in this lab, which is a legitimate configuration a real
organisation may also choose.

### The bank reconciliation matched nothing because there was nothing to match

The statement is built from ledger lines on the bank account, and gulfbuild has
none: payments in this configuration do not post to the bank control account.
So the three synthetic lines — a fee, interest, an unidentified deposit — are
all that exist, and all are unmatched. The check should assert what is true:
where the ledger has bank movements some must match, and where it has none the
statement is entirely unreconciled, which is itself a state worth showing.

### The payroll calendar has two families writing it

gulfbuild has **61 pay periods on one pay group, 48 of them overlapping**:
a monthly series and a semi-monthly one interleaved —
`2024-09-30` is followed by `2024-09-16`.

setup plans 37 periods; hr plans 24; 37 + 24 = 61. Both write `pay_period`,
and hr attaches its own to setup's ACTIVE pay group, so a pilot opening the
payroll calendar sees overlapping periods on the same group. The hr family's
own comment says *"setup owns the pay group and its periods; this family adds
the runs"* — the comment is right and the code is not.

**Fix:** hr stops writing `pay_period` and takes setup's from the handoff it
already receives (`payGroups.periods`), so its pay runs cite the calendar that
already exists. Overlapping periods are not a cosmetic problem: a pay run names
the period it covers, and two periods covering the same fortnight make the
question "what was paid for September" unanswerable.

### A maintenance plan that never learns its own history

Every mismatched plan carries, as its `last_done_on`, the date of its OLDEST
event rather than its newest — `last_done` 2024-12-19 against a newest event of
2025-12-14, over five events; 2026-02-17 against 2026-08-16; and so on for
eighteen plans.

**This diagnosis is the second one.** The first, recorded here and acted on, was
that the lab's assets service call omitted `advancePlan` and so never asked the
plan to move. That was wrong, and checking it is what found the real cause:
`advancePlan` is `z.boolean().optional().default(true)` in
`src/modules/assets/lifecycle.ts` — it was already on, and omitting it had never
been capable of causing this. The service path is not involved at all: it mints
its own plan with a single event, which cannot disagree with itself.

The real cause is in the lab's bulk insert, and it is a comment that lied to the
code beneath it. Occurrences are generated by a loop that counts **down** in
days-ago from registration toward today, so `occ[0]` is the OLDEST occurrence
and the last entry is the most recent. The comment above it said "latest first",
and `const lastDone = clock.dayAgo(occ[0]!)` believed it. Every plan with more
than one occurrence was therefore born claiming its first service as its last,
with `next_due_on` derived from that same wrong date.

**Fix:** `clock.dayAgo(Math.min(...occ))` — the most recent occurrence is the
smallest days-ago, not the first — and the comment corrected to describe the
order the loop actually produces. `next_due_on` derives from `lastDone` and is
fixed with it. `advancePlan: true` stays in the service call as an explicit
statement of intent, not as a fix.

**What this cost:** the fix was found after the clean rebuild had already
started, and a module already loaded cannot be changed under a running process,
so all five companies were seeded with the bug and repaired afterwards by the
marker-scoped `lab:repair`, which recomputes `last_done_on` and `next_due_on`
from each plan's own newest event. The generator is correct at source for any
future seed; this build's plans were corrected after the fact. That is stated
here rather than glossed, because the manifest counts a repaired lab, not a
lab that was born right.

### One Studio edge cites a dependency that is not there

Traced. Of 1,220 edges, 8 were offered for materialisation and 2 carry a
`task_dependency_id`. One of those two cites `a1112bf5-…`, which does not
exist at all — not soft-removed, absent. Both ids are v4 UUIDs, so they came
from the product's own service rather than the lab's deterministic v5 scheme.

**This one is the product, not the lab.** The lab does not write
`task_dependency_id` at all — it calls `addEdge`, and the product sets it.

`addEdge` runs inside its own `command(ctx, …)` transaction, and from within
that callback it calls `addDependency(ctx, …)` — passing the CONTEXT, not the
transaction. `addDependency` therefore opens a transaction of its own, and
there is no `addDependencyIn(tx, …)` variant to call instead. So the two writes
are not atomic: the edge records an id produced outside the transaction that
inserts it, and the edge can outlive the dependency it names. That is precisely
the state found — an edge citing `a1112bf5-…`, a row that is not there.

Nesting one `command(ctx, …)` inside another on the same context is itself
worth a look: depending on how the tenancy layer hands out connections it
either opens a second connection to the same rows or creates a savepoint that
can roll back under a committing parent.

**Proposed product fix:** add `addDependencyIn(tx, ctx, …)` and have `addEdge`
call it, so the dependency and the edge that names it commit together. Small
and well understood, but it touches a product module and needs its own tests
and a CI run — the owner's call whether it lands in this phase.

**Lab repair meanwhile:** null the dangling `task_dependency_id`, so the Studio
panel does not cite a row that is not there.

---

### Five surfaces answered 404, and the cause was a stale build cache

The first performance run reported HTTP 404 on `finance/journals`,
`finance/reports`, `finance/tax`, `revenue/pipeline` and `revenue/forecast`,
while every other surface answered 200. Signed in as the owner, the browser
showed Next's own "This page could not be found" — not the module-unavailable
card, so it was not `ModuleGate`.

**Two wrong diagnoses came before the right one**, and both are recorded because
each cost time that a cheaper check would have saved:

1. *The launcher fails to pass the flags on Windows.* `open.ts` spawns
   `next dev` through `npx.cmd` with `shell: true`, which looked like a
   plausible way to lose environment. It was rewritten to spawn Next's resolved
   bin with `process.execPath` and no shell — and the surfaces still 404ed. The
   change was reverted, because the code it replaced was not at fault.
2. *The organisation has the modules switched off.* Both subtrees do sit behind
   a `ModuleGate` for `cap.finance` and `cap.revenue_studio`, which made the
   correlation look decisive — those were the only two subtrees with such a
   layout. But `ModuleGate` renders a calm unavailable state, never a 404, so it
   could not have produced what we saw.

**The actual cause: a corrupted `.next` development cache.** Two pieces of
evidence pointed at it once they were put together — `tsc` was reporting syntax
errors inside the generated `.next/dev/types/routes.d.ts`, and a temporary probe
route added under `src/app/api` never compiled at all. A dev server with a
damaged route manifest serves some routes and 404s others, which is exactly the
pattern. Deleting `.next` and restarting turned all five into a normal 307.

**What it means for the lab:** nothing is wrong with the product, the launcher
or the seeded organisations, and no fix was needed. What it changes is the
instructions: an owner who opens the lab on a stale cache would conclude that
finance and revenue are missing from the product. Clearing `.next` before a
session is now in the owner checklist, and the first performance run — measured
against that damaged cache — was discarded and taken again.

## Remediation plan

Most of these are REPAIRS, not re-seeds. That matters: a re-seed of a
checkpointed family costs its whole service phase, and four of the six do not
need one.

| # | Fix | Kind | Cost |
| --- | --- | --- | --- |
| 1 | sales: payments are not approval-gated in this lab | verify only | none |
| 2 | finance: assert what is true when the bank account has no ledger movements | verify only | none |
| 3 | assets: take the NEWEST occurrence for `last_done_on` (`Math.min(...occ)`), and repair the 18 stale plans from their own newest event | code + repair | one statement |
| 4 | studio: null the dangling `task_dependency_id` (lab repair); the underlying defect is in the product's `addEdge` | repair + product finding | one statement |
| 5 | hr: stop writing `pay_period`; take setup's from the handoff | code + **re-seed hr** | hr is all bulk, no service phase — seconds per company |
| 6 | work/sales: consider a `payment` approval rule in a later seed version | deferred | would re-run most of the lab |

### What makes the hr re-seed safe

hr's pay runs cite hr's own periods, so the overlapping periods cannot simply
be deleted — the runs would lose their foreign key. The family has to be
rebuilt. Two guards stand in the way and both are answerable:

- **The checkpoint.** `reset-family` refuses a checkpointed family, because
  undoing one usually strands the families that depend on it. Only `finance`
  declares `hr`, and it declares it for ORDERING — it reads no hr handoff, only
  setup's. So nothing is stranded, and the reset may drop the checkpoint in the
  same transaction.
- **The delete guards.** `expense_claim_line` refuses deletion for a paid
  claim. Reset only the payroll tables — `--tables=payslip,pay_run_line,pay_run,pay_period`
  — and leave attendance, leave and claims where they are; the generator
  re-derives them identically, so `ON CONFLICT DO NOTHING` makes the re-run a
  no-op for everything else.

## Order of work

Verify-only fixes are safe while the seed is still running; generator fixes are
not, because they would give the last two companies different data from the
first three. So:

1. **Now:** the checks in group A, and the `hr` expectation in group B — all of
   them live in `verify()` and change no row.
2. **After the seed completes:** the six data findings, then re-seed only the
   families affected, for all five companies, with `reset-family`.
