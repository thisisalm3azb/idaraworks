-- 0084_h22a_inventory_foundation (H22A — units, item extensions, warehouses)
--
-- The catalogue has been live since 0020 with stock deliberately deferred
-- ("catalog live, stock deferred — doc 01 L3"). This migration lays the ground
-- the stock ledger stands on, and nothing more: units that can be converted,
-- items that know what kind of thing they are and how they are tracked, and
-- places that can hold stock.
--
-- NO ledger, balances or movements here. Those arrive in H22B, once these
-- references exist to point at.
--
-- Conventions this migration follows, from the codebase and from the standards
-- research recorded in the H22 report:
--   * Quantities are numeric(20,6). Existing quantity columns are numeric(14,3);
--     20,6 holds every one of those values exactly, so the seam is lossless, and
--     the extra scale covers units that 3 decimals cannot (litres, kilograms,
--     metres). Never float: repeated addition of 0.1 in binary floating point
--     does not sum to a whole, and a stock ledger is nothing but repeated
--     addition.
--   * Money stays BIGINT minor units paired with an explicit currency, because
--     the minor-unit exponent is not always 2 — KWD, BHD and OMR are 3-decimal
--     currencies, and the integer 1000 means 10.00 AED or 1.000 KWD depending
--     entirely on which currency it belongs to. formatMoney already drives the
--     divisor from minorUnitExponent(), so an amount is only meaningful next to
--     its code.
--   * Every table is org-scoped with RLS, carries a (id, org_id) unique so
--     children can pin the tenant in a composite foreign key, and grants no
--     DELETE (D-1.7).

-- ── 0. Composite uniques the ledger will need ───────────────────────────────
-- goods_receipt_line and material_request_line have no (id, org_id) unique, so
-- nothing can composite-FK to them today. The ledger must reference the receipt
-- line a movement came from, so these come first. Adding a unique constraint is
-- additive: it creates an index and rejects nothing that could already exist,
-- because id is already a primary key and is therefore unique on its own.
alter table public.goods_receipt_line
  add constraint goods_receipt_line_id_org_uq unique (id, org_id);
alter table public.material_request_line
  add constraint material_request_line_id_org_uq unique (id, org_id);

-- ── 1. Units of measure ─────────────────────────────────────────────────────
-- Items carry a free-text `unit` today (1..16 chars), and so do quote lines,
-- request lines, order lines and report material lines. Free text cannot be
-- converted: "box" and "Box" and "BOX" are three units, and none of them has a
-- known relationship to "each".
--
-- This table gives a unit an identity, a dimension and a factor toward that
-- dimension's base unit. Conversion is then multiplication, and conversion
-- ACROSS dimensions is impossible by construction rather than by validation:
-- there is no factor between a kilogram and a metre, so the join that would
-- produce one finds nothing.
--
-- Seeded per organization rather than globally because organizations name their
-- own units, and because a global table would need cross-tenant writes.
create table public.unit_of_measure (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- The code as people type it: 'pcs', 'kg', 'm', 'box12'.
  code text not null check (length(code) between 1 and 16),
  name_en text not null check (length(name_en) between 1 and 60),
  name_ar text not null check (length(name_ar) between 1 and 60),
  /*
   * What kind of quantity this measures. A unit may only convert within its own
   * dimension. 'count' is its own dimension because a box of 12 is a count, not
   * a volume, and converting a box to a litre is a category error rather than a
   * missing factor.
   */
  dimension text not null check (dimension in ('count', 'mass', 'volume', 'length', 'area', 'time')),
  /*
   * How many BASE units of this dimension one of this unit is. The base unit of
   * a dimension is the one with factor 1. A kilogram is 1000 grams if the base
   * is the gram; a dozen is 12 if the base is 'each'.
   *
   * numeric(20,10) because conversion factors need more scale than quantities:
   * a fluid ounce in litres is 0.0295735296, and rounding that at 6 places
   * accumulates visibly over a year of movements.
   */
  factor_to_base numeric(20, 10) not null check (factor_to_base > 0),
  is_base boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unit_of_measure_id_org_uq unique (id, org_id),
  constraint unit_of_measure_org_code_uq unique (org_id, code),
  -- A base unit is the one with factor exactly 1; nothing else may claim to be.
  constraint unit_of_measure_base_ck check (not is_base or factor_to_base = 1)
);
create index unit_of_measure_org_idx on public.unit_of_measure (org_id, dimension, active);
-- Exactly one base unit per dimension per organization, so "convert to base" is
-- never ambiguous. Partial, so retired units do not block a replacement base.
create unique index unit_of_measure_one_base_uq
  on public.unit_of_measure (org_id, dimension) where is_base and active;

alter table public.unit_of_measure enable row level security;
create policy unit_of_measure_select on public.unit_of_measure
  for select to app_user using (org_id = (select app.current_org_id()));
create policy unit_of_measure_insert on public.unit_of_measure
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy unit_of_measure_update on public.unit_of_measure
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.unit_of_measure to app_user;
grant update (code, name_en, name_ar, dimension, factor_to_base, is_base, active, updated_at)
  on public.unit_of_measure to app_user;

