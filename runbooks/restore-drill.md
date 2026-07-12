# Restore Drill (phase2/10 #47 — stub until the first drill)

**Requirement:** a quarterly restore drill covering **database AND storage** to
plain Postgres + plain S3 (doubles as the vendor-exit rehearsal). **The first
drill must run before pilot start** — this stub becomes the full runbook with
measured timings from that drill.

## Database

1. Source: Supabase PITR (owner item: confirm the PITR add-on is active on the
   hosted project before pilots) or the latest daily backup.
2. Restore target: a plain Postgres 17 instance (never the production project).
3. Procedure sketch: create target → `pg_restore`/PITR export → run the
   verification queries below → record duration (RTO evidence) and the backup
   timestamp used (RPO evidence).
4. Verify: row counts per org for `org`, `membership`, `audit_log`,
   `domain_event`; audit append-only triggers present; RLS policies present
   (`select count(*) from pg_policies where schemaname='public'`).

## Storage

1. Source: the two private buckets (`tenant-media`, `tenant-docs`).
2. Restore target: any plain S3-compatible store.
3. Procedure sketch: `objectStore().list()` per bucket → copy objects →
   verify object counts + spot-check derivative sets against
   `org_storage_usage` and the reconcile report
   (`tooling/scripts` storage reconcile from Phase E).

## Break-glass note (phase2/10 #45)

Any direct production data access during a drill or incident follows the
break-glass rule: two-party approval recorded BEFORE access, post-hoc tenant
notification where tenant data was viewed. Access is via `DIRECT_URL`
credentials only, never the app runtime.

## To complete at first drill

- [ ] Measured RTO/RPO
- [ ] Exact command list (replacing the sketches above)
- [ ] Drill log entry (date, operator, findings) — quarterly cadence starts
