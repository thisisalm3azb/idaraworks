/**
 * H22 end-to-end production smoke — one marked fixture, removed in `finally`.
 *
 * This is the proof that the H22 system works on the real database, run through
 * the same module functions the screens call. It is NOT a feature demo: every
 * step asserts a property that would be expensive to get wrong, and the whole
 * thing self-destructs whether it passes or fails.
 *
 * What it walks, in the order a business does:
 *   1. a catalogue item LINKED to a purchase order line (the join that was
 *      missing entirely until H22F — without it a receipt can never be stock)
 *   2. a goods receipt recorded the way the receiving desk records one
 *   3. accepted stock landing in the INTENDED warehouse and bin
 *   4. a reservation, which promises stock without moving it
 *   5. consumption through a reviewed daily report — this product's issue document
 *   6. quantity AND value reconciled against the ledger from both directions
 *   7. lot tracking, including a batch that cannot be received without its lot
 *   8. an asset registered, assigned, serviced and retired
 *
 * SAFETY. It creates exactly one organization and one user, both marked as a
 * disposable fixture the moment they exist, and touches nothing else. It never
 * reads or writes another organization's rows. Cleanup runs in `finally` and
 * removes every org-scoped row, then the org, then the user — which cascades
 * its identities and sessions once foreign keys are back on.
 *
 *   npx tsx tooling/scripts/h22-prod-smoke.ts
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createPurchaseOrder, recordGoodsReceipt } from "@/modules/supply/service";
import {
  postGoodsReceiptToStock,
  postConsumptionToStock,
  postMovement,
  listStockLevels,
  listMovements,
  listItemLots,
  itemStock,
  reconcileStockBalances,
} from "@/modules/inventory/service";
import {
  createAssetCategory,
  registerAsset,
  setAssetStatus,
  assignAsset,
  returnAsset,
  recordInspection,
  createMaintenancePlan,
  recordMaintenance,
  assetDetail,
} from "@/modules/assets/service";

const RUN = randomUUID().slice(0, 8);
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

const ownerUser = randomUUID();
let orgId = "";
let warehouseId = "";
let receivingBin = "";
let otherBin = "";
let unitId = "";
let supplierId = "";

const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `h22-smoke-${RUN}`,
});

let passes = 0;
function assert(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`H22 smoke assertion failed: ${label}${detail ? ` — ${detail}` : ""}`);
  passes++;
}

/** Stamp the org as disposable the instant it exists, before anything can fail. */
async function markFixture(): Promise<void> {
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, 'test.fixture', ${owner.json({
      is_test_fixture: true,
      suite: "h22-prod-smoke",
      run: RUN,
      created_at: new Date().toISOString(),
    } as never)})
    on conflict (org_id, key) do update set value = excluded.value`;
}

async function setUp(): Promise<void> {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22smoke-${RUN}@example.invalid`}, '{"full_name":"H22 Smoke"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: `H22 SMOKE ${RUN}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixture();
  console.log(`fixture org ${orgId} (marked test.fixture, run ${RUN})\n`);

  unitId = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitId}, ${orgId}, 'EA', 'Each', 'حبة', 'count', 1, true)`;

  warehouseId = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, created_by)
    values (${warehouseId}, ${orgId}, 'MAIN', 'Main store', ${ownerUser})`;

  receivingBin = randomUUID();
  otherBin = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, kind, is_default_receiving, is_default_issue)
    values (${receivingBin}, ${orgId}, ${warehouseId}, 'RECV', 'Receiving', 'storage', true, true),
           (${otherBin}, ${orgId}, ${warehouseId}, 'BAY2', 'Bay two', 'storage', false, false)`;

  supplierId = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierId}, ${orgId}, 'Smoke Supplier')`;
}

async function anItem(sku: string, tracking = "none"): Promise<string> {
  const id = randomUUID();
  await owner`
    insert into public.item
      (id, org_id, sku, name, name_ar, category_key, unit, item_type, base_unit_id,
       purchase_unit_id, issue_unit_id, tracking, reorder_point, lifecycle, active)
    values (${id}, ${orgId}, ${sku}, ${"Smoke " + sku}, ${"عينة " + sku}, 'material', 'EA',
            'inventory', ${unitId}, ${unitId}, ${unitId}, ${tracking}, 5, 'active', true)`;
  return id;
}

