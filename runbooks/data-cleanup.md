# Synthetic / Demo Data Cleanup Runbook

**Scope:** removing synthetic (demo, test, walkthrough) org data from the **hosted
production** database so the pilot baseline is exactly the two real orgs, and nothing
else. Every stage (S3–S10) ran a scripted production demo that seeded a throwaway org;
this runbook is how that residue is inventoried, dry-run, and (with approval) purged
back to baseline.

**The production baseline is exactly two orgs — nothing else may remain:**

| Org | UUID |
| --- | --- |
| **Alpha Marine** | `d22b2098-2e09-436d-ab9e-ee26c8719cd5` |
| **TESTING** | `9fcaa697-becd-41ec-97d4-6ce2851ead36` |

These two are **hard-excluded by NAME and by UUID** in every cleanup script — both
conditions are asserted, and any script that finds a protected name *or* UUID in its
delete set aborts before deleting anything. They are never read for deletion, never
touched, never wiped. If you add a legitimate production org later, add its name **and**
UUID to `PROTECTED_NAMES` / `PROTECTED_IDS` in `tooling/scripts/s7-cleanup.ts` and
`s7-inventory.ts` **before** running any cleanup.

> **Non-negotiable order of operations: inventory → dry-run → confirm the delete set →
> apply → re-confirm baseline → `/api/health`.** Never run `--apply` without reading the
> dry-run output first.

---

## 1. Inventory (read-only) — always first

`tooling/scripts/s7-inventory.ts` is **read-only**. It lists every org with a
`PROTECTED` / `synthetic` tag and prints S7 table totals across the whole DB. Run it to
see the current state before and after any cleanup.

```bash
tsx tooling/scripts/s7-inventory.ts
```

Expected clean baseline output: exactly two orgs, both tagged `[PROTECTED]` (Alpha
Marine, TESTING), and the S7 table counters (`digest`, `ai_interaction`,
`customer_update`, `share_token`, and exception rows carrying S7 rule keys) at `0` once
synthetic data is gone. Any org tagged `[synthetic]` is a cleanup candidate.

---

## 2. Dry-run the cleanup — see exactly what would go

`tooling/scripts/s7-cleanup.ts` **defaults to dry-run**. With no flag it:

1. selects every org whose name is **not** in `PROTECTED_NAMES` **and** whose id is
   **not** in `PROTECTED_IDS` (both conditions), and lists each `id + name`;
2. hard-guards: aborts if any protected UUID or protected name slipped into the set;
3. computes the synthetic-**only** users (members of a synthetic org who are **not** a
   member of either protected org — a shared user is never deleted);
4. enumerates every `public` table carrying an `org_id` column and prints the row count
   that would be deleted per table, plus the totals.

```bash
tsx tooling/scripts/s7-cleanup.ts
# => synthetic orgs to remove: N
#      - <uuid> "S7 Org" ...
#    DRY-RUN. org-scoped tables: <count>
#      <table>: <rows> ...
#    would delete <T> tenant rows + <N> orgs + <U> users.
#    re-run with --apply to execute.
```

**Read this output.** Confirm the org list is *only* synthetic demo orgs (names like
"S7 Org", "S6 Org", "S4 Org", etc.), the counts are plausible, and neither Alpha Marine
nor TESTING appears. For reference, the S7 close removed 15 synthetic orgs + 25 users +
2175 rows.

---

## 3. Apply — the destructive step (approval-gated)

```bash
tsx tooling/scripts/s7-cleanup.ts --apply
```

Mechanism: one owner transaction sets `session_replication_role = replica` (disables FK
triggers so the wipe is order-independent across the full S1–S10 table graph), deletes
every `org_id`-bearing row for the synthetic orgs, then the orgs, then the
synthetic-only `user_profile` and `auth.users` rows, then restores
`session_replication_role = default`. It runs over `DIRECT_URL` (owner/superuser).

