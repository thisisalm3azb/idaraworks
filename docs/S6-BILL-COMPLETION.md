# S6 — Bill — Completion Report

**Status:** COMPLETE · deployed `ee5eb7a` (prod `/api/health` confirms) · CI green · production baseline restored.
**Date:** 2026-07-13 · **Commits:** `5d8f4bd`, `dd07b5d`, `6f386ab`, `ee5eb7a`, `9f2cdc4` (last = tooling-only demo-cleanup fix).

## What shipped — the money loop (doc 01 L4)

quote → submit → **quote_send approval** → send → **accept-with-evidence → convert to job**
→ invoice → **issue (immutable, §4.7)** → **e-invoice adapter** → payment → **AR** → **credit note**.

- **Money discipline:** bigint minor units, VAT recorded **per line** (never assumed), `is_export` zero-rating, VAT-disabled org mode, multi-currency with the base amount **frozen at issuance** + an immutable `exchange_rate` (OP-8).
- **Immutable issued invoices** (draft-only line RLS); corrections are `credit_note` rows (`kind` + `corrects_invoice_id`), never a post-issuance cancel. Draft invoices may be voided pre-issuance.
- **E-invoice adapter seam** (`src/platform/einvoice`): provider-agnostic interface; a deterministic **FAKE** provider in S6 (clears a tax-registered domestic supply, rejects a domestic taxable supply with no buyer tax registration — the ZATCA reject path is contract-tested); **DISABLED in production** until a certified partner + credentials (D4/FR-16). The provider call never runs inside a DB transaction (§4.12).
- **AR** = a DB-side CTE aggregate: outstanding + aged buckets (current / 1–30 / 31–60 / 61–90 / over-90). Credit notes are attributed to the invoice they correct and folded into the same net that feeds the buckets, so **outstanding always equals the sum of its buckets** and never goes negative.
- **Exceptions:** E-09 `billing_point_uninvoiced` + E-10 `overdue_invoice` added to the nightly engine (raise + self-heal, calendar-aware, positive-net-balance predicate).
- **Today screens:** owner / accounts / procurement composers (invoices-to-issue, overdue receivables, AR summary, collections, payments-this-week, open POs). All money redacted when `!pricePrivileged`.
- **UI:** quotes / invoices / payments / AR pages — English + Arabic, RTL, 375px mobile-first; job noun via the `{job}` terminology variable (no hardcoded domain nouns).

## Migrations (hosted Seoul DB now at 0000–0044)

- `0041` quote (+ line) — transient `converting` claim state, org-scoped RLS, no DELETE grant.
- `0042` invoice (+ line, draft-only immutability), `einvoice_submission`.
- `0043` payment (+ receipt).
- `0044` exception `rule_key` widened for E-09/E-10.

## Adversarial review — 7 confirmed findings, all fixed + regression-covered

Independent 5-lens review (financial / tenancy / state-machine / events / i18n-ui), each finding
independently verified (0 uncertain):

| # | Defect | Fix | Regression |
|---|--------|-----|-----------|
| 1 | `computeAR` subtracted credit notes as an org-wide lump (outstanding ≠ buckets, could go negative) | per-invoice attribution folded into the bucket net | S6 integ #1 |
| 2 | `reconcile`/E-10 ignored credit notes → a fully-credited invoice stayed "issued" forever (perpetual critical overdue) | reconcile counts paid+credited → settles to `paid`; `createCreditNote` re-reconciles; E-10 net-balance predicate | S6 integ #2 |
| 3 | `submitEInvoice` had no `assertCan` → any member could submit e-invoices | split gated public `submitEInvoice(ctx, archetype, id)` vs trusted worker-only `submitEInvoiceInternal` | S6 integ #3 |
| 4 | approval sole-writer subject UPDATE had no pre-state guard → deciding a stale approval resurrected a voided payment | `SUBJECTS.live` guard + `RETURNING` no-op | S6 integ #4 (S4 still 37/37) |
| 5 | `acceptQuote` non-atomic → concurrent/retry accept left an orphan job | claim into transient `converting` before `createJobFromPreset`; release on failure | S6 integ #5 |
| 6 | `submitQuote`/`recordPayment` ignored `res.decided` → an auto-approve rule stranded the subject | advance the subject in-tx when decided (mirrors S4) | S6 integ #6 |
| 7 | AR page / `computeAR` rendered money with no `pricePrivileged` gate | `computeAR` returns null money when not privileged; AR page + Today cards redact | S6 unit (computeAR redaction) |

## Gates

format ✓ · lint 0 errors ✓ · typecheck ✓ · **unit 254/254** · build ✓ · **S6 hosted integration 19/19**
(full loop + immutability + E-09/E-10 + 6 review regressions) · **S4 integration 37/37** (approval-engine
change introduced no regression) · **bleed harness 2/2** (7 new tables seeded + isolated) · **full hosted
integration green** · **GitHub CI green** (local ephemeral Supabase) · deployed commit confirmed by prod health.

**Process note:** the full-integration wrapper reported exit 0 while vitest actually failed (exit 1). Reading
the test summary (not the exit code) caught a real bug — a speculative `quote_line`/`invoice_line` DELETE
grant that violated D-1.7 (no hard deletes), flagged by the tenancy harness and removed. The one remaining
full-run failure was a pre-existing events-outbox relay-timing flake (passes in isolation and in CI).

## Production DoD demo (Arabic, `tooling/scripts/s6-prod-demo.ts`)

org قوارب الفوترة: quote QT-001 5,775,000 → job 13S-001 (selling_price 5,775,000); invoice INV-001
2,100,000 issued + immutable; e-invoice **cleared**; AR 2,100,000 in the 31–60 bucket + E-10 raised;
**redaction wall HELD** (owner sees 2,100,000, non-privileged sees null); payment PMT-001 → invoice **paid**,
AR → 0, E-10 **self-healed**; credit note CN-001; all four outbox events present. Org deleted, **0 leftovers**.
Nine leftover `S6 Org` integration-test orgs were also removed; final production orgs = **Alpha Marine, TESTING
(both untouched, all S6 tables 0)**.

## Owner actions from S6 (documented, non-blocking — governed logic built, integration seam disabled)

- **E-invoice / ZATCA certified partner + credentials** — the adapter is disabled in production until then; no real government submission can occur without them.
- **Payment-provider credentials** — no real collection without them; the payment/AR/receipt logic is fully built and tested with fixtures.
- **Org pricing / tax / VAT-registration flag / thresholds** — org configuration (owner decides).
- **PB-3 accountant VAT sign-off** — ratifies which VAT base a pilot org uses (both are built + golden-tested).

Carried from earlier slices: Inngest Cloud keys, production PDF render runtime, Sentry DSN, Upstash,
password rotation, delete 4 junk Vercel projects.