/** An approved order, since approval is not what this is proving. */
async function anApprovedOrder(
  lines: Array<{ itemId?: string; name: string; qty: number; costMinor: number }>,
): Promise<{ id: string; lineIds: Array<{ id: string; itemId: string | null }> }> {
  const { id } = await createPurchaseOrder(ctx(), "owner", {
    supplierId,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      itemName: l.name,
      qty: l.qty,
      unit: "EA",
      unitCostMinor: l.costMinor,
    })),
  });
  await owner`update public.purchase_order set status = 'approved' where id = ${id} and org_id = ${orgId}`;
  const rows = (await owner`
    select id::text as id, item_id::text as item_id
    from public.purchase_order_line where po_id = ${id} and org_id = ${orgId}
    order by sort`) as unknown as Array<{ id: string; item_id: string | null }>;
  return { id, lineIds: rows.map((r) => ({ id: r.id, itemId: r.item_id })) };
}

async function ledgerOnHand(itemId: string): Promise<number> {
  const [r] = (await owner`
    select coalesce(sum(qty_delta), 0)::text as q from public.stock_movement
    where org_id = ${orgId} and item_id = ${itemId}`) as unknown as Array<{ q: string }>;
  return Number(r!.q);
}

// ── 1-3. order → receive → the intended bin ──────────────────────────────────
async function orderReceiveStock(): Promise<string> {
  console.log("ORDER → RECEIVE → STOCK");
  const item = await anItem(`SMK-CABLE-${RUN}`);
  const order = await anApprovedOrder([
    { itemId: item, name: "Cable drum", qty: 20, costMinor: 1500 },
  ]);
  assert(
    "the order line carries the catalogue item",
    order.lineIds[0]!.itemId === item,
    "this is the join that did not exist before H22F",
  );

  const grn = await recordGoodsReceipt(ctx(), "owner", {
    poId: order.id,
    receivedDate: new Date().toISOString().slice(0, 10),
    lines: [{ poLineId: order.lineIds[0]!.id, receivedQty: 20 }],
  });
  const posted = await postGoodsReceiptToStock(ctx(), "owner", grn.id);
  assert("the receipt posted to the ledger", posted.filter((p) => p.posted).length === 1);

  const placed = await itemStock(ctx(), "owner", item);
  assert("stock landed in exactly one place", placed.length === 1);
  assert(
    "accepted stock is in the INTENDED receiving bin",
    placed[0]!.locationId === receivingBin && placed[0]!.warehouseName === "Main store",
    `${placed[0]!.warehouseName} / ${placed[0]!.locationName}`,
  );
  assert("on hand is what arrived", Number(placed[0]!.onHand) === 20);

  // Posting the same receipt again must be a no-op, because the receiving
  // action posts after the receipt commits and a person may retry.
  await postGoodsReceiptToStock(ctx(), "owner", grn.id);
  assert("re-posting the same receipt books nothing new", (await ledgerOnHand(item)) === 20);
  return item;
}

// ── 4. a reservation promises stock without moving it ────────────────────────
async function reserve(item: string): Promise<void> {
  console.log("\nRESERVATION");
  await postMovement(ctx(), "owner", {
    itemId: item,
    warehouseId,
    locationId: receivingBin,
    movementType: "reservation",
    qtyDelta: "0",
    reservedDelta: "8",
    unitId,
    idempotencyKey: `smoke-res-${RUN}`,
  });
  const after = await itemStock(ctx(), "owner", item);
  assert("on hand did not move", Number(after[0]!.onHand) === 20);
  assert("reserved went up", Number(after[0]!.reserved) === 8);
  assert("available came down", Number(after[0]!.available) === 12);

  const seen = await listMovements(ctx(), "owner", { itemId: item });
  const res = seen.rows.find((m) => m.movementType === "reservation");
  assert(
    "the reservation is legible in the ledger",
    res !== undefined && res.reservedDelta === "8",
  );
}

