# H32 — Simple Guided Onboarding: implementation report

**Status: COMPLETE — accepted by the owner on 2026-09-05.** The owner signed in to
production and walked all seven steps of the live tour; every step behaved
correctly. Live commit `8d89e96`; migration `0137_h32a_onboarding_state.sql`;
`FEATURE_GUIDED_ONBOARDING=1`.

The phase was closed three times. The first close rested on every gate except
the one that mattered; the owner found two production defects in it; the third
close rests on a signed-in browser walking the whole tour on the same code the
owner then used. That history is kept below deliberately.

---

## What a person actually sees

Somebody who joins a company on IdaraWorks from now on signs in and gets a small
panel: *"Welcome to <their company>. A quick look around, about a minute. You can
stop at any time."* Two buttons — start, or not now.

If they start, five to seven short steps walk them through the parts of the
product their own job uses, each one highlighting the real control on the real
page. The last step tells them where to find the tour again. Escape closes it at
any point; the application behind stays fully usable throughout.

On the home page there is a three-item list — first customer, first job, first
invoice — that ticks itself from records that already exist and disappears once
done or dismissed.

Everybody who was already using IdaraWorks sees **none of this** unless they ask
for it from the account menu.

---

## The five decisions worth defending

### 1. Server state, not browser state

Whether somebody has finished is a row in `public.onboarding_state`, not a
`localStorage` key. There is no browser storage in this feature at all.

A tour that is "finished" in one browser is unfinished in every other one, so it
comes back on the phone the evening after being dismissed on the laptop. That is
worse than having no tour.

### 2. The RLS predicate is the enforcement, not a permission check

Every policy on the table names **both** the current organisation and the current
user:

```sql
org_id = (select app.current_org_id())
and user_id = (select app.current_user_id())
```

The mandate requires that administrators cannot mark another user's tour
complete. That could have been a `can()` check in the service — and a future call
site could have forgotten it. Instead the colleague's row is not visible to them
at all, so there is no request shape that asks for it and nothing to forget.

The integration test proves this the only way that means anything: it drops
underneath the service and issues the SELECT, the UPDATE and the INSERT as a
legitimate administrator of the right organisation. The select returns nothing,
the update matches nothing, the insert is refused.

### 3. A fixed cutoff, so nobody who was already here is interrupted

Only a membership beginning at or after `AUTO_START_FROM` (2026-09-05T00:00:00Z)
is greeted automatically.

The obvious alternative — "no progress row means new" — would have greeted the
entire customer base at once on the day this shipped. The production smoke states
the outcome as a number rather than an intention:

```
memberships: 41 predate the cutoff (never auto-greeted), 0 are new, 41 total
eligibility: existing members are excluded from the automatic welcome — 41 protected
```

### 4. The checklist counts; it never creates

Three `exists()` reads. No branch of this feature inserts a customer, a job, an
invoice or anything else. A getting-started list that seeds an example record to
tick its own box leaves fake entries in a real ledger, and "you can delete them
later" does not make that a reasonable thing to do to somebody's books.

Asserted, not asserted-in-prose: the integration test compares the customer, job
and invoice counts before and after repeated loads.

### 5. Progress stays out of the business audit trail

`saveProgress` does not go through the house `command()` wrapper. The audit log
records who changed the business; "advanced to step 3 of the welcome tour" is not
that, and a few hundred such rows per new employee would bury the entries
somebody needs during a dispute. Pinned by a test that fails if `audit_log` grows.

---

## Defects found, and how

Not one of these was found by reading the code back.

