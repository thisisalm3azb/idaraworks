# Pilot Lab families — the contract

A family is one file in this directory exporting a `Family` (see `../types.ts`),
registered in `index.ts`. The orchestrator (`../run.ts`) provisions the
organisation and its nine personas, then runs families in dependency order,
checkpointing each one. A family must obey the following, every one of which is
either enforced by the database or checked after the seed.

## Non-negotiable

1. **Test project only.** Never open a connection; use `ctx.sql`, `ctx.insert`,
   `ctx.admin`. Never read `.env.local`.
2. **Every row carries `ctx.orgId`.** `ctx.insert` refuses rows without it.
3. **Deterministic ids.** Every primary key is `ctx.id(family, ordinal…)`. Never
   `randomUUID()`. Every random choice comes from `ctx.rng` (seeded per company).
   Run twice → identical rows → `ON CONFLICT DO NOTHING` → no duplicates.
4. **Batched writes.** Build arrays, call `ctx.insert(table, rows)` once per
   table (it chunks at 2,000). No per-row inserts for bulk data.
5. **Legal states only.** The database has triggers (see the trigger table in
   `docs/H33-TRUTH-MAP.md`). Where a state machine exists, EITHER drive the real
   domain service for a representative subset (`ctx.ctxFor("finance")` gives a
   tenant `Ctx`; call `withCtx`/service functions from `@/modules/*`), OR call
   the same database function the service calls (e.g. `app.post_journal_entry`).
   Never write `posted_at` / `finalized` / `issued_snapshot_id` by hand. Never
   use `session_replication_role = replica` in a family.
6. **Sources exist first.** A `stock_movement` cites a real
   `goods_receipt_line` / `report_material_line` / etc. Insert the source rows
   before the movements. Balances and cost layers must reconcile with movements
   (`reconcileStockBalances` is the referee).
7. **Money reconciles.** Line totals, VAT, document totals, payments and journal
   lines use the product's formulas (`tooling/simulation/money.ts`,
   `computeInvoiceTotals`, `computeQuoteTotals`). No rounding by hand. Every
   journal entry balances.
8. **No external effects.** No email, SMS, webhooks, AI, e-invoicing
   submission, payment providers. The test env has no keys, but do not try.
9. **Fake everything.** Names from the shared pools, `.invalid` emails,
   obviously fake phone numbers (`+971 50 000 0xxx`), fake TRNs
   (`100000000000003`-style with a fixed prefix `1999`), fake IBANs
   (`AE00 0000 …`). No real company, person, address, TRN, IBAN, plate or ID.
10. **Coherent history.** Dates spread across `company.history.from … asOf`
    with seasonality (`_shared.ts` → `spreadDates`). States mixed: current,
    completed, cancelled, overdue, rejected, draft. Long names and
    descriptions, Arabic and English content (`_shared.ts` pools).
11. **Dry-run honest.** `plan()` must return the expected row count per table
    from the same numbers `seed()` will use — the dry-run is the budget gate.
12. **Verify what you wrote.** `verify()` returns checks a person can read:
    counts match plan, totals reconcile, cross-links resolve, pagination
    thresholds met (`> 1205` where the company profile asks for it).
13. **Handoffs are small.** Pass ids other families need (warehouse ids,
    account ids, employee ids by persona) via `report.handoff`; never whole
    row arrays.

## Conventions

- File name = family key: `customers.ts` exports `customers: Family` with
  `key: "customers"`.
- `appliesTo(company)` reads `company.profile.enables.*`.
- Use `ctx.log` sparingly: one line per table written.
- Timestamps: `ctx.clock.tsAgo(days)` / `dayAgo(days)` (ISO strings).
- Volume: read `company.profile`; do not hard-code counts.
- Arabic: Saudi company (`saudimfg`) is Arabic-first; every company has some
  Arabic customers, items and documents.

## Personas that are employees

Families `people` creates an `employee` for `manager`, `hr`, `warehouse`,
`field`, `restricted` (and more) and records the employee ids in
`report.handoff.personaEmployees` — later families read them via
`ctx.handoff("people")`.
