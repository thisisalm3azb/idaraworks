-- 0041_s6_quotes (S6 — "Bill", part 1 of 4): quotes (doc 01 L4; FS-1).
-- A quote is authored (+lines grouped by config quote_section), routed through the
-- unified approval engine as `quote_send` (always → owner/admin, D-5.3), sent, and
-- ACCEPTED with evidence (accepted_at/note/file) — the acceptance record justifies
-- the on_acceptance billing point. On acceptance the quote CONVERTS to a job (total
-- → selling_price, terms → payment_terms, billing_points seeded from the preset).
-- Money in minor units, VAT recorded per document; multi-currency with the base
-- amount FROZEN at issuance + an immutable exchange_rate (D-1.3/OP-8). No-hard-delete.
-- Forward-only.

-- Composite (id, org_id) unique the child FKs pin against (supplier/item already have one).
alter table public.customer add constraint customer_id_org_uq unique (id, org_id);

create table public.quote (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  customer_id uuid,
  customer_name text, -- D-1.6 snapshot: survives customer rename/deactivation
  preset_id uuid references public.job_preset (id),
  -- 'converting' is a transient claim state: acceptQuote atomically moves an
  -- approved/sent quote here BEFORE creating the job, so a concurrent accept or a
  -- retry cannot create a second (orphan) job.
  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'sent', 'converting', 'accepted', 'rejected', 'expired', 'converted'
  )),
  revision_of_id uuid, -- self-FK: this quote is a revision of an earlier one (F-9)
  currency char(3) not null default 'AED'
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  -- Rate to the org base currency, set at issuance and IMMUTABLE (OP-8). base_* are
  -- the frozen base-currency amounts costing/AR/reporting consume — never recomputed.
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  vat_amount_minor bigint not null default 0 check (vat_amount_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  base_total_minor bigint not null default 0 check (base_total_minor >= 0),
  terms text check (terms is null or length(terms) <= 2000),
  valid_until date,
  accepted_at timestamptz,
  accepted_note text check (accepted_note is null or length(accepted_note) <= 2000),
  acceptance_evidence_file_id uuid references public.file (id),
  rejected_reason text check (rejected_reason is null or length(rejected_reason) <= 2000),
  converted_job_id uuid,
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_id_org_uq unique (id, org_id),
  constraint quote_ref_uq unique (org_id, reference),
  constraint quote_total_ck check (total_minor = subtotal_minor + vat_amount_minor),
  -- Acceptance must carry its evidence trail; a rejected quote must carry a reason.
  constraint quote_accept_ck check (status <> 'accepted' or accepted_at is not null),
  constraint quote_reject_ck check (status <> 'rejected' or rejected_reason is not null)
);
create index quote_org_status_idx on public.quote (org_id, status, created_at);
create index quote_org_customer_idx on public.quote (org_id, customer_id);
alter table public.quote
  add constraint quote_customer_org_fk foreign key (customer_id, org_id)
  references public.customer (id, org_id) on delete restrict;
alter table public.quote
  add constraint quote_job_org_fk foreign key (converted_job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.quote
  add constraint quote_revision_org_fk foreign key (revision_of_id, org_id)
  references public.quote (id, org_id) on delete restrict;
alter table public.quote enable row level security;
create policy quote_select on public.quote
  for select to app_user using (org_id = (select app.current_org_id()));
create policy quote_insert on public.quote
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy quote_update on public.quote
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.quote to app_user;
grant update (customer_id, customer_name, preset_id, status, currency, exchange_rate,
  subtotal_minor, vat_amount_minor, total_minor, base_total_minor, terms, valid_until,
  accepted_at, accepted_note, acceptance_evidence_file_id, rejected_reason,
  converted_job_id, notes, updated_at) on public.quote to app_user;

create table public.quote_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  quote_id uuid not null,
  -- section_key references a config quote_section (CategorySet); free text tolerated.
  section_key text check (section_key is null or length(section_key) <= 60),
  item_id uuid,
  description text not null check (length(description) between 1 and 300),
  qty numeric(14, 3) not null check (qty > 0),
  unit text not null check (length(unit) between 1 and 16),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  vat_rate numeric(5, 2) not null default 0 check (vat_rate >= 0 and vat_rate <= 100),
  line_total_minor bigint not null default 0 check (line_total_minor >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index quote_line_idx on public.quote_line (org_id, quote_id, sort);
alter table public.quote_line
  add constraint quote_line_quote_org_fk foreign key (quote_id, org_id)
  references public.quote (id, org_id) on delete restrict;
alter table public.quote_line
  add constraint quote_line_item_org_fk foreign key (item_id, org_id)
  references public.item (id, org_id) on delete restrict;
alter table public.quote_line enable row level security;
create policy quote_line_select on public.quote_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy quote_line_insert on public.quote_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy quote_line_update on public.quote_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- No DELETE grant (D-1.7 no-hard-delete). Draft line editing, when added, must use a
-- soft pattern (rewrite via update/insert), never a hard delete.
grant select, insert on public.quote_line to app_user;
grant update (section_key, item_id, description, qty, unit, unit_price_minor, vat_rate,
  line_total_minor, sort) on public.quote_line to app_user;
