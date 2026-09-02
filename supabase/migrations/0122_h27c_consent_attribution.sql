-- H27C — consent, suppression and attribution touches (ADR-36, ADR-40).
-- Consent is recorded per person and channel with its source and evidence; a
-- suppression (objection, unsubscribe, bounce, complaint) outranks any consent
-- and is never overwritten. Touches record which campaign reached which
-- lead, customer or opportunity, for first/last/linear attribution.

create table public.crm_consent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- Exactly one subject.
  customer_id uuid,
  contact_id uuid,
  lead_id uuid,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'phone', 'post')),
  status text not null check (status in ('granted', 'withdrawn', 'unknown')),
  -- How consent was obtained or withdrawn: form, verbal, written, import, customer_request, unsubscribe.
  source text not null check (source in ('form', 'verbal', 'written', 'import', 'customer_request', 'unsubscribe', 'system')),
  evidence text check (evidence is null or length(evidence) <= 1000),
  effective_at timestamptz not null default now(),
  actor_user_id uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint crm_consent_id_org_uq unique (id, org_id),
  constraint crm_consent_customer_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint crm_consent_contact_fk foreign key (contact_id, org_id)
    references public.customer_contact (id, org_id) on delete restrict,
  constraint crm_consent_lead_fk foreign key (lead_id, org_id)
    references public.lead (id, org_id) on delete restrict,
  constraint crm_consent_subject_ck check (
    (case when customer_id is not null then 1 else 0 end) +
    (case when contact_id is not null then 1 else 0 end) +
    (case when lead_id is not null then 1 else 0 end) = 1)
);
create index crm_consent_customer_idx on public.crm_consent (org_id, customer_id, channel, effective_at desc);
create index crm_consent_contact_idx on public.crm_consent (org_id, contact_id, channel, effective_at desc);
create index crm_consent_lead_idx on public.crm_consent (org_id, lead_id, channel, effective_at desc);
alter table public.crm_consent enable row level security;
create policy crm_consent_select on public.crm_consent
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_consent_insert on public.crm_consent
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Consent records are append-only: a change is a new row with a later effective_at.
grant select, insert on public.crm_consent to app_user;

create table public.crm_suppression (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'phone', 'post')),
  -- Normalised address (lower-cased email, E.164 phone); the match key.
  address text not null check (length(address) between 3 and 320),
  reason text not null check (reason in ('objection', 'unsubscribe', 'bounce', 'complaint', 'legal', 'manual')),
  note text check (note is null or length(note) <= 500),
  actor_user_id uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint crm_suppression_id_org_uq unique (id, org_id),
  constraint crm_suppression_org_channel_address_uq unique (org_id, channel, address)
);
alter table public.crm_suppression enable row level security;
create policy crm_suppression_select on public.crm_suppression
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_suppression_insert on public.crm_suppression
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Suppressions are never updated or deleted by the application role.
grant select, insert on public.crm_suppression to app_user;

create table public.crm_touch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  campaign_id uuid not null,
  customer_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  kind text not null default 'exposure' check (kind in ('exposure', 'click', 'reply', 'visit', 'referral', 'manual')),
  touched_at timestamptz not null default now(),
  note text check (note is null or length(note) <= 300),
  created_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint crm_touch_id_org_uq unique (id, org_id),
  constraint crm_touch_campaign_fk foreign key (campaign_id, org_id)
    references public.crm_campaign (id, org_id) on delete restrict,
  constraint crm_touch_customer_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint crm_touch_lead_fk foreign key (lead_id, org_id)
    references public.lead (id, org_id) on delete restrict,
  constraint crm_touch_opportunity_fk foreign key (opportunity_id, org_id)
    references public.opportunity (id, org_id) on delete restrict,
  constraint crm_touch_subject_ck check (customer_id is not null or lead_id is not null or opportunity_id is not null)
);
create index crm_touch_campaign_idx on public.crm_touch (org_id, campaign_id, touched_at);
create index crm_touch_opportunity_idx on public.crm_touch (org_id, opportunity_id, touched_at);
create index crm_touch_lead_idx on public.crm_touch (org_id, lead_id, touched_at);
create index crm_touch_customer_idx on public.crm_touch (org_id, customer_id, touched_at);
alter table public.crm_touch enable row level security;
create policy crm_touch_select on public.crm_touch
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_touch_insert on public.crm_touch
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_touch to app_user;
