# H32 — Simple Guided Onboarding: implementation report

**Status: shipped, flag on.** Merge commit `2ff35ad`, CI green on `826c5be`,
migration `0137_h32a_onboarding_state.sql` applied to production.

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

## Verification actually performed, and the one gate that was not

| Gate | Result |
| --- | --- |
| Unit (1702, incl. 20 new H32 laws) | green |
| Integration, real database (15 new) | green |
| Two-org bleed harness | green, teardown included |
| Typecheck / lint / format / build | green |
| CI on `826c5be` | success |
| Merge tree == verified branch tree | identical (`0f4d6a4…`) |
| Production migration | 1 file, additive, applied |
| Production smoke, flag OFF | 25/25 |
| Production smoke, flag ON | 25/25 |
| Signed-out production, desktop + 375px | no tour anchors, no tour dialog, no horizontal scroll |
| **Signed-in browser walk (EN/AR, desktop/375px, standalone)** | **NOT PERFORMED** |

### Why the signed-in walk was not performed

Three routes to an authenticated session were available in principle and none
was usable here:

1. **The user's own Chrome**, which carries existing sessions — the extension is
   not connected in this environment.
2. **A local stack** (`supabase start` + the founder-style e2e suite, which is
   the repo's sanctioned way to drive an authenticated UI) — Docker is not
   installed on this machine, so the local stack cannot start. CI does not run
   that suite either: it is gated behind `E2E_FOUNDER=1` and requires the
   integration stage's local stack, and the workflow sets neither.
3. **Signing in to production by hand** — this would mean entering a password
   into a live service, which I do not do.

So the tour's *visual* behaviour in a real browser — the spotlight anchoring, the
375px sheet placement, Arabic RTL, and installed-PWA standalone mode — rests on
the build, the unit law that every step's target is an attribute the source
actually emits, and code review. That is weaker than seeing it, and it is stated
here rather than glossed.

**This is the highest-value thing left to check.** Everything else about H32 has
been proven against a real database or a live deployment.

### How to run it in five minutes

Sign in to `https://www.idaraworks.com`, then:

1. Account menu (top right) → **"Show me around"**.
   This is the real restart path, and it works for an existing account — the
   automatic welcome deliberately will not fire for anyone who was already a
   member, which is the whole point of the eligibility rule.
2. Step through with **Next**; check the highlight lands on the control named in
   each step, and that the page behind stays clickable.
3. Press **Escape** mid-tour — it must close immediately.
4. Repeat at a phone width, and with the language switched to **العربية**.
5. Check the home page for the three-item **Getting started** list.

Anything wrong with the highlight positions is a change to one client file; the
copy is data and changes without a deployment of logic.
