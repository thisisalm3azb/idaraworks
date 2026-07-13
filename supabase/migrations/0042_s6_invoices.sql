-- 0042_s6_invoices (S6 — "Bill", part 2 of 4): invoices + the e-invoice seam.
-- An invoice is IMMUTABLE once issued (§4.7): a cleared invoice is never cancelled —
-- it is corrected by a credit_note referencing corrects_invoice_id (F-8). Cancel is
-- allowed PRE-issuance/clearance only. kind = invoice | credit_note; is_export carries
-- zero-rating; VAT recorded per document, never assumed (D-1.3). customer snapshot +
-- tax_reg_no survive master changes (D-1.6). base amount frozen at issuance (OP-8).
-- einvoice_submission is the provider-agnostic satellite (D4) — S6 runs it against a
-- FAKE provider; real submission is credential-gated (owner action). Forward-only.

create table public.invoice (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  kind text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  corrects_invoice_id uuid, -- a credit_note references the invoice it corrects (F-8)
  customer_id uuid,
  customer_name text,
  customer_tax_reg_no text,
  job_id uuid,
  quote_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'partially_paid', 'paid', 'cancelled')),
  is_export boolean not null default false, -- zero-rated export supply
  currency char(3) not null default 'AED'
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  subtotal_minor bigint not null default 0,
  vat_amount_minor bigint not null default 0,
  total_minor bigint not null default 0,
  base_total_minor bigint not null default 0,
  issued_at timestamptz,
  due_date date,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) between 1 and 500),
  pdf_file_id uuid references public.file (id),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_id_org_uq unique (id, org_id),
  constraint invoice_ref_uq unique (org_id, reference),
  -- A credit_note (kind) can be negative-signed by the app; totals are stored as the
  -- document's own signed magnitude but kept non-negative here and signed in AR math.
  constraint invoice_total_ck check (total_minor = subtotal_minor + vat_amount_minor),
  constraint invoice_credit_note_ck check (kind <> 'credit_note' or corrects_invoice_id is not null),
  -- issued_at is set at issuance and required thereafter; a DRAFT or a draft that
  -- was CANCELLED pre-issuance (void, never issued) legitimately has none.
  constraint invoice_issued_ck check (status in ('draft', 'cancelled') or issued_at is not null),
  constraint invoice_cancel_ck check (status <> 'cancelled' or cancel_reason is not null)
);
create index invoice_org_status_idx on public.invoice (org_id, status, issued_at);
create index invoice_org_customer_idx on public.invoice (org_id, customer_id);
create index invoice_org_job_idx on public.invoice (org_id, job_id);
create index invoice_org_due_idx on public.invoice (org_id, due_date)
  where status in ('issued', 'partially_paid');
alter table public.invoice
  add constraint invoice_customer_org_fk foreign key (customer_id, org_id)
  references public.customer (id, org_id) on delete restrict;
alter table public.invoice
  add constraint invoice_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.invoice
  add constraint invoice_quote_org_fk foreign key (quote_id, org_id)
  references public.quote (id, org_id) on delete restrict;
alter table public.invoice
  add constraint invoice_corrects_org_fk foreign key (corrects_invoice_id, org_id)
  references public.invoice (id, org_id) on delete restrict;
alter table public.invoice enable row level security;
create policy invoice_select on public.invoice
  for select to app_user using (org_id = (select app.current_org_id()));
create policy invoice_insert on public.invoice
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy invoice_update on public.invoice
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.invoice to app_user;
-- Issued invoices are immutable except status (payment reconciliation), the cancel
-- fields (pre-issuance only, service-guarded), issued_at, due_date, and the PDF id.
-- No DELETE grant (corrections = credit notes / void, D-1.7).
grant update (status, issued_at, due_date, cancelled_at, cancel_reason, pdf_file_id, updated_at)
  on public.invoice to app_user;

create table public.invoice_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  invoice_id uuid not null,
  description text not null check (length(description) between 1 and 300),
  qty numeric(14, 3) not null check (qty > 0),
  unit text not null check (length(unit) between 1 and 16),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  vat_rate numeric(5, 2) not null default 0 check (vat_rate >= 0 and vat_rate <= 100),
  line_total_minor bigint not null default 0 check (line_total_minor >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index invoice_line_idx on public.invoice_line (org_id, invoice_id, sort);
alter table public.invoice_line
  add constraint invoice_line_invoice_org_fk foreign key (invoice_id, org_id)
  references public.invoice (id, org_id) on delete restrict;
alter table public.invoice_line enable row level security;
create policy invoice_line_select on public.invoice_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy invoice_line_insert on public.invoice_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Draft-only line edits (an issued invoice's lines are immutable, §4.7).
create policy invoice_line_update on public.invoice_line
  for update to app_user
  using (org_id = (select app.current_org_id())
    and exists (select 1 from public.invoice i where i.id = invoice_id
      and i.org_id = (select app.current_org_id()) and i.status = 'draft'))
  with check (org_id = (select app.current_org_id()));
-- No DELETE grant (D-1.7 no-hard-delete); issued lines are immutable and drafts are
-- edited by rewrite, never a hard delete.
grant select, insert on public.invoice_line to app_user;
grant update (description, qty, unit, unit_price_minor, vat_rate, line_total_minor, sort)
  on public.invoice_line to app_user;

-- ── einvoice_submission (D4 provider-agnostic satellite; FAKE provider in S6) ──
create table public.einvoice_submission (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  invoice_id uuid not null,
  provider text not null default 'fake',
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'cleared', 'rejected')),
  external_id text,
  cleared_at timestamptz,
  error text check (error is null or length(error) <= 1000),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_one_per_invoice_uq unique (org_id, invoice_id)
);
create index einvoice_org_status_idx on public.einvoice_submission (org_id, status);
alter table public.einvoice_submission
  add constraint einvoice_invoice_org_fk foreign key (invoice_id, org_id)
  references public.invoice (id, org_id) on delete restrict;
alter table public.einvoice_submission enable row level security;
create policy einvoice_select on public.einvoice_submission
  for select to app_user using (org_id = (select app.current_org_id()));
create policy einvoice_insert on public.einvoice_submission
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy einvoice_update on public.einvoice_submission
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.einvoice_submission to app_user;
grant update (provider, status, external_id, cleared_at, error, attempts, updated_at)
  on public.einvoice_submission to app_user;
