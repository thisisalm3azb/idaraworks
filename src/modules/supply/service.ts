/**
 * Supply module — the MR → PO → GRN chain (doc 01; doc 11 S4). Material requests
 * and MR-less/over-threshold purchase orders enter the unified approval engine
 * (doc 05, F-3); goods receipts reconcile partial receipts onto the PO. Money in
 * minor units; supply COST fields (est/unit costs, totals, VAT) are visible to the
 * purchasing/finance roles (po.view) and REDACTED for the foreman (who never sees
 * cost, F-23). cost_only: NO stock ledger in the MVP. No-hard-delete: cancel/void.
 * Every mutation runs through command() (audit + activity + outbox), one tx.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can, ForbiddenError } from "@/platform/authz";
import { requireCapability } from "@/platform/entitlements";
import {
  GOODS_RECEIPT_RECORDED,
  GOODS_RECEIPT_CANCELLED,
  PURCHASE_ORDER_APPROVED,
} from "@/platform/events";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { isAssignedIn } from "@/modules/jobs/service";
import { submitForApproval } from "@/modules/approvals/service";
import { getDocBranding } from "@/modules/branding/service";
import { CURRENCY_CODES, minorUnitExponent } from "@/platform/registries";
import type { CurrencyCode, RoleArchetype } from "@/platform/registries";
import { lpoHtml } from "./lpo-template";

export { lpoHtml, type LpoData, type LpoOptions } from "./lpo-template";

export class SupplyNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "SupplyNotFoundError";
  }
}
export class SupplyStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplyStateError";
  }
}
export class InvalidSupplyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSupplyInputError";
  }
}

const seesCost = (a: RoleArchetype) => can(a, "po.view");

// ── input schemas ─────────────────────────────────────────────────────────────
const MrLineInput = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().trim().min(1).max(160),
  qty: z.number().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(16),
  estUnitCostMinor: z.number().int().min(0).optional(),
});
export const CreateMrInput = z.object({
  jobId: z.string().uuid().optional(),
  urgency: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
  requiredDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
  lines: z.array(MrLineInput).min(1).max(100),
});

const PoLineInput = z.object({
  itemId: z.string().uuid().optional(),
  itemName: z.string().trim().min(1).max(160),
  qty: z.number().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(16),
  unitCostMinor: z.number().int().min(0),
});
export const CreatePoInput = z.object({
  supplierId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  vatMinor: z.number().int().min(0).optional().default(0),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
  /**
   * The currency the SUPPLIER is being asked to charge in. Absent means the
   * organization's own currency, which is what every order meant before this
   * field existed.
   */
  currency: z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]).optional(),
  /**
   * Base-currency units per one unit of the order currency (3.6725 AED per USD).
   *
   * Required — and required to differ from 1 — whenever the order currency is
   * not the base currency. There is no rate service: a person enters this, and
   * the audit log records who and when.
   */
  exchangeRate: z.number().positive().max(1_000_000).optional(),
  rateDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(PoLineInput).min(1).max(200),
});

// ── helpers ───────────────────────────────────────────────────────────────────
/** A purchase order's money, fixed at the moment it is written. */
export type OrderMoney = {
  currency: CurrencyCode;
  baseCurrency: CurrencyCode;
  exchangeRate: number;
  rateDate: string;
  rateSource: "same_currency" | "manual";
  baseTotalMinor: number;
};

/**
 * Settle what an order is priced in, and what that is worth in the
 * organization's own money.
 *
 * The rule that matters: a rate of exactly 1 is a statement that no conversion
 * happens, which is only true when the currencies match. A foreign order with no
 * rate — or a foreign order at 1 — is refused here with a message a buyer can
 * act on, rather than reaching the database and failing as a constraint name.
 *
 * base_currency is stored on the ORDER rather than read from the organization
 * later. An organization can change its base currency; a document that already
 * exists must keep saying what it said.
 */
async function resolveOrderMoney(
  tx: TenantTx,
  ctx: Ctx,
  totalMinor: number,
  input: { currency?: CurrencyCode; exchangeRate?: number; rateDate?: string },
): Promise<OrderMoney> {
  const rows = (await tx.execute(sql`
    select base_currency from public.org where id = ${ctx.orgId}
  `)) as unknown as Array<{ base_currency: CurrencyCode }>;
  const baseCurrency = rows[0]?.base_currency;
  if (!baseCurrency) throw new InvalidSupplyInputError("the organization has no base currency");

  const currency = input.currency ?? baseCurrency;
  const rateDate = input.rateDate ?? new Date().toISOString().slice(0, 10);

  if (currency === baseCurrency) {
    if (input.exchangeRate !== undefined && input.exchangeRate !== 1) {
      throw new InvalidSupplyInputError(
        `an order in ${currency} is already in the organization's currency, so its rate is 1, not ${input.exchangeRate}`,
      );
    }
    return {
      currency,
      baseCurrency,
      exchangeRate: 1,
      rateDate,
      rateSource: "same_currency",
      baseTotalMinor: totalMinor,
    };
  }

  if (input.exchangeRate === undefined) {
    throw new InvalidSupplyInputError(
      `an order in ${currency} needs the ${baseCurrency} per ${currency} rate; there is no rate service to assume one`,
    );
  }
  if (input.exchangeRate === 1) {
    throw new InvalidSupplyInputError(
      `a rate of 1 says ${currency} and ${baseCurrency} are the same money; enter the real rate`,
    );
  }

  /*
   * Minor units are not interchangeable across currencies: 1000 fils is one
   * dinar, 1000 cents is ten dollars. So the conversion goes through major
   * units — divide out the order's exponent, apply the rate, then scale into the
   * base currency's own exponent.
   */
  const scale = 10 ** (minorUnitExponent(baseCurrency) - minorUnitExponent(currency));
  return {
    currency,
    baseCurrency,
    exchangeRate: input.exchangeRate,
    rateDate,
    rateSource: "manual",
    baseTotalMinor: Math.round(totalMinor * input.exchangeRate * scale),
  };
}

