-- H27A — CRM and Revenue Growth Studio foundation. ADDITIVE: new satellite
-- tables around the H19/H20 customer, lead, opportunity, pipeline_stage and
-- sales_activity models; new columns on those models; widened UPDATE grants;
-- one new approval subject (crm_discount). No table is replaced, nothing is
-- deleted, and every new table carries org_id + RLS + composite org FKs and no
-- DELETE grant. Surfaces stay behind FEATURE_REVENUE_STUDIO.

-- ── entitlement ─────────────────────────────────────────────────────────────
insert into public.entitlement_def (key, kind) values ('cap.revenue_studio', 'feature');
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, 'cap.revenue_studio', true
from public.plan p
where p.key in ('free', 'starter', 'growth', 'business');

-- ── approval subject: commercial exceptions (discounts) ─────────────────────
alter table public.approval drop constraint approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step',
    'crm_discount'
  ));
alter table public.approval_rule drop constraint approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step',
    'crm_discount'
  ));

-- ── territories (before customer/lead/opportunity columns reference them) ──
create table public.crm_territory (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name jsonb not null,                                   -- {en, ar}
  -- Rules: countries (ISO-2), tags, name patterns; evaluated in app code.
  rules jsonb not null default '{}'::jsonb,
  owner_user_id uuid references public.user_profile (id),
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_territory_org_key_uq unique (org_id, key),
  constraint crm_territory_id_org_uq unique (id, org_id)
);
alter table public.crm_territory enable row level security;
create policy crm_territory_select on public.crm_territory
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_territory_insert on public.crm_territory
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_territory_update on public.crm_territory
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_territory to app_user;
grant update (name, rules, owner_user_id, active, updated_at) on public.crm_territory to app_user;
create trigger crm_territory_touch before update on public.crm_territory
  for each row execute function app.set_updated_at();

-- ── pipelines ───────────────────────────────────────────────────────────────
create table public.crm_pipeline (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name jsonb not null,                                   -- {en, ar}
  kind text not null default 'new_business'
    check (kind in ('new_business', 'expansion', 'renewal', 'custom')),
  is_default boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_pipeline_org_key_uq unique (org_id, key),
  constraint crm_pipeline_id_org_uq unique (id, org_id)
);
create unique index crm_pipeline_one_default_idx on public.crm_pipeline (org_id) where is_default;
alter table public.crm_pipeline enable row level security;
create policy crm_pipeline_select on public.crm_pipeline
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_pipeline_insert on public.crm_pipeline
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_pipeline_update on public.crm_pipeline
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_pipeline to app_user;
grant update (name, kind, is_default, active, updated_at) on public.crm_pipeline to app_user;
create trigger crm_pipeline_touch before update on public.crm_pipeline
  for each row execute function app.set_updated_at();

-- Stages join a pipeline; existing rows attach to the default pipeline lazily
-- (app: ensurePipelines). Requirements gate ENTRY to a stage.
alter table public.pipeline_stage
  add column pipeline_id uuid,
  add column requirements jsonb not null default '[]'::jsonb,   -- ["value","close_date","stakeholder","next_action","quote","contact"]
  add column exit_criteria jsonb,                                -- {en, ar}
  add column default_probability integer check (default_probability is null or default_probability between 0 and 100),
  add column max_age_days integer check (max_age_days is null or max_age_days between 1 and 3650),
  add constraint pipeline_stage_pipeline_org_fk foreign key (pipeline_id, org_id)
    references public.crm_pipeline (id, org_id) on delete restrict;
create index pipeline_stage_pipeline_idx on public.pipeline_stage (org_id, pipeline_id, sort);
grant update (pipeline_id, requirements, exit_criteria, default_probability, max_age_days)
  on public.pipeline_stage to app_user;

-- ── campaigns ───────────────────────────────────────────────────────────────
create table public.crm_campaign (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 160),
  objective text check (objective is null or length(objective) <= 1000),
  channel text not null default 'other'
    check (channel in ('email', 'sms', 'whatsapp', 'social', 'event', 'referral', 'web', 'ads', 'phone', 'other')),
  status text not null default 'planned' check (status in ('planned', 'active', 'paused', 'completed', 'cancelled')),
  audience jsonb not null default '{}'::jsonb,           -- segments, tags, territories (descriptive)
  budget_minor bigint check (budget_minor is null or budget_minor >= 0),
  cost_minor bigint not null default 0 check (cost_minor >= 0),
  currency char(3),
  starts_on date,
  ends_on date,
  owner_user_id uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_campaign_id_org_uq unique (id, org_id),
  constraint crm_campaign_dates_ck check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint crm_campaign_money_ck check ((budget_minor is null and cost_minor = 0) or currency is not null)
);
create index crm_campaign_org_idx on public.crm_campaign (org_id, status, starts_on desc);
alter table public.crm_campaign enable row level security;
create policy crm_campaign_select on public.crm_campaign
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_campaign_insert on public.crm_campaign
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_campaign_update on public.crm_campaign
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_campaign to app_user;
grant update (name, objective, channel, status, audience, budget_minor, cost_minor, currency,
              starts_on, ends_on, owner_user_id, updated_at)
  on public.crm_campaign to app_user;
