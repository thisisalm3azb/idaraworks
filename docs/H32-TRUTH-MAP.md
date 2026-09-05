# H32 — Simple Guided Onboarding: truth map

What is actually true about this phase, written before and during the work rather
than after it. Everything here is checkable in the repository or the database.

---

## Part A — what already existed

Before building anything, the mandate's own instruction was to reuse a safe
preference mechanism if one exists.

| Question | Answer | Evidence |
| --- | --- | --- |
| Is there a generic per-user preference store? | **No.** | Only `notification_preference`, which is specific to notification channels. |
| Is there an org-scoped key-value store? | Yes — `public.app_settings`, keyed `(org_id, key)`. | Unsuitable: it has no user dimension, so one person finishing the tour would finish it for the whole company. |
| Is there an existing getting-started checklist? | **Yes, partly.** | `SetupProgress` on the owner home page, fed by `home.setup` in `src/modules/today/owner-home.ts`. |
| Is there any tour, welcome panel or product walkthrough? | No. | No `data-tour` attribute existed anywhere in `src/`. |

### The existing setup card, and why H32 did not replace or duplicate it

`SetupProgress` renders **only while the workspace is `empty`**, is shown **only
on the owner home screen**, and lists *configuration* steps: workspace created,
company details, logo, invite the team. Its own source comments record that it
deliberately cannot include "first job / first report" steps, because the
composer it is fed from receives recent-window aggregates and cannot prove
all-time firsts.

So the two answer different questions, and H32's checklist was trimmed from four
items to three specifically to avoid asking "invite somebody" twice on one
screen. The existing card keeps that item.

| | Existing `SetupProgress` | H32 `GettingStarted` |
| --- | --- | --- |
| Question | Is this workspace configured? | Has this company done its first real work? |
| Audience | Owner home, empty workspace only | Anyone eligible, permission-filtered |
| Items | workspace, config, logo, team | customer, job, invoice |
| Proves firsts? | No (by design) | Yes — `exists()` over the whole table |
| Dismissible per person? | No | Yes |

---

## Part B — the storage decision

`public.onboarding_state`, migration `0137_h32a_onboarding_state.sql`. Additive:
one new table, nothing existing altered, and an organisation with no rows behaves
exactly as it does today.

**Keyed `(org_id, user_id)`**, mirroring `notification_preference` (migration
0011) so a reader who knows one knows the other.

Every RLS policy carries **both** conditions:

```sql
org_id = (select app.current_org_id())
and user_id = (select app.current_user_id())
```

That is the whole enforcement of "an administrator cannot mark another user's
tour complete". It is not a permission check in a service that a future call site
could forget — the row is not visible to them at all. `tests/integration/guided-onboarding.test.ts`
proves it by driving the raw tenant connection as a legitimate administrator of
the right organisation and watching the SELECT, the UPDATE and the INSERT all
fail to touch a colleague's row.

Grants: `select, insert`, plus a **column-scoped** `update` that omits `org_id`
and `user_id`, so no application path can move a row to another person or
company. **No `delete` grant.**

### Why not browser storage

Local storage would make "finished" mean "finished in this browser" — the tour
would come back from the dead on somebody's phone the evening after they
dismissed it on their laptop. Server state governs completion. The
implementation uses **no** browser storage at all.

### Why no `command()` audit wrapper

The audit log is the organisation's record of who changed the business.
"Advanced to step 3 of the welcome tour" is not that, and a few hundred such rows
per new employee would bury the entries somebody needs during a dispute. The row
is visible only to its own owner and `updated_at` already answers "when". This is
pinned by a test asserting `audit_log` does not grow.

---

## Part C — the eligibility rule (documented, as required)

> **Only a person whose membership in this organisation began at or after
> `AUTO_START_FROM` (2026-09-05T00:00:00Z) is greeted automatically.**

Defined in `src/modules/guidedtour/tours.ts`.

Everybody else can start the tour whenever they like from the account menu, and
is **never** interrupted.

Two rejected alternatives, and why:

- **"No progress row means new."** On the day this ships nobody has a progress
  row, so this would greet the entire existing customer base at once — precisely
  the interruption the mandate forbids.
- **"Joined within the last N days."** Quietly changes who is eligible every time
  the flag is toggled, so the same person could be greeted twice, months apart.

Two deliberate exceptions:

- An **unfinished** tour resumes regardless of join date — that is what makes
  cross-device resume work.
- Somebody whose **job here changed** (their role now maps to a different tour)
  is offered the newly relevant one.

---

## Part D — the tour

Four tours, chosen by role and then filtered again by permission:

| Tour | Roles | Steps |
| --- | --- | --- |
| `owner` | owner, admin, manager | home, create, customers, jobs, invoices, team, help (7) |
| `finance` | accounts | home, quotes, invoices, payments, expenses, help (6) |
| `supply` | procurement | home, requests, orders, items, suppliers, help (6) |
| `field` | foreman, viewer, worker_reserved_p3 | home, work, report, attendance, issues, help (6) |

