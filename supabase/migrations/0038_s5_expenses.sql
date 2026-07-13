-- 0038_s5_expenses (S5 — "Measure", part 1 of 3): the expense entity (doc 01 L4).
-- Expenses are a COST channel disjoint from POs (audit F-2): an expense may NOT
-- reference a purchase order — enforced STRUCTURALLY here (there is no po_id column
-- to set) and by the service. Money in minor units, VAT recorded per document
-- (D-1.3). Each expense snapshots its category's costing_mapping (D-1.6) so the
-- costing spine knows whether it hits job cost. No-hard-delete: void with a
-- mandatory reason (D-1.7). Reference serials via reference_sequence. Forward-only.

create table public.expense (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  -- job_id null = org overhead (P1: overhead is a deliberate choice, not an omission).
  job_id uuid,
  job_name text, -- D-1.6 snapshot: survives job rename; null for overhead
  category_key text not null check (length(category_key) between 1 and 60),
  -- Snapshot of the category's costing_mapping AT ENTRY (doc 08 / F-2 dedup): which
  -- expenses feed the job cost sum. Frozen so a later category re-map never rewrites
  -- historical cost.
  costing_mapping text not null
    check (costing_mapping in ('job_materials', 'job_other', 'overhead')),
  description text not null check (length(description) between 1 and 500),
  expense_date date not null,
  -- Ex-VAT net, the recorded VAT, and the gross — all three recorded, never assumed
  -- (D-1.3). The costing basis (ex/inc-VAT per org registration, F-53/PB-3) chooses
  -- which the engine sums.
  amount_minor bigint not null check (amount_minor >= 0),
  vat_amount_minor bigint not null default 0 check (vat_amount_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid')),
  receipt_file_id uuid references public.file (id),
  created_by uuid not null references public.user_profile (id),
  -- No-hard-delete: void carries who/when/why (D-1.7). Voided rows are excluded
  -- from every cost aggregate by the costing engine.
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 500),
  voided_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_id_org_uq unique (id, org_id),
  constraint expense_ref_uq unique (org_id, reference),
  -- The gross must equal net + VAT (integrity; the engine trusts these columns).
  constraint expense_total_ck check (total_minor = amount_minor + vat_amount_minor),
  -- A void must carry its reason (doc 10 #18).
  constraint expense_void_reason_ck check (voided_at is null or void_reason is not null)
);
create index expense_org_job_idx on public.expense (org_id, job_id);
create index expense_org_date_idx on public.expense (org_id, expense_date);
create index expense_org_category_idx on public.expense (org_id, category_key);
alter table public.expense
  add constraint expense_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.expense enable row level security;
create policy expense_select on public.expense
  for select to app_user using (org_id = (select app.current_org_id()));
create policy expense_insert on public.expense
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy expense_update on public.expense
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.expense to app_user;
-- Only void + payment fields are mutable post-create (an expense's amount/category
-- is immutable — a correction is a void + a new expense, the money-record rule
-- §4.7). No DELETE grant (D-1.7). The expenses.void archetype gate (owner/admin/
-- accounts) is the SERVICE assertCan; RLS is the org backstop.
grant update (payment_status, voided_at, void_reason, voided_by, updated_at)
  on public.expense to app_user;
