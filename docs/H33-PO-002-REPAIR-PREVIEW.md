**NOTHING WAS APPLIED.** This is a read-only preview. No database was opened by the author of this document, no row was written, and PO-002 is exactly as it was.

# H33 — PO-002 repair preview (Najolatech, production)

Date: 2026-09-05. Branch `verify/h33`. Everything below was read from the repository on this branch and from the read-only production facts recorded in `docs/H33-TRUTH-MAP.md` (Part L/M). Where a fact could not be read it is marked **UNVERIFIED — owner action**.

The question this document answers: *if the owner approves the PO-002 repair, exactly what would change, what would not, and how would we know it went right?*

---

## 1. In one paragraph

Najolatech (a live customer) ordered 34 stainless screws on purchase order PO-002, recorded two deliveries (20, then 14) and the paperwork says the order is fully received. The owner has confirmed the first delivery; the second is inferred from production and needs the owner's confirmation before it is posted (§3, U-10). The stock ledger holds **zero** because the organisation has no warehouse, no receiving location and no unit of measure, so the stock booking failed both times while the delivery records were kept (by design). The repair has three parts: create one warehouse with a receiving bay, create a "pcs" unit and make it the base unit for Najolatech's stock items, then re-post the two existing deliveries. It would add exactly two ledger lines (+20 and +14 pieces at 0.10 each), two cost layers (2.00 and 1.40), and one balance row showing 34 on hand at an average of 0.10. It cannot double-count (proved by test and enforced by two unique indexes). It would not touch the purchase order, the delivery records, invoices, or any existing history. It is technically safe and **must not run without the owner's written approval**, because it changes a real customer's ledger.

---

## 2. What production holds today (read-only, from Part A)

### The purchase order

| Field | Value |
| --- | --- |
| Organisation | Najolatech (`cc2bd8d9…`, one real login) |
| Reference | PO-002 (`8d462039…`) |
| `purchase_order.status` | `received` |
| Lines | one |
| `purchase_order_line.item_name` | "screws ss316" — a real `inventory` catalogue item |
| `purchase_order_line.qty` / `unit` | 34 / `pcs` (free-text unit on the order line) |
| `purchase_order_line.unit_cost_minor` | 10 → **0.10 per piece** |
| Goods value | 34 × 0.10 = **3.40** (340 minor units) |
| `purchase_order.vat_minor` | 5 → 0.05 |
| `purchase_order.total_minor` | 345 → **3.45** (3.40 + 0.05) |
| Currency | **UNVERIFIED — owner action.** Expected to be Najolatech's base currency with `exchange_rate = 1` (migration 0087 sets both automatically when an order is created without a currency). Everything below assumes that. |
| `purchase_order.pdf_file_id` | **not read — UNVERIFIED — owner action (U-11).** Expected null, by inference: the LPO PDF is rendered by the `lpo-pdf-renderer` consumer of `purchase_order/approved`, the outbox relay never ran (Part L: all 11 events unprocessed, `attempts = 0`) and Inngest is unprovisioned, so "LPO PDF pending render" would be permanent. Separate issue either way, see `docs/H33-INNGEST-READINESS.md` |
| PO-001 | a `draft` for the same 34 screws — an abandoned first attempt; not part of this repair |

### The two deliveries (goods receipts)

| Receipt | `received_date` | `received_qty` | `previously_received` | `damaged_qty` | `rejected_qty` | `accepted_qty` (derived) | `status` | Stock movements |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GRN-001 | 2026-09-01 | 20 | 0 (inferred ¹) | 0 | 0 | **20** | `recorded` | **0** |
| GRN-002 | 2026-09-01 | 14 | 20 (inferred ¹) | 0 | 0 | **14** | `recorded` | **0** |

What was actually read (Part A / `docs/H33-TRUTH-MAP.md` Part M, and the H22 record): received 20 and 14, accepted 20 and 14, both `recorded`, none damaged or rejected, zero stock movements. Both receipts are ordinary, complete, and correct as records of a delivery. 20 + 14 = 34 = the order. `accepted_qty` is filled by the database trigger `goods_receipt_line_accepted_default` (migration 0087) as received − damaged − rejected − quarantine, so each line has exactly one "accepted" portion and no damaged or quarantine portion.

¹ `previously_received` was **not read — UNVERIFIED (U-11)**. The values are inferred from `recordGoodsReceipt` in `src/modules/supply/service.ts`, which writes the quantity already received on the PO line (`info.prev`, cumulative) into every new receipt line, and from the H22 record that GRN-001 was recorded first (09:15:22) and GRN-002 a minute later (09:16:22). The repair never reads this column; the poster books `accepted_qty`.

