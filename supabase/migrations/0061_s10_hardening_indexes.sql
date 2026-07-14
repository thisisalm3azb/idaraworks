-- 0061_s10_hardening_indexes (S10 perf pass — audit F-29 / paging-index lens): three FK/hot-path
-- columns were declared as foreign keys but never indexed, so correlated lookups degrade O(N²) as
-- history accumulates. Postgres never auto-indexes the referencing side of an FK. Forward-only;
-- CREATE INDEX IF NOT EXISTS is idempotent and takes only a brief lock at MVP volume.

-- (1) invoice.corrects_invoice_id — every outstanding-balance path (computeAR, the nightly digest
-- AR aggregate, E-10 overdue-invoice raise + self-heal, reconcileInvoiceStatus) runs a correlated
-- `sum(credit notes where corrects_invoice_id = i.id)` per invoice row. Without this index each
-- outer row triggers a full invoice-table scan → quadratic on lifetime invoice count.
create index if not exists invoice_corrects_idx
  on public.invoice (org_id, corrects_invoice_id)
  where corrects_invoice_id is not null;

-- (2) goods_receipt_line.po_line_id — partial-receipt math sums received/damaged/rejected per PO
-- line across all of an org's GRN lines; this covers the FK and the aggregation.
create index if not exists goods_receipt_line_po_line_idx
  on public.goods_receipt_line (org_id, po_line_id);

-- (3) quote.converted_job_id — the C-10 accepted-quote lookup (getJobCosting quoted-money path)
-- filters quotes by their converted job; unindexed it scans the org's converted quotes each read.
create index if not exists quote_converted_job_idx
  on public.quote (org_id, converted_job_id)
  where converted_job_id is not null;
