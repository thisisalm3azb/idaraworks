# Incident Response (phase2/10 #50; BUILD_BIBLE §15.7)

**Flow: detect → contain → scope per-tenant → notify → post-mortem.**
Tabletop-test this runbook before launch (doc-10 #50 `DRILL`).

## Severity ladder

| Sev | Definition | Response |
| --- | --- | --- |
| SEV-1 | Tenant-isolation suspicion (cross-org data visible), data loss, full outage | Act immediately; contain first, diagnose second |
| SEV-2 | A core flow broken for all orgs (login, org load, uploads), queue dead-letters accumulating | Same day |
| SEV-3 | Degraded behaviour with workaround; single-org impact | Ticket, next working day |

Page-worthy signals (Bible §15.4): tenancy failures, backup/replication
failures, **queue dead-letters** (Sentry `outbox_dead_letter`), error-rate
burns. Everything else is a ticket.

## Detect

- `/api/health` — per-dependency truth (db / storage / queue / inngest).
- Vercel logs — filter `level=error`; every line carries `request_id`.
- Sentry (once provisioned) — issues tagged `request_id` / `worker` / `org_id`.
- User report — the error page shows a **digest**; every response carries
  `x-request-id`. Either id finds the exact `unhandled request error` log line.

## Contain

- App-level fault → roll back per `deployment-and-rollback.md` (minutes).
- Suspected tenant-isolation fault (SEV-1) → **pause production traffic**
  (Vercel dashboard → pause deployment or password-protect), preserve logs,
  do NOT delete or "clean up" anything before evidence capture.
- Storage credential suspicion → rotate per `secret-rotation.md` (storage keys
  cannot touch the DB by design — Bible §5.2 blast-radius note).

## Scope per-tenant (before any external message)

Tenant-scoped impact assessment FIRST: from logs/audit (`audit_log`,
`sign_in_log`, `domain_event.org_id`), enumerate which orgs were actually
affected and in what window. The bleed harness + RLS design mean cross-org
reads require a platform fault — treat any such evidence as SEV-1 and preserve
it.

## Notify

- Affected orgs within the regulatory window applicable to their country
  (UAE/KSA data-protection timelines; record the clock start = detection time).
- Keep a factual timeline (UTC) as you go — it becomes the post-mortem spine.

## Post-mortem (blameless)

Within 5 working days: timeline, root cause, blast radius, what limited it,
what would have caught it earlier. **The closing artifact is a regression
test** (Bible §15.7) merged to `main` — the incident is not closed without it.
