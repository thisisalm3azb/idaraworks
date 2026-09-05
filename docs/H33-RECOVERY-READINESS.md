# H33 — Recovery readiness: restore rehearsal and PITR, honestly stated

**Covers:** H30 owner conditions **O-1** (run the restore drill, record RPO and RTO) and
**O-2** (confirm point-in-time recovery is enabled and write down the retention window).
**Date:** 2026-09-05. **Branch:** `verify/h33`. **Written from:** the repository and the
official Supabase documentation only. No database was opened, no credential file was
read, nothing was changed anywhere.

Builds on `runbooks/restore-drill.md` (the executable procedure), `runbooks/backup-monitoring.md`
(the four backup layers and their status), `docs/H30-OWNER-CHECKLIST.md` (O-1, O-2) and
`docs/H30-PRIVACY-CHECKLIST.md` (§5 gaps, §7 what a pilot customer must be told). It does
not repeat them; it says what is true today, what Supabase actually provides, and exactly
what you have to do.

---

## 0. The answer in one paragraph

**Neither condition is closed, and this session could not close either.** Point-in-time
recovery status is **UNCONFIRMED** from this machine: reading it needs the Supabase
dashboard or a personal access token, and neither is available here. The production
project's **plan tier is also UNCONFIRMED**, and that matters more than it sounds — on
Supabase's Free plan there are **no automatic backups at all**. A restore rehearsal was
**NOT performed** in H33, because a genuine rehearsal needs dashboard access, a disposable
target project you pay for by the hour, a witness, and a break-glass record; faking it with
a live export of production would have read every customer's data to prove something a
backup rehearsal is not meant to prove. The runbooks are executable **only with the
corrections listed in §6** (their default backup source does not exist yet, two of their
reference numbers are stale, and one script they call must first be saved from the runbook
text), and §4 below is the numbered procedure to close O-1 and O-2 yourself in one sitting.
Until it is done, the honest sentence to a pilot customer stays exactly what H30 wrote in
`docs/H30-PRIVACY-CHECKLIST.md` §7 point 4: *"That backups exist but the restore has not
yet been rehearsed."* H33 adds one qualifier of its own, which is not H30's wording: whether
backups exist at all depends on the plan tier, and the plan tier is unconfirmed (§2.1, §4a).

---

## 1. What is true today

| Fact | Source | Status |
| --- | --- | --- |
| Production database is Supabase project `anhgeeutrwftsvuzfinf`, region `aws-1-ap-northeast-2` (Seoul); the app is on Vercel `icn1` (Seoul); domain `www.idaraworks.com` | Part A facts; `tests/integration/guard-env.ts` | Verified (read-only, Part A) |
| Files live in two **private** Supabase Storage buckets, `tenant-media` (15 MB/file) and `tenant-docs` (25 MB/file); no public bucket | Part A facts | Verified (Part A) |
| Supabase **management access is not available from this machine** — the CLI has no access token, and no `SUPABASE_ACCESS_TOKEN` / `SUPABASE_MGMT_API_TOKEN` is defined anywhere in the repository (`.env.example` does not list one; `runbooks/backup-monitoring.md` §4.4 only *proposes* the name) | Part A facts; `.env.example`; grep of the repo | Verified |
| Therefore **plan tier, PITR status, backup existence, backup age and hosted Postgres version could not be read** | consequence of the above | **UNVERIFIED — owner action** (§4a) |
| **No restore drill has ever been recorded**: the drill log in `runbooks/restore-drill.md` §4 still reads `_pending first drill_` and every "First drill result" field is `_TBD_`. The repository can prove only that no drill was written down, not that none was ever run; what it does establish is that H33 itself performed none (§3 item 3) | `runbooks/restore-drill.md` lines 443, 504–545 | Verified (absence of a record) |
| `runbooks/backup-monitoring.md` §0 records Layer A (PITR) as **"NOT ENABLED — hosted project has default daily backups only"** *as of when that runbook was written*. That is a statement in a file, not a fresh reading. Treat it as the most likely state, not as confirmed | `runbooks/backup-monitoring.md` line 28 | **UNVERIFIED — owner action** |
| Layers B (nightly logical dump to a second provider), C (storage replication + manifest) and D (backup monitor) are **designed but not built**: `tooling/scripts/` has no `logical-backup.ts`, `storage-replicate.ts` or `restore-drill-storage.ts`; `src/workers/index.ts` registers no `backup-monitor` | directory listing; `src/workers/index.ts` | Verified |
| Consequence: **whatever Supabase itself holds is the only copy of the production database, and there is no copy of the files anywhere.** | the two rows above | Verified |
| Sentry, Inngest, Resend, AI provider, billing provider: none provisioned. Nothing in this document sends anything or depends on any of them | Part A facts | Verified (Part A) |

---

## 2. What Supabase officially provides (read 2026-09-05)

Every figure below was read from the Supabase documentation on the date shown. The URLs
are listed in full in §8. Prices are Supabase's published list prices in USD on that date;
your invoice is the authority.

### 2.1 Daily backups — which plans, how long they are kept

| Plan | Daily backups | Retention | Source |
| --- | --- | --- | --- |
| **Free** | **Not included.** Supabase recommends Free projects "regularly export their data using the Supabase CLI `db dump` command" | none | Backups guide; Pricing page ("Not included") |
| **Pro** (from $25/month) | Yes | "access the last 7 days of daily backups" | Backups guide; Pricing page ("Daily backups stored for 7 days") |
| **Team** (from $599/month) | Yes | "the last 14 days of daily backups" | Backups guide; Pricing page |
| **Enterprise** (custom) | Yes | "up to 30 days" (guide) / "Custom" (pricing page) | both |

