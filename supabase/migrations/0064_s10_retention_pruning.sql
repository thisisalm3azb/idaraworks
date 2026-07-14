-- 0064_s10_retention_pruning (S10 — doc 10 #36 / doc 01 Appendix B): monitored pruning for the
-- ephemeral, unbounded-growth tables. A PLATFORM job (assert_platform_task-guarded DEFINER, so it
-- can DELETE where app_user has no delete grant). Windows per Appendix B. Forward-only.
--
-- NEVER touched here (deliberately): audit_log (financial-mutation rows kept ≥6 years regardless of
-- tier — a hard VAT-record floor), activity (the tenant-visible history promise), domain_event
-- (already pruned 30–90d by the outbox relay). These are excluded by omission, not by predicate.
create or replace function app.prune_retention(p_now timestamptz default now())
returns table (
  notifications_pruned bigint, exceptions_pruned bigint, ai_interactions_pruned bigint, digests_pruned bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  n_notif bigint; n_exc bigint; n_ai bigint; n_dig bigint;
begin
  perform app.assert_platform_task();

  -- Notifications: read >90d OR any >12mo (a stale unread reminder is noise past a year).
  with d as (
    delete from public.notification
    where (read_at is not null and read_at < p_now - interval '90 days')
       or created_at < p_now - interval '12 months'
    returning 1
  ) select count(*) into n_notif from d;

  -- Exceptions: resolved (cleared) rows older than 24 months. OPEN exceptions are never pruned.
  with d as (
    delete from public.exception
    where resolved_at is not null and resolved_at < p_now - interval '24 months'
    returning 1
  ) select count(*) into n_exc from d;

  -- AI interaction ledger: metadata kept 12 months, then dropped.
  with d as (
    delete from public.ai_interaction
    where created_at < p_now - interval '12 months'
    returning 1
  ) select count(*) into n_ai from d;

  -- Digests: the full per-audience payload is kept 90 days (headline-only retention beyond that is
  -- deferred — dropping the row is the MVP truth; the source facts remain queryable live).
  with d as (
    delete from public.digest
    where digest_date < (p_now - interval '90 days')::date
    returning 1
  ) select count(*) into n_dig from d;

  return query select n_notif, n_exc, n_ai, n_dig;
end
$$;
revoke all on function app.prune_retention(timestamptz) from public;
grant execute on function app.prune_retention(timestamptz) to app_user;
