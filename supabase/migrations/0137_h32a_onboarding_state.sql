-- 0137_h32a — H32 Simple Guided Onboarding: where a person's tour progress lives.
--
-- Additive. One table, nothing existing is touched, and an organisation with no
-- rows here behaves exactly as it does today.
--
-- ── Why a table and not a browser preference ────────────────────────────────
-- A tour that is "finished" in one browser and unfinished in another is worse
-- than no tour: it reappears on the phone after being dismissed on the laptop.
-- Local storage may remember device-specific display choices; whether somebody
-- has actually finished is server state.
--
-- ── Why the key is (org_id, user_id) ───────────────────────────────────────
-- Both halves matter. `org_id` keeps one company's progress out of another's.
-- `user_id` in the SAME policy is what makes it structurally impossible for an
-- administrator to read or mark another person's tour — not a permission check
-- that could be forgotten at a call site, but a row they cannot see at all.
--
-- This mirrors `public.notification_preference` (migration 0011) deliberately:
-- the shape is already proven here, and a reader who knows one knows the other.

create table public.onboarding_state (
  org_id uuid not null references public.org (id) on delete restrict,
  user_id uuid not null references public.user_profile (id),

  /*
   * Where this person is. Deliberately a small closed vocabulary rather than a
   * pile of booleans, because "welcomed but not started" and "skipped" are
   * genuinely different states and a boolean pair would allow nonsense
   * combinations.
   */
  status text not null default 'new'
    check (status in ('new', 'welcomed', 'in_progress', 'completed', 'skipped')),

  /* The furthest step reached, so Restart can resume rather than replay. */
  step_index integer not null default 0 check (step_index >= 0 and step_index <= 20),

  /*
   * Which tour this progress refers to. A person whose role changes should be
   * able to receive a newly relevant short tour without replaying the old one,
   * and comparing this to the tour they are eligible for now is how that is
   * decided.
   */
  tour_key text check (tour_key is null or length(tour_key) between 1 and 40),

  /*
   * Bumped when the tour's content changes materially. It lets a future phase
   * offer an updated tour without resetting anybody's history, and it means
   * "completed" always answers "completed WHAT".
   */
  tour_version integer not null default 1 check (tour_version >= 1),

  /* The checklist is dismissed independently: somebody may finish the tour and
   * still want the checklist, or the reverse. */
  checklist_dismissed_at timestamptz,

  completed_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (org_id, user_id)
);

alter table public.onboarding_state enable row level security;

/*
 * Every policy carries BOTH conditions. Dropping `user_id` from any one of them
 * would let an administrator read or overwrite a colleague's progress, which is
 * exactly the failure this shape exists to make unreachable.
 */
create policy onboarding_state_select on public.onboarding_state
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy onboarding_state_insert on public.onboarding_state
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );
create policy onboarding_state_update on public.onboarding_state
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and user_id = (select app.current_user_id())
  );

grant select, insert on public.onboarding_state to app_user;
-- Column-scoped: org_id and user_id are absent, so a row can never be moved to
-- another person or another company by an application path.
grant update (status, step_index, tour_key, tour_version,
              checklist_dismissed_at, completed_at, dismissed_at, updated_at)
  on public.onboarding_state to app_user;

create trigger onboarding_state_touch_updated_at
  before update on public.onboarding_state
  for each row execute function app.set_updated_at();

comment on table public.onboarding_state is
  'H32: one person''s guided-tour progress in one organisation. RLS is scoped to '
  'org AND user, so an administrator cannot see or change a colleague''s row.';
