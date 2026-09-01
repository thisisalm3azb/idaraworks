# H22 — Inventory, stock and assets

**Branch** `verify/h22`, merged to `main` · **Base** `3662569` · 21 commits
**Migrations** 0084–0092 (nine, ~3,500 lines of SQL) · **Tests** 284 H22 integration tests, 1,389 unit tests
**Production** DEPLOYED — 93 migrations, serving `70e2034`. Every existing business row unchanged, zero fixture residue.

---

## What H22 set out to build

A stock and asset system for a business that already had purchase orders, goods
receipts, jobs and daily reports, and no idea how much of anything it owned.

Nine slices, each with its own migration, its own tests and its own adversarial
audit:

| Slice | Migration | What it added |
| --- | --- | --- |
| H22A | 0084 | Units of measure, warehouses, stock locations, item tracking and lifecycle; bounded reads; master-data editing |
| H22B | 0085 | The immutable stock ledger, balances, concurrency control, cost layers (FIFO / weighted average / specific) |
| H22C | 0086 | Goods receipts into stock, consumption, reservations, transfers, stock counts |
| H22C.1 | 0087 | Foreign-currency purchasing, receipt disposition (accepted / damaged / rejected / quarantine), supplier returns, multi-location issuing |
| H22D | 0088–0090 | Lot and serial identity, expiry, bills of material, assembly and disassembly, and the corrections the audit found |
| H22E | 0091–0092 | The asset register: identity, custody, inspections, maintenance, downtime, disposal |
| H22F | — | The screens, the inbox, and the two joins that connected the whole chain |
| H22G | — | Verification, deployment pre-flight, cleanup, this report |

---

## The rules H22 held itself to

Recorded here because several of them changed decisions, not just wording.

**Nothing that records history can be deleted.** No `DELETE` grants on any new
business table. The stock ledger, custody events, inspections, maintenance and
disposal are append-only, enforced by triggers rather than by withheld grants —
RLS without `FORCE` does not bind the table owner and neither does a missing
grant, a lesson H22B learned and H22E had to learn again.

**Corrections are events, not edits.** A reversal is its own ledger line
pointing at what it undid. A custody correction is its own event pointing at the
event it fixes. Both stay visible, and the screens show them that way rather
than tidying them into a single "current" value.

**Money is not interchangeable.** Amounts are integer minor units with an
explicit currency; three of the supported currencies have three decimal places.
This produced one of the defects below.

**No depreciation.** H22E stores acquisition cost, residual value and useful
life because H24 will need them. It does not calculate a book value and the
asset screen says so out loud, because those three fields look exactly like the
inputs to a schedule that does not exist yet.

**No LIFO.** FIFO and weighted average for interchangeable stock; specific
identification preserved for serialised and non-interchangeable items.

**No worker.** Inngest is unprovisioned in production, so the `domain_event`
outbox never drains. Anything designed around a scheduled job would have been
code that never runs behind a screen reading "nothing needs attention". The
attention feed is therefore computed on read.

**Inventory stays hidden** until the whole system is functional and verified.

---

## H22F — making it visible, and connecting it

Everything before H22F was writable and almost entirely invisible. H22F is the
half a person can see, plus two joins that turned out to be missing entirely.

### The Download PDF path

Diagnosed first, before adding any more PDF buttons. In production the PDF
renderer could not start at all — the browser binary was never traced into the
serverless function — and both document routes answered *every* failure with
404 "not found". Anyone clicking Download PDF on their own invoice was told
their document did not exist.

The fix distinguishes a renderer that is down from a document that is missing:
a 503 that says the document is fine and links to the printable page, content
negotiated so a browser gets a page and a script gets JSON. The failing binary
was traced properly via `outputFileTracingIncludes`. The diagnosis came from the
build's own `.nft.json`, not from code that read plausibly.

### An inbox

"Do not build alerts with no visible inbox" had been broken since long before
H22. Approvals, seat invitations and subscription changes were all writing
notifications and nothing in the product ever displayed one. `listMyNotifications`
also had no `LIMIT` on a table that grows for the life of a membership.