Other facts from the same page that matter here:

- "Database backups do not include objects you store via the Storage API." **Files are not in
  the database backup.** "Restoring an old backup does not restore objects you deleted after
  that backup."
- "Daily backups do not store passwords for custom roles, and you will not find them in
  downloadable files." That sentence is about downloadable backup files: after a restore
  from such a file the application role `app_user` would have no usable password until one
  is set (the migration runner's post-step sets it from `APP_DB_PASSWORD` —
  `tooling/scripts/migrate.ts`). Whether a "Restore to a New Project" clone (§2.4) keeps
  the password is **UNVERIFIED** — see §4b step 4.
- Backups are "logical" or "physical"; "All projects on Postgres `15.8.1.079` and newer use
  the newer physical backup process." The production project's Postgres version is
  **UNVERIFIED** from here (the local stack pins major version 17 in `supabase/config.toml`;
  the hosted version is read from the dashboard — §4a step 4).
- The documentation does **not** state the time of day the daily backup is taken. Do not
  assume "midnight". Read the timestamp of the newest backup in the dashboard and record it.

### 2.2 Point-in-time recovery (PITR) — what it is and what it requires

- **Definition:** PITR "allows you to back up a project at shorter intervals, giving you the
  option to restore to any chosen point with up to seconds of granularity." Write-ahead-log
  files are backed up "at two-minute intervals" by default, or sooner "if these files exceed
  a certain file size threshold".
- **Who can enable it:** "Pro, Team and Enterprise Plan projects can enable PITR as an
  add-on." The restore-to-new-project page adds that it is "available for organizations on
  a paid plan with physical backups enabled." **Not available on Free.**
- **Compute prerequisite:** "Projects that want to use PITR must also use at least a Small
  compute add-on to ensure smooth functioning." Small compute is listed at **$0.0206/hour
  (~$15/month)**. Whether a plan's compute credit offsets part of that is **UNVERIFIED —
  read it on your billing page.**
- **Retention windows and price** (per project, billed by the hour):

  | Retention | Hourly | Approx. monthly |
  | --- | --- | --- |
  | 7 days | $0.137 | ~$100 |
  | 14 days | $0.274 | ~$200 |
  | 28 days | $0.55 | ~$400 |

  "PITR is charged by the hour, meaning you are charged for the exact number of hours that
  PITR is active for a project." "You are charged for every enabled PITR add-on across your
  projects." The pricing page's Point in Time Recovery row phrases the same thing as "$100
  per month per 7 days retention" (the Team column reads exactly that and nothing more);
  the phrase ">28 days retention available" appears **only in the Enterprise column** of
  that row.
- **Not covered by the Spend Cap.** "Point-In-Time Recovery add-on is **not** covered by the
  Spend Cap." Enabling it is a real recurring cost from the first hour.
- **It replaces daily backups:** "If you enable PITR, we will no longer take Daily Backups."
- **The recoverable window is shown on screen:** "The recovery period of a project is shown
  by the earliest and latest recovery points displayed in your preferred timezone." The
  picker only accepts a time "if the selected date and time fall within the earliest and
  latest recovery points." **You cannot go back further than the retention you paid for.**

### 2.3 How a restore works — in place

- Dashboard path: **Database → Backups**; PITR restores live under "the Point in Time
  settings in the Dashboard".
- A restore from the Backups page is applied **to the same project, in place**. "The project
  is inaccessible during this process, so plan for downtime beforehand. Downtime depends on
  the size of the database — the larger it is, the longer the downtime will be." The
  documentation gives no duration figure; the rehearsal in §4b measures it.
- Restoring in place rewinds **every organisation in the database** to the chosen moment.
  There is no per-organisation restore. (§5 spells out what this means.)

### 2.4 Restoring into a separate, new project — supported, with conditions

This is the mechanism the rehearsal uses, because it never touches production. Supabase
calls it **"Restore to a new project"** (`/docs/guides/platform/clone-project`).

- **Conditions:** "exclusive to users on paid plans" and "requires that physical backups
  are enabled for the source project". Works from a daily backup ("Select the backup you
  want to use") **or**, if PITR is on, from an exact timestamp ("use the date and time
  selector to specify the exact point in time").
- **Where:** source project → "the database backups page" → the **"Restore to a New
  Project"** tab → choose backup → **Restore**.
- **What the new project gets:** "Database schema (tables, views, procedures)", "All data
  and indexes", "Database roles, permissions and users", "Auth user data (user accounts,
  hashed passwords, and authentication records)", the Vault "Encryption root key"; and it
  replicates "the compute instance size, disk attributes, SSL enforcement settings, and
  network restrictions" of the source.
- **What it does NOT get** (must be recreated by hand if you ever used a clone for real):
  **storage objects and bucket settings**, Edge Functions, Auth settings and API keys,
  Realtime settings, database extension configuration, read replicas.
- **Region:** "The data will remain in the same region as the source project to ensure
  compliance with data residency requirements." A clone of production stays in Seoul.
- **Cost:** the new project "will incur additional monthly expenses based on the mirrored
  resources" — it is a full paid project while it exists. Delete it the same day (§4c).