| # | Defect | Found by |
| --- | --- | --- |
| 1 | The role→tour map did not cover `worker_reserved_p3`, a reserved eighth archetype | The compiler, because the map is exhaustive over `ROLE_ARCHETYPES` rather than a lookup with a default. Without that shape its holders would silently have received the owner's tour. |
| 2 | **Restart did not restart** | The integration test. Restart writes `in_progress`, which is not a terminal state, so the never-go-backwards guard clamped the reset away and resumed at the last step. Intent and resulting status are different things; the caller now says which it is. |
| 3 | Three strings said "job" literally | The house i18n test. A company that calls a job a *boat* would have read "job" in its own welcome tour. Now `{job}` / `{jobs}`. |
| 4 | The overlay re-rendered ~60×/second | Rereading the client island. `setRect` was called with a fresh object every animation frame; every one was a new reference, so React re-rendered the whole overlay continuously for a highlight that is usually perfectly still. |
| 5 | On a 375px screen the panel covered its own target | Rereading the same file. Most mobile steps point at the bottom navigation bar and the panel was a sheet pinned to the bottom. It now goes to whichever end the target is not at. |
| 6 | The home page ran the same query twice | Rereading. The tour mount is in the layout, the checklist is on the page. Both now go through one `cache()`d read per request. |

### And one that was not H32's

The two-org bleed harness had been **failing on its teardown hook for days**. Its
assertions passed and only the cleanup timed out, so the failure looked like
noise and nobody chased it — while twelve leftover `Bleed A` / `Bleed B` org
pairs accumulated in the test project.

The cause: the teardown issued one DELETE per table per org, roughly five hundred
sequential round trips to a remote database, and had grown past the 180-second
budget as the schema grew. It now sends one statement. The harness is green end
to end (669s, teardown included) and the leftover orgs are removed.

That is worth recording because it is the second time in three phases that a
green-looking signal was hiding something: H31's icon returned a valid PNG with
no glyphs in it, and this returned passing assertions with a failing cleanup.
**A test file's own status line is evidence; its test count is not.**

---

## What shipped

| | |
| --- | --- |
| Migration | `0137_h32a_onboarding_state.sql` — one additive table |
| Module | `src/modules/guidedtour/` — `tours.ts` (pure), `service.ts` (the only door) |
| UI | `src/app/(app)/o/[orgId]/onboarding-tour/` — mount, client island, checklist, actions, cached read |
| Flag | `FEATURE_GUIDED_ONBOARDING`, exact string `"1"` |
| Copy | 69 keys × EN / AR / ES |
| Tests | 20 unit laws, 15 integration, 1 bleed seeder |
| Tooling | `tooling/scripts/h32-prod-smoke.ts` (read-only, two modes) |
| Docs | truth map, owner checklist, this report |

---

## What H32 did not do

- Did not begin the customer pilot.
- Did not enable H28 AI or the H29 country / Spanish releases.
- Did not touch PO-002.
- Did not modify any customer business record. Production counts unchanged
  throughout: 41 orgs / 62 users / 51 customers / 78 invoices / 93 jobs / 670
  audit rows.
- Did not weaken authentication, tenant isolation, CI or any production check.
- Did not build a training platform, video course, AI guide or 3D experience.

**H30's five owner conditions remain open. H32 does not change the launch
recommendation.**

---

## The defect the owner found, and why every gate missed it

The owner signed in to production, opened the account menu, clicked
**"Show me around"** — and nothing happened. Every gate was green.

### Cause (proven, not inferred)

Reproduced with a signed-in disposable fixture against the isolated test
project. The dev server's own log gave the answer:

```
POST /o/<org> 303 in 13.4s        ← the action ran and issued its redirect
                                   ← …and no GET followed. Nothing at all.
```

`restartTourAction` wrote the row correctly (status `in_progress`, step 0 —
asserted through the owner connection), then called `redirect()` to the org
home, which is where the person already was. A redirect to the current URL is a
**soft navigation**, and a soft navigation reuses the layout segment from the
client router cache. The tour is mounted by the org **layout**. So the server
said "in progress", the browser kept its cached copy of the shell that said
"nothing to show", and the click was invisible.

The sibling `dismissExceptionAction` in the same directory calls
`revalidatePath` before its redirect for exactly this reason. Mine did not.

### Fix

`revalidatePath("/o/<orgId>", "layout")` before the redirect — `"layout"`
because revalidating the page alone re-renders everything *except* the thing
that needs it. And the three swallowing actions now report every caught failure
through the house error channel: "does not break the page" and "nobody ever
finds out" are different properties, and the first version had confused them.

