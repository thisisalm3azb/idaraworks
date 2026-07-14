# Migration Runbook

**Scope:** authoring, applying, verifying, and recovering database migrations for
IdaraWorks (Supabase Postgres, Seoul / `icn1`). This is the operator's authority on
how schema and data reach the hosted database. It codifies BUILD_BIBLE §4.11/§4.14
(forward-only, numbered, never edited after merge) and §14.5/§14.7 (expand-first
releases, safe rollback).

**The single authority is `pnpm db:migrate`** (`tooling/scripts/migrate.ts`).
`supabase db push` and the Supabase dashboard SQL editor are **NOT** the path — they
do not write the `app.migrations` ledger, they do not run under `DIRECT_URL` with the
one-file-per-transaction guarantee, and they will silently desync the ledger from what
is actually on disk. If you ran DDL by any other means, the ledger is now lying; see
[Recovering a failed or partial migration](#recovering-a-failed-or-partial-migration).

---

## 1. Authoring conventions

Every migration lives in `supabase/migrations/NNNN_short_slug.sql` and obeys all of the
following. The migration test harness (phase2/10 #2) enforces the structural rules; the
rest are review-gated.

### 1.1 Forward-only, numbered, immutable after merge

- Files are numbered `NNNN_` (four digits, zero-padded) and applied in **filename sort
  order** (`readdirSync(...).sort()` in `migrate.ts`). The next number is
  `highest + 1` — see [§4 Verify](#4-verify) for how to read the highest.
- **Never edit a migration after it has merged / been applied to hosted.** The runner
  keys the ledger on the exact filename; a fix goes in a **new** higher-numbered file.
  Editing an applied file makes on-disk SQL diverge from what the database actually ran,
  with no record of the drift.
- There is no `down`/`rollback` SQL. Rollback is app-level (redeploy the previous
  Vercel deployment) or, for data, restore-from-backup (`restore-drill.md`). This is why
  every change must be expand-first (§3).

### 1.2 One file per change; data ≠ schema

- **Never mix a schema migration and a data migration in the same file** (BUILD_BIBLE
  §4.14). Schema DDL (create/alter table, index, policy, function) and data DML
  (backfills, seeds, corrective updates) go in separate numbered files. Rationale: a
  data backfill can be large, slow, or need to run in batches; keeping it out of the
  DDL file keeps each transaction small and each change independently recoverable.
- One logical change per file. `0061_s10_hardening_indexes.sql` adding three related
  hot-path indexes is one change; adding an unrelated table in the same file is not.

### 1.3 RLS lives in the migration that creates the table

New tenant tables ship their Row-Level Security **in the same file that creates them** —
enable RLS, define the policies, and grant only the privileges the app role needs, all
inline. RLS is the second tenancy wall (BUILD_BIBLE §5.2); a table must never exist for
even one migration without it. The canonical shape (from `0046_s7_digest.sql`):

```sql
create table public.digest (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  ...
);
create index digest_org_date_idx on public.digest (org_id, digest_date desc);

alter table public.digest enable row level security;
create policy digest_select on public.digest
  for select to app_user using (org_id = (select app.current_org_id()));
create policy digest_insert on public.digest
  for insert to app_user with check (org_id = (select app.current_org_id()));

-- Grant only what the app role uses. Append-only tables get NO update/delete
-- (audit_log, ai_interaction). No DELETE grant anywhere by default (no-hard-delete).
grant select, insert on public.digest to app_user;
```

Rules baked into that pattern, all mandatory:

- `org_id uuid not null references public.org (id) on delete restrict` on every
  tenant table — no `on delete cascade` (no-hard-delete; §3.4 no cross-org bleed).
- Policies read the org via the init-plan-wrapped subselect `(select app.current_org_id())`
  so the GUC is evaluated once per statement, not per row.
- `grant` the **minimum** verbs. Append-only ledgers (audit, `ai_interaction`) get
  `select, insert` only. Sole-writer rollups grant `update` on named columns only.
- `app_user` is `NOBYPASSRLS`. DEFINER functions that must read cross-org (platform
  scans) are the only exception and carry `set search_path` + `assert_platform_task()`
  (see `0058_s9_platform_scans.sql`).

### 1.4 Rollback-note header

Every file opens with a comment block stating **what the change is** and **how to undo
it**, even when the answer is "restore from backup — destructive." This is BUILD_BIBLE
§4.14's rollback note. It tells the on-call operator, mid-incident, whether an app
rollback alone is safe (expand-only change → yes) or whether data is at risk. Example
header (`0061_s10_hardening_indexes.sql`):

```sql
-- 0061_s10_hardening_indexes (S10 perf pass — audit F-29 / paging-index lens): three
-- FK/hot-path columns were declared as foreign keys but never indexed... Forward-only;
-- CREATE INDEX IF NOT EXISTS is idempotent and takes only a brief lock at MVP volume.
```

For a pure additive change (new table, new index, new nullable column, new function),
the rollback note is: *"expand-only; previous app version tolerates it; no data
rollback needed."* For anything that drops or rewrites data, the note must say
*"destructive — rollback = restore from backup per restore-drill.md"* and the change
must not have shipped without the expand→contract sequencing in §3.

### 1.5 Idempotency (strongly preferred, required for anything re-runnable)

Prefer `create table if not exists`, `create index if not exists`,
`create or replace function`, and guarded `alter table ... add column if not exists`.
Idempotency is what makes the [failed-migration recovery](#recovering-a-failed-or-partial-migration)
(delete the ledger row, re-run) safe. A migration that hard-fails on a second run
against a half-applied state is a latent incident.

---

## 2. The `app.migrations` ledger

`migrate.ts` creates and maintains a single owner-only table:

```sql
create schema if not exists app;
create table if not exists app.migrations (
  filename    text primary key,
  applied_at  timestamptz not null default now()
);
```

- One row per **successfully applied** file, keyed by the exact filename.
- The runner reads this set on every invocation and **skips** any filename already
  present. A file not in the ledger is a file that has not run.
- The ledger and the migration **body insert run in the same transaction**
  (`sql.begin(async tx => { await tx.unsafe(body); await tx.insert(...) })`). So a file
  that errors rolls back both its DDL **and** its ledger row — atomically. A clean
  `pnpm db:migrate` therefore never leaves a ledger row for a failed file (see §5 for
  the exceptions that break this and how to recover).
- It is `app`-schema, owner-only, and never exposed to `app_user`. Only tooling/CI
  reaching the database over `DIRECT_URL` touches it.

---

## 3. Expand → migrate → contract

Because rollback is forward-only and app rollback must always be safe, **breaking
changes are split across releases** (BUILD_BIBLE §14.5, item 5; §14.7 rollback). Never
land a schema change and the app code that depends on it in a way where rolling back the
app would break against the new schema.

The sequence for a breaking change (e.g. renaming/removing a column, tightening a
constraint, changing a type):

1. **Expand** — migration that adds the new shape *alongside* the old (new nullable
   column, new table, new function overload). Deploy. The old app still works; the new
   column is unused or dual-written.
2. **Migrate** — deploy app code that writes/reads the new shape. Optionally a
   *separate, data-only* migration backfills existing rows (never in the same file as
   the expand DDL — §1.2). Both old and new shapes are now valid simultaneously.
3. **Contract** — only after the new app has been stable in production, a later
   migration drops the old column/constraint. This is the one destructive step; it
   ships alone, with a destructive rollback note, once nothing reads the old shape.

**Migrations always deploy before the code that needs them** (BUILD_BIBLE §14.5). The
deploy runbook runs `pnpm db:migrate` as step 1, before `vercel deploy`
(`deployment-and-rollback.md`). Expand-first is exactly what lets that same runbook
promise "app rollback is always safe": the previous deployment always tolerates the
newer schema, because the newer schema only ever *added*.

Additive-only changes (new table + RLS, new index, new function, new nullable column)
are the common case and are a single release — they are expand steps with no contract.

---

## 4. Verify

`pnpm db:migrate` requires `DIRECT_URL` in `.env.local` (the direct port-5432
connection; the runner refuses to guess and errors if it is unset). It is tooling/CI
only and never present in Vercel runtime env.

**Apply / bring the database current:**

```bash
pnpm db:migrate
# => migrations: applied [0065_s11_...]        (or "applied [none]" if already current)
```

The runner prints the filenames it applied this run. `applied [none]` means the ledger
already covers every file on disk — the database is current.

**Read the highest-applied filename and derive the next number.** The ledger is the
source of truth (matches on-disk order because the runner applies in sort order):

```sql
-- highest applied (over DIRECT_URL)
select filename from app.migrations order by filename desc limit 1;
```

Compare it to the highest file on disk (`ls supabase/migrations/ | tail -1`). They must
match after a clean `pnpm db:migrate`. The **next** migration you author is
`highest + 1`. Example current state: highest applied `0064_s10_retention_pruning`,
next file to author `0065_...`.

A one-shot "are we current?" check is simply re-running `pnpm db:migrate` and confirming
`applied [none]`. For connectivity troubleshooting before a run, `tsx tooling/scripts/probe-db.ts`
fail-fast-probes both `DIRECT_URL` and `DATABASE_URL` with a clear message (the hosted
`db.<ref>.supabase.co` host is IPv6-only; use the Session-pooler URI on IPv4-only
networks).

After migrating as part of a release, `/api/health` must show `db.ok: true` (and
`storage`, `queue`) — see `deployment-and-rollback.md`.

---

## 5. Recovering a failed or partial migration (the S9/S10 lesson)

**Normal case — nothing to recover.** A migration that errors during `pnpm db:migrate`
rolls back its whole file *and* its ledger row in the same transaction. Fix the SQL,
re-run `pnpm db:migrate`; because the ledger has no row for it, it simply runs again.
No manual ledger surgery. The runner also stops at the first failure, so later files are
untouched.

**When the ledger and reality diverge.** The atomic guarantee breaks in exactly these
situations, which is where the S9/S10 renumbering lesson came from:

- A migration was **applied to hosted, then the file was renumbered/renamed** during
  scope reshuffling (S9 build reorganised what became `0054`–`0058` mid-flight). The
  ledger now holds the *old* filename; on-disk sits the *new* filename. The runner sees
  the new name as "not done" and tries to re-run it — but the objects already exist.
- DDL was applied **out-of-band** (dashboard SQL editor, `supabase db push`, a manual
  psql) so the objects exist but **no ledger row** does. The runner will try to create
  them again on the next `pnpm db:migrate`.
- A statement that **cannot run in a transaction** (rare; e.g. `CREATE INDEX
  CONCURRENTLY`) left objects behind while the surrounding transaction reported failure.

**Recovery procedure:**

1. **Diagnose.** Compare ledger to disk:
   ```sql
   select filename from app.migrations order by filename;         -- what ran
   ```
   ```bash
   ls supabase/migrations/                                          -- what should run
   ```
   Identify the mismatch (a ledger row with no matching file = a rename; a file with no
   ledger row whose objects already exist = out-of-band apply).

2. **Make the migration idempotent** if it is not already: `create table if not exists`,
   `create index if not exists`, `create or replace function`, `add column if not
   exists`, guarded policy drops/creates. This is what makes re-running safe against the
   half-present state (§1.5).

3. **Delete the stale/mismatched ledger row(s)** over `DIRECT_URL`:
   ```sql
   -- remove the row for a file that was renamed away, or a bogus/partial marker
   delete from app.migrations where filename = '0055_old_name.sql';
   ```
   Do this only for the specific mismatched filename(s), after confirming in step 1.

4. **Re-run** `pnpm db:migrate`. The now-idempotent file re-applies cleanly (its
   `IF NOT EXISTS`/`OR REPLACE` clauses no-op against objects that already exist) and
   inserts the correct ledger row under its current filename.

5. **Verify** per §4: highest applied matches highest on disk; `pnpm db:migrate` a
   second time prints `applied [none]`; `/api/health` `db.ok: true`.

**Never** hand-`INSERT` a ledger row to "mark" a file applied without the objects
actually existing, and never edit an already-applied file to fix it forward — both
recreate the exact divergence this section exists to undo. The only supported edits to
`app.migrations` are the targeted `delete` in step 3.

---

## 6. Quick reference

| Action | Command |
| --- | --- |
| Bring DB current | `pnpm db:migrate` |
| Confirm current | `pnpm db:migrate` → `applied [none]` |
| Highest applied | `select filename from app.migrations order by filename desc limit 1;` (over `DIRECT_URL`) |
| Highest on disk | `ls supabase/migrations/ \| tail -1` |
| Connectivity probe | `tsx tooling/scripts/probe-db.ts` |
| Recover renamed/partial | make idempotent → `delete from app.migrations where filename = '<stale>'` → re-run |

**[OWNER ACTION]** `DIRECT_URL` and `APP_DB_PASSWORD` are owner-provisioned credentials
that live only in `.env.local` (and CI secrets) — never committed, never in Vercel
runtime env. Running `pnpm db:migrate` against **production** is part of the release
process only (`deployment-and-rollback.md`); the runner's header warns "Never run
against prod outside the release process." `APP_DB_PASSWORD`, when set, is applied to the
`app_user` role on every run as a SCRAM verifier (the plaintext is never sent in SQL);
leaving it empty-but-present is a hard error, not a silent skip.
