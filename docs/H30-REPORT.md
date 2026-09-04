# H30 — Launch Hardening and Release Readiness: delivery report

**Recommendation: CONDITIONAL GO for a controlled pilot.**

Status: **shipped.** Production serves `5a63020`, healthy, smoke 13 of 13, zero
residue, business counts unchanged. H31 and H32 were not started.

The software is ready. Seven launch-blocking defects were found and fixed, one of
them a loaded gun pointed at every customer record in the database. What remains
is not code: five owner actions in `docs/H30-OWNER-CHECKLIST.md` §1 must close
before a pilot customer enters real data, and every one of them needs a
credential, a signature or a legal judgement that could not be supplied to this
session.

Do not read "conditional" as "nearly". The conditions are specific, listed, and
mostly short.

Mandate: owner direction, 2026-09-04 (overnight autonomous run).
Truth map: `docs/H30-TRUTH-MAP.md`. Owner actions: `docs/H30-OWNER-CHECKLIST.md`.
Privacy position: `docs/H30-PRIVACY-CHECKLIST.md`.

---

## 1. The seven defects

### LB-1 — the cleanup script would have deleted every customer

`tooling/scripts/s7-cleanup.ts` chose its victims by complement: every
organisation whose name and id were not in a two-entry hard-coded allow-list.
That is safe only while the database contains nothing but fixtures.

Measured against production, by a script kept in the repository so the claim is
reproducible rather than quoted (`tooling/scripts/h30-allowlist-check.ts`):

```
organisations in production:                    40
still matched by the old allow-list:             0
the old --apply would have deleted:             40
of those, organisations with a real login:       4
```

"Alpha Marine" and "TESTING" no longer exist. **The allow-list protected
nothing.** One `--apply` would have deleted every tenant in the database — the
four real ones included — along with their `user_profile` rows and their
`auth.users` logins, doing exactly what the code said.

The rule is now inverted and lives in `tooling/fixtures/evidence.ts`, which both
the destructive script and the read-only residue report import so they cannot
disagree: an organisation is deleted **only if it proves it is a fixture** — the
suite's own marker, or three independent kinds of evidence agreeing. Anything
unrecognised is kept. A dry run against production now reports 16 confirmed
fixtures and keeps 15 needs-review, 5 seeded demos and 4 live organisations.

Two further gates: the target project must be identified positively before
connecting, and production additionally demands
`--confirm=delete-fixtures-in-<ref>`; and `--apply` re-classifies **inside the
transaction**, so a tenant created between the dry run and the apply cannot be
swept up by an id list computed a moment earlier.

### LB-2 and LB-3 — the goods-receipt trap

`docs/H22-BLOCKER-PO002.md` recorded that Najolatech received 34 units across two
goods receipts and the stock ledger holds zero. H30 reproduced it, and found the
cause was three defects wearing one coat.

**There was no warehouse setup anywhere in the product.** The tables, row-level
security and column-scoped grants have existed since H22A; no module function and
no screen ever used them. An organisation whose receipt failed for want of a
receiving bin could not create one. Fixed by `src/modules/inventory/warehouses.ts`
and a screen at `/o/:orgId/stock/warehouses`. **No migration was needed** — the
grants already allowed every write.

**The advice was actively dangerous.** The banner said "check the warehouse setup
and receive again". There was no setup screen to check, and receiving again
creates a *second* receipt: posting is idempotent per receipt LINE, so a new
receipt has new ids, new keys, and books a delivery that never physically
happened. Najolatech followed that advice and ended with two receipts and no
stock. It is replaced by a guided remedy driven by the ledger's own state — what
is missing, a link to the screen that fixes it, and a button that replays *this*
receipt, with the duplication warning stated outright rather than implied.

**Creating a warehouse now offers its receiving bay in the same step, ticked by
default.** A warehouse with no receiving bin is the exact state that caused the
defect, and nobody chooses it deliberately.

### LB-4 — a stalled queue that reported itself healthy

The health check raised `alert` only on a dead letter. Production ran **3.2 days
with eleven unprocessed jobs, zero dead letters, and `alert: false`** — because
nothing had *failed*. Nothing had run at all: Inngest is unprovisioned, so no
worker collected the jobs, no attempt was made, and no attempt could exhaust its
retries. The single condition being watched was reachable only by a worker that
exists.

Staleness is now its own alarm at a deliberately generous hour. The underlying
cause — Inngest — needs an external account and is owner action **O-6**. It is
also why "LPO PDF pending render" is permanent rather than pending on every
approved purchase order in production.

### LB-5 — a receipt that posted 500 lines and claimed success

`postGoodsReceiptToStock` read its lines with a bare `limit 500` and nothing
checked whether the limit had been reached. A 501-line receipt posted 500 and
reported success, so the paperwork said the goods arrived and the ledger held
part of them. It now refuses rather than truncating.