### The stock side

| Table (Najolatech rows) | Count |
| --- | --- |
| `warehouse` | 0 |
| `stock_location` | 0 |
| `unit_of_measure` | 0 |
| `stock_movement` | 0 |
| `stock_balance` | 0 |
| `stock_cost_layer` | 0 (follows from zero movements) |

---

## 3. Why the stock is zero — three missing things

The receiving action (`recordGrnAction` in `src/app/(app)/o/[orgId]/purchase-orders/actions.ts`) saves the receipt first and then calls `postGoodsReceiptToStock`. The posting failed and the receipt was deliberately kept. Three independent setup gaps each block posting:

1. **No warehouse.** `receivingLocation()` in `src/modules/inventory/operations.ts` looks for an active `stock_location` with `is_default_receiving = true` and `can_hold_stock = true` inside a warehouse. There is none, so it throws `no default receiving location — set one on a warehouse first`.
2. **No receiving location.** Same check; a warehouse alone is not enough — it needs a location flagged as the default receiving bay.
3. **No unit of measure.** `resolveReceiptTarget()` reads `item.base_unit_id`. It is null for the screws item (production had **zero** `unit_of_measure` rows anywhere when H30 looked). A line whose item has no base unit is refused with `this item has no base unit, so a received quantity cannot be recorded`. This was the second cause, found by H30 (LB-7); H22 had only found the first.

The H22 advice "receive again" made things worse rather than better: receiving again creates a **new** receipt with new line ids, so it does not replay the failed one — it books a second delivery that never happened, or fails identically. That is how Najolatech ended with two receipts. The two receipts are nonetheless treated as genuine, so **both** would be posted — but note what the owner has and has not said. `docs/H22-BLOCKER-PO002.md` records only that the owner reported receiving 20 and seeing no stock; the second receipt of 14, one minute later, was **inferred from production**, not attested by the owner. The repair would book those 14 into stock, so the owner must confirm that the second delivery physically arrived before approving (**UNVERIFIED — owner action, U-10**; the approval sentence in §11.1 says so explicitly). If the 14 were never delivered, GRN-002 must not be posted, and the repair becomes a different and smaller one.

---

## 4. The setup the repair would create — exact rows

All three writes go through `command()` (`src/platform/audit/command.ts`), so each is one transaction with its own audit row; if anything in it fails, nothing from it is written.

### 4.1 One warehouse — `createWarehouse()` in `src/modules/inventory/warehouses.ts`

Proposed values (the owner may choose different names; codes are upper-cased by the module):

| `public.warehouse` column | Value |
| --- | --- |
| `id` | new uuid |
| `org_id` | Najolatech |
| `code` | `MAIN` (proposed) |
| `name_en` | `Main Store` (proposed) |
| `name_ar` | null unless typed |
| `city` | null unless typed |
| `active` | true |
| `created_by` | the user who presses the button |
| `address_line`, `country`, `phone`, `email`, `manager_user_id` | null |

Refused if a warehouse with that code already exists (`stock.setup.duplicate_code`).

### 4.2 Its receiving bay — created in the same transaction when "Receives by default" is left ticked (the default)

| `public.stock_location` column | Value |
| --- | --- |
| `id` | new uuid |
| `org_id` | Najolatech |
| `warehouse_id` | the new warehouse |
| `parent_id` | null |
| `code` | `RECV` (fixed by the module) |
| `name_en` | `Receiving` (fixed by the module) |
| `name_ar` | null |
| `kind` | `receiving` |
| `can_hold_stock` | true |
| `is_default_receiving` | **true** |
| `is_default_issue` | false |
| `active` | true |

The unique index `stock_location_default_receiving_uq` allows at most one default receiving bay per warehouse.

### 4.3 One unit of measure — `createUnit()` in `src/modules/inventory/warehouses.ts`

| `public.unit_of_measure` column | Value |
| --- | --- |
| `id` | new uuid |
| `org_id` | Najolatech |
| `code` | `PCS` (typed as "pcs"; the module upper-cases and caps at 16 characters) |
| `name_en` | `Pieces` (proposed) |
| `name_ar` | whatever is typed; if left blank, a copy of `name_en` (the column is NOT NULL) |
| `dimension` | `count` |
| `factor_to_base` | 1 |
| `is_base` | **true** — Najolatech has no other active `count` unit, so this becomes the base (unique index `unit_of_measure_one_base_uq`) |
| `active` | true |

### 4.4 Adopting the unit — the same `createUnit()` transaction, when "Use this as the base unit for … item(s) that have none" is ticked

