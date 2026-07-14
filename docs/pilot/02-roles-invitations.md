# Roles & invitations

> How to invite pilot users, which of the **7 roles** to give them, how the invite
> flow works, and the seat/entitlement implications. Companion to
> [`00-pilot-org-setup.md`](00-pilot-org-setup.md).

---

## The 7 roles (archetypes) — and the "workshop manager" question

IdaraWorks has exactly **7 role archetypes**. They are code-owned; a template may
*relabel* them but cannot add or remove any.

| # | Archetype (key) | Template #1 label | Seat class | Cost/price view |
| --- | --- | --- | --- | --- |
| 1 | `owner` | Owner / المالك | full | yes / yes |
| 2 | `admin` | Admin / مشرف | full | yes / yes |
| 3 | `manager` | **Workshop Manager** / مدير الورشة | full | **no / no** |
| 4 | `foreman` | Foreman / مشرف عمال | **field** | no / no |
| 5 | `procurement` | Procurement / مشتريات | full | no / no |
| 6 | `accounts` | **Accounts** (back-office / "Inventory") / حسابات | full | yes / yes |
| 7 | `viewer` | Viewer / مشاهد | viewer | no / no |

**On "workshop manager":** it is **not** a separate archetype — it's the label
template #1 gives the `manager` archetype (the "Workshop Manager" variant: manages
stages/reports/issues/week-plan but has `finance.viewCosts` **off**). So the mapping
the pilot brief asks for resolves as:

- owner → `owner`
- admin → `admin`
- manager / workshop-manager → `manager` (labelled "Workshop Manager")
- foreman → `foreman`
- procurement → `procurement`
- accounts → `accounts`
- viewer → `viewer`

An 8th slot, `worker_reserved_p3`, exists in the registry but is **cut from the MVP
build** — do not assign it.

### What each role can do (highlights from the permission matrix)

Permissions are enforced by `can()`/`assertCan()` against a single matrix
(`src/platform/authz/matrix.ts`) — deny-by-default. Notable rows for choosing roles:

- **owner** — everything admin can do, **plus** owner-only: billing management
  (`billing.manage`), job **price adjustments** (`jobs.price.adjust`), report
  backfill. Cannot be deactivated.
- **admin** — full operational + config admin (`config.manage`, `members.invite`,
  `onboarding.run`, `imports.manage`, quotes/invoices/payments, data export).
- **manager (Workshop Manager)** — jobs create/edit, stages, tasks, crew, reports
  review, attendance, approvals it's routed, quotes draft, exceptions — but **sees no
  cost or margin figures** (viewCosts off) and no selling prices.
- **foreman (field seat)** — the field participant: daily reports, tasks, issues,
  photos, material requests, goods-receipt recording — **on assigned jobs only**;
  sees progress, **never costs/prices**. Does not read the attendance grid or costing.
- **procurement** — supplier/item catalog, material requests + convert to LPO, POs,
  goods receipts. No cost-view privilege by default.
- **accounts** — the finance/back-office seat: invoices, payments, AR, expenses,
  costing view (with cost/price privilege on), quotes view, data export.
- **viewer** — read-only across jobs/week/attendance; no contribution, no money.

The **money walls** are server-side: `cost_privileged` gates labour/cost figures,
`price_privileged` gates selling prices/margins. Template #1 grants both only to
owner/admin/accounts. This is why a Workshop Manager and a Foreman can run the shop
floor without seeing what anything costs.

---

## The invite flow

Owner/admin only (`members.invite`). **Members** (top bar) →
`/o/<orgId>/settings/members`.

1. **Send** — enter the invitee's **email** and pick a **role** (any role except
   `owner`; you cannot mint a second owner via invite). Submit.
2. **Token** — a single-use invite token is created, valid **7 days**, stored hashed;
   an audited `membership_invite.create` row is written.
3. **Delivery** — two cases:
   - **Email provider configured** (`RESEND_API_KEY`) → the invitee gets an email with
     the accept link.
   - **No provider** → the Members page shows the invite **link once**
     (`.../invite/<token>`); **[OWNER ACTION]** copy it and send it to the invitee
     yourself. This keeps pilots usable before email is wired.
