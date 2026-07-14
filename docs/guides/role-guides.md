# IdaraWorks — Role Guides

One short guide per role: what you do day to day, where you do it, and **what money you can and
can't see**. IdaraWorks has seven roles. Money visibility runs on two independent, per-role
switches:

- **Costs** (`finance.viewCosts`) — labour cost, cost side-tables, the figures on the **Costing**
  page.
- **Prices / margin** (`finance.viewPrices`) — selling prices and margin on **quotes, invoices,
  payments, and AR**.

The table below is the **default** from the shipped template. An Owner/Admin can toggle either
switch on a role in Configuration, so your workspace may differ — but the Foreman seat is designed to
show **no money anywhere**, whatever the flags.

| Role | Sees costs? | Sees prices / margin? | Today screen |
|---|---|---|---|
| **Owner** | Yes | Yes | Owner (with digest) |
| **Admin** | Yes | Yes | Owner (with digest) |
| **Manager** (Workshop Manager) | No | No | Manager |
| **Foreman** | No (none anywhere) | No | Foreman (field) |
| **Procurement** | No | No | Procurement (supply) |
| **Accounts** | Yes | Yes | Accounts (finance) |
| **Viewer** | No | No | — (no Today) |

All roles use the app in **English or Arabic** (switch on the Account page); Arabic renders
right-to-left. Everything is mobile-first.

---

## Owner

**You are the workspace owner.** Full control of people, configuration, money, and commercials.

**Day to day**
- **Today + digest:** open `/o/<orgId>` for the management action list plus the **digest card** — a
  deterministic roll-up of what needs a decision, what's at risk, collections due, and yesterday's
  activity (narrated when AI is enabled, always readable without it).
- **People & roles:** invite/deactivate members and set roles (Members). You're the only role that
  can't be deactivated.
- **Configuration:** install the template, rename terminology (EN/AR), and undo config revisions.
- **Money:** everything — Costing, Expenses, Quotes, Invoices, Payments, AR.
- **Approvals:** you decide rule-routed approvals (e.g. purchases over threshold).
- **Commercials:** the **only** role that can change plan or cancel the subscription. Grant or
  decline **support-access** requests (consent-gated impersonation) and review who accessed the org.

**Sees:** all costs and all prices/margin. Everything.

**Can't / doesn't:** entering live payment or bank credentials is done with the provider directly,
never inside IdaraWorks.

---

## Admin

**You run the workspace operationally**, with the same reach as the Owner except the top commercial
levers.

**Day to day**
- Same **Today + digest**, **Members**, **Configuration**, **masters**, **money**, and **approvals**
  surfaces as the Owner.
- Manage members (invite/deactivate), install/adjust configuration, run onboarding and imports.

**Sees:** all costs and all prices/margin (same as Owner).

**Can't:** **change the subscription plan or cancel** — that's Owner-only (you can *view* billing).
You also can't deactivate the Owner.

---

## Manager (Workshop Manager)

**You run production.** Jobs, stages, the week plan, reports, crew, and blockers.

**Day to day**
- **Today (manager view):** today's plan, blockers, reports to review, missing/overdue reports for
  the jobs you manage.
- **Work:** manage jobs and move stages; review and return **daily reports**; run **attendance**;
  raise and resolve **issues**; manage crew and the **week** plan.
- **Masters:** manage employees, customers, and the item catalogue.
- **Approvals:** decide rule-routed approvals within your remit.
- **Supply:** raise material requests, manage purchase orders, receive goods (create GRNs).
- **Money (limited):** you can open the **Costing** page and create **expenses**, and you can draft
  **quotes** — but see redaction below.

**Sees:** **no cost figures and no prices/margin by default.** On the Costing page the labour cost
and margin lines are **blanked**; you see quantities, stages, and progress, not the money. Approval
cards show what needs deciding but hide the amount unless you've been granted the price flag.

**Can't:** view invoices, payments, or AR; see salary/HR side-details; change org configuration or
manage members; approve your own request (self-approval is blocked).

> If your Owner grants you the cost flag, the Costing page's cost figures become visible to you —
> ask them; don't expect it by default.

---

## Foreman (field / mobile)

**You are on the workshop floor, on your phone.** The app is built for *doing*, not monitoring.

**Day to day**
- **Today (field view):** your jobs and tasks for the day — a clean action list, **no money**.
- **Daily report** (`/reports/new`): file the day's report on an assigned job — stage worked,
  labour **hours** (normal + OT), **materials** used (pick from the catalogue or type free text),
  and **photos**. This is your main job.