comment on column public.unit_of_measure.factor_to_base is
  'Multiply a quantity in this unit by this to get the dimension base unit. Conversion across dimensions is impossible: there is no factor between mass and length.';

-- ── 2. Item extensions ──────────────────────────────────────────────────────
-- The item table keeps every column it has. Everything here is additive and
-- nullable or defaulted, so existing rows stay valid and existing code that
-- selects the old columns is unaffected.

alter table public.item
  /*
   * What kind of thing this is. Only 'inventory' and 'asset' affect stock; a
   * service has no quantity to hold, and a consumable is expensed on receipt
   * rather than tracked. The ledger refuses a movement for a kind that cannot
   * hold stock, which is why this is not merely a display label.
   */
  add column item_type text not null default 'inventory'
    check (item_type in ('inventory', 'consumable', 'service', 'asset', 'kit', 'manufactured')),
  add column description_en text check (description_en is null or length(description_en) <= 2000),
  add column name_ar text check (name_ar is null or length(name_ar) <= 160),
  add column description_ar text check (description_ar is null or length(description_ar) <= 2000),
  add column brand text check (brand is null or length(brand) <= 120),

  /*
   * Barcode. Three columns rather than one, because "is this a real GTIN" must
   * not be guessed from the digits at read time.
   *
   *   gtin       — normalised to 14 digits, so GTIN-8/12/13/14 compare equal
   *                and one check-digit routine serves all of them.
   *   gtin_raw   — exactly what was scanned or typed, preserving U.P.C. leading
   *                zeros, which the normalised form destroys.
   *   code_kind  — declared, not inferred. 'gs1_gtin' asserts the organization
   *                holds a GS1 licence for that prefix; 'internal' is a
   *                restricted-circulation code that must never be published to
   *                a trading partner. The product does not verify a licence and
   *                must not imply it does.
   */
  add column gtin text check (gtin is null or gtin ~ '^[0-9]{14}$'),
  add column gtin_raw text check (gtin_raw is null or gtin_raw ~ '^[0-9]{8,14}$'),
  add column code_kind text not null default 'none'
    check (code_kind in ('none', 'gs1_gtin', 'internal')),

  -- Purchasing and issuing may use different units from the stocking unit. Both
  -- convert through unit_of_measure, so a box bought and pieces issued reconcile.
  add column base_unit_id uuid,
  add column purchase_unit_id uuid,
  add column issue_unit_id uuid,

  add column preferred_supplier_id uuid,
  add column supplier_item_code text check (supplier_item_code is null or length(supplier_item_code) <= 64),
  add column tax_category text check (tax_category is null or length(tax_category) <= 40),

  /*
   * Tracking policy. 'none' is the default because most items are fungible.
   * 'lot' and 'serial' change what a movement must carry, and the ledger
   * enforces that in H22B rather than trusting the caller.
   */
  add column tracking text not null default 'none'
    check (tracking in ('none', 'lot', 'serial')),
  add column expiry_tracked boolean not null default false,

  /*
   * Cost method. Null means "follow the organization's default", which is the
   * normal case. An explicit per-item value exists because IAS 2.25 requires the
   * SAME formula for inventories of similar nature and use, not one formula for
   * the whole entity — but the consistency judgement belongs to the accountant,
   * so the system records the choice and its history rather than policing it.
   * LIFO is absent by design: IAS 2.25 does not permit it.
   */
  add column cost_method text
    check (cost_method is null or cost_method in ('weighted_average', 'fifo')),

  /*
   * Whether this item may go negative. Default false everywhere. An override is
   * a deliberate act with a permission and a reason behind it, because a hidden
   * negative balance is a silent lie about what the business holds.
   */
  add column allow_negative_stock boolean not null default false,

  add column reorder_point numeric(20, 6) check (reorder_point is null or reorder_point >= 0),
  add column reorder_qty numeric(20, 6) check (reorder_qty is null or reorder_qty >= 0),
  add column lifecycle text not null default 'active'
    check (lifecycle in ('active', 'inactive', 'discontinued'));

