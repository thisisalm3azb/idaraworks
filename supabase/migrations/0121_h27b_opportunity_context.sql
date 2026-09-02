-- H27B — the opportunity's commercial context: stakeholders, products and
-- pricing lines, competitors, risks, commercial exceptions (discounts routed
-- through the approvals engine), and the optional visual deal canvas.
-- Additive; org_id + RLS + composite FKs; no DELETE grant.

-- ── stakeholders (people on the buying side, with influence) ────────────────
create table public.crm_opportunity_stakeholder (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  contact_id uuid,                                       -- a known contact, or…
  name text check (name is null or length(name) between 1 and 120),  -- …a named person
  role_kind text not null default 'other'
    check (role_kind in ('decision_maker', 'economic_buyer', 'influencer', 'champion', 'user',
                         'procurement', 'finance', 'technical', 'blocker', 'other')),
  influence integer not null default 3 check (influence between 1 and 5),
  sentiment text not null default 'unknown' check (sentiment in ('supporter', 'neutral', 'detractor', 'unknown')),
  notes text check (notes is null or length(notes) <= 1000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_opportunity_stakeholder_id_org_uq unique (id, org_id),
  constraint crm_opportunity_stakeholder_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict,
  constraint crm_opportunity_stakeholder_contact_fk foreign key (contact_id, org_id)
    references public.customer_contact (id, org_id) on delete restrict,
  constraint crm_opportunity_stakeholder_identity_ck check (contact_id is not null or name is not null)
);
create index crm_opportunity_stakeholder_idx on public.crm_opportunity_stakeholder (org_id, opportunity_id);
alter table public.crm_opportunity_stakeholder enable row level security;
create policy crm_opportunity_stakeholder_select on public.crm_opportunity_stakeholder
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_opportunity_stakeholder_insert on public.crm_opportunity_stakeholder
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_opportunity_stakeholder_update on public.crm_opportunity_stakeholder
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_opportunity_stakeholder to app_user;
grant update (contact_id, name, role_kind, influence, sentiment, notes, updated_at)
  on public.crm_opportunity_stakeholder to app_user;
create trigger crm_opportunity_stakeholder_touch before update on public.crm_opportunity_stakeholder
  for each row execute function app.set_updated_at();

-- ── products and services on the opportunity (pre-quote pricing lines) ─────
create table public.crm_opportunity_product (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  item_id uuid,                                           -- catalogue item, or free text
  description text not null check (length(description) between 1 and 300),
  qty numeric(12, 3) not null check (qty > 0),
  unit text not null default 'ea' check (length(unit) between 1 and 16),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  discount_pct numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  vat_rate numeric(5, 2) not null default 0 check (vat_rate between 0 and 100),
  -- Cost for margin (redacted by ctx.costPrivileged in the serializer, F-23).
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  optional boolean not null default false,
  bundle_key text check (bundle_key is null or bundle_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  recurrence_months integer check (recurrence_months is null or recurrence_months between 1 and 120),
  sort integer not null default 0,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_opportunity_product_id_org_uq unique (id, org_id),
  constraint crm_opportunity_product_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict,
  constraint crm_opportunity_product_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict
);
create index crm_opportunity_product_idx on public.crm_opportunity_product (org_id, opportunity_id, sort);
alter table public.crm_opportunity_product enable row level security;
create policy crm_opportunity_product_select on public.crm_opportunity_product
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_opportunity_product_insert on public.crm_opportunity_product
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_opportunity_product_update on public.crm_opportunity_product
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_opportunity_product to app_user;
grant update (item_id, description, qty, unit, unit_price_minor, discount_pct, vat_rate, unit_cost_minor,
              optional, bundle_key, recurrence_months, sort, updated_at)
  on public.crm_opportunity_product to app_user;
create trigger crm_opportunity_product_touch before update on public.crm_opportunity_product
  for each row execute function app.set_updated_at();

-- ── competitors ─────────────────────────────────────────────────────────────
create table public.crm_opportunity_competitor (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  name text not null check (length(name) between 1 and 120),
  strengths text check (strengths is null or length(strengths) <= 1000),
  weaknesses text check (weaknesses is null or length(weaknesses) <= 1000),
  status text not null default 'active' check (status in ('active', 'eliminated', 'won_against_us', 'unknown')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_opportunity_competitor_id_org_uq unique (id, org_id),
  constraint crm_opportunity_competitor_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict
);
create index crm_opportunity_competitor_idx on public.crm_opportunity_competitor (org_id, opportunity_id);
alter table public.crm_opportunity_competitor enable row level security;
create policy crm_opportunity_competitor_select on public.crm_opportunity_competitor
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_opportunity_competitor_insert on public.crm_opportunity_competitor
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_opportunity_competitor_update on public.crm_opportunity_competitor
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_opportunity_competitor to app_user;
grant update (name, strengths, weaknesses, status, updated_at) on public.crm_opportunity_competitor to app_user;
create trigger crm_opportunity_competitor_touch before update on public.crm_opportunity_competitor
  for each row execute function app.set_updated_at();

-- ── risks, blockers and dependencies ────────────────────────────────────────
create table public.crm_opportunity_risk (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  kind text not null default 'risk' check (kind in ('risk', 'blocker', 'dependency')),
  title text not null check (length(title) between 1 and 200),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'mitigated', 'closed')),
  mitigation text check (mitigation is null or length(mitigation) <= 1000),
  owner_user_id uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_opportunity_risk_id_org_uq unique (id, org_id),
  constraint crm_opportunity_risk_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict
);
create index crm_opportunity_risk_idx on public.crm_opportunity_risk (org_id, opportunity_id, status);
alter table public.crm_opportunity_risk enable row level security;
create policy crm_opportunity_risk_select on public.crm_opportunity_risk
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_opportunity_risk_insert on public.crm_opportunity_risk
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_opportunity_risk_update on public.crm_opportunity_risk
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_opportunity_risk to app_user;
grant update (kind, title, severity, status, mitigation, owner_user_id, updated_at)
  on public.crm_opportunity_risk to app_user;
create trigger crm_opportunity_risk_touch before update on public.crm_opportunity_risk
  for each row execute function app.set_updated_at();

-- ── commercial exceptions: a discount request is an approval subject ───────
create table public.crm_discount (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  quote_id uuid,
  requested_pct numeric(5, 2) not null check (requested_pct > 0 and requested_pct <= 100),
  list_total_minor bigint not null check (list_total_minor >= 0),
  discounted_total_minor bigint not null check (discounted_total_minor >= 0),
  currency char(3) not null,
  reason text not null check (length(reason) between 1 and 1000),
  -- The approvals engine's guarded move: pending → approved | rejected | withdrawn.
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  approval_id uuid,
  decided_at timestamptz,
  requested_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_discount_id_org_uq unique (id, org_id),
  constraint crm_discount_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict,
  constraint crm_discount_quote_fk foreign key (quote_id, org_id)
    references public.quote (id, org_id) on delete restrict,
  constraint crm_discount_approval_fk foreign key (approval_id, org_id)
    references public.approval (id, org_id) on delete restrict
);
-- One live request per opportunity.
create unique index crm_discount_one_pending_idx on public.crm_discount (opportunity_id) where status = 'pending';
create index crm_discount_org_idx on public.crm_discount (org_id, opportunity_id, created_at desc);
alter table public.crm_discount enable row level security;
create policy crm_discount_select on public.crm_discount
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_discount_insert on public.crm_discount
  for insert to app_user with check (org_id = (select app.current_org_id())
                                     and requested_by = (select app.current_user_id()));
create policy crm_discount_update on public.crm_discount
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_discount to app_user;
grant update (status, approval_id, decided_at, quote_id, updated_at) on public.crm_discount to app_user;
create trigger crm_discount_touch before update on public.crm_discount
  for each row execute function app.set_updated_at();

-- ── the optional visual deal canvas (one per opportunity) ───────────────────
create table public.crm_deal_canvas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  opportunity_id uuid not null,
  -- {nodes:[{id,kind,label,x,y,ref?}], edges:[{id,from,to,label?}]} — app-validated.
  doc jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  row_version bigint not null default 1,
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_deal_canvas_id_org_uq unique (id, org_id),
  constraint crm_deal_canvas_opp_uq unique (opportunity_id),
  constraint crm_deal_canvas_opp_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict
);
alter table public.crm_deal_canvas enable row level security;
create policy crm_deal_canvas_select on public.crm_deal_canvas
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_deal_canvas_insert on public.crm_deal_canvas
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_deal_canvas_update on public.crm_deal_canvas
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_deal_canvas to app_user;
grant update (doc, row_version, updated_by, updated_at) on public.crm_deal_canvas to app_user;
create trigger crm_deal_canvas_touch before update on public.crm_deal_canvas
  for each row execute function app.set_updated_at();