async function jobReference(tx: TenantTx, ctx: Ctx, jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  const rows = (await tx.execute(sql`
    select reference from public.job where id = ${jobId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ reference: string }>;
  return rows[0]?.reference ?? null;
}

async function validateItems(tx: TenantTx, ctx: Ctx, itemIds: string[]): Promise<void> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return;
  const found = (await tx.execute(sql`
    select id::text as id from public.item
    where org_id = ${ctx.orgId} and active = true
      and id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `)) as unknown as Array<{ id: string }>;
  const set = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !set.has(id));
  if (missing.length > 0) {
    throw new InvalidSupplyInputError(`unknown or inactive item(s): ${missing.join(", ")}`);
  }
}

// ── Material Requests ─────────────────────────────────────────────────────────
export async function createMaterialRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "mr.create");
  // Add-on gate (FR-9): CREATE only — reads and in-flight MRs never gate.
  await requireCapability(ctx, "cap.material_requests");
  const data = CreateMrInput.parse(input);
  const id = randomUUID();
  return command<{ id: string; reference: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "mr.create",
        entityType: "material_request",
        entityId: r.id,
        summary: `Created ${r.reference}`,
      }),
      activity: data.jobId
        ? {
            entityType: "job",
            entityId: data.jobId,
            verb: "requested",
            summary: `created a material request`,
          }
        : undefined,
    },
    async (tx) => {
      // Foreman: MR only on an ASSIGNED job (F-6).
      if (data.jobId && archetype === "foreman" && !(await isAssignedIn(tx, ctx, data.jobId))) {
        throw new ForbiddenError("mr.create");
      }
      if (data.jobId) {
        const j = (await tx.execute(
          sql`select id from public.job where id = ${data.jobId} and org_id = ${ctx.orgId}`,
        )) as unknown as Array<{ id: string }>;
        if (!j[0]) throw new InvalidSupplyInputError(`unknown job ${data.jobId}`);
      }
      await validateItems(tx, ctx, data.lines.map((l) => l.itemId).filter(Boolean) as string[]);
      const seq = await allocateReference(tx, ctx, "material_request", 1);
      const reference = formatRef("MR", seq);
      const total = data.lines.reduce(
        (s, l) => s + Math.round(l.qty * (l.estUnitCostMinor ?? 0)),
        0,
      );
      await tx.execute(sql`
        insert into public.material_request
          (id, org_id, reference, job_id, status, urgency, required_date, total_minor, notes, created_by)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.jobId ?? null}, 'draft', ${data.urgency},
                ${data.requiredDate ?? null}, ${total}, ${data.notes ?? null}, ${ctx.userId})
      `);
      for (const [i, l] of data.lines.entries()) {
        await tx.execute(sql`
          insert into public.material_request_line
            (id, org_id, mr_id, item_id, item_name, qty, unit, est_unit_cost_minor, sort)
          values (${randomUUID()}, ${ctx.orgId}, ${id}, ${l.itemId ?? null}, ${l.itemName},
                  ${l.qty}, ${l.unit}, ${l.estUnitCostMinor ?? null}, ${i})
        `);
      }
      return { id, reference };
    },
  );
}

export async function submitMaterialRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  mrId: string,
): Promise<{ id: string; approvalId: string }> {
  assertCan(archetype, "mr.create");
  return command<{ id: string; approvalId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "mr.submit",
        entityType: "material_request",
        entityId: r.id,
        summary: `Submitted material request for approval`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, reference, job_id::text as job_id, status, urgency,
               total_minor::text as total_minor, created_by::text as created_by
        from public.material_request where id = ${mrId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{
        id: string;
        reference: string;
        job_id: string | null;
        status: string;
        urgency: string;
        total_minor: string;
        created_by: string;
      }>;
      const mr = rows[0];
      if (!mr) throw new SupplyNotFoundError("material_request", mrId);
      if (archetype === "foreman" && mr.created_by !== ctx.userId) {
        throw new ForbiddenError("mr.create");
      }
      // GUARDED transition (review fix): draft/rejected → submitted with RETURNING
      // so two concurrent submits can't both proceed (the second gets 0 rows). The
      // 0037 approval unique is the second line of defence.
      const advanced = (await tx.execute(sql`
        update public.material_request set status = 'submitted', updated_at = now()
        where id = ${mrId} and org_id = ${ctx.orgId} and status in ('draft', 'rejected')
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (advanced.length === 0) {
        throw new SupplyStateError(`only a draft/rejected MR can be submitted (was ${mr.status})`);
      }
      const jobRef = await jobReference(tx, ctx, mr.job_id);
      const res = await submitForApproval(tx, ctx, {
        subjectType: "material_request",
        subjectId: mrId,
        subjectSummary: {
          title: `Material request ${mr.reference}`,
          amountMinor: Number(mr.total_minor),
          jobRef,
        },
        amountMinor: Number(mr.total_minor),
        urgency: mr.urgency,
      });
      // Auto-approved (below threshold) → advance the MR now (engine only writes
      // the subject on a human decide; for auto/pre it hands back decided:true).
      if (res.decided) {
        await tx.execute(sql`
          update public.material_request set status = 'approved', updated_at = now()
          where id = ${mrId} and org_id = ${ctx.orgId}
        `);
      }
      return { id: mrId, approvalId: res.approvalId };
    },
  );
}

export const ConvertMrInput = z.object({
  supplierId: z.string().uuid(),
  vatMinor: z.number().int().min(0).optional().default(0),
  // Optional per-line unit cost overrides (procurement prices the request).
  lineCosts: z.record(z.string().uuid(), z.number().int().min(0)).optional(),
});

