# Pilot org setup — end-to-end workflow

> **Scope:** taking a brand-new pilot customer from "no account" to a configured
> IdaraWorks workspace with real masters and a first job. Audience: the operator
> running the pilot alongside the customer's owner.
> **Product:** IdaraWorks — an AI-configured Operations Management System (not an
> ERP) for GCC project-based industrial SMBs. Arabic + English, RTL, mobile-first.
> **Deployment:** `https://idaraworks.vercel.app` · Supabase Postgres (Seoul,
> `ap-northeast-2`) · hosted DB at migrations `0000–0064`.
>
> Companion docs: [`01-onboarding-template-checklist.md`](01-onboarding-template-checklist.md)
> (the tickable checklist), [`02-roles-invitations.md`](02-roles-invitations.md)
> (invite the team), [`03-initial-imports.md`](03-initial-imports.md) (bulk-load masters).

---

## 0. Before you start — platform prerequisites

Platform-level, done once by whoever operates the IdaraWorks platform (not per
pilot org). Verify before onboarding a customer.

| Prerequisite | How to confirm | If missing |
| --- | --- | --- |
| App is live | `GET /api/health` returns `200`, `db`/`storage` OK | Stop; see `runbooks/deployment-and-rollback.md` |
| DB migrated to `0064` | `pnpm db:migrate` (idempotent, forward-only) against `DIRECT_URL` | Onboarding fails on missing tables |
| Storage buckets exist | `pnpm storage:setup` has run for the project | Photo upload / derivatives fail |
| Runtime env set on Vercel | `APP_ENV=prod`, `DATABASE_URL` (pooler :6543), `APP_DB_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | App can't serve traffic |

**[OWNER ACTION] credential-gated items** — none block a pilot, but you must know
which are on:

- **Email provider (`RESEND_API_KEY`)** — if unset, invite emails are **not**
  delivered; the invite **link is surfaced once in the Members UI** for you to
  hand over manually (`inviteMemberAction` falls back to `?notice=sent&link=<token>`).
  Fine for a bootstrap pilot; wire it before scale.
- **Inngest keys (`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`)** — required to make
  the background crons (nightly digest/exceptions, subscription lifecycle, retention
  prune) run. Without them a deployed env serves `503 inngest_unconfigured` on
  `/api/inngest`; the in-app request/response flows still work. See
  `runbooks/inngest-provisioning.md`.
- **OAuth (`OAUTH_ENABLED` + Google/Microsoft provider config in Supabase)** —
  **off by default.** The shipped auth is **email+password** (min 10 chars),
  **phone-OTP** (for field staff), and **TOTP MFA**. OAuth buttons stay hidden
  until enabled.
- **Sentry (`SENTRY_DSN`)** — optional error capture; absent = clean no-op.
- **Billing / e-invoice providers** — **disabled in production by design** (`isProd()`
  guard). A pilot org runs on the internal-pilot/trial plan with the checkout UI in
  its "commercial activation unavailable" state. No real charges are possible.

Nothing on this list must be true for a functional pilot except the four rows in
the table above.

---

## 1. Create the account and the org

The person who signs up and creates the org becomes its **owner** (the first
admin). Do this as the customer's owner, or hand them the keyboard.

1. **Sign up** — `https://idaraworks.vercel.app/signup`. Full name, email,
   password (≥10 chars). On the hosted DB, email confirmation is **on**: the user
   is sent to `/login?notice=confirm_email` and must click the confirm link, which
   returns them to the app. (On local/CI, confirmations are off and signup goes
   straight to org creation.)
2. **Create the organisation** — after first sign-in with no org, the app routes to
   `/onboarding` (the org-creation form, `createOrgAction`). Fields:
   - **Organisation name** (≥2 chars)
   - **Country** — `AE / SA / QA / KW / BH / OM` (also `US / GB` in the list; use a
     GCC country for pilots — it drives the holiday calendar and lawful-basis posture)
   - **Base currency** — default `AED`; `SAR / QAR / USD / EUR` are 2-decimal,
     `KWD / BHD / OMR` are **3-decimal** (handled correctly in minor units)
   - **Six-day working week** checkbox
3. **What the platform bootstraps atomically** (`app.create_org_with_owner`, one
   transaction, self-audited):
   - the org + a default company
   - the **7 role definitions** (`owner`, `admin`, `manager`, `foreman`,
     `procurement`, `accounts`, `viewer`) with cost/price-privilege flags
   - a **membership** row making the signup user the **owner**
   - `org_plan_state` = plan `growth`, billing state `trialing` (a full-featured
     trial; commercial charging is disabled in prod)

