# Access Revocation — Off-boarding a User or Staff Member

**One-line rule:** revoking someone's access is **layered**, and the layers are
enforced in different places. Deactivating an org membership severs that org's
data at the **next request** (RLS + `resolveCtx`), but it does **not** kill the
person's live Supabase auth session, and it does **not** touch platform-staff
(impersonation) rights or break-glass. A complete revocation walks **all** of:
membership → auth session → platform-staff → break-glass, then **verifies** each
and leaves an audit trail.

Use this when a person leaves, changes employer, is compromised, or when a
support/platform operator is off-boarded. Read [break-glass.md](break-glass.md)
and [impersonation-history.md](impersonation-history.md) alongside it — the last
two layers live in those runbooks' territory.

---

## 0. First decide the scope

| Who are you revoking? | Layers that apply | Who performs it |
| --- | --- | --- |
| A **tenant user** (member of one org) | 1 (membership) + 2 (auth session, if compromised/immediate) | Tenant **owner/admin** (in-app) |
| A **tenant user in several orgs** | 1 per org + 2 (a global sign-out reaches every org) | Owner/admin of **each** org + [OWNER ACTION] for the global sign-out |
| An **IdaraWorks platform/support operator** | 1 (if they also hold a tenant membership) + 2 + **3 (platform-staff + break-glass)** | **[OWNER ACTION]** — platform tables have no tenant grant |

A membership is scoped to one org (`public.membership` is `(org_id, user_id,
role_key)`). "Remove them everywhere" means repeating layer 1 for each org **or**
using the global auth sign-out (layer 2) plus deactivating each membership.

---

## 1. Layer 1 — Deactivate the org membership (removes the role)

This is the normal, in-app, self-serve revocation. It is the **only** layer a
tenant admin can do without owner/DB access.

**UI path:** `Settings → Members` (`/o/<orgId>/settings/members`) → find the
person → **Deactivate**. Gated by `members.deactivate` — **owner / admin** only
(`src/platform/authz/matrix.ts`). The button is hidden for the org owner row and
does not appear for your own row.

**What it does** (`deactivateMemberAction` → `deactivateMember`,
`src/platform/auth/identity.ts`):

- Runs through the audited `command()` path, so it sets
  `membership.deactivated_at = now()` **and** writes an `audit_log` row
  (`action = 'membership.deactivate'`, before `{active:true}` / after
  `{active:false}`) in **one transaction**.
- **Refuses** to deactivate the org **owner** (`doc 06`) or **yourself**.
- The membership's `role_key` **is** the role binding, so deactivating the
  membership **removes the role for that org** — there is no separate "remove
  role" step and no in-app role re-assignment.

**Effect on access — enforced at the next request, not retroactively:**

- `resolveCtx` (`src/platform/auth/resolve.ts`) only matches memberships
  `where ... deactivated_at is null`. A deactivated member gets `no_membership`
  → redirected out of the org on their next navigation/action.
- `listMyOrgs` filters the same way, so the org disappears from their switcher.
- Every RLS policy keys on `app.current_org_id()`, which is only set for a live
  membership context — so the DB itself refuses their rows.

> **Changing** a role (not removing it): there is no in-app role-change action.
> To move someone to a different role, **deactivate the current membership and
> re-invite** with the new role (`Settings → Members → Invite`, `role_key`).
> A direct `membership.role_key` update is a break-glass DB operation
> ([break-glass.md](break-glass.md)) and should be the exception, not the habit.

---

## 2. Layer 2 — Force sign-out of all devices (kill the live session)