```sql
update public.item
set base_unit_id = <new PCS id>, updated_at = now()
where org_id = <Najolatech>
  and item_type in ('inventory', 'asset', 'kit', 'manufactured')
  and base_unit_id is null
```

This touches **every** Najolatech stock-type item that currently has no base unit — not only the screws. It never overwrites a unit somebody already chose (test: "adopting never overwrites a base unit somebody already chose"). **How many Najolatech items this is: UNVERIFIED — owner action.** The warehouses screen shows the exact count before the box is ticked (`stock.setup.apply_base_unit`: "Use this as the base unit for {count} item(s) that have none"), and `receivingReadiness()` reports it as `itemsWithoutBaseUnit`. Owner should read that number and be content with it before ticking.

Without step 4.3–4.4 the two receipts still cannot post: the "Add this delivery to stock" button would report the line as blocked ("1 line(s) cannot be added yet: their item has no base unit") and book nothing.

---

## 5. The ledger movements the repair would create — exact rows

`postGoodsReceiptToStock()` (`src/modules/inventory/operations.ts`) is run once per receipt. Each receipt has one line with one "accepted" portion, so each run creates **one** `stock_movement`, **one** `stock_cost_layer`, and creates-or-updates **one** `stock_balance` row. All writes for a receipt happen in one transaction (`command()`), so a receipt posts completely or not at all.

### 5.1 `public.stock_movement` — two rows

| Column | GRN-001 movement | GRN-002 movement |
| --- | --- | --- |
| `id` | new uuid (generated in code) | new uuid |
| `org_id` | Najolatech | Najolatech |
| `item_id` | screws ss316 | screws ss316 |
| `warehouse_id` | MAIN | MAIN |
| `location_id` | RECV | RECV |
| `movement_type` | `goods_receipt` | `goods_receipt` |
| `qty_delta` | **+20.000000** | **+14.000000** |
| `reserved_delta` | 0 | 0 |
| `unit_id` | PCS | PCS |
| `currency` | the PO's currency (UNVERIFIED; expected base currency) | same |
| `unit_cost_minor` | 10 (0.10) | 10 (0.10) |
| `exchange_rate` | 1 (expected) | 1 |
| `base_unit_cost_minor` | 10 = round(10 × 1) | 10 |
| `cost_total_minor` | **200** = round(10 × 20) → 2.00 | **140** = round(10 × 14) → 1.40 |
| `effective_at` | **now() at the moment of repair** (see §9.1) | same |
| `recorded_at` | now() | now() |
| `source_type` | `goods_receipt_line` | `goods_receipt_line` |
| `source_id` | GRN-001's line id | GRN-002's line id |
| `idempotency_key` | `grl:<GRN-001 line id>:accepted` | `grl:<GRN-002 line id>:accepted` |
| `reverses_movement_id`, `reason`, `note` | null | null |
| `actor_user_id` | the user who presses the button | same |

The item is not lot- or serial-tracked (default `tracking = 'none'`; **UNVERIFIED — owner action** to confirm on the item record), so no `stock_lot`, `stock_serial`, `stock_movement_lot` or `stock_movement_serial` rows are written.

### 5.2 `public.stock_cost_layer` — two rows (one per receipt movement)

| Column | Layer for GRN-001 | Layer for GRN-002 |
| --- | --- | --- |
| `org_id`, `item_id`, `warehouse_id` | Najolatech, screws, MAIN | same |
| `source_movement_id` | the GRN-001 movement | the GRN-002 movement |
| `qty_received` | 20 | 14 |
| `qty_remaining` | 20 | 14 |
| `unit_cost_minor` | 10 = round(200 / 20) | 10 = round(140 / 14) |
| `value_remaining_minor` | **200** (2.00) | **140** (1.40) |
| `currency` | the PO's currency | same |
| `original_unit_cost_minor` | 10 | 10 |
| `exchange_rate` | 1 | 1 |
| `received_at` | now() at repair | now() at repair |
| `lot_id`, `serial_id`, `depleted_at` | null | null |

### 5.3 `public.stock_balance` — one row, created on the first posting and updated on the second

| Column | After GRN-001 | After GRN-002 (final) |
| --- | --- | --- |
| key `(org_id, item_id, warehouse_id, location_id)` | Najolatech, screws, MAIN, RECV | same row |
| `on_hand` | 20 | **34** |
| `reserved` | 0 | 0 |
| `avg_unit_cost_minor` | 10 = round((0 + 200) / 20) | **10** = round((10 × 20 + 140) / 34) = round(340 / 34) |
| `last_movement_at` | now() | now() |

