# Retention Runbook (doc 10 #36 · doc 01 Appendix B)

**What this covers:** the data-retention windows IdaraWorks prunes, the ≥6-year financial-audit floor
that is **never** pruned, and how an operator runs / verifies pruning. Retention pruning is a
**platform** job — it deletes ephemeral rows that `app_user` has no DELETE grant on, via a
`SECURITY DEFINER` function guarded by `app.assert_platform_task()`.

## Windows (doc 01 Appendix B)

| Table | Pruned when | Notes |
| --- | --- | --- |
| `notification` | `read_at` older than **90d**, OR any row older than **12mo** | recipient-private |
| `exception` | `resolved_at` (cleared) older than **24mo** | OPEN exceptions are never pruned |
| `ai_interaction` | older than **12mo** | the AI-spend/usage metadata ledger |
| `digest` | `digest_date` older than **90d** | headline-only retention beyond that is deferred |
| `domain_event` | 30–90d after processing | pruned by the **outbox relay** (not this job) |

**Never pruned — deliberately excluded by omission, not predicate:**

- **`audit_log`** — financial-mutation audit rows are kept **≥ 6 years regardless of tier** (KSA ≥6yr
  / UAE ≥5yr VAT-record law overrides any per-tier policy). `app.prune_retention` does not reference
  this table at all.
- **`activity`** — the tenant-visible history promise; kept.

## The mechanism

- `supabase/migrations/0064_s10_retention_pruning.sql` defines
  `app.prune_retention(p_now timestamptz default now())` — a plpgsql `SECURITY DEFINER` function with
  `set search_path = ''` that `perform app.assert_platform_task()` first (so a tenant session with an
  org GUC is rejected), then deletes per the windows above and returns the per-table counts.
- `src/workers/functions/retention-prune.ts` wraps it as `pruneRetention()` + the
  `retentionPruneCron` (registered in `src/workers/index.ts`, id `retention-prune`, ~03:30 UTC nightly).
- **The cron is DORMANT in production until Inngest is provisioned** (owner action —
  `runbooks/inngest-provisioning.md`). Until then, run it on demand (below); nothing accumulates
  unsafely because the windows are generous and the financial floor is absolute.

## Run it manually (until the cron is live)

From a machine with `DIRECT_URL` in `.env.local` (owner/DB access):

```bash
cd C:/Users/abdul/Desktop/idaraworks
pnpm tsx -e "import('./src/workers/functions/retention-prune').then(m=>m.pruneRetention()).then(r=>{console.log(r);process.exit(0)})"
```

or directly against the DB (the DEFINER runs from the platform no-context client):

```sql
select * from app.prune_retention();
-- → notifications_pruned | exceptions_pruned | ai_interactions_pruned | digests_pruned
```

**Do NOT** call `app.prune_retention(NULL)` — an explicit NULL overrides the `default now()` and every
`col < NULL` window is false, making it a silent no-op. Call it **with no argument** (or pass a real
timestamp only in tests).

## Verify

- The call returns counts; 0/0/0/0 on a clean/young database is correct.
- Confirm the financial floor holds: `select min(created_at) from public.audit_log where org_id = '<org>'`
  should still show rows older than any retention window (they are never pruned).
- After the Inngest cron is live: `/api/health` `checks.queue` shows the outbox draining; a nightly
  `retention prune complete` line appears in logs (pino) with the counts.

## Owner actions

- **[OWNER ACTION]** Provision **Inngest Cloud** keys to make `retentionPruneCron` fire nightly
  (`runbooks/inngest-provisioning.md`). Until then this is an on-demand job.
- **[OWNER ACTION]** Confirm the legal retention floors for the pilot jurisdictions (KSA ≥6yr, UAE
  ≥5yr) with counsel; the code enforces ≥6yr by never pruning `audit_log`.
