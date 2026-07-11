-- 0000_setup_helpers
-- S0 checklist §3 migration 0000: extensions, app schema, GUC helper functions,
-- updated_at trigger, and the app_user role (LOGIN, NOBYPASSRLS).
-- Rollback note: destructive rollback = drop schema app cascade + drop role app_user
-- (only safe before 0001; after that, restore from backup — BUILD_BIBLE §4.14).

create extension if not exists pgcrypto;

create schema if not exists app;

-- GUC readers used by every RLS policy. STABLE + pinned search_path.
-- current_setting(..., true) returns NULL when unset -> policies deny by default.
create or replace function app.current_org_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.is_cost_privileged()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('app.cost_priv', true) = 'true', false)
$$;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- The application role. The app NEVER connects as postgres/service_role
-- (phase2/10 #1). Password is set by the migration runner from APP_DB_PASSWORD
-- (never stored in SQL). NOBYPASSRLS is asserted by the tenancy harness test.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login nobypassrls;
  end if;
end
$$;

grant usage on schema public to app_user;
grant usage on schema app to app_user;
grant execute on all functions in schema app to app_user;
alter default privileges in schema app grant execute on functions to app_user;

-- NOTE: app.migrations (runner tracking table) is created by the runner itself
-- and deliberately gets NO grants to app_user.
