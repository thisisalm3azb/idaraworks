-- 0063_s10_concurrency_guards (S10 concurrency lens): DB backstops for two double-submit races the
-- audit confirmed. Forward-only. IF NOT EXISTS / guarded so re-run is a no-op.

-- ── (1) One live 'always' approval rule per (org, subject_type) ──────────────────────────────────
-- The only ambiguity guard was app-level (assertRuleSetUnambiguous re-reads active rules inside the
-- insert tx), but under READ COMMITTED two concurrent applyOnboarding runs each see only their own
-- uncommitted insert, so both can create an 'always' rule for the same subject. Two active 'always'
-- rules then make EVERY future createApprovalRule on that subject throw (the pair already violates
-- the check) and resolveRule pick nondeterministically — a permanent, in-app-unrecoverable wedge.
-- This partial unique makes the DB reject the second insert (23505 → RuleValidationError in code).
create unique index if not exists approval_rule_one_always_per_subject
  on public.approval_rule (org_id, subject_type)
  where condition_kind = 'always' and active;

-- ── (2) Payment idempotency ─────────────────────────────────────────────────────────────────────
-- recordPayment had no idempotency key: a double-tapped Record Payment (slow network, two devices)
-- minted two 'recorded' payments that both immediately count toward the invoice / AR. Add an
-- optional client-generated key + a partial unique so a retry with the same key collapses to one
-- (mirrors daily_report's exactly-once pattern). NULL key = legacy/unspecified (no constraint).
alter table public.payment
  add column if not exists idempotency_key text
    check (idempotency_key is null or length(idempotency_key) between 8 and 200);
create unique index if not exists payment_idempotency_uq
  on public.payment (org_id, idempotency_key)
  where idempotency_key is not null;

-- ── (3) onboarding_session: a transient 'applying' claim state ──────────────────────────────────
-- applyOnboarding gated re-apply on a plain read then did all its work (template install + N config
-- revisions + M rule seeds) before flipping to 'applied' — so two concurrent applies both passed the
-- read and both ran the full pipeline (duplicate revisions; the rule race above). Add an 'applying'
-- status so the service can atomically claim the session (proposed → applying) before doing work.
-- Drop the existing inline status CHECK by discovered name, then re-add including 'applying'.
-- Drop ANY existing status-enum CHECK (the inline one normalises to `status = ANY (ARRAY[...])`,
-- so match on the unique 'dismissed' literal, not on 'in'), then re-add including 'applying'.
-- Idempotent: the loop also drops a prior run's onboarding_session_status_ck before re-adding.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.onboarding_session'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%dismissed%'
  loop
    execute format('alter table public.onboarding_session drop constraint %I', c);
  end loop;
end $$;
alter table public.onboarding_session
  add constraint onboarding_session_status_ck
  check (status in ('draft', 'proposed', 'applying', 'applied', 'dismissed'));