alter table public.item
  add constraint item_base_unit_org_fk foreign key (base_unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  add constraint item_purchase_unit_org_fk foreign key (purchase_unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  add constraint item_issue_unit_org_fk foreign key (issue_unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  add constraint item_preferred_supplier_org_fk foreign key (preferred_supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict;

-- A barcode identifies one item within an organization. Partial so the many
-- items with no barcode do not collide on null.
create unique index item_org_gtin_uq on public.item (org_id, gtin) where gtin is not null;
create index item_org_type_idx on public.item (org_id, item_type, lifecycle);

grant update (
  item_type, description_en, name_ar, description_ar, brand,
  gtin, gtin_raw, code_kind,
  base_unit_id, purchase_unit_id, issue_unit_id,
  preferred_supplier_id, supplier_item_code, tax_category,
  tracking, expiry_tracked, cost_method, allow_negative_stock,
  reorder_point, reorder_qty, lifecycle
) on public.item to app_user;

comment on column public.item.code_kind is
  'Declared, never inferred from the digits. gs1_gtin asserts the organization holds a GS1 licence for the prefix; the product does not verify that and must not imply it does.';
comment on column public.item.cost_method is
  'Null follows the organization default. LIFO is absent by design: IAS 2 does not permit it.';

-- ── 3. Warehouses ───────────────────────────────────────────────────────────
create table public.warehouse (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (length(code) between 1 and 24),
  name_en text not null check (length(name_en) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  address_line text check (address_line is null or length(address_line) <= 300),
  city text check (city is null or length(city) <= 80),
  country text check (country is null or length(country) <= 80),
  phone text check (phone is null or length(phone) <= 32),
  email text check (email is null or length(email) <= 254),
  -- Who answers for what is in it. user_profile, not employee: custody by an
  -- app user is answerable today, and H23 introduces the canonical workforce
  -- record without this having to guess at it now.
  manager_user_id uuid references public.user_profile (id),
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouse_id_org_uq unique (id, org_id),
  constraint warehouse_org_code_uq unique (org_id, code)
);
create index warehouse_org_idx on public.warehouse (org_id, active, name_en);

alter table public.warehouse enable row level security;
create policy warehouse_select on public.warehouse
  for select to app_user using (org_id = (select app.current_org_id()));
create policy warehouse_insert on public.warehouse
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy warehouse_update on public.warehouse
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.warehouse to app_user;
grant update (code, name_en, name_ar, address_line, city, country, phone, email,
              manager_user_id, active, updated_at)
  on public.warehouse to app_user;

-- ── 4. Locations within a warehouse ─────────────────────────────────────────
-- A hierarchy: zone → aisle → rack → shelf → bin, each a row whose parent is the
-- level above. Depth is not fixed, because a small workshop has one zone and a
-- distribution centre has five levels, and forcing either into the other's shape
-- makes the smaller one tedious and the larger one impossible.
create table public.stock_location (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  warehouse_id uuid not null,
  parent_id uuid,
  code text not null check (length(code) between 1 and 24),
  name_en text not null check (length(name_en) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  /*
   * What this place is FOR. 'quarantine', 'damaged' and 'returns' hold stock
   * that exists but is not available to issue, which the balance projection in
   * H22B reads: available stock excludes anything sitting in a kind that is not
   * 'storage'. Recording the intent here means the rule is a property of the
   * place rather than a condition remembered at every call site.
   */
  kind text not null default 'storage'
    check (kind in ('storage', 'receiving', 'dispatch', 'quarantine', 'damaged', 'returns', 'transit')),
  /*
   * Whether stock may physically rest here. A zone is usually a grouping rather
   * than a shelf, and a movement into a grouping is almost always a mistake, so
   * a location must opt in to holding stock.
   */
  can_hold_stock boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_location_id_org_uq unique (id, org_id),
  constraint stock_location_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_location_parent_org_fk foreign key (parent_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  -- A location cannot be its own parent. Deeper cycles are prevented by the
  -- service, which walks the chain; this catches the one-step case for free.
  constraint stock_location_not_self_parent_ck check (parent_id is null or parent_id <> id),
  constraint stock_location_wh_code_uq unique (warehouse_id, code)
);
create index stock_location_org_wh_idx
  on public.stock_location (org_id, warehouse_id, active, kind);
create index stock_location_parent_idx on public.stock_location (parent_id);

alter table public.stock_location enable row level security;
create policy stock_location_select on public.stock_location
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_location_insert on public.stock_location
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_location_update on public.stock_location
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_location to app_user;
grant update (code, name_en, name_ar, kind, can_hold_stock, parent_id, active, updated_at)
  on public.stock_location to app_user;

/*
 * Default places to receive into and issue from.
 *
 * These are flags on the LOCATION, not foreign keys on the warehouse. Putting
 * default_receiving_location_id on warehouse would make warehouse reference
 * stock_location while stock_location references warehouse — a cycle, so
 * neither table can be deleted before the other and any topological ordering of
 * the two is arbitrary. The bleed harness found this immediately.
 *
 * Marking the location is also the better model: a location already declares
 * what it is for through `kind`, and being the default is a property of the
 * place rather than a fact the warehouse remembers about one of its children.
 */
alter table public.stock_location
  add column is_default_receiving boolean not null default false,
  add column is_default_issue boolean not null default false;

-- At most one default of each role per warehouse, and only among locations that
-- can actually hold stock and are still active.
create unique index stock_location_default_receiving_uq
  on public.stock_location (warehouse_id)
  where is_default_receiving and active and can_hold_stock;
create unique index stock_location_default_issue_uq
  on public.stock_location (warehouse_id)
  where is_default_issue and active and can_hold_stock;

alter table public.stock_location
  add constraint stock_location_default_holds_stock_ck
    check ((not is_default_receiving and not is_default_issue) or can_hold_stock);

grant update (is_default_receiving, is_default_issue) on public.stock_location to app_user;

-- ── 5. Per-organization inventory settings ──────────────────────────────────
-- The organization's default cost method and negative-stock stance live in
-- app_settings under 'inventory.policy', beside every other configuration blob,
-- rather than in new columns on org. No schema change is needed for a setting,
-- and the config pipeline already versions, diffs and guards those revisions.