> **[OWNER ACTION] — auto-mode-classifier approval gate.** `--apply` against production
> is a destructive bulk DELETE. When cleanup runs inside the automated agent harness,
> the **auto-mode safety classifier blocks the production DELETE** and it must be run by
> the owner (or with explicitly granted permission) in an approved/interactive context —
> this is not a bug, it is the guardrail. This blocked twice at the S7 close, so the
> baseline did not match until the owner ran it. **Batch all pending destructive purges
> into one approval point** (e.g. the stage's demo-cleanup step) rather than requesting
> approval repeatedly. Until `--apply` is approved and run, the pre/post baseline will
> not match, and that mismatch is expected, not an incident.

---

## 4. Residue purge — reach what the org-scoped sweep cannot

`s7-cleanup.ts` only deletes rows that carry an `org_id` for a **synthetic org**. Two
classes of test residue survive it and are cleared by
`tooling/scripts/s9-residue-purge.ts` (also **dry-run by default**, `--apply` to
execute):

- **Orphan fake-provider webhook rows** — `subscription_event` rows with `provider = 'fake'`
  (the fake billing provider exists only in tests/demos, disabled in production, so `provider='fake'`
  is synthetic by construction), plus any `reconciliation` / orphan `domain_event` rows whose `org_id`
  no longer exists in `public.org` (`s9-residue-purge.ts` filters those by orphan/null org, not by a
  provider column — `reconciliation` has no provider column).
- **Orphan outbox events** (`domain_event`) whose `org_id` no longer exists in
  `public.org` (left behind after an org was deleted).

Safety: the purge is structurally restricted to rows whose org is **absent** from
`public.org` (or `org_id IS NULL`), so protected orgs are excluded by construction; it
prints exactly what it will delete first.

```bash
tsx tooling/scripts/s9-residue-purge.ts            # dry-run
tsx tooling/scripts/s9-residue-purge.ts --apply    # [OWNER ACTION] — same classifier gate as §3
```

There is a known pending item: **7 inert `subscription_event` rows**
(`org_id = NULL`, `provider = 'fake'`, S9 test-webhook residue) that the classifier
blocked twice. They are inert — the fake provider is disabled in prod and the rows are
unreadable by tenants (migration `0060` deny policy + no grant) — and are queued to be
cleared at the next classifier approval point (S10 demo cleanup), batched with the org
sweep.

**Test-side equivalent (not for production):** integration tests use `wipeOrgs()` in
`tests/integration/helpers.ts` — the same `session_replication_role = replica`
order-independent teardown, scoped to a single test's throwaway org(s) so a test file
leaves no leaked orgs or outbox backlog. It runs against the test database via
`ownerSql()`, never as a production cleanup tool. (A test that leaks orgs later shows up
as extra `[synthetic]` rows in the §1 inventory — self-cleaning teardown is what keeps
the production sweep from being needed for test residue.)

---

## 5. Confirm baseline + health — always last

After any `--apply`, prove the database is back to baseline and the app is healthy:

1. **Re-run the inventory** (`tsx tooling/scripts/s7-inventory.ts`) — expect **exactly
   two orgs**, both `[PROTECTED]` (Alpha Marine, TESTING), and S7 table counters at `0`.
2. **Re-run the cleanup dry-run** (`tsx tooling/scripts/s7-cleanup.ts`) — expect
   `nothing to remove — baseline already clean.`
3. **Check `/api/health`** — `db`, `storage`, and `queue` must all be `ok` (503 if `db`
   or `storage` is down). Cleanup touches only tenant data; a red health check after a
   purge means something else and warrants `incident-response.md`.

```bash
EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod   # optional: full read-only prod smoke
```

---

## 6. Quick reference

| Step | Command | Destructive? |
| --- | --- | --- |
| Inventory | `tsx tooling/scripts/s7-inventory.ts` | no (read-only) |
| Dry-run org sweep | `tsx tooling/scripts/s7-cleanup.ts` | no |
| Apply org sweep | `tsx tooling/scripts/s7-cleanup.ts --apply` | **yes — [OWNER ACTION], classifier-gated** |
| Dry-run residue purge | `tsx tooling/scripts/s9-residue-purge.ts` | no |
| Apply residue purge | `tsx tooling/scripts/s9-residue-purge.ts --apply` | **yes — [OWNER ACTION], classifier-gated** |
| Re-confirm baseline | inventory + dry-run + `/api/health` | no |

**Invariants that must never be violated:**

- Protected orgs are excluded by **name AND UUID**; both are asserted before any delete.
- **Dry-run before apply**, every time. Never `--apply` unread.
- All scripts run over `DIRECT_URL` (owner creds, `.env.local` / CI only — never in
  Vercel runtime).
- Destructive `--apply` on prod is owner-run under the auto-mode-classifier gate; batch
  pending purges into one approval point.
- End every purge by re-confirming the two-org baseline and a green `/api/health`.
