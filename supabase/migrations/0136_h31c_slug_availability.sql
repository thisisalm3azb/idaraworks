-- 0136_h31c — asking whether a hostname is free, without being able to see who
-- has it.
--
-- ── The defect this fixes, found by the integration test ────────────────────
-- `checkSlug` read `public.tenant_host` through the tenant's own connection.
-- Row-level security scopes that to the caller's organisation, so a claim made
-- by ANOTHER company is invisible: the availability check told both tenants the
-- same name was free, and only the unique index stopped the second one — as a
-- raw constraint violation rather than a helpful message.
--
-- Availability is inherently a cross-tenant question, so it needs a
-- cross-tenant read. This is that read, and it is deliberately the narrowest
-- one that answers the question: a single boolean.
--
-- It returns TRUE for taken, quarantined-after-release, and for a host held by
-- the caller's own organisation — the caller is told "not available" and
-- nothing else. It cannot report WHO holds a name, when they claimed it, or
-- whether the company exists, so it cannot be used to enumerate customers.
--
-- Additive: one function, no table or grant changed.

create or replace function app.tenant_host_is_taken(p_host text, p_excluding_org uuid default null)
returns boolean
language sql
security definer
stable
set search_path = public, app
as $$
  select exists (
    select 1
    from public.tenant_host th
    where th.host = lower(trim(p_host))
      and (
        -- A live claim by anybody but the excluded organisation.
        (th.status in ('pending', 'active')
          and (p_excluding_org is null or th.org_id <> p_excluding_org))
        -- Or a released host still inside its takeover quarantine, whoever
        -- held it: re-issuing one early is exactly the risk that window exists
        -- to prevent.
        or (th.status = 'released'
          and (th.claimable_after is null or th.claimable_after > now()))
      )
  )
$$;

revoke all on function app.tenant_host_is_taken(text, uuid) from public;
grant execute on function app.tenant_host_is_taken(text, uuid) to app_user;

comment on function app.tenant_host_is_taken(text, uuid) is
  'H31: is this hostname unavailable? One boolean, deliberately. RLS makes a '
  'tenant-scoped availability check answer "free" for a name another company '
  'already holds, which is how two tenants race for one address.';