// ── 5-6. consumption, then reconciliation from both directions ───────────────
async function consumeAndReconcile(item: string): Promise<void> {
  console.log("\nCONSUMPTION → RECONCILIATION");
  const jobId = randomUUID();
  const reportId = randomUUID();
  await owner`
    insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
    values (${jobId}, ${orgId}, ${"SMK-J-" + RUN}, 'Smoke wiring', 'active', 'active', ${ownerUser})`;
  await owner`
    insert into public.daily_report (id, org_id, job_id, report_date, summary, status, submitted_by)
    values (${reportId}, ${orgId}, ${jobId}, current_date, 'smoke', 'submitted', ${ownerUser})`;
  await owner`
    insert into public.report_material_line (id, org_id, report_id, item_id, item_name, qty, unit)
    values (${randomUUID()}, ${orgId}, ${reportId}, ${item}, 'Cable drum', 6, 'EA')`;

  const consumed = await postConsumptionToStock(ctx(), "owner", reportId);
  assert("the reviewed report took material out of stock", consumed[0]!.posted === true);
  assert(
    "charged at what it cost coming in, not a list price",
    consumed[0]!.costMinor === 9000,
    `6 x 1500 = 9000, got ${consumed[0]!.costMinor}`,
  );

  const levels = await listStockLevels(ctx(), "owner", { search: `SMK-CABLE-${RUN}` });
  const row = levels.rows[0]!;
  assert("quantity reconciles: 20 in, 6 out", Number(row.onHand) === 14);
  assert("the reservation still stands against what is left", Number(row.available) === 6);
  assert(
    "value follows quantity: 14 remaining at 1500",
    row.valueMinor === 21_000,
    `got ${row.valueMinor}`,
  );
  assert("a single currency, so a total is meaningful", row.valueIsMixedCurrency === false);

  // The balance table and the ledger are two records of the same fact. The
  // reconciler exists to prove they agree; a drift here is the bug that makes
  // every stock figure untrustworthy.
  assert("the balance table agrees with the ledger", (await ledgerOnHand(item)) === 14);
  const drift = await reconcileStockBalances(ctx(), "owner", { repair: false });
  assert(
    "the reconciler finds no drift at all",
    drift.drift.length === 0 && drift.lotDrift.length === 0 && drift.valueDrift.length === 0,
    `checked=${drift.checked} drift=${drift.drift.length} lots=${drift.lotDrift.length} values=${drift.valueDrift.length}`,
  );
}

// ── 7. lot tracking ──────────────────────────────────────────────────────────
async function lotTracking(): Promise<void> {
  console.log("\nLOT TRACKING");
  const item = await anItem(`SMK-SEALANT-${RUN}`, "lot");
  const order = await anApprovedOrder([{ itemId: item, name: "Sealant", qty: 10, costMinor: 800 }]);
  const lotId = randomUUID();
  const expiry = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  await owner`
    insert into public.stock_lot (id, org_id, item_id, code, expiry_date, created_by)
    values (${lotId}, ${orgId}, ${item}, ${"LOT-" + RUN}, ${expiry}, ${ownerUser})`;

  // A tracked item cannot enter the ledger without saying WHICH batch: the
  // database refuses it at commit, not the application.
  let refused = false;
  try {
    await postMovement(ctx(), "owner", {
      itemId: item,
      warehouseId,
      locationId: receivingBin,
      movementType: "goods_receipt",
      qtyDelta: "10",
      unitId,
      currency: "AED",
      unitCostMinor: 800,
      idempotencyKey: `smoke-nolot-${RUN}`,
    });
  } catch {
    refused = true;
  }
  assert("a lot-tracked item cannot be received without its batch", refused);

  await postMovement(ctx(), "owner", {
    itemId: item,
    warehouseId,
    locationId: receivingBin,
    movementType: "goods_receipt",
    qtyDelta: "10",
    unitId,
    currency: "AED",
    unitCostMinor: 800,
    lots: [{ lotId, qty: 10 }],
    idempotencyKey: `smoke-lot-${RUN}`,
  });
  const lots = await listItemLots(ctx(), "owner", item);
  assert("the batch is on the shelf", lots.length === 1 && Number(lots[0]!.onHand) === 10);
  assert("its date is known and not yet past", lots[0]!.expiryDate === expiry && !lots[0]!.expired);
  void order;
}

