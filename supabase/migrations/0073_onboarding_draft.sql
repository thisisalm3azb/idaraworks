-- 0073_onboarding_draft (U4 — pre-org onboarding journey)
-- One draft per USER, not per org: the first-login questionnaire answers, chosen
-- template, tier selection and branding stash live here while NO organization
-- exists yet. Nothing in this table grants anything — the org, the template
-- application, the tier recording and the branding all happen only at the
-- explicit final confirm (src/modules/onboarding/service.ts runConfirmChain).
--
-- USER-scoped RLS: policies key on app.current_user_id() — the same idiom as the
-- user_profile self policy and the membership bootstrap read (0003/0004). The
-- flow runs under withUserCtx (no org GUC is ever set for it).
--
-- No DELETE grant (D-1.7 archive/void law): a finished draft flips
-- status='completed' and stays; a new flow re-activates the same row (upsert).
-- Rollback note: drop trigger, then table; safe (drafts are re-creatable scratch).

create table public.onboarding_draft (
  user_id uuid primary key references auth.users (id) on delete restrict,
  -- answers, chosen template, tier selection, branding stash, confirm progress
  data jsonb not null default '{}'::jsonb,
  -- current wizard step (validated app-side against the FLOW_STEPS registry)
  step text not null default 'welcome',
  status text not null default 'active' check (status in ('active', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.onboarding_draft enable row level security;

create policy onboarding_draft_self_access on public.onboarding_draft
  for all to app_user
  using (user_id = (select app.current_user_id()))
  with check (user_id = (select app.current_user_id()));

grant select, insert, update on public.onboarding_draft to app_user; -- NO DELETE (D-1.7)

create trigger onboarding_draft_touch_updated_at
  before update on public.onboarding_draft
  for each row execute function app.set_updated_at();
