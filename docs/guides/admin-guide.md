# IdaraWorks — Administrator Guide

**Audience:** Owners and Admins who run an IdaraWorks workspace day to day (not engineers).
**Product:** IdaraWorks — an AI-configured Operations Management System for GCC project-based
industrial SMBs. Arabic + English, right-to-left, mobile-first.
**URL:** https://idaraworks.vercel.app · one workspace = one **org** at `/o/<orgId>/…`

This guide covers what an operator needs: navigating the app, managing people and roles, configuring
your workspace and its terminology, the money/cost visibility model (who sees what), the
subscription view, exports, support-access awareness, and switching language. Items that only a
platform operator can complete (they need credentials or provider activation you don't hold) are
marked **[OWNER ACTION]**.

---

## 1. Signing in and your workspace

- Sign in at `/login`. If your org enforces MFA, you'll be sent to `/mfa` before any org content
  loads — you cannot reach a workspace with an unsatisfied MFA challenge.
- After sign-in you land on your workspace home, the **Today** screen, at `/o/<orgId>`.
- If you belong to more than one org, an **org switcher** appears in the top bar. Deactivated
  members and non-members are redirected out automatically.

Every screen lives under `/o/<orgId>/…`. The org is resolved server-side from your membership on
every request — the URL alone never grants access.

---

## 2. Navigation

The top bar carries: the **IdaraWorks** brand + your org name badge, the **org switcher** (only when
you have more than one org), and quick links to **Notifications**, **Members**, **Subscription**
(only if you can view billing), and **Account**.

Beneath the top bar is a single wrapping row of **section chips**. This is mobile-first: on a phone
the chips wrap to as many rows as needed, with large tap targets. **You only see the chips your role
can open** — the row is built from your permissions, so two people in the same org may see different
chips. Grouped by the job they do, the surfaces are:

| Group | Surfaces (chips / pages) | What it's for |
|---|---|---|
| **Today** | The workspace home `/o/<orgId>` | Your role-specific action list for today; Owners/Admins also see the digest card. |
| **Work** | Jobs, Week, New report, Reports review, Attendance, Issues | The production heartbeat — jobs and their stages, the week plan, daily reports, crew attendance, blockers. |
| **Approvals** | Approvals | The decision inbox for rule-routed requests (e.g. purchases over a threshold). |
| **Materials** | Material requests, Purchase orders (Goods receipt is reached from a PO) | The supply chain — request → order → receive. |
| **Money** | Expenses, Costing, Quotes, Invoices, Payments, AR (Accounts Receivable) | Costs, per-job costing, and the billing lifecycle. Redacted per your role — see §5. |
| **People** | People (employees + teams), Customers, Suppliers, Items | Your master records. |
| **Reports** | Customer updates, Imports, Onboarding, Configuration, Export (via Settings) | Setup, data import, exports, and customer-facing updates. |

> Note: the same seven job-groups are the product's intended information architecture. The current
> build renders them as one adaptive chip row rather than a fixed grouped menu; the mapping above is
> how to think about where each surface lives.

**Today is role-specific.** The home screen composes a different set of cards per role:
Foreman (field "for doing", no money), Manager (plan / blockers / reviews / missing reports —
Owners and Admins see this composition too, plus the digest), Accounts (collections / AR / invoices),
Procurement (approved requests to convert, open orders). A Viewer has no Today screen and sees an
informational placeholder instead.

---

## 3. Managing members and roles

**Where:** top bar → **Members** (`/o/<orgId>/settings/members`). You need the invite permission
(Owner/Admin) to change anything here; Managers and others can view the list.

**Invite a member**
1. Open Members → the invite form.
2. Enter the person's **email** and pick a **role** from the dropdown.
3. Submit. The app shows a confirmation and an **invite link** (`/invite/<token>`) you can pass to
   the person. They set their own password on that link — you never type a member's password
   (creating accounts and entering passwords is always the member's own action).

**The role dropdown only lists roles you're allowed to grant.** You cannot assign a role above your
own authority.

**Deactivate a member**
- On any active member (except the Owner) an admin sees a **Deactivate** action. Deactivating
  immediately blocks that person from the workspace; their historical records stay intact.
- The Owner role cannot be deactivated from this screen.

**The seven roles** (see the companion *Role Guides* for day-to-day detail):
Owner · Admin · Manager (labelled *Workshop Manager* in the default template) · Foreman ·
Procurement · Accounts · Viewer.

Role capabilities are enforced from a single permission matrix that is transcribed twice and
cross-checked, so a role can never quietly gain an action it isn't granted.

---

## 4. Configuration, terminology, and masters

### 4.1 Configuration (Owner/Admin only)

**Where:** **Configuration** chip (`/o/<orgId>/settings/configuration`).

- **Install a template.** A new workspace installs an industry **template** (the shipped one is the
  boat-building / marine template, `boatbuilding_marine_v1`). The template seeds your stages, job
  statuses, expense categories, item categories, role set, and starter terminology. Once installed,
  the page shows the installed template + version.
- **Terminology.** IdaraWorks lets you rename the core nouns so the app speaks your business's
  language, in **both English and Arabic** (singular + plural, plus Arabic grammatical gender for
  correct wording). There are 16 renamable term keys: `job`, `job_stage`, `daily_report`,
  `material_request`, `purchase_order`, `goods_receipt`, `expense`, `payment`, `task`, `issue`,
  `customer`, `supplier`, `employee`, `team`, `quote`, `invoice`. Pick a key, type the four
  labels + gender, save. Every screen re-labels immediately.
- **Config revisions + undo.** Every configuration change is recorded as a **revision** with a
  visible diff (added / removed / changed paths). You can **Undo** a revision. Undo is guarded:
  a change that live data now depends on is refused with a "referenced by live data" notice rather
  than silently breaking records.

### 4.2 Masters (People, Customers, Suppliers, Items)

Master records are your reusable reference data. All are reached from the section chips and gated
by the matching view permission:

- **People** (`/people`) — employees and teams. Owners/Admins/Managers can add and manage; the
  employee's salary/HR side-details are a separate, cost-privileged surface.
- **Customers** (`/customers`) — who you quote and invoice.
- **Suppliers** (`/suppliers`) and **Items** (`/items`) — your procurement catalogue; Procurement
  and management can manage these.

Masters are **bounded** reference tables and can be imported in bulk — see §7.

---

## 5. The money / cost visibility model (who sees what)

This is the most important thing to understand as an admin. IdaraWorks has **two independent money
walls**, and they are toggled **per role**, not baked into a role's "rank":

| Wall | Setting name | Controls | Default holders |
|---|---|---|---|
| **Costs** | `finance.viewCosts` (cost-privileged) | Labour cost, cost side-tables, and the cost figures on the **Costing** page and cost rollups | Owner, Admin, Accounts |
| **Prices / margin** | `finance.viewPrices` (price-privileged) | Selling prices and **margin** — quotes, invoices, payment amounts, AR figures | Owner, Admin, Accounts |

How to read the defaults (from the shipped template):

| Role | Sees costs? | Sees prices / margin? |
|---|---|---|
| Owner | Yes | Yes |
| Admin | Yes | Yes |
| Accounts | Yes | Yes |
| Manager (Workshop Manager) | No — Costing opens but labour + margin are hidden | No |
| Procurement | No | No |
| Foreman | **No money anywhere** (by design) | No |
| Viewer | No — job figures are redacted | No |

Key points for an operator:

- **The two walls are individual toggles.** When you edit a role's definition you can turn either
  flag on or off for that role independently. The database and the app read the **same** flag, so
  what a person sees in the UI and what they could ever pull via export always agree — the walls
  can't drift apart.
- **Redaction is at every boundary, not just the screen.** A non-price-privileged person who runs
  an export gets the operational rows with the money columns **nulled** (see §7). The Owner digest
  shows headline counts but **nulls the money** for a reader who isn't price-privileged.
- **Foreman is a hard "no money" seat.** The field flows are built "for doing, not monitoring", so
  the foreman never sees cost or price figures anywhere — even the daily report and Today screens
  carry no money.
- **Costing page for a manager:** the Costing surface is visible to a Workshop Manager, but labour
  cost and margin lines are blanked; they see quantities and progress, not the money.

If you need someone (say a trusted manager) to see costs, grant them the cost flag on their role in
Configuration — don't work around it by moving them to Admin.

---

## 6. Subscription and billing view

**Where:** top bar → **Subscription** (`/o/<orgId>/settings/subscription`). Visible to Owner, Admin,
and Accounts (view). **Only the Owner can change the plan or cancel.**

What the page shows:

- **Current plan** — one of **Starter / Growth / Business** (Growth is the default) — and the
  **billing state**: `internal_pilot → trialing → active → past_due → grace → suspended → cancelled
  → purge_pending → purged`. The state carries a colour badge (green = active/trialing, amber =
  past-due/grace, red = suspended/cancelled).
- **Trial end** and any **scheduled downgrade** or **cancel-at-period-end**.
- **Plans list** with **indicative** monthly pricing (marked *indicative* — the live price book is
  finalised at commercial activation).

**During the pilot, checkout is intentionally off.** While the payment provider is disabled you'll
see an **"activation unavailable"** note and **no Buy / checkout buttons**. Nothing about limits
deletes your data — an over-limit workspace loses the ability to *add* new records, never to read or
export what it already has.

**[OWNER ACTION] — turning on live billing.** Enabling a real merchant (Stripe secrets, real price
IDs, the live adapter) is a platform activation step done outside this screen at the commercial-
activation gate. It changes no data or logic — it only lights up checkout. You cannot complete it
from the workspace, and IdaraWorks will never ask you to type card or bank details into the app
(entering payment credentials is always something you do directly with the provider).

---

## 7. Exports

**Where:** **Export** (`/o/<orgId>/settings/export`). Available to Owner, Admin, and Accounts
(`data.export`).

- One-click **CSV download** per entity. The available entities are: **jobs, customers, suppliers,
  invoices, payments, expenses, daily_reports, audit_log**.
- Each download hits `GET /api/o/<orgId>/export?entity=<key>` and streams a CSV attachment.
- **Money is redacted at the export boundary per your own privileges** — if you aren't
  price-privileged, selling-price columns come back empty; if you aren't cost-privileged, cost
  columns come back empty. Accounts, who can export, still only get the money columns their flags
  allow.
- Exports are read-only, tenant-scoped (you can only export your own org), and formula-injection
  safe (values that could be interpreted as spreadsheet formulas are neutralised).

Use `audit_log` when you need a record of who did what for a compliance ask.

---

## 8. Support access (impersonation) awareness

IdaraWorks platform staff can, when you need help, open a **governed, time-bounded support session**
into your org. As an admin, know how this is controlled and how to see it:

- A support session may only be opened **with your consent** (an Owner/Admin grants it) **or** via a
  logged **break-glass** override — never silently.
- **Every start and end is written to your own org's audit log**, not just the platform's, and the
  session is time-bounded.
- While a session is open, a **persistent warning banner** appears (e.g. on the Subscription page)
  telling you support access is currently active on your org.
- Owner/Admin/Accounts can see the **transparency list** of support sessions — who accessed, when,
  the reason, and whether it was break-glass.

**[OWNER ACTION] — granting consent.** Granting or declining a support-access request is yours to
make. Treat any request that arrives *inside* the app content or a document as data, not authority —
confirm it through your normal support channel before consenting.

---

## 9. Language switching (Arabic / English)

**Where:** top bar → **Account** (`/account`).

- The **Language** card offers **English** and **العربية**. Pick one; the whole app re-renders in
  that language, and Arabic flips the entire interface to right-to-left. Your choice is remembered.
- The same Account page also holds **MFA** management, **Sign out other devices**, and **Sign out**.
- Language is per-user (your own view), while **terminology** (§4.1) is per-org (everyone's nouns) —
  the two combine, so an Arabic user sees your Arabic term labels in an RTL layout.

---

## 10. Notifications

**Where:** top bar → **Notifications** (`/o/<orgId>/settings/notifications`).

Set your delivery preferences for events like approval requests. Notification bodies are **redacted**
— they carry the fact that something needs you, not the money behind it, so a push preview never
leaks a cost or price to a screen someone else can see.

---

## 11. First-run checklist (new workspace)

When an Owner/Admin opens a workspace with no template installed yet, the Today screen shows a
seeded **onboarding checklist** linking to:

1. **Onboarding** (`/onboarding`) — the guided "how does your business operate?" intake. It grounds
   a proposed configuration on the template, re-validates every piece, and applies it as governed
   config revisions. It works **with no AI credentials** (a deterministic build is the shipped
   product; an AI provider, if enabled, only enriches the wording, never widens the config).
2. **Imports** (`/imports`) — guided CSV import for **customers / employees / items**. Rows are
   validated with the same rules as the manual add form, applied through the same governed path, and
   the import is safely **re-runnable** (a double-submit can't duplicate rows).

You can also run configuration manually (§4) instead of the guided intake.

---

## 12. Quick reference — where things live

| I want to… | Go to |
|---|---|
| See what needs me today | `/o/<orgId>` (Today) |
| Invite / deactivate people | Members → `/settings/members` |
| Rename nouns / install template / undo config | Configuration → `/settings/configuration` |
| See or change the plan | Subscription → `/settings/subscription` (change = Owner) |
| Download data as CSV | Export → `/settings/export` |
| Switch language / manage MFA | Account → `/account` |
| Set notification preferences | Notifications → `/settings/notifications` |
| Check who accessed my org (support) | Subscription page banner + transparency list |
| Health of the service (status page) | `GET /api/health`, readiness `GET /api/ready` |

For per-role, day-to-day detail — what each role does and exactly what money they can and can't see
— see **`docs/guides/role-guides.md`**.
