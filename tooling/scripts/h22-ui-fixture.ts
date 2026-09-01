/**
 * Seed one organization with enough stock and asset data to LOOK at.
 *
 * The screens are the part of H22 no assertion can fully cover: whether a
 * number is readable at 375px, whether Arabic actually renders right to left,
 * whether the navigation reaches the pages at all. That needs a person or a
 * browser looking at a real page with real data in it, which needs data.
 *
 * Deliberately pointed at the TEST project, never production: it leaves the
 * fixture in place to be browsed, so it must not be pointed anywhere it would
 * matter. `--wipe` removes it.
 *
 *   npx tsx tooling/scripts/h22-ui-fixture.ts          seed, print the sign-in
 *   npx tsx tooling/scripts/h22-ui-fixture.ts --wipe   remove it
 */
import "./load-env-integration";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Ctx } from "@/platform/tenancy";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { createPurchaseOrder, recordGoodsReceipt } from "@/modules/supply/service";
import { postGoodsReceiptToStock, postMovement } from "@/modules/inventory/service";
import {
  createAssetCategory,
  registerAsset,
  setAssetStatus,
  assignAsset,
  recordInspection,
  createMaintenancePlan,
} from "@/modules/assets/service";

const MARKER = "fixture.h22_ui";
const owner = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

async function wipe(): Promise<void> {
  const marked = (await owner`
    select org_id::text as id from public.app_settings where key = ${MARKER}`) as unknown as Array<{
    id: string;
  }>;
  const ids = marked.map((m) => m.id);
  if (ids.length === 0) {
    console.log("nothing to remove");
    return;
  }
  const users = (await owner`
    select user_id::text as id from public.membership where org_id = any(${ids}::uuid[])`) as unknown as Array<{
    id: string;
  }>;
  const tables = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tables) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    await tx.unsafe("set local session_replication_role = default");
    const uids = users.map((u) => u.id);
    if (uids.length) {
      await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [uids]);
      await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [uids]);
    }
  });
  console.log(`removed ${ids.length} fixture organization(s)`);
}

