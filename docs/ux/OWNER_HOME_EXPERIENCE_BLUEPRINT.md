# Owner Home Experience Blueprint — "Your business, alive"

**Microstep 002A · design document only — no code.** Status of the deployed `CommandCenterHero`
(`bf405e7`): a successful *technical* experiment (tokens, truthfulness law, motion-safe discipline,
role isolation all proven) and a **rejected design direction**. This blueprint defines what replaces
it and how, in independently deployable increments (002B–002G).

Product ambition: IdaraWorks must make even a very small business — a home cupcake operation — feel
**organized, capable, valuable and ready to scale**, without pretending it has revenue or activity
it does not have. Premium comes from clarity, control, personalization, visible progress,
typography, guidance and coherence — not decoration. The home is not a statistics page; it is the
owner's **operating environment**.

---

## 1. Honest critique of the deployed screen

Verified against `src/app/(app)/o/[orgId]/page.tsx`, `CommandCenterHero.tsx`, `nav/*`, and the
dashboard components.

1. **The hero is attached, not integrated.** It is a dark decorated band inserted above an
   otherwise unchanged page. Below it, the same equal-weight card grid continues in the light
   theme. Nothing above the fold *connects* to anything below it; the hero's orbital SVG has no
   relationship to the business's actual state. It reads as a banner, and banners read as marketing.
2. **The page hierarchy remains generic.** After the hero: digest card, two half-width charts,
   at-risk list, quick actions, deadlines, activity, subscription strip — all rendered as
   same-shaped `SectionCard`s in a 1/2-column grid (`page.tsx` OwnerScreen + shared bottom
   section). Every module competes at equal visual weight; the page has no *argument* — no "this
   first, because…". That is the definition of a generic admin template, whatever the colors.
3. **Empty charts poison the first run.** A new org renders `TrendChart` scaffolds with
   `trend_empty` copy, a stage donut with nothing in it, and KPI values of 0-0-0-0 in the hero.
   Four zeros under a heading that says "Your operation, at a glance" tells a brand-new founder:
   *your business is nothing*. The exact opposite of the ambition.
4. **The sidebar overwhelms a small business.** The owner rail exposes 8 groups / ~23 destinations
   (`nav/build.ts:433`) on day one — Materials, Money (6 items), People, Data… A cupcake baker who
   enabled nothing yet sees the org chart of a factory. Locked/irrelevant items add noise exactly
   when confidence needs building.
5. **Visual weight spent without understanding gained.** The hero's grid/orbits/glow consume the
   most prominent 240px of the page and encode zero information (the audit's own test proves the
   SVG carries no data — that was the honesty goal, but it concedes the point: it is wallpaper).
   Meanwhile the information that *should* own that space — "what changed, what needs me" — sits
   below in undifferentiated cards.
6. **Retain (the experiment paid for real assets):** the truthfulness law and its tests (no
   invented numbers — this blueprint keeps it constitutional); `buildOwnerSignals`' real-data
   mapping; the hero token technique (`color-mix` over existing semantics — reusable for the depth
   system in §7); motion-safe-only keyframes; the per-role branch isolation that made the change
   collateral-free; the `perspective` micro-3D approach (right tool, wrong subject). The
   *component* is replaced in 002B; the *infrastructure* stays.

## 2. Owner jobs-to-be-done

**First 5 seconds** — answer, without reading: *Am I okay? Is anything on fire? Did anything move?*
- Active org: one calm status line + at most one attention signal, visually distinct from everything else.
- Empty org: *"You're set up / almost set up — here's where you are."* Progress, not zeros.

**First 30 seconds** — answer by scanning: *What changed since I last looked? What needs my
decision? Where is work in the pipeline?*
- Active: yesterday's delta (reports in, jobs moved, money received), the 1–3 decisions waiting,
  the flow picture.
- Empty: what the workspace can already do, the 2–3 next setup/first-work actions, what unlocks after each.

