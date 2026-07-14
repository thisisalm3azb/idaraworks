# Support Impersonation — History Review & Audit

**One-line rule:** every time IdaraWorks staff enter a tenant's org for support,
it is **consent-gated or break-glass**, **time-bounded**, **RLS-scoped** (runs as
`app_user`, not owner), shown to the tenant as a **persistent banner**, and
**dual-logged** — to the platform stream **and to the tenant's own `audit_log`**.
This runbook is how an operator (or an auditor answering a tenant/regulator)
**reviews that history**: who impersonated which tenant, when, under whose
consent, and whether any session was a break-glass override that owes the tenant
a notice.

This is the S9 support-impersonation surface (`src/modules/support/service.ts`,
`supabase/migrations/0056_s9_impersonation.sql`). It is the **normal** support
path; the raw-DB [break-glass.md](break-glass.md) is the escalation when even
impersonation cannot reach the problem (see §6).

---

## 1. What gets recorded, and where

**Table: `public.impersonation_session`** (`0056_s9_impersonation.sql`) — one row
per session:

| Column | Meaning |
| --- | --- |
| `id` | session id |
| `org_id` | the tenant org that was entered |
| `staff_user_id` | which IdaraWorks operator (from `platform_staff`) |
| `reason` | free-text justification (3–500 chars, required) |
| `consent_granted_by` | the tenant **owner/admin** user id who granted access — **or NULL** |
| `break_glass` | `true` = consent was skipped (emergency override) |
| `started_at` / `ended_at` | the time window; `ended_at IS NULL` = **still open** |

**Invariant enforced in the DB:** `consent_granted_by IS NOT NULL OR break_glass`
(`impersonation_consent_ck`). A session **always** has one of the two — never
neither. `app.start_impersonation` also re-checks it and verifies the actor is
**active `platform_staff`**, so a tenant user can never open a session (they are
not staff), and a session can never be opened into the wrong org.

