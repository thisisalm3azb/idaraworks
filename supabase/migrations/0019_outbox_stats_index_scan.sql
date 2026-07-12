-- 0019_outbox_stats_index_scan (Phase I review fix — database CM).
--
-- 0018's single-pass aggregate used FILTER clauses over the WHOLE table, so
-- every /api/health call sequentially scanned public.domain_event — unbounded
-- growth on an unauthenticated endpoint. Rewrite as three subqueries whose
-- predicates all carry `processed_at is null`, matching 0014's partial index
-- domain_event_unprocessed_idx — each is an index(-only) scan over the small
-- unprocessed set, independent of total table size.
--
-- Also honest-names the age gauge (review minor): oldest_unprocessed_age_s
-- covers RETRYING events only (attempts < max); dead-lettered events are
-- unprocessed too but are alarmed separately via dead_lettered.
--
-- Same guard discipline as 0014/0018: SECURITY DEFINER + assert_platform_task;
-- signature unchanged. Rollback note: forward-only; replaces 0018's body only.

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
      (select count(*) from public.domain_event e
        where e.processed_at is null and e.attempts < p_max_attempts),
      coalesce((select extract(epoch from now() - min(e.occurred_at))::bigint
        from public.domain_event e
        where e.processed_at is null and e.attempts < p_max_attempts), 0),
      (select count(*) from public.domain_event e
        where e.processed_at is null and e.attempts >= p_max_attempts);
end
$$;
revoke all on function app.outbox_stats(int) from public;
grant execute on function app.outbox_stats(int) to app_user;
