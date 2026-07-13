-- 0044_s6_billing_rules (S6 — "Bill", part 4 of 4): the billing exception rules.
-- Widen the exception rule_key catalogue for the two money-loop rules (doc 04):
-- E-09 billing_point_uninvoiced (a reached billing milestone with no invoice within
-- the grace window) and E-10 overdue_invoice (past due, unpaid, aged). Both raise to
-- the accounts/owner audience via the existing S5 engine (materialized, dedup, calendar
-- aware). AR itself is a DB-side aggregate over invoice + payment computed in the
-- service (RLS-scoped, F-30) — no new table. Forward-only.

alter table public.exception drop constraint if exists exception_rule_key_check;
alter table public.exception
  add constraint exception_rule_key_check check (rule_key in (
    'missing_report', 'overdue_stage', 'approval_stuck', 'blocking_issue',
    'labour_outlier', 'quote_divergence', 'billing_point_reopened',
    'billing_point_uninvoiced', 'overdue_invoice'
  ));
