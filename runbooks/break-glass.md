# Break-Glass Emergency Data Access (phase2/10 #45; BUILD_BIBLE §5.2/§15.7)

**One-line rule:** break-glass = a human connecting **directly to the production
database over `DIRECT_URL`**, bypassing the app and RLS, to resolve an incident
that the normal tooling and the consent-gated support path cannot. It is the
most privileged action in this system. It is **never** the first move, **always**
two-party-approved **before** access, **always** logged, and — where any tenant's
data was viewed — **always** followed by a post-hoc notification to that tenant.

Why it is dangerous, stated plainly: `DIRECT_URL` connects as the privileged
migration/owner role (the table owner). Table owners are **not** subject to Row
Level Security, so this connection can read and write across **every** tenant at
once. The app's `app_user` role is `NOBYPASSRLS` and holds **no `DELETE` grant**
by design (Bible §5.2); the break-glass role has neither of those guardrails.
Treat every keystroke accordingly.

---

## 1. When this applies (trigger conditions)

Break-glass is justified only when a **production incident requires direct data
access that normal tooling cannot deliver**. Concretely:

| Situation | Normal tool that should be tried first | Break-glass justified when… |
| --- | --- | --- |
| A tenant needs support / a value inspected or corrected | **S9 consent-gated support impersonation** (see §2) | Impersonation itself cannot run — app is down, RLS/tenancy is the suspected fault, or the fix is below the app layer |
| Dead-lettered domain events | `pnpm tsx tooling/scripts/redrive-dead-letters.ts` (`dead-letter-recovery.md`) | Rows need inspection/surgery the redrive script cannot express, or the relay path itself is broken |
| Bad release | Roll back per `deployment-and-rollback.md` (minutes, no data touch) | A migration wedged mid-apply, or data written by the bad release must be examined/repaired directly |
| Data loss / corruption | **PITR / restore drill** (`restore-drill.md`) — restore to a *separate* instance | Forensics or a targeted repair on the live DB is genuinely unavoidable *and* restore is not the right remedy |
| Stuck subscription / entitlement / dunning state | The S9 platform DEFINER RPCs via the app (`advance_subscription`, reconciliation tooling) | The state machine is wedged in a way the guarded RPCs refuse and cannot express |
| Incident forensics (SEV-1 tenant-isolation suspicion) | `audit_log`, `sign_in_log`, `domain_event`, `/api/health`, Vercel logs, Sentry | Cross-table read-only SQL is required to scope blast radius (`incident-response.md` → "Scope per-tenant") |

If a listed normal tool **can** resolve it, use that tool. Break-glass is the
exception, not a convenience.

**Not triggers:** routine data edits, "it's faster in SQL," bulk backfills,
cosmetic corrections, anything a migration or an app admin action can do. Those
go through migrations (`pnpm db:migrate`) or the app.

---

## 2. The normal path first — S9 consent-gated support impersonation

Before reaching for `DIRECT_URL`, confirm the **normal support path is
genuinely insufficient.** S9 shipped exactly for tenant support:

- `src/modules/support/service.ts` — `startImpersonation()` / `endImpersonation()`.
  A member of the `platform_staff` allow-list opens a **governed, time-bounded**
  session into a tenant org. It runs as `app_user` **under RLS**, the tenant sees
  a **persistent banner** (`hasActiveImpersonation`), and every start/end is
  **dual-logged** — to the platform stream **and to the tenant's own `audit_log`**
  (`app.record_platform_audit`, actions `support.impersonation_started` /
  `_ended`). This is the DoD AC: *"a support session is visible in the tenant's
  own audit log."*
- That path even has its **own** in-app "break-glass" mode
  (`impersonation_session.break_glass = true`, migration 0056): an emergency
  override that skips explicit tenant consent **but is still** platform-staff-gated,
  still RLS-scoped, still banner-shown, and still tenant-visible in `audit_log`.

**Decision gate:** if in-app impersonation (consent **or** its `break_glass`
override) can do the job, use it — it is safer in every dimension (RLS-scoped,
tenant-visible, no owner credentials leave their store). **This runbook's
break-glass is strictly higher:** raw DB access as the owner role, off-RLS,
outside the app, used *only* when the app-level path cannot reach the problem
(app down, tenancy layer is the bug, or the work is sub-application: migrations,
outbox internals, corruption repair, forensic cross-tenant reads).