**First 5 minutes** — *act and orient*: approve the waiting item, chase the overdue thing, create
the next piece of work; then browse — team activity, momentum, capabilities. The owner leaves
feeling: *I know where my business stands and I did the two things that mattered.*

## 3. New experience architecture

Nine candidate zones. **Rendering rule: a zone renders only when it has something useful to say**
— the page is composed per-state (empty / active / attention), never a fixed grid. Order below is
priority order; a zone earns its place, it is not entitled to one.

| Zone | What it says | Renders when |
| --- | --- | --- |
| **Business Brief** | One composed paragraph + 2–4 delta chips: "3 reports came in yesterday · 1 job moved to Delivery · AED 4,500 received". The heading is the org's own name/logo, not "Today". | Always (empty state gets the setup variant) |
| **Next Best Actions** | Max **3** prioritized real actions, each with its *reason* ("Approve Fahad's material request — 2 days waiting"). Priority: decisions waiting → overdue/blocked → returned reports → collections → first-work/setup steps. | Always (that is the point of the page) |
| **Attention** | Blockers, overdue, approvals — *in context*: each item names its job, its age, its owner, its next step. Replaces scattered warning cards. | Only when non-empty |
| **Operational Flow** | The demand→work→cash path as connected stages with REAL counts: Quotes awaiting (demand) → Active by stage (work) → Done this week (delivery) → Invoiced/Outstanding (cash, price-gated). Clicking a node opens its filtered view. | When ≥1 job or quote exists |
| **Momentum** | What got DONE: completed jobs, submitted reports (wk vs prev wk), resolved attention items. Written as achievement, not audit. | When ≥1 completion exists this week |
| **Team Pulse** | Who did what recently (activity, reports submitted, crew on site today) framed as contribution — never idle-time, rankings or surveillance framing. | When ≥2 members AND activity exists |
| **Business Map** | The owner's configured system: capabilities on (with their org terminology), what's off and what turning it on would add. Doubles as honest upsell surface (existing LockedCard logic). | Empty + growing orgs; collapsible for mature ones |
| **Quick Create** | 2–4 *contextual* creates (empty org: "Add your first customer"; active: "New order", "Daily report") from the existing role/entitlement-aware builder — not the full generic menu. | Always, compact |
| **Setup Progress** | Replaces every zero-KPI/empty-chart surface for new orgs: named steps with done/next states, each step explaining what it unlocks. | Until first real operational data, then retires itself |

## 4. Three realistic dashboard states

> All numbers below are **illustrative wireframe data**, invented for layout design only — not
> production data, not defaults, never to be shipped as content.

### State 1 — "Rawan's Cupcakes", created today (empty org)

```
┌────────────────────────────────────────────────────────────┐
│ [logo/initials]  Rawan's Cupcakes                          │
│ Your workspace is ready. Two steps until your first order. │  ← Business Brief (setup variant)
├────────────────────────────────────────────────────────────┤
│ SETUP PROGRESS                          ▓▓▓▓▓░░░  5 of 8   │
│ ✓ Workspace created      ✓ Orders configured               │
│ ✓ Currency & VAT         ✓ Your logo                       │
│ → Add your first customer            (unlocks orders)      │
│ → Add what you sell                  (unlocks quick quotes)│
│   Invite a helper · Set an order flow                      │  ← progressive disclosure (collapsed)
├────────────────────────────────────────────────────────────┤
│ NEXT BEST ACTIONS                                          │
│ 1 ▸ Add your first customer — orders need one              │
│ 2 ▸ Create your first order — see how tracking works       │
│ 3 ▸ Add a teammate — reports arrive by themselves          │
├────────────────────────────────────────────────────────────┤
│ YOUR BUSINESS, AS CONFIGURED             [Business Map]    │
│ Orders ✓  Daily updates ✓  Customers ✓  Team ✓            │
│ Quotes & invoices — off · turn on when you're ready        │
└────────────────────────────────────────────────────────────┘
```
No charts. No zeros. No empty graphs. The page is *shorter* than an active org's — correctly.