- **Limits and warnings:** "Projects that are created through the restoration process
  cannot themselves be used as a source for further clones." Extensions that perform
  external operations (`pg_net`, `pg_cron`, `wrappers`) should be disabled after the
  restore so a clone cannot fire real side effects.

### 2.5 Downloading a backup, and the CLI route

- **Dashboard download is only for old projects.** The Supabase "Restore Dashboard backup"
  page states: "Dashboard backups are only available for older projects that still use
  logical backups." A project on physical backups (every project on Postgres 15.8.1.079 or
  newer) has no download button; the Backups guide says: "If you need to download a backup
  after disabling PITR, you need to take a manual legacy logical backup using the Supabase
  CLI or pg_dump." **Whether production is logical or physical is UNVERIFIED** (§4a step 4).
- **The CLI route is an export of the live database, not a download of a backup.** The
  official "Backup and Restore using the CLI" page dumps roles, schema and data with three
  `supabase db dump` commands over the project's connection string and restores with one
  `psql --single-transaction --variable ON_ERROR_STOP=1 … --command 'SET
  session_replication_role = replica' …` into a project created at `database.new`. Its data
  dump excludes `storage.buckets_vectors` and `storage.vector_indexes`, and the page has a
  separate "Migrating storage objects" section with a Node.js script for copying objects
  between projects; it does **not** contain a sentence saying storage objects are excluded
  from the dump — the explicit statement that backups do not include Storage objects is in
  the Backups guide (§2.1), not on this page. The CLI page does say that custom `LOGIN`
  roles need their passwords reset in the new project.
- **A downloaded `.backup` file can be restored locally** with
  `supabase db start --from-backup db_cluster.backup` after writing the source Postgres
  version to `supabase/.temp/postgres-version`; "The earliest Supabase Postgres version that
  supports a local restore is `15.1.0.55`", and the result "is not production ready". This
  only applies if a downloadable backup exists (see the first bullet).

### 2.6 The Management API and CLI need a personal access token — none is present here

- The Management API is authenticated with a **Personal Access Token** generated on the
  account tokens page, sent as `Authorization: Bearer <access_token>` to
  `https://api.supabase.com/v1/`; rate limit 120 requests per minute.
- `supabase login` connects the CLI "by signing in with your personal access token", and
  "you may skip login by specifying the `SUPABASE_ACCESS_TOKEN` environment variable". The
  token is generated at `https://supabase.com/dashboard/account/tokens`.
- The read that answers O-2 without a browser is
  **`GET /v1/projects/{ref}/database/backups`** (permission `backups_read`), which returns
  `region`, `walg_enabled`, **`pitr_enabled`**, `backups[]` (each with `id`,
  `is_physical_backup`, `status`, `inserted_at`) and `physical_backup_data`
  (`earliest_physical_backup_date_unix`, `latest_physical_backup_date_unix`). This is the
  same call `runbooks/backup-monitoring.md` §4.3 wants the future monitor to make.
- A PITR restore can also be triggered by API —
  `POST /v1/projects/{ref}/database/backups/restore-pitr` with
  `recovery_time_target_unix` (permission `backups_write`). **Do not use it for the
  rehearsal**: the documentation does not say it creates a separate project, and the
  dashboard's "Restore to a New Project" tab does.
- **None of this could be run in H33**: there is no token on this machine, and creating one
  is an account action only the owner can take.

---

## 3. What H33 did not do, and why it must not be claimed

1. **PITR status: UNCONFIRMED.** Not readable without the dashboard or a token. The
   backup-monitoring runbook's "NOT ENABLED" line is the best available information and is
   older than today.
2. **Plan tier: UNCONFIRMED.** No file in the repository records production's Supabase plan
   or compute size. A grep of `docs/`, `runbooks/` and `README.md` for "free plan" / "free
   tier" hits only unrelated things: the *product's* own free plan; Vercel's free plan
   (`docs/H27-REPORT.md` line 186); Supabase's free tier for the **test** project
   `idaraworks-test` (`docs/H33-TRUTH-MAP.md` line 52; `tests/integration/guard-env.ts`
   calls it "a separate free project"); and the sibling H33 drafts (DPA, erasure policy,
   subprocessor register) repeating this same gap. None of them states the **production**
   project's plan. If production is on Free, §2.1 applies: no backups.
3. **Restore rehearsal: NOT PERFORMED.** The genuine rehearsal needs (a) dashboard access or
   a token to create the disposable project, (b) a paid plan on the source for the
   "Restore to a New Project" tab to exist, (c) a witness and a break-glass record, because
   the clone holds every customer's real data, and (d) a few hours of paid compute. None of
   (a)–(d) was available or appropriate for an unattended session.
4. **A substitute was deliberately not run.** A `pg_dump` of production into a local
   Postgres would have proved that the *export* path works — useful, and `restore-drill.md`
   §1c describes it — but it reads all tenant data (break-glass, two-party) and proves
   **nothing about whether Supabase holds a backup or whether that backup restores.** Doing
   it and calling it a "restore rehearsal" would be exactly the false comfort O-1 exists to
   prevent.
