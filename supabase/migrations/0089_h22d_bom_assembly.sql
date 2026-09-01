-- 0089_h22d_bom_assembly (H22D, part 2)
--
-- What a thing is made of, and the act of making it.
--
-- H22B declared the movement types 'assembly_consume', 'assembly_produce',
-- 'disassembly_consume' and 'disassembly_produce' so the vocabulary would be
-- stable, and said nothing would post them until the slice that owns them
-- existed. This is that slice.

-- ── 1. Bills of material ────────────────────────────────────────────────────
/*
 * A recipe: this many of the parent, from these components.
 *
 * `output_qty` exists because recipes are not always per-one. A batch that makes
 * 500 litres from a component list is stated as it is used rather than divided
 * down into a per-litre fiction that then has to be multiplied back.
 *
 * Versions rather than edits. A bill of material is referenced by every assembly
 * built from it, so changing one in place would silently restate what was made
 * last year. A new version is a new row and the old one is archived.
 */
create table public.bom (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  output_qty numeric(20, 6) not null default 1 check (output_qty > 0),
  unit_id uuid not null,
  notes text check (notes is null or length(notes) <= 2000),
  effective_from date,
  archived_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bom_id_org_uq unique (id, org_id),
  constraint bom_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint bom_unit_org_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint bom_version_uq unique (org_id, item_id, version),
  constraint bom_archived_ck check ((status = 'archived') = (archived_at is not null))
);
-- One recipe in force at a time. "Which BOM was used" must never be a guess.
create unique index bom_active_uq on public.bom (org_id, item_id) where status = 'active';
create index bom_item_idx on public.bom (org_id, item_id, status);

create table public.bom_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  bom_id uuid not null,
  component_item_id uuid not null,
  qty_per numeric(20, 6) not null check (qty_per > 0),
  unit_id uuid not null,
  /*
   * Expected loss, as a percentage of the component quantity. Recorded on the
   * recipe because it is a property of the process, not of the day: a material
   * that always loses 3% in cutting needs 103% issued to make the parent.
   */
  scrap_pct numeric(6, 3) not null default 0 check (scrap_pct >= 0 and scrap_pct < 100),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint bom_line_id_org_uq unique (id, org_id),
  constraint bom_line_bom_fk foreign key (bom_id, org_id)
    references public.bom (id, org_id) on delete restrict,
  constraint bom_line_item_org_fk foreign key (component_item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint bom_line_unit_org_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  -- One line per component: two lines for the same thing is an error somebody
  -- has to resolve, not a quantity to be added up silently.
  constraint bom_line_once_uq unique (bom_id, component_item_id)
);
create index bom_line_bom_idx on public.bom_line (org_id, bom_id);

/*
 * Nothing is made of itself.
 *
 * This catches the one-step case, which is the one people actually type. Longer
 * cycles (A needs B, B needs A) are walked by activateBom, because activation is
 * where a recipe starts having to be resolvable and because the depth is
 * unbounded — a trigger recursing on every insert would pay that cost on every
 * line of every draft.
 */
create function app.bom_line_is_not_self()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  parent uuid;
begin
  select b.item_id into parent from public.bom b
  where b.id = new.bom_id and b.org_id = new.org_id;
  if parent = new.component_item_id then
    raise exception 'an item cannot be a component of itself'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.bom_line_is_not_self() from public;

create trigger bom_line_not_self
  before insert on public.bom_line
  for each row execute function app.bom_line_is_not_self();

alter table public.bom enable row level security;
create policy bom_select on public.bom
  for select to app_user using (org_id = (select app.current_org_id()));
create policy bom_insert on public.bom
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy bom_update on public.bom
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bom to app_user;
grant update (status, output_qty, notes, effective_from, archived_at, updated_at)
  on public.bom to app_user;

alter table public.bom_line enable row level security;
create policy bom_line_select on public.bom_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy bom_line_insert on public.bom_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy bom_line_update on public.bom_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bom_line to app_user;
grant update (qty_per, scrap_pct, sort) on public.bom_line to app_user;

comment on table public.bom is
  'Versioned. An active BOM is referenced by everything built from it, so a change is a new version and the old one is archived, never edited.';