### State 2 — "Jasmine Events", growing and healthy

```
┌────────────────────────────────────────────────────────────┐
│ [logo] Jasmine Events            Tue 26 Aug · all calm ✓   │
│ Yesterday: 4 reports in · "Wedding — Zahra" moved to Setup │  ← Brief + delta chips
│ · AED 3,200 received                                       │
├──────────────────────────────┬─────────────────────────────┤
│ NEXT BEST ACTIONS            │ OPERATIONAL FLOW            │
│ 1 ▸ Approve Fahad's MR       │  Quotes (2) ─▶ Active (6)   │
│     (AED 850 · waiting 1d)   │   by stage ▷ Prep 3 · Setup │
│ 2 ▸ Review Sara's report     │   2 · Delivery 1            │
│ 3 ▸ Send quote to Al Noor    │  ─▶ Done this wk (2)        │
│                              │  ─▶ Outstanding AED 12,400  │  ← price-gated
├──────────────────────────────┴─────────────────────────────┤
│ MOMENTUM                     │ TEAM PULSE                  │
│ 2 events delivered this week │ Sara — 3 reports this week  │
│ Reports 11 (↑ from 8)        │ Fahad — on site today       │
│ 1 blocker cleared            │ 2 handoffs completed        │
├──────────────────────────────┴─────────────────────────────┤
│ Quick create:  ▸ New order  ▸ Daily report  ▸ Quote        │
└────────────────────────────────────────────────────────────┘
```
Attention zone absent (nothing urgent). Business Map collapsed to a footer link.

### State 3 — "Gulf Marine Works", busy with risk

```
┌────────────────────────────────────────────────────────────┐
│ [logo] Gulf Marine Works       Tue 26 Aug · needs attention│  ← truthful non-numeric status
│ 2 boats overdue · 3 approvals waiting · AED 68k past due   │
├────────────────────────────────────────────────────────────┤
│ ATTENTION — raised surface, above the fold                 │
│ ⚠ 24C-007 "Al Fahim" — 6 days overdue at Rigging           │
│    blocker: awaiting engine parts (PO-118 partial) ▸ view  │
│ ⚠ Approvals: 3 waiting (oldest 3 days, AED 12,500) ▸ decide│
│ ⚠ Collections: AED 68,000 past 90 days ▸ AR                │
├──────────────────────────────┬─────────────────────────────┤
│ NEXT BEST ACTIONS            │ OPERATIONAL FLOW            │
│ 1 ▸ Decide oldest approval   │ Quotes (1) ─▶ Active (9)    │
│ 2 ▸ Call re: PO-118 parts    │  ⚠ 2 overdue highlighted    │
│ 3 ▸ Chase Al Rashid invoice  │ ─▶ Done wk (1) ─▶ AR ⚠68k   │
├──────────────────────────────┴─────────────────────────────┤
│ MOMENTUM (kept small — honesty: still 14 reports this wk)  │
└────────────────────────────────────────────────────────────┘
```
Under load the page *reorders*: Attention takes the raised layer; Momentum shrinks but never
disappears when real (morale honesty works both ways).

## 5. Responsive wireframes

**Wide desktop (≥1440):** two-column body under a full-width Brief. Start-column = decisions
(Next Best Actions, Attention); end-column = system view (Flow, Momentum, Team Pulse). Business
Map/Setup full-width below. The eye path is Brief → Actions → Flow.

**Standard laptop (~1280):** same order, Flow drops under Actions (single column ~720px content +
the rail); delta chips wrap to two lines; Flow nodes compress to counts-only.