Cost method: Najolatech has no `inventory.policy` setting recorded (UNVERIFIED, but the code defaults to `weighted_average` when absent), and under weighted average the balance row's average is what a later issue would be charged. Layers are written regardless so the method can be changed later without losing history.

### 5.4 Before and after

| | Before (today) | After the repair |
| --- | --- | --- |
| Screws on hand (ledger, sum of `qty_delta`) | 0 | **34 PCS** at MAIN / RECV |
| Reserved | 0 | 0 |
| Available | 0 | 34 |
| Open cost layers | none | 2 (20 @ 0.10 = 2.00; 14 @ 0.10 = 1.40) |
| Stock value (sum of open layers) | 0.00 | **3.40** (340 minor) |
| Average unit cost | none | **0.10** |
| PO goods value for comparison | 3.40 | 3.40 — **the ledger matches the order exactly**; the 0.05 VAT is not stock value |
| `unpostedReceipts()` for PO-002 | 2 receipts, 0 of 1 lines posted each | none — the "Recorded, but not yet in stock" card disappears |
| `reconcileStockBalances(repair: false)` | nothing to check | expected `drift: []`, `valueDrift: []` |

---

## 6. Duplicate prevention — the evidence

Three independent guards, so a second press, a retry after a timeout, or two tabs racing cannot book the goods twice:

1. **The key is derived, not generated.** `grl:<receipt line id>:accepted` is computed from the receipt line's own id. A replay computes the same key, finds the movement already there, and posts nothing (`posted: false`). The check runs under `pg_advisory_xact_lock` on `<org>:<key>` so two concurrent posters serialise.
2. **Unique index `stock_movement_idempotency_uq (org_id, idempotency_key)`** — migration 0085. Even if the code check were bypassed, the database refuses a second row with the same key.
3. **Unique index `stock_movement_source_event_uq (org_id, source_type, source_id, movement_type, location_id) where source_id is not null`.** Migration 0085 created it without `location_id`; migration 0087 (§4, "One business event, several places") **dropped and recreated it with `location_id`**, so that one receipt line can legitimately post its accepted, damaged and quarantined portions into three different bins. It is therefore *not* "one `goods_receipt` movement per receipt line" — it is one per receipt line **per location**. For PO-002 each line has a single accepted portion going to RECV, so the index still refuses a same-line, same-location replay; a second movement for the same line into a *different* location is what guard 1 forbids, because the derived key names the disposition (`grl:<line id>:accepted`), not the bin.

And the ledger is **append-only**: triggers `stock_movement_no_update` and `stock_movement_no_delete` refuse UPDATE and DELETE for every role. If the repair were ever judged wrong, the correction is a *reversal movement* (`reverseMovement()`), which leaves the history visible. Nothing is ever silently rewritten.

Tests in `tests/integration/h30-receipt-remedy.test.ts` — **17 tests** on this branch (17 `it(` blocks, none skipped, none `.only`; `docs/H30-REPORT.md` says 14, which is stale). They run in CI against the isolated test project, never production. All 17, by name:

Duplicate prevention (the two that matter most here):

- **"replaying the SAME receipt posts it, and replaying again posts nothing further"** — three consecutive posts of one receipt: on-hand stays 20 and the movement count does not change.
- **"Najolatech's two receipts both post, and neither is counted twice"** — the exact PO-002 shape (20 then 14 as separate receipts): total is 34, and replaying both again leaves 34.

The failure and the setup that fixes it:

- "the receipt survives the posting failure — the lorry did arrive" — the failure mode that produced PO-002, reproduced.
- "an organisation with no warehouse cannot receive, and says exactly why" / "creating a warehouse makes the organisation able to receive, in one step".
- "an item with no base unit blocks its receipt, and the readiness says so" / "creating a unit adopts it for every stock item that has none, and unblocks them" / "adopting never overwrites a base unit somebody already chose".
- "lists receipts that were recorded but never reached the ledger" / "a receipt of only services is never reported as a problem" — the `unpostedReceipts()` card that the repair makes disappear.
- "does not silently post only the first 500 lines" — atomicity: a receipt posts whole or not at all (irrelevant to a one-line receipt but shows the transaction boundary).

Setup guards:

- "a duplicate warehouse code is refused with a key the UI can render" / "a location that cannot hold stock cannot become the receiving default" / "setting the receiving default moves it rather than creating a second one".
- "a role without inventory.adjust cannot create a warehouse" — permission enforced in the module, not by hiding a button.
- "a warehouse id from another organisation cannot be written into" / "listing warehouses never returns another organisation's" — tenant isolation of the new setup paths.

---

## 7. What the repair would NOT touch

