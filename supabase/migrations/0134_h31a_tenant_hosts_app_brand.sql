-- 0134_h31a — H31 Branded Company App Platform: the host registry and the
-- application identity that a manifest is built from.
--
-- Additive and backward-compatible. Nothing here changes an existing row, and
-- every organisation without these rows behaves exactly as it does today.
--
-- ── Two tables, and why they are two ─────────────────────────────────────────
-- `org_app_brand` is IDENTITY: what the installed application is called and
-- what it looks like. `tenant_host` is ADDRESSING: which hostnames reach this
-- organisation. They change for different reasons, at different rates, under
-- different risks — a logo swap is routine, a hostname change can hand a
-- customer's private workspace to a stranger — so they are not one table.
--
-- `public.org_branding` (0071) stays the canonical source for the LOGO and the
-- document identity. This migration does not copy it, move it, or rewrite any
-- issued document. `org_app_brand` references the same file pipeline and adds
-- only what a web app manifest needs and 0071 has no column for.

-- ── 1. Application identity ─────────────────────────────────────────────────
create table public.org_app_brand (
  org_id uuid primary key references public.org (id) on delete restrict,

  -- What the installed app is called. Both optional: absent means "fall back to
  -- the organisation name", which is always present.
  app_name text check (app_name is null or length(app_name) between 1 and 60),
  -- Home screens truncate hard. 12 characters is the practical ceiling before
  -- Android and iOS start eliding, so the limit is stated rather than discovered.
  app_short_name text check (app_short_name is null or length(app_short_name) between 1 and 12),
  app_description text check (app_description is null or length(app_description) <= 300),

  /*
   * The square source image icons are generated from.
   *
   * Separate from org_branding.logo_file_id on purpose: a logo is usually wide,
   * and squashing it into 512x512 produces the letterboxed mess that makes an
   * app look unfinished. When this is null the generator derives a mark from
   * the organisation's initials, which is a deliberate design, not a failure.
   */
  icon_file_id uuid references public.file (id) on delete restrict,

  -- Colours. The pattern is checked here so a malformed value cannot reach a
  -- manifest even if a caller bypasses the service.
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  background_color text check (background_color is null or background_color ~ '^#[0-9a-fA-F]{6}$'),

  -- Which language and direction the installed app opens in. Constrained to the
  -- shipped locale registry; `es` is accepted as data while its release flag
  -- stays off, so parity is kept without releasing Spanish.
  default_locale text check (default_locale is null or default_locale in ('en', 'ar', 'es')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_app_brand_id_org_uq unique (org_id)
);

alter table public.org_app_brand enable row level security;
create policy org_app_brand_tenant_isolation on public.org_app_brand
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.org_app_brand to app_user;
-- Column-scoped UPDATE: org_id is not in the list, so a row can never be moved
-- to another tenant by an application path.
grant update (app_name, app_short_name, app_description, icon_file_id,
              brand_color, background_color, default_locale, updated_at)
  on public.org_app_brand to app_user;

create trigger org_app_brand_touch_updated_at
  before update on public.org_app_brand
  for each row execute function app.set_updated_at();

-- ── 2. Host registry ────────────────────────────────────────────────────────
create table public.tenant_host (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,

  /*
   * The normalised host, lowercase and without a port. UNIQUE ACROSS THE WHOLE
   * PLATFORM — this single constraint is what makes two organisations claiming
   * one hostname impossible under concurrency, rather than merely unlikely.
   */
  host text not null check (host = lower(host) and length(host) between 3 and 253),

  kind text not null check (kind in ('subdomain', 'custom')),

  /*
   * Verification state. `pending` routes NOTHING and authorises NOTHING; only
   * `active` is ever consulted by the resolver, and even then the caller must
   * still prove membership.
   */
  status text not null default 'pending'
    check (status in ('pending', 'active', 'failed', 'released')),

  /* What was actually observed, so a claim of verification can be audited
   * rather than believed: the DNS answer, the provider's response, who acted. */
  verification_token text,
  verification_evidence jsonb,
  verified_at timestamptz,
  failed_reason text check (failed_reason is null or length(failed_reason) <= 300),

  /*
   * Takeover protection. A released host stays in this table with its old owner
   * recorded and cannot be claimed again until this moment passes. Without it,
   * a company that closes its account frees a hostname that browsers, bookmarks
   * and installed applications still point at.
   */
  released_at timestamptz,
  claimable_after timestamptz,

  created_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenant_host_id_org_uq unique (id, org_id)
);

-- One live claim per hostname. Partial, so a released row does not block the
-- same host being re-issued deliberately later.
create unique index tenant_host_active_uq
  on public.tenant_host (host)
  where status in ('pending', 'active');

-- The resolver's only read path.
create index tenant_host_lookup_idx on public.tenant_host (host, status);
create index tenant_host_org_idx on public.tenant_host (org_id, status);

alter table public.tenant_host enable row level security;
-- A tenant sees and creates only its own claims.
create policy tenant_host_tenant_isolation on public.tenant_host
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.tenant_host to app_user;
-- Deliberately NOT grantable by a tenant: status, verified_at, evidence. A
-- customer may request a host; only the platform may declare it verified.
grant update (failed_reason, updated_at) on public.tenant_host to app_user;

create trigger tenant_host_touch_updated_at
  before update on public.tenant_host
  for each row execute function app.set_updated_at();

-- ── 3. The verification writer, platform-only ───────────────────────────────
/*
 * Activation is a platform act, never a tenant one. Running as the definer with
 * an operator assertion means a customer cannot mark their own claim verified
 * even with full application access — which is the difference between a domain
 * system and a domain-shaped form.
 */
create or replace function app.tenant_host_set_status(
  p_host text,
  p_status text,
  p_evidence jsonb default null,
  p_failed_reason text default null
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_norm text := lower(trim(p_host));
begin
  perform app.assert_platform_operator();
  if p_status not in ('pending', 'active', 'failed', 'released') then
    raise exception 'unknown tenant_host status %', p_status;
  end if;

  update public.tenant_host
  set status = p_status,
      verification_evidence = coalesce(p_evidence, verification_evidence),
      failed_reason = case when p_status = 'failed' then p_failed_reason else null end,
      verified_at = case when p_status = 'active' then now() else verified_at end,
      released_at = case when p_status = 'released' then now() else released_at end,
      -- A released hostname is quarantined for 90 days. Long enough that
      -- bookmarks and installed apps have stopped pointing at it; short enough
      -- that a genuine re-issue is not blocked for ever.
      claimable_after = case when p_status = 'released' then now() + interval '90 days'
                             else claimable_after end,
      updated_at = now()
  where host = v_norm and status in ('pending', 'active', 'failed');

  if not found then
    raise exception 'no live tenant_host row for %', v_norm;
  end if;
end;
$$;

revoke all on function app.tenant_host_set_status(text, text, jsonb, text) from public;

comment on table public.tenant_host is
  'H31: hostnames that may reach an organisation. Selection, never authorisation — '
  'a resolved host still passes through the ordinary membership check.';
comment on table public.org_app_brand is
  'H31: installed-application identity. org_branding remains canonical for the '
  'logo and for document identity; nothing here rewrites an issued document.';