- **Tasks:** update task status; request a stage be marked complete.
- **Issues:** raise a blocker fast when something stops the work.
- **Supply (assigned jobs only):** raise a **material request** and record **goods received** on the
  jobs you're assigned to.

**Sees:** **no money at all — anywhere.** No costs, no prices, no margin, not even redacted
placeholders. Report labour is entered as *hours*, never as cost.

**Can't:** decide approvals; manage purchase orders; see costing, expenses, quotes, invoices,
payments, or AR; touch configuration, members, customers, or the catalogue. You act only on jobs
assigned to you.

---

## Procurement

**You own the supply chain** — turning needs into orders and receiving goods.

**Day to day**
- **Today (procurement view):** approved material requests waiting to be converted, and your open
  purchase orders.
- **Materials:** raise **material requests**, **convert** approved requests into **purchase orders**,
  manage POs (with the generated bilingual LPO PDF), and receive goods (**GRNs**, including partial
  receipts).
- **Expenses:** create and view **expenses** (e.g. petty-cash purchases).
- **Catalogue:** manage suppliers and items.
- **Issues:** raise material problems as issues.

**Sees:** **no cost figures and no prices/margin by default** — you work with quantities, suppliers,
and order status. You see the operational supply picture, not the org's costing or billing money.
(You may see an approval-related exception only when a rule specifically names your role.)

**Can't:** decide approvals; open the Costing page; view quotes, invoices, payments, or AR.

---

## Accounts

**You are the back office / finance seat.**

**Day to day**
- **Today (finance view):** collections due, AR, and invoice status.
- **Money:** manage **invoices**, **payments**, and **AR**; view **quotes**; create and **void
  expenses**; open the **Costing** page.
- **Approvals:** decide rule-routed approvals (amounts are visible to you).
- **Attendance:** view attendance (payroll input).
- **Exports:** run self-service **CSV exports** (`data.export`).
- **Billing:** **view** the subscription/plan status (you can't change it).

**Sees:** **both costs and prices/margin** — you're cost- and price-privileged, so amounts show in
full across the finance surfaces and in your exports.

**Can't:** change the subscription plan/cancel (Owner-only); manage members or org configuration;
draft quotes (you can manage/view invoices and payments, but quote *drafting* sits with
management).

---

## Viewer

**Read-only, redacted visibility** — for stakeholders who need to watch progress without touching
anything or seeing money.

**Day to day**
- See **jobs** (money redacted), the **week** plan, and **attendance**.

**Sees:** **no money.** Job figures are redacted; no costs, no prices, no margin.

**Can't:** create or change anything; no Today screen (you get an informational placeholder); no
approvals, supply, money, masters, configuration, or members surfaces.

---

## At-a-glance: who can do what

| Capability | Owner | Admin | Manager | Foreman | Procurement | Accounts | Viewer |
|---|---|---|---|---|---|---|---|
| Invite / deactivate members | ✓ | ✓ | view | — | view | view | view |
| Org configuration + terminology | ✓ | ✓ | — | — | — | — | — |
| Manage jobs & stages | ✓ | ✓ | ✓ | assigned* | view | view | view |
| File daily reports | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Review daily reports | ✓ | ✓ | ✓ | — | — | — | — |
| Decide approvals | ✓ | ✓ | ✓ | — | — | ✓ | — |
| Material requests | ✓ | ✓ | ✓ | assigned* | ✓ (+convert) | — | — |
| Purchase orders | ✓ | ✓ | manage | — | manage | view | — |
| Expenses | ✓ (+void) | ✓ (+void) | create | — | create | ✓ (+void) | — |
| Costing page | ✓ | ✓ | redacted | — | — | ✓ | — |
| Quotes | ✓ | ✓ | draft | — | — | view | — |
| Invoices / Payments / AR | ✓ | ✓ | — | — | — | ✓ | — |
| See costs (labour/cost) | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| See prices / margin | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Change subscription / cancel | ✓ | view | — | — | — | view | — |
| Self-service export (CSV) | ✓ | ✓ | — | — | — | ✓ | — |

\* *assigned* = only on jobs the foreman is assigned to. "redacted" = the page opens but money lines
are hidden. Money-visibility columns are the shipped defaults and can be toggled per role by an
Owner/Admin in Configuration (except the Foreman seat, which is designed to show no money at all).

See **`docs/guides/admin-guide.md`** for the full navigation map, the money model, exports, support-
access awareness, and language switching.