**Layer 1 does not end the person's authenticated session.** Their Supabase
access token stays valid until it expires (short-lived; refresh-token rotation is
on — `docs/S10-AUDIT-REGISTER.md` doc10 #3). Concretely, after deactivation they
can no longer resolve **that** org, but:

- if they are still a member of **other** orgs, they remain signed in there;
- a compromised/exfiltrated token is still live for its short TTL.

For an immediate, all-device cut you must invalidate the **auth session**, which
lives in Supabase's `auth` schema — **outside** the app's `app_user` data plane.

**What the app has (and its limit):** the self-service
`signOutOtherDevicesAction` (`src/app/(auth)/actions.ts`, wired to the account
page) calls `supabase.auth.signOut({ scope: "others" })`. It signs out **the
caller's own** other devices only. **It cannot be used to revoke someone else** —
there is no in-app admin "sign out this user" surface. This is the documented
PARTIAL state of session management (doc10 #3: remote sign-out + rotation exist,
no per-device admin list).

**[OWNER ACTION] — force global sign-out of a target user.** Two equivalent
paths, both owner-only:

- **Supabase Dashboard** → **Authentication → Users** → select the user →
  **Sign out user** (revokes all refresh tokens → every device drops on next
  refresh). This is the fastest, no-code path.
- **Admin API**, from a one-off tooling script (never app runtime), using
  `SUPABASE_SERVICE_ROLE_KEY` (tooling/CI-only; see `.env.example` line 24 and
  [secret-rotation.md](secret-rotation.md)):

  ```ts
  // tooling one-off — service-role key from .env.local, NEVER Vercel runtime.
  import "./load-env";
  import { createClient } from "@supabase/supabase-js";
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistToken: false } },
  );
  await admin.auth.admin.signOut("<target-user-uuid>", "global"); // all devices
  ```

**When to do layer 2:** always for a compromised account or a for-cause removal;
for an ordinary off-boarding, layer 1 plus the token's short TTL is usually
enough — decide based on urgency and whether the person is multi-org.

> **Do not** delete the Supabase auth user as the revocation step. Hard-deleting
> an identity cascades against `user_profile`/audit references and is a
> **prohibited destructive action** in this runbook — deactivate the membership
> and sign the session out instead.

---

## 3. Layer 3 — Revoke platform-staff (impersonation) + break-glass

Only relevant when the person is an **IdaraWorks operator**, not an ordinary
tenant user. These are platform capabilities with **no tenant grant**, reachable
only via `DIRECT_URL`/break-glass or a migration — every step here is an
**[OWNER ACTION]**.

**3a. End any live support session they hold.** A staff member may have an open
impersonation session. Close it first so the tenant banner clears and no session
outlives the operator:

```sql
-- Read (any read-only DIRECT_URL session): open sessions this operator holds.
select id, org_id, reason, break_glass, started_at
from public.impersonation_session
where staff_user_id = '<staff-user-uuid>' and ended_at is null;
```

End each via the governed, dual-logged path — **not** a raw `update`, so the
tenant's own `audit_log` records `support.impersonation_ended`:

```ts
// tooling one-off (platform context; app.end_impersonation is DEFINER + dual-logged).
import { endImpersonation } from "@/modules/support/service";
await endImpersonation("<session-uuid>");
```

See [impersonation-history.md](impersonation-history.md) for the full query set.

**3b. Remove them from the platform-staff allow-list.** `public.platform_staff`
is the allow-list that gates who may **open** an impersonation session
(`app.start_impersonation` checks `where user_id = ? and active`,
`0056_s9_impersonation.sql`). Deactivate (preferred — keeps the row for history)
or delete:

```sql
-- [OWNER ACTION] via DIRECT_URL (platform table, no tenant grant).
update public.platform_staff set active = false where user_id = '<staff-user-uuid>';
-- (matches the tooling pattern: insert ... (user_id, active) values (?, true))
```

Once `active = false`, any future `start_impersonation` by them
raises `is not active platform staff` — the gate is closed.

**3c. Revoke break-glass reach.** Break-glass is **not** a per-user grant — it is
possession of the `DIRECT_URL` owner credential ([break-glass.md](break-glass.md)
§8). "Revoking" a departing operator's break-glass means:

- Remove them from the **two-party Approver/Operator roster** (break-glass.md §8).
- **[OWNER ACTION]** If they ever held `DIRECT_URL` / `APP_DB_PASSWORD` /
  `SUPABASE_SERVICE_ROLE_KEY`, **rotate** those per
  [secret-rotation.md](secret-rotation.md) — a departed operator who memorised or
  stored a credential still has raw DB reach until it is rotated.

---

## 4. Verify (do not assume — check each layer)

Run these read-only checks (in-app where possible; else a
`begin transaction read only` DIRECT_URL session, per break-glass.md §6):

**Membership (layer 1):**
- `Settings → Members` shows the person with the **Deactivated** badge, or:
  ```sql
  select deactivated_at from public.membership
  where org_id = '<org-uuid>' and user_id = '<user-uuid>';   -- expect: not null
  ```
- Audit row exists:
  ```sql
  select action, summary, created_at from public.audit_log
  where org_id = '<org-uuid>' and action = 'membership.deactivate'
  order by created_at desc limit 5;
  ```
- Functional check: have the person (or a test) hit `/o/<orgId>` → they are
  redirected out (`resolveCtx` → `no_membership`). Confirm the org is gone from
  their switcher.

**Auth session (layer 2):** after a global sign-out, their next request 401s /
bounces to `/login` on **every** device. Confirm no other-org access remains if
the intent was a full off-boarding.

**Platform-staff / break-glass (layer 3):**
```sql
select active from public.platform_staff where user_id = '<staff-user-uuid>';  -- expect: false (or 0 rows)
select count(*) from public.impersonation_session
where staff_user_id = '<staff-user-uuid>' and ended_at is null;                -- expect: 0
```
Plus: roster updated, and any owned credential rotated (secret-rotation.md
confirms the new value is live in Vercel + CI).

---

## 5. Audit / record what wasn't auto-audited

- **Layer 1 self-audits** — `membership.deactivate` is written atomically by
  `command()`; nothing extra to do.
- **Layers 2 and 3 are NOT app actions** (Dashboard sign-out, service-role admin
  call, `platform_staff` update, secret rotation) → they leave **no** `audit_log`
  row on their own. Record them in the **ops log**: who was revoked, which layers,
  by whom, UTC timestamp, reason (off-boarding / for-cause / compromise), and the
  break-glass ID if a `DIRECT_URL` session was used.
- If you touched `platform_staff` or ended a session **via a raw `DIRECT_URL`
  session** (rather than the `endImpersonation` DEFINER path), follow the
  break-glass close-out — write a tenant-visible row with
  `app.record_platform_audit(...)` and complete the break-glass log
  (break-glass.md §7). The `endImpersonation` service path already dual-logs, so
  prefer it and this step is unnecessary.

---

## 6. Quick reference — the whole revocation on one screen

```
REVOKE <person>  (UTC ____, performed by ____, reason ____)

[ ] L1  Members → Deactivate  (per org)         -> membership.deactivated_at set + audit_log row
[ ] L2  Dashboard "Sign out user" (or admin API, global)   [OWNER ACTION]  (compromise/for-cause: mandatory)
[ ] L3a endImpersonation() any open session       [OWNER ACTION]  (staff only) -> support.impersonation_ended
[ ] L3b platform_staff.active = false             [OWNER ACTION]  (staff only)
[ ] L3c roster removal + rotate DIRECT_URL/service-role if held  [OWNER ACTION]  (secret-rotation.md)

VERIFY  deactivated_at not null · audit row · redirected out · sessions dead · platform_staff false · 0 open sessions
RECORD  ops log entry (L2/L3 are not auto-audited); break-glass close-out if DIRECT_URL was used
```

---

## 7. Cross-references

- [impersonation-history.md](impersonation-history.md) — review who impersonated
  which tenant; the query set for `impersonation_session` + the tenant audit trail.
- [break-glass.md](break-glass.md) — the `DIRECT_URL` two-party path for the
  layer-3 platform-table edits and any role-key surgery; post-hoc tenant notice.
- [secret-rotation.md](secret-rotation.md) — rotating `DIRECT_URL`,
  `APP_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY` after a for-cause off-boarding.
- `src/platform/auth/identity.ts` (`deactivateMember`),
  `src/app/(auth)/actions.ts` (`signOutOtherDevicesAction`),
  `src/modules/support/service.ts` (`endImpersonation`),
  `supabase/migrations/0056_s9_impersonation.sql` (`platform_staff`) — the code
  paths this runbook drives.
