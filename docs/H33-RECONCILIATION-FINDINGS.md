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

Every mismatched plan is stale by exactly one service interval: `last_done_on`
2025-11-08 against a newest event of 2026-05-07, and so on for eighteen plans.

The product is right and the caller is wrong. `recordMaintenance` updates the
plan's `last_done_on` and recomputes `next_due_on` — but only when the caller
passes `advancePlan`, which is a sensible default, because recording a
historical event should not move a live schedule. The lab records the NEWEST
event and never asks the plan to advance, so every plan the service touched
kept the date the bulk insert gave it.

**Fix:** pass `advancePlan: true` in the assets service call. One line, and the
plans then agree with their own events and due dates.

### One Studio edge cites a dependency that is not there

Traced. Of 1,220 edges, 8 were offered for materialisation and 2 carry a
`task_dependency_id`. One of those two cites `a1112bf5-…`, which does not
exist at all — not soft-removed, absent. Both ids are v4 UUIDs, so they came
from the product's own service rather than the lab's deterministic v5 scheme.

So the lab recorded the id the service returned onto the edge, and the
dependency it names was never committed: the pointer outlived the row it points
at. Writing a foreign id optimistically, outside the transaction that creates
it, is the whole bug.

**Fix:** record `task_dependency_id` only after confirming the row is there —
read it back, or do both writes in one transaction. Least consequential of the
six (it degrades one Studio panel) but the most clearly wrong.

---

## Order of work

Verify-only fixes are safe while the seed is still running; generator fixes are
not, because they would give the last two companies different data from the
first three. So:

1. **Now:** the checks in group A, and the `hr` expectation in group B — all of
   them live in `verify()` and change no row.
2. **After the seed completes:** the six data findings, then re-seed only the
   families affected, for all five companies, with `reset-family`.
