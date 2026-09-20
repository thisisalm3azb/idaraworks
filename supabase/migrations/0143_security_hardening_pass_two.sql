-- 0143 — security hardening, pass two (review 2026-09-20, evening).
--
-- 1. A SHARED rate-limit store that needs no new vendor: one fixed-window
--    bucket per key in an unlogged table, driven by a SECURITY DEFINER function
--    the app role may execute. Every serverless instance and worker process
--    counts against the same budget (the per-process memory store bounded one
--    process only).
-- 2. Organisation guards on the three HR functions that took an org id as a
--    parameter without comparing it to the transaction's org (defence in
--    depth: they are only ever called under withCtx with ctx.orgId, so the
--    guard changes nothing for the application and refuses everything else).
--    Done by renaming the existing body and placing a guarded wrapper in front
--    of it, so the proven bodies are not copied.
-- 3. Privilege trims that are justified by the call graph: two operator-only
--    functions nothing in the application calls lose EXECUTE from app_user;
--    the add-on setter and the auth trigger function lose their PUBLIC grant.
-- 4. An idempotency key on expenses (payments and bank vouchers already have
--    one), so a retried or double-submitted expense form records ONE expense.

-- ── 1. shared rate-limit store ───────────────────────────────────────────────

create unlogged table if not exists app.rate_limit_bucket (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0)
);

comment on table app.rate_limit_bucket is
  'Fixed-window rate-limit counters shared by every app instance (0143). Unlogged: a crash empties it, which only resets budgets.';

create or replace function app.rate_limit_hit(
  p_key text, p_limit integer, p_window_seconds integer
) returns table (allowed boolean, remaining integer, retry_after integer)
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_hits integer;
  v_window interval;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
    raise exception 'rate_limit_hit: invalid key' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'rate_limit_hit: invalid rule' using errcode = '22023';
  end if;
  v_window := make_interval(secs => p_window_seconds);

  insert into app.rate_limit_bucket as b (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set hits = case when b.window_start + v_window <= v_now then 1 else b.hits + 1 end,
        window_start = case when b.window_start + v_window <= v_now then v_now else b.window_start end
  returning b.window_start, b.hits into v_start, v_hits;

  -- Opportunistic housekeeping: roughly one call in two hundred sweeps buckets
  -- whose window ended more than a day ago, so the table stays small without
  -- a scheduled job.
  if random() < 0.005 then
    delete from app.rate_limit_bucket where window_start < v_now - interval '1 day';
  end if;

  return query select
    v_hits <= p_limit,
    greatest(0, p_limit - v_hits),
    case when v_hits <= p_limit then 0
         else greatest(1, ceil(extract(epoch from (v_start + v_window - v_now)))::integer) end;
end;
$$;

revoke all on function app.rate_limit_hit(text, integer, integer) from public;
grant execute on function app.rate_limit_hit(text, integer, integer) to app_user;

-- ── 2. organisation guards on the HR functions ───────────────────────────────

alter function app.rollup_attendance_day(uuid, uuid, date)
  rename to rollup_attendance_day_unguarded;
alter function app.resolve_leave_days(uuid, uuid, uuid, text, date[])
  rename to resolve_leave_days_unguarded;
alter function app.revert_leave_days(uuid, uuid, uuid)
  rename to revert_leave_days_unguarded;

revoke all on function app.rollup_attendance_day_unguarded(uuid, uuid, date) from public, app_user;
revoke all on function app.resolve_leave_days_unguarded(uuid, uuid, uuid, text, date[]) from public, app_user;
revoke all on function app.revert_leave_days_unguarded(uuid, uuid, uuid) from public, app_user;

create or replace function app.assert_current_org(p_org uuid)
returns void
language plpgsql
stable
set search_path = pg_catalog, app
as $$
begin
  if p_org is null or p_org is distinct from app.current_org_id() then
    raise exception 'organisation mismatch' using errcode = '42501';
  end if;
end;
$$;

create or replace function app.rollup_attendance_day(
  p_org uuid, p_employee uuid, p_date date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  perform app.assert_current_org(p_org);
  perform app.rollup_attendance_day_unguarded(p_org, p_employee, p_date);
end;
$$;

create or replace function app.resolve_leave_days(
  p_org uuid, p_request uuid, p_employee uuid, p_status text, p_dates date[]
) returns void
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  perform app.assert_current_org(p_org);
  perform app.resolve_leave_days_unguarded(p_org, p_request, p_employee, p_status, p_dates);
end;
$$;

create or replace function app.revert_leave_days(
  p_org uuid, p_request uuid, p_employee uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, app
as $$
begin
  perform app.assert_current_org(p_org);
  return app.revert_leave_days_unguarded(p_org, p_request, p_employee);
end;
$$;

revoke all on function app.rollup_attendance_day(uuid, uuid, date) from public;
grant execute on function app.rollup_attendance_day(uuid, uuid, date) to app_user;
revoke all on function app.resolve_leave_days(uuid, uuid, uuid, text, date[]) from public;
grant execute on function app.resolve_leave_days(uuid, uuid, uuid, text, date[]) to app_user;
revoke all on function app.revert_leave_days(uuid, uuid, uuid) from public;
grant execute on function app.revert_leave_days(uuid, uuid, uuid) to app_user;

-- ── 3. privilege trims ───────────────────────────────────────────────────────

-- Operator-only, self-gated, and called by nothing in src/: the app role does
-- not need to be able to reach them at all.
revoke execute on function app.set_plan_price(uuid, text, text, character, bigint, boolean, text) from public, app_user;
revoke execute on function app.country_pack_upsert(text, text, text, text, text, date, date, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, app_user;

-- Called by the application (subscription service) as app_user; the default
-- PUBLIC grant is unnecessary.
revoke execute on function app.set_org_addon(uuid, text, integer, text, timestamp with time zone, text) from public;
grant execute on function app.set_org_addon(uuid, text, integer, text, timestamp with time zone, text) to app_user;

-- The auth.users trigger function fires under the auth service's role; a
-- trigger needs no EXECUTE grant to fire, and nothing else should call it.
revoke execute on function app.handle_new_auth_user() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function app.handle_new_auth_user() to supabase_auth_admin;
  end if;
end;
$$;

-- ── 4. expense idempotency ───────────────────────────────────────────────────

alter table public.expense
  add column if not exists idempotency_key text
    check (idempotency_key is null or length(idempotency_key) between 8 and 200);

create unique index if not exists expense_idempotency_uq
  on public.expense (org_id, idempotency_key) where idempotency_key is not null;