### Why nothing caught it

| Gate | Why it was green |
| --- | --- |
| Unit laws | Content and eligibility only — no browser |
| Integration (15) | Called `restartTour` directly and read the row back — the row was right |
| Production smokes (2 × 25) | Read-only, signed out — could not click |
| Build / lint / typecheck | The code was valid; it was the *wrong* code |

The one thing that would have caught it was the signed-in browser walk, and the
first report recorded that as NOT PERFORMED. It is now performed on every run of
the regression spec below, and the spec is written so that it fails without the
fix (it did).

### The regression test

`tests/e2e/h32-show-me-around.spec.ts` — six checks across desktop and 375px:

1. A **pre-cutoff** member signs in and is **not** greeted, and the menu offers
   "Show me around".
2. Clicking it shows the first step **immediately**, on that page, as a result
   of that click — "Your home page", "Step 1 of 7"; the first target is
   visible; the server row is `in_progress` / 0 / `owner`; Next advances;
   Escape closes; the console is clean.
3. A **newcomer** is greeted; "Not now" sticks across a reload.

The session is minted through the Supabase admin API and consumed by the app's
own `/auth/confirm` route — no password exists anywhere in the file. It refuses
any environment that resolves to production, and removes everything it creates.

To run it here (no Docker needed): export `.env.test.local`, set
`FEATURE_GUIDED_ONBOARDING=1`, start `next dev -p 3000`, then
`npx playwright test --config playwright.local.config.ts tests/e2e/h32-show-me-around.spec.ts`.
Clear `.next` first if a production build has been run since — a build into the
dev cache makes every route 404, which cost an hour of this diagnosis.

---

## Verification, second pass

| Gate | Result |
| --- | --- |
| Signed-in browser walk, desktop + 375px, pre-cutoff member and newcomer | **6/6 green** against the fixed code; the click test fails without the fix |
| Unit (1702) / typecheck / lint / format / build | green |
| Test-project residue after the harness | 0 orgs, 0 users, 0 onboarding rows |
| Production | see the deployment note appended below |

### Deployment of the fix

| | |
| --- | --- |
| Fix commit | `31fc81f`, CI success |
| Merge | `d89fe46` (`--no-ff`; merge tree identical to the verified branch tree `315c0a4…`) |
| Live | www.idaraworks.com serves `d89fe46`, auto-deployed; `FEATURE_GUIDED_ONBOARDING=1` bound |
| Flag-on smoke on the live commit | 25/25 |
| Business counts | unchanged throughout: 41 orgs / 62 users / 51 customers / 78 invoices / 93 jobs / 670 audit rows |
| Harness residue in production | 0 orgs, 0 users — the harness never touched production |
| `onboarding_state` in production | exactly one row: the owner's own click from 06:30, `in_progress` / step 0 / `owner`. Deliberately left as is. |

That single row is the whole diagnosis in one line: the click handler ran and the
restart wrote the right state on the first attempt. Only the re-render failed.
With the fix live, that row means the tour will open on the owner's next page
load without any click; "Show me around" also works, and both paths are what
the regression test proves.

---

## Third pass — "it stopped at step 2 of 7"

### What the database said, read-only

The owner's own row, untouched: `status=skipped step_index=2 dismissed_at=07:14:27`.
`step_index=2` is index 2 — **step 3**. The Next click at step 2 ran, the client
advanced to step 3 and the server recorded it. The tour was then closed
(Escape) while the client was at step 3. So the state machine worked; **step 3's
card was never seen**. A display problem, not a transition problem.

### The exact reason, captured

An instrumented walk (signed-in disposable owner, isolated test project, the
card's box and every target's rect logged after each click):

```
step 3 +2000ms  dialog: 12,905 320x180   viewport 1280x720   nav:customers: 8,1097
```

