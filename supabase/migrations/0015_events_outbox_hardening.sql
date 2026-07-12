-- 0015_events_outbox_hardening
-- Phase G independent-review hardening (0014 already hosted-applied → forward-only).
--   m10/m7: tighten assert_platform_task — a real platform task has NEITHER an org
--           NOR a user context, so also require the user GUC to be null. This
--           narrows the boundary from "no org" to "no tenant context at all",
--           rejecting even the withUserCtx bootstrap context.
--   m3/m8:  domain_event needs no SELECT grant (emit has no RETURNING; the policy
--           uses scalar GUC functions) — revoke it. Tenant confidentiality then
--           rests on both the missing grant AND RLS default-deny.
--   m9/m12: lightweight integrity CHECKs on name/version (defense-in-depth over
--           the app-layer registry validation).
--   m11/m2: dead-lettered rows (unprocessed, attempts exhausted) were never
--           reaped or recoverable — add a redrive (reset attempts) and a bounded
--           dead-letter purge, and wire the purge into retention.
-- Rollback note: forward-only; re-create the 0014 forms. Non-destructive.

-- ── m10/m7: platform task = no org AND no user context ───────────────────────
create or replace function app.assert_platform_task()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if nullif(current_setting('app.org_id', true), '') is not null
     or nullif(current_setting('app.user_id', true), '') is not null then
    raise exception 'platform task only: must run without any tenant context';
  end if;
end
$$;

-- ── m3/m8: drop the unnecessary SELECT grant ─────────────────────────────────
revoke select on public.domain_event from app_user;

-- ── m9/m12: integrity CHECKs (app validates via the registry; this is the wall) ──
alter table public.domain_event
  add constraint domain_event_name_ck check (char_length(name) between 1 and 100),
  add constraint domain_event_version_ck check (version >= 1);

-- ── m11/m2: dead-letter recovery + bounded reaping ──────────────────────────
-- Redrive: reset exhausted-but-unprocessed events so they retry (ops recovery
-- after a fixed root cause; NOT auto-called — auto-redrive would loop poison events).
create or replace function app.redrive_dead_lettered_domain_events(p_max_attempts int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  perform app.assert_platform_task();
  update public.domain_event
    set attempts = 0, last_error = null
    where processed_at is null and attempts >= p_max_attempts;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function app.redrive_dead_lettered_domain_events(int) from public;
grant execute on function app.redrive_dead_lettered_domain_events(int) to app_user;

-- Bounded reaping: an event dead-lettered and untouched for the window is
-- abandoned (already alarmed) — drop it so it cannot linger forever.
create or replace function app.purge_dead_lettered_domain_events(p_max_attempts int, p_older_than interval)
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
    where processed_at is null and attempts >= p_max_attempts
      and occurred_at < now() - p_older_than
    returning 1
  )
  select count(*) into v_count from deleted;
  return v_count;
end
$$;
revoke all on function app.purge_dead_lettered_domain_events(int, interval) from public;
grant execute on function app.purge_dead_lettered_domain_events(int, interval) to app_user;
