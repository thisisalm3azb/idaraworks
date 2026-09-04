-- 0135_h31b — the one read a browser may perform before signing in.
--
-- An installed application fetches its manifest and its icons BEFORE the user
-- authenticates: that is how a home-screen launch works, and refusing would
-- break the signed-out launch H31 must support. So there has to be exactly one
-- door through which a small, public-facing identity can be read without a
-- session, and it has to be narrow enough to describe in a sentence.
--
-- This is that door. It returns the same facts a company's own login page
-- already shows a stranger who has its link: a name, two colours, a language,
-- and whether an icon exists. It returns no member, no record, no count, no
-- address, no registration, and no indication of subscription or activity.
--
-- The argument is the organisation's UUID. Knowing one is not a secret in the
-- cryptographic sense, but it is unguessable, so this cannot be used to
-- enumerate customers — a caller must already have been given the id.
--
-- Additive: creates one function, changes no table and no existing grant.

create or replace function app.public_app_identity(p_org_id uuid)
returns table (
  org_name text,
  display_name text,
  app_name text,
  app_short_name text,
  app_description text,
  brand_color text,
  accent_color text,
  background_color text,
  default_locale text,
  first_language text,
  has_icon boolean
)
language sql
security definer
stable
set search_path = public, app
as $$
  select
    o.name,
    ob.display_name,
    b.app_name,
    b.app_short_name,
    b.app_description,
    b.brand_color,
    ob.accent_color,
    b.background_color,
    b.default_locale,
    o.languages[1],
    b.icon_file_id is not null
  from public.org o
  left join public.org_app_brand b on b.org_id = o.id
  left join public.org_branding ob on ob.org_id = o.id
  where o.id = p_org_id
$$;

-- The application role may call it; nobody else inherits it from PUBLIC.
revoke all on function app.public_app_identity(uuid) from public;
grant execute on function app.public_app_identity(uuid) to app_user;

comment on function app.public_app_identity(uuid) is
  'H31: the pre-authentication identity a manifest and icon are built from. '
  'Public-facing fields only; never membership, records or counts.';

-- ── The host resolver''s read ───────────────────────────────────────────────
-- Turning a hostname into a candidate organisation also happens before any
-- session exists, and for the same reason: the request arrived at a hostname
-- and something must decide which workspace it means. Only an ACTIVE row ever
-- resolves; a pending or failed claim returns nothing, so a claim can never
-- route traffic. Resolution is still only SELECTION — the caller proves
-- membership afterwards, exactly as it does for /o/<id> today.
create or replace function app.resolve_tenant_host(p_host text)
returns table (org_id uuid, kind text)
language sql
security definer
stable
set search_path = public, app
as $$
  select th.org_id, th.kind
  from public.tenant_host th
  where th.host = lower(trim(p_host))
    and th.status = 'active'
  limit 1
$$;

revoke all on function app.resolve_tenant_host(text) from public;
grant execute on function app.resolve_tenant_host(text) to app_user;

comment on function app.resolve_tenant_host(text) is
  'H31: hostname -> organisation, ACTIVE rows only. Selection, never '
  'authorisation; the caller still passes the ordinary membership check.';
