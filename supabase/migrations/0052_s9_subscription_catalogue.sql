-- 0052_s9_subscription_catalogue (S9 "Commercial Wiring", part 1): the subscription-lifecycle
-- fields on org_plan_state + the provider-neutral price-book catalogue. Forward-only, expand-only.
--
-- D1 boundary: this is SCHEMA/CAPABILITY design, which phase2/00-INDEX.md explicitly says D1 does
-- NOT block. Nothing here touches a real payment processor. Provider id columns are nullable and
-- stay null until D1 activation wires a real adapter. Prices are PLACEHOLDERS (is_placeholder=true)
-- pending D3 — never presented as final public pricing.

-- ── Reconcile billing_state to the v1 §13 machine (add purge_pending, purged) ──────────────────
-- v1 §13: trialing → active → past_due → grace → suspended → cancelled → purge_pending → purged.
-- Keep internal_pilot (shipped). `paused` deferred (S10+). Forward-only constraint swap.
alter table public.org_plan_state drop constraint org_plan_state_billing_state_check;
alter table public.org_plan_state add constraint org_plan_state_billing_state_check
  check (billing_state in (
    'internal_pilot','trialing','active','past_due','grace','suspended',
    'cancelled','purge_pending','purged'
  ));

-- ── Subscription-lifecycle fields on org_plan_state ────────────────────────────────────────────
-- All nullable / defaulted so the expand is safe on live rows. Money stays out of this table
-- (it lives in plan_price); these are state + window timestamps + the swappable provider linkage.
alter table public.org_plan_state
  add column provider text
    check (provider is null or provider in ('none','fake','stripe','paddle','lemonsqueezy','tap','moyasar')),
  add column provider_customer_id text
    check (provider_customer_id is null or length(provider_customer_id) between 1 and 200),
  add column provider_subscription_id text
    check (provider_subscription_id is null or length(provider_subscription_id) between 1 and 200),
  add column billing_interval text
    check (billing_interval is null or billing_interval in ('month','year')),
  add column billing_currency char(3),
  -- Window math for the lifecycle worker (all UTC instants; the calendar service owns any
  -- working-day math elsewhere — these are simple wall-clock deadlines).
  add column trial_end timestamptz,
  add column grace_until timestamptz,      -- past_due → suspend deadline (dunning window end)
  add column suspend_at timestamptz,       -- when grace ends → suspended
  add column cancel_at_period_end boolean not null default false,
  add column purge_at timestamptz,         -- cancelled/suspended read-only window end → purge_pending
  -- A pending plan change that applies at period end (downgrade path; never deletes data).
  add column scheduled_plan_key text references public.plan (key) on delete restrict,
  -- Legal hold suspends ALL deletion pipelines (v1 §12) — the purge worker checks this first.
  add column legal_hold boolean not null default false;

-- provider_customer_id must be unique PER provider so a webhook can resolve exactly one org
-- (a core reconciliation invariant). Null customer ids (pre-activation) are unconstrained.
create unique index org_plan_state_provider_customer_uq
  on public.org_plan_state (provider, provider_customer_id)
  where provider_customer_id is not null;
-- Hot path: the lifecycle worker scans for orgs whose window deadline has passed.
create index org_plan_state_lifecycle_idx
  on public.org_plan_state (billing_state, grace_until, suspend_at, purge_at);

-- No new grant: org_plan_state stays tenant-READ-ONLY (0005). Every write is a platform/billing
-- action through the S9 SECURITY DEFINER path (0053) — the DB enforces "never by client claims".

-- ── plan_price: the provider-neutral price book (per plan × interval × currency) ────────────────
-- Minor units, no floats (Bible §4.9). is_placeholder marks the D3-pending hypothesis values so
-- the UI never renders them as final public prices. Versioned + audited via the platform path;
-- a used price is superseded (active=false), never hard-deleted.
create table public.plan_price (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.plan (key) on delete restrict,
  billing_interval text not null check (billing_interval in ('month','year')),
  currency char(3) not null,
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  -- Provider price id (e.g. Stripe price_...) — NULL until D1 activation; never committed to repo.
  provider_price_id text check (provider_price_id is null or length(provider_price_id) between 1 and 200),
  is_placeholder boolean not null default true,
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One ACTIVE price per (plan, interval, currency); superseded rows keep history.
create unique index plan_price_active_uq
  on public.plan_price (plan_key, billing_interval, currency)
  where active;
create index plan_price_lookup_idx on public.plan_price (plan_key, active);
alter table public.plan_price enable row level security;
-- Prices are PUBLIC catalogue data (a signed-out visitor could see them): readable by app_user
-- with no org predicate. Writes are platform-only (no grant) — owner edits via the S9 platform path.
create policy plan_price_read on public.plan_price for select to app_user using (true);
grant select on public.plan_price to app_user;
create trigger plan_price_touch_updated_at
  before update on public.plan_price
  for each row execute function app.set_updated_at();

-- Seed PLACEHOLDER prices (is_placeholder=true) for the 3 tiers × month/year in AED + USD, in
-- minor units. NON-FINAL — pending D3/OP-2 owner ratification. Sourced from the doc-09 tier
-- hypothesis; the UI labels these "indicative". (Data-only seed of a just-created reference table
-- is safe here — no live rows depend on it; kept in this file as the table is pure reference.)
insert into public.plan_price (plan_key, billing_interval, currency, unit_amount_minor, is_placeholder) values
  ('starter','month','AED', 18900, true), ('starter','year','AED', 189000, true),
  ('growth','month','AED', 49900, true),  ('growth','year','AED', 499000, true),
  ('business','month','AED', 99900, true),('business','year','AED', 999000, true),
  ('starter','month','USD', 4900, true),  ('starter','year','USD', 49000, true),
  ('growth','month','USD', 12900, true),  ('growth','year','USD', 129000, true),
  ('business','month','USD', 24900, true),('business','year','USD', 249000, true);
