# IdaraWorks Runbooks (S0)

Operational procedures required by the S0 Execution Checklist §15 ("Docs") and
BUILD_BIBLE §14.7/§15.7. Each runbook is self-contained; none contains secret
values — secrets live only in the platform stores named in `secret-rotation.md`.

| Runbook | Covers | Source requirement |
| --- | --- | --- |
| [deployment-and-rollback.md](deployment-and-rollback.md) | Deploying `main` to Vercel production; verifying; rolling back | Bible §14.5/§14.7 |
| [incident-response.md](incident-response.md) | Severity ladder, tenant-scoped triage, notification, post-mortem | phase2/10 #50; Bible §15.7 |
| [dead-letter-recovery.md](dead-letter-recovery.md) | Diagnosing and redriving dead-lettered domain events | Bible §8.7/§15.4 |
| [secret-rotation.md](secret-rotation.md) | Where every secret lives; quarterly + emergency rotation | phase2/10 #37; checklist §12 |
| [restore-drill.md](restore-drill.md) | Quarterly DB + storage restore drill (stub until first drill) | phase2/10 #47 (+ #45 break-glass note) |
| [inngest-provisioning.md](inngest-provisioning.md) | Owner action: provision Inngest Cloud, install keys, verify | OA-4; Phase G/I |
| [sentry-provisioning.md](sentry-provisioning.md) | Owner action: provision Sentry, install DSN, verify seeded error | OA-4; checklist §15 |

**Operational surfaces** (Phase I):

- `GET /api/health` — per-dependency status: `db`, `storage`, `queue`
  (outbox backlog / oldest age / dead-letters), `inngest`
  (`configured|unconfigured`). 503 when db or storage is down.
- `GET /api/ready` — dependency-free readiness (process serves traffic).
- `pnpm smoke:prod [-- <url>]` — read-only production smoke suite.
- Logs: structured JSON (pino), every request-scoped line tagged
  `request_id` / `org_id` / `user_id`; **no tenant business values at info+**.
  Vercel → Project → Logs; filter by `request_id` from a user report (the
  error page shows the digest; every response echoes `x-request-id`).
- Sentry (once provisioned): errors tagged `request_id`, worker failures
  tagged `worker`/`org_id`, dead-letters as `outbox_dead_letter` events.