export async function convertMrToPo(
  ctx: Ctx,
  archetype: RoleArchetype,
  mrId: string,
  input: unknown,
): Promise<{ poId: string; reference: string }> {
  assertCan(archetype, "mr.convert");
  // Converting mints a NEW purchase order — gated like po.create (FR-9).
  await requireCapability(ctx, "cap.purchase_orders");
  const data = ConvertMrInput.parse(input);
  const poId = randomUUID();
  return command<{ poId: string; reference: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "mr.convert",
        entityType: "purchase_order",
        entityId: r.poId,
        summary: `Converted MR to ${r.reference} (auto-approved)`,
      }),
      events: (r) => [
        {
          name: PURCHASE_ORDER_APPROVED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            purchaseOrderId: r.poId,
            reference: r.reference,
          },
        },
      ],
    },
    async (tx) => {
      const mrRows = (await tx.execute(sql`
        select id::text as id, status, job_id::text as job_id, reference
        from public.material_request where id = ${mrId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{
        id: string;
        status: string;
        job_id: string | null;
        reference: string;
      }>;
      const mr = mrRows[0];
      if (!mr) throw new SupplyNotFoundError("material_request", mrId);
      const supplier = (await tx.execute(
        sql`select id from public.supplier where id = ${data.supplierId} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ id: string }>;
      if (!supplier[0]) throw new InvalidSupplyInputError(`unknown supplier ${data.supplierId}`);
      // GUARDED conversion (review fix): claim the approved→converted transition
      // with RETURNING FIRST, so two concurrent converts can't both mint a PO (the
      // second gets 0 rows). The 0037 purchase_order(org, mr_id) unique backstops it.
      const claimed = (await tx.execute(sql`
        update public.material_request
        set status = 'converted', converted_po_id = ${poId}, updated_at = now()
        where id = ${mrId} and org_id = ${ctx.orgId} and status = 'approved'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (claimed.length === 0) {
        throw new SupplyStateError(`only an approved MR can be converted (was ${mr.status})`);
      }

      const lines = (await tx.execute(sql`
        select id::text as id, item_id::text as item_id, item_name, qty::text as qty, unit,
               est_unit_cost_minor::text as est_unit_cost_minor
        from public.material_request_line
        where mr_id = ${mrId} and org_id = ${ctx.orgId} and superseded_at is null
        order by sort asc
      `)) as unknown as Array<{
        id: string;
        item_id: string | null;
        item_name: string;
        qty: string;
        unit: string;
        est_unit_cost_minor: string | null;
      }>;

      const seq = await allocateReference(tx, ctx, "purchase_order", 1);
      const reference = formatRef("PO", seq);
      let total = 0;
      const poLines = lines.map((l, i) => {
        const unitCost =
          data.lineCosts?.[l.id] ?? (l.est_unit_cost_minor ? Number(l.est_unit_cost_minor) : 0);
        const lineTotal = Math.round(Number(l.qty) * unitCost);
        total += lineTotal;
        return { ...l, unitCost, lineTotal, sort: i };
      });
      total += data.vatMinor;

      // A material request carries no currency — it asks for things, not for a
      // price in someone else's money — so a converted order is in the
      // organization's own currency. Stated rather than left to a default.
      const money = await resolveOrderMoney(tx, ctx, total, {});
      await tx.execute(sql`
        insert into public.purchase_order
          (id, org_id, reference, supplier_id, job_id, mr_id, status, vat_minor, total_minor,
           created_by, approved_at, currency, base_currency, exchange_rate, rate_date,
           rate_source, base_total_minor)
        values (${poId}, ${ctx.orgId}, ${reference}, ${data.supplierId}, ${mr.job_id}, ${mrId},
                'approved', ${data.vatMinor}, ${total}, ${ctx.userId}, now(),
                ${money.currency}, ${money.baseCurrency}, ${money.exchangeRate},
                ${money.rateDate}::date, ${money.rateSource}, ${money.baseTotalMinor})
      `);
      for (const l of poLines) {
        await tx.execute(sql`
          insert into public.purchase_order_line
            (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor, line_total_minor, sort)
          values (${randomUUID()}, ${ctx.orgId}, ${poId}, ${l.item_id}, ${l.item_name}, ${l.qty},
                  ${l.unit}, ${l.unitCost}, ${l.lineTotal}, ${l.sort})
        `);
      }
      // The MR is already claimed as converted (guarded update above); the
      // converting PO AUTO-approves (D-5.3) — record an already-approved approval
      // so the sole-writer invariant holds.
      await submitForApproval(tx, ctx, {
        subjectType: "purchase_order",
        subjectId: poId,
        subjectSummary: {
          title: `Purchase order ${reference}`,
          amountMinor: total,
          jobRef: await jobReference(tx, ctx, mr.job_id),
        },
        preApproved: true,
      });
      return { poId, reference };
    },
  );
}

// ── Purchase Orders (MR-less / direct) ────────────────────────────────────────
export async function createPurchaseOrder(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "po.manage");
  // Add-on gate (FR-9): CREATE only — submit/receive on existing POs never gate.
  await requireCapability(ctx, "cap.purchase_orders");
  const data = CreatePoInput.parse(input);
  const id = randomUUID();
  // Captured for the audit line: a manually entered rate must name the person
  // who entered it, and the audit log is where that is recorded.
  let money: OrderMoney | null = null;
  return command<{ id: string; reference: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "po.create",
        entityType: "purchase_order",
        entityId: r.id,
        summary:
          money && money.currency !== money.baseCurrency
            ? `Created ${r.reference} (MR-less) in ${money.currency} at ${money.exchangeRate} ${money.baseCurrency}/${money.currency}, entered manually on ${money.rateDate}`
            : `Created ${r.reference} (MR-less)`,
      }),
    },
    async (tx) => {
      const supplier = (await tx.execute(
        sql`select id from public.supplier where id = ${data.supplierId} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ id: string }>;
      if (!supplier[0]) throw new InvalidSupplyInputError(`unknown supplier ${data.supplierId}`);
      if (data.jobId) {
        const j = (await tx.execute(
          sql`select id from public.job where id = ${data.jobId} and org_id = ${ctx.orgId}`,
        )) as unknown as Array<{ id: string }>;
        if (!j[0]) throw new InvalidSupplyInputError(`unknown job ${data.jobId}`);
      }
      await validateItems(tx, ctx, data.lines.map((l) => l.itemId).filter(Boolean) as string[]);
      const seq = await allocateReference(tx, ctx, "purchase_order", 1);
      const reference = formatRef("PO", seq);
      let total = data.vatMinor;
      const lines = data.lines.map((l, i) => {
        const lineTotal = Math.round(l.qty * l.unitCostMinor);
        total += lineTotal;
        return { ...l, lineTotal, sort: i };
      });
      money = await resolveOrderMoney(tx, ctx, total, data);
      await tx.execute(sql`
        insert into public.purchase_order
          (id, org_id, reference, supplier_id, job_id, status, vat_minor, total_minor, notes,
           created_by, currency, base_currency, exchange_rate, rate_date, rate_source,
           base_total_minor)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.supplierId}, ${data.jobId ?? null}, 'draft',
                ${data.vatMinor}, ${total}, ${data.notes ?? null}, ${ctx.userId},
                ${money.currency}, ${money.baseCurrency}, ${money.exchangeRate},
                ${money.rateDate}::date, ${money.rateSource}, ${money.baseTotalMinor})
      `);
      for (const l of lines) {
        await tx.execute(sql`
          insert into public.purchase_order_line
            (id, org_id, po_id, item_id, item_name, qty, unit, unit_cost_minor, line_total_minor, sort)
          values (${randomUUID()}, ${ctx.orgId}, ${id}, ${l.itemId ?? null}, ${l.itemName}, ${l.qty},
                  ${l.unit}, ${l.unitCostMinor}, ${l.lineTotal}, ${l.sort})
        `);
      }
      return { id, reference };
    },
  );
}