// ── 8. an asset, through its life ────────────────────────────────────────────
async function assetLifecycle(): Promise<void> {
  console.log("\nASSET LIFECYCLE");
  const category = await createAssetCategory(ctx(), "owner", {
    code: `SMK-${RUN.slice(0, 4)}`,
    nameEn: "Smoke plant",
    nameAr: "معدات العينة",
    defaultUsefulLifeMonths: 60,
  });
  const asset = await registerAsset(ctx(), "owner", {
    nameEn: "Smoke compressor",
    nameAr: "ضاغط العينة",
    categoryId: category.id,
    serialNo: `SN-${RUN}`,
    acquisitionCostMinor: 250_000,
    residualValueMinor: 25_000,
    usefulLifeMonths: 60,
    currency: "AED",
    acquiredOn: new Date().toISOString().slice(0, 10),
    supplierId,
    warehouseId,
    locationId: receivingBin,
  });
  assert("the asset has a number", /^AST-\d{3}$/.test(asset.assetNo), asset.assetNo);
  assert(
    "its scannable identity is not its number",
    asset.qrKey.length > 0 && !asset.qrKey.includes(asset.assetNo),
    "a label encoding a sequence tells any reader how many assets the business owns",
  );

  await setAssetStatus(ctx(), "owner", asset.id, "in_service");
  await assignAsset(ctx(), "owner", {
    assetId: asset.id,
    toUserId: ownerUser,
    reason: "smoke handover",
  });
  await recordInspection(ctx(), "owner", {
    assetId: asset.id,
    inspectedOn: new Date().toISOString().slice(0, 10),
    kind: "safety",
    passed: true,
    conditionFound: "good",
  });
  const plan = await createMaintenancePlan(ctx(), "owner", {
    assetId: asset.id,
    nameEn: "Quarterly service",
    nameAr: "صيانة ربع سنوية",
    kind: "preventive",
    intervalDays: 90,
  });
  await recordMaintenance(ctx(), "owner", {
    assetId: asset.id,
    planId: plan.id,
    kind: "preventive",
    performedOn: new Date().toISOString().slice(0, 10),
    costMinor: 15_000,
    currency: "AED",
  });
  await returnAsset(ctx(), "owner", {
    assetId: asset.id,
    reason: "smoke return",
    conditionAtEvent: "good",
  });

  const detail = await assetDetail(ctx(), "owner", asset.id);
  assert("the register reads back", detail !== null);
  assert(
    "custody is a trail, not a field",
    detail!.custody.length === 2,
    `${detail!.custody.length} events`,
  );
  assert("the inspection is on the record", detail!.inspections.length === 1);
  assert(
    "so is the service, and its plan",
    detail!.maintenance.length === 1 && detail!.plans.length === 1,
  );
  assert(
    "acquisition cost is stored for H24 without a book value being claimed",
    detail!.asset.acquisitionCostMinor === 250_000 &&
      detail!.asset.residualValueMinor === 25_000 &&
      detail!.asset.usefulLifeMonths === 60,
  );

  // Custody events are append-only: the database, not the application, refuses.
  const [firstEvent] = (await owner`
    select id::text as id from public.asset_assignment
    where asset_id = ${asset.id} and org_id = ${orgId} order by created_at limit 1`) as unknown as Array<{
    id: string;
  }>;
  let historyHeld = false;
  try {
    await owner`delete from public.asset_assignment where id = ${firstEvent!.id}`;
  } catch {
    historyHeld = true;
  }
  assert("custody history cannot be deleted, even by the owner role", historyHeld);
}

async function cleanup(): Promise<void> {
  if (!orgId) return;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    // Foreign keys off so the delete order cannot matter; the append-only
    // triggers are disabled by the same switch, which is the only way a fixture
    // that deliberately writes history can be removed at all.
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = $1`, [orgId]);
    }
    await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    // Back on BEFORE the auth deletes, so removing the user cascades its
    // identities and sessions instead of orphaning them.
    await tx.unsafe("set local session_replication_role = default");
    await tx.unsafe(`delete from public.user_profile where id = $1`, [ownerUser]);
    await tx.unsafe(`delete from auth.users where id = $1`, [ownerUser]);
  });
  console.log("\nfixture removed");
}

async function verifyNoResidue(): Promise<void> {
  const [row] = (await owner`
    select
      (select count(*)::int from public.org where id = ${orgId}) as orgs,
      (select count(*)::int from public.stock_movement where org_id = ${orgId}) as movements,
      (select count(*)::int from public.stock_balance where org_id = ${orgId}) as balances,
      (select count(*)::int from public.asset where org_id = ${orgId}) as assets,
      (select count(*)::int from public.file where org_id = ${orgId}) as files,
      (select count(*)::int from public.app_settings where org_id = ${orgId}) as markers,
      (select count(*)::int from auth.users where id = ${ownerUser}) as users,
      (select count(*)::int from auth.identities where user_id = ${ownerUser}) as identities,
      (select count(*)::int from auth.sessions where user_id = ${ownerUser}) as sessions,
      (select count(*)::int from public.user_profile where id = ${ownerUser}) as profiles
  `) as unknown as Array<Record<string, number>>;
  const total = Object.values(row!).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(row!)) {
    console.log(`  ${v === 0 ? "OK  " : "LEFT"}  ${k.padEnd(12)} ${v}`);
  }
  if (total !== 0) throw new Error(`fixture residue remains: ${JSON.stringify(row)}`);
  console.log("  zero residue");
}

async function main(): Promise<void> {
  console.log(`H22 PRODUCTION SMOKE — run ${RUN}\n`);
  await setUp();
  const item = await orderReceiveStock();
  await reserve(item);
  await consumeAndReconcile(item);
  await lotTracking();
  await assetLifecycle();
  console.log(`\nH22 SMOKE PASS — ${passes} assertions`);
}

main()
  .then(async () => {
    await cleanup();
    await verifyNoResidue();
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\nH22 SMOKE FAILED: ${(err as Error).message}`);
    // The fixture goes whether it passed or not. A failed run that leaves an
    // organization behind in production is a second problem on top of the first.
    await cleanup().catch((e) => console.error(`cleanup also failed: ${(e as Error).message}`));
    await verifyNoResidue().catch((e) => console.error(`residue check: ${(e as Error).message}`));
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
