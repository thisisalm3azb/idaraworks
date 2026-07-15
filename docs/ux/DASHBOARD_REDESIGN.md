# U5 — Dashboard & Navigation Redesign

Status: shipped (task U5). Replaces the S1 "pill-wall" nav and the flat Today
card list with a branded shell + role dashboards. This document is the IA /
design-system record; per-role screen contents live in `ROLE_DASHBOARDS.md`.

## 1. Navigation shell

### Desktop (md+)
- **Left sidebar** (`src/app/(app)/o/[orgId]/nav/SidebarNav.tsx`, client for
  active-state + collapse only): OrgLogo + org name on top (U2 brand slot —
  tenant logo when `feat.branding_app`, initials avatar otherwise), then the
  role-aware grouped nav. Groups collapse; active item = 3px accent start-border
  + accent-soft tint + accent icon; labels stay ink-on-light (contrast-safe for
  any tenant accent).
- **Top bar** (server, in `layout.tsx`): page-context slot (brand on mobile),
  quick-create **+ New** menu (role-aware, entitled items only), notifications,
  language switch (cookie via `setActiveLocaleAction`), account menu (account,
  subscription, members, org switcher, logout).

### Mobile (< md, 375px first-class)
- Compact top bar: burger → **drawer** (the full grouped nav + an account
  link; start-side sheet, flips under RTL), brand, + New, bell, account.
- **BottomNav mounted** (`src/platform/ui/BottomNav.tsx`): 4 role-primary items
  + **More** (opens the same drawer). 44px+ targets everywhere; labels truncate;
  no horizontal overflow (the old header min-content overflow is gone — the
  top bar is icon-only on small widths with `min-w-0` truncation).

### The IA (groups)
`Today · Work [jobs, week, new report, review, issues, approvals, attendance] ·
Materials [MRs, POs, items, suppliers] · Money [quotes, invoices, payments,
expenses, costing, AR] · Customers [customers, customer updates] · People
[people, members] · Insights [imports, exports] · Settings [set up,
configuration, branding, notifications, subscription]`

Notes: *receiving* has no standalone route (GRNs are recorded from the PO
detail) so it is not a nav item; *digest* lives on the dashboard, not the nav.

### Visibility law (unchanged semantics)
One pure builder — `src/platform/ui/nav/build.ts` (`buildNavGroups`,
`buildBottomNav`, `buildQuickCreate`, `activeItemKey`) — is the single source
for all three surfaces. `can()` (authz matrix) remains THE decider of whether
an item exists for a role; the entitlement feature remains the decider of its
entitled state. Unit-tested per role × entitlements in
`tests/unit/nav-build.test.ts`.

### Locked-vs-hidden rule (the ONE consistent rule)
- **Money-group items** (quotes, invoices, payments, expenses, costing) whose
  capability is OFF are **shown with a lock glyph**. Their link goes to the
  subscription page for `billing.view` holders, else to the module's own
  read-only list (reads are never blocked — freeze FR-9).
- **Every other entitlement-gated item** (attendance, MRs, POs, customer
  updates, imports) is **hidden** when its capability is off — exactly the
  pre-U5 behaviour.
- Rationale: money modules are the monetisation surface — an honest locked
  state advertises the upgrade; operational add-ons stay out of the field
  crew's way.

## 2. Colour / accent system (globals.css — surgical)
- Canvas deepened: `--surface-page #f0f0ec`, `--surface-sunken #e8e8e3`; cards
  stay white with `--elevation-1` (`shadow-card`); popovers use `--elevation-2`
  (`shadow-pop`). Kills the pale-on-pale.
- **Org accent**: `--accent` (default `var(--brand)`), overridden inline by the
  org layout from `getAppBranding` when `feat.branding_app` is on. Derivatives
  via `color-mix`: `--accent-soft` (12% tint), `--accent-line` (32%). The
  accent drives **indicator bars, tints, chart strokes and icons only — never
  text colour** — so any tenant `#rrggbb` stays WCAG AA (ink text on light
  surfaces throughout). No rainbow: charts use the semantic status tokens
  (`src/platform/ui/dashboard/palette.ts`).