async function seed(): Promise<void> {
  const run = randomUUID().slice(0, 6);
  const email = `h22ui-${run}@example.invalid`;
  const password = "Fixture-H22-ui!";

  /*
   * Created through the Auth ADMIN API rather than by inserting into auth.users.
   *
   * A hand-written row with a bcrypt hash looks complete and cannot sign in:
   * GoTrue wants an identity record and its own metadata shape alongside it, and
   * refuses without them — with "Sign-in failed" and nothing more. The admin
   * endpoint is the supported way to make an account that actually works.
   */
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "H22 Fixture" },
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
  }
  const userId = created.data.user.id;
  await owner`
    insert into public.user_profile (id, full_name, locale)
    values (${userId}, 'H22 Fixture', 'en')
    on conflict (id) do update set full_name = excluded.full_name`;

  const orgId = await createOrgForUser(userId, {
    name: `H22 UI ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${MARKER}, ${owner.json({ run, created_at: new Date().toISOString() } as never)})
    on conflict (org_id, key) do update set value = excluded.value`;

  const ctx = (): Ctx => ({
    orgId,
    userId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "ui-fixture",
  });

  const unitId = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitId}, ${orgId}, 'EA', 'Each', 'حبة', 'count', 1, true)`;
  const warehouseId = randomUUID();
  await owner`
    insert into public.warehouse (id, org_id, code, name_en, name_ar, created_by)
    values (${warehouseId}, ${orgId}, 'MAIN', 'Main store', 'المستودع الرئيسي', ${userId})`;
  const recv = randomUUID();
  const bay = randomUUID();
  await owner`
    insert into public.stock_location
      (id, org_id, warehouse_id, code, name_en, name_ar, kind, is_default_receiving, is_default_issue)
    values (${recv}, ${orgId}, ${warehouseId}, 'RECV', 'Receiving', 'الاستلام', 'storage', true, true),
           (${bay}, ${orgId}, ${warehouseId}, 'BAY2', 'Bay two', 'الرصيف الثاني', 'storage', false, false)`;
  const supplierId = randomUUID();
  await owner`
    insert into public.supplier (id, org_id, name) values (${supplierId}, ${orgId}, 'Gulf Steel')`;

  /** Items with Arabic names, so the Arabic screens have something to show. */
  const items: Array<{ id: string; sku: string; qty: number; cost: number }> = [];
  const catalogue = [
    { sku: "STL-PLATE", en: "Steel plate 6mm", ar: "لوح فولاذ ٦ ملم", qty: 40, cost: 8500 },
    { sku: "CABLE-25", en: "Cable 25mm", ar: "كابل ٢٥ ملم", qty: 12, cost: 1500 },
    { sku: "BOLT-M12", en: "Bolt M12", ar: "برغي ١٢", qty: 3, cost: 120 },
  ];
  for (const c of catalogue) {
    const id = randomUUID();
    await owner`
      insert into public.item
        (id, org_id, sku, name, name_ar, category_key, unit, item_type, base_unit_id,
         purchase_unit_id, issue_unit_id, tracking, reorder_point, lifecycle, active)
      values (${id}, ${orgId}, ${c.sku}, ${c.en}, ${c.ar}, 'material', 'EA', 'inventory',
              ${unitId}, ${unitId}, ${unitId}, 'none', 10, 'active', true)`;
    items.push({ id, sku: c.sku, qty: c.qty, cost: c.cost });
  }

  // Stock in through the real chain, so the ledger and balances are genuine.
  const po = await createPurchaseOrder(ctx(), "owner", {
    supplierId,
    lines: items.map((i) => ({
      itemId: i.id,
      itemName: i.sku,
      qty: i.qty,
      unit: "EA",
      unitCostMinor: i.cost,
    })),
  });
  await owner`update public.purchase_order set status='approved' where id=${po.id}`;
  const lines = (await owner`
    select id::text as id from public.purchase_order_line where po_id = ${po.id} order by sort`) as unknown as Array<{
    id: string;
  }>;
  const grn = await recordGoodsReceipt(ctx(), "owner", {
    poId: po.id,
    receivedDate: new Date().toISOString().slice(0, 10),
    lines: lines.map((l, i) => ({ poLineId: l.id, receivedQty: items[i]!.qty })),
  });
  await postGoodsReceiptToStock(ctx(), "owner", grn.id);

  // One reservation, so the list shows a promised quantity rather than only zeros.
  await postMovement(ctx(), "owner", {
    itemId: items[0]!.id,
    warehouseId,
    locationId: recv,
    movementType: "reservation",
    qtyDelta: "0",
    reservedDelta: "15",
    unitId,
    idempotencyKey: `ui-${run}-res`,
  });

  const category = await createAssetCategory(ctx(), "owner", {
    code: "PLANT",
    nameEn: "Plant and machinery",
    nameAr: "آلات ومعدات",
    defaultUsefulLifeMonths: 60,
  });
  for (const a of [
    { en: "Compressor 50L", ar: "ضاغط ٥٠ لتر", serial: "CMP-8891", cost: 250_000 },
    { en: "Site generator", ar: "مولد الموقع", serial: "GEN-2210", cost: 780_000 },
  ]) {
    const asset = await registerAsset(ctx(), "owner", {
      nameEn: a.en,
      nameAr: a.ar,
      categoryId: category.id,
      serialNo: a.serial,
      acquisitionCostMinor: a.cost,
      residualValueMinor: Math.round(a.cost / 10),
      usefulLifeMonths: 60,
      currency: "AED",
      acquiredOn: new Date().toISOString().slice(0, 10),
      supplierId,
      warehouseId,
      locationId: recv,
    });
    await setAssetStatus(ctx(), "owner", asset.id, "in_service");
    await assignAsset(ctx(), "owner", {
      assetId: asset.id,
      toUserId: userId,
      reason: "site work",
    });
    await recordInspection(ctx(), "owner", {
      assetId: asset.id,
      inspectedOn: new Date().toISOString().slice(0, 10),
      kind: "safety",
      passed: true,
      conditionFound: "good",
    });
    // Overdue on purpose, so the attention feed and the badge have something.
    const due = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await createMaintenancePlan(ctx(), "owner", {
      assetId: asset.id,
      nameEn: "Quarterly service",
      nameAr: "صيانة ربع سنوية",
      kind: "preventive",
      intervalDays: 90,
      nextDueOn: due,
    });
  }

  console.log("H22 UI FIXTURE — test project\n");
  console.log(`  org      ${orgId}`);
  console.log(`  email    ${email}`);
  console.log(`  password ${password}`);
  console.log(`\n  stock    /o/${orgId}/stock`);
  console.log(`  assets   /o/${orgId}/assets`);
  console.log(`  inbox    /o/${orgId}/inbox`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--wipe")) await wipe();
  else await seed();
}

main()
  .then(async () => {
    await owner.end({ timeout: 5 });
    await closeAppDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error((err as Error).message);
    await owner.end({ timeout: 5 }).catch(() => {});
    await closeAppDb().catch(() => {});
    process.exit(1);
  });