After this you land on `/o/<orgId>` (Today). Because no template is installed yet,
owners/admins see a **first-run onboarding checklist** on Today linking to the
guided onboarding and imports (`src/app/(app)/o/[orgId]/page.tsx`, `needsSetup`).

> **Arabic:** the org record defaults to English; each user switches their own UI
> to Arabic/RTL on **Account → Language** (`changeLanguageAction`, persisted to
> their profile). Terminology (what things are *called*) is org-level config — see §3.

---

## 2. Configure the workspace — pick ONE path

A cold org has no stages, presets, categories, or terminology. Configuring means
**installing template #1 (boatbuilding)** and adjusting it. There are two equivalent
paths to the same governed config pipeline — every change is a diffable, undoable
`config_revision`.

### Path A — Guided (AI) onboarding · S8 · recommended

Owner/admin only (`onboarding.run`). Nav: **Onboarding** → `/o/<orgId>/onboarding`.

1. **Intake questionnaire** (structured, not free-form):
   - business name, country (GCC), base currency
   - **what you call a job** — EN + AR label (defaults `Boat` / `قارب`)
   - **auto-approve thresholds** (org-currency minor units) for LPO / material
     request — leave blank to skip
   - six-day week, VAT-registered
2. **Proposal** — a deterministic, template-grounded `ConfigProposal` is generated.
   **This requires NO AI credentials** — the deterministic grounding *is* the shipped
   product (`feat.ai_onboarding` is free + always-on). A future AI provider may only
   rephrase prose, never widen config. Generation is metered and per-org capped
   (`limit.ai_onboarding_calls`) behind a platform daily-spend circuit breaker.
3. **Preview** — per-artifact diffs of exactly what will change; the auto-approve
   numbers are **F-28-capped** at 2× the template default and *rejected* (not silently
   clamped) above the cap.
4. **Apply** — runs `installTemplate('boatbuilding_marine_v1')` (~20 config
   revisions) + seeds F-28-capped approval rules. The whole apply is **undoable**
   (session undo reverts the config revisions; the install marker reverts so the org
   returns to un-onboarded — irreversible custom fields are retained by design).

### Path B — Manual fallback · S1 · always available

Owner/admin (`config.view` / `config.manage`). Nav: **Configuration** →
`/o/<orgId>/settings/configuration`.

1. Under the template card, click **Install boatbuilding template** — this calls the
   **same** `installTemplate` pipeline as Path A, minus the questionnaire/proposal.
2. Then adjust terminology and per-artifact config on the same page (see §3).

Use Path B when AI onboarding is undesired, when you're re-configuring an existing
org, or as a fallback if the guided flow errors.

### What template #1 installs (`boatbuilding_marine_v1`)

- **11 production stages** in order (Mould Prep → Lamination → Below Deck Rigging →
  3-part Assembly → Over Deck Assembly → Hardware Rigging → Electrical Rigging →
  Upholstery → Finishing & Polishing → Sea Trial → Delivery), production-proven
  weights (Σ = 100).
- **7 role presets** — the template relabels the `manager` archetype as **"Workshop
  Manager"** (cost/price view OFF) and routes **Accounts** to the back-office
  "Inventory = accountant" duties (cost/price view ON). See doc 02.
- **9 job presets** (13ft Skiff, 18ft Skiff, 21ft Panga GW, 24ft Catamaran, 27ft
  Panga GW, 34ft Catamaran, 35ft EQM, 46ft Dustour, 20m Catamaran) with hull-number
  pattern `{preset_code}-{seq:3}` (e.g. `24C-001`) and 60/40 billing points (60% on
  acceptance, 40% at Delivery). Small skiffs skip Upholstery.
- **17 item categories**, **13 expense categories** (with costing mappings), **9
  quote sections** — verbatim Najolatech constants.
- **Job custom fields**: `engine_package`, `colour_scheme`.
- **Holiday calendars** for AE and SA (incl. Ramadan reduced hours) — picked by the
  org's country; org-editable after install.
- **Terminology**: Boat/قارب, Production Stage, Daily Report, Material Request, LPO
  (house term for purchase order), Quotation, Worker, Team.

---

## 3. Configure terminology

Terminology = what each object is *called* in the UI, per language. 16 term keys
(`job`, `job_stage`, `daily_report`, `material_request`, `purchase_order`,
`goods_receipt`, `expense`, `payment`, `task`, `issue`, `customer`, `supplier`,
`employee`, `team`, `quote`, `invoice`).

- Template #1 already sets sensible marine terms, so **most pilots need no overrides**.
- To override: **Configuration → Terminology card**. Pick a term key, enter EN
  singular/plural + AR singular/plural + AR grammatical gender (m/f), Save. Each save
  is an audited config revision, undoable from the Revisions card on the same page.
