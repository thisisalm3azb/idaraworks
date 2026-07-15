# U5 — Role Dashboards (Today screens)

`src/app/(app)/o/[orgId]/page.tsx` composes each role's screen from
`composeToday` (attention queues — unchanged), `getDashboardExtras` (U5
aggregates), `listInbox` (approvals) and the digest (S7, unchanged gating).
Common to every screen: header + screen badge, `?welcome=1` banner, first-run
setup card (`onboarding.run` + no installed template), quick actions (same
builder as + New), deadlines + recent-activity row, skeleton `loading.tsx`,
retrying `error.tsx`. Terminology: every domain noun arrives via `term()` ICU
vars (`{job}/{jobs}/{daily_report}/{daily_reports}`).

Redaction laws hold everywhere: money only when `ctx.pricePrivileged` (AR via
`computeAR`, inbox amounts via `listInbox`'s per-subject rules); the foreman
data branch never selects a money column; manager/foreman aggregates are
scoped to assigned jobs (F-6).

## OWNER (owner/admin)
- KPIs: active {jobs}, completed this week, approvals waiting (warn), overdue
  {jobs} (danger) → `/jobs`, `/approvals`, `/jobs?filter=overdue`.
- Visuals: stage distribution bar (segments → `/jobs?stage=…`), 14-day report
  bar chart with week-over-week delta.
- Money row (each slot renders a LockedCard when its capability is off):
  collections summary (outstanding + >90d, pricePrivileged) → `/ar`; 30-day
  payments line + this-week sum → `/payments`.
- At-risk list (rule-labelled exception rows → job pages / `/week`),
  approvals queue (titles, amounts where permitted, job refs) → `/approvals`.
- Purchasing status (MRs submitted/approved, open POs, awaiting receipt),
  attendance today (present/marked of active employees, `cap.attendance`).
- Owner digest card (unchanged; upsell LockedCard when the add-on is off).
- Subscription strip (billing.view): plan + state badges, office seats vs
  limit, storage used vs limit → `/settings/subscription`.

## MANAGER
- KPIs: active {jobs} (scoped), reports to review (warn), missing today
  (warn), blockers (danger).
- Visuals: workload by stage (scoped), reporting-completion 14-day bar.
- Approval queue (rule-routed inbox), the three dismissible exception cards
  (missing reports / overdue / blockers — dismiss action unchanged), reports
  to review + missing today queues.
- No invoices/payments/AR anywhere (matrix row 57 −); money group in nav is
  quotes/expenses/costing only.

## FOREMAN (mobile-first)
- Hero CTA: **Submit today's {daily_report}** (accent block, count badge) when
  any assigned job lacks today's report.
- KPIs: my {jobs}, to submit today, returned {daily_reports}, open issues (on
  assigned jobs only).
- My-jobs list (big rows → job pages, last-report meta), returned-reports list
  (→ report page), small own-report 14-day trend.
- Activity feed restricted to assigned-job rows. NO money data is fetched or
  rendered (F-23 — the data layer never selects it for this branch).
- Quick actions: new report, material request (when `cap.material_requests`).

## ACCOUNTS
- KPIs: outstanding AR (money), overdue receivables (danger), ready to
  invoice (warn), expenses to pay, quotes awaiting action, payments this week
  (money).
- Visuals: AR aging donut (current/1–30/31–60/61–90/90+ → `/ar`), 30-day
  payments line (money).
- Finance approvals queue, invoices-to-issue + overdue-receivables queues.

## PROCUREMENT
- KPIs: requests awaiting approval, approved MRs to convert, open POs,
  awaiting receipt.
- Visual: PO status donut (approved / sent / partially received).
- Catalogue shortcuts (suppliers, items), activity, deadlines.

## Empty states
- New org (owner/admin): setup checklist card + welcome banner suggestions.
- Foreman with no assignments: explanatory EmptyState ("when a manager assigns
  you to a {job}…").
- Every list card has a per-card empty label; charts show "No data yet."
- Viewer (no `today.view`): unchanged "coming soon" EmptyState.