5. **The runbook's default source does not exist yet.** `restore-drill.md` §1a names
   "Option B — nightly logical backup" as the default. Per `backup-monitoring.md` §0 that
   nightly dump is a seam, not a script, and has no destination. Until Layer B is built,
   the only rehearsable source is Supabase's own backup via "Restore to a New Project"
   (Option A in the runbook's terms) — which is why §4b below is written around it.

---

## 4. The owner procedure

Three parts, in order. Part (a) takes ten minutes. Part (b) is the rehearsal — budget half a
day, with a second person present. Part (c) is cleanup and is not optional.

Write the answers into the tables provided; this document is the record.

### 4a. Read the plan tier and the PITR status (closes O-2)

1. Sign in to the Supabase dashboard as the organisation owner.
2. Open the organisation's **billing / plan page**. The exact menu path is **UNVERIFIED —
   owner action** (none of the cited documentation pages names it; follow the screen).
   Write down the **plan** (Free / Pro / Team / Enterprise) and the **Spend Cap** setting.
   Also write down the **compute size** of project `anhgeeutrwftsvuzfinf` — where the
   dashboard shows it is likewise **UNVERIFIED — owner action**.
3. Open the project → **Database → Backups** (this path is the one the Backups guide
   gives). Write down: whether the page shows a list of daily backups at all (Free shows
   none); the **timestamp of the newest backup**; the **number of backups listed**; and
   whether the PITR page under Backups (path `/database/backups/pitr`, the page the PITR
   guide links to) says enabled or disabled. If enabled, write down the **retention**
   (7 / 14 / 28 days) and the **earliest and latest recovery points** shown (§2.2 says they
   are displayed).
4. Note the **Postgres version** the dashboard shows for the project. Where it is
   displayed is **UNVERIFIED — owner action** (a project settings / infrastructure page is
   the likely place; copy the full version string exactly as shown). Anything at or above
   `15.8.1.079` means physical backups (§2.1).
5. Confirm whether the Backups page shows a **"Restore to a New Project"** tab. It appears
   only on paid plans with physical backups (§2.4). If it is absent, the rehearsal in §4b
   cannot use Supabase's backup and you are in the "Free plan" branch of §4b step 0.
6. (Optional, and it lets the future monitor work.) At
   `https://supabase.com/dashboard/account/tokens` (the page the CLI login documentation
   names, §2.6) create a personal access token, scoped as narrowly as the dashboard allows
   (backups read). Store it only in `.env.local` and the GitHub `migrations` environment,
   never in Vercel, as `runbooks/backup-monitoring.md` §4.4 instructs — and **add a row for
   it to `runbooks/secret-rotation.md`**: that runbook has no entry today for any Supabase
   personal access / management token (its table lists `APP_DB_PASSWORD`, the Supabase
   keys, the storage keys, Inngest, Sentry, Vercel and GitHub credentials only); §4.4 says
   to add one when the token is provisioned. Then, from any machine with `curl`:
   `curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/anhgeeutrwftsvuzfinf/database/backups`
   and keep the JSON (it contains `pitr_enabled`, `walg_enabled`, the backup list and the
   physical-backup window). No data leaves Supabase; this is metadata only.
7. Fill in:

   | Question | Your answer | Date |
   | --- | --- | --- |
   | Plan tier | | |
   | Compute size | | |
   | Spend Cap on/off | | |
   | Daily backups listed? newest timestamp? | | |
   | PITR enabled? retention days? | | |
   | Earliest / latest recovery point shown | | |
   | Postgres version string | | |
   | "Restore to a New Project" tab present? | | |

8. **Decide.** If PITR is off and you intend a pilot with real data, the runbooks' recovery
   objective (RPO ≤ 1 hour, `restore-drill.md` §0) is **unachievable** on daily backups
   (§5). The decision is yours; the published price for the smallest option is
   ~$100/month for 7-day PITR plus Small compute at ~$15/month (§2.2), and it is not
   covered by the Spend Cap. If you enable it, write the retention days into
   `runbooks/backup-monitoring.md` §1 step 2 as that runbook asks, and note that daily
   backups stop from that moment (§2.2). O-2 is closed when the table above is filled in
   and the decision is written down — either answer closes it; an unrecorded answer does not.

### 4b. Perform a safe restore rehearsal into a NEW disposable project (closes O-1)

**Golden rule (from `restore-drill.md`):** the target is always a throwaway. Never press
"Restore" on the main Backups tab of production — that is the **in-place** restore and
takes the live system down (§2.3). Only the **"Restore to a New Project"** tab is used.

**Step 0 — pick the branch.**

- **Paid plan, "Restore to a New Project" tab present:** follow steps 1–14.
- **Free plan (no backups):** there is nothing to rehearse. Record that as the finding for
  O-1 ("no backup exists to restore"), decide on the plan (§4a step 8), and re-run this
  section after the first daily backup has been taken (or after PITR shows a recovery
  window). In the meantime the only protective action available is a manual export with
  `supabase db dump` (§2.5), run under the break-glass rule, stored encrypted off-Supabase.
  That is Layer B done by hand once; it is not a rehearsal.

**Step 1 — people and record.** Two people: operator and witness (`restore-drill.md` §7).
Before touching anything, write the break-glass line: date/time UTC, both names, reason
"O-1 restore rehearsal, disposable clone". The clone will contain every customer's data.

**Step 2 — start the clock and choose the restore point.** Note **T0** = now (UTC). On the
production project → Database → Backups → **"Restore to a New Project"** tab. If PITR is on,
choose a timestamp about 15 minutes in the past (well inside the window). If daily backups
only, choose the newest backup. Write down the **restore-point timestamp** exactly as shown —
this is the RPO evidence.

**Step 3 — create the clone.** Click **Restore**. Supabase creates a new project mirroring
production's compute size, disk, SSL and network settings, in the same region (§2.4). Give it
an unmistakable name, e.g. `idw-drill-2026-09-05-DELETE-ME`. Note **T1** = the moment the
dashboard shows the new project as ready. **T1 − T0 is Supabase's part of the RTO.**

**Step 4 — quarantine the clone.** Immediately in the new project: Database → Extensions —
disable `pg_net`, `pg_cron` and any `wrappers` if enabled (§2.4 warning). Do **not** put its
credentials into any Vercel environment, `.env.local`, or CI. Create a scratch env file
outside the repository (`restore-drill.md` §0 "Environment isolation") holding only the
clone's **Session pooler** connection string (port 5432). Whether the clone carries a
usable `app_user` password is **UNVERIFIED**: the clone-project page says the new project
receives "Database roles, permissions and users" and does not say passwords are dropped;
the "no passwords for custom roles" sentence (§2.1) is about downloadable backup files, and
the password-reset note (§2.5) is about the CLI dump path. It does not matter for the
drill — for every check below connect as `postgres`, and record whether `app_user` could
log in as a finding.

**Step 5 — schema check (migration ledger).** In the clone, run:

```sql
select count(*) as applied, min(filename) as first, max(filename) as last from app.migrations;
```

Expected today: **137**, first `0000_setup_helpers.sql`, last `0137_h32a_onboarding_state.sql`
(`ls supabase/migrations/*.sql | wc -l` on the branch you deployed from must equal
`applied`; the runbook's "65 / 0064" figures are stale — see §6). Then the policy and RLS
checks from `restore-drill.md` §1f (2)–(4) verbatim. For (5), the DELETE-grant allowlist,
the runbook's list of four tables is also stale: migration `0032_s3_line_soft_delete.sql`
revoked three of them, and as far as the migration files show the only remaining `DELETE`
grant to `app_user` is `public.org_holiday_calendar`. Capture the real list from
**production** at drill time (the runbook already says not to hardcode it) and require the
clone to match it exactly.

**Step 6 — schema diff (exact).** From the operator machine with Postgres 17 client tools:

```bash
pg_dump "$PROD_DIRECT_URL"  --schema-only --no-owner --schema=public --schema=app > schema-prod.sql
pg_dump "$CLONE_DIRECT_URL" --schema-only --no-owner --schema=public --schema=app > schema-clone.sql
diff schema-prod.sql schema-clone.sql && echo "SCHEMA IDENTICAL"
```

The production read is schema-only (no tenant rows) but is still a privileged connection —
it is inside the break-glass record from step 1. Any difference is a **finding** (a
migration applied after the restore point is the benign explanation; anything else is not).

**Step 7 — row counts per table.** Run this on **both** databases (it prints and executes one
`count(*)` per table in `public`; `\gexec` is a `psql` feature):

```sql
\o counts-clone.txt
select format('select %L as tbl, count(*) as n from %I.%I', c.relname, n.nspname, c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname \gexec
\o
```

(Use `counts-prod.txt` for the production run.) Then `diff counts-prod.txt counts-clone.txt`.
Rows written to production **after** the restore point are the only acceptable differences,
and they should appear only in tables that receive writes (e.g. `audit_log`, `domain_event`,
`activity`). Record the largest organisation's counts for the four tables the runbook names
(`org`, `membership`, `audit_log`, `domain_event`) in the evidence table. 280 tables are
expected in `public` (the migrations create 280; confirm the number on production).

**Step 8 — checksums on a few tables.** Order-independent content hash; run on both
databases for at least `public.invoice`, `public.payment`, `public.journal_entry`,
`public.membership`, `public.audit_log`:

```sql
select 'invoice' as tbl, count(*) as n,
       md5(string_agg(md5(t::text), '' order by md5(t::text))) as content_hash
from public.invoice t;
```

Repeat per table. Hashes must be **identical** for tables with no writes after the restore
point; for `audit_log` compare after excluding rows with `created_at` later than the
restore-point timestamp.

**Step 9 — storage: what the clone does and does not hold.** The clone carries the
`storage.objects` and `public.file` **rows** but **none of the file bytes** (§2.4). Record:

```sql
select bucket_id, count(*) from storage.objects group by bucket_id order by 1;
select bucket, status, count(*) from public.file group by bucket, status order by 1,2;
select count(*) as orgs_with_usage, sum(bytes_used) as bytes from public.org_storage_usage;
```

Then run the storage half of `restore-drill.md` §2 **as written**: copy `tenant-media` and
`tenant-docs` with `rclone sync` from the production S3 endpoint into a **disposable**
bucket or local MinIO (needs the storage-scoped `STORAGE_S3_*` keys — owner action #3 in
that runbook), compare `rclone size` object counts and bytes with the counts above and with
the manifest from the runbook's `restore-drill-storage.ts` (its source is embedded in the
runbook §2c and must be saved to `tooling/scripts/` at drill time — the file is not in the
repository yet). The number to write down: **objects in the buckets vs `storage.objects`
rows vs `public.file` rows with `status='ready'`**, per bucket. A mismatch between the bucket
and the rows is a finding; a mismatch between the clone's bytes (zero) and the bucket is
expected and is the reason Layer C exists.

**Step 10 — bring the clone to "green".** Optionally run the migration runner against the
clone, to confirm nothing is pending and to give `app_user` a known password. Read this
before typing it: `pnpm db:migrate` (`tooling/scripts/migrate.ts`) loads `.env.local` and
then `.env` from the current directory through `tooling/scripts/load-env.ts` — there is
**no scratch-env flag**, and dotenv does **not** override a variable that is already set
in the shell. On a maintainer machine `.env.local` is production, so a bare
`pnpm db:migrate` sees only the production ref and **refuses** (its guard,
`targetsOnlyProductionProject` in `tests/integration/guard-env.ts`, reads
`NEXT_PUBLIC_SUPABASE_URL`, `DIRECT_URL` and `DATABASE_URL`). To make it run
against the clone, export all three of those variables in the shell, pointing at the
clone's ref, plus a **clone-only** `APP_DB_PASSWORD` (non-empty — an empty value is an
error — and never production's value), and only then run the command:

```bash
export NEXT_PUBLIC_SUPABASE_URL="https://<clone-ref>.supabase.co"
export DIRECT_URL="<clone direct / session connection string>"
export DATABASE_URL="<clone pooled connection string>"
export APP_DB_PASSWORD="<throwaway value used for the clone only>"
pnpm db:migrate
```

Set all three URLs, not just `DIRECT_URL`: the guard refuses only when *every* reference
it finds is production, so a half-changed shell would still run (against `DIRECT_URL`) —
but a shell that names two projects is exactly the mixed environment the guard exists to
catch, and the drill record must not depend on that loophole. Expected output:
`migrations: applied [none]` (nothing pending). The runner's post-step then issues
`alter role app_user with login password …` on the clone from `APP_DB_PASSWORD`. If any
file is listed as applied, the restore point predates that migration — a benign finding to
record alongside step 6. Close that shell afterwards so the exported values cannot leak
into another command. Then, only if you want an application-level check, point a
**local** `pnpm dev` at the clone and open `/api/health` — `db.ok`, `storage.ok` and
`queue.ok` must be `true` and `inngest.status` `unconfigured`. **Do not deploy anything
that points at the clone.** Note **T2** = all checks green.

**Step 11 — record the objectives.**

| Metric | Objective (`restore-drill.md` §0) | Measured | Pass |
| --- | --- | --- | --- |
| Source | — | daily backup / PITR | — |
| Restore-point timestamp (UTC) | — | | — |
| **RPO** = T0 − restore point | ≤ 1 h | | ☐ |
| Supabase restore time (T1 − T0) | — | | — |
| Verification time (T2 − T1) | — | | — |
| **RTO** = T2 − T0 | ≤ 4 h | | ☐ |
| Schema diff | identical | | ☐ |
| Migration ledger | 137 / `0137_h32a_onboarding_state.sql` | | ☐ |
| Row counts (diff explained) | yes | | ☐ |
| Checksums (5 tables) | identical | | ☐ |
| Storage objects vs rows (per bucket) | recorded | | ☐ |

With daily backups only, RPO will be **hours**, and it will fail the ≤ 1 h objective. That is
a true result, not a bad drill; write it down as the finding that drives the PITR decision.

**Step 12 — append the drill-log row** in `runbooks/restore-drill.md` §4 and fill the
"First drill result" template at the end of that file; both people sign.

**Step 13 — findings.** Anything that needed a step not in the runbook, any command that was
refused on the managed source (e.g. `pg_dumpall --roles-only`), any count that did not
reconcile, and the two stale numbers noted in §6 — record them and update the runbook in a
commit.

**Step 14 — go to §4c now, not tomorrow.**

### 4c. Delete the disposable project and every copy

1. In the disposable project's settings, use the dashboard's **Delete project** action and
   confirm as prompted (the exact menu wording is **UNVERIFIED** here — follow the screen).
   The project is billed while it exists (§2.4).
2. Delete the disposable storage target: `docker rm -f idw-drill-s3` for MinIO, or delete
   the scratch bucket; then `rm -rf ./drill` and any `idw-drill-*` dump, roles or
   `schema-*.sql` / `counts-*.txt` files (they contain real schema and counts; the dumps
   contain real data).
3. Delete the scratch env file holding the clone's connection string.
4. If a personal access token was created **only** for the drill and will not be kept for
   the monitor, revoke it at `https://supabase.com/dashboard/account/tokens`. If it is
   kept, **add a row for it to `runbooks/secret-rotation.md`** (quarterly rotation,
   immediate on exposure, as `runbooks/backup-monitoring.md` §4.4 specifies) — no such row
   exists in that runbook today, so until you write it the token is governed by nothing.
5. If any credential was pasted into a shared terminal, chat or ticket, rotate it immediately
   (`restore-drill.md` §6).
6. Confirm in the dashboard that the project list no longer shows the clone; note the
   deletion time in the drill log. The break-glass record from §4b step 1 is closed with
   "copies destroyed at <time>".

---

## 5. The practical recovery gap in plain language

Production holds 41 organisations in one database. Every restore Supabase offers is a
restore of that **whole database**. Keep that in mind for all three cases.

**Case 1 — daily backups only (the state the runbook recorded; UNVERIFIED today).**
Supabase keeps one snapshot per day, for 7 days on Pro. If something goes wrong at 15:00 —
a wrong bulk action, a bad migration, a deleted customer — the nearest restore point is the
last daily snapshot, taken at a time of day Supabase does not publish. **Everything every
organisation entered since that snapshot is lost**: every invoice, payment, approval, goods
receipt and journal from all 41 companies, not just the one that had the problem. In the
worst case that is close to 24 hours of everyone's work. Then the project is offline for the
restore itself. The runbook's objective of losing no more than 1 hour **cannot be met** in
this configuration. A mistake noticed on day 8 is unrecoverable.

**Case 2 — PITR enabled (7 / 14 / 28 days).** Supabase ships the change log every two
minutes. You can restore to any second within the window, so the loss is **the last two
minutes or so** before the chosen point — plus the restore downtime, which the rehearsal
measures. The RPO ≤ 1 h objective is met with a wide margin. Two limits remain: it is still
a whole-database restore (rewinding one organisation means restoring to a **new** project
and copying that organisation's rows back by hand — there is no tool for that and it has
never been tried), and nothing older than the retention window can be recovered.

**Case 3 — Free plan.** There is no backup. A lost database is lost. If §4a shows Free,
this is the single most important fact in the H33 package.

**Files, in all three cases.** Neither daily backups nor PITR includes the two storage
buckets (§2.1, §2.4). A deleted or corrupted PDF, image or attachment is gone unless Layer C
(nightly copy of the buckets to a second location, `runbooks/backup-monitoring.md` §3) is
built and running. It is not built. The rows describing the files survive; the files do not.

**Provider loss, in all three cases.** PITR and daily backups live inside the same Supabase
project. If the account, region or billing fails, they fail with it. The hedge is Layer B
(a nightly dump shipped elsewhere), also not built. Until it is, "we have backups" means
"Supabase has backups of us".

**What this means for a pilot customer.** The sentence in `docs/H30-PRIVACY-CHECKLIST.md`
§7 point 4 stands as written — *"That backups exist but the restore has not yet been
rehearsed."* — with one qualifier that is H33's own, not H30's: whether backups exist at
all depends on the plan tier, which is unconfirmed (§4a). After §4a and §4b it becomes a
sentence with numbers in it, which is the whole point of doing them.

---

## 6. What H33 could verify from the repository, and what it could not

### Verified (read from files on `verify/h33`)

1. **The runbook is executable once items 2 and 3 below are applied.** Every command in
   `runbooks/restore-drill.md` is standard tooling (`pg_dump`, `pg_dumpall`, `pg_restore`,
   `psql`, Docker, `rclone`/AWS CLI). Every table its verification SQL (§1f and §2d)
   touches exists in the migrations: `org` (0001), `membership` (0003), `audit_log`
   (0006), `file` — including the `variants` column §2d samples — and `org_storage_usage`
   (0008), `domain_event` (0014); `app.migrations` is created by the migration runner
   itself (`tooling/scripts/migrate.ts`, `create table if not exists app.migrations`,
   before any file runs). Its other reads are Postgres catalog views (`pg_policies`,
   `pg_class`, `pg_roles`, `information_schema.role_table_grants`). Two names from the
   sibling runbooks that read like tables are **functions**, and the drill's SQL never
   references them: `app.org_known_object_paths(p_org uuid)` (created in
   `0009_files_hardening.sql`, replaced in `0010_reconcile_known_paths.sql`; used by the
   storage-reconcile worker and mentioned only in `runbooks/backup-monitoring.md` §3) and
   `app.outbox_stats(int)` (0018, re-created in 0019; used by `/api/health`). The storage
   primitives the runbook relies on, `objectStore().list()` and `listTopLevelPrefixes()`,
   exist in `src/platform/tenancy/storage.ts` (lines 120 and 143).
2. **Two numbers in the runbook are stale and must be replaced at drill time** (the runbook
   itself says "do NOT hardcode — capture the reference at drill time"):
   - §1f check (6) expects 65 migrations ending at `0064_s10_retention_pruning.sql`; the
     repository now has **137**, ending at `0137_h32a_onboarding_state.sql`.
   - §1f check (5) expects DELETE grants to `app_user` on exactly four tables; migration
     `0032_s3_line_soft_delete.sql` revoked three of them (`report_work_line`,
     `report_material_line`, `report_labour_line`). A grep of the migration files leaves
     only `public.org_holiday_calendar` (a multi-line `GRANT` would not have matched the
     grep, so confirm on production during the drill).
3. **`tooling/scripts/restore-drill-storage.ts` is not in the repository.** Its full source
   is embedded in the runbook §2c and must be saved before the storage checks run.
4. **The app has `/api/ready` and `/api/health`.** `/api/ready`
   (`src/app/api/ready/route.ts`) is dependency-free and returns `ready: true`.
   `/api/health` (`src/app/api/health/route.ts`, `src/platform/observability/health.ts`)
   reports `db`, `storage`, `queue` (unprocessed count, oldest age, dead letters, and a
   `stale` flag after 3,600 s) and `inngest` (`configured` / `unconfigured`); it returns 503
   only when `db` or `storage` fails. Both endpoints are asserted by
   `tests/e2e/smoke.spec.ts` and by the production smoke script
   `tooling/scripts/smoke-prod.ts` (`pnpm smoke:prod`), which is what "green" means in
   §4b step 10.
5. **Migrations are forward-only.** 137 `.sql` files, no `down`/rollback files, no
   `DROP TABLE` or `DROP COLUMN` statement in any of them. CI (`.github/workflows/ci.yml`,
   step "Apply all migrations") builds the whole schema from an empty local stack on every
   run, so the schema is reproducible from the repository alone. `tooling/scripts/migrate.ts`
   refuses to run against the production ref; `tooling/scripts/migrate-prod.ts` prints the
   target and the pending files and demands a confirmation phrase naming the project. A
   restored database is therefore brought forward by applying pending migrations — never by
   rolling any back — which is also why `runbooks/deployment-and-rollback.md` can promise
   that app rollback never needs a data rollback.
6. **Postgres major version 17** is pinned for the local stack (`supabase/config.toml`,
   `major_version = 17`), and the runbook's target is `postgres:17`. Client tools must match.
7. **The backup layers B, C and D are unbuilt** (no scripts, no worker), so no second copy of
   the database and no copy of the files exists anywhere outside Supabase.

### Could not be verified (each is an owner action in §4a)

- The production project's **plan tier**, **compute size** and **Spend Cap** setting.
- Whether **PITR is enabled**, and its retention.
- Whether **any daily backup exists**, how many, and the newest one's timestamp.
- The hosted **Postgres version** (and so whether backups are physical or logical).
- Whether the **"Restore to a New Project"** tab is present.
- The **STORAGE_S3_*** keys needed for the storage half of the drill (they are documented as
  living in Vercel and `.env.local`; `.env.local` was not read).
- Whether `pg_dumpall --roles-only` is permitted on the managed source (the runbook has a
  fallback).
- **All timings** — the restore duration, the downtime of an in-place restore, RPO and RTO.
- Whether the numbers in Supabase's documentation match what the dashboard shows for this
  account today; the dashboard and the invoice are the authority.

---

## 7. Clauses that need professional legal review

None of the following is legal advice, and nothing in this document is "legally approved".
Each item below should be reviewed by a qualified adviser for the UAE, the KSA and the
customer's own jurisdiction before it is written into a customer-facing document.

1. **[LEGAL REVIEW — UAE / KSA / customer jurisdiction]** *Erased data persists in backups.*
   With PITR at 7/14/28 days (or daily backups at 7–30 days), a person or record erased from
   the live database still exists in Supabase's backups until the window rolls past. The
   data-processing agreement (H30 O-3) and the erasure policy (O-4, `H30-PRIVACY-CHECKLIST.md`
   §6) must state this retention truthfully; the exact wording, and whether backup copies
   are treated as "deleted" under each regime, is a legal question.
2. **[LEGAL REVIEW — UAE / KSA / customer jurisdiction]** *Data residency of backups and
   clones.* Backups, PITR logs and any "Restore to a New Project" clone remain in the Seoul
   region (§2.4). Whether storing UAE or KSA personal and financial data in that region, and
   the disclosure required, satisfies each applicable data-protection and sector rule is a
   legal question; `H30-PRIVACY-CHECKLIST.md` §2 already says residency statements must come
   from Supabase's region, not the product.
3. **[LEGAL REVIEW — UAE / KSA / customer jurisdiction]** *Notification after a restore that
   loses data.* A whole-database restore discards other customers' recent work (§5).
   `runbooks/incident-response.md` classes data loss as SEV-1 and starts the notification
   clock at detection; the legally required timeline and content of notice to affected
   customers (H30 O-9) has not been agreed and must be.

---

## 8. Sources read on 2026-09-05

Official Supabase documentation (all read on 2026-09-05; figures quoted are as published on
that date):

- Database Backups — https://supabase.com/docs/guides/platform/backups
- Point-in-Time Recovery usage and pricing — https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- Pricing (plans; daily backup retention; PITR add-on price) — https://supabase.com/pricing
- Compute and Disk (compute sizes and hourly prices) — https://supabase.com/docs/guides/platform/compute-and-disk
- Restore to a new project — https://supabase.com/docs/guides/platform/clone-project
- Backup and Restore using the CLI — https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- Restore Dashboard backup — https://supabase.com/docs/guides/platform/migrating-within-supabase/dashboard-restore
- Restoring a downloaded backup locally — https://supabase.com/docs/guides/local-development/restoring-downloaded-backup
- Management API introduction (authentication, rate limits) — https://supabase.com/docs/reference/api/introduction
- Management API: List all backups — https://supabase.com/docs/reference/api/v1-list-all-backups
- Management API: Restore PITR backup — https://supabase.com/docs/reference/api/v1-restore-pitr-backup
- CLI: `supabase login` — https://supabase.com/docs/reference/cli/supabase-login

Repository files relied on: `runbooks/restore-drill.md`, `runbooks/backup-monitoring.md`,
`runbooks/incident-response.md`, `runbooks/deployment-and-rollback.md`,
`docs/H30-OWNER-CHECKLIST.md`, `docs/H30-PRIVACY-CHECKLIST.md`, `docs/H30-REPORT.md`,
`docs/H33-TRUTH-MAP.md`, `src/app/api/health/route.ts`, `src/app/api/ready/route.ts`,
`src/platform/observability/health.ts`, `src/platform/tenancy/storage.ts`,
`src/workers/index.ts`, `tooling/scripts/migrate.ts`, `tooling/scripts/migrate-prod.ts`,
`tooling/scripts/smoke-prod.ts`, `tests/e2e/smoke.spec.ts`, `tests/integration/guard-env.ts`,
`.github/workflows/ci.yml`, `supabase/config.toml`, `.env.example`, `supabase/migrations/`
(file list and grants). Not read, by rule: `.env.local`, `.env.test.local`, any database.
