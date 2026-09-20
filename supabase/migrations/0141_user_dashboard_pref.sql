-- 0141 — a person's own dashboard layout in one organisation.
--
-- Additive. One table, nothing existing is touched, and a person with no row
-- here sees the role default exactly as before.
--
-- ── Why a table and not a browser preference ────────────────────────────────
-- A dashboard arranged on the laptop must be the same dashboard on the phone.
-- Local storage would make the layout a property of a browser; this makes it
-- a property of the person in this company.
--
-- ── Why the key is (org_id, user_id) ───────────────────────────────────────
-- Both halves matter. `org_id` keeps one company's preferences out of another's
-- and lets the same person arrange each workspace differently. `user_id` in the
-- SAME policy is what makes it structurally impossible for an administrator to
-- read or rewrite a colleague's layout — not a permission check that could be
-- forgotten at a call site, but a row they cannot see at all.
--
-- ── What the layout does NOT do ────────────────────────────────────────────
-- It never grants anything. A widget key stored here is a preference about
-- ORDER, SIZE and VISIBILITY; whether the widget's data may be read is decided
-- again, every time, by the permission and entitlement checks in the loader.
-- A key this person may not see, or that no longer exists, is ignored on read.
--
-- Mirrors `public.onboarding_state` (0137) and `public.notification_preference`
-- (0011): the shape is already proven, and a reader who knows one knows this.

create table public.user_dashboard_pref (
  org_id uuid not null references public.org (id) on delete restrict,
  user_id uuid not null references public.user_profile (id),

  /*
   * { "v": 1, "widgets": [ { "key": "...", "size": "s|m|l", "hidden": bool? } ] }
   * NULL means "the role default" — the state after Reset, and the state of
   * everybody who has never touched Edit dashboard.
   */
  layout jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (org_id, user_id),

  /* The application validates the full shape; the database refuses the
   * shapes that could never be valid, so a bad write cannot sit here quietly. */
  constraint user_dashboard_pref_layout_shape check (
    layout is null
    or (
      jsonb_typeof(layout) = 'object'
      and jsonb_typeof(layout -> 'widgets') = 'array'
      and jsonb_array_length(layout -> 'widgets') <= 40
    )
  )
);

alter table public.user_dashboard_pref enable row level security;

/*
 * Every policy carries BOTH conditions. Dropping `user_id` from any one of them
 * would let an administrator read or overwrite a colleague's dashboard, which
 * is exactly the failure this shape exists to make unreachable.
 */
create policy user_dashboard_pref_select on public.user_dashboard_pref
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy user_dashboard_pref_insert on public.user_dashboard_pref
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy user_dashboard_pref_update on public.user_dashboard_pref
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );

grant select, insert on public.user_dashboard_pref to app_user;
-- Column-scoped: org_id and user_id are absent, so a row can never be moved to
-- another person or another company by an application path.
grant update (layout, updated_at) on public.user_dashboard_pref to app_user;

create trigger user_dashboard_pref_touch_updated_at
  before update on public.user_dashboard_pref
  for each row execute function app.set_updated_at();

comment on table public.user_dashboard_pref is
  'One person''s dashboard layout (widget order, size, visibility) in one '
  'organisation. RLS is scoped to org AND user. A preference, never a grant: '
  'the loader re-checks permission and entitlement for every widget it renders.';
