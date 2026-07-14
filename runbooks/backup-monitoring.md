# Backup Stack & Monitoring (phase2/10 #46 — resilience)

**Requirement (doc-10 #46):** PITR on the primary DB; nightly logical backups to
a second provider/region; **nightly incremental bucket replication + manifest for
storage (audit F-34)**; **backup monitors** that alarm on failure/staleness.
Recovery objectives (doc-10 #48): **RPO ≤ 1h, RTO ≤ 4h** — the backup cadence
below is what makes those achievable; the [restore-drill](restore-drill.md)
measures them.

> **Read this first — current status.** Three of the four backup layers are
> **OWNER ACTIONS not yet performed**, and the monitor that watches them is a
> **documented seam, not a live alarm**. Until the owner provisions (1) the
> Supabase PITR add-on, (2) a second-provider logical-backup target, (3) a
> second-provider storage bucket, and (4) a Supabase Management API token, this
> runbook describes *where the code hooks in* — it is not yet protecting
> production data. This mirrors the deliberate env-gated pattern already used for
> [Sentry](sentry-provisioning.md) and [Inngest](inngest-provisioning.md): the
> seams exist and are inert until their secret is present. Do not report backups
> as "monitored" in any readiness sign-off until §5 verification passes end to
> end.

---

## 0. What exists vs. what the owner must provision

| Layer | Requirement | Status | Owner action |
| --- | --- | --- | --- |
| **A. Postgres PITR** | Continuous WAL archiving + point-in-time restore on the hosted primary | **NOT ENABLED** — hosted project has default daily backups only | **OA — enable the Supabase PITR add-on; record retention days** |
| **B. Logical backups → 2nd provider** | Nightly `pg_dump` shipped to a different provider/region | **SEAM ONLY** — script not built; no target provisioned | **OA — provision second-provider Postgres/object target + DSN/keys** |
| **C. Storage replication + manifest** | Nightly incremental copy of both buckets to a 2nd-provider bucket + a manifest for verification (audit F-34) | **PARTIAL** — enumeration primitives exist (`objectStore().list` / `listTopLevelPrefixes`); no destination, no replicator | **OA — provision second-provider S3 bucket + credentials** |
| **D. Backup monitor** | Nightly check of A/B/C freshness → standard alarm on failure/staleness | **SEAM ONLY** — cron infra exists (Inngest), the check is not wired; needs the mgmt API token | **OA — provision Supabase Management API token (read-only, backup scope)** |

The four owner actions are independent — each can be provisioned and verified on
its own. The monitor (D) reports each layer's freshness separately, so a partial
rollout (e.g. PITR enabled but replication not yet) shows exactly which layers
are live and which are still `unconfigured`, never a generic failure. This is the
same "explain the pre-provisioning state, don't fail opaquely" law the health
probe uses for `inngest.status = "unconfigured"`
(`src/platform/observability/health.ts`).

---

## 1. Layer A — Postgres PITR on the primary  `[OWNER ACTION]`

**What it protects:** the authoritative tenant database (all org data, audit_log,
domain_event). PITR turns "restore to last night's snapshot" (RPO ~24h) into
"restore to any second in the retention window" (RPO ≤ 1h, satisfying #48).

**Owner steps (Supabase dashboard):**

1. Project → **Settings → Add-ons → Point-in-Time Recovery** → enable.
2. Choose retention. **Record the retention days here** once set:
   `PITR retention = ____ days` (recommend ≥ 7). This is the RPO ceiling — a
   restore can only go back as far as retention.
3. Confirm the WAL/physical backup schedule shows **healthy / recent** on the
   dashboard Backups tab.

**Where PITR is consumed:** the [restore-drill](restore-drill.md) "Database"
section restores from PITR (or the latest daily backup) to a **plain Postgres 17
instance — never the production project**. Break-glass rules
([incident-response](incident-response.md), doc-10 #45) apply to any direct
production data access: two-party approval recorded *before* access, via
`DIRECT_URL` credentials only, never the app runtime.

**Notes / constraints:**
- The app role (`app_user`) is `NOBYPASSRLS` with **no delete grants** — it
  cannot be used to take or restore backups. All backup/restore paths use the
  privileged direct connection (`DIRECT_URL`, port 5432 / session pooler), the
  same credential `tooling/scripts/migrate.ts` uses.
- PITR is a Supabase-managed feature; there is no repo code for it. Its only
  contact with this codebase is the freshness check in §4.

---

## 2. Layer B — Nightly logical backups to a second provider/region  `[OWNER ACTION + SEAM]`

**Why, in addition to PITR:** PITR lives inside the *same* Supabase project. A
provider-level loss (account, region, billing) takes PITR with it. A nightly
`pg_dump` shipped to a **different provider and region** is the vendor-exit /
provider-loss hedge. It doubles as the vendor-exit rehearsal source in the
restore drill.

**Owner action (provision the target):**
- Stand up a second-provider destination in a **different region** from Seoul
  (`ap-northeast-2`). Two acceptable shapes:
  - a plain Postgres 17 instance elsewhere (restore target ready), **or**
  - an object store elsewhere holding the dump artifacts (cheaper; restore is a
    `pg_restore` step during a drill).
- Record its connection secret. Proposed env names (add to `.env.example` when
  built, install per [secret-rotation](secret-rotation.md)):
  - `BACKUP_DB_URL` — DSN of the second-provider Postgres, **or**
  - `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` / `BACKUP_S3_ACCESS_KEY_ID` /
    `BACKUP_S3_SECRET_ACCESS_KEY` — second-provider object store for dump files.
- These are **tooling/CI-only** secrets. Like `DIRECT_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`, they must **never** land in Vercel app runtime env
  (doc-10 #1, lint-guarded).

**Seam to build — `tooling/scripts/logical-backup.ts`** (does not exist yet;
model it on `tooling/scripts/migrate.ts`):
1. `import "./load-env"` then read `DIRECT_URL` (source) — refuse to run if unset,
   exactly as `migrate.ts` does.
2. `pg_dump` the source over `DIRECT_URL` (`--format=custom --no-owner
   --no-privileges`), streaming to a timestamped artifact
   `idaraworks-YYYYMMDDTHHMMZ.dump`.
3. Ship the artifact to the second-provider target (`BACKUP_*`). For the S3
   shape, reuse the `AwsClient` PUT pattern already in
   `src/platform/tenancy/storage.ts` (`objectStore().put`), pointed at
   `BACKUP_S3_*` instead of `STORAGE_S3_*`.
4. Write a small **result record** the monitor can read (see §4): the artifact
   name, byte size, source LSN/timestamp, and completion time. Simplest durable
   home is a row via `DIRECT_URL` in an owner-only `app.backup_run` table
   (create in a forward migration when this lands) — the monitor then reads
   freshness from the DB, no cross-provider API needed for B.
5. Retention on the target: keep ≥ 7 daily dumps; prune older (the second
   provider's lifecycle policy, or a tail of the same script).

**Scheduling the seam:** run it from **CI on a schedule** (GitHub Actions
`schedule:` cron in the existing `migrations`-privileged env, which already holds
the direct/service credentials) rather than from Vercel/Inngest — logical dump is
a heavy, credentialed, long-running job that does not belong in the app runtime
(which never holds `DIRECT_URL`). Nightly, offset from the 02:00–03:30 UTC app
crons (e.g. `0 1 * * *` UTC).

---

## 3. Layer C — Nightly incremental bucket replication + manifest  `[OWNER ACTION + SEAM]`

**What it protects:** the two private buckets `tenant-media` and `tenant-docs`
(originals + image derivatives). Storage is *not* covered by DB PITR — it needs
its own copy.

**What already exists (reuse it):**
- `objectStore()` in `src/platform/tenancy/storage.ts` — the storage-scoped S3
  worker credential (`STORAGE_S3_*`). Blast radius = storage only; it cannot
  touch the DB (Bible §5.2).
  - `list(bucket, prefix)` — paginated recursive listing (path + bytes).
  - `listTopLevelPrefixes(bucket)` — the org-id folders present.
  - `get` / `put` — object copy primitives.
- `src/workers/functions/storage-reconcile.ts` — the nightly per-org reconcile
  (Inngest cron `0 2 * * *` UTC) that already *walks both buckets*, trues the
  usage counter, and does **leak detection** (bucket listing vs
  `app.org_known_object_paths`). The replicator/manifest is a natural sibling to
  this and can share its enumeration approach.

**Owner action (provision the destination):**
- A **second-provider S3-compatible bucket** in a different region. Record:
  `BACKUP_MEDIA_S3_*` (endpoint/region/keys), or reuse the `BACKUP_S3_*` names
  from §2 with a bucket suffix. Storage-scoped only.

**Seam to build — `tooling/scripts/storage-replicate.ts`** (or a Layer-C worker
sibling to `storage-reconcile.ts`; does not exist yet):
1. For each bucket (`tenant-media`, `tenant-docs`): `objectStore().list(bucket,
   "")` to enumerate source objects (path, bytes).
2. **Incremental:** compare against the previous run's **manifest** (see below).
   Copy only new/changed keys (changed = size differs, or an object HEAD ETag
   differs) source→destination via `get` then `put` to the `BACKUP_*` client.
3. Write a **manifest** for this run: a newline-delimited or JSON list of
   `{path, bytes, etag}` per bucket, plus counts and completion time. Store the
   manifest **both** at the destination (for restore-side verification) and as a
   `app.backup_run` row (kind = `storage`) for the monitor. The manifest is the
   audit-F-34 artifact — restore verification (restore-drill "Storage" section)
   diffs a restored bucket against it.
4. Per-object failures must be isolated (one bad object never aborts the run) —
   same fault-isolation law `reconcileAllOrgs` already follows.

**Cadence:** nightly, adjacent to `storage-reconcile` (which runs `0 2 * * *`
UTC). If built as an Inngest worker it inherits the same dormant-until-provisioned
behaviour (see §7); if built as a CI job it runs regardless of Inngest.

---

## 4. Layer D — The backup monitor (the actual alarm)  `[SEAM — describe, then build]`

This is doc-10 #46's "backup monitors" clause. Three freshness facts must be
checked nightly, and any **failure or staleness** must raise the **standard
alarm**.

### 4.1 What "the standard alarm" is here

The platform already has exactly one page-worthy alarm mechanism, used by the
outbox relay for dead-letters (Bible §15.4). Reuse it verbatim — do **not** invent
a new channel:

- **ERROR-level structured log** via `logger.error({...}, "…")`
  (`src/platform/logger`) — the same call `storage-reconcile.ts` uses for orphan
  leaks and `outbox-relay` uses for dead-letters. Vercel → Logs, filter
  `level=error`.
- **Sentry capture** — env-gated, a clean no-op until `SENTRY_DSN` is set
  (`src/platform/observability/sentry.ts`). Add a sibling to the existing
  `captureDeadLetter()` — e.g. `captureBackupStaleness(details)` that
  `Sentry.captureMessage("backup stale/failed", "error")` with a
  `channel: "backup_monitor"` tag and **identifiers/counts only** (never a
  connection string, key, or object path) — the same PII-scrub law
  (`scrubEvent`) all captures obey. Export it from
  `src/platform/observability/index.ts` next to `captureDeadLetter`.

### 4.2 Freshness thresholds (staleness = alarm)

| Layer | Fresh if… | Stale/failed → alarm |
| --- | --- | --- |
| A. PITR | Supabase mgmt API reports the latest physical backup / WAL within the last **26h** and PITR add-on = active | add-on disabled, or newest backup age > 26h |
| B. Logical dump | newest `app.backup_run(kind='logical')` completed < **26h** ago and byte size > 0 | no row < 26h, or `ok=false`, or 0 bytes |
| C. Storage replica | newest `app.backup_run(kind='storage')` < **26h** ago and manifest object count ≥ last known good | no row < 26h, or `ok=false` |

26h = one nightly cycle + a 2h grace so a slightly-late run does not false-alarm.

### 4.3 The seam — extend a nightly cron

Two equivalent homes; pick one when building:

- **(Preferred) a new Inngest worker** `src/workers/functions/backup-monitor.ts`,
  wired into `src/workers/index.ts` `workerFunctions[]` (add its export there and
  register it — that array *is* the fleet `/api/inngest` serves). Give it a
  nightly `cron("45 3 * * *")` UTC so it runs **after** the 01:00 logical dump,
  02:00 storage reconcile/replicate, and 03:30 retention prune — i.e. it checks
  freshness once every backup for the night has had its chance to complete. It is
  a **platform task** (no org context) — build it on the `createAppDb({ max: 1 })`
  pattern that `retention-prune.ts` uses, so it may read `app.backup_run` and call
  the mgmt API.
- **(Alternative) a CI scheduled job** in the same privileged GitHub env as the
  logical backup, running the check right after the dump. Use this if the owner
  wants the monitor independent of Inngest provisioning (see §7).

The check body:
1. **A (PITR):** `GET https://api.supabase.com/v1/projects/{ref}/database/backups`
   with header `Authorization: Bearer $SUPABASE_MGMT_API_TOKEN`. Parse the newest
   backup / PITR window end; compute age. **The token is an OWNER-provisioned
   secret** — see §4.4.
2. **B, C:** query `app.backup_run` over `DIRECT_URL` (or `createAppDb` if the
   monitor is the Inngest worker — a **platform** session, allowed to read
   owner-only backup tables under the same law `health.ts` uses to call
   `app.outbox_stats`).
3. For each layer that is stale/failed → `logger.error(...)` + the Sentry capture.
   For each layer whose secret is **absent** (e.g. no mgmt token yet) → report
   `unconfigured` (a `logger.warn`, **not** an error/alarm) so a not-yet-provisioned
   layer never pages, exactly like `inngest.status = "unconfigured"`.
4. **Optionally** surface the latest result on `/api/health` as a
   `checks.backups` block (fresh counts + per-layer `ok|stale|unconfigured`), so
   operators can eyeball backup state on the same endpoint as db/storage/queue.
   Keep it a **non-gating** status (like `queue`/`inngest`) — a stale backup must
   never 503 the app.

### 4.4 The Management API token  `[OWNER ACTION]`

- Supabase dashboard → **Account → Access Tokens** → create a token scoped as
  narrowly as the platform allows (read/backup). Record the **project ref**.
- Proposed env names: `SUPABASE_MGMT_API_TOKEN`, `SUPABASE_PROJECT_REF`.
- **Tooling/CI-only** — never Vercel app runtime (it can read/modify project
  infrastructure; treat it at the sensitivity of `SUPABASE_SERVICE_ROLE_KEY`).
  Store in `.env.local` + the GitHub `migrations` env only. Add to
  [secret-rotation](secret-rotation.md) with quarterly rotation and
  immediate-on-exposure rules.
- **Until this token exists, Layer-A freshness cannot be checked** — the monitor
  reports PITR as `unconfigured` and the operator must eyeball the dashboard
  Backups tab during the monthly checklist (§6).

### 4.5 Alert routing

- **Logs:** always on. Vercel → Logs, `level=error`, message `backup …`.
- **Sentry:** once `SENTRY_DSN` is provisioned ([sentry-provisioning](sentry-provisioning.md)),
  add an **alert rule on `channel:backup_monitor` events** (and on any
  `environment:prod` first-seen) → operator email/phone. This sits beside the
  existing required rule on `outbox_dead_letter`. Both are the Bible §15.4
  page-worthy set.
- Backup/replication failure is explicitly a **page-worthy** signal in the
  incident severity ladder ([incident-response](incident-response.md)):
  persistent backup failure is **SEV-2** (same-day); a confirmed loss of the
  primary with no valid recent backup is **SEV-1**.

---

## 5. Bring-up verification (run once per layer, when the owner provisions it)

Do these in order as each owner action completes. A layer is not "done" until its
row here passes.

- [ ] **A — PITR:** add-on shows active; dashboard Backups tab shows a recent
      healthy backup; retention days recorded in §1. Monthly restore drill
      ([restore-drill](restore-drill.md)) exercises an actual PITR restore to a
      throwaway Postgres.
- [ ] **B — Logical dump:** run `pnpm tsx tooling/scripts/logical-backup.ts` once
      by hand; confirm an artifact landed at the second-provider target with
      non-zero bytes and an `app.backup_run(kind='logical', ok=true)` row.
      `pg_restore --list` the artifact to prove it is readable.
- [ ] **C — Storage replica:** run the replicator once; confirm object counts at
      the destination match the source manifest for both buckets and an
      `app.backup_run(kind='storage', ok=true)` row exists.
- [ ] **D — Monitor happy path:** run the monitor with all secrets present;
      confirm it logs a clean pass and (if wired) `/api/health` →
      `checks.backups` shows all layers `ok`, none `unconfigured`.
- [ ] **D — Monitor alarm path:** force one staleness (e.g. temporarily point the
      monitor at a `backup_run` fixture older than 26h, or revoke the mgmt token)
      and confirm **both** an ERROR log line **and** a Sentry `backup_monitor`
      event fire, and the Sentry alert rule routes to the operator. This is the
      equivalent of the seeded-error check in
      [sentry-provisioning](sentry-provisioning.md) §3 — the monitor is not
      trustworthy until its alarm has been *seen* to fire.

---

## 6. Monthly operator verification checklist

Run on the first working day of each month; log completion in the ops log
(doc-10 §12 evidence). Until §5 is complete for a layer, its check is a manual
dashboard eyeball, flagged `[manual — layer not yet provisioned]`.

1. **PITR live & fresh:** dashboard Backups tab — add-on active, newest backup <
   26h, retention unchanged from §1. Or, once the mgmt token exists, read the
   monitor's last `checks.backups.pitr` result.
2. **Logical dumps landing:** second-provider target holds ≥ 7 recent daily
   artifacts, newest < 26h, non-zero bytes; newest `app.backup_run(kind='logical')`
   `ok=true`.
3. **Storage replica current:** destination object counts for both buckets within
   expected drift of source; newest `app.backup_run(kind='storage')` `ok=true`;
   manifest present.
4. **Monitor is actually running:** confirm the nightly monitor produced a result
   every night this month (no silent gap). A monitor that stopped running is a
   failure mode as bad as a failed backup.
5. **Alarms wired:** the Sentry alert rule on `channel:backup_monitor` still
   exists and routes to a current operator contact; send/observe a test if the
   operator roster changed.
6. **No `unconfigured` layers remain** (once the owner intends all four live). Any
   layer still `unconfigured` is an open owner action, not an acceptable steady
   state.
7. **Restore rehearsal cadence:** confirm the quarterly restore drill
   ([restore-drill](restore-drill.md)) is on schedule — backups you have never
   restored are unproven. First drill must run **before pilot start** (doc-10
   #47).

---

## 7. Why this is a seam, not yet a live monitor (read before sign-off)

- The Inngest worker fleet (`src/workers/index.ts`) — including any
  `backup-monitor` worker added per §4.3 — is **dormant in production** until the
  owner completes Inngest provisioning (OA-4,
  [inngest-provisioning](inngest-provisioning.md)). `/api/health` currently
  reports `checks.inngest.status = "unconfigured"` and `/api/inngest` returns
  `503 inngest_unconfigured`. **No nightly cron actually fires in production
  today** — so an Inngest-hosted backup monitor would not run until Inngest is
  live. If the owner wants backup monitoring *before* committing to Inngest, build
  Layer D as the **CI scheduled job** variant (§4.3, §2) — CI runs regardless of
  Inngest.
- Sentry is likewise env-gated: without `SENTRY_DSN` the alarm's paging half is a
  no-op (log-only). Provision Sentry ([sentry-provisioning](sentry-provisioning.md))
  or the monitor can detect staleness but cannot page.
- Layers B and C have **no destination provisioned** and **no script written**;
  Layer A's freshness cannot be polled without the **mgmt token**.

**Therefore:** until the owner provisions **PITR + second-provider DB target +
second-provider bucket + Management API token**, and Sentry + (for the worker
path) Inngest are live, this document is the *design of record* for backup
monitoring — the hooks, thresholds, alarm channel, and verification are all
specified — but **backups are not being monitored in production**. Do not mark
doc-10 #46 satisfied, and do not enter pilot, on the strength of this file alone;
mark it satisfied only when §5 passes for all four layers and the §6 checklist has
one clean monthly run on record.

---

## Related runbooks

- [restore-drill.md](restore-drill.md) — the quarterly DB + storage restore that
  *consumes* these backups and measures RPO/RTO (doc-10 #47/#48).
- [secret-rotation.md](secret-rotation.md) — where `SUPABASE_MGMT_API_TOKEN`,
  `BACKUP_*`, `DIRECT_URL`, and the storage keys live and how they rotate.
- [incident-response.md](incident-response.md) — severity of a backup/replication
  failure; break-glass rules for any direct production data access during a
  restore.
- [sentry-provisioning.md](sentry-provisioning.md) /
  [inngest-provisioning.md](inngest-provisioning.md) — the two env-gated seams the
  monitor's alarm and schedule depend on.
