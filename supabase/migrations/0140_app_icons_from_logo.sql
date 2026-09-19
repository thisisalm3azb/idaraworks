-- 0140 — the installed company app carries the company's own logo (item 10).
--
-- WHY (owner, 2026-09-20): the app icon was always a generated initials mark,
-- never the uploaded logo. The icon route serves anonymous requests (a home
-- screen draws its icon before anyone signs in) and must not read private
-- storage, so the derived icons are produced when the logo is uploaded and
-- kept in the database, where a narrow DEFINER read hands out exactly one
-- PNG for one organisation and one size.
--
-- WHAT:
--   * public.org_app_icon — the rendered PNGs (5 sizes × any/maskable) plus the
--     512px source the icons are re-derived from when brand colours change.
--     Tenant-scoped, RLS, no DELETE grant (rows are overwritten).
--   * app.public_app_icon(org, size, maskable) — the anonymous read.
--
-- Rollback note: drop function app.public_app_icon; drop table public.org_app_icon.

create table public.org_app_icon (
  org_id uuid not null references public.org (id) on delete restrict,
  -- 0 = the 512px source logo; otherwise the rendered icon edge.
  size int not null check (size in (0, 32, 180, 192, 512)),
  maskable boolean not null default false,
  png bytea not null,
  bytes int not null check (bytes > 0 and bytes <= 1048576),
  updated_at timestamptz not null default now(),
  primary key (org_id, size, maskable)
);

alter table public.org_app_icon enable row level security;
create policy org_app_icon_tenant_isolation on public.org_app_icon
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert, update on public.org_app_icon to app_user;

create or replace function app.public_app_icon(p_org_id uuid, p_size int, p_maskable boolean)
returns table (png bytea, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.png, i.updated_at
  from public.org_app_icon i
  where i.org_id = p_org_id and i.size = p_size and i.maskable = p_maskable and i.size > 0
  limit 1;
$$;

revoke all on function app.public_app_icon(uuid, int, boolean) from public;
grant execute on function app.public_app_icon(uuid, int, boolean) to app_user;
