-- 0075_workspace_blueprint (H14 — Intelligent Clay workspace contract)
-- Blueprint revisions with an explicit lifecycle: draft -> validated ->
-- approved -> applied -> superseded, with rejected as a terminal branch.
-- One row per revision, append-only in spirit: content is mutable ONLY while
-- a revision is a draft/validated; approved and later content is frozen by
-- the guard trigger below, independently of the application layer.
--
-- NOTHING here grants anything: the blueprint is configuration INTENT.
-- Entitlements stay resolved from plan_entitlement/org_addon/overrides, and
-- permissions from the authz matrix. No existing organization gains or loses
-- behavior from this migration (no seeds; nothing reads the table yet).
--
-- SELECT is archetype-gated to owner/admin (the config_revision idiom, 0012):
-- blueprints ARE configuration history. INSERT/UPDATE follow the same gate;
-- the acting user must also be the attributed actor on insert.
-- No DELETE grant (D-1.7): history is never removed, only superseded.
--
-- Rollback note: drop triggers, then table; safe — nothing reads it in H14
-- and no existing behavior depends on it.

create table public.workspace_blueprint_revision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  revision_no integer not null check (revision_no >= 1),
  status text not null default 'draft' check (
    status in ('draft', 'validated', 'approved', 'applied', 'superseded', 'rejected')
  ),
  schema_version integer not null check (schema_version >= 1),
  blueprint jsonb not null,
  blueprint_hash text not null check (blueprint_hash ~ '^[0-9a-f]{64}$'),
  validation jsonb,
  compiled jsonb,
  compiler_version text check (compiler_version is null or length(compiler_version) <= 20),
  proposed_source text not null check (
    proposed_source in (
      'recommended_default', 'onboarding_answer', 'imported_configuration',
      'user_change', 'system_requirement', 'country_pack', 'undo'
    )
  ),
  proposed_reason text check (proposed_reason is null or length(proposed_reason) <= 1000),
  created_by uuid not null references public.user_profile (id),
  approved_by uuid references public.user_profile (id),
  approved_at timestamptz,
  approved_hash text check (approved_hash is null or approved_hash ~ '^[0-9a-f]{64}$'),
  rejected_by uuid references public.user_profile (id),
  rejected_at timestamptz,
  rejected_reason text check (rejected_reason is null or length(rejected_reason) <= 1000),
  applied_by uuid references public.user_profile (id),
  applied_at timestamptz,
  -- Deferrable: an undo supersedes the current applied revision pointing at
  -- the restoring revision BEFORE that row is inserted in the same tx.
  superseded_by uuid references public.workspace_blueprint_revision (id)
    deferrable initially deferred,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, revision_no)
);

-- Exactly one applied revision per organization.
create unique index workspace_blueprint_applied_uq
  on public.workspace_blueprint_revision (org_id) where status = 'applied';
create index workspace_blueprint_org_idx
  on public.workspace_blueprint_revision (org_id, revision_no desc);

alter table public.workspace_blueprint_revision enable row level security;

-- Owner/admin gate (the config_revision idiom): blueprints are configuration.
create policy workspace_blueprint_select on public.workspace_blueprint_revision
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.membership m
      join public.role_definition rd on rd.org_id = m.org_id and rd.key = m.role_key
      where m.org_id = workspace_blueprint_revision.org_id
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
        and rd.archetype in ('owner', 'admin')
    )
  );

create policy workspace_blueprint_insert on public.workspace_blueprint_revision
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select app.current_user_id())
    and exists (
      select 1 from public.membership m
      join public.role_definition rd on rd.org_id = m.org_id and rd.key = m.role_key
      where m.org_id = workspace_blueprint_revision.org_id
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
        and rd.archetype in ('owner', 'admin')
    )
  );

create policy workspace_blueprint_update on public.workspace_blueprint_revision
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.membership m
      join public.role_definition rd on rd.org_id = m.org_id and rd.key = m.role_key
      where m.org_id = workspace_blueprint_revision.org_id
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
        and rd.archetype in ('owner', 'admin')
    )
  )
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.workspace_blueprint_revision to app_user; -- NO DELETE (D-1.7)

create trigger workspace_blueprint_touch_updated_at
  before update on public.workspace_blueprint_revision
  for each row execute function app.set_updated_at();

-- Lifecycle immutability guard (H14 Part E/G): approved and applied content
-- is frozen at the DATABASE layer — a compromised or buggy app layer cannot
-- rewrite an approved revision's blueprint, and terminal states stay terminal.
create or replace function app.workspace_blueprint_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Terminal states: nothing changes any more, except an applied/approved
  -- revision being superseded (content identical).
  if old.status in ('superseded', 'rejected') then
    raise exception 'workspace blueprint revision is % and immutable', old.status;
  end if;

  -- Content is mutable ONLY while draft/validated.
  if old.status in ('approved', 'applied') then
    if new.blueprint::text is distinct from old.blueprint::text
       or new.blueprint_hash is distinct from old.blueprint_hash
       or new.schema_version is distinct from old.schema_version
       or new.revision_no is distinct from old.revision_no
       or new.created_by is distinct from old.created_by then
      raise exception 'approved/applied blueprint content is immutable';
    end if;
  end if;

  -- Legal transitions only.
  if old.status = 'approved' and new.status not in ('approved', 'applied', 'rejected', 'superseded') then
    raise exception 'illegal blueprint transition % -> %', old.status, new.status;
  end if;
  if old.status = 'applied' and new.status not in ('applied', 'superseded') then
    raise exception 'illegal blueprint transition % -> %', old.status, new.status;
  end if;
  if old.status in ('draft', 'validated') and new.status not in ('draft', 'validated', 'approved', 'rejected') then
    raise exception 'illegal blueprint transition % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

create trigger workspace_blueprint_guard
  before update on public.workspace_blueprint_revision
  for each row execute function app.workspace_blueprint_guard();