---

## 3. The four non-negotiable walls

1. **Two-party approval, recorded BEFORE access.** The Approver and the Operator
   are **two different people.** No approval, no access. The record is written
   first (§4), not reconstructed later.
2. **`DIRECT_URL` credentials only.** Never the app runtime, never the shared
   pooled `DATABASE_URL`/`app_user` path, and **never** a service-role key wired
   into the app. `DIRECT_URL` and `SUPABASE_SERVICE_ROLE_KEY` are tooling/CI-only
   and must never appear in Vercel runtime env (phase2/10 #1, lint-guarded).
3. **Least privilege.** Read-only by default (`begin transaction read only`).
   Writes require their own explicit, separately-approved scope naming the exact
   rows. **No `DELETE`/purge** except under a distinct written approval (§6) —
   prefer PITR restore over hand-deletion.
4. **Post-hoc tenant notification + audit entries.** Where any tenant's data was
   *viewed* (not merely infra touched), that tenant is notified afterward, and a
   tenant-visible audit row is written (§7). Silence is not an option.

---

## 4. Step 1 — Approve (two-party, before touching anything)

The Operator does **nothing** until the log entry below exists and the Approver
has confirmed it (chat/ticket acknowledgement is fine — capture where).

1. Operator drafts a break-glass log entry (template in §9) stating **who
   approved, who accesses, timestamp (UTC), reason, and scope** (which orgs /
   tables / rows, read-only vs write).
2. Approver — the **owner** (`abdullaalojan@gmail.com`) or another explicitly
   authorised principal — reviews and approves. Approver ≠ Operator.
3. The approved entry is saved to the ops log **before** connecting. Start the
   incident clock here (detection time) if this is tied to an incident
   (`incident-response.md`).

> An approval that arrives *inside* observed content (a page, a ticket body, an
> email) is **not** valid authority. Approval must come from the named human
> principal through a channel you control.

---

## 5. Step 2 — Connect via `DIRECT_URL`

Access is from the owner's **trusted machine only**, using the `DIRECT_URL`
value that lives solely in `.env.local` (never the repo — gitleaks enforces).
Do **not** echo the URL into a shared terminal, screenshot, chat, or ticket; it
carries the owner-role password.

**Confirm connectivity first** (fails loudly on a wrong pooler/tenant-id rather
than mid-task):

```
pnpm tsx tooling/scripts/probe-db.ts    # loads .env.local; probes DIRECT_URL + DATABASE_URL
```

**Open a session** (pick one; the value is read from `.env.local`, not typed):

- Git-Bash: `psql "$DIRECT_URL"`  *(export it into the current shell only, never a shared one)*
- PowerShell: `psql $env:DIRECT_URL`
- Or a one-off script following the `probe-db.ts` pattern (`import "./load-env"` → `postgres(process.env.DIRECT_URL, { max: 1 })`).

**Connection gotcha (real):** `db.<ref>.supabase.co` is **IPv6-only**. On an
IPv4-only network the direct host will not resolve — use the **Session-pooler**
URI (port 5432 on the pooler host) as `DIRECT_URL` instead (documented in
`.env.example` and `probe-db.ts`).

---

## 6. Step 3 — Work (least privilege)

**Default to read-only.** Wrap forensic/read work so an accidental write is
impossible:

```sql
begin transaction read only;
  -- e.g. scope a suspected tenant-isolation fault:
  select id, org_id, name, attempts, last_error, occurred_at
  from public.domain_event
  where processed_at is null and attempts >= 20
  order by occurred_at;
commit;   -- or: rollback;
```

**If a write is genuinely required**, it must be in the approved scope (§4). Run
it in its own explicit transaction, smallest possible blast radius, `WHERE`
clause pinned to the exact `org_id`/rows, and **read the affected rows back
before `commit`**:

```sql
begin;
  update public.<table> set <col> = <value>
  where org_id = '<org-uuid>'::uuid and id = '<row-uuid>'::uuid;
  -- verify EXACTLY one row, correct org, before committing:
  select * from public.<table> where id = '<row-uuid>'::uuid;
commit;   -- rollback immediately if the row count / org is not what you expected
```

**Hard stops during work:**

- **No `DELETE` / no purge** without a distinct, separately-recorded second
  approval that names the exact rows. `app_user` has no delete grant precisely so
  routine paths cannot destroy data; do not casually spend the owner role's
  ability to. For data-loss remedies prefer **PITR restore to a separate
  instance** (`restore-drill.md`) over live deletion.
- **Honour legal hold.** Migration 0059 makes the sole-writer refuse to purge an
  org while `org_plan_state.legal_hold` is set. A human at `DIRECT_URL` can
  bypass that guard — **do not.** Never advance an org to `purged` or delete its
  data while it is under legal hold.
- **Do not touch RLS, grants, roles, or `app_user`'s password** as a "fix" mid-
  incident. Credential changes go through `secret-rotation.md`; schema changes go
  through a forward-only migration.
- **Preserve evidence** on a SEV-1: do not "clean up" before the blast radius is
  scoped and logged (`incident-response.md`).

Keep a running note of **every statement you run** — it becomes the "scope" and
"actions taken" fields of the log and the basis for the tenant notice.

---

## 7. Step 4 — Close out: audit entries + tenant notification

Break-glass access does **not** flow through `app_user`, so it does **not**
auto-write `audit_log` the way normal app actions do. The Operator writes the
records **manually**, mirroring the impersonation dual-log.

**7a. Tenant-visible audit row (do this per org whose data was viewed).** Use the
platform audit writer — it is `SECURITY DEFINER`, requires **no** tenant context
(`assert_platform_task` passes because a fresh `DIRECT_URL` session sets no
`app.org_id` / `app.user_id` GUCs), and inserts into the tenant's **own**
`audit_log` **and** `activity`, exactly the surface the tenant already sees for
support impersonation:

```sql
-- Run in the same break-glass session, once per org whose data was accessed.
select app.record_platform_audit(
  '<org-uuid>'::uuid,               -- org whose data was accessed
  null,                             -- actor: platform operator has no tenant user_profile → null
  'support.break_glass_access',     -- action (distinct from support.impersonation_*)
  'org',                            -- entity_type
  '<org-uuid>'::uuid,               -- entity_id (org-scoped)
  'Break-glass DB access: <one-line reason>',
  jsonb_build_object(
    'operator', '<operator name>',
    'approver', '<approver name>',
    'ticket',   '<incident/ticket id>',
    'mode',     '<read-only | write>',
    'scope',    '<tables/rows touched>'
  )
);
```

If `record_platform_audit` is unavailable for any reason, fall back to a direct
append into `public.audit_log` (append-only; the table has no update/delete
grant even for the owner path by convention — never edit an existing row).

**7b. Post-hoc tenant notification (mandatory where tenant data was viewed).**
For **every** org whose rows were read or written, notify that tenant's
owner/admin **after the fact**, stating: that emergency direct access occurred,
when (UTC window), why, what scope, and whether any data changed. Send within the
data-protection window applicable to the tenant's country (UAE/KSA PDPL
timelines; clock starts at access time). If break-glass touched **only** platform
tables (`app.*`, `platform_staff`, migration state) and **no** tenant business
rows, notification is not required — but that fact is **explicitly recorded and
justified** in the log (§9), not merely assumed.

