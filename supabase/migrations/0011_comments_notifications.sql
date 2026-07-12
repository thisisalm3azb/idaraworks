-- 0011_comments_notifications (S0 checklist §3 "comments_notifications", renumbered)
-- comment (polymorphic operational narrative), notification (recipient-scoped),
-- notification_preference (per-user channel prefs — audit F-12). Doc 01 L1.
-- The entities comments/notifications point at land in later slices; these are
-- the org-scoped substrate + RLS, exercised now by the bleed/isolation tests.
-- Rollback note: drop the three tables; safe pre-data.

-- ── comment ───────────────────────────────────────────────────────────────────
-- Polymorphic: entity_type is registry-typed IN APP (ATTACHABLE_TYPES). No FK by
-- design — target tables arrive later; the owning module validates the target.
create table public.comment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  entity_type text not null,
  entity_id uuid not null,
  author_user_id uuid not null references public.user_profile (id),
  body text not null check (length(body) between 1 and 4000),
  edited_at timestamptz,
  deleted_at timestamptz, -- soft delete (D-1.7: comments are voided, not purged)
  deleted_by uuid references public.user_profile (id),
  created_at timestamptz not null default now()
);
create index comment_org_entity_idx on public.comment (org_id, entity_type, entity_id, created_at);

alter table public.comment enable row level security;
-- Reads: any active org member (operational narrative is tenant-visible).
create policy comment_select on public.comment
  for select to app_user
  using (org_id = (select app.current_org_id()));
-- Writes: the author is the caller.
create policy comment_insert on public.comment
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and author_user_id = (select app.current_user_id())
  );
-- Edit / soft-delete confined to the org; column grant restricts WHICH columns.
create policy comment_update on public.comment
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.comment to app_user;
grant update (body, edited_at, deleted_at, deleted_by) on public.comment to app_user;
-- No DELETE grant — D-1.7.

-- ── notification ──────────────────────────────────────────────────────────────
-- Recipient-scoped: a user sees only their OWN notifications in the active org.
create table public.notification (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  user_id uuid not null references public.user_profile (id), -- recipient
  kind text not null,                    -- registry-typed in app (later slices add kinds)
  title text not null check (length(title) between 1 and 200),
  body text check (body is null or length(body) <= 2000),
  entity_type text,                      -- optional deep-link target
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notification_recipient_idx
  on public.notification (org_id, user_id, created_at);
create index notification_unread_idx
  on public.notification (org_id, user_id) where read_at is null;

alter table public.notification enable row level security;
-- Read/mark-read: the recipient only (not org-wide — a notification is private).
create policy notification_select on public.notification
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
-- Insert: a member may create a notification FOR a co-member in their org (the
-- generating features run in the actor's ctx). org-scoped; recipient must be a
-- member of the org (enforced by the recipient's own membership existing — a
-- notification to a non-member is inert and the recipient can never read it).
create policy notification_insert on public.notification
  for insert to app_user
  with check (org_id = (select app.current_org_id()));
-- Update: only the recipient, only to mark read (column grant).
create policy notification_update on public.notification
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
grant select, insert on public.notification to app_user;
grant update (read_at) on public.notification to app_user;

-- ── notification_preference ───────────────────────────────────────────────────
-- Per-user, per-org channel prefs. channels jsonb = { "<kind>": { in_app, email, push } };
-- absent kind => defaults (resolved in app). Delivery wiring is S4.
create table public.notification_preference (
  org_id uuid not null references public.org (id) on delete restrict,
  user_id uuid not null references public.user_profile (id),
  channels jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create trigger notification_preference_touch_updated_at
  before update on public.notification_preference
  for each row execute function app.set_updated_at();

alter table public.notification_preference enable row level security;
create policy notification_preference_select on public.notification_preference
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy notification_preference_insert on public.notification_preference
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy notification_preference_update on public.notification_preference
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
grant select, insert on public.notification_preference to app_user;
grant update (channels) on public.notification_preference to app_user;