## 3. Component inventory (`src/platform/ui/dashboard/`)
| Component | File | Notes |
|---|---|---|
| KpiCard | KpiCard.tsx | value/delta/icon/href; value `dir="ltr"` mono |
| TrendChart | TrendChart.tsx | hand-rolled SVG line/bar; hover + arrow-key tooltips; `role="img"`; plot pinned LTR |
| StatusDonut | StatusDonut.tsx | server SVG ring + linked legend (values always in the legend — no hover dependence) |
| DistributionBar | ProgressCard.tsx | stacked stage/status bar + linked legend |
| SectionCard / RowList | cards.tsx | titled card with "view all"; linked rows, badges, ltr metas |
| ActivityTimeline | cards.tsx | reads `public.activity` via `getDashboardExtras` (foreman: assigned jobs only) |
| QuickActions | cards.tsx | role-aware create links (same builder as + New) |
| LockedCard | cards.tsx | compact honest locked state (LockedFeature stays the full-page treatment) |
| Skeleton / DashboardSkeleton | cards.tsx | `loading.tsx` |
| ErrorState | ErrorState.tsx | org `error.tsx` w/ retry + Sentry capture |
| WelcomeBanner | WelcomeBanner.tsx | honours `?welcome=1` (onboarding redirect); dismissible |
| geometry | geometry.ts | pure chart math + `formatCompact`/`computeDelta` (unit-tested) |
| icons | ../icons.tsx | ~34 stroke icons, `currentColor`, addressed by name |

## 4. Data
`getDashboardExtras` (`src/modules/today/dashboard.ts`, exported via the today
service) is the ONE new read: small read-only aggregates, each gated by the
same `can()` action as its page, money additionally behind `ctx.pricePrivileged`
(the foreman branch selects no money column at all; manager/foreman queries are
scoped by `assignedJobCondition` — F-6). `composeToday` is untouched and still
feeds the attention queues; `listInbox` feeds the approvals card (it already
redacts amounts per subject type).

## 5. Interactivity map (card → destination)
| Surface | Destination |
|---|---|
| Active/completed KPI, stage segment | `/jobs`, `/jobs?stage=<stage_key>` |
| Overdue KPI | `/jobs?filter=overdue` (new display filter) |
| Approvals KPI/queue | `/approvals` |
| Report trend / review KPIs | `/reports/review`; foreman → `/reports/new` |
| Receivables / aging segments | `/ar` |
| Payments trend/KPI | `/payments` |
| Expenses / quotes / invoices KPIs | `/expenses`, `/quotes`, `/invoices` |
| MR / PO cards | `/material-requests`, `/purchase-orders` |
| Deadlines rows | `/jobs/[jobId]` (view all → `/week`) |
| Attendance card | `/attendance` |
| Subscription strip | `/settings/subscription` |
| Digest rows | per-section deep links (unchanged) |

## 6. 375px behaviour
- KPI grid 2-up; visual cards single-column; charts scale to container width
  (SVG viewBox), tooltips clamp inside the card.
- Bottom bar fixed with `env(safe-area-inset-bottom)`; main content keeps
  `pb-24` clearance.
- Drawer is a start-side sheet (85% width, max-xs); all touch targets ≥44px.
- Nothing overflows horizontally: `min-w-0` + truncation on every flexible
  row; top-bar actions are icon-only below `sm`.

## 7. Tests
- `tests/unit/nav-build.test.ts` — role × entitlement matrix, foreman money
  wall, locked-vs-hidden, bottom-bar fallbacks, active-state resolution.
- `tests/unit/dashboard-geometry.test.ts` — chart math + KPI formatting.
- `tests/unit/dashboard-render.test.ts` — SSR smoke + RTL physical-class guard
  for every new component and icon.