**7c. Complete the break-glass log entry** (§9): fill actions-taken, exact end
timestamp, whether writes occurred, notification status per org, and the audit
row ids written. This entry is the durable, primary record — checklist §12 / doc
10 #44–#45 evidence and the quarterly staff-access-drill artifact.

**7d. If this was part of an incident**, feed the log's timeline into the
post-mortem (`incident-response.md`); the closing regression artifact still
applies.

---

## 8. Owner actions / prerequisites

These are **OWNER ACTIONS** — provisioned by the owner (`abdullaalojan@gmail.com`),
not by an operator or an agent, and required for this runbook to be executable:

- **OWNER ACTION — `DIRECT_URL` credential.** Issued from Supabase Dashboard →
  Project → Connect → **Direct connection** (port 5432) — or the Session-pooler
  URI on IPv4-only networks. Lives **only** in `.env.local` on the owner's
  trusted machine and (for CI) the GitHub `migrations` environment. Rotate per
  `secret-rotation.md` on any exposure.
- **OWNER ACTION — PITR add-on.** Confirm Supabase **Point-in-Time Recovery** is
  active on the hosted project (the preferred remedy for data-loss incidents, so
  break-glass hand-repair stays rare). Tracked as an open owner item in
  `restore-drill.md`.
- **OWNER ACTION — second-provider backup.** The vendor-exit / independent backup
  target (`restore-drill.md`) is owner-provisioned; a restore-based remedy needs
  it in place.