**Mobile (≥375):** strict single column in priority order: Brief (2 lines max) → Next Best Actions
(the screen's heart — 3 full-width 44px+ rows) → Attention → Flow (vertical stages, not horizontal)
→ Momentum → collapsed disclosure rows for Team Pulse / Business Map. Quick Create stays in the
existing bottom-nav "+". Nothing horizontal-scrolls.

**Arabic RTL:** identical hierarchy and ordering (start/end flip automatically — logical
properties only, already law). Flow direction follows reading direction: demand starts at the
inline-start in both languages (the arrow glyphs flip). Numerals stay `dir="ltr"` islands. Delta
chips and action reasons written for Arabic-first cadence (see §10 voice), not translated word
order.

## 6. Navigation and shell proposal (design only — implemented in 002D)

**Calmer shell:** a compact **workspace rail** (~72px, icons + labels on hover/expand) with at most
**five first-level destinations for the owner**: **Home · Work · Money · People · Settings**
(Materials folds under Work; Data/exports under Settings; Customers under Work or Money per
terminology). Second-level navigation becomes **contextual**: opening Work shows jobs / reports /
approvals / materials as a section header row inside the page, not a permanent global tree. The org
identity moves to the top of the rail — logo, name, accent — making the brand feel like the
product's owner rather than a footer detail. Command/search (⌘K) is reserved space in the top bar
(built later; not 002D scope). Role-aware shortcuts: the rail's middle section shows the 2–3
destinations *this role uses daily* (from the existing nav builder's role lists).

**Compatibility:** zero route changes — the rail links to the exact current paths; `can()` +
entitlement gating keeps deciding visibility (same `buildNav` data, regrouped); the current
sidebar's grouped tree becomes the expanded state of the rail; mobile keeps the existing bottom
nav + drawer (the drawer adopts the new grouping). Every current permission boundary remains the
decider — the shell is a re-projection of the same nav model.

## 7. Meaningful 3D/depth system

Depth = **semantics, not wallpaper**. Three uses, all CSS/SVG, all server-rendered:

1. **Urgency elevation.** Three surface layers with existing/extended tokens: base (context:
   Momentum, Map), raised (work: Actions, Flow), **prominent** (Attention — stronger shadow +
   1–2px lift + accent edge). A card's elevation is *computed from its state* (attention items
   literally sit above the page), replacing tone-colored borders as the primary urgency channel.
2. **Flow topology.** The Operational Flow is the one "system alive" visual: real-count nodes
   connected by SVG paths; a stage with overdue work renders its node raised + warning-edged; the
   connecting path to a starved stage (0 items) renders dashed. Movement (motion-safe only): a
   single slow dash-offset drift along paths that had activity yesterday — motion *means* "this
   edge moved recently". Static for reduced-motion; counts carry the meaning without it.
3. **Progress as space.** Setup Progress and stage progress render as a path travelled (filled
   segment length = real completion), not a percentage badge.

**Hard limits:** no fake metrics anywhere (constitutional, tested); no WebGL/canvas/deps; no
continuous ambient animation (only the meaning-bearing drift, motion-safe); no glassmorphism/neon;
gradients only as ≤8% tints of existing tokens; mobile simplifies to flat cards + ordered list
(depth is an enhancement, never the information); server-rendered HTML/SVG, no layout shift.

## 8. Adaptive behavior

Composition inputs (all existing): `ResolvedEntitlements.features` (capability on/off →
Flow stages shown, Business Map contents, Quick Create verbs), configuration/terminology (org's own
nouns everywhere), role + `can()` (this page stays Owner/Admin; every zone's underlying reads are
already permission-gated in `getDashboardExtras`/`composeToday`), `ctx.pricePrivileged` /
`costPrivileged` (the cash node, AR chip and any money delta render **only** price-privileged —
otherwise the Flow simply ends at Delivery; no locked-money teaser to non-entitled roles),
data-presence (zone rendering rule, §3), and maturity: **empty** (no jobs/customers → Setup state),
**active** (default), **attention** (any of: overdue > 0, blockers > 0, approvals waiting > N days,
over-90 AR > 0 → reorder per State 3). Redaction never leaks: all money already arrives
pre-redacted from the services (F-23 nulls), and the composition layer treats `null` as "zone
absent", never as 0.

## 9. Existing-data map (verified against the code, 2026-08-26)

| Surface | Existing data | Source (already permission-safe) | Gap | Ship without new query? |
| --- | --- | --- | --- | --- |
| Business Brief | yesterday's reports/moves/money: digest sections `yesterday`, `crew`, `customers_awaiting`; deltas from `reportsThisWeek/PrevWeek`, `jobs.doneThisWeek`, `paymentsWeekMinor` (price-gated) | `getOwnerDigest` (entitlement-gated), `getDashboardExtras` | Digest rows are nightly/Inngest-gated in prod → Brief must degrade to extras-only composition (it can) | **Yes** |
| Next Best Actions | approvals (`listInbox` rows + age), overdue (`jobs.overdue`, `at_risk` card items), returned reports (foreman card exists; owner variant = `reports_to_review`/`missing_reports` cards), collections (`collections` card, `over90`), setup steps (`needsSetup` + installed template + entitlements) | `composeToday` owner cards, `listInbox`, `getDashboardExtras` | A pure prioritizer function (new CODE, not new data) | **Yes** |
| Attention | `at_risk` card (rule keys + severities), `blockers`/`overdue` cards, `approvalsPending`, `openIssues`, `collections.over90` | `composeToday`, extras | none | **Yes** |
| Operational Flow | `quotesAwaiting` → `jobs.active` + `stageDist` → `doneThisWeek` → `ar_summary`/`collections` (price-gated), supply chips from `poStatus`/`mrOpen` | extras + owner cards | none for v1 | **Yes** |
| Momentum | `doneThisWeek`, `reportsThisWeek` vs prev, deadlines met | extras | "problems resolved this week" (dismissed-exception count) is not currently surfaced — omit in v1 or add later (needs a small query) | **Yes (without resolved-count)** |
| Team Pulse | `activity` (actor names + summaries), attendance today (`listAttendanceForDate`, already imported by the page), reports-by-person implicit in activity | extras, attendance service | per-person aggregation is client-side composition of activity — fine for v1; a real per-member rollup would need a query later | **Yes** |
| Business Map | `features` on/off, terminology, LockedFeature price mapping | `resolveEntitlements`, terminology, U3 selection helpers | none | **Yes** |
| Quick Create | role/entitlement-aware verbs | `buildQuickCreate` | contextual filtering is code, not data | **Yes** |
| Setup Progress | installed template marker, entitlements, counts (customers/jobs exist?) — `listJobs` length already read; customer-count needs either the existing masters list call or a tiny count | config marker + extras | a customers-exist boolean is the only possibly-new read; v1 can infer from the existing onboarding-checklist logic | **Mostly yes** |

**Genuinely missing data (flagged, NOT invented):** business goals/targets (no entity — see owner
decisions), resolved-exception counts, per-member contribution rollups, any notion of "customer
demand inflow" beyond quotes. None blocks 002B.

## 10. Visual language

- **Typography:** two-scale hierarchy on the existing Geist stack — display (Brief heading, org
  name: `text-2xl/3xl`, semibold, tight leading) and body (`text-sm`) with a *single* intermediate
  (`text-base medium`) for zone titles. Numbers always `font-mono tabular-nums dir=ltr`. Arabic
  gets +0.05 line-height on body text (long shaping). No new fonts.
- **Spacing rhythm:** 4px base grid; zones separated by 24px (mobile 16px); inside-zone rows 8/12px.
  The Brief gets asymmetric breathing room (32px below) — it is the page's only "hero" whitespace.
- **Surfaces:** page canvas → card → raised → prominent (§7). The dark graphite surface survives in
  exactly one place: the **Flow topology**, where dark ground makes the light nodes read as the
  system image — a purposeful island, not a banner.
- **Color roles:** existing tokens unchanged: accent = org identity + interactive; status tones
  ONLY on real states; money always neutral ink (money is information, not alarm). New: the ≤8%
  accent tint for the Brief's backdrop.
- **Icons:** existing 24px stroke set at 16px, always paired with text — never icon-only meaning.
- **Empty states:** small inline SVG *diagrams of the flow to come* (e.g. the three-node
  order→work→done path, greyed with "your first order will appear here") — teaching drawings,
  not clip-art moods.
- **Micro-interactions:** hover lift (existing motion-safe pattern), chevron affordances on
  disclosure rows, focus rings per the global law; **motion rules:** only the Flow drift (§7) +
  120ms enter transitions; nothing loops decoratively; everything static under reduced motion.
- **Org identity:** logo/initials + org name lead the page (Brief) and the rail (§6); accent
  derived from org branding as today. The product recedes; the business is the star.
- **Voice (en):** plain, confident, second person, verbs first: "Approve Fahad's request", "2 boats
  need a decision". Never blame ("Sara hasn't…" → "Sara's report is waiting for review"). **Voice
  (ar):** natural Gulf business Arabic, addressed respectfully (أنتَ/أنتِ neutral forms), same
  verb-first energy: "اعتمد طلب فهد" — written for Arabic, not through it.

## 11. Removal list

Remove/replace in 002B–002D (technical assets retained per §1.6):
1. `CommandCenterHero` from the owner page (component may remain in the tree until 002F cleanup).
2. The owner four-KPI grid concept entirely (signals fold into Brief chips + Flow nodes).
3. Empty `TrendChart`/`StatusDonut` scaffolds on data-less orgs (charts render only with ≥5 data
   points; otherwise the zone stays silent or shows the teaching diagram).
4. The equal-weight `SectionCard` grid as the page's layout principle.
5. The generic "Today" `<h1>` + role badge header (replaced by the org-identity Brief).
6. The permanent 8-group sidebar for owners (002D: rail + contextual second level).
7. The `SubscriptionStrip`'s slot at the page bottom (moves into Business Map / account surfaces).
8. Duplicated quick-action surfaces (page section + top-bar + New menu → one contextual Quick
   Create + the existing top-bar "+").

## 12. Implementation sequence (each independently deployable + reversible)

- **002B — Structure & state logic:** the zone composer (pure function: existing payloads →
  ordered zones per §8 states), Brief, Next Best Actions, Attention, Setup Progress; removals #1–5.
  No new queries; feature-parity fallback = current page kept behind the same role branch for
  instant revert.
- **002C — Operational Flow & prioritization depth:** the Flow topology (real counts, price-gated
  cash node), Momentum, Team Pulse composition; the prioritizer gets its full reason strings.
- **002D — Shell:** workspace rail + contextual second-level + org identity; routes/permissions
  untouched; old sidebar retained behind a single layout flag for revert.
- **002E — Mobile, RTL, accessibility hardening:** the §5 mobile order, Arabic voice pass with a
  native review, keyboard walk, contrast audit, 375px overflow tests.
- **002F — Motion/depth polish:** urgency elevation, flow drift, enter transitions, reduced-motion
  verification; delete retired components.
- **002G — Demo-business presentation:** the ~5 fictional marketing workspaces (per the 2026-08-26
  owner direction) rendered through this real home — content work, no engine changes.

Each step ships behind the existing owner-branch isolation, passes the standard gates
(format/lint/typecheck/unit/build + focused tests + CI), and can be reverted by a single commit.

---

### Constitutional guardrails (restated for every increment)
Server-side data access, pooled tenancy + RLS, permission/entitlement boundaries, terminology
resolution, en/ar parity, AI-configures-never-codes, existing routes — all unchanged. No customer-
facing industry templates return. Nothing here is claimed to be scientifically guaranteed or
unprecedented — it is a considered application of well-worn principles (self-determination theory's
autonomy/competence/relatedness framing, goal-feedback loops, progressive disclosure) to this
codebase's real data.
