# H22 PRE-LAUNCH BLOCKER — Najolatech PO-002 receipt never became stock

**Status: OPEN, deliberately deferred by the owner. Do not repair during H23.**

Recorded 2026-09-01 from a read-only production inspection. Nothing in this
record was modified. H23 must not touch PO-002, must not re-receive the goods,
must not create another receipt for them, and must not silently repair this.

## What production holds (read-only, 2026-09-01 09:16 UTC)

Organization **Najolatech** (`cc2bd8d9…` — a live organization, one real login):

| Record | Facts |
| --- | --- |
| PO-001 | draft, "screws ss316" ×34 — apparently an abandoned first attempt |
| PO-002 (`8d462039…`) | status `received`, one line: "screws ss316" ×34, a real `inventory` catalogue item |
| GRN-001 (09:15:22) | received 20, accepted 20, **stock movements: 0** |
| GRN-002 (09:16:22) | received 14, accepted 14, **stock movements: 0** |

The owner reported receiving 20 and seeing no stock. Production shows they then
received the remaining 14 as a second receipt one minute later — so the PO is
fully received on paper (20 + 14 = 34) and **zero units exist in the stock
ledger**. Any later correction must post BOTH receipts, not just the first.

## Root cause 1 — no warehouse to receive into

Najolatech has **0 warehouses and 0 stock locations**. The receiving action
records the receipt first, then posts it to stock; `receivingLocation` found no
default receiving bin and threw. This is the designed non-destructive failure:
the receipt (a record of a physical delivery) is preserved, stock is not
booked, and the page shows the `po.grn_not_stocked` warning banner telling the
user to check the warehouse setup and receive again.

Two product gaps made the designed behaviour a trap in practice:

1. **Nothing guided the user to create a warehouse.** H22F shipped no warehouse
   setup screen — warehouses exist only as schema plus module functions, so the
   banner's advice ("check the warehouse setup") pointed at a page that does
   not exist.
2. **"Receive again" re-posts idempotently only for the SAME receipt.** The
   user instead received the remaining quantity as a NEW receipt, which is a
   different document; it failed the same way.

## Root cause 2 — "LPO PDF pending render" is permanent, not pending

The string is `po.pdf_pending`, shown while `purchase_order.pdf_file_id` is
null. The LPO PDF is produced by the Inngest worker
`src/workers/functions/lpo-pdf.ts`, triggered by `PURCHASE_ORDER_APPROVED` —
and **Inngest is unprovisioned in production**, so the worker never runs and
the message never resolves. This predates H22 and affects every approved PO in
production, not only PO-002.

## The later correction (owner-scheduled, NOT part of H23)

1. Create a warehouse and a default receiving stock location for Najolatech
   (through a real setup screen, which H22 still owes).
2. Re-run `postGoodsReceiptToStock` for **both** GRN-001 and GRN-002. Posting
   is idempotent under an advisory lock, so this cannot double-book; expected
   result is exactly 34 on hand at the new receiving bin, valued at the PO's
   order cost.
3. Verify PO-002's stock level shows 34 and the ledger shows two receipt
   movements (20 and 14), then reconcile (`reconcileStockBalances`, repair off)
   and expect zero drift.
4. Separately decide the LPO PDF path: either provision Inngest, or move LPO
   rendering to the on-request document route family (the pattern that now
   provably works in production for quotes). Until then the pending message is
   honest about neither.

## Guardrails H23 must respect

- No writes to Najolatech's purchase orders, receipts, items or stock.
- H23's migrations must not alter `goods_receipt*`, `stock_*` or
  `purchase_order*` semantics.
- H23's smokes must not use the Najolatech organization.