| Record | Effect |
| --- | --- |
| `purchase_order` PO-002 | **unchanged** — status stays `received`, money columns are frozen by trigger `purchase_order_freeze_money`, `pdf_file_id` stays null (the LPO PDF is a separate Inngest matter) |
| `purchase_order_line` | **unchanged** |
| `goods_receipt` GRN-001 / GRN-002 | **unchanged** — status `recorded`, `received_date` 2026-09-01 |
| `goods_receipt_line` | **unchanged** — the poster only reads them; quantities stay 20 and 14 |
| PO-001 (draft) | untouched |
| Invoices, payments, supplier, customers, jobs | untouched — nothing in the three commands reads or writes them |
| Existing `audit_log` rows | untouched — the table is append-only; new rows are added (§8) |
| `domain_event` (the stalled outbox) | **no new rows** — none of `createWarehouse`, `createUnit`, `postGoodsReceiptToStock` declares `events`, so the repair adds nothing to the 11 stalled jobs |
| Email, PDFs, Inngest, AI | nothing sent, nothing rendered, nothing queued |
| Every other organisation | untouched — every statement is scoped to `org_id = <Najolatech>` and runs under row-level security |
| Schema / migrations | none — H30 shipped the remedy with no migration; the grants already allowed every write |

---

## 8. The audit rows the repair WOULD write