create trigger crm_campaign_touch before update on public.crm_campaign
  for each row execute function app.set_updated_at();

-- ── customer: ownership, territory, tags, segment, merge pointer ────────────
alter table public.customer
  add column owner_user_id uuid references public.user_profile (id),
  add column territory_id uuid,
  add column tags text[] not null default '{}'::text[],
  add column segment text check (segment is null or segment ~ '^[a-z][a-z0-9_]{0,39}$'),
  add column merged_into_customer_id uuid,
  add column source_kind text check (source_kind is null or source_kind in
    ('manual', 'form', 'import', 'referral', 'campaign', 'email', 'api', 'lead')),
  add constraint customer_territory_org_fk foreign key (territory_id, org_id)
    references public.crm_territory (id, org_id) on delete restrict,
  add constraint customer_merged_org_fk foreign key (merged_into_customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  add constraint customer_merge_self_ck check (merged_into_customer_id is null or merged_into_customer_id <> id);
create index customer_org_owner_idx on public.customer (org_id, owner_user_id);
create index customer_org_territory_idx on public.customer (org_id, territory_id);
create index customer_org_tags_idx on public.customer using gin (tags);
grant update (owner_user_id, territory_id, tags, segment, merged_into_customer_id, source_kind)
  on public.customer to app_user;

-- ── contacts: relationship roles (+ the composite key other tables reference) ─
alter table public.customer_contact
  add constraint customer_contact_id_org_uq unique (id, org_id);
alter table public.customer_contact
  add column role_kind text not null default 'other'
    check (role_kind in ('decision_maker', 'economic_buyer', 'influencer', 'champion', 'user',
                         'procurement', 'finance', 'technical', 'blocker', 'other')),
  add column notes text check (notes is null or length(notes) <= 2000),
  add column language text check (language is null or language in ('en', 'ar'));
grant update (role_kind, notes, language) on public.customer_contact to app_user;

-- ── lead: capture, attribution, qualification, quarantine ───────────────────
alter table public.lead
  add column source_kind text not null default 'manual'
    check (source_kind in ('manual', 'form', 'import', 'referral', 'customer', 'campaign', 'email', 'messaging', 'api')),
  add column campaign_id uuid,
  add column referrer_customer_id uuid,
  add column territory_id uuid,
  add column estimated_value_minor bigint check (estimated_value_minor is null or estimated_value_minor >= 0),
  add column currency char(3),
  add column timeframe text check (timeframe is null or timeframe in ('immediate', 'quarter', 'half_year', 'year', 'unknown')),
  add column interest text check (interest is null or length(interest) <= 300),
  -- Qualification: {budget, authority, need, timing} booleans + note.
  add column qualification jsonb not null default '{}'::jsonb,
  add column disqualify_reason text check (disqualify_reason is null or disqualify_reason in
    ('no_budget', 'no_need', 'no_authority', 'timing', 'competitor', 'unresponsive', 'spam', 'duplicate', 'other')),
  add column quarantine text not null default 'trusted' check (quarantine in ('trusted', 'quarantined', 'spam')),
  add column duplicate_of_lead_id uuid,
  add column row_version bigint not null default 1,
  add constraint lead_campaign_org_fk foreign key (campaign_id, org_id)
    references public.crm_campaign (id, org_id) on delete restrict,
  add constraint lead_referrer_org_fk foreign key (referrer_customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  add constraint lead_territory_org_fk foreign key (territory_id, org_id)
    references public.crm_territory (id, org_id) on delete restrict,
  add constraint lead_duplicate_org_fk foreign key (duplicate_of_lead_id, org_id)
    references public.lead (id, org_id) on delete restrict,
  add constraint lead_money_ck check ((estimated_value_minor is null) = (currency is null));
create index lead_org_campaign_idx on public.lead (org_id, campaign_id);
create index lead_org_quarantine_idx on public.lead (org_id, quarantine) where quarantine <> 'trusted';
grant update (source_kind, campaign_id, referrer_customer_id, territory_id, estimated_value_minor,
              currency, timeframe, interest, qualification, disqualify_reason, quarantine,
              duplicate_of_lead_id, row_version)
  on public.lead to app_user;

-- ── opportunity: pipeline, forecast, commercial context, contract link ─────
alter table public.opportunity
  add column pipeline_id uuid,
  add column forecast_category text not null default 'pipeline'
    check (forecast_category in ('pipeline', 'best_case', 'commit', 'omitted')),
  add column campaign_id uuid,
  add column territory_id uuid,
  add column source text check (source is null or length(source) <= 80),
  add column kind text not null default 'new_business' check (kind in ('new_business', 'expansion', 'renewal')),
  add column amount_kind text not null default 'one_time' check (amount_kind in ('one_time', 'recurring', 'mixed')),
  add column recurring_minor bigint check (recurring_minor is null or recurring_minor >= 0),
  add column recurrence_months integer check (recurrence_months is null or recurrence_months between 1 and 120),
  add column decision_criteria text check (decision_criteria is null or length(decision_criteria) <= 2000),
  add column needs text check (needs is null or length(needs) <= 4000),
  -- Buying process: [{step, owner, done, due}] (descriptive, app-validated).
  add column buying_process jsonb not null default '[]'::jsonb,
  add column contract_document_id uuid,
  add column stage_entered_at timestamptz not null default now(),
  add column last_activity_at timestamptz,
  add column row_version bigint not null default 1,
  add constraint opportunity_pipeline_org_fk foreign key (pipeline_id, org_id)
    references public.crm_pipeline (id, org_id) on delete restrict,
  add constraint opportunity_campaign_org_fk foreign key (campaign_id, org_id)
    references public.crm_campaign (id, org_id) on delete restrict,
  add constraint opportunity_territory_org_fk foreign key (territory_id, org_id)
    references public.crm_territory (id, org_id) on delete restrict,
  add constraint opportunity_contract_org_fk foreign key (contract_document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict;
create index opportunity_org_pipeline_idx on public.opportunity (org_id, pipeline_id, status, stage_key);
create index opportunity_org_forecast_idx on public.opportunity (org_id, forecast_category)
  where status = 'open' and archived = false;
create index opportunity_org_campaign_idx on public.opportunity (org_id, campaign_id);
grant update (pipeline_id, forecast_category, campaign_id, territory_id, source, kind, amount_kind,
              recurring_minor, recurrence_months, decision_criteria, needs, buying_process,
              contract_document_id, stage_entered_at, last_activity_at, row_version)
  on public.opportunity to app_user;

-- ── sales_activity: wider subjects and kinds, structured payload ───────────
alter table public.sales_activity
  add column customer_id uuid,
  add column contact_id uuid,
  add column title text check (title is null or length(title) <= 200),
  add column outcome text check (outcome is null or outcome in
    ('completed', 'no_answer', 'rescheduled', 'positive', 'neutral', 'negative', 'cancelled')),
  add column participants jsonb not null default '[]'::jsonb,     -- [{kind:'member'|'contact'|'external', id?, name}]
  add column next_action text check (next_action is null or length(next_action) <= 300),
  add column next_action_due date,
  add column location text check (location is null or length(location) <= 200),
  add column reminder_at timestamptz,
  add column recurrence_days integer check (recurrence_days is null or recurrence_days between 1 and 365),
  add column template_key text check (template_key is null or template_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  add column custom_kind text check (custom_kind is null or length(custom_kind) <= 60),
  add column completed_by uuid references public.user_profile (id),
  add column meta jsonb not null default '{}'::jsonb,
  add column updated_at timestamptz not null default now(),
  add constraint sales_activity_customer_org_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  add constraint sales_activity_contact_org_fk foreign key (contact_id, org_id)
    references public.customer_contact (id, org_id) on delete restrict;
alter table public.sales_activity drop constraint sales_activity_kind_check;
alter table public.sales_activity
  add constraint sales_activity_kind_check check (kind in
    ('note', 'call', 'meeting', 'email', 'follow_up', 'task', 'message', 'site_visit', 'demo', 'custom',
     'stage_change', 'quote_created', 'won', 'lost', 'converted', 'merged', 'consent', 'automation',
     'forecast', 'discount', 'contract', 'assigned'));
alter table public.sales_activity drop constraint sales_activity_subject_ck;
alter table public.sales_activity
  add constraint sales_activity_subject_ck
    check (lead_id is not null or opportunity_id is not null or customer_id is not null);
alter table public.sales_activity
  add constraint sales_activity_custom_ck check (kind <> 'custom' or custom_kind is not null);
create index sales_activity_org_customer_idx on public.sales_activity (org_id, customer_id, created_at desc);
create index sales_activity_org_open_tasks_idx on public.sales_activity (org_id, owner_user_id, due_date)
  where kind in ('follow_up', 'task') and completed_at is null;
create index sales_activity_reminder_idx on public.sales_activity (org_id, reminder_at)
  where reminder_at is not null and completed_at is null;
grant update (title, body, outcome, participants, next_action, next_action_due, location, reminder_at,
              recurrence_days, completed_by, meta, updated_at)
  on public.sales_activity to app_user;
create trigger sales_activity_touch before update on public.sales_activity
  for each row execute function app.set_updated_at();
