/**
 * The asset register (H22E): categories, assets, identity and custody.
 *
 * An asset is a thing the organization OWNS AND USES, as distinct from stock,
 * which it holds to consume or sell. The distinction is not academic: stock is
 * counted in aggregate and issued anonymously, while an asset is a named
 * individual with a custodian, a service history and an end of life.
 *
 * Three rules shape this module.
 *
 * A CUSTODIAN IS A MEMBER. Not an employee row — people are H23's subject, and a
 * second person model here would have to be reconciled with that one later. The
 * database checks the membership, so it holds for every writer.
 *
 * CUSTODY IS A LEDGER. `asset.custodian_user_id` is a convenience; the truth is
 * the append-only `asset_assignment` trail, because "who had the drill in March"
 * is exactly the question an editable field cannot answer.
 *
 * RECEIVING PRESERVES HISTORY. Registering a serialised unit as an asset ADDS a
 * record; it never deletes the unit, the receipt line or a ledger movement.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { command } from "@/platform/audit";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import type { RoleArchetype } from "@/platform/registries";

export class AssetError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "AssetError";
  }
}
export class AssetStateError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "AssetStateError";
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CURRENCY = z.enum(["AED", "SAR", "QAR", "KWD", "BHD", "OMR", "USD", "EUR"]);

// ── Categories ──────────────────────────────────────────────────────────────
export const CreateAssetCategoryInput = z.object({
  code: z.string().trim().min(1).max(32),
  nameEn: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  parentId: z.string().uuid().optional(),
  /** Defaults an asset COPIES at registration. H24 uses them; H22 does not. */
  defaultUsefulLifeMonths: z.number().int().positive().max(1200).optional(),
  defaultResidualPct: z.number().min(0).max(99.999).optional(),
});

export async function createAssetCategory(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "assets.manage");
  const data = CreateAssetCategoryInput.parse(input);
  const id = randomUUID();

  return command<{ id: string }>(
    ctx,
    {
      audit: {
        action: "asset.category_created",
        entityType: "asset",
        entityId: id,
        summary: `Created asset category ${data.code}`,
      },
    },
    async (tx) => {
      if (data.parentId) {
        // A tree that loops has no root, and every walk over it runs forever.
        if (await categoryDescendsFrom(tx, ctx, data.parentId, id, 0)) {
          throw new AssetError("that parent is below this category in the tree");
        }
      }
      await tx.execute(sql`
        insert into public.asset_category
          (id, org_id, parent_id, code, name_en, name_ar, default_useful_life_months,
           default_residual_pct, created_by)
        values (${id}, ${ctx.orgId}, ${data.parentId ?? null}, ${data.code}, ${data.nameEn},
                ${data.nameAr ?? null}, ${data.defaultUsefulLifeMonths ?? null},
                ${data.defaultResidualPct ?? null}, ${ctx.userId})
      `);
      return { id };
    },
  );
}

