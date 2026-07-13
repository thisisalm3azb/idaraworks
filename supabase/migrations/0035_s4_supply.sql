-- 0035_s4_supply (S4 part 2 of 2): the MR → PO → GRN supply chain (doc 01).
-- Reference serials via public.reference_sequence (the job pattern, reused). Money
-- in minor units; cost fields are redacted per role at the SERVICE serialization
-- boundary (F-23), not by RLS (procurement/manager/accounts see POs; foreman does
-- not — doc 06). cost_only: NO stock ledger in the MVP. No-hard-delete: cancel/void.
-- Forward-only.

-- Composite (id, org_id) uniques the child FKs pin against (item already has one).
alter table public.supplier add constraint supplier_id_org_uq unique (id, org_id);

-- ── material_request (+ lines) ───────────────────────────────────────────────
create table public.material_request (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  job_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'converted', 'cancelled')),
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'high', 'urgent')),
  required_date date,
  -- Snapshot of the lines' estimated total (for the approval subject_summary). Cost
  -- data — redacted for non-finance viewers at serialization.
  total_minor bigint not null default 0 check (total_minor >= 0),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  converted_po_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_request_id_org_uq unique (id, org_id),
  constraint material_request_ref_uq unique (org_id, reference)
);
create index material_request_org_status_idx on public.material_request (org_id, status, created_at);
create index material_request_org_job_idx on public.material_request (org_id, job_id);
alter table public.material_request
  add constraint material_request_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.material_request enable row level security;
create policy material_request_select on public.material_request
  for select to app_user using (org_id = (select app.current_org_id()));
create policy material_request_insert on public.material_request
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy material_request_update on public.material_request
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.material_request to app_user;
grant update (status, urgency, required_date, total_minor, notes, converted_po_id, updated_at)
  on public.material_request to app_user;

create table public.material_request_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  mr_id uuid not null,
  item_id uuid,
  item_name text not null check (length(item_name) between 1 and 160),
  qty numeric(14, 3) not null check (qty > 0),
  unit text not null check (length(unit) between 1 and 16),
  est_unit_cost_minor bigint check (est_unit_cost_minor is null or est_unit_cost_minor >= 0),
  sort integer not null default 0,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
create index material_request_line_idx on public.material_request_line (org_id, mr_id, sort);
alter table public.material_request_line
  add constraint mr_line_mr_org_fk foreign key (mr_id, org_id)
  references public.material_request (id, org_id) on delete restrict;
alter table public.material_request_line
  add constraint mr_line_item_org_fk foreign key (item_id, org_id)
  references public.item (id, org_id) on delete restrict;
alter table public.material_request_line enable row level security;
create policy mr_line_select on public.material_request_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy mr_line_insert on public.material_request_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy mr_line_update on public.material_request_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.material_request_line to app_user;
grant update (item_id, item_name, qty, unit, est_unit_cost_minor, sort, superseded_at)
  on public.material_request_line to app_user;

-- ── purchase_order (+ lines) ─────────────────────────────────────────────────
create table public.purchase_order (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  supplier_id uuid not null,
  job_id uuid,
  mr_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled')),
  vat_minor bigint not null default 0 check (vat_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  pdf_file_id uuid references public.file (id),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_order_id_org_uq unique (id, org_id),
  constraint purchase_order_ref_uq unique (org_id, reference)
);
create index purchase_order_org_status_idx on public.purchase_order (org_id, status, created_at);
create index purchase_order_org_job_idx on public.purchase_order (org_id, job_id);
alter table public.purchase_order
  add constraint po_supplier_org_fk foreign key (supplier_id, org_id)
  references public.supplier (id, org_id) on delete restrict;
alter table public.purchase_order
  add constraint po_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.purchase_order
  add constraint po_mr_org_fk foreign key (mr_id, org_id)
  references public.material_request (id, org_id) on delete restrict;
alter table public.purchase_order enable row level security;
create policy purchase_order_select on public.purchase_order
  for select to app_user using (org_id = (select app.current_org_id()));
create policy purchase_order_insert on public.purchase_order
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy purchase_order_update on public.purchase_order
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.purchase_order to app_user;
grant update (status, supplier_id, job_id, mr_id, vat_minor, total_minor, pdf_file_id,
  notes, approved_at, updated_at) on public.purchase_order to app_user;

create table public.purchase_order_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  po_id uuid not null,
  item_id uuid,
  item_name text not null check (length(item_name) between 1 and 160),
  qty numeric(14, 3) not null check (qty > 0),
  unit text not null check (length(unit) between 1 and 16),
  unit_cost_minor bigint not null default 0 check (unit_cost_minor >= 0),
  line_total_minor bigint not null default 0 check (line_total_minor >= 0),
  sort integer not null default 0,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint po_line_id_org_uq unique (id, org_id)
);
create index purchase_order_line_idx on public.purchase_order_line (org_id, po_id, sort);
alter table public.purchase_order_line
  add constraint po_line_po_org_fk foreign key (po_id, org_id)
  references public.purchase_order (id, org_id) on delete restrict;