**Dual audit (the DoD acceptance criterion — "a support session is visible in the
tenant's own audit log"):** `start_impersonation` / `end_impersonation` call
`app.record_platform_audit` (`0054_s9_usage_audit.sql`), a `SECURITY DEFINER`
writer that inserts into the tenant's **own** `public.audit_log` **and**
`public.activity`:

- `action = 'support.impersonation_started'` (summary notes `(break-glass)` when
  applicable, `after_data` carries `{reason, break_glass}`)
- `action = 'support.impersonation_ended'`

`audit_log` is **append-only** (no update/delete grant, even on the owner path by
convention) — the trail cannot be rewritten.

---

## 2. What the tenant sees (transparency surface)

- **Persistent banner:** `Settings → Subscription`
  (`/o/<orgId>/settings/subscription`) renders a warning banner whenever a session
  is **open** on the org — driven by `listImpersonations(ctx, archetype, true)`
  (active-only). Visible to `billing.view` holders (**owner / admin / accounts**).
- **The audit trail itself:** the `support.impersonation_*` rows are ordinary
  tenant `audit_log` rows, so they also flow to any tenant audit view and to the
  **self-service export** (`?entity=audit_log`, see [exports.md](exports.md)).
- `hasActiveImpersonation(ctx)` is the boolean seam behind the banner if another
  surface needs it.

> There is **no** in-app operator console that *starts* impersonation — the
> `startImpersonation` / `endImpersonation` service functions are invoked from a
> platform/tooling context (they run without a tenant GUC, guarded by
> `assert_platform_task`). See `tooling/scripts/s9-prod-demo.ts` and
> `tooling/scripts/s11-pilot-sim.ts` for the exact call shape. Opening a session
> is therefore itself an **[OWNER ACTION]**-adjacent, platform-staff-gated step.

---

## 3. Querying the history (operator / auditor)

Run these **read-only**. A tenant-scoped answer can come from the app export; a
cross-tenant/platform answer needs a `DIRECT_URL` read-only session
(`begin transaction read only`, break-glass.md §6 — but a *read* to answer an
audit question is routine, not a break-glass write).

**All sessions on one org, newest first** (mirrors what the tenant can see):
```sql
select s.id, s.staff_user_id, sp.note as staff_note, s.reason,
       s.consent_granted_by, s.break_glass,
       s.started_at, s.ended_at,
       (s.ended_at is null) as still_open
from public.impersonation_session s
left join public.platform_staff sp on sp.user_id = s.staff_user_id
where s.org_id = '<org-uuid>'
order by s.started_at desc;
```

**Every currently-open session across the whole fleet** (should normally be empty
or short-lived — a stale open session is a finding):
```sql
select org_id, staff_user_id, reason, break_glass, started_at,
       now() - started_at as open_for
from public.impersonation_session
where ended_at is null
order by started_at;
```

**All break-glass (consent-skipped) sessions** — each of these owes the tenant a
post-hoc notice (§4):
```sql
select org_id, staff_user_id, reason, started_at, ended_at
from public.impersonation_session
where break_glass = true
order by started_at desc;
```

**Everything one operator did** (for an off-boarding review, pairs with
[access-revocation.md](access-revocation.md) §3):
```sql
select org_id, reason, break_glass, started_at, ended_at
from public.impersonation_session
where staff_user_id = '<staff-user-uuid>'
order by started_at desc;
```

**Correlate a session with the tenant-visible audit rows** (prove the dual-log
fired — the DoD check):
```sql
select org_id, action, summary, actor_user_id, after_data, created_at
from public.audit_log
where org_id = '<org-uuid>'
  and action in ('support.impersonation_started','support.impersonation_ended')
order by created_at desc;
```

**As the tenant, without DB access:** export `audit_log`
(`GET /api/o/<orgId>/export?entity=audit_log`, [exports.md](exports.md)) and
filter the `action` column to `support.impersonation_started` /
`_ended`. That is the self-serve, no-credential answer a tenant/DPO can run
themselves.

---

## 4. Reviewing consent & the break-glass override

Two consent modes, both fully logged:

- **`consent_granted_by` set** — a tenant **owner/admin** explicitly granted
  access. The normal, expected mode. Reviewing = confirm the grantor is genuinely
  an owner/admin of that org and the `reason` matches a real support request.
- **`break_glass = true`** — consent was **skipped** for an emergency. Still
  platform-staff-gated, still RLS-scoped, still banner-shown, still in the tenant
  `audit_log`. But because the tenant did **not** pre-approve, each break-glass
  session **must** be followed by a **post-hoc tenant notification** (same
  obligation and window as [break-glass.md](break-glass.md) §7b — the applicable
  UAE/KSA PDPL timeline, clock starting at `started_at`).

**Review checklist (run periodically, and on any tenant/regulator request):**
- Every `break_glass = true` session has a recorded tenant notification. If not →
  notify now and record it.
- No session is **open** longer than a support interaction plausibly needs — a
  long-lived `ended_at IS NULL` means someone forgot to close it. **End it** (§5)
  and note why it lingered.
- Every `staff_user_id` still corresponds to an **active** `platform_staff` row;
  a session by someone since off-boarded is a process gap (access-revocation.md
  §3 should have caught it).
- `reason` is meaningful on every row (the DB enforces 3–500 chars, not quality).

---

## 5. Closing a lingering session

If a session is open that should not be (operator forgot, or you are cleaning up
during an off-boarding), close it through the governed, **dual-logged** path so
the tenant's `audit_log` records the end and the banner clears:

```ts
// tooling one-off — platform context; app.end_impersonation is DEFINER + dual-logged.
import { endImpersonation } from "@/modules/support/service";
await endImpersonation("<session-uuid>");   // idempotent: ending an already-ended session is a no-op
```

Do **not** `update public.impersonation_session set ended_at = now()` by hand over
`DIRECT_URL` — that skips `record_platform_audit`, leaving the tenant's audit log
without the `support.impersonation_ended` row. Use the service function; only fall
back to a raw close under break-glass, and then write the tenant audit row
yourself with `app.record_platform_audit(... 'support.impersonation_ended' ...)`.

---

## 6. Break-glass as the escalation path

Support impersonation is the **first** and preferred way in. It is safer in every
dimension: RLS-scoped (cannot silently cross into another org), tenant-visible,
no owner credentials leave their store. It even carries its **own** in-app
`break_glass` override (above) for emergencies **within** that safe envelope.

Escalate to the raw-DB [break-glass.md](break-glass.md) **only** when impersonation
itself cannot do the job — the app is down, the tenancy/RLS layer is the suspected
bug, or the work is sub-application (migrations, outbox internals, corruption
repair, forensic cross-tenant reads). Keep the two "break-glass" meanings distinct:

| Term | What it is | Guardrails |
| --- | --- | --- |
| `impersonation_session.break_glass = true` | **in-app** consent override, still runs as `app_user` under RLS | staff-gated, banner-shown, tenant `audit_log` |
| **break-glass.md** | **raw `DIRECT_URL`** access as the owner/migration role, **off-RLS**, outside the app | two-party approval, post-hoc notice, manual audit writes |

The raw path is strictly higher-privilege; use it last, and log it per its own
runbook.

---

## 7. Owner / provisioning notes

- **[OWNER ACTION] — `platform_staff` roster.** Who *can* impersonate is the
  `public.platform_staff` allow-list, platform-managed with **no** tenant grant,
  reached only via `DIRECT_URL`/migration
  (`insert into public.platform_staff (user_id, active) values (?, true)`).
  Adding/removing operators is an owner action; off-boarding one is
  [access-revocation.md](access-revocation.md) §3.
- **[OWNER ACTION] — post-hoc tenant notice for break-glass sessions.** The
  notification obligation (§4) is a human/legal step; the app records the session
  but does not send the notice automatically (the notification seam is D1-gated).
- The `impersonation_session` table is **tenant-readable** (RLS `select` policy
  `org_id = current_org_id()`) so the transparency surface and export work without
  any platform access.

---

## 8. Cross-references

- [access-revocation.md](access-revocation.md) — off-boarding an operator:
  ending live sessions + removing them from `platform_staff`.
- [break-glass.md](break-glass.md) — the raw-DB escalation and its two-party /
  post-hoc-notice discipline (which break-glass impersonation sessions mirror).
- [exports.md](exports.md) — how a tenant/DPO self-exports the `audit_log`
  containing the `support.impersonation_*` trail.
- `src/modules/support/service.ts` (`startImpersonation`, `endImpersonation`,
  `listImpersonations`, `hasActiveImpersonation`),
  `supabase/migrations/0056_s9_impersonation.sql` (schema + DEFINER functions),
  `supabase/migrations/0054_s9_usage_audit.sql` (`record_platform_audit`),
  `src/app/(app)/o/[orgId]/settings/subscription/page.tsx` (the banner) — the code
  this runbook reviews.
