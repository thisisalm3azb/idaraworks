# Historical test-organization deletion plan (H21.1 Part E)

**Status: NOT EXECUTED. Awaiting explicit authorization.**

Nothing in this plan has been run. H21.1 removed only the fixtures its own runs
created. The organizations below predate this phase and are listed here so the
decision to remove them can be made deliberately, with the evidence in view.

## How to reproduce the inventory

```bash
npx tsx tooling/scripts/test-residue.ts
```

The command is report-only. It contains no `delete` statement, and a unit test
(`tests/unit/fixture-cleanup.test.ts`) asserts that it never gains one. Add
`--json` for machine-readable output.

## What the inventory found

Scanning every organization in the shared database:

| Class | Count | Meaning |
| --- | --- | --- |
| Confirmed fixtures | 16 | Evidence agrees on all available axes |
| Needs review | 15 | Some evidence, not enough to act unattended |
| Seeded demo | 5 | Deliberate demo data, explicitly **not** residue |

## How an organization is classified

Never by name alone. `public.org.name` has no uniqueness constraint, so nothing
stops a real tenant from being called "S9 Org". Four independent kinds of
evidence are gathered and reported per organization:

1. **marker** — `app_settings['test.fixture'].is_test_fixture`, written by the
   suite itself at creation time (`markFixtureOrg`). This is the organization
   declaring what it is, and is sufficient on its own.
2. **test-emails** — every member's login sits on a reserved test domain
   (`@example.com`, `@journey.invalid`) and none is a real address.
3. **name** — the name matches a known fixture name exactly. A surfacing aid
   only; never sufficient by itself.
4. **no-business** — the organization holds no customers, invoices, payments or
   quotations, i.e. nothing a real tenant would have created.

An organization is **confirmed** only when it carries the marker, or when *all
three* of the remaining kinds agree. Anything else is **needs review**.

The marker is new in H21.1, so the historical organizations below cannot carry
it — they were created before it existed. They are classified on the other three
kinds, which is exactly why this plan requires human authorization rather than
running automatically.

## Seeded demo organizations — excluded, do not delete

These carry `app_settings['demo.simulation']` and hold deliberate demo data.
They use `@example.com` logins and would otherwise trip the email heuristic, so
they are recognised and set aside before classification:

- Finjan Coffee Catering
- Layali Stay Operations
- TorqueLine Auto Workshop
- Sugar Petal Home Bakes
- بستان الرُطب للتمور

## Could any candidate be real?

The inventory reports a `NON-TEST email(s)` flag on any organization holding a
member whose address is not on a reserved test domain. **No candidate in either
list carries that flag.** Two organizations in the database do hold real logins —
Najolatech and شما اتيلييه — and neither appears as a candidate, because their
members' addresses are real.

That is a strong signal, not a proof. Before any deletion, re-run the inventory
and confirm the flag is still absent: an organization that gained a real member
since this plan was written must drop out of scope.

## The proposed deletion, if authorized

1. Re-run `npx tsx tooling/scripts/test-residue.ts` and save the output. The
   list must be re-derived at deletion time, never taken from this document.
2. Delete **only** the organizations in the CONFIRMED list, by id.
3. Use the existing wipe path (`wipeOrgs`), which removes every `org_id`-bearing
   row, the organization, and its users in one transaction. Deleting the
   organization row alone would strand outbox and audit rows that only
   `tooling/scripts/s9-residue-purge.ts` can then reach.
4. Re-run the inventory afterwards and confirm the confirmed list is empty and
   the seeded demo list is still five.

Do **not** use `tooling/scripts/s7-cleanup.ts` for this. It works from a
hardcoded deny-list ("delete every organization except these two"), which today
would destroy the five demo organizations and any tenant created since those ids
were written.

## The NEEDS REVIEW list stays

Fifteen organizations have partial evidence — typically a fixture name and test
logins, but some business records (a customer or a job created by the test
itself). They are left alone. If they should also go, the right move is to
inspect them individually rather than widen the rule, because widening the rule
is precisely how a real tenant would eventually be caught by it.

## Why this will not recur

The seven suites that produced this residue now mark their organizations at
creation and wipe them in `afterAll`, without swallowing failures. Cleanup runs
even when `beforeAll` throws. The only remaining leak path is a hard kill of the
runner (SIGKILL, a closed terminal, a CI runner teardown), where no hook runs at
all — and that is what the inventory command exists to catch.
