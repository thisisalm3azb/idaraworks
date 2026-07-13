-- 0043_s6_payments (S6 — "Bill", part 3 of 4): payments + printable receipts.
-- payment is the money-in record and an APPROVABLE subject: recording it creates the
-- payment (status 'recorded'); if the org installed a payment approval rule (OP-7
-- mode always | amount_gte), an approval routes it to owner/admin who Confirm
-- (recorded → confirmed) or Reject (→ rejected). Mode 'none' leaves it 'recorded'.
-- payment_receipt is the serial-numbered printable wrapper (C-2 rename; the PB-8
-- draft→approve ritual is SUPERSEDED by OP-7 payment approval). Void-never-delete.
-- AR counts payments in ('recorded','confirmed'). Forward-only.

create table public.payment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  invoice_id uuid,
  job_id uuid,
  customer_id uuid,
  customer_name text,
  status text not null default 'recorded'
    check (status in ('recorded', 'confirmed', 'rejected', 'void')),
  method text not null default 'bank_transfer'
    check (method in ('cash', 'bank_transfer', 'cheque', 'card', 'other')),
  payment_date date not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null default 'AED'
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount_minor bigint not null default 0 check (base_amount_minor >= 0),
  external_reference text check (external_reference is null or length(external_reference) <= 200),
  rejected_reason text check (rejected_reason is null or length(rejected_reason) <= 500),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 500),
  voided_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_id_org_uq unique (id, org_id),
  constraint payment_ref_uq unique (org_id, reference),
  -- A payment reject is driven by the approval engine (status-only transition); the
  -- rejection REASON is the approval's decision_note, so rejected_reason is optional
  -- context here (no CHECK — else the engine's status update would violate it).
  constraint payment_void_ck check (voided_at is null or void_reason is not null)
);
create index payment_org_status_idx on public.payment (org_id, status, payment_date);
create index payment_org_invoice_idx on public.payment (org_id, invoice_id);
create index payment_org_job_idx on public.payment (org_id, job_id);
alter table public.payment
  add constraint payment_invoice_org_fk foreign key (invoice_id, org_id)
  references public.invoice (id, org_id) on delete restrict;
alter table public.payment
  add constraint payment_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.payment
  add constraint payment_customer_org_fk foreign key (customer_id, org_id)
  references public.customer (id, org_id) on delete restrict;
alter table public.payment enable row level security;
create policy payment_select on public.payment
  for select to app_user using (org_id = (select app.current_org_id()));
create policy payment_insert on public.payment
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy payment_update on public.payment
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.payment to app_user;
-- Status transitions (approval), and void fields; no DELETE grant (D-1.7).
grant update (status, rejected_reason, voided_at, void_reason, voided_by, updated_at)
  on public.payment to app_user;

create table public.payment_receipt (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  payment_id uuid not null,
  reference text not null,
  issued_at timestamptz not null default now(),
  pdf_file_id uuid references public.file (id),
  created_at timestamptz not null default now(),
  constraint payment_receipt_payment_uq unique (org_id, payment_id),
  constraint payment_receipt_ref_uq unique (org_id, reference)
);
alter table public.payment_receipt
  add constraint payment_receipt_payment_org_fk foreign key (payment_id, org_id)
  references public.payment (id, org_id) on delete restrict;
alter table public.payment_receipt enable row level security;
create policy payment_receipt_select on public.payment_receipt
  for select to app_user using (org_id = (select app.current_org_id()));
create policy payment_receipt_insert on public.payment_receipt
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy payment_receipt_update on public.payment_receipt
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.payment_receipt to app_user;
grant update (pdf_file_id) on public.payment_receipt to app_user;