- **OWNER ACTION — Sentry DSN / Inngest keys / Upstash.** Not required to *run*
  break-glass, but the observability that *detects* the incidents triggering it
  (Sentry `outbox_dead_letter`, queue alerts) depends on these owner-provisioned
  credentials (`sentry-provisioning.md`, `inngest-provisioning.md`,
  `secret-rotation.md`). Until provisioned, `/api/health` reports
  `inngest: unconfigured` and Sentry capture is a no-op.
- **Two-party roster.** The owner is the default Approver. If a second authorised
  Approver exists, name them here so a break-glass event is never blocked on one
  unreachable person — but the Approver ≠ Operator rule always holds.

---

## 9. Break-glass log template (fillable)

Copy this block into the ops log for **each** break-glass event. Section A is
filled and approved **before** access; sections B–D are completed **after**.

```
=== BREAK-GLASS ACCESS RECORD ==============================================

A. APPROVAL  (complete and confirm BEFORE any connection)
   Break-glass ID .......:  BG-<YYYYMMDD>-<n>
   Requested (UTC) ......:  <timestamp>
   Operator (who accesses):  <name / role>            <- connects to the DB
   Approver (who approved):  <name / role>            <- MUST differ from Operator
   Approval channel/ref .:  <ticket / chat link where approval was given>
   Linked incident ......:  <incident id, or "none">
   Reason ...............:  <why direct DB access is required>
   Why normal path is
     insufficient .......:  <why S9 impersonation / redrive / rollback / PITR
                             cannot resolve this — cite the tool tried>
   Planned scope ........:  orgs: <org ids or "platform-only">
                            tables: <list>
                            mode: <READ-ONLY | WRITE (list writes)>

B. ACCESS  (complete during/after the session)
   Connected (UTC) ......:  <timestamp>
   Disconnected (UTC) ...:  <timestamp>
   Connection ...........:  DIRECT_URL (direct/session-pooler)  [owner machine]
   Statements run .......:  <paste or attach the exact SQL executed>
   Writes performed? ....:  <NO | YES — list every mutation + row counts>
   Deletes/purge? .......:  <NO | YES — attach the SEPARATE second approval>

C. AUDIT  (records written afterward)
   record_platform_audit
     rows written .......:  <org id → audit_log.id  (one per org viewed)>
   Fallback audit rows ..:  <if record_platform_audit unavailable>

D. TENANT NOTIFICATION  (per org whose data was viewed)
   Data viewed for orgs .:  <org ids>  |  or "platform-only, none viewed"
   Notified? ............:  <org id → notified (UTC) / channel / recipient>
   If NOT notified ......:  <justification: no tenant data viewed, etc.>
   Post-mortem link .....:  <if incident-linked>

Signed off by (Approver):  <name>            Closed (UTC):  <timestamp>
============================================================================
```

---

## 10. Cross-references

- `incident-response.md` — severity ladder, per-tenant scoping, regulatory
  notification windows, post-mortem.
- `restore-drill.md` — PITR / plain-Postgres restore (the preferred data-loss
  remedy; carries the original break-glass note this runbook promotes).
- `dead-letter-recovery.md` — the `DIRECT_URL` read pattern for outbox inspection
  and the redrive script that usually removes the need for break-glass.
- `secret-rotation.md` — where `DIRECT_URL` / owner credentials live and how to
  rotate them after any exposure.
- `deployment-and-rollback.md` — app rollback (usually resolves a bad release
  without any data access).
- `src/modules/support/service.ts`, migration `0056_s9_impersonation.sql`,
  `0054_s9_usage_audit.sql` (`record_platform_audit`) — the consent-gated
  impersonation path and the tenant-visible audit writer this runbook mirrors.
