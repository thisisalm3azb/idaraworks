-- 0045_s7_exception_rules (S7 — "Improve", part 1): widen the exception rule_key
-- catalogue for the four remaining MVP rules (doc 04): E-05 margin_drift (a job whose
-- cost outruns its progress-adjusted quote — critical, owner/accounts), E-06 late_supplier
-- (a PO past its expected date without receipt, and the aggregate "supplier late >= 3x in
-- 90 days" — warning, procurement/owner), E-08 unusual_expense (an expense above N x the
-- category's trailing median on that job — warning, accounts/owner), E-13 document_expiry
-- (an employee ID/passport/visa expiring within the window — warning, admin/owner, reads
-- employee_hr expiries reserved in 0020). All raise through the existing S5 engine
-- (materialized, dedup partial-unique, calendar-aware). Forward-only.

alter table public.exception drop constraint if exists exception_rule_key_check;
alter table public.exception
  add constraint exception_rule_key_check check (rule_key in (
    'missing_report', 'overdue_stage', 'approval_stuck', 'blocking_issue',
    'labour_outlier', 'quote_divergence', 'billing_point_reopened',
    'billing_point_uninvoiced', 'overdue_invoice',
    -- S7:
    'margin_drift', 'late_po', 'late_supplier', 'unusual_expense', 'document_expiry'
  ));

-- E-06 aggregate + E-13 attach to a supplier / employee rather than a job; the exception
-- table already carries subject_type/subject_id (nullable job_id), so no column change is
-- needed. These indexes keep the nightly DB-side aggregates (F-30) cheap.
create index if not exists exception_org_subject_idx
  on public.exception (org_id, subject_type, subject_id) where resolved_at is null;