Every command writes one `public.audit_log` row **in the same transaction** as its change (columns: `org_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `summary`, `before_data`, `after_data`). No `activity` rows are written by these three commands.

| Step | `action` | `entity_type` | `entity_id` | `summary` (as the code composes it) |
| --- | --- | --- | --- | --- |
| Warehouse | `stock.warehouse_created` | `warehouse` | new warehouse id | `Created warehouse MAIN (Main Store) with a receiving bay` |
| Unit | `stock.unit_created` | `unit_of_measure` | new unit id | `Created unit PCS (Pieces), adopted as the base unit for N item(s)` |
| Post GRN-001 | `stock.receipt_posted` | `stock_movement` | null | `Booked goods receipt into stock (1 line(s))` |
| Post GRN-002 | `stock.receipt_posted` | `stock_movement` | null | `Booked goods receipt into stock (1 line(s))` |

`before_data` and `after_data` are null for all four. `actor_user_id` is the logged-in user. If an optional step is used (creating a separate location, moving the receiving default, renaming), it writes its own row (`stock.location_created`, `stock.default_receiving_set`, `stock.warehouse_renamed`).

A repeat press of "Add this delivery to stock" that posts nothing still writes an audit row saying `Booked goods receipt into stock (0 line(s))` — harmless, and honest.

---

## 9. Side effects the owner should know about before approving

### 9.1 The ledger will be dated the day of the repair, not the day of delivery

`postGoodsReceiptToStock` does not pass `effectiveAt`, so `stock_movement.effective_at` and `stock_cost_layer.received_at` will be **now()** when the button is pressed (on or after 2026-09-05), while the delivery records say 2026-09-01. Quantities and values are right; the *date* the stock appears in the ledger is the repair date. A stock report "as at 2026-09-03" would show zero screws, which is what the ledger genuinely held that day.

**[PROFESSIONAL REVIEW — accountant, UAE]** Whether a stock receipt recorded four days after delivery is acceptable for Najolatech's period-end stock valuation and VAT records is an accounting judgement for Najolatech's accountant, not a software decision. The system records what happened when it happened; it does not backdate.

### 9.2 The books, if Najolatech has finance set up

`postMovementIn` calls `postStockMovementIn` (`src/modules/finance/subledgers.ts`) for every valued movement:

- If Najolatech has **no** `config.finance` setting → skipped silently (`finance not set up`). No journal entries. **Whether Najolatech has finance set up: UNVERIFIED — owner action** (visible at Finance → Setup in the app).
- If it **does**, and the repair date is on or after the books start date → two journal entries of kind `inventory` are written in the same transaction, one per movement: **DR Inventory / CR Goods Received Not Invoiced**, 2.00 and 1.40, idempotent per source movement (`postFromSourceIn` returns `alreadyPosted` on a replay). These are additional rows in `journal_entry` / `journal_line`, and they consume two journal reference numbers.
- If finance is set up **but** the chart of accounts lacks the `inventory` or `grni` system account, `systemAccountIn` throws `the chart of accounts has no '…' system account — run finance setup first`, and the **whole receipt posting rolls back** (no movement, no layer, no balance, no audit row). The page would show "Still not added…". Nothing partial is left behind.

### 9.3 The unit adoption touches more than the screws

§4.4: every Najolatech stock-type item with no base unit gets `base_unit_id = PCS`. For items that are genuinely counted in pieces this is correct; for an item measured in metres or kilograms it would be wrong, and would have to be changed on the item record afterwards. Read the count on the warehouses screen first (**UNVERIFIED — owner action**).

### 9.4 The H30 production smoke keeps its verdict — PO-002 is not the only unposted receipt

`tooling/scripts/h30-prod-smoke.ts` asserts that at least one unposted receipt exists and that at least one line is blocked for want of a base unit ("receipts: unposted goods receipts are identifiable in production", "receipts: PO-002 is reported and left untouched", "receipts: LB-7 is visible…"). An earlier draft of this document treated "is PO-002 the only one?" as an open owner question. The repository answers it: the commit message of `5a63020` (the final H30 build, run against production on 2026-09-04) records **7 receipts recorded but not in the ledger** and **17 lines that cannot post until their item has a base unit**, and `docs/H30-REPORT.md` §1 LB-7 records **35 items with no base unit** across production and zero `unit_of_measure` rows in the whole database. PO-002 accounts for 2 of those 7 receipts and 2 of those 17 lines (one line per receipt). After the repair — unless other organisations' receipts have been posted since 2026-09-04 — **5 unposted receipts and 15 blocked lines remain**, so all three checks keep passing, with smaller numbers. The unit adoption in §4.4 is scoped to `org_id = <Najolatech>`, so it does not unblock the other organisations' lines either. The smoke needs no change for this repair. If those three checks ever do fail, the meaning is that every other unposted receipt in production has since been posted — update the smoke then, never the data.

### 9.5 Preconditions the button enforces

- `FEATURE_STOCK_SURFACES` must be on in production. It is **defined** there (H30 truth map §A.7), and the value must be exactly `"1"` — the value itself was never readable from this machine (**UNVERIFIED — owner action**; if the `/o/<org>/stock/warehouses` route answers 404, it is off).
- The logged-in user must hold `inventory.adjust` (roles `owner`, `admin`, `manager`) for the warehouse and unit steps, and `inventory.receive` (`owner`, `admin`, `manager`, `procurement`) for the posting step (`src/platform/authz/matrix.ts`). The module re-checks these itself; hiding a button is never the control.
- Najolatech's `org_plan_state.billing_state` must not be a read-only state (suspended / cancelled / purge_pending / purged), or `command()` refuses every step (**UNVERIFIED — owner action**; a live customer with a working login is very unlikely to be read-only).
- The session must satisfy MFA if the workspace requires it (`resolveCtxForAction`).

---

## 10. Is it safe?

**Technically: yes.**

- Every write is one transaction with its own audit row; a failure leaves nothing partial.
- Posting is idempotent by derived key, backed by two unique indexes; the exact PO-002 shape is a named test.
- The ledger is append-only; if the repair is later judged wrong, it is corrected by a visible reversal, never by deletion.
- It adds nothing to the stalled queue, sends no email, renders no PDF, and touches no other tenant.
- No migration, no deploy, no credential change is needed. The remedy code (`createWarehouse` / `createUnit` in `src/modules/inventory/warehouses.ts` and the "Add this delivery to stock" button) was written in `321ea95` and first served by production at `9842df2`, H30's first deployment (`docs/H30-REPORT.md` §4). The build live today is `5a63020`, the final H30 build, which changed only `tooling/scripts/h30-prod-smoke.ts` (`git show --stat`).

**Procedurally: it must not run without the owner's explicit approval**, because:

- It changes a **live customer's** stock ledger and possibly their books (§9.2). Since H22 every phase has been instructed to leave PO-002 alone (`docs/H22-BLOCKER-PO002.md`, H30 O-11), and this document does not change that instruction.
- It creates named records (a warehouse, a unit) the customer will see and live with, and re-bases N of their items (§9.3).
- The movements will carry the repair date, not the delivery date (§9.1).
- It is reversible only by a further, visible movement — there is no "undo".

**[LEGAL REVIEW — UAE]** Changing records inside a customer's workspace at the provider's initiative is a data-processing act. `docs/H30-PRIVACY-CHECKLIST.md` §7 lists what a pilot customer must be told and O-3 records that no data-processing agreement exists yet. Whether Najolatech's written say-so is required before the provider presses this button on their behalf — or whether Najolatech's own user should press it — is a question for a UAE-qualified adviser. The safest course, which needs no legal answer, is for **Najolatech's own login to perform the steps**, with the owner present.

---

## 11. The approval sentence, and exactly what would then be done

### 11.1 The sentence required (verbatim, in writing, from the owner)

> I approve applying the PO-002 stock repair to the Najolatech organisation in production (Supabase project `anhgeeutrwftsvuzfinf`) on [date]: create one warehouse with its default receiving bay, create the PCS base unit and adopt it for Najolatech's stock items that have none, and post goods receipts GRN-001 and GRN-002 to stock. I confirm that both deliveries — 20 pieces on GRN-001 and 14 pieces on GRN-002 — physically arrived at Najolatech. I have read `docs/H33-PO-002-REPAIR-PREVIEW.md`, I accept that the ledger will be dated the day of the repair, and I accept the journal entries in §9.2 if Najolatech has finance set up.

Anything short of that sentence — "go ahead", "looks fine", a thumbs-up — is **not** approval for this change. Nothing else in the H33 package depends on it; the repair can wait indefinitely.

### 11.2 The exact command

**There is no dedicated script.** `tooling/scripts/h30-po002-diagnose.ts` is read-only (it lists receipt lines and counts movements); `tooling/scripts/h30-prod-smoke.ts` reads PO-002 and writes only to a marked, disposable fixture organisation. H30 deliberately shipped the repair as a **button in the product** (owner checklist O-11: "left the button to you") so that it runs as an audited, permission-checked, tenant-scoped action by a real user rather than as an operator script with database credentials. That is the command:

**Route A — the product (built and tested for exactly this; recommended).** Logged in to https://www.idaraworks.com as a Najolatech member with the `owner`, `admin` or `manager` role:

1. Open `/o/<Najolatech org id>/stock/warehouses` ("Warehouses and locations"). Under **Add a warehouse**: Short code `MAIN`, Name `Main Store` (or the customer's own names), leave **Receives by default** ticked. Submit → "Warehouse created." Confirm the card shows the `RECV` location with the "Receives by default" badge.
2. On the same page, under **Add a unit**: Short code `pcs`, Name `Pieces` (Arabic name optional), tick **Use this as the base unit for N item(s) that have none** — read N first (§9.3). Submit → "Base unit set on N item(s)." The banner should now read "This workspace can receive goods into stock."
3. Open `/o/<Najolatech org id>/purchase-orders/<PO-002 id, 8d462039…>`. The card **Recorded, but not yet in stock** lists "Delivery GRN-001 of 2026-09-01 — 0 of 1 lines in stock" and the same for GRN-002. Press **Add this delivery to stock** on GRN-001 → "Added to stock." Press it on GRN-002 → "Added to stock." The card disappears once both are posted.

**Route B — the same service calls, if a script were ever written (none exists today).** Listed so the reader knows exactly what Route A executes; writing and reviewing such a script would itself need approval, and it would need a `ctx.userId` that is a Najolatech `user_profile` (the ledger's `actor_user_id` and the warehouse's `created_by` reference it).

```ts
import {
  createWarehouse, createUnit, postGoodsReceiptToStock, reconcileStockBalances,
} from "@/modules/inventory/service";

const ctx = { orgId: "<Najolatech>", userId: "<a Najolatech user_profile id>",
              costPrivileged: true, pricePrivileged: true, requestId: "po-002-repair" };

await createWarehouse(ctx, "owner", { code: "MAIN", nameEn: "Main Store", withReceivingBay: true });
await createUnit(ctx, "owner", { code: "pcs", nameEn: "Pieces", adoptAsBaseUnit: true });
await postGoodsReceiptToStock(ctx, "owner", "<GRN-001 id>");   // expect one result with posted: true
await postGoodsReceiptToStock(ctx, "owner", "<GRN-002 id>");   // expect one result with posted: true
await reconcileStockBalances(ctx, "owner", { repair: false }); // expect drift: [], valueDrift: []
```

### 11.3 Verification afterwards (all read-only)

1. On the PO-002 page: the "Recorded, but not yet in stock" card is gone; the status badge still says `received`.
2. Stock screens: 34 PCS of screws ss316 at MAIN / RECV; two `goods_receipt` movements of +20 and +14; value 3.40.
3. `pnpm tsx tooling/scripts/h30-po002-diagnose.ts` (read-only, needs production `DIRECT_URL`): both Najolatech lines show `movements=1`, `base_unit_missing=false`.
4. `reconcileStockBalances` with repair **off**: zero drift.
5. Audit log for Najolatech: the four rows in §8, and nothing else new.
6. `public.domain_event`: still 11 rows — the repair added none.
7. `h30-prod-smoke.ts` (reads PO-002; writes only to its own marked, disposable fixture): the three "receipts:" checks still pass, with the reported counts down by two each — 7 → 5 receipts and 17 → 15 blocked lines on the 2026-09-04 figures (§9.4). If they fail instead, every other unposted receipt has been posted in the meantime; update the smoke, never the data.

---

## 12. Everything marked UNVERIFIED, in one list (owner actions)

| # | Item | How the owner checks it |
| --- | --- | --- |
| U-1 | PO-002's `currency` and `exchange_rate` (expected: base currency, rate 1) | PO-002 page, or the Supabase dashboard |
| U-2 | The screws item is `item_type = inventory` with `tracking = none` | the item record |
| U-3 | How many Najolatech stock items have no base unit (N in §4.4) | the count shown beside "Use this as the base unit…" on the warehouses screen |
| U-4 | Whether Najolatech has finance set up (`config.finance`), and if so whether the `inventory` and `grni` system accounts exist | Finance → Setup in the app |
| U-5 | Najolatech's `billing_state` is not read-only | the workspace subscription page |
| U-6 | `FEATURE_STOCK_SURFACES` is `"1"` in production (it is defined; the value was not readable) | the warehouses route answers, rather than 404 |
| U-7 | The Najolatech login's role is `owner`, `admin` or `manager` | Settings → Members |
| U-8 | *Resolved from the repository — no longer an owner action.* Whether other unposted receipts exist: **yes** — 7 receipts / 17 blocked lines on 2026-09-04 (commit message of `5a63020`; `docs/H30-REPORT.md` §1 LB-7). Kept in the list only so the numbering above stays stable (§9.4) | nothing to do; `h30-po002-diagnose.ts` or the smoke would merely show today's count |
| U-9 | Najolatech's `inventory.policy` (expected absent → weighted average) | Stock settings |
| U-10 | That the **second delivery (14 pieces, GRN-002) physically arrived** — the owner has attested only the first 20 (§3) | the owner's own knowledge; stated in the approval sentence in §11.1 |
| U-11 | `goods_receipt_line.previously_received` (expected 0 and 20) and `purchase_order.pdf_file_id` (expected null) — inferred from code and from the H22 record, not read (§2) | PO-002 page or the Supabase dashboard; neither value changes the repair |

With one exception, none of these change what the repair does to PO-002; they decide whether it can run (U-5, U-6, U-7), what it touches beyond the screws (U-3, U-4), and how the money is labelled (U-1). The exception is U-10: if the 14 pieces were not delivered, GRN-002 must not be posted.

---

## 13. Sources read for this document

`docs/H22-BLOCKER-PO002.md` · `docs/H30-REPORT.md` (§1 LB-2/3/5/7, §4, §5) · `docs/H30-OWNER-CHECKLIST.md` (O-11) · `docs/H30-TRUTH-MAP.md` (§A.7, §A.9) · `docs/H33-TRUTH-MAP.md` (Part L/M) · `src/modules/inventory/warehouses.ts` · `src/modules/inventory/operations.ts` (`resolveReceiptTarget`, `postGoodsReceiptToStock`, `receivingLocation`) · `src/modules/inventory/ledger.ts` (`inventoryPolicy`, `postMovementIn`) · `src/modules/inventory/reconcile.ts` · `src/modules/inventory/service.ts` · `src/modules/finance/subledgers.ts` (`stockGlMap`, `postStockMovementIn`) · `src/modules/finance/ledger.ts` (`systemAccountIn`, `postFromSourceIn`) · `src/modules/finance/chart.ts` (`financeConfigIn`) · `src/platform/audit/command.ts` · `src/platform/authz/matrix.ts` · `src/platform/i18n/messages/en.json` · `src/app/(app)/o/[orgId]/purchase-orders/actions.ts` and `[id]/page.tsx` · `src/app/(app)/o/[orgId]/stock/warehouses/actions.ts` · `supabase/migrations/0035_s4_supply.sql`, `0084_h22a_inventory_foundation.sql`, `0085_h22b_stock_ledger.sql`, `0087_h22c1_currency_disposition.sql`, `0090_h22d_tracking_corrections.sql` · `tests/integration/h30-receipt-remedy.test.ts` · `tooling/scripts/h30-po002-diagnose.ts` · `tooling/scripts/h30-prod-smoke.ts` · `package.json` · git history on this branch (`git log` / `git show --stat` of `321ea95`, `9842df2`, `5a63020`).

No database connection was opened, no script was run, no environment file was read, and no vendor documentation was needed for this preview.

---

**NOTHING WAS APPLIED.** PO-002, GRN-001, GRN-002 and Najolatech's stock tables are exactly as Part A found them. This document describes a repair; it does not perform one, and no one should perform it without the sentence in §11.1.