export async function submitPurchaseOrder(
  ctx: Ctx,
  archetype: RoleArchetype,
  poId: string,
): Promise<{ id: string; approvalId: string }> {
  assertCan(archetype, "po.manage");
  return command<{ id: string; approvalId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "po.submit",
        entityType: "purchase_order",
        entityId: r.id,
        summary: `Submitted PO for approval (MR-less/over-threshold, F-3)`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, reference, job_id::text as job_id, status, total_minor::text as total_minor
        from public.purchase_order where id = ${poId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{
        id: string;
        reference: string;
        job_id: string | null;
        status: string;
        total_minor: string;
      }>;
      const po = rows[0];
      if (!po) throw new SupplyNotFoundError("purchase_order", poId);
      if (po.status !== "draft") {
        throw new SupplyStateError(`only a draft PO can be submitted (was ${po.status})`);
      }
      const res = await submitForApproval(tx, ctx, {
        subjectType: "purchase_order",
        subjectId: poId,
        subjectSummary: {
          title: `Purchase order ${po.reference}`,
          amountMinor: Number(po.total_minor),
          jobRef: await jobReference(tx, ctx, po.job_id),
        },
        amountMinor: Number(po.total_minor),
      });
      if (res.decided) {
        await tx.execute(sql`
          update public.purchase_order set status = 'approved', approved_at = now(), updated_at = now()
          where id = ${poId} and org_id = ${ctx.orgId}
        `);
      }
      return { id: poId, approvalId: res.approvalId };
    },
  );
}