### LB-7 — no item in production could become stock, ever

Found by the H30 production smoke, which expected to see PO-002 in the
unposted-receipts list and saw nothing. The diagnostic that explains it is kept
as `tooling/scripts/h30-po002-diagnose.ts` (read-only):

```
unit_of_measure rows in the whole production database: 0
items with no base unit:                              35
```

`resolveReceiptTarget` skips any line whose item has a null `base_unit_id`,
quietly, as "not an inventory item". So **every goods receipt in the production
database would have failed to post even with a perfectly configured warehouse**,
and the failure would have looked like a shrug rather than a problem. This is the
second cause of PO-002; `docs/H22-BLOCKER-PO002.md` named the missing warehouse
and the receive-again trap and stopped there.

Worse, the H30 remedy's own diagnostic initially excluded those lines as "not
stockable" — so the remedy built for PO-002 could never have shown PO-002.

Fixed in three places: readiness reports the count and names it after the
warehouse; the diagnostic counts blocked lines instead of hiding them, and the
purchase-order card says which lines cannot post and why; and `createUnit`
creates a unit and adopts it as the base unit for every stock item that has none,
in one statement, touching only items that are stockable and currently unset so
it can never overwrite a unit somebody chose.

The integration test then caught three defects in that fix that reading had not:
`unit_of_measure.name_ar` is NOT NULL (a user leaving the optional Arabic name
blank would have met a raw constraint violation), a unit code is capped at 16 not
24, and exactly one base unit per dimension is allowed — so inserting every unit
as a base worked once and failed for ever after.

### LB-6 — PDFs in the wrong language

`DocumentActions` carried no language on any link, and the document route
defaults to English. An Arabic-speaking user reading an Arabic invoice pressed
**Download PDF** and silently received an English document. The only Arabic route
was a separate link producing HTML, so **there was no path to an Arabic PDF at
all** from invoices, quotes or week plans.

Every link now carries the reader's language, and the alternate offers the other
one by name rather than hard-coding Arabic — which was useless to a reader
already in Arabic, since it silently reloaded the same document.

Two other PDF producers were checked and deliberately left alone: the revenue
report reads the locale from the request cookie, and Document Studio renders the
document's **own stored language**, which is right for an authored document. An
issued contract does not change language because of who opens it.

---

## 2. What was verified, and how

| Gate | Result |
| --- | --- |
| Format | clean |
| Lint (incl. boundary and tenancy rules) | clean, 0 errors |
| Typecheck | clean |
| Unit tests | **1,627 passed**, 108 files |
| Production build | compiled, the new route present in the output |
| Dependency audit | 545 packages, 0 advisories at or above `high` |
| Integration suite | green in CI against a fresh local stack, including tenant-bleed and migration-safety |
| **CI on the exact deployed commit `9842df2`** | **green, both jobs** (run 33851488732) |

### Tests added

- `tests/unit/fixture-evidence-law.test.ts` — 10 tests. The property that matters
  most is asserted by name: **an organisation the classifier does not recognise
  is kept, never deleted.**
- `tests/integration/h30-receipt-remedy.test.ts` — 14 tests against the isolated
  test project. The failure reproduced with the receipt surviving; readiness
  naming what is missing; the setup path fixing it; **three consecutive replays
  leaving quantities and movement counts unchanged**; Najolatech's two receipts
  totalling exactly 34 and not 54; service-only receipts never nagging;
  permission enforced in the module rather than by hiding a button; the 501-line
  refusal leaving nothing partial behind; and a valid warehouse id belonging to
  another organisation refused rather than written into.
- `tests/integration/h30-pagination-scale.test.ts` — 1,150 items walked with no
  gaps, no duplicates, ordered as the cursor promises, rows past 1,000 present,
  search reaching row 1,149, and the page size bounded against a caller asking
  for everything at once.
- `tests/unit/queue-staleness-law.test.ts` — pins the exact production state that
  went unnoticed.
- `tests/unit/document-link-language-law.test.ts` — scans every record PDF link
  in `src/app`. It found LB-6 and one further link before the scope was narrowed
  to the route that actually defaults to English.

### What the browser walk did and did not cover

The warehouse setup screen was exercised against the test project with the stock
flag on: English desktop, Arabic desktop, and Arabic at 375px.

The LB-7 units card was **not** photographed. It renders only when an
organisation has stock items lacking a base unit, and the UI fixture seeds a
unit, so in that fixture the card is correctly hidden. It is covered instead by
the build, by three integration tests over `createUnit` (including that adoption
never overwrites a unit somebody chose), and by the three-language copy parity
test — and it sits inside the page whose rendering was verified above. Said here
rather than left as an implied screenshot.

