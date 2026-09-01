# H24 — Production transition report (READ-ONLY)

Generated 2026-09-02 by `tooling/scripts/h24-transition-report.ts` (every
statement a SELECT; production project `anhgeeutrwftsvuzfinf`, 39
organizations). **Nothing was converted, posted, or modified.** This report
proposes; it does not execute.

## 1. What historical money activity exists

| Source | Count | Value (minor, org base) | Date range |
| --- | --- | --- | --- |
| Invoices — issued | 5 | 5,575,925 | 2026-04-26 .. 2026-06-13 |
| Invoices — paid | 47 | 102,860,870 | 2023-09-10 .. 2026-08-07 |
| Invoices — partially paid | 21 | 54,061,225 | 2024-02-18 .. 2026-08-17 |
| Credit notes — issued | 5 | 2,003,630 | 2026-08-23 |
| Payments — confirmed | 63 | 129,667,908 | 2023-09-19 .. 2026-08-21 |
| Expenses | 51 | 18,710,600 (VAT 822,095) | 2026-01-24 .. 2026-08-24 |
| Goods receipts — recorded | 13 | 951,640 ex-VAT (accepted × PO cost) | 2026-02-02 .. 2026-09-01 |
| Stock movements | 0 | — | — |
| Pay runs | 0 | — | — |

The earliest financial event is an invoice dated **2023-09-10** (imported
history); activity is continuous through 2026-08.

## 2. Reconstructability classification

**Reconstructable mechanically (data complete):**

- All 78 invoices + 5 credit notes: totals, VAT amounts, customers, dates all
  present. 0 foreign-currency documents → **no missing exchange rates**.
- All 63 confirmed payments: amounts, dates, methods, invoice links present.
  0 foreign-currency payments.
- 46 of 51 expenses carry an explicit recorded VAT amount.

**Ambiguous (needs a human ruling before any conversion):**

1. **5 expenses with zero VAT recorded** — zero-rated, exempt, out of scope,
   or simply unrecorded? The tax engine refuses to guess (they would land as
   VAT-return exceptions), but converting them into official books without a
   ruling would bake the ambiguity in.
2. **13 recorded goods receipts with 0 stock movements** — the receipts exist
   but no inventory ledger ever moved (pre-H22 flow). Posting them now would
   assert an inventory asset that was never counted; not posting them means
   GRNI/AP opening balances must come from a human-confirmed statement, not
   from these documents.
3. **Invoices dated 2023–2025 pre-date any VAT profile** in the system; their
   VAT filing status with the FTA is outside what the database can prove.
4. **VAT filing history is unknown to the system** — which past periods were
   already filed via Tally/manually determines the earliest safe books-start
   date. This is a legally consequential fact only the owner can supply.

## 3. PO-002 — the named reconciliation exception (untouched)

The mandate described PO-002 as "34 ordered and 20 received". Production
today (read-only, Najolatech org):

- `GRN-001` — recorded 2026-09-01, accepted **20** (the state the mandate
  described)
- `GRN-002` — recorded 2026-09-01, accepted **14** (a second receipt already
  present in production before this report ran)

Both receipts exist with **zero stock movements and zero accounting entries**
(the ledger is not installed in production). Nothing was duplicated, repaired,
fabricated, or modified during H24. Disposition: PO-002 remains a **standing
reconciliation exception** — when (and only when) the owner authorizes a
conversion, its payable must come from a human-confirmed supplier statement,
never from re-deriving these receipts.

Five other organizations also have a `PO-002` reference (references are
per-org); all show ordered quantities with no recorded receipts — they are
demo/simulation orgs and carry no conversion obligation.

## 4. Proposed transition (NOT executed)

- **Proposed transition date:** first day of the month after the owner
  confirms filed-VAT history — realistically **2026-10-01**, giving September
  to close open items in the old records.
- **Proposed opening balances** (per organization, entered through the
  visible opening-balance journal, D7):
  - AR control: derived from open invoices (21 partially paid + 5 issued),
    verified against customer statements.
  - Bank/cash: from actual bank statements — the system has no bank balances
    to derive from, so these MUST be human-supplied.
  - GRNI/AP: from supplier statements (see §2.2 and §3).
  - VAT payable/receivable: from the last filed return's closing position —
    human-supplied (§2.4).
  - Equity offset: the opening-balance journal's visible
    `opening_balance_equity` line, never a hidden plug.
- Documents dated **on or after** the books-start date post through the
  normal rules; everything earlier stays historical reference (D7 — the
  posting rules already refuse pre-books documents).

## 5. Decision — STOP before converting history

The mandate's rule: *"If there is any ambiguity that could change official
books, complete and deploy the engine behind its feature gate but stop before
converting production history."*

Ambiguity exists (§2.1–§2.4). Therefore:

- ✅ The engine (migrations 0100–0106) deploys behind
  `FEATURE_FINANCE_SURFACES` (default **off**, strict `"1"`).
- ✅ This report stands as the read-only conversion plan.
- ⛔ **No production history is converted.** No opening balances are posted,
  no `config.finance` is written for any production organization, and no
  historical document is re-posted. Conversion happens only after the owner
  supplies the §2 rulings and §4 balances.