- Note: the guided intake records your preferred job term, but a terminology
  *override* is applied through this card, not auto-applied by onboarding (the marine
  template term already matches the default `Boat/قارب`; change it here if the pilot
  builds something else).

---

## 4. Seed the masters

Load the real customers, suppliers, employees, and catalog items. Two ways — use
whichever fits the data you were given. Full detail in
[`03-initial-imports.md`](03-initial-imports.md).

- **Guided CSV import** (owner/admin/manager, `imports.manage`) — nav **Imports** →
  `/o/<orgId>/imports`. Paste a CSV per entity kind (`customers`, `employees`,
  `items`); rows are staged, per-row validated against the same schema as the manual
  form, then applied through the governed services. Re-runnable.
- **Manual forms** — nav **People / Customers / Suppliers / Items**. Best for a
  handful of records or to add one after an import.

Order that avoids errors:

1. **Confirm item categories exist** (they come from the template — §2). Item import
   rejects a row whose `category` isn't an active category.
2. **Customers**, **Suppliers**, **Employees** (any order).
3. **Items** (needs categories).

> **Employees ≠ users.** Importing employees does **not** create logins or consume
> seats — an employee is a labour resource (rates, trade, HR docs). A foreman is both
> an employee *and* a user, linked later. This is deliberate: you onboard the whole
> workforce without paying per-seat for people who never log in.

---

## 5. Designate the first admin and invite the team

- The org creator is the **owner** — already your first admin (owner ⊇ admin, plus
  owner-only powers like billing management and price adjustments).
- To add a **second admin** or any teammate: **Members** (top bar) →
  `/o/<orgId>/settings/members` → invite by email + role. Full flow, the 7-role map,
  and seat implications are in [`02-roles-invitations.md`](02-roles-invitations.md).
- **[OWNER ACTION]** if `RESEND_API_KEY` is unset, copy the surfaced invite link to
  the invitee out-of-band.

---

## 6. Prove the workspace — create the first job

The pilot readiness bar is **cold org → configured → first job in under 30 minutes**.

1. Nav **Jobs** → new job → pick a **preset** (e.g. `24ft Catamaran`) and a name.
   The reference (hull number, e.g. `24C-001`) is allocated atomically.
2. Optionally file a first **daily report** against a reportable stage to confirm the
   heartbeat works end-to-end.
3. **Costing parity check** — the onboarded config reproduces the S5 costing golden
   to the minor unit (the S8 production demo verified **ex-labour = 290000, total =
   395000**). If you run a scripted parity check, this is the number to match.

---

## 7. Verify and hand off

- **Health:** `GET /api/health` (`db`, `storage`, `queue`, `inngest`), `GET /api/ready`.
- **Read-only smoke:** `pnpm smoke:prod -- https://idaraworks.vercel.app`.
- **Audit trail:** every setup action (org create, template install, each config
  revision, invites, imports, first job) is in the org's audit log — the pilot's own
  compliance evidence.
- **Self-service export:** `GET /api/o/<orgId>/export?entity=customers` (also `jobs`,
  `suppliers`, `invoices`, `payments`, `expenses`, `daily_reports`, `audit_log`) —
  confirm the seeded data round-trips. Money columns are redacted to the caller's
  cost/price privilege.

When §1–§6 are green, the org is pilot-ready. Track each item on the
[onboarding + template checklist](01-onboarding-template-checklist.md).

---

## Quick reference — where each step lives

| Step | Nav / URL | Who (archetype) | Backing code |
| --- | --- | --- | --- |
| Sign up | `/signup` | anyone | `(auth)/actions.ts` `signupAction` |
| Create org | `/onboarding` | signed-in, no org | `createOrgForUser` → `app.create_org_with_owner` |
| Guided onboarding | `/o/<orgId>/onboarding` | owner/admin | `modules/onboarding/service.ts` |
| Manual template install + terminology | `/o/<orgId>/settings/configuration` | owner/admin | `platform/config/install.ts` |
| Imports | `/o/<orgId>/imports` | owner/admin/manager | `modules/imports/service.ts` |
| Manual masters | `/o/<orgId>/{people,customers,suppliers,items}` | per matrix | `modules/masters/service.ts` |
| Members / invites | `/o/<orgId>/settings/members` | owner/admin | `platform/auth/identity.ts` |
| First job | `/o/<orgId>/jobs` | owner/admin/manager | `modules/jobs/service.ts` |
| Export | `/api/o/<orgId>/export?entity=…` | owner/admin/accounts | `platform/export/service.ts` |