4. **Accept** — the invitee opens `/invite/<token>`. If not signed in, they're routed
   to sign up / log in first, then back to accept. On accept, `app.accept_invite`
   creates their membership with the invited role (audited `membership.join`), and
   they land in the org.
5. **Expiry / re-invite** — after 7 days the token is dead; simply invite again.

**Rate limits:** invite sends and accepts are rate-limited per org/IP. If you hit
`?error=rate_limited`, wait and retry. (Durable rate limits need Upstash —
**[OWNER ACTION]**, tracked as OA-4; the in-memory limiter is the pilot backstop.)

### Removing access

- **Deactivate**, don't delete: Members → **Deactivate** on a member
  (`members.deactivate`, owner/admin). It sets `deactivated_at`; nothing is
  hard-deleted (D-1.7).
- Guards: the **owner cannot be deactivated**, and you **cannot deactivate yourself**.
- Re-granting access = a fresh invite.

### MFA & field-seat auth

- **TOTP MFA** is available to every user (Account → MFA) and some sensitive server
  actions require it (`resolveCtxForAction` redirects to `/mfa` when required).
- **Field staff** (foremen) are designed for **phone-OTP or admin-issued
  credentials** rather than desktop email/password — a workshop-floor login on a
  phone.
- **OAuth (Google/Microsoft)** is **credential-gated and off by default**
  (**[OWNER ACTION]** `OAUTH_ENABLED` + Supabase provider config). Until enabled, the
  buttons are hidden and email+password / OTP / TOTP are the auth methods.

---

## Seats & entitlements

Seat classes map to entitlement limit keys. **Honest economics is the point:** you
pay for office seats, not for the shop floor.

| Seat class | Archetypes counted | Limit key | Growth-trial value* |
| --- | --- | --- | --- |
| **Full** (paid) | owner, admin, manager, procurement, accounts | `limit.full_users` | 5 / 15 / 40 by tier |
| **Field** (free) | foreman (worker reserved) | `limit.field_users` | **unlimited (null) on every tier** |
| **Viewer** (free) | viewer | `limit.viewer_users` | **unlimited** |

\* Starter / Growth / Business. **All numbers are placeholders pending pricing (D3)** —
the keys are final, the values are not.

Practical consequences for a pilot:

- Invite **foremen and viewers freely** — they never count against a paid cap.
- The **full-user count** is what a paid plan meters. On the Growth trial a pilot has
  generous headroom; don't worry about it during a pilot.
- **Reads and exports are never blocked by entitlements** (freeze FR-9). Even a
  suspended/over-limit org can still see and export everything — limits only govern
  the ability to **add**.
- **Honest limitation to know:** the per-seat caps are defined and *resolved* in the
  entitlement layer, but the invite path does **not** hard-stop at the seat number in
  the MVP — seat economics are enforced at the plan/commercial layer, not as a block
  at invite time. Track full-user growth manually during the pilot; don't rely on the
  invite form to refuse an over-cap seat.

---

## Suggested pilot role assignment

| Person | Role to assign | Why |
| --- | --- | --- |
| Business owner | `owner` | first admin; billing + price authority |
| Ops lead / GM | `admin` | full config + operations, continuity if owner is away |
| Workshop manager | `manager` | runs stages/reports; no cost exposure |
| Line foreman(en) | `foreman` | field seat, assigned jobs, phone-first, free |
| Buyer | `procurement` | MRs → LPOs, goods receipts |
| Accountant / back office | `accounts` | invoices, payments, AR, costing, export |
| Read-only stakeholder | `viewer` | dashboards only, free |

---

## Quick reference

| Action | Where | Who |
| --- | --- | --- |
| Invite a member | `/o/<orgId>/settings/members` | owner/admin |
| Accept an invite | `/invite/<token>` | invited email |
| Deactivate a member | Members page | owner/admin (not self, not owner) |
| Enable MFA | `/account` → MFA | any user |
| Switch language (per user) | `/account` → Language | any user |
| See plan / seats | `/o/<orgId>/settings/subscription` | owner/admin/accounts |
