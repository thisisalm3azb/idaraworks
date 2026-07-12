-- 0018_outbox_stats (Phase I — observability; BUILD_BIBLE §15.5, S0 checklist
-- §15 "Observability": /api/health checks DB/queue/storage).
--
-- The outbox is deliberately unreadable by tenant sessions (0014: no tenant
-- SELECT policy; 0016: default-deny), and the existing platform functions
-- (claim / mark / record / dead_lettered / purge) expose batches, not counts.
-- Health needs three queue gauges: unprocessed backlog, age of the oldest
-- unprocessed event, and the dead-letter count. Same guard discipline as every
-- 0014 function: SECURITY DEFINER + app.assert_platform_task() — only a
-- no-org-context platform session (A-B5 dedicated client) may call it.
--
-- Rollback note: forward-only; additive (one stable function); non-destructive.

create or replace function app.outbox_stats(p_max_attempts int)
returns table (unprocessed bigint, oldest_unprocessed_age_s bigint, dead_lettered bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select
      count(*) filter (where e.processed_at is null and e.attempts < p_max_attempts),
      coalesce(extract(epoch from now() - min(e.occurred_at) filter (
        where e.processed_at is null and e.attempts < p_max_attempts))::bigint, 0),
      count(*) filter (where e.processed_at is null and e.attempts >= p_max_attempts)
    from public.domain_event e;
end
$$;
revoke all on function app.outbox_stats(int) from public;
grant execute on function app.outbox_stats(int) to app_user;