The inbox has two halves, deliberately separate: **notifications**, which are
things that happened and were addressed to a person, and **needs attention**,
which is computed from the data on every load — stock below its reorder point,
batches near their date, services falling due, warranties ending.

### The screens

Stock levels; one item's stock with its batches, serials and full ledger; the
asset register; and one asset's whole life including custody, inspections,
maintenance, downtime and disposal. Every read bounded, keyset paged,
organization scoped and permission checked. Mobile-first cards rather than
tables, because these are read on a phone in a workshop.

### The two missing joins

The screens would have stayed empty forever, because the chain from a purchase
order to a stock balance was broken at both ends and each slice's tests only
ever looked at its own link:

1. **The purchase-order form was free text only.** `PoLineInput` has accepted an
   optional `itemId` since H22A and no screen ever sent one, so no order line in
   the product has ever referenced a catalogue item — and a receipt against a
   line with no item is not an inventory event.
2. **Nothing ever called `postGoodsReceiptToStock` or `postConsumptionToStock`.**
   H22C built both, tested both directly, and left the receiving desk and the
   report review — the actions people actually use — recording paperwork the
   warehouse never heard about.

Both are now connected: the order form offers the catalogue (and still takes
free text, because a business orders crane hire too), receiving books the
receipt into stock, and reviewing a daily report takes its material out.

Both postings happen **after** their document commits, never inside it. A goods
receipt records a physical fact — a lorry came and goods were unloaded — and a
review records a decision a person made. Neither may be lost because a warehouse
has no receiving bin or the ledger has no opening balance. A posting failure
keeps the document and says so on the page; posting is idempotent under an
advisory lock, so the remedy is to fix the setup and do it again.

### The release gate

`FEATURE_STOCK_SURFACES`, default **off everywhere including development**.

A release gate is not an entitlement. `feature` answers "has this organization
paid for it"; this answers "is it finished". Conflating them is how an
unverified screen reaches a customer with a price tag attached. With the flag
off: no menu entry, the routes answer 404, the inbox's attention half does not
render, and receiving and report review behave exactly as they did before H22.

`addon.inventory_stock` stays `availability: "deferred"` in the public
catalogue, which is what the pricing page tells the world.

---

## What the adversarial audits found

Every defect below produced a **plausible wrong answer** rather than an error.
That is why they survived to an audit: nothing failed, nothing logged, and the
screens looked right.

### H22D — eight findings, all of which came back incomplete on the second pass

The tracking constraint was added without updating every writer, so transfers,
stock counts, assembly output and disassembly output all threw at commit for
tracked items. Value was not conserved in four places from two causes: cost
layers held only a rate, and transfers credited the *charge* while debiting the
*layers* — different numbers under weighted average. The test that should have
caught it could not, because its fixture forced FIFO while the product default
is weighted average.

The second pass also found tests that could not detect the defect they named: an
"awkward divisor" that divided exactly, tracking tests satisfied by the
TypeScript pre-check so the database trigger was never exercised, sign-symmetric
transfer assertions that would pass with both values null, and a calendar-literal
expiry date that happened to be that day's date.

### H22E — seven findings

Append-only enforced only by a withheld grant (which does not bind the owner); a
withdrawn disposal that was a dead end; a discarded `decided` flag; validation
after the write, making the friendly error message unreachable; no lock and
unchecked updates in `completeDisposal`; cost returned to roles outside the cost
wall; and un-retiring an asset leaving a stale retirement reason behind.

### H22F — seven findings

- `listMovements` bound `""` as a `timestamptz` on any call without a cursor,
  because `"".split("|")` yields `[""]` and `?? null` never fires. This broke
  the **first page of every ledger view** — the one case the tests reached last.
- Stock value summed minor units **across currencies**. A cost layer records the
  currency the movement was priced in, which since H22C.1 may be the supplier's.
  The result looked exactly like money. It now withholds the total and says why.