### Driven in a real browser

The new screen was exercised against the test project with the stock flag on:
English desktop, Arabic desktop, and Arabic at 375px. The readiness banner, the
warehouse card, the default-receiving badge and the promote button all render;
RTL mirrors the whole layout; mobile stacks with no horizontal scroll and 44px
targets. A 404 encountered on the way was a stale Turbopack dev cache, not a
product defect — it resolved after clearing `.next`.

---

## 3. Audited and deliberately unchanged

Recorded so nobody re-opens a settled question. Full list in truth map §A.8.

- **Server-side plan enforcement is real.** Both the seat limit and the
  active-work limit recount **inside the transaction** under a per-organisation
  advisory lock. Neither can be raced; neither depends on a hidden button.
- **No secret reaches the browser.** No client component references the
  service-role key, a database URL, or any non-`NEXT_PUBLIC` variable.
- **Every API route authenticates** except `/api/health` and `/api/ready`, which
  are rate-limited, cached, and expose nothing.
- **Every public token surface is rate-limited** per IP.
- **All 29 environment-verdict call sites read `.ok`.** The H29 boolean bug has
  not returned. Of 26 database scripts with no guard, `s7-cleanup.ts` was the
  only destructive one and is fixed.
- **The 1,000-row PostgREST ceiling does not apply** — reads go through a direct
  postgres connection. Now proved rather than assumed.

---

## 4. Production

| Step | Result |
| --- | --- |
| Migrations | **none.** H30 changed no file under `supabase/migrations/`; both deployments are code-only |
| First deployment | `9842df2` merged to `main` and served by production. `/api/health` reports it, and the queue probe now carries `stale: true` — LB-4's alarm working in production against the very stall that previously read as healthy |
| First smoke on `9842df2` | 8 of 9. **The failing check was the point**: it asserted PO-002 would appear in the unposted list, it did not, and diagnosing that found LB-7 |
| Final deployment | **`5a63020` live**, CI green on that exact commit (run 33854593203). It did not deploy itself — see truth map §A.10 — and was rebuilt with the Production environment by an explicitly authorised `vercel redeploy --target production` of the same commit. The preview was **not** promoted: every project variable is production-scoped, so a promoted preview would have run with no feature flags and no database credentials |
| Health after deployment | `ok: true`, db 100 ms, storage 97 ms. `queue.alert: true` — LB-4's alarm firing on the stall that previously reported itself healthy |
| Production smoke on the final build | **ALL 13 CHECKS PASSED**, `commit 5a63020` |
| Residue | **0**, proved directly by `tooling/scripts/h30-residue-check.ts`: no H30 organisation, no H30 user, and zero rows in every table H30's new write paths touch (warehouse, stock_location, unit_of_measure, stock_movement) |
| Business counts | identical before and after: 40 organisations, 61 users, 51 customers, 93 jobs, 78 invoices, 646 audit rows. The independent residue report tallies the same 40 organisations as at the start |

The smoke is narrow by design. H30 shipped no schema, so there was nothing to
verify structurally; what it checks instead is that the fixes reach the right
verdict about production's **real** rows — that no organisation with a real login
is deletable, that every deletable one carries recorded evidence, that a seeded
demo never is, that the queue's staleness is computed rather than assumed, and
that PO-002 is reported and left untouched.

---

## 5. The honest position on a pilot

**What is ready:** the software. The defects that would have hurt a pilot
customer are fixed and each fix is proved by a test that fails without it.

**What is not ready, and is not code:**

1. **Backups are unverified.** The restore drill has never been run. The
   procedure is complete and executable; running it needs the Supabase dashboard
   and a witness (**O-1**, **O-2**).
2. **No data-processing agreement exists** (**O-3**).
3. **The per-person erasure policy is undecided** — a legal choice with three
   very different engineering answers (**O-4**).
4. **Inngest is unprovisioned**, so background jobs never run (**O-6**).
5. **No billing provider is connected.** Nothing can be charged, which is correct
   for a pilot, and the customer must be told (**O-10**).

**What H30 deliberately did not do:** repair Najolatech's PO-002 stock. The
remedy is built, proved idempotent by test, and left as a button for the owner to
press, because posting 34 units into a live customer's ledger is a change to
genuine business data and that is not this session's call (**O-11**).

**Not started, as instructed:** H31 branded installable apps, H32 guided
onboarding. **Untouched, as instructed:** the H24 transition ambiguities,
historical accounting conversion, the H29 country and locale flags, H28 AI.

**No claim is made** that IdaraWorks holds any privacy, security, tax or labour
certification, or that any of the above satisfies a particular law. Those are
questions for a qualified adviser, and they are named as owner actions rather
than glossed.