// ── Goods Receipts (partial-receipt reconciliation) ──────────────────────────
const DISPOSITION = z.enum(["accepted", "damaged", "quarantine"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A batch as the delivery note describes it. */
const GrnLotInput = z.object({
  lotCode: z.string().trim().min(1).max(64),
  supplierLotCode: z.string().trim().max(64).optional(),
  manufacturedOn: DATE.optional(),
  expiryDate: DATE.optional(),
  qty: z.number().positive().max(1_000_000_000),
  disposition: DISPOSITION.optional().default("accepted"),
});
const GrnSerialInput = z.object({
  serialNo: z.string().trim().min(1).max(64),
  lotCode: z.string().trim().max(64).optional(),
  disposition: DISPOSITION.optional().default("accepted"),
});

const GrnLineInput = z
  .object({
    poLineId: z.string().uuid(),
    receivedQty: z.number().min(0).max(1_000_000_000),
    damagedQty: z.number().min(0).max(1_000_000_000).optional().default(0),
    rejectedQty: z.number().min(0).max(1_000_000_000).optional().default(0),
    /** Held for inspection: owned, but not usable until someone decides. */
    quarantineQty: z.number().min(0).max(1_000_000_000).optional().default(0),
    lots: z.array(GrnLotInput).max(200).optional(),
    serials: z.array(GrnSerialInput).max(500).optional(),
  })
  /*
   * Everything that arrived is accounted for, and the balance is what was
   * accepted. Refusing the over-split here means the clerk is told which line is
   * wrong, rather than meeting a constraint name from the database.
   */
  .refine((l) => l.damagedQty + l.rejectedQty + l.quarantineQty <= l.receivedQty, {
    message: "damaged, rejected and quarantined cannot exceed what was received",
  });
export const RecordGrnInput = z.object({
  poId: z.string().uuid(),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
  lines: z.array(GrnLineInput).min(1).max(200),
});

type GrnLine = z.infer<typeof GrnLineInput>;

/**
 * A tracked item must arrive with its labels, disposition by disposition.
 *
 * Checked at RECEIVING rather than at posting, because that is the only moment
 * anybody is holding the goods. Discovering at posting time that nobody wrote
 * down the batch number leaves a warehouse with stock it cannot legally issue
 * and no way to recover the answer.
 *
 * Rejected quantity is excluded throughout: it was refused at the door and never
 * became the organization's, so it needs no identity.
 */
function assertTrackingRecorded(line: GrnLine, tracking: string): void {
  const owned: Record<"accepted" | "damaged" | "quarantine", number> = {
    accepted: line.receivedQty - line.damagedQty - line.rejectedQty - line.quarantineQty,
    damaged: line.damagedQty,
    quarantine: line.quarantineQty,
  };
  const lots = line.lots ?? [];
  const serials = line.serials ?? [];

  if (tracking === "none") {
    if (lots.length > 0 || serials.length > 0) {
      throw new InvalidSupplyInputError(
        "this item is not lot- or serial-tracked, so it has no batches or units to record",
      );
    }
    return;
  }
  if (tracking === "lot" && serials.length > 0) {
    throw new InvalidSupplyInputError("this item is lot-tracked, not serialised");
  }
  if (tracking === "serial" && lots.length > 0) {
    throw new InvalidSupplyInputError("this item is serialised, not lot-tracked");
  }

  for (const d of ["accepted", "damaged", "quarantine"] as const) {
    const expected = owned[d];
    const recorded =
      tracking === "lot"
        ? lots.filter((l) => l.disposition === d).reduce((s, l) => s + l.qty, 0)
        : serials.filter((s) => s.disposition === d).length;
    if (Math.abs(recorded - expected) > 1e-9) {
      throw new InvalidSupplyInputError(
        tracking === "lot"
          ? `${expected} ${d} unit(s) arrived but the batches account for ${recorded}`
          : `${expected} ${d} unit(s) arrived but ${recorded} serial number(s) were recorded`,
      );
    }
  }
  if (tracking === "serial") {
    const seen = new Set(serials.map((s) => s.serialNo));
    if (seen.size !== serials.length) {
      throw new InvalidSupplyInputError("the same serial number appears twice");
    }
  }
}

/** Recompute a PO's status from all RECORDED GRNs (self-healing reconciliation). */
async function reconcilePoStatus(tx: TenantTx, ctx: Ctx, poId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    select pol.id::text as po_line_id, pol.qty::text as ordered,
           coalesce(sum(grl.received_qty) filter (where grn.status = 'recorded'), 0)::text as received
    from public.purchase_order_line pol
    left join public.goods_receipt_line grl on grl.po_line_id = pol.id and grl.org_id = pol.org_id
    left join public.goods_receipt grn on grn.id = grl.grn_id and grn.org_id = grl.org_id
    where pol.po_id = ${poId} and pol.org_id = ${ctx.orgId} and pol.superseded_at is null
    group by pol.id, pol.qty
  `)) as unknown as Array<{ po_line_id: string; ordered: string; received: string }>;
  let anyReceived = false;
  let allFull = rows.length > 0;
  for (const r of rows) {
    const rec = Number(r.received);
    const ord = Number(r.ordered);
    if (rec > 0) anyReceived = true;
    if (rec < ord) allFull = false;
  }
  const status = allFull ? "received" : anyReceived ? "partially_received" : null;
  if (status) {
    // Never downgrade an approved/sent PO out of a received state incorrectly:
    // only move a PO that is at/after approval into a receipt state.
    await tx.execute(sql`
      update public.purchase_order set status = ${status}, updated_at = now()
      where id = ${poId} and org_id = ${ctx.orgId}
        and status in ('approved', 'sent', 'partially_received', 'received')
    `);
  } else {
    // No recorded receipts remain (e.g. after a cancel) → revert to approved.
    await tx.execute(sql`
      update public.purchase_order set status = 'approved', updated_at = now()
      where id = ${poId} and org_id = ${ctx.orgId}
        and status in ('partially_received', 'received')
    `);
  }
}

export async function recordGoodsReceipt(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string; reference: string }> {
  assertCan(archetype, "grn.create");
  // Add-on gate (FR-9): RECORD only — reads and cancelling an existing GRN never gate.
  await requireCapability(ctx, "cap.goods_receipts");
  const data = RecordGrnInput.parse(input);
  const id = randomUUID();
  return command<{ id: string; reference: string; poId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "grn.record",
        entityType: "goods_receipt",
        entityId: r.id,
        summary: `Recorded ${r.reference}`,
      }),
      events: (r) => [
        {
          name: GOODS_RECEIPT_RECORDED,
          payload: {
            orgId: ctx.orgId,
            actorUserId: ctx.userId,
            goodsReceiptId: r.id,
            purchaseOrderId: r.poId,
          },
        },
      ],
    },
    async (tx) => {
      // Reject a batch that references the same PO line twice — else each entry
      // passes the over-receipt check independently and cumulative exceeds ordered
      // (review fix).
      const dupIds = data.lines.map((l) => l.poLineId);
      if (new Set(dupIds).size !== dupIds.length) {
        throw new InvalidSupplyInputError("a PO line appears more than once in one receipt");
      }
      // LOCK the PO row FOR UPDATE so concurrent receipts against the same PO
      // serialize — the previously-received sum below then sees committed prior
      // receipts, preventing over-receipt under READ COMMITTED (review fix).
      const poRows = (await tx.execute(sql`
        select id::text as id, job_id::text as job_id, status
        from public.purchase_order where id = ${data.poId} and org_id = ${ctx.orgId}
        for update
      `)) as unknown as Array<{ id: string; job_id: string | null; status: string }>;
      const po = poRows[0];
      if (!po) throw new SupplyNotFoundError("purchase_order", data.poId);
      if (!["approved", "sent", "partially_received"].includes(po.status)) {
        throw new SupplyStateError(`cannot receive against a ${po.status} PO`);
      }
      if (archetype === "foreman" && po.job_id && !(await isAssignedIn(tx, ctx, po.job_id))) {
        throw new ForbiddenError("grn.create");
      }

      // Resolve ordered + previously-received per referenced PO line.
      const poLineIds = data.lines.map((l) => l.poLineId);
      const pol = (await tx.execute(sql`
        select pol.id::text as id, pol.qty::text as ordered,
               coalesce(max(i.tracking), 'none') as tracking,
               coalesce(sum(grl.received_qty) filter (where grn.status = 'recorded'), 0)::text as prev
        from public.purchase_order_line pol
        left join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
        left join public.goods_receipt_line grl on grl.po_line_id = pol.id and grl.org_id = pol.org_id
        left join public.goods_receipt grn on grn.id = grl.grn_id and grn.org_id = grl.org_id
        where pol.po_id = ${data.poId} and pol.org_id = ${ctx.orgId}
          and pol.id in (${sql.join(
            poLineIds.map((x) => sql`${x}::uuid`),
            sql`, `,
          )})
        group by pol.id, pol.qty
      `)) as unknown as Array<{ id: string; ordered: string; prev: string; tracking: string }>;
      const byId = new Map(pol.map((r) => [r.id, r]));
      for (const l of data.lines) {
        const info = byId.get(l.poLineId);
        if (!info)
          throw new InvalidSupplyInputError(`PO line ${l.poLineId} not on PO ${data.poId}`);
        // No over-receipt: cumulative received may not exceed ordered.
        if (Number(info.prev) + l.receivedQty > Number(info.ordered)) {
          throw new SupplyStateError(
            `over-receipt on line ${l.poLineId}: ${info.prev}+${l.receivedQty} > ordered ${info.ordered}`,
          );
        }
        assertTrackingRecorded(l, info.tracking);
      }

      const seq = await allocateReference(tx, ctx, "goods_receipt", 1);
      const reference = formatRef("GRN", seq);
      await tx.execute(sql`
        insert into public.goods_receipt
          (id, org_id, reference, po_id, job_id, status, received_date, notes, created_by)
        values (${id}, ${ctx.orgId}, ${reference}, ${data.poId}, ${po.job_id}, 'recorded',
                ${data.receivedDate}, ${data.notes ?? null}, ${ctx.userId})
      `);
      for (const [i, l] of data.lines.entries()) {
        const info = byId.get(l.poLineId)!;
        // What is left once damage, refusal and inspection are taken out is
        // what the business accepted. Derived here, and checked by the database
        // against received_qty, so the four can never drift apart.
        const accepted = l.receivedQty - l.damagedQty - l.rejectedQty - l.quarantineQty;
        const grlId = randomUUID();
        await tx.execute(sql`
          insert into public.goods_receipt_line
            (id, org_id, grn_id, po_line_id, ordered_qty, previously_received, received_qty,
             accepted_qty, damaged_qty, rejected_qty, quarantine_qty, sort)
          values (${grlId}, ${ctx.orgId}, ${id}, ${l.poLineId}, ${info.ordered}, ${info.prev},
                  ${l.receivedQty}, ${accepted}, ${l.damagedQty}, ${l.rejectedQty},
                  ${l.quarantineQty}, ${i})
        `);
        // The labels on the goods, recorded while someone is holding them. They
        // become ledger identity when the receipt is posted, not before.
        for (const lot of l.lots ?? []) {
          await tx.execute(sql`
            insert into public.goods_receipt_line_lot
              (org_id, grl_id, lot_code, supplier_lot_code, manufactured_on, expiry_date,
               qty, disposition)
            values (${ctx.orgId}, ${grlId}, ${lot.lotCode}, ${lot.supplierLotCode ?? null},
                    ${lot.manufacturedOn ?? null}::date, ${lot.expiryDate ?? null}::date,
                    ${lot.qty}, ${lot.disposition})
          `);
        }
        for (const s of l.serials ?? []) {
          await tx.execute(sql`
            insert into public.goods_receipt_line_serial
              (org_id, grl_id, serial_no, lot_code, disposition)
            values (${ctx.orgId}, ${grlId}, ${s.serialNo}, ${s.lotCode ?? null}, ${s.disposition})
          `);
        }
      }
      await reconcilePoStatus(tx, ctx, data.poId);
      return { id, reference, poId: data.poId };
    },
  );
}

export async function cancelGoodsReceipt(
  ctx: Ctx,
  archetype: RoleArchetype,
  grnId: string,
): Promise<{ id: string }> {
  assertCan(archetype, "grn.cancel");
  return command<{ id: string; poId: string }>(
    ctx,
    {
      audit: (r) => ({
        action: "grn.cancel",
        entityType: "goods_receipt",
        entityId: r.id,
        summary: `Cancelled goods receipt`,
      }),
      // A cancel changes the job's PO cost (the rollup counts only 'recorded' GRNs),
      // so it must invalidate the cached rollup — else the cost stays overstated until
      // the nightly reconcile fires a false drift alarm (review finding).
      events: (r: { id: string; poId: string }) => [
        {
          name: GOODS_RECEIPT_CANCELLED,
          payload: { goodsReceiptId: r.id, purchaseOrderId: r.poId },
        },
      ],
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, po_id::text as po_id, status
        from public.goods_receipt where id = ${grnId} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ id: string; po_id: string; status: string }>;
      const grn = rows[0];
      if (!grn) throw new SupplyNotFoundError("goods_receipt", grnId);
      if (grn.status !== "recorded") {
        throw new SupplyStateError(`only a recorded GRN can be cancelled (was ${grn.status})`);
      }
      // Serialize against concurrent receipts on the same PO (review fix).
      await tx.execute(sql`
        select id from public.purchase_order where id = ${grn.po_id} and org_id = ${ctx.orgId}
        for update
      `);
      // S10: guard the cancel UPDATE on status='recorded' (the pre-check preceded the PO lock, so
      // two concurrent cancels could both pass it) — a lost race is a no-op, not a duplicate
      // cancel + duplicate audit row + duplicate GOODS_RECEIPT_CANCELLED event.
      const cancelled = (await tx.execute(sql`
        update public.goods_receipt set status = 'cancelled', updated_at = now()
        where id = ${grnId} and org_id = ${ctx.orgId} and status = 'recorded'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (cancelled.length === 0) throw new SupplyStateError("GRN was concurrently cancelled");
      await reconcilePoStatus(tx, ctx, grn.po_id);
      return { id: grnId, poId: grn.po_id };
    },
  ).then((r) => ({ id: r.id }));
}