- A warehouse-filtered page priced that warehouse's stock at the whole
  organization's value.
- Reservations rendered as "−0", because a reservation posts `qty_delta` 0 and a
  `reserved_delta`.
- Quantities printed as "10.000000".
- Expiry and overdue were decided from the server's UTC clock — up to four hours
  behind the Gulf business day this product is built for, so on the morning a
  batch expired the screen still called it good.
- The inbox would have announced the unreleased stock system to customers.

### Found by CI, not by a green local run

Two defects survived a green run against the hosted test database: a `NOT NULL`
column that broke a fixture only on a fresh database, and `receivingLocation`
using `limit 1` with no ordering, so a two-warehouse organization received into
an unpredictable bin — CI's fresh database chose differently and ten assertions
failed with "0 available".

### A test that caught its own bug

The vocabulary test reads `CHECK` constraints out of the live schema rather than
a hand-copied list, so a movement type added in a migration fails the build until
both catalogues can say it. On its first run its own regex matched `event`
inside `condition_at_event` and it demanded translations for five keys that
should never have existed.

---

## Deployment

### Pre-flight (read-only, run against production)

Seven of the nine migrations create new tables and columns, which cannot fail on
data nobody has written. Two backfill and then **constrain rows that already
exist**, and that is the one way H22 could abort a deploy over data it did not
create:

- 0087 sets `goods_receipt_line.accepted_qty` and then demands
  `accepted + damaged + rejected + quarantine = received` on every historical line.
- 0087 sets `purchase_order.currency` from the organization's base currency and
  makes it `NOT NULL`.

`tooling/scripts/h22-deploy-preflight.ts` asks production whether those can
succeed before anything is applied. **Result: clear on all four checks** — every
existing receipt line satisfies the disposition constraint, every order's
organization has a supported base currency, and no H22 table is present.

### Ordering

Migrations first, then code. The new `NOT NULL` columns are filled by `BEFORE
INSERT` triggers (`purchase_order_money_defaults`,
`goods_receipt_line_accepted_default`), so the currently-deployed code keeps
working unchanged against the new schema. The freeze trigger only rejects a
*change* to currency fields on a non-draft order, which old code never makes.

### Risk

Low, and deliberately so. The schema is additive, the backfills only fill new
columns, and every new surface is behind a flag that is off. A production
deployment of this branch changes nothing a customer can see.

Because the release gate is off, the usual ordering constraint relaxes: the new
code never queries an H22 table while the flag is off, so code and schema can go
out in either order without a broken window between them.

### Status: DEPLOYED AND VERIFIED

Applied on the owner's explicit authorization, after a 119-agent adversarial
audit of every statement in the nine migrations against production's own data.

| Check                              | Result                                             |
| ---------------------------------- | -------------------------------------------------- |
| Migrations applied                 | 84 → 93, none pending                              |
| Business rows, 28 tables           | every count identical                              |
| Tables without RLS                 | 0 of 129                                           |
| DELETE grants to `app_user`        | 1 — `org_holiday_calendar`, the permitted exception |
| Auth orphans                       | 13 / 103, unchanged (all historical)               |
| Deployed-surface smoke             | 18 / 18                                            |
| H22 end-to-end production fixture  | 29 / 29 assertions, zero residue                   |
| Download PDF, English and Arabic   | verified, three consecutive runs                   |

The audit found five real risks. Three were lock contention — the runner wraps
each migration in ONE transaction with no `lock_timeout`, so its lock footprint
is the union of every statement, held to the end; a blocked migration does not
fail, it queues, and a queued ACCESS EXCLUSIVE blocks every reader behind it.
Checked immediately before applying: no blockers, none idle in transaction.

The fourth was the disposition CHECK, verified clear against all 21 historical
receipt lines. The fifth was that `item_type` defaults every pre-existing
catalogue row to `inventory` with no backfill, which would silently make
services and labour lines look stock-movable — checked first, and all 34
production rows are physical goods, so the default is right for every one.

---

## Download PDF: three defects, each hiding the one behind it

