-- 0014_events_outbox (S0 checklist §3 "events_outbox" + §7; BUILD_BIBLE §8.6-8.8)
-- The transactional outbox. Services write a domain_event row INSIDE the
-- mutation's transaction (atomic — no lost/phantom events, no network call in
-- the tx §8.8). A separate relay (post-commit) publishes unprocessed events to
-- Inngest and marks them processed (idempotent by event id). The bus is
-- TRANSPORT, not a record (Appendix B: purge processed > 90 days).
-- Rollback note: drop the table + relay functions; safe pre-data.

create table public.domain_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null,                    -- past-tense fact, e.g. 'file/uploaded'
  version int not null default 1,        -- payload schema version (§8.6)
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid references public.user_profile (id),
  occurred_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text,
  last_attempt_at timestamptz
);
-- The relay's hot query: the unprocessed queue, oldest first.
create index domain_event_unprocessed_idx
  on public.domain_event (occurred_at) where processed_at is null;
-- Retention purge scans processed rows by age.
create index domain_event_processed_idx
  on public.domain_event (processed_at) where processed_at is not null;

alter table public.domain_event enable row level security;
-- INSERT only for tenants: the bus is written by mutations, never read by them
-- (it is internal plumbing). Actor-bound + org-scoped. No SELECT/UPDATE/DELETE
-- policy or grant → a tenant session can neither read nor mutate the bus; the
-- relay reaches it exclusively through the platform-task definer functions below.
create policy domain_event_insert on public.domain_event
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())
  );
grant select, insert on public.domain_event to app_user;
-- SELECT grant is required for the INSERT ... (no returning here, but the emit
-- helper reads nothing back); revoke UPDATE/DELETE explicitly. The absence of a
-- SELECT *policy* means app_user still sees zero rows (RLS default-deny).
revoke update, delete on public.domain_event from app_user;

-- ── relay / retention: PLATFORM-TASK definer functions ───────────────────────
-- Guarded to run ONLY in a session with NO org context. A tenant request always
-- runs inside withCtx (org GUC set), so it can never invoke these — the relay
-- uses a dedicated no-context client (A-B5). This is the cross-org boundary.
create or replace function app.assert_platform_task()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if nullif(current_setting('app.org_id', true), '') is not null then
    raise exception 'platform task only: must run without an org context';
  end if;
end
$$;
revoke all on function app.assert_platform_task() from public;
grant execute on function app.assert_platform_task() to app_user;

-- Claim a batch: bump attempts, lock-skip so concurrent relays never double-take.
create or replace function app.claim_domain_events(p_limit int, p_max_attempts int)
returns table (id uuid, org_id uuid, name text, version int, payload jsonb, attempts int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    update public.domain_event e
    set attempts = e.attempts + 1, last_attempt_at = now()
    where e.id in (
      select e2.id from public.domain_event e2
      where e2.processed_at is null and e2.attempts < p_max_attempts
      order by e2.occurred_at
      for update skip locked
      limit greatest(0, p_limit)
    )
    returning e.id, e.org_id, e.name, e.version, e.payload, e.attempts;
end
$$;
revoke all on function app.claim_domain_events(int, int) from public;
grant execute on function app.claim_domain_events(int, int) to app_user;

create or replace function app.mark_domain_event_processed(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  update public.domain_event set processed_at = now(), last_error = null where id = p_id;
end
$$;
revoke all on function app.mark_domain_event_processed(uuid) from public;
grant execute on function app.mark_domain_event_processed(uuid) to app_user;

create or replace function app.record_domain_event_error(p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  update public.domain_event set last_error = left(p_error, 2000) where id = p_id;
end
$$;
revoke all on function app.record_domain_event_error(uuid, text) from public;
grant execute on function app.record_domain_event_error(uuid, text) to app_user;

-- Dead-lettered: exhausted attempts, still unprocessed → the relay alerts.
create or replace function app.dead_lettered_domain_events(p_max_attempts int, p_limit int)
returns table (id uuid, org_id uuid, name text, attempts int, last_error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select e.id, e.org_id, e.name, e.attempts, e.last_error
    from public.domain_event e
    where e.processed_at is null and e.attempts >= p_max_attempts
    order by e.occurred_at
    limit greatest(0, p_limit);
end
$$;
revoke all on function app.dead_lettered_domain_events(int, int) from public;
grant execute on function app.dead_lettered_domain_events(int, int) to app_user;

-- Retention (Appendix B): drop processed events older than the window.
create or replace function app.purge_processed_domain_events(p_older_than interval)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  perform app.assert_platform_task();
  with deleted as (
    delete from public.domain_event
    where processed_at is not null and processed_at < now() - p_older_than
    returning 1
  )
  select count(*) into v_count from deleted;
  return v_count;
end
$$;
revoke all on function app.purge_processed_domain_events(interval) from public;
grant execute on function app.purge_processed_domain_events(interval) to app_user;