`MAX_STEPS = 7`, asserted per tour by a test. The role map is exhaustive over
`ROLE_ARCHETYPES` — which caught the reserved eighth archetype
(`worker_reserved_p3`) at compile time during the build.

Every tour's last step is `help`, pointing at the account menu, because a person
who skips on day one and wants it on day three must not have to ask a colleague.

### Targets are stable identifiers

Steps point at `data-tour="…"` attributes placed deliberately for this purpose:
`brand`, `create`, `account`, and `nav:<key>` emitted from each nav item's own
key. Never a CSS path (breaks when the menu is reordered) and never translated
text (breaks in Arabic). A test reads the source and fails if a step names a
target nothing emits.

The same `nav:<key>` value is emitted by the desktop sidebar, the mobile drawer
**and** the bottom bar, so a step means "the place you find your work", not "the
sidebar". The client picks whichever copy is actually on screen.

**A missing target does not drop the step** — it renders centred instead. Losing
the arrow is better than losing the sentence.

---

## Part E — the safety properties

| Promise | How it is kept | Proof |
| --- | --- | --- |
| Never creates or modifies business records | The checklist is three `exists()` reads | Integration test compares customer/job/invoice counts before and after |
| No cross-tenant read | RLS `org_id` predicate + the two-org bleed harness | `seed-two-orgs.ts` seeder registered; harness enumerates every `org_id` table |
| Admin cannot complete a colleague's tour | RLS `user_id` predicate in the same policy | Raw-connection SELECT / UPDATE / INSERT tests |
| Never blocks the app | Every server action swallows its own failure; both server components return `null` on any query error | Actions return `void`; mounts catch around the query only |
| Never traps the user | Escape always closes; the page behind stays interactive (`pointer-events-none` overlay); `aria-modal="false"` | — |
| Flag-off is a no-op | Every entry point returns before querying | `guidedOnboardingEnabled()` is the first line of both components and gates the menu item |
| Nouns are the company's own | `{job}` / `{jobs}` ICU variables | The house i18n test caught three literal uses and now passes |

---

## Part F — what H32 did NOT do

- Did not begin the customer pilot.
- Did not enable H28 AI or the H29 country/Spanish releases.
- Did not touch PO-002.
- Did not modify any real customer business record.
- Did not weaken authentication, tenant isolation, CI or any production check.
- Did not build a training platform, video course, AI guide or 3D experience.

**H30's five owner conditions remain open.** H32 does not change the launch
recommendation.

---

## Part G — the defect found in production, after the first close

**Symptom.** "Show me around" did nothing for the owner.

**Cause.** `restartTourAction` redirected to the URL the person was already on
without `revalidatePath`. Same-URL soft navigation → layout segment served from
the client router cache → the tour mount (which lives in the layout) never
re-rendered. Proven by the dev server log: `POST … 303` and then no request.

**Fix.** `revalidatePath(\`/o/${orgId}\`, "layout")` before `redirect()`; caught
failures in all three actions now reported through `captureRequestError`.

**Regression test.** `tests/e2e/h32-show-me-around.spec.ts` — signed-in, both
viewports, pre-cutoff and newcomer; fails without the fix.

**Two harness traps recorded for next time.**
- A production build into `.next` corrupts the dev cache: every route, including
  API routes, renders the root not-found. Clear `.next` before `next dev`.
- Supabase magic-link tokens are single-use. Mint one per sign-in, not per user.

---

## Part H — the second production defect: "it stopped at step 2 of 7"

**Read-only verdict on the owner's row:** `skipped`, `step_index=2` — the client
had advanced to step 3 and the server recorded it. Transition fine; **step 3's
card was never seen.**

**Exact cause (instrumented walk):** card at `top=905` in a 720-px viewport,
because its target — the "Customers" sidebar item — sat at `y=1097` inside the
sidebar's `overflow-y-auto` column. No scroll-into-view, no clamp.

**Also found:** `create`/`account` anchors were `display: contents` (0×0, never
ringed); progress writes queued behind one another on fast clicking.

**Fixes:** scroll the target into view once per step; treat a still-off-screen
target as absent; clamp the card to the viewport with its measured height;
give the two anchors real boxes; coalesce progress writes to one in flight.

**Regression:** the e2e now walks all seven steps on desktop and 375 px, in
English and Arabic, asserting the card is inside the viewport and the database
step after every click, Back, Done, restart, and unchanged business counts.

**Law:** a card positioned relative to an anchor must prove the anchor is on
screen first, and must never trust that its own box is. Every earlier gate
passed while the card was 185 px below the screen.

---

## Closure

**2026-09-05 — owner acceptance.** All seven steps of the live tour walked and
confirmed correct by the owner. H32 complete. No new phase started.
