# Restore Drill — Database + Storage (phase2/10 #47 & #48)

**What this is.** The full, executable procedure for the quarterly restore drill
that recovers the **database AND storage** into a *plain* Postgres 17 target and a
*plain* S3 target. It is simultaneously the **vendor-exit rehearsal** (checklist
#47): if it runs green, we can leave Supabase for any commodity Postgres + any
S3-compatible object store.

**Cadence.** Quarterly. **The first drill must run before pilot start**
(phase2/11-mvp-delivery-plan §S11: "drill evidence filed with measured RPO/RTO").

**Objectives being measured** (checklist #48, published internally):

| Objective | Target | Where measured |
| --- | --- | --- |
| **RPO** (max data loss) | **≤ 1 hour** | timestamp of the backup/restore point actually used |
| **RTO** (time to recover) | **≤ 4 hours** | wall clock from "start restore" to "all verification queries green" |

**Golden rule:** the restore target is **always a throwaway** (local Docker /
scratch project / scratch bucket). **Never** restore onto the production Supabase
project, its DB, or its buckets. Two people run this (operator + witness) per the
break-glass rule (§7).

---

## 0. Preconditions, roles, and OWNER ACTIONS

### Who does what

- **Operator** — runs the commands, fills the evidence tables.
- **Witness** — second party for break-glass (§7); co-signs the drill-log entry.

### OWNER ACTIONS (confirm/provision before the drill — the operator cannot self-serve these)

1. **[OWNER ACTION] Confirm the Supabase PITR add-on is ACTIVE** on the production
   project (Dashboard → Project → Settings → Add-ons → Point-in-Time Recovery).
   This is checklist #46 and S0 checklist OA-2. If PITR is **not** active, the
   drill runs off the nightly logical backup only, and the achievable RPO is
   bounded by the backup cadence — record that as a finding.
2. **[OWNER ACTION] Confirm the nightly logical backup to a second provider/region
   exists** and share its location + access (checklist #46: "nightly logical
   backups to second provider/region"). This artifact is the default DB source
   for the drill (§1, Option B). *As of this writing the automated backup-status
   monitor named in docs/S10-AUDIT-REGISTER.md (line 17) is NOT yet built — until
   it is, the owner manually confirms the latest backup exists and is readable.*
3. **[OWNER ACTION] Provide the storage S3 credential** (`STORAGE_S3_ACCESS_KEY_ID`
   / `STORAGE_S3_SECRET_ACCESS_KEY`, Dashboard → Settings → Storage → S3 access
   keys). These are storage-scoped, cannot touch the DB (Bible §5.2). They are not
   present in a default `.env.local`; the owner supplies them for the drill.
4. **[OWNER ACTION] Provision a plain S3 target** for the storage half — either a
   local MinIO container (below) or a throwaway AWS S3 bucket in a scratch account.
   Supply `TARGET_S3_*` credentials to the operator.

### Tools required on the operator machine (Windows + Git-Bash / PowerShell)

- **PostgreSQL 17 client tools** — `pg_dump`, `pg_dumpall`, `pg_restore`, `psql`,
  **major version 17** (must match the server; Postgres 17). Either install the
  native Windows PG17 client, or use the `postgres:17` Docker image as the client
  (examples below use both).
- **Docker Desktop** (for the throwaway Postgres 17 target and optional MinIO).
- **Node ≥ 22 + pnpm** (repo is already set up; `pnpm` scripts in `package.json`).
- **rclone** (recommended for S3→S3 copy) *or* **AWS CLI v2** (download-then-upload).

### Environment isolation

Do **not** run the drill from the repo's production `.env.local`. Create a scratch
env file and keep source/target credentials separate:

```bash
# scratch dir, e.g. the session scratchpad — NOT committed
cp .env.local /tmp/.env.drill          # start from prod creds (source read-only)
# then add TARGET_* creds for the throwaway DB and S3 to /tmp/.env.drill
```

The **source** DB connection is `DIRECT_URL` (the port-5432 session-pooler /
direct URI — host today `aws-1-ap-northeast-2.pooler.supabase.com:5432`; the
transaction pooler on 6543 is **not** usable for `pg_dump`). The **source**
storage is the two private buckets read via `STORAGE_S3_*`. All target
credentials are new and disposable.

---

## 1. Database restore

### 1a. Choose the source (DECISION POINT)

| | Option A — PITR add-on | Option B — nightly logical backup (**default**) |
| --- | --- | --- |
| Achievable RPO | minutes (continuous WAL) | ≤ nightly cadence |
| How you get data OUT to plain PG | Dashboard restores a **clone** project to a chosen timestamp → then `pg_dump` from that clone | the artifact **already is** a `pg_dump` file on the second provider — download it |
| Vendor-exit fidelity | medium (still Supabase-mediated) | **high** (plain dump → plain restore) |
| Use it when | testing the tightest RPO / real point-in-time recovery | the default quarterly drill and the exit rehearsal |

- **Option A (PITR):** **[OWNER ACTION]** In the Supabase dashboard → Database →
  Backups → Point in Time, restore to a chosen timestamp **into a new/scratch
  project** (never in place on prod). When it is ready, treat that clone's
  `DIRECT_URL` as the dump source in step 1c.
- **Option B (nightly dump):** download the latest nightly `pg_dump` artifact from
  the second-provider location the owner shared (OWNER ACTION #2). Skip 1c's
  `pg_dump` and go straight to 1e with that file.

**Record now:** which option, and the **exact backup/restore-point timestamp
(UTC)** — this is your **RPO evidence** (§3). **Start the RTO stopwatch now.**

### 1b. Provision the plain Postgres 17 target (throwaway)

```bash
# Local Docker target on host port 55432 (never prod):
docker run -d --name idw-drill-pg \
  -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:17

# Target connection string used below:
#   postgresql://postgres:drill@localhost:55432/postgres
```

PowerShell equivalent:

```powershell
docker run -d --name idw-drill-pg -e POSTGRES_PASSWORD=drill -p 55432:5432 postgres:17
```

(An alternative target is a throwaway hosted Postgres 17 — Neon/RDS/second
Supabase project. Anything that is plain Postgres 17 and **is not production**.)

### 1c. Take the logical dump (Option A only; Option B already has the file)

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SRC="postgresql://USER:PWD@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres"  # DIRECT_URL of prod (Opt A: the clone)

pg_dump "$SRC" \
  --format=custom --no-owner \
  --schema=public --schema=app \
  --file="idw-drill-${STAMP}.dump"
```

Notes:
- **Keep privileges** (do **not** pass `--no-privileges`): the drill must verify
  `app_user`'s GRANTs, so the GRANT statements must survive into the target.
- `--no-owner` is safe: object ownership on the target differs (no `supabase_admin`
  there) and is irrelevant to the RLS/grant checks.
- RLS **policies** are dumped regardless of privileges — the `pg_policies` count
  check (1f) is faithful either way.
- Run via Docker if PG17 client isn't native:
  `docker run --rm postgres:17 pg_dump "$SRC" --format=custom --no-owner --schema=public --schema=app > idw-drill-${STAMP}.dump`

### 1d. Pre-create roles the dump references (globals)

A single-database logical dump does **not** carry cluster-global roles. The
policies say `to app_user` and the GRANTs target `app_user` / `anon` /
`authenticated` / `service_role`; those roles must exist on the target **before**
`pg_restore`, or the privilege/policy statements error.

**Primary — copy the real roles (most faithful):**

```bash
pg_dumpall --roles-only --no-role-passwords \
  -d "$SRC" > idw-drill-roles.sql
psql "postgresql://postgres:drill@localhost:55432/postgres" -f idw-drill-roles.sql
```

**Fallback** (if `pg_dumpall --roles-only` is blocked on the managed source) — a
minimal bootstrap that is sufficient for restore + the `app_user` checks:

```sql
-- idw-drill-roles-min.sql  → psql "...55432/postgres" -f idw-drill-roles-min.sql
create role app_user       login nobypassrls;   -- MUST match prod: nobypassrls
create role anon           nologin nobypassrls;
create role authenticated  nologin nobypassrls;
create role service_role   nologin nobypassrls;
create role authenticator  login  noinherit;
```

> If you used the fallback, note it in the drill log — the `app_user`
> NOBYPASSRLS assertion (1f) is still valid because you set it here explicitly to
> match migration `0000_setup_helpers.sql` (`create role app_user login
> nobypassrls`).

### 1e. Restore into the target

```bash
TARGET="postgresql://postgres:drill@localhost:55432/postgres"

# custom-format dump (from 1c, or the nightly artifact if it is custom-format):
pg_restore --no-owner --exit-on-error --jobs=4 \
  --dbname="$TARGET" "idw-drill-${STAMP}.dump"

# If the nightly artifact is a plain .sql instead:
#   psql "$TARGET" -v ON_ERROR_STOP=1 -f nightly-backup.sql
```

A handful of `--no-owner` role-reassignment notices are expected and harmless.
Any error on a `CREATE POLICY` / `GRANT` means a role from 1d is missing — fix
roles and re-run into a fresh target.

### 1f. Verification queries (paste into `psql "$TARGET"`)

Capture each result into the evidence table in §3. Where a check compares against
"the source", get the source number by running the same query against a **freshly
migrated reference DB** (`pnpm db:migrate` into an empty PG17) or against prod at
drill time.

```sql
-- (1) Per-org row counts for the four core tables.
--     org is the tenant root (count total); the rest are org-scoped.
select 'org' as tbl, null::uuid as org_id, count(*) from public.org
union all
select 'membership', org_id, count(*)  from public.membership   group by org_id
union all
select 'audit_log',  org_id, count(*)  from public.audit_log    group by org_id
union all
select 'domain_event', org_id, count(*) from public.domain_event group by org_id
order by tbl, org_id;
-- PASS: per-org counts match the source (spot-check the largest org exactly).

-- (2) RLS policy count (compare to the reference number).
select count(*) as policy_count from pg_policies where schemaname = 'public';
-- PASS: equals the freshly-migrated reference (order of magnitude ~200+ as of
--       migration 0064; do NOT hardcode — capture the reference at drill time).

-- (3) RLS actually ENABLED on the sensitive tables.
select relname, relrowsecurity
from pg_class
where relname in
  ('org','membership','audit_log','domain_event','file','org_storage_usage')
order by relname;
-- PASS: relrowsecurity = true for every row.

-- (4) app_user is NOBYPASSRLS (and not a superuser / can login).
select rolname, rolsuper, rolbypassrls, rolcanlogin
from pg_roles where rolname = 'app_user';
-- PASS: rolsuper=f, rolbypassrls=f, rolcanlogin=t.

-- (5) app_user DELETE grants are ONLY the known narrow allowlist.
select table_schema, table_name
from information_schema.role_table_grants
where grantee = 'app_user' and privilege_type = 'DELETE'
order by table_schema, table_name;
-- PASS: exactly these four (draft/line tables), nothing else —
--   public.org_holiday_calendar
--   public.report_labour_line
--   public.report_material_line
--   public.report_work_line
-- Any other row here is a FINDING (broad delete escalation).

-- (6) Migration ledger completeness.
select count(*) as applied, min(filename) as first, max(filename) as last
from app.migrations;
-- PASS: applied = number of files in supabase/migrations (65 as of 0064),
--       first = 0000_setup_helpers.sql, last = 0064_s10_retention_pruning.sql.

-- (6b) No gaps — list ledger vs. an expected sequence if a count mismatch shows.
select filename from app.migrations order by filename;
```

Cross-check the ledger count against the repo:

```bash
ls supabase/migrations/*.sql | wc -l   # must equal (6).applied above
```

---

## 2. Storage restore

### 2a. Source and target

- **Source:** the two private buckets, `tenant-media` and `tenant-docs`, read via
  the S3 protocol with `STORAGE_S3_*` (OWNER ACTION #3). Endpoint shape:
  `https://<project-ref>.supabase.co/storage/v1/s3`, region `ap-northeast-2`.
- **Target (throwaway, OWNER ACTION #4):** plain S3. Either local MinIO:

  ```bash
  docker run -d --name idw-drill-s3 -p 9000:9000 -p 9001:9001 \
    -e MINIO_ROOT_USER=drill -e MINIO_ROOT_PASSWORD=drillpass \
    minio/minio server /data --console-address ":9001"
  # then create target buckets idw-drill-media / idw-drill-docs in the console
  ```

  …or a throwaway AWS S3 bucket in a scratch account. Both ends speak plain S3 —
  this is exactly the vendor-exit path.

### 2b. Copy the objects

**Path A — rclone, S3 → S3 (recommended; true plain-S3 vendor-exit rehearsal).**
Configure two remotes (`~/.config/rclone/rclone.conf`), values from OWNER ACTIONS
#3 and #4:

```ini
[supa]
type = s3
provider = Other
access_key_id = <STORAGE_S3_ACCESS_KEY_ID>
secret_access_key = <STORAGE_S3_SECRET_ACCESS_KEY>
region = ap-northeast-2
endpoint = https://<project-ref>.supabase.co/storage/v1/s3

[target]
type = s3
provider = Minio            # or AWS
access_key_id = <TARGET_S3_ACCESS_KEY_ID>
secret_access_key = <TARGET_S3_SECRET_ACCESS_KEY>
region = us-east-1          # target region
endpoint = http://localhost:9000   # MinIO; omit for real AWS
```

```bash
rclone sync supa:tenant-media target:idw-drill-media --progress
rclone sync supa:tenant-docs  target:idw-drill-docs  --progress
```

**Path B — AWS CLI (download then upload) when rclone isn't available:**

```bash
SUPA_EP="https://<project-ref>.supabase.co/storage/v1/s3"
AWS_ACCESS_KEY_ID=<STORAGE_S3_ACCESS_KEY_ID> \
AWS_SECRET_ACCESS_KEY=<STORAGE_S3_SECRET_ACCESS_KEY> \
  aws --endpoint-url "$SUPA_EP" --region ap-northeast-2 \
  s3 sync s3://tenant-media ./drill/tenant-media
# ...repeat for tenant-docs, then `aws s3 sync ./drill/... s3://<target>` to the target.
```

### 2c. Produce the authoritative source manifest with the app's own client

The codebase's `objectStore().list(bucket, prefix)`
(`src/platform/tenancy/storage.ts`) is the app's own view of storage — use it to
generate the source inventory the copy is checked against. Save this as
`tooling/scripts/restore-drill-storage.ts` and run it with the source
`STORAGE_S3_*` in the drill env:

```ts
// tooling/scripts/restore-drill-storage.ts
// Run: pnpm tsx tooling/scripts/restore-drill-storage.ts
import "./load-env";
import { objectStore } from "@/platform/tenancy";

const BUCKETS = ["tenant-media", "tenant-docs"] as const;

async function main() {
  const store = objectStore();
  for (const bucket of BUCKETS) {
    const orgs = await store.listTopLevelPrefixes(bucket); // org ids that hold objects
    let bucketObjects = 0;
    let bucketBytes = 0;
    for (const org of orgs) {
      const objs = await store.list(bucket, `${org}/`);
      const bytes = objs.reduce((n, o) => n + o.bytes, 0);
      bucketObjects += objs.length;
      bucketBytes += bytes;
      console.log(`${bucket}\t${org}\t${objs.length}\t${bytes}`);
    }
    console.log(`# ${bucket} TOTAL objects=${bucketObjects} bytes=${bucketBytes}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

This prints one line per `(bucket, org)` with object count and byte total, plus a
per-bucket total. Keep the output — it is the manifest for the checks below.

### 2d. Verify the storage restore

1. **Object counts match, source vs target.** Compare the manifest totals from 2c
   to the target listing:

   ```bash
   rclone size target:idw-drill-media   # objects + bytes
   rclone size target:idw-drill-docs
   # PASS: object counts equal the manifest; byte totals equal per bucket.
   ```

2. **Per-org bytes reconcile against `org_storage_usage`.** Query the **restored**
   DB from §1:

   ```sql
   select org_id, bytes_used, reconciled_at
   from public.org_storage_usage order by org_id;
   ```

   For each org, `bytes_used` should match that org's byte total in the 2c
   manifest, with any small positive delta explained only by in-flight `pending`
   reservations (the nightly reconcile logic counts *ready actual + pending
   reserved* — see `src/workers/functions/storage-reconcile.ts`). A large or
   negative delta is a **FINDING**.

3. **Derivative-set spot-check.** Every `status='ready'` image file carries a
   `variants` map (`main` / `thumb` / `medium` [+ `original`]). Sample rows from
   the restored DB and confirm each variant object landed in the target with the
   right size:

   ```sql
   select f.org_id, f.bucket, v.key as variant,
          v.value->>'path'            as object_path,
          (v.value->>'bytes')::bigint as bytes
   from public.file f, jsonb_each(f.variants) v
   where f.status = 'ready' and f.variants is not null
   order by random()
   limit 30;
   ```

   For each returned `(bucket, object_path, bytes)`, confirm the object exists in
   the target at the same size, e.g.:

   ```bash
   rclone lsl target:idw-drill-media/<object_path>   # size must match `bytes`
   ```

   PASS: every sampled variant is present in the target at the expected byte size
   (paths follow `<org_id>/<class>/<type>/<id>/<file_id>[.variant].<ext>` —
   `src/platform/files/paths.ts`).

---

## 3. Measured evidence (RPO / RTO) — fill during the drill

**RPO** = how much data the restore point could have lost = `now_at_incident −
backup_timestamp`. For the drill, record the backup/restore-point timestamp used
and the objective it is measured against.

**RTO** = wall clock from "start restore" (§1a stopwatch) to "all §1f and §2d
checks green".

| Metric | Objective | Measured this drill | Pass? |
| --- | --- | --- | --- |
| DB source used | — | _PITR clone / nightly dump_ | — |
| Restore-point timestamp (UTC) | — | _YYYY-MM-DDThh:mmZ_ | — |
| **RPO** (data-loss window) | **≤ 1h** | _____ min | ☐ |
| DB restore wall-clock | — | _____ min | — |
| Storage restore wall-clock | — | _____ min | — |
| **RTO** (total to green) | **≤ 4h** | _____ h __ min | ☐ |
| §1f DB verification | all pass | _____ | ☐ |
| §2d storage verification | all pass | _____ | ☐ |

---

## 4. Drill log (append-only)

One row per drill. Quarterly cadence starts at the first entry. Keep this in the
runbook so the history travels with the procedure.

| Date (UTC) | Operator | Witness | Source (A/B) | RPO | RTO | Result | Findings / follow-ups |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _pending first drill_ | | | | | | | |

---

## 5. Vendor-exit note

This drill **is** the vendor-exit rehearsal (checklist #47). Because the DB half
lands in plain Postgres 17 (§1) and the storage half lands in plain S3 (§2), a
green drill demonstrates the exit deliverable end-to-end:

- **Database:** `pg_dump`/`pg_restore` with roles bootstrapped (§1d) → any managed
  or self-hosted Postgres 17. No Supabase-specific object is required for the app
  schema (`public` + `app`); the migration ledger (`app.migrations`) proves the
  schema is reproducible from `supabase/migrations/*.sql` via `pnpm db:migrate`.
- **Storage:** plain S3 sync (§2b) → any S3-compatible store; object paths are
  provider-neutral (`src/platform/files/paths.ts`) and the app reaches storage
  only through the S3 protocol (`STORAGE_S3_*`), so re-pointing `STORAGE_S3_ENDPOINT`
  is the entire migration.

If any step here required a Supabase-only mechanism that has no plain equivalent,
that is an exit-risk **FINDING** — log it in §4.

---

## 6. Teardown

After evidence is captured, destroy the throwaway targets (they hold real tenant
data copies — treat as sensitive):

```bash
docker rm -f idw-drill-pg idw-drill-s3
rm -f idw-drill-*.dump idw-drill-roles*.sql
rm -rf ./drill
# delete the throwaway AWS bucket if one was used
```

Rotate nothing (the drill only read source credentials), but if any credential
was pasted into a shared terminal, log, or ticket, rotate it per
`secret-rotation.md` immediately.

---

## 7. Break-glass note (phase2/10 #45)

Any **direct production data access** during a drill or incident follows the
break-glass rule: **two-party approval recorded BEFORE access**, and **post-hoc
tenant notification** where tenant data was viewed. In this drill the source read
(the `pg_dump` and the storage `list`/`sync`) is production tenant data — so the
operator + witness co-sign the drill-log entry (§4) as the two-party record, and
because real tenant data is copied to the targets, treat teardown (§6) as
mandatory and notify per the incident/break-glass policy if the copies were
retained. Access is via `DIRECT_URL` / `STORAGE_S3_*` credentials only, **never**
the app runtime, and never onto production.

---

## First drill result (template — complete during the actual first drill)

> Fill this in verbatim during the first drill, then copy the summary row into the
> §4 drill log. Leave the `_TBD_` markers until measured.

**Drill date (UTC):** _TBD_
**Operator / Witness:** _TBD_ / _TBD_
**Environment:** target DB = local Docker `postgres:17` on `localhost:55432`;
target storage = _MinIO local_ / _scratch AWS bucket_ (circle one).

**Source chosen:** _Option A (PITR clone)_ / _Option B (nightly logical dump)_
**Restore-point timestamp (UTC):** _TBD_
**PITR add-on active at drill time?** _yes / no_ (if no, RPO bounded by nightly
cadence — record the actual cadence).

**Database verification (§1f):**

| Check | Expected | Observed | Pass |
| --- | --- | --- | --- |
| (1) per-org counts org/membership/audit_log/domain_event | match source | _TBD_ | ☐ |
| (2) `pg_policies` count (public) | = reference (~200+ @ 0064) | _TBD_ | ☐ |
| (3) RLS enabled on 6 sensitive tables | all true | _TBD_ | ☐ |
| (4) app_user rolbypassrls / rolsuper | false / false | _TBD_ | ☐ |
| (5) app_user DELETE grants | only the 4 allowlisted line/calendar tables | _TBD_ | ☐ |
| (6) `app.migrations` count / last | 65 / `0064_s10_retention_pruning.sql` | _TBD_ | ☐ |

**Storage verification (§2d):**

| Check | Expected | Observed | Pass |
| --- | --- | --- | --- |
| object counts source vs target (both buckets) | equal | _TBD_ | ☐ |
| per-org bytes vs `org_storage_usage.bytes_used` | match ± pending reservations | _TBD_ | ☐ |
| derivative spot-check (30 sampled variants) | all present, sizes match | _TBD_ | ☐ |

**Measured objectives:**

| Metric | Objective | Measured | Pass |
| --- | --- | --- | --- |
| RPO | ≤ 1h | _TBD_ | ☐ |
| RTO | ≤ 4h | _TBD_ | ☐ |

**Findings / follow-ups:** _TBD_ (e.g. "pg_dumpall --roles-only blocked on managed
source → used minimal bootstrap"; "backup-status monitor still unbuilt — owner
confirmed backup manually"; any step lacking a plain-provider equivalent).

**Sign-off:** operator _______ · witness _______ · date _______