The card was placed at `top=905` in a 720-pixel viewport — **185 pixels below
the bottom of the screen**. Its target, the "Customers" sidebar item, sits at
`y=1097` inside the sidebar's `overflow-y-auto` column, below the fold on an
ordinary laptop. The tour measured that target faithfully, positioned the card
relative to it, and clamped nothing. Playwright reported Back and Next as
"outside of the viewport"; a person sees a dimmed page and no card.

Two further findings from the same walk:

- The `create` and `account` anchors measured **0×0**: they were
  `display: contents` wrappers, which have no box, so those steps could never be
  ringed and always fell back to centred.
- Progress writes **queued**. Server actions from one browser run one at a time;
  a person clicking Next quickly built a queue of round-trips and the database
  trailed the screen — "completed" was still queued ten seconds after Done.

### Fixes

| | |
| --- | --- |
| Off-screen target | On each step change the target is scrolled into view once (`block: "nearest"`, instant, so measurement never chases an animation and reduced motion needs no special case). |
| Still off-screen after that | Treated as **absent** — the card is placed where the person is, never where the anchor is. Covers closed drawers, collapsed groups, hidden columns. |
| Card placement | Clamped to the viewport on both axes using the card's **measured** height, so a longer sentence in another language cannot push the buttons off the bottom either. |
| Box-less anchors | The two wrappers are `inline-flex` — real boxes, real rings. |
| Queued writes | At most one progress write in flight; only the latest state is remembered while one is out. The server keeps the highest step it has seen and a terminal state is always last, so nothing meaningful is lost and completion lands promptly. |

### What the regression test now proves (`tests/e2e/h32-show-me-around.spec.ts`)

Desktop and 375 px; English and Arabic RTL; a pre-cutoff owner and a newcomer:

1. Sign in as a pre-cutoff owner: not greeted; every target attached to the DOM.
2. Start by hand from the account menu.
3. Step 1: title and "Step 1 of 7" from the catalogue, **card fully inside the viewport**, database `in_progress/0`.
4. Next through steps 2–7, asserting title, progress, in-viewport box, and the database step after **every** click.
5. Back once at step 3: step 2 shown; database stays at 2 (never backwards); Next returns to 3.
6. Done: dialog gone; database `completed/7` with `completed_at`; reload does not re-greet.
7. Restart from the menu: step 1 again; database `in_progress/0`, `completed_at` cleared; Escape → `skipped/0`.
8. Customer, job, invoice, quote, audit and membership counts for the organisation identical before and after.
9. Console error-free throughout.
10. Everything created is removed in `afterAll`.

Before the fix the walk failed at step 3 with the card outside the viewport;
after it, it passes.

### Two harness lessons

- Playwright's base config budgets 30 s per test — right for a smoke, wrong for a
  walk with two restarts and eight writes on a dev server that serves an org
  page in 6–16 s while compiling. The walk sets its own budget.
- Two workers against one dev server doubled every round-trip; the walk runs
  with one.

### Deployment of the third pass

| | |
| --- | --- |
| Fix commit | `841f441`, CI success |
| Merge | `8d89e96` (`--no-ff`; merge tree identical to the verified branch tree `634bb3e…`) |
| Live | www.idaraworks.com serves `8d89e96`, auto-deployed, flag bound |
| Signed-in e2e on the fixed code | 6/6: desktop and 375 px × English and Arabic RTL, plus the newcomer path |
| Flag-on smoke on the live commit | 25/25 |
| Business counts | unchanged: 41 orgs / 62 users / 51 customers / 78 invoices / 93 jobs / 670 audit rows |
| Harness residue | production 0 orgs / 0 users; test project 0 / 0 / 0 |
| Owner's own row | `skipped` / step 2 — left exactly as found; a manual "Show me around" restarts from step 1 |

What remains before H32 can be marked complete is the one thing no fixture can
stand in for: the owner walking all seven steps in production. Everything that
walk exercises has now been proven by a signed-in browser on the same code.


---

## Acceptance

2026-09-05 — the owner tested the complete live tour in production and
reported that all seven steps worked correctly. H32 is closed at 100%.

H30's five owner conditions remain open. H32 does not change the launch
recommendation, and no further phase has been started.