// ── reads (cost-redacted for the foreman; F-23) ──────────────────────────────
export type MrRow = {
  id: string;
  reference: string;
  status: string;
  urgency: string;
  jobReference: string | null;
  totalMinor: string | null;
  createdByName: string | null;
  createdAt: string;
};

export async function listMaterialRequests(ctx: Ctx, archetype: RoleArchetype): Promise<MrRow[]> {
  assertCan(archetype, "mr.create");
  const cost = seesCost(archetype);
  const rows = (await withCtx(ctx, async (tx) => {
    // Foreman sees only their OWN material requests.
    const scope = archetype === "foreman" ? sql`and mr.created_by = ${ctx.userId}` : sql``;
    return tx.execute(sql`
      select mr.id::text as id, mr.reference, mr.status, mr.urgency,
             j.reference as job_reference, mr.total_minor::text as total_minor,
             u.full_name as created_by_name, mr.created_at::text as created_at
      from public.material_request mr
      left join public.job j on j.id = mr.job_id and j.org_id = mr.org_id
      left join public.user_profile u on u.id = mr.created_by
      where mr.org_id = ${ctx.orgId} ${scope}
      order by mr.created_at desc
      limit 500
    `);
  })) as unknown as Array<{
    id: string;
    reference: string;
    status: string;
    urgency: string;
    job_reference: string | null;
    total_minor: string;
    created_by_name: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    urgency: r.urgency,
    jobReference: r.job_reference,
    totalMinor: cost ? r.total_minor : null,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  }));
}

