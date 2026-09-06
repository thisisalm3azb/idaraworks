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

## Order of work

Verify-only fixes are safe while the seed is still running; generator fixes are
not, because they would give the last two companies different data from the
first three. So:

1. **Now:** the checks in group A, and the `hr` expectation in group B — all of
   them live in `verify()` and change no row.
2. **After the seed completes:** the six data findings, then re-seed only the
   families affected, for all five companies, with `reset-family`.