H22F diagnosed this and fixed the wrong thing. Twice. It took making production
able to say what went wrong before the real cause appeared.

**One — a 404 that concealed everything.** Both document routes decided
"renderer broken" versus "document missing" by matching substrings of the error
message. The error production actually threw was not on the list, so the honest
503 fell through to 404 and a customer clicking Download PDF on their own quote
was told it did not exist. A substring list can only hold failures somebody
already imagined; the one that reaches production is the one nobody did. The
render is now WRAPPED and position decides: by the time a route is building a
PDF it has resolved the share and loaded the model, so the document provably
exists and anything failing from there is a rendering failure, whatever it says.
The lookup stays outside the wrapper, so another organization's record still
answers 404 and no tenancy probe learns anything.

**Two — a tracing key that matched no route.** `outputFileTracingIncludes` keys
are route GLOBS. `"/d/[token]"` matches nothing, and neither does
`"/d/[token]/route"` — only `"/d/**"` does. A key matching no route is not an
error: the build succeeds, the deploy succeeds, and the function ships without
the files it was told to carry. The same defect sat in the config twice more,
for `sharp`, inert since the day it was written — which is why the onboarding
logo upload it was added to fix kept failing on deploy. All five keys are now
the glob form, and `check-traced-payloads.ts` reads the build's own `.nft.json`
to assert each function really carries what it needs, because that file is the
only place the truth is written down.

**Three — a data file nothing imports.** With the browser binary finally in the
bundle, production still failed in under a second, and finally said why:

> Cannot find module `/var/task/node_modules/playwright-core/browsers.json`

playwright-core reads it at REQUIRE time, by path. Nothing imports it, so the
tracer never saw it — and the driver died before it ever went looking for the
browser. Which is exactly why tracing the 65 MB chromium payload changed
nothing: the code never got that far.

**And a fourth, found by fixing the first three.** The PDF then worked, failed,
and worked again within one verification run. A serverless instance is FROZEN
between requests and the Chromium it started does not survive — but the handle
still reports `isConnected()`, so the cached browser looks healthy until the
first thing that touches it throws. A cached browser now gets one chance to
prove it is alive; if it is not, it is discarded and the render runs again on a
fresh one.

What made the difference was making the failure legible. The share route now
answers `?diag=1` with the reason, to a caller who already holds the token — a
bearer secret for that one document — and both catch-alls log. A 404 that
records nothing is how this survived for months: its only trace was a customer
saying their document had gone.

---

## What still needs the owner

`FEATURE_STOCK_SURFACES` is not set in production, so the stock and asset
screens are absent from every menu and their routes answer 404 — the intended
state until the system has been exercised. Setting it is a Vercel environment
change, which needs an interactive login this session cannot perform.

The screens themselves were verified against the same code and schema on the
test project, with the flag on: stock levels, one item's ledger, the asset
register, one asset's life, and the inbox — in English and Arabic, at desktop
and at 375px. Arabic mirrors correctly with Latin numerals throughout, the
navigation reaches every page, and the reservation shows as "Promised, not
moved" rather than the "−0" the audit caught.

---

## What is deliberately not done

- **No depreciation.** H24 owns it. H22 stores the inputs and says so.
- **No historical reconciliation.** Existing receipts and material consumption
  are untouched. Turning them into opening balances needs a reviewed
  reconciliation that proves exactly how, and that is its own piece of work.
- **No asset write screens.** H22E's actions — assign, transfer, inspect,
  service, dispose — each need a considered form. The register is readable; a
  half-wired button that loses somebody's reason text is worse than no button.
- **No stock write screens beyond the two real paths.** Receiving and report
  review are how stock actually moves in this product. Manual adjustments,
  transfers and counts have module functions and no UI yet.
- **No valuation report.** Blocked on the same question the mixed-currency
  finding raises: there is no conversion policy yet, and a report that invents
  one is worse than no report. When it exists it will be labelled a cost report.
- **Inventory is not for sale.** `addon.inventory_stock` remains deferred.