export type MrDetail = {
  id: string;
  reference: string;
  status: string;
  urgency: string;
  jobReference: string | null;
  requiredDate: string | null;
  notes: string | null;
  totalMinor: string | null;
  createdBy: string;
  createdByName: string | null;
  pendingApprovalId: string | null;
  lines: Array<{
    id: string;
    itemName: string;
    qty: string;
    unit: string;
    estUnitCostMinor: string | null;
  }>;
};
export async function getMaterialRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  mrId: string,
): Promise<MrDetail | null> {
  assertCan(archetype, "mr.create");
  const cost = seesCost(archetype);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select mr.id::text as id, mr.reference, mr.status, mr.urgency,
             j.reference as job_reference, mr.required_date::text as required_date, mr.notes,
             mr.total_minor::text as total_minor, mr.created_by::text as created_by,
             u.full_name as created_by_name
      from public.material_request mr
      left join public.job j on j.id = mr.job_id and j.org_id = mr.org_id
      left join public.user_profile u on u.id = mr.created_by
      where mr.id = ${mrId} and mr.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const h = rows[0];
    if (!h) return null;
    // Foreman: only their OWN MR.
    if (archetype === "foreman" && h.created_by !== ctx.userId) return null;
    const lines = (await tx.execute(sql`
      select id::text as id, item_name, qty::text as qty, unit,
             est_unit_cost_minor::text as est_unit_cost_minor
      from public.material_request_line
      where mr_id = ${mrId} and org_id = ${ctx.orgId} and superseded_at is null
      order by sort asc
    `)) as unknown as Array<{
      id: string;
      item_name: string;
      qty: string;
      unit: string;
      est_unit_cost_minor: string | null;
    }>;
    const pending = (await tx.execute(sql`
      select id::text as id from public.approval
      where org_id = ${ctx.orgId} and subject_type = 'material_request' and subject_id = ${mrId}
        and state = 'pending' limit 1
    `)) as unknown as Array<{ id: string }>;
    return {
      id: h.id as string,
      reference: h.reference as string,
      status: h.status as string,
      urgency: h.urgency as string,
      jobReference: (h.job_reference as string | null) ?? null,
      requiredDate: (h.required_date as string | null) ?? null,
      notes: (h.notes as string | null) ?? null,
      totalMinor: cost ? ((h.total_minor as string | null) ?? null) : null,
      createdBy: h.created_by as string,
      createdByName: (h.created_by_name as string | null) ?? null,
      pendingApprovalId: pending[0]?.id ?? null,
      lines: lines.map((l) => ({
        id: l.id,
        itemName: l.item_name,
        qty: l.qty,
        unit: l.unit,
        estUnitCostMinor: cost ? l.est_unit_cost_minor : null,
      })),
    };
  });
}