async function categoryDescendsFrom(
  tx: TenantTx,
  ctx: Ctx,
  categoryId: string,
  needle: string,
  depth: number,
): Promise<boolean> {
  if (depth > 20) return false;
  const rows = (await tx.execute(sql`
    select parent_id::text as parent_id from public.asset_category
    where id = ${categoryId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ parent_id: string | null }>;
  const parent = rows[0]?.parent_id;
  if (!parent) return false;
  if (parent === needle) return true;
  return categoryDescendsFrom(tx, ctx, parent, needle, depth + 1);
}

// ── Registering an asset ────────────────────────────────────────────────────
export const RegisterAssetInput = z.object({
  nameEn: z.string().trim().min(1).max(160),
  nameAr: z.string().trim().max(160).optional(),
  descriptionEn: z.string().trim().max(2000).optional(),
  descriptionAr: z.string().trim().max(2000).optional(),
  categoryId: z.string().uuid().optional(),

  serialNo: z.string().trim().min(1).max(64).optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  /**
   * What the barcode IS, declared rather than guessed from its digits.
   * 'gs1_gtin' asserts the organization holds a GS1 licence for the prefix;
   * nothing here verifies that and nothing may imply it does.
   */
  codeKind: z.enum(["none", "gs1_gtin", "internal"]).optional().default("none"),

  acquisitionSource: z
    .enum(["purchase", "transfer_in", "donation", "lease", "built", "opening_balance"])
    .optional()
    .default("purchase"),
  acquiredOn: DATE.optional(),
  acquisitionCostMinor: z.number().int().min(0).optional(),
  currency: CURRENCY.optional(),
  exchangeRate: z.number().positive().optional(),

  /** H24 inputs. Recorded here, computed nowhere in H22. */
  residualValueMinor: z.number().int().min(0).optional(),
  usefulLifeMonths: z.number().int().positive().max(1200).optional(),
  depreciationStartOn: DATE.optional(),

  supplierId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  goodsReceiptLineId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
  /** The serialised unit this asset IS, when it came through inventory. */
  stockSerialId: z.string().uuid().optional(),

  warrantyStartOn: DATE.optional(),
  warrantyEndOn: DATE.optional(),
  warrantyProvider: z.string().trim().max(160).optional(),
  warrantyTerms: z.string().trim().max(2000).optional(),

  warehouseId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  siteNote: z.string().trim().max(200).optional(),
  condition: z.enum(["new", "good", "fair", "poor", "unserviceable"]).optional().default("good"),
  notes: z.string().trim().max(2000).optional(),
});

export type RegisteredAsset = { id: string; assetNo: string; qrKey: string };

/**
 * Put a thing on the register.
 *
 * The asset number is sequential and the organization's own — it is what goes on
 * the sticker. The QR key is a separate opaque string, because a label that
 * encodes the sequence number tells anyone who reads it how many assets the
 * business has, and a reused number would point a scanner at the wrong thing
 * forever.
 *
 * Registering from a serialised unit COPIES what inventory already knows —
 * supplier, order, receipt line, cost — instead of asking a person to retype it
 * and get it subtly wrong. The unit itself is untouched.
 */
export async function registerAsset(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<RegisteredAsset> {
  assertCan(archetype, "assets.manage");
  const data = RegisterAssetInput.parse(input);
  const id = randomUUID();
  const qrKey = `AQR-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;

  return command<RegisteredAsset>(
    ctx,
    {
      audit: (r) => ({
        action: "asset.registered",
        entityType: "asset" as const,
        entityId: r.id,
        summary: `Registered asset ${r.assetNo}: ${data.nameEn}`,
      }),
    },
    async (tx) => {
      if (data.warrantyStartOn && data.warrantyEndOn && data.warrantyEndOn < data.warrantyStartOn) {
        throw new AssetError("a warranty cannot end before it starts");
      }

      /*
       * Inherit from the serialised unit, where there is one.
       *
       * Everything below is a fact inventory already holds. Copying it keeps the
       * asset's acquisition history true to the delivery that produced it, and
       * anything the caller states explicitly still wins — a correction at
       * registration time is legitimate.
       */
      let inherited: Record<string, string | null> = {};
      if (data.stockSerialId) {
        const rows = (await tx.execute(sql`
          select s.item_id::text as item_id, s.serial_no,
                 s.warehouse_id::text as warehouse_id, s.location_id::text as location_id,
                 s.status
          from public.stock_serial s
          where s.id = ${data.stockSerialId} and s.org_id = ${ctx.orgId}
        `)) as unknown as Array<Record<string, string | null>>;
        if (!rows[0]) throw new AssetError("no such serialised unit in this organization");
        inherited = rows[0];
      }

      const category = data.categoryId
        ? ((await tx.execute(sql`
            select default_useful_life_months, default_residual_pct::text as default_residual_pct
            from public.asset_category
            where id = ${data.categoryId} and org_id = ${ctx.orgId}
          `)) as unknown as Array<{
            default_useful_life_months: number | null;
            default_residual_pct: string | null;
          }>)
        : [];
      if (data.categoryId && !category[0]) {
        throw new AssetError("no such asset category in this organization");
      }

      const cost = data.acquisitionCostMinor ?? null;
      const rate = data.exchangeRate ?? 1;
      /*
       * Residual defaults from the category as a PERCENTAGE of what this asset
       * cost, resolved now and stored as an amount. Storing the percentage and
       * multiplying later would silently restate every asset the day somebody
       * edits the category.
       */
      const residual =
        data.residualValueMinor ??
        (cost !== null && category[0]?.default_residual_pct
          ? Math.round((cost * Number(category[0].default_residual_pct)) / 100)
          : null);

      const seq = await allocateReference(tx, ctx, "asset", 1);
      const assetNo = formatRef("AST", seq);

      await tx.execute(sql`
        insert into public.asset
          (id, org_id, asset_no, category_id, name_en, name_ar, description_en, description_ar,
           serial_no, barcode, code_kind, qr_key,
           acquisition_source, acquired_on, acquisition_cost_minor, currency, exchange_rate,
           base_acquisition_cost_minor,
           residual_value_minor, useful_life_months, depreciation_start_on,
           supplier_id, purchase_order_id, goods_receipt_line_id, item_id, stock_serial_id,
           warranty_start_on, warranty_end_on, warranty_provider, warranty_terms,
           warehouse_id, location_id, site_note, condition, notes, status, created_by)
        values (${id}, ${ctx.orgId}, ${assetNo}, ${data.categoryId ?? null}, ${data.nameEn},
                ${data.nameAr ?? null}, ${data.descriptionEn ?? null}, ${data.descriptionAr ?? null},
                ${data.serialNo ?? inherited.serial_no ?? null}, ${data.barcode ?? null},
                ${data.codeKind}, ${qrKey},
                ${data.acquisitionSource}, ${data.acquiredOn ?? null}::date, ${cost},
                ${data.currency ?? null}, ${cost === null ? null : rate},
                ${cost === null ? null : Math.round(cost * rate)},
                ${residual},
                ${data.usefulLifeMonths ?? category[0]?.default_useful_life_months ?? null},
                ${data.depreciationStartOn ?? null}::date,
                ${data.supplierId ?? null}, ${data.purchaseOrderId ?? null},
                ${data.goodsReceiptLineId ?? null}, ${data.itemId ?? inherited.item_id ?? null},
                ${data.stockSerialId ?? null},
                ${data.warrantyStartOn ?? null}::date, ${data.warrantyEndOn ?? null}::date,
                ${data.warrantyProvider ?? null}, ${data.warrantyTerms ?? null},
                ${data.warehouseId ?? inherited.warehouse_id ?? null},
                ${data.locationId ?? inherited.location_id ?? null},
                ${data.siteNote ?? null}, ${data.condition}, ${data.notes ?? null},
                'draft', ${ctx.userId})
      `);
      return { id, assetNo, qrKey };
    },
  );
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
const STATUSES = [
  "draft",
  "in_service",
  "in_storage",
  "under_maintenance",
  "in_transit",
  "lost",
  "retired",
] as const;

/**
 * Move an asset to another state.
 *
 * Which transitions are legal is enforced by the DATABASE, so this reports the
 * refusal rather than deciding it — two places deciding the same thing is how
 * they come to disagree. 'disposed' is absent here on purpose: an asset becomes
 * disposed only by completing an approved disposal, never by being set.
 */
export async function setAssetStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  assetId: string,
  status: (typeof STATUSES)[number],
  reason?: string,
): Promise<{ id: string; status: string }> {
  assertCan(archetype, "assets.manage");
  if (!STATUSES.includes(status)) {
    throw new AssetStateError(`${status} is not a state an asset can be set to`);
  }
  if (status === "retired" && !reason?.trim()) {
    throw new AssetStateError("retiring an asset needs a reason");
  }

  return command<{ id: string; status: string }>(
    ctx,
    {
      audit: {
        action: "asset.status_changed",
        entityType: "asset",
        entityId: assetId,
        summary: `Asset moved to ${status}${reason ? `: ${reason.trim()}` : ""}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.asset
        set status = ${status},
            /*
             * Coming back into service CLEARS the retirement.
             *
             * The state machine allows retired -> in_service precisely because a
             * retirement can be a mistake. Leaving the date and reason behind
             * left a live asset reading as retired — and completeDisposal later
             * coalesces those stale values onto a record that becomes permanently
             * immutable, freezing a retirement date months before it happened
             * with no correcting event able to reach it.
             */
            retired_at = case when ${status} = 'retired' then now() else null end,
            retired_reason = case when ${status} = 'retired' then ${reason?.trim() ?? null}
                                  else null end,
            updated_at = now()
        where id = ${assetId} and org_id = ${ctx.orgId}
        returning id::text as id, status
      `)) as unknown as Array<{ id: string; status: string }>;
      if (!rows[0]) throw new AssetError("no such asset in this organization");
      return rows[0];
    },
  );
}

// ── Custody ─────────────────────────────────────────────────────────────────
export const AssignAssetInput = z.object({
  assetId: z.string().uuid(),
  toUserId: z.string().uuid(),
  toWarehouseId: z.string().uuid().optional(),
  toLocationId: z.string().uuid().optional(),
  conditionAtEvent: z.enum(["new", "good", "fair", "poor", "unserviceable"]).optional(),
  reason: z.string().trim().max(500).optional(),
  effectiveAt: z.string().optional(),
});

/**
 * Hand an asset to somebody.
 *
 * Two writes in one transaction: the append-only event that is the record, and
 * the asset's current-custodian fields that make "who has it now" a single read
 * rather than a walk over history. They cannot disagree, because they are
 * written together or not at all.
 *
 * A disposed or retired asset cannot be handed out — that refusal is the point
 * of retiring it.
 */
export async function assignAsset(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ eventId: string }> {
  assertCan(archetype, "assets.assign");
  const data = AssignAssetInput.parse(input);
  const eventId = randomUUID();

  return command<{ eventId: string }>(
    ctx,
    {
      audit: {
        action: "asset.assigned",
        entityType: "asset",
        entityId: data.assetId,
        summary: `Asset handed over${data.reason ? `: ${data.reason}` : ""}`,
      },
    },
    async (tx) => {
      const asset = await lockAsset(tx, ctx, data.assetId);
      if (["retired", "disposed", "lost"].includes(asset.status ?? "")) {
        throw new AssetStateError(`a ${asset.status} asset cannot be handed out`);
      }

      await tx.execute(sql`
        insert into public.asset_assignment
          (id, org_id, asset_id, event, from_user_id, to_user_id,
           from_warehouse_id, from_location_id, to_warehouse_id, to_location_id,
           condition_at_event, reason, effective_at, recorded_by)
        values (${eventId}, ${ctx.orgId}, ${data.assetId}, 'assigned',
                ${asset.custodian_user_id}, ${data.toUserId},
                ${asset.warehouse_id}, ${asset.location_id},
                ${data.toWarehouseId ?? asset.warehouse_id},
                ${data.toLocationId ?? asset.location_id},
                ${data.conditionAtEvent ?? null}, ${data.reason ?? null},
                coalesce(${data.effectiveAt ?? null}::timestamptz, now()), ${ctx.userId})
      `);
      await tx.execute(sql`
        update public.asset
        set custodian_user_id = ${data.toUserId}, custodian_since = now(),
            warehouse_id = ${data.toWarehouseId ?? asset.warehouse_id},
            location_id = ${data.toLocationId ?? asset.location_id},
            condition = coalesce(${data.conditionAtEvent ?? null}, condition),
            updated_at = now()
        where id = ${data.assetId} and org_id = ${ctx.orgId}
      `);
      return { eventId };
    },
  );
}

export const ReturnAssetInput = z.object({
  assetId: z.string().uuid(),
  toWarehouseId: z.string().uuid().optional(),
  toLocationId: z.string().uuid().optional(),
  conditionAtEvent: z.enum(["new", "good", "fair", "poor", "unserviceable"]).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Take it back. The custodian goes empty; the trail keeps who it was. */
export async function returnAsset(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ eventId: string }> {
  assertCan(archetype, "assets.assign");
  const data = ReturnAssetInput.parse(input);
  const eventId = randomUUID();

  return command<{ eventId: string }>(
    ctx,
    {
      audit: {
        action: "asset.returned",
        entityType: "asset",
        entityId: data.assetId,
        summary: `Asset returned${data.reason ? `: ${data.reason}` : ""}`,
      },
    },
    async (tx) => {
      const asset = await lockAsset(tx, ctx, data.assetId);
      if (!asset.custodian_user_id) {
        throw new AssetStateError("nobody is holding that asset");
      }
      await tx.execute(sql`
        insert into public.asset_assignment
          (id, org_id, asset_id, event, from_user_id, from_warehouse_id, from_location_id,
           to_warehouse_id, to_location_id, condition_at_event, reason, recorded_by)
        values (${eventId}, ${ctx.orgId}, ${data.assetId}, 'returned', ${asset.custodian_user_id},
                ${asset.warehouse_id}, ${asset.location_id},
                ${data.toWarehouseId ?? asset.warehouse_id},
                ${data.toLocationId ?? asset.location_id},
                ${data.conditionAtEvent ?? null}, ${data.reason ?? null}, ${ctx.userId})
      `);
      await tx.execute(sql`
        update public.asset
        set custodian_user_id = null, custodian_since = null,
            warehouse_id = ${data.toWarehouseId ?? asset.warehouse_id},
            location_id = ${data.toLocationId ?? asset.location_id},
            condition = coalesce(${data.conditionAtEvent ?? null}, condition),
            updated_at = now()
        where id = ${data.assetId} and org_id = ${ctx.orgId}
      `);
      return { eventId };
    },
  );
}

export const TransferAssetInput = z.object({
  assetId: z.string().uuid(),
  toWarehouseId: z.string().uuid().optional(),
  toLocationId: z.string().uuid().optional(),
  toUserId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(500),
});

/** Move it somewhere else, with or without changing who holds it. */
export async function transferAsset(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ eventId: string }> {
  assertCan(archetype, "assets.assign");
  const data = TransferAssetInput.parse(input);
  const eventId = randomUUID();
  if (!data.toWarehouseId && !data.toLocationId && !data.toUserId) {
    throw new AssetError("a transfer has to move the asset somewhere or to somebody");
  }

  return command<{ eventId: string }>(
    ctx,
    {
      audit: {
        action: "asset.transferred",
        entityType: "asset",
        entityId: data.assetId,
        summary: `Asset transferred: ${data.reason}`,
      },
    },
    async (tx) => {
      const asset = await lockAsset(tx, ctx, data.assetId);
      if (["retired", "disposed"].includes(asset.status ?? "")) {
        throw new AssetStateError(`a ${asset.status} asset cannot be transferred`);
      }
      await tx.execute(sql`
        insert into public.asset_assignment
          (id, org_id, asset_id, event, from_user_id, to_user_id,
           from_warehouse_id, from_location_id, to_warehouse_id, to_location_id,
           reason, recorded_by)
        values (${eventId}, ${ctx.orgId}, ${data.assetId}, 'transferred',
                ${asset.custodian_user_id}, ${data.toUserId ?? asset.custodian_user_id},
                ${asset.warehouse_id}, ${asset.location_id},
                ${data.toWarehouseId ?? asset.warehouse_id},
                ${data.toLocationId ?? asset.location_id},
                ${data.reason}, ${ctx.userId})
      `);
      await tx.execute(sql`
        update public.asset
        set warehouse_id = ${data.toWarehouseId ?? asset.warehouse_id},
            location_id = ${data.toLocationId ?? asset.location_id},
            custodian_user_id = ${data.toUserId ?? asset.custodian_user_id},
            custodian_since = case
              when ${data.toUserId ?? null}::uuid is null then custodian_since
              else now() end,
            updated_at = now()
        where id = ${data.assetId} and org_id = ${ctx.orgId}
      `);
      return { eventId };
    },
  );
}

/**
 * Correct a custody event that was recorded wrongly.
 *
 * A further event, never an edit. The original stays exactly as somebody entered
 * it, the correction names it, and both are in the trail — which is the only way
 * a reader can tell "it was always like this" from "somebody fixed it".
 */
export async function correctAssignment(
  ctx: Ctx,
  archetype: RoleArchetype,
  correctsId: string,
  reason: string,
): Promise<{ eventId: string }> {
  assertCan(archetype, "assets.assign");
  if (!reason.trim()) throw new AssetError("a correction needs a reason");
  const eventId = randomUUID();

  return command<{ eventId: string }>(
    ctx,
    {
      audit: {
        action: "asset.assignment_corrected",
        entityType: "asset",
        entityId: correctsId,
        summary: `Corrected a custody event: ${reason.trim()}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select asset_id::text as asset_id, from_user_id::text as from_user_id,
               to_user_id::text as to_user_id
        from public.asset_assignment
        where id = ${correctsId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<Record<string, string | null>>;
      if (!rows[0]) throw new AssetError("no such custody event in this organization");
      await tx.execute(sql`
        insert into public.asset_assignment
          (id, org_id, asset_id, event, from_user_id, to_user_id, reason, corrects_id, recorded_by)
        values (${eventId}, ${ctx.orgId}, ${rows[0].asset_id}, 'correction',
                ${rows[0].to_user_id}, ${rows[0].from_user_id}, ${reason.trim()},
                ${correctsId}, ${ctx.userId})
      `);
      return { eventId };
    },
  );
}

/** Read the asset and hold its row, so two custody changes cannot interleave. */
async function lockAsset(
  tx: TenantTx,
  ctx: Ctx,
  assetId: string,
): Promise<Record<string, string | null>> {
  const rows = (await tx.execute(sql`
    select id::text as id, status, custodian_user_id::text as custodian_user_id,
           warehouse_id::text as warehouse_id, location_id::text as location_id,
           asset_no
    from public.asset
    where id = ${assetId} and org_id = ${ctx.orgId}
    for update
  `)) as unknown as Array<Record<string, string | null>>;
  if (!rows[0]) throw new AssetError("no such asset in this organization");
  return rows[0];
}

// ── Reading ─────────────────────────────────────────────────────────────────
export type AssetRow = {
  id: string;
  assetNo: string;
  nameEn: string;
  status: string;
  condition: string;
  categoryId: string | null;
  custodianUserId: string | null;
  locationId: string | null;
  serialNo: string | null;
  acquisitionCostMinor: number | null;
};

/**
 * The register, a page at a time.
 *
 * Cursor-based on (asset_no, id) rather than an offset: an offset walk over a
 * register that is being added to skips rows, and a hard ceiling would hide the
 * rest of a fleet without saying so. `hasMore` tells the caller there is more
 * instead of leaving them to guess from a full page.
 */
export async function listAssets(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    search?: string;
    status?: string;
    categoryId?: string;
    custodianUserId?: string;
    locationId?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ rows: AssetRow[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  assertCan(archetype, "assets.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const search = opts.search?.trim() ?? "";

  return withCtx(ctx, async (tx) => {
    const where = sql`
      a.org_id = ${ctx.orgId}
      and (${opts.status ?? null}::text is null or a.status = ${opts.status ?? null})
      and (${opts.categoryId ?? null}::uuid is null or a.category_id = ${opts.categoryId ?? null}::uuid)
      and (${opts.custodianUserId ?? null}::uuid is null
           or a.custodian_user_id = ${opts.custodianUserId ?? null}::uuid)
      and (${opts.locationId ?? null}::uuid is null or a.location_id = ${opts.locationId ?? null}::uuid)
      and (${search === ""}
           or a.asset_no ilike ${"%" + search + "%"}
           or a.name_en ilike ${"%" + search + "%"}
           or coalesce(a.serial_no, '') ilike ${"%" + search + "%"}
           or coalesce(a.barcode, '') ilike ${"%" + search + "%"})
    `;

    const counted = (await tx.execute(sql`
      select count(*)::int as n from public.asset a where ${where}
    `)) as unknown as Array<{ n: number }>;

    const rows = (await tx.execute(sql`
      select a.id::text as id, a.asset_no, a.name_en, a.status, a.condition,
             a.category_id::text as category_id, a.custodian_user_id::text as custodian_user_id,
             a.location_id::text as location_id, a.serial_no,
             a.acquisition_cost_minor::text as acquisition_cost_minor
      from public.asset a
      where ${where}
        and (${opts.cursor ?? null}::text is null or a.asset_no > ${opts.cursor ?? null})
      order by a.asset_no, a.id
      limit ${limit + 1}
    `)) as unknown as Array<Record<string, string | null>>;

    const page = rows.slice(0, limit);
    return {
      rows: page.map((r) => ({
        id: r.id!,
        assetNo: r.asset_no!,
        nameEn: r.name_en!,
        status: r.status!,
        condition: r.condition!,
        categoryId: r.category_id ?? null,
        custodianUserId: r.custodian_user_id ?? null,
        locationId: r.location_id ?? null,
        serialNo: r.serial_no ?? null,
        /*
         * What a thing COST is money, and money follows the cost wall.
         *
         * assets.view is deliberately wide — a foreman needs to see the
         * equipment they work with — but several of those roles sit outside
         * F-23, so handing them acquisition cost through the asset list would
         * route around a wall the rest of the product keeps.
         */
        acquisitionCostMinor:
          !ctx.costPrivileged || r.acquisition_cost_minor === null
            ? null
            : Number(r.acquisition_cost_minor),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.asset_no ?? null) : null,
      hasMore: rows.length > limit,
      total: Number(counted[0]?.n ?? 0),
    };
  });
}

/** One asset with its custody trail, newest first and bounded. */
export async function getAsset(
  ctx: Ctx,
  archetype: RoleArchetype,
  assetId: string,
  opts: { historyLimit?: number } = {},
): Promise<{
  asset: Record<string, string | null> | null;
  custody: Array<Record<string, string | null>>;
}> {
  assertCan(archetype, "assets.view");
  const historyLimit = Math.min(Math.max(opts.historyLimit ?? 100, 1), 500);

  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select a.id::text as id, a.asset_no, a.name_en, a.name_ar, a.description_en,
             a.status, a.condition, a.serial_no, a.barcode, a.code_kind, a.qr_key,
             a.acquisition_source, a.acquired_on::text as acquired_on,
             a.acquisition_cost_minor::text as acquisition_cost_minor, a.currency,
             a.residual_value_minor::text as residual_value_minor,
             a.useful_life_months::text as useful_life_months,
             a.warranty_start_on::text as warranty_start_on,
             a.warranty_end_on::text as warranty_end_on, a.warranty_provider,
             a.custodian_user_id::text as custodian_user_id,
             a.warehouse_id::text as warehouse_id, a.location_id::text as location_id,
             a.stock_serial_id::text as stock_serial_id,
             a.goods_receipt_line_id::text as goods_receipt_line_id,
             a.retired_at::text as retired_at, a.retired_reason,
             a.disposed_at::text as disposed_at
      from public.asset a
      where a.id = ${assetId} and a.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, string | null>>;
    if (!rows[0]) return { asset: null, custody: [] };

    // The same wall on the single-asset read. Redacted rather than omitted, so
    // a caller can tell "you may not see this" from "nobody recorded it".
    if (!ctx.costPrivileged) {
      for (const key of ["acquisition_cost_minor", "residual_value_minor"]) {
        if (rows[0][key] !== undefined) rows[0][key] = null;
      }
    }

    const custody = (await tx.execute(sql`
      select id::text as id, event, from_user_id::text as from_user_id,
             to_user_id::text as to_user_id, from_location_id::text as from_location_id,
             to_location_id::text as to_location_id, condition_at_event, reason,
             corrects_id::text as corrects_id, effective_at::text as effective_at,
             recorded_by::text as recorded_by
      from public.asset_assignment
      where asset_id = ${assetId} and org_id = ${ctx.orgId}
      order by effective_at desc, created_at desc
      limit ${historyLimit}
    `)) as unknown as Array<Record<string, string | null>>;

    return { asset: rows[0], custody };
  });
}