-- ── 2. Making and unmaking ──────────────────────────────────────────────────
/*
 * One act of assembly or disassembly.
 *
 * The components are COPIED onto the order when it is created, not read from the
 * BOM at completion. A recipe can be revised between planning and building, and
 * what was actually consumed must not change retroactively because somebody
 * edited the recipe afterwards.
 */
create table public.assembly_order (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  direction text not null check (direction in ('assemble', 'disassemble')),
  item_id uuid not null,
  bom_id uuid,
  qty numeric(20, 6) not null check (qty > 0),
  unit_id uuid not null,
  warehouse_id uuid not null,
  location_id uuid,
  status text not null default 'draft' check (status in ('draft', 'completed', 'cancelled')),
  notes text check (notes is null or length(notes) <= 2000),
  completed_at timestamptz,
  completed_by uuid references public.user_profile (id),
  cancelled_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assembly_order_id_org_uq unique (id, org_id),
  constraint assembly_order_ref_uq unique (org_id, reference),
  constraint assembly_order_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint assembly_order_bom_org_fk foreign key (bom_id, org_id)
    references public.bom (id, org_id) on delete restrict,
  constraint assembly_order_unit_org_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint assembly_order_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint assembly_order_location_org_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint assembly_order_completed_ck check ((status = 'completed') = (completed_at is not null)),
  constraint assembly_order_cancelled_ck check ((status = 'cancelled') = (cancelled_at is not null))
);
create index assembly_order_org_idx
  on public.assembly_order (org_id, status, created_at desc);

create table public.assembly_order_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  order_id uuid not null,
  component_item_id uuid not null,
  qty numeric(20, 6) not null check (qty > 0),
  unit_id uuid not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint assembly_order_line_id_org_uq unique (id, org_id),
  constraint assembly_order_line_order_fk foreign key (order_id, org_id)
    references public.assembly_order (id, org_id) on delete restrict,
  constraint assembly_order_line_item_org_fk foreign key (component_item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint assembly_order_line_unit_org_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint assembly_order_line_once_uq unique (order_id, component_item_id)
);
create index assembly_order_line_order_idx on public.assembly_order_line (org_id, order_id);

alter table public.assembly_order enable row level security;
create policy assembly_order_select on public.assembly_order
  for select to app_user using (org_id = (select app.current_org_id()));
create policy assembly_order_insert on public.assembly_order
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy assembly_order_update on public.assembly_order
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.assembly_order to app_user;
grant update (status, notes, location_id, completed_at, completed_by, cancelled_at, updated_at)
  on public.assembly_order to app_user;

alter table public.assembly_order_line enable row level security;
create policy assembly_order_line_select on public.assembly_order_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy assembly_order_line_insert on public.assembly_order_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy assembly_order_line_update on public.assembly_order_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.assembly_order_line to app_user;
grant update (qty, sort) on public.assembly_order_line to app_user;

-- The ledger learns where an assembly movement comes from.
alter table public.stock_movement drop constraint if exists stock_movement_source_type_ck;
alter table public.stock_movement
  add constraint stock_movement_source_type_ck check (source_type in (
    'goods_receipt_line', 'report_material_line', 'stock_transfer',
    'stock_count_line', 'supplier_return_line',
    'assembly_order', 'assembly_order_line', 'manual'
  ));

create or replace function app.validate_stock_movement_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  found boolean;
begin
  if new.source_id is null or new.source_type = 'manual' then
    return new;
  end if;

  if new.source_type = 'goods_receipt_line' then
    select exists (select 1 from public.goods_receipt_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'report_material_line' then
    select exists (select 1 from public.report_material_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'stock_transfer' then
    select exists (select 1 from public.stock_transfer x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'stock_count_line' then
    select exists (select 1 from public.stock_count_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'supplier_return_line' then
    select exists (select 1 from public.supplier_return_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'assembly_order' then
    select exists (select 1 from public.assembly_order x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'assembly_order_line' then
    select exists (select 1 from public.assembly_order_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  else
    raise exception 'stock_movement source % is not a known source type', new.source_type
      using errcode = 'check_violation';
  end if;

  if not found then
    raise exception 'stock_movement: no % in this organization for the given source_id',
      new.source_type using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.validate_stock_movement_source() from public;

comment on table public.assembly_order is
  'Components are copied onto the order at creation, not read from the BOM at completion: a recipe revised in between must not restate what was actually consumed.';