export type PoDetail = {
  id: string;
  reference: string;
  status: string;
  supplierName: string | null;
  jobReference: string | null;
  vatMinor: string;
  totalMinor: string;
  notes: string | null;
  pdfFileId: string | null;
  pendingApprovalId: string | null;
  lines: Array<{
    id: string;
    itemName: string;
    qty: string;
    unit: string;
    unitCostMinor: string;
    lineTotalMinor: string;
    orderedQty: string;
    receivedQty: string;
  }>;
};
export async function getPurchaseOrder(
  ctx: Ctx,
  archetype: RoleArchetype,
  poId: string,
): Promise<PoDetail | null> {
  assertCan(archetype, "po.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select po.id::text as id, po.reference, po.status, s.name as supplier_name,
             j.reference as job_reference, po.vat_minor::text as vat_minor,
             po.total_minor::text as total_minor, po.notes, po.pdf_file_id::text as pdf_file_id
      from public.purchase_order po
      left join public.supplier s on s.id = po.supplier_id and s.org_id = po.org_id
      left join public.job j on j.id = po.job_id and j.org_id = po.org_id
      where po.id = ${poId} and po.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const h = rows[0];
    if (!h) return null;
    const lines = (await tx.execute(sql`
      select pol.id::text as id, pol.item_name, pol.qty::text as qty, pol.unit,
             pol.unit_cost_minor::text as unit_cost_minor, pol.line_total_minor::text as line_total_minor,
             coalesce(sum(grl.received_qty) filter (where grn.status = 'recorded'), 0)::text as received_qty
      from public.purchase_order_line pol
      left join public.goods_receipt_line grl on grl.po_line_id = pol.id and grl.org_id = pol.org_id
      left join public.goods_receipt grn on grn.id = grl.grn_id and grn.org_id = grl.org_id
      where pol.po_id = ${poId} and pol.org_id = ${ctx.orgId} and pol.superseded_at is null
      group by pol.id, pol.item_name, pol.qty, pol.unit, pol.unit_cost_minor, pol.line_total_minor, pol.sort
      order by pol.sort asc
    `)) as unknown as Array<{
      id: string;
      item_name: string;
      qty: string;
      unit: string;
      unit_cost_minor: string;
      line_total_minor: string;
      received_qty: string;
    }>;
    const pending = (await tx.execute(sql`
      select id::text as id from public.approval
      where org_id = ${ctx.orgId} and subject_type = 'purchase_order' and subject_id = ${poId}
        and state = 'pending' limit 1
    `)) as unknown as Array<{ id: string }>;
    return {
      id: h.id as string,
      reference: h.reference as string,
      status: h.status as string,
      supplierName: (h.supplier_name as string | null) ?? null,
      jobReference: (h.job_reference as string | null) ?? null,
      vatMinor: h.vat_minor as string,
      totalMinor: h.total_minor as string,
      notes: (h.notes as string | null) ?? null,
      pdfFileId: (h.pdf_file_id as string | null) ?? null,
      pendingApprovalId: pending[0]?.id ?? null,
      lines: lines.map((l) => ({
        id: l.id,
        itemName: l.item_name,
        qty: l.qty,
        unit: l.unit,
        unitCostMinor: l.unit_cost_minor,
        lineTotalMinor: l.line_total_minor,
        orderedQty: l.qty,
        receivedQty: l.received_qty,
      })),
    };
  });
}

/**
 * Build the bilingual LPO HTML for a PO — INTERNAL (called by the PDF worker with
 * a verified system ctx; no assertCan, org-scoped RLS is the wall). Reads the PO
 * cost data (POs carry no RLS cost wall — operational purchasing data) and passes
 * the ALREADY-computed totals to the template (P5: no VAT re-derivation). Returns
 * null if the PO is not visible in the org context.
 */
export async function buildLpoHtmlForPo(ctx: Ctx, poId: string): Promise<string | null> {
  // 003B.1: core document identity — logo + footer embed for EVERY org
  // (getDocBranding never throws; missing logo → text fallback).
  const branding = await getDocBranding(ctx);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select po.reference, po.vat_minor::text as vat_minor, po.total_minor::text as total_minor,
             po.notes, po.created_at::text as created_at,
             s.name as supplier_name, j.reference as job_reference,
             o.name as org_name, o.base_currency as currency
      from public.purchase_order po
      join public.org o on o.id = po.org_id
      left join public.supplier s on s.id = po.supplier_id and s.org_id = po.org_id
      left join public.job j on j.id = po.job_id and j.org_id = po.org_id
      where po.id = ${poId} and po.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const h = rows[0];
    if (!h) return null;
    const lines = (await tx.execute(sql`
      select item_name, qty::text as qty, unit, unit_cost_minor::text as unit_cost_minor,
             line_total_minor::text as line_total_minor
      from public.purchase_order_line
      where po_id = ${poId} and org_id = ${ctx.orgId} and superseded_at is null
      order by sort asc
    `)) as unknown as Array<{
      item_name: string;
      qty: string;
      unit: string;
      unit_cost_minor: string;
      line_total_minor: string;
    }>;
    return lpoHtml(
      {
        reference: h.reference as string,
        supplierName: (h.supplier_name as string | null) ?? null,
        jobReference: (h.job_reference as string | null) ?? null,
        issueDate: (h.created_at as string).slice(0, 10),
        vatMinor: h.vat_minor as string,
        totalMinor: h.total_minor as string,
        notes: (h.notes as string | null) ?? null,
        lines: lines.map((l) => ({
          itemName: l.item_name,
          qty: l.qty,
          unit: l.unit,
          unitCostMinor: l.unit_cost_minor,
          lineTotalMinor: l.line_total_minor,
        })),
      },
      {
        orgName: branding.displayName ?? (h.org_name as string),
        currency: h.currency as CurrencyCode,
        poTermEn: "Local Purchase Order",
        poTermAr: "أمر شراء محلي",
        logoDataUri: branding.logoDataUri,
        footerDetails: branding.footerDetails,
      },
    );
  });
}

export type PoRow = {
  id: string;
  reference: string;
  status: string;
  supplierName: string | null;
  jobReference: string | null;
  totalMinor: string;
  hasPdf: boolean;
  createdAt: string;
};

export async function listPurchaseOrders(ctx: Ctx, archetype: RoleArchetype): Promise<PoRow[]> {
  assertCan(archetype, "po.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select po.id::text as id, po.reference, po.status, s.name as supplier_name,
             j.reference as job_reference, po.total_minor::text as total_minor,
             (po.pdf_file_id is not null) as has_pdf, po.created_at::text as created_at
      from public.purchase_order po
      left join public.supplier s on s.id = po.supplier_id and s.org_id = po.org_id
      left join public.job j on j.id = po.job_id and j.org_id = po.org_id
      where po.org_id = ${ctx.orgId}
      order by po.created_at desc
      limit 500
    `),
  )) as unknown as Array<{
    id: string;
    reference: string;
    status: string;
    supplier_name: string | null;
    job_reference: string | null;
    total_minor: string;
    has_pdf: boolean;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    supplierName: r.supplier_name,
    jobReference: r.job_reference,
    totalMinor: r.total_minor,
    hasPdf: r.has_pdf,
    createdAt: r.created_at,
  }));
}
