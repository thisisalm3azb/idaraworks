# H24 evidence log — tax, accounting and interop research

_Rule: product decisions about tax and accounting cite current primary/official
sources. Each entry: source, jurisdiction, retrieval date, rule version, and
the exact product decision it supports. Verification tiers:
**verified-primary** (official text/guide read), **official-summary**
(official page, detail behind portal), **unverified** (secondary only — never
auto-applied)._

## UAE VAT (pack `AE-VAT-2026-09-01`)

1. **Standard rate 5%** — FTA VAT page (tax.gov.ae/en/taxes/vat.aspx),
   retrieved 2026-09-01. Tier: verified-primary (FTA's own calculator states
   5%). Decision: pack standard rate 5%.
2. **VAT201 return structure** — FTA "VAT Returns User Guide" (EmaraTax,
   English V4.0), PDF retrieved 2026-09-01 from tax.gov.ae; box structure
   corroborated by multiple practitioner sources. Tier: verified-primary
   (document retrieved; box map below encoded as the pack's reporting boxes).
   Boxes implemented: 1a–1g standard-rated supplies per emirate (Abu Dhabi,
   Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah); 2 tax
   refunds provided to tourists; 3 supplies subject to reverse charge; 4
   zero-rated supplies; 5 exempt supplies; 6 goods imported into the UAE; 7
   adjustments to goods imported; 8 totals; 9 standard-rated expenses
   (recoverable input); 10 supplies subject to reverse charge (input); 11
   totals; 12 due tax for the period; 13 recoverable tax for the period; 14
   payable/refundable. Decision: `reporting_box` values on tax codes and the
   VAT201 working report group by exactly these boxes.
3. **Filing deadline (28th of the month following the period; monthly or
   quarterly periods)** — FTA guide + official summaries, retrieved
   2026-09-01. Tier: official-summary. Decision: return-period model supports
   monthly/quarterly with due-date display; no filing claimed.
4. **Registration thresholds (AED 375,000 mandatory / 187,500 voluntary)** —
   official summaries (u.ae), retrieval 2026-09-01. Tier: official-summary.
   Decision: shown as guidance text in the VAT profile; never used to infer
   registration.
5. **Treatments** (standard, zero-rated, exempt, out-of-scope, reverse
   charge, designated zones) — Federal Decree-Law No. 8 of 2017 + Executive
   Regulation as referenced by FTA legislation page, retrieved 2026-09-01.
   Tier: official-summary (category existence verified; specific eligibility
   is ALWAYS an explicit user selection, never inferred). Decision: treatment
   enum + per-code recoverability; designated-zone handling is an explicit
   flag on the transaction, not an address inference.

## UAE Corporate Tax (pack `AE-CT-2026-09-01`)

6. **Federal Decree-Law No. 47 of 2022**, effective for financial years
   starting on/after 2023-06-01 — u.ae official page + FTA CT pages,
   retrieved 2026-09-01. Tier: verified-primary (rates and law identity).
   Decision: pack cites the law; workpaper starts from accounting income.
7. **Rates: 0% up to AED 375,000 taxable income; 9% above** — official
   sources, retrieved 2026-09-01. Tier: verified-primary. Decision: the ONLY
   auto-computed bracket math in the pack.
8. **Small Business Relief: revenue ≤ AED 3,000,000, periods ending on or
   before 2026-12-31** (Ministerial Decision 73 of 2023) — official
   summaries, retrieved 2026-09-01. Tier: official-summary. Decision: SBR is
   an explicit reviewed election input with the revenue test computed and
   shown; never auto-elected.
9. **Free-zone (QFZP) 0% on qualifying income** — official summaries,
   retrieved 2026-09-01. Tier: official-summary. Decision: free-zone status
   and qualifying-income amounts are explicit reviewed inputs; the pack never
   infers eligibility.
10. **Adjustment concepts** (non-deductible expenditure, 50% entertainment,
    related-party, interest limitation, loss carry-forward with 75% set-off
    cap) — practitioner-corroborated official summaries, retrieved
    2026-09-01. Tier: **unverified as to exact figures except the 50%
    entertainment and 75% loss set-off widely documented in MD/law
    summaries** → implemented as EXPLICIT INPUT LINES with rule references
    the reviewer confirms; no percentage is silently applied. Decision:
    workpaper adjustment rows carry source amount, rule key, legal source
    text, calculation, evidence and reviewer.

## Accounting foundations

11. **Double-entry, accrual, historical-cost + perpetual inventory (moving
    average per H22 costing)** — internationally accepted foundations; no
    IFRS/IFRS-for-SMEs compliance is claimed anywhere in the product.
    Decision: statement layouts are conventional (current/non-current,
    operating/investing/financing indirect cash flow) and labelled as
    management statements.

## Tally interop

12. **TallyPrime exports Masters (List of Accounts) and Vouchers (Day Book)
    as XML; report data as Excel/CSV/PDF/JSON** — official TallyHelp
    (help.tallysolutions.com "Export/Import Data — Masters and Vouchers",
    "How to Export Data in TallyPrime", "Sample XML"), retrieved 2026-09-01.
    Tier: verified-primary. Decision: importer targets the TALLYMESSAGE XML
    envelope for masters + vouchers, and generic CSV; supported-format
    statement names exactly these.
13. **TallyPrime feature surface** — official tallysolutions.com feature
    pages (invoicing-and-accounting, inventory-management, banking),
    retrieved 2026-09-01. Tier: verified-primary for parity classification
    only. Decision: H24-TALLY-PARITY matrix.

_No compliance claim (IFRS, VAT, corporate tax, WPS, statutory filing) is made
anywhere unless the shipped configuration genuinely meets the complete
requirement; prepared returns are working papers requiring professional
review._