alter table public.purchase_order_line
  add constraint po_line_item_org_fk foreign key (item_id, org_id)
  references public.item (id, org_id) on delete restrict;
alter table public.purchase_order_line enable row level security;
create policy po_line_select on public.purchase_order_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy po_line_insert on public.purchase_order_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy po_line_update on public.purchase_order_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.purchase_order_line to app_user;
grant update (item_id, item_name, qty, unit, unit_cost_minor, line_total_minor, sort, superseded_at)
  on public.purchase_order_line to app_user;

-- ── goods_receipt (+ lines: partial-receipt math) ────────────────────────────
create table public.goods_receipt (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  po_id uuid not null,
  job_id uuid,
  status text not null default 'recorded' check (status in ('draft', 'recorded', 'cancelled')),
  received_date date not null,
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goods_receipt_id_org_uq unique (id, org_id),
  constraint goods_receipt_ref_uq unique (org_id, reference)
);
create index goods_receipt_org_po_idx on public.goods_receipt (org_id, po_id, received_date);
alter table public.goods_receipt
  add constraint grn_po_org_fk foreign key (po_id, org_id)
  references public.purchase_order (id, org_id) on delete restrict;
alter table public.goods_receipt
  add constraint grn_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.goods_receipt enable row level security;
create policy goods_receipt_select on public.goods_receipt
  for select to app_user using (org_id = (select app.current_org_id()));
create policy goods_receipt_insert on public.goods_receipt
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy goods_receipt_update on public.goods_receipt
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.goods_receipt to app_user;
grant update (status, received_date, notes, updated_at) on public.goods_receipt to app_user;

create table public.goods_receipt_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  grn_id uuid not null,
  po_line_id uuid not null,
  ordered_qty numeric(14, 3) not null check (ordered_qty >= 0),
  previously_received numeric(14, 3) not null default 0 check (previously_received >= 0),
  received_qty numeric(14, 3) not null default 0 check (received_qty >= 0),
  damaged_qty numeric(14, 3) not null default 0 check (damaged_qty >= 0),
  rejected_qty numeric(14, 3) not null default 0 check (rejected_qty >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index goods_receipt_line_idx on public.goods_receipt_line (org_id, grn_id, sort);
alter table public.goods_receipt_line
  add constraint grn_line_grn_org_fk foreign key (grn_id, org_id)
  references public.goods_receipt (id, org_id) on delete restrict;
alter table public.goods_receipt_line
  add constraint grn_line_po_line_org_fk foreign key (po_line_id, org_id)
  references public.purchase_order_line (id, org_id) on delete restrict;
alter table public.goods_receipt_line enable row level security;
create policy grn_line_select on public.goods_receipt_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy grn_line_insert on public.goods_receipt_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.goods_receipt_line to app_user;
-- GRN lines are an immutable receipt record: no UPDATE/DELETE grant (a correction
-- is a new GRN, or a cancel of the GRN — the audit heartbeat rule).
