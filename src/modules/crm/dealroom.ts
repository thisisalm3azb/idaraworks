/**
 * H27 — the opportunity's commercial context (ADR-37) and the deal room
 * composition: stakeholders, products and pricing, competitors, risks, the
 * commercial fields, the optional deal canvas, and one read that assembles
 * everything the deal room shows from the owning modules.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { PipelineError } from "./pipelines";

const uuid = z.string().uuid();
const ROLE_KINDS = [
  "decision_maker",
  "economic_buyer",
  "influencer",
  "champion",
  "user",
  "procurement",
  "finance",
  "technical",
  "blocker",
  "other",
] as const;

async function openOpportunityIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
  lock = false,
): Promise<{ id: string; status: string }> {
  const rows = (await tx.execute(
    lock
      ? sql`select id::text as id, status from public.opportunity where id = ${id} and org_id = ${ctx.orgId} and archived = false for update`
      : sql`select id::text as id, status from public.opportunity where id = ${id} and org_id = ${ctx.orgId} and archived = false`,
  )) as unknown as Array<{ id: string; status: string }>;
  if (!rows[0]) throw new PipelineError("opportunity not found", "not_found");
  return rows[0];
}

async function touchOpportunityIn(tx: TenantTx, ctx: Ctx, id: string): Promise<void> {
  await tx.execute(sql`
    update public.opportunity set last_activity_at = now(), updated_at = now()
    where id = ${id} and org_id = ${ctx.orgId}
  `);
}

// ── stakeholders ──────────────────────────────────────────────────────────────
export type StakeholderRow = {
  id: string;
  contactId: string | null;
  name: string;
  roleKind: (typeof ROLE_KINDS)[number];
  influence: number;
  sentiment: "supporter" | "neutral" | "detractor" | "unknown";
  notes: string | null;
};

export const StakeholderInput = z.object({
  opportunityId: uuid,
  contactId: uuid.optional().nullable(),
  name: z.string().trim().min(1).max(120).optional().nullable(),
  roleKind: z.enum(ROLE_KINDS).default("other"),
  influence: z.number().int().min(1).max(5).default(3),
  sentiment: z.enum(["supporter", "neutral", "detractor", "unknown"]).default("unknown"),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export async function addStakeholder(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "opportunities.manage");
  const input = StakeholderInput.parse(raw);
  if (!input.contactId && !input.name)
    throw new PipelineError("a contact or a name is required", "validation");
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.stakeholder.add",
        entityType: "opportunity",
        entityId: input.opportunityId,
        summary: `Added stakeholder ${r.id.slice(0, 8)}`,
      }),
    },
    async (tx) => {
      await openOpportunityIn(tx, ctx, input.opportunityId);
      if (input.contactId) {
        const c = (await tx.execute(sql`
          select 1 from public.customer_contact where id = ${input.contactId} and org_id = ${ctx.orgId}
        `)) as unknown as unknown[];
        if (!c.length) throw new PipelineError("contact not found", "not_found");
      }
      const rows = (await tx.execute(sql`
        insert into public.crm_opportunity_stakeholder
          (org_id, opportunity_id, contact_id, name, role_kind, influence, sentiment, notes, created_by)
        values (${ctx.orgId}, ${input.opportunityId}, ${input.contactId ?? null}, ${input.name ?? null},
                ${input.roleKind}, ${input.influence}, ${input.sentiment}, ${input.notes ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await touchOpportunityIn(tx, ctx, input.opportunityId);
      return { id: rows[0]!.id };
    },
  );
}

export const StakeholderPatch = z.object({
  id: uuid,
  roleKind: z.enum(ROLE_KINDS).optional(),
  influence: z.number().int().min(1).max(5).optional(),
  sentiment: z.enum(["supporter", "neutral", "detractor", "unknown"]).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export async function updateStakeholder(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  const input = StakeholderPatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.stakeholder.update",
        entityType: "opportunity",
        summary: `Stakeholder ${input.id.slice(0, 8)}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_opportunity_stakeholder set
          role_kind = coalesce(${input.roleKind ?? null}, role_kind),
          influence = coalesce(${input.influence ?? null}, influence),
          sentiment = coalesce(${input.sentiment ?? null}, sentiment),
          notes = case when ${input.notes === undefined} then notes else ${input.notes ?? null} end
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

// ── products and pricing ──────────────────────────────────────────────────────
export type ProductLine = {
  id: string;
  itemId: string | null;
  description: string;
  qty: number;
  unit: string;
  unitPriceMinor: number;
  discountPct: number;
  vatRate: number;
  /** Redacted unless cost-privileged. */
  unitCostMinor: number | null;
  optional: boolean;
  bundleKey: string | null;
  recurrenceMonths: number | null;
  sort: number;
  lineNetMinor: number;
  lineVatMinor: number;
  lineTotalMinor: number;
  marginMinor: number | null;
};

export const ProductLineInput = z.object({
  opportunityId: uuid,
  itemId: uuid.optional().nullable(),
  description: z.string().trim().min(1).max(300),
  qty: z.number().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(16).default("ea"),
  unitPriceMinor: z.number().int().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  vatRate: z.number().min(0).max(100).default(0),
  unitCostMinor: z.number().int().min(0).optional().nullable(),
  optional: z.boolean().default(false),
  bundleKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .nullable(),
  recurrenceMonths: z.number().int().min(1).max(120).optional().nullable(),
  sort: z.number().int().min(0).default(0),
});

/** Pure line arithmetic in minor units (mirrors quotes.computeQuoteTotals; no floats near money). */
export function computeLine(l: {
  qty: number;
  unitPriceMinor: number;
  discountPct: number;
  vatRate: number;
  unitCostMinor: number | null;
}) {
  const gross = Math.round(l.qty * l.unitPriceMinor);
  const net = Math.round(gross * (1 - l.discountPct / 100));
  const vat = Math.round((net * l.vatRate) / 100);
  const cost = l.unitCostMinor === null ? null : Math.round(l.qty * l.unitCostMinor);
  return {
    lineNetMinor: net,
    lineVatMinor: vat,
    lineTotalMinor: net + vat,
    marginMinor: cost === null ? null : net - cost,
  };
}

export async function addProductLine(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "opportunities.manage");
  const input = ProductLineInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "crm.product.add",
        entityType: "opportunity",
        entityId: input.opportunityId,
        summary: input.description,
      },
    },
    async (tx) => {
      const opp = await openOpportunityIn(tx, ctx, input.opportunityId);
      if (opp.status !== "open")
        throw new PipelineError("only an open opportunity is priced", "state");
      if (input.itemId) {
        const it = (await tx.execute(
          sql`select 1 from public.item where id = ${input.itemId} and org_id = ${ctx.orgId}`,
        )) as unknown as unknown[];
        if (!it.length) throw new PipelineError("item not found", "not_found");
      }
      const rows = (await tx.execute(sql`
        insert into public.crm_opportunity_product
          (org_id, opportunity_id, item_id, description, qty, unit, unit_price_minor, discount_pct, vat_rate, unit_cost_minor,
           optional, bundle_key, recurrence_months, sort, created_by)
        values (${ctx.orgId}, ${input.opportunityId}, ${input.itemId ?? null}, ${input.description}, ${input.qty}, ${input.unit},
                ${input.unitPriceMinor}, ${input.discountPct}, ${input.vatRate}, ${ctx.costPrivileged ? (input.unitCostMinor ?? null) : null},
                ${input.optional}, ${input.bundleKey ?? null}, ${input.recurrenceMonths ?? null}, ${input.sort}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await syncOpportunityValueIn(tx, ctx, input.opportunityId);
      return { id: rows[0]!.id };
    },
  );
}

/** Explicit patch: never re-applies ProductLineInput defaults (unit, discount, VAT, optional, sort). */
export const ProductLinePatch = z.object({
  id: uuid,
  itemId: uuid.optional().nullable(),
  description: z.string().trim().min(1).max(300).optional(),
  qty: z.number().positive().max(1_000_000_000).optional(),
  unit: z.string().trim().min(1).max(16).optional(),
  unitPriceMinor: z.number().int().min(0).optional(),
  discountPct: z.number().min(0).max(100).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  unitCostMinor: z.number().int().min(0).optional().nullable(),
  optional: z.boolean().optional(),
  bundleKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .nullable(),
  recurrenceMonths: z.number().int().min(1).max(120).optional().nullable(),
  sort: z.number().int().min(0).optional(),
});

export async function updateProductLine(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  const input = ProductLinePatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.product.update",
        entityType: "opportunity",
        summary: `Line ${input.id.slice(0, 8)}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.crm_opportunity_product set
          description = coalesce(${input.description ?? null}, description),
          qty = coalesce(${input.qty ?? null}, qty),
          unit = coalesce(${input.unit ?? null}, unit),
          unit_price_minor = coalesce(${input.unitPriceMinor ?? null}, unit_price_minor),
          discount_pct = coalesce(${input.discountPct ?? null}, discount_pct),
          vat_rate = coalesce(${input.vatRate ?? null}, vat_rate),
          unit_cost_minor = case when ${input.unitCostMinor === undefined || !ctx.costPrivileged} then unit_cost_minor else ${input.unitCostMinor ?? null} end,
          optional = coalesce(${input.optional ?? null}, optional),
          bundle_key = case when ${input.bundleKey === undefined} then bundle_key else ${input.bundleKey ?? null} end,
          recurrence_months = case when ${input.recurrenceMonths === undefined} then recurrence_months else ${input.recurrenceMonths ?? null} end,
          sort = coalesce(${input.sort ?? null}, sort)
        where id = ${input.id} and org_id = ${ctx.orgId}
        returning opportunity_id::text as opportunity_id
      `)) as unknown as Array<{ opportunity_id: string }>;
      if (rows[0]) await syncOpportunityValueIn(tx, ctx, rows[0].opportunity_id);
    },
  );
}

/** Products are the one computing owner of the opportunity's estimated value once any line exists (P4). */
export async function syncOpportunityValueIn(
  tx: TenantTx,
  ctx: Ctx,
  opportunityId: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    select qty, unit_price_minor, discount_pct, vat_rate, optional from public.crm_opportunity_product
    where org_id = ${ctx.orgId} and opportunity_id = ${opportunityId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  let net = 0;
  for (const r of rows) {
    if (r.optional) continue;
    net += computeLine({
      qty: Number(r.qty),
      unitPriceMinor: Number(r.unit_price_minor),
      discountPct: Number(r.discount_pct),
      vatRate: Number(r.vat_rate),
      unitCostMinor: null,
    }).lineNetMinor;
  }
  await tx.execute(sql`
    update public.opportunity set estimated_value_minor = ${net}, last_activity_at = now(), updated_at = now()
    where id = ${opportunityId} and org_id = ${ctx.orgId}
  `);
}

export async function listProductLines(
  ctx: Ctx,
  archetype: RoleArchetype,
  opportunityId: string,
): Promise<ProductLine[]> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, item_id::text as item_id, description, qty, unit, unit_price_minor, discount_pct, vat_rate,
             unit_cost_minor, optional, bundle_key, recurrence_months, sort
      from public.crm_opportunity_product where org_id = ${ctx.orgId} and opportunity_id = ${opportunityId}
      order by sort asc, created_at asc
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const base = {
      qty: Number(r.qty),
      unitPriceMinor: ctx.pricePrivileged ? Number(r.unit_price_minor) : 0,
      discountPct: Number(r.discount_pct),
      vatRate: Number(r.vat_rate),
      unitCostMinor:
        ctx.costPrivileged && r.unit_cost_minor !== null ? Number(r.unit_cost_minor) : null,
    };
    const c = computeLine(base);
    return {
      id: String(r.id),
      itemId: (r.item_id as string | null) ?? null,
      description: String(r.description),
      qty: base.qty,
      unit: String(r.unit),
      unitPriceMinor: base.unitPriceMinor,
      discountPct: base.discountPct,
      vatRate: base.vatRate,
      unitCostMinor: base.unitCostMinor,
      optional: Boolean(r.optional),
      bundleKey: (r.bundle_key as string | null) ?? null,
      recurrenceMonths: r.recurrence_months === null ? null : Number(r.recurrence_months),
      sort: Number(r.sort),
      lineNetMinor: ctx.pricePrivileged ? c.lineNetMinor : 0,
      lineVatMinor: ctx.pricePrivileged ? c.lineVatMinor : 0,
      lineTotalMinor: ctx.pricePrivileged ? c.lineTotalMinor : 0,
      marginMinor: ctx.costPrivileged && ctx.pricePrivileged ? c.marginMinor : null,
    };
  });
}

// ── competitors and risks ─────────────────────────────────────────────────────
export const CompetitorInput = z.object({
  opportunityId: uuid,
  name: z.string().trim().min(1).max(120),
  strengths: z.string().trim().max(1000).optional().nullable(),
  weaknesses: z.string().trim().max(1000).optional().nullable(),
  status: z.enum(["active", "eliminated", "won_against_us", "unknown"]).default("active"),
});

export async function addCompetitor(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "opportunities.manage");
  const input = CompetitorInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "crm.competitor.add",
        entityType: "opportunity",
        entityId: input.opportunityId,
        summary: input.name,
      },
    },
    async (tx) => {
      await openOpportunityIn(tx, ctx, input.opportunityId);
      const rows = (await tx.execute(sql`
        insert into public.crm_opportunity_competitor (org_id, opportunity_id, name, strengths, weaknesses, status, created_by)
        values (${ctx.orgId}, ${input.opportunityId}, ${input.name}, ${input.strengths ?? null}, ${input.weaknesses ?? null}, ${input.status}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export const RiskInput = z.object({
  opportunityId: uuid,
  kind: z.enum(["risk", "blocker", "dependency"]).default("risk"),
  title: z.string().trim().min(1).max(200),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  mitigation: z.string().trim().max(1000).optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
});

export async function addRisk(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "opportunities.manage");
  const input = RiskInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "crm.risk.add",
        entityType: "opportunity",
        entityId: input.opportunityId,
        summary: input.title,
      },
    },
    async (tx) => {
      await openOpportunityIn(tx, ctx, input.opportunityId);
      const rows = (await tx.execute(sql`
        insert into public.crm_opportunity_risk (org_id, opportunity_id, kind, title, severity, mitigation, owner_user_id, created_by)
        values (${ctx.orgId}, ${input.opportunityId}, ${input.kind}, ${input.title}, ${input.severity}, ${input.mitigation ?? null}, ${input.ownerUserId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function setRiskStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  const input = z
    .object({
      id: uuid,
      status: z.enum(["open", "mitigated", "closed"]),
      mitigation: z.string().trim().max(1000).optional().nullable(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.risk.status",
        entityType: "opportunity",
        summary: `${input.id.slice(0, 8)} → ${input.status}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_opportunity_risk set status = ${input.status},
          mitigation = case when ${input.mitigation === undefined} then mitigation else ${input.mitigation ?? null} end
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

// ── commercial fields on the opportunity ──────────────────────────────────────
export const CommercialPatch = z.object({
  id: uuid,
  rowVersion: z.number().int().min(1),
  forecastCategory: z.enum(["pipeline", "best_case", "commit", "omitted"]).optional(),
  kind: z.enum(["new_business", "expansion", "renewal"]).optional(),
  amountKind: z.enum(["one_time", "recurring", "mixed"]).optional(),
  recurringMinor: z.number().int().min(0).optional().nullable(),
  recurrenceMonths: z.number().int().min(1).max(120).optional().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  probability: z.number().int().min(0).max(100).optional().nullable(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  decisionCriteria: z.string().trim().max(2000).optional().nullable(),
  needs: z.string().trim().max(4000).optional().nullable(),
  buyingProcess: z
    .array(
      z.object({
        step: z.string().trim().min(1).max(120),
        owner: z.string().trim().max(120).optional(),
        done: z.boolean().default(false),
        due: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
    )
    .max(20)
    .optional(),
  campaignId: uuid.optional().nullable(),
  territoryId: uuid.optional().nullable(),
  source: z.string().trim().max(80).optional().nullable(),
  nextAction: z.string().trim().max(300).optional().nullable(),
  nextActionDue: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

/** Update the commercial context; a forecast category change is recorded as a forecast activity (never silent). */
export async function updateCommercial(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number }> {
  assertCan(archetype, "opportunities.manage");
  const input = CommercialPatch.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "opportunity.update",
        entityType: "opportunity",
        entityId: input.id,
        summary: "Commercial context updated",
      },
    },
    async (tx) => {
      const cur = (await tx.execute(sql`
        select row_version, forecast_category, status from public.opportunity
        where id = ${input.id} and org_id = ${ctx.orgId} and archived = false for update
      `)) as unknown as Array<{ row_version: number; forecast_category: string; status: string }>;
      if (!cur[0]) throw new PipelineError("opportunity not found", "not_found");
      if (Number(cur[0].row_version) !== input.rowVersion)
        throw new PipelineError("the opportunity changed; reload and try again", "conflict");
      const u = (k: keyof typeof input) => input[k] === undefined;
      const rows = (await tx.execute(sql`
        update public.opportunity set
          forecast_category = coalesce(${input.forecastCategory ?? null}, forecast_category),
          kind = coalesce(${input.kind ?? null}, kind),
          amount_kind = coalesce(${input.amountKind ?? null}, amount_kind),
          recurring_minor = case when ${u("recurringMinor")} then recurring_minor else ${input.recurringMinor ?? null} end,
          recurrence_months = case when ${u("recurrenceMonths")} then recurrence_months else ${input.recurrenceMonths ?? null} end,
          currency = case when ${u("currency")} then currency else ${input.currency ?? null} end,
          probability = case when ${u("probability")} then probability else ${input.probability ?? null} end,
          expected_close_date = case when ${u("expectedCloseDate")} then expected_close_date else ${input.expectedCloseDate ?? null}::date end,
          decision_criteria = case when ${u("decisionCriteria")} then decision_criteria else ${input.decisionCriteria ?? null} end,
          needs = case when ${u("needs")} then needs else ${input.needs ?? null} end,
          buying_process = coalesce(${input.buyingProcess ? JSON.stringify(input.buyingProcess) : null}::jsonb, buying_process),
          campaign_id = case when ${u("campaignId")} then campaign_id else ${input.campaignId ?? null}::uuid end,
          territory_id = case when ${u("territoryId")} then territory_id else ${input.territoryId ?? null}::uuid end,
          source = case when ${u("source")} then source else ${input.source ?? null} end,
          next_action = case when ${u("nextAction")} then next_action else ${input.nextAction ?? null} end,
          next_action_due = case when ${u("nextActionDue")} then next_action_due else ${input.nextActionDue ?? null}::date end,
          last_activity_at = now(), row_version = row_version + 1, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId}
        returning row_version
      `)) as unknown as Array<{ row_version: number }>;
      if (input.forecastCategory && input.forecastCategory !== cur[0].forecast_category)
        await tx.execute(sql`
          insert into public.sales_activity (org_id, opportunity_id, kind, title, actor_user_id, meta)
          values (${ctx.orgId}, ${input.id}, 'forecast', ${`${cur[0].forecast_category}|${input.forecastCategory}`}, ${ctx.userId},
                  ${JSON.stringify({ from: cur[0].forecast_category, to: input.forecastCategory })}::jsonb)
        `);
      return { rowVersion: Number(rows[0]!.row_version) };
    },
  );
}

// ── the deal canvas ───────────────────────────────────────────────────────────
export const CanvasDoc = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        kind: z.enum([
          "stakeholder",
          "decision",
          "risk",
          "document",
          "step",
          "note",
          "competitor",
          "product",
        ]),
        label: z.string().max(200),
        x: z.number(),
        y: z.number(),
        ref: z.string().max(80).optional(),
      }),
    )
    .max(200),
  edges: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        from: z.string(),
        to: z.string(),
        label: z.string().max(120).optional(),
      }),
    )
    .max(400),
});
export type CanvasDoc = z.infer<typeof CanvasDoc>;

export async function getDealCanvas(
  ctx: Ctx,
  archetype: RoleArchetype,
  opportunityId: string,
): Promise<{ doc: CanvasDoc; rowVersion: number }> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select doc, row_version from public.crm_deal_canvas where opportunity_id = ${opportunityId} and org_id = ${ctx.orgId}`,
    ),
  )) as unknown as Array<{ doc: unknown; row_version: number }>;
  if (!rows[0]) return { doc: { nodes: [], edges: [] }, rowVersion: 0 };
  return { doc: CanvasDoc.parse(rows[0].doc), rowVersion: Number(rows[0].row_version) };
}

export async function saveDealCanvas(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number }> {
  assertCan(archetype, "opportunities.manage");
  const input = z
    .object({ opportunityId: uuid, rowVersion: z.number().int().min(0), doc: CanvasDoc })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "crm.canvas.save",
        entityType: "opportunity",
        entityId: input.opportunityId,
        summary: `${input.doc.nodes.length} nodes`,
      },
    },
    async (tx) => {
      await openOpportunityIn(tx, ctx, input.opportunityId);
      if (input.rowVersion === 0) {
        const rows = (await tx.execute(sql`
          insert into public.crm_deal_canvas (org_id, opportunity_id, doc, updated_by)
          values (${ctx.orgId}, ${input.opportunityId}, ${JSON.stringify(input.doc)}::jsonb, ${ctx.userId})
          on conflict (opportunity_id) do nothing
          returning row_version
        `)) as unknown as Array<{ row_version: number }>;
        if (!rows[0])
          throw new PipelineError("the canvas changed; reload and try again", "conflict");
        return { rowVersion: Number(rows[0].row_version) };
      }
      const rows = (await tx.execute(sql`
        update public.crm_deal_canvas set doc = ${JSON.stringify(input.doc)}::jsonb, row_version = row_version + 1, updated_by = ${ctx.userId}
        where opportunity_id = ${input.opportunityId} and org_id = ${ctx.orgId} and row_version = ${input.rowVersion}
        returning row_version
      `)) as unknown as Array<{ row_version: number }>;
      if (!rows[0]) throw new PipelineError("the canvas changed; reload and try again", "conflict");
      return { rowVersion: Number(rows[0].row_version) };
    },
  );
}

// ── the deal room read ────────────────────────────────────────────────────────
export type DealRoom = {
  stakeholders: StakeholderRow[];
  products: ProductLine[];
  totals: {
    netMinor: number | null;
    vatMinor: number | null;
    totalMinor: number | null;
    marginMinor: number | null;
    recurringMinor: number | null;
  };
  competitors: Array<{
    id: string;
    name: string;
    strengths: string | null;
    weaknesses: string | null;
    status: string;
  }>;
  risks: Array<{
    id: string;
    kind: string;
    title: string;
    severity: string;
    status: string;
    mitigation: string | null;
    ownerUserId: string | null;
  }>;
  contract: { id: string; reference: string; title: string; status: string } | null;
  jobs: Array<{ id: string; reference: string; name: string; statusCategory: string }>;
  invoices: Array<{
    id: string;
    reference: string;
    status: string;
    totalMinor: number | null;
    dueDate: string | null;
  }>;
  discounts: Array<{
    id: string;
    requestedPct: number;
    status: string;
    reason: string;
    createdAt: string;
  }>;
  stageHistory: Array<{
    from: string;
    to: string;
    reason: string | null;
    ageDays: number | null;
    at: string;
    actorName: string | null;
  }>;
  forecastHistory: Array<{ from: string; to: string; at: string; actorName: string | null }>;
  coverage: { decisionMaker: boolean; champion: boolean; economicBuyer: boolean; blockers: number };
};

export async function gatherDealRoom(
  ctx: Ctx,
  archetype: RoleArchetype,
  opportunityId: string,
): Promise<DealRoom> {
  assertCan(archetype, "opportunities.view");
  const products = await listProductLines(ctx, archetype, opportunityId);
  return withCtx(ctx, async (tx) => {
    const stakeholders = (await tx.execute(sql`
      select s.id::text as id, s.contact_id::text as contact_id, coalesce(c.name, s.name) as name, s.role_kind, s.influence, s.sentiment, s.notes
      from public.crm_opportunity_stakeholder s
      left join public.customer_contact c on c.id = s.contact_id
      where s.org_id = ${ctx.orgId} and s.opportunity_id = ${opportunityId}
      order by s.influence desc, s.created_at asc
    `)) as unknown as Array<Record<string, unknown>>;
    const competitors = (await tx.execute(sql`
      select id::text as id, name, strengths, weaknesses, status from public.crm_opportunity_competitor
      where org_id = ${ctx.orgId} and opportunity_id = ${opportunityId} order by created_at asc
    `)) as unknown as Array<Record<string, unknown>>;
    const risks = (await tx.execute(sql`
      select id::text as id, kind, title, severity, status, mitigation, owner_user_id::text as owner_user_id
      from public.crm_opportunity_risk where org_id = ${ctx.orgId} and opportunity_id = ${opportunityId}
      order by (status = 'open') desc, severity desc, created_at asc
    `)) as unknown as Array<Record<string, unknown>>;
    const contract = (await tx.execute(sql`
      select d.id::text as id, d.reference, d.title, d.status
      from public.opportunity o join public.doc_document d on d.id = o.contract_document_id and d.org_id = o.org_id
      where o.id = ${opportunityId} and o.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    const jobs = can(archetype, "jobs.view")
      ? ((await tx.execute(sql`
          select j.id::text as id, j.reference, j.name, j.status_category
          from public.job j join public.opportunity o on o.org_id = j.org_id and (j.source_opportunity_id = o.id or (o.quote_id is not null and j.id = (select converted_job_id from public.quote q where q.id = o.quote_id)))
          where o.id = ${opportunityId} and o.org_id = ${ctx.orgId} and j.archived = false
          order by j.created_at desc limit 10
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const invoices = can(archetype, "invoices.view")
      ? ((await tx.execute(sql`
          select i.id::text as id, i.reference, i.status, i.total_minor, i.due_date::text as due_date
          from public.invoice i
          where i.org_id = ${ctx.orgId} and i.job_id in (
            select j.id from public.job j join public.opportunity o on o.org_id = j.org_id and (j.source_opportunity_id = o.id or (o.quote_id is not null and j.id = (select converted_job_id from public.quote q where q.id = o.quote_id)))
            where o.id = ${opportunityId} and o.org_id = ${ctx.orgId})
          order by i.created_at desc limit 20
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const discounts = (await tx.execute(sql`
      select id::text as id, requested_pct, status, reason, created_at::text as created_at from public.crm_discount
      where org_id = ${ctx.orgId} and opportunity_id = ${opportunityId} order by created_at desc limit 20
    `)) as unknown as Array<Record<string, unknown>>;
    const history = (await tx.execute(sql`
      select a.kind, a.title, a.body, a.meta, a.created_at::text as at, u.full_name as actor_name
      from public.sales_activity a left join public.user_profile u on u.id = a.actor_user_id
      where a.org_id = ${ctx.orgId} and a.opportunity_id = ${opportunityId} and a.kind in ('stage_change', 'forecast')
      order by a.created_at asc limit 200
    `)) as unknown as Array<Record<string, unknown>>;
    const seesPrice = ctx.pricePrivileged;
    const totals = products
      .filter((p) => !p.optional)
      .reduce(
        (t, p) => ({
          netMinor: t.netMinor + p.lineNetMinor,
          vatMinor: t.vatMinor + p.lineVatMinor,
          totalMinor: t.totalMinor + p.lineTotalMinor,
          marginMinor:
            p.marginMinor === null || t.marginMinor === null ? null : t.marginMinor + p.marginMinor,
          recurringMinor: t.recurringMinor + (p.recurrenceMonths ? p.lineNetMinor : 0),
        }),
        {
          netMinor: 0,
          vatMinor: 0,
          totalMinor: 0,
          marginMinor: (ctx.costPrivileged ? 0 : null) as number | null,
          recurringMinor: 0,
        },
      );
    const sh = stakeholders.map((r) => ({
      id: String(r.id),
      contactId: (r.contact_id as string | null) ?? null,
      name: String(r.name ?? ""),
      roleKind: String(r.role_kind) as StakeholderRow["roleKind"],
      influence: Number(r.influence),
      sentiment: String(r.sentiment) as StakeholderRow["sentiment"],
      notes: (r.notes as string | null) ?? null,
    }));
    return {
      stakeholders: sh,
      products,
      totals: seesPrice
        ? totals
        : {
            netMinor: null,
            vatMinor: null,
            totalMinor: null,
            marginMinor: null,
            recurringMinor: null,
          },
      competitors: competitors.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        strengths: (r.strengths as string | null) ?? null,
        weaknesses: (r.weaknesses as string | null) ?? null,
        status: String(r.status),
      })),
      risks: risks.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        title: String(r.title),
        severity: String(r.severity),
        status: String(r.status),
        mitigation: (r.mitigation as string | null) ?? null,
        ownerUserId: (r.owner_user_id as string | null) ?? null,
      })),
      contract: contract[0]
        ? {
            id: String(contract[0].id),
            reference: String(contract[0].reference),
            title: String(contract[0].title),
            status: String(contract[0].status),
          }
        : null,
      jobs: jobs.map((r) => ({
        id: String(r.id),
        reference: String(r.reference),
        name: String(r.name),
        statusCategory: String(r.status_category),
      })),
      invoices: invoices.map((r) => ({
        id: String(r.id),
        reference: String(r.reference),
        status: String(r.status),
        totalMinor: seesPrice ? Number(r.total_minor) : null,
        dueDate: (r.due_date as string | null) ?? null,
      })),
      discounts: discounts.map((r) => ({
        id: String(r.id),
        requestedPct: Number(r.requested_pct),
        status: String(r.status),
        reason: String(r.reason),
        createdAt: String(r.created_at),
      })),
      stageHistory: history
        .filter((h) => h.kind === "stage_change")
        .map((h) => {
          const m = (h.meta as Record<string, unknown>) ?? {};
          const [from, to] = String(h.title ?? h.body ?? "|").split("|");
          return {
            from: String(m.from ?? from ?? ""),
            to: String(m.to ?? to ?? ""),
            reason: (m.reason as string | null) ?? (h.body as string | null) ?? null,
            ageDays: m.ageDays === undefined ? null : Number(m.ageDays),
            at: String(h.at),
            actorName: (h.actor_name as string | null) ?? null,
          };
        }),
      forecastHistory: history
        .filter((h) => h.kind === "forecast")
        .map((h) => {
          const m = (h.meta as Record<string, unknown>) ?? {};
          return {
            from: String(m.from ?? ""),
            to: String(m.to ?? ""),
            at: String(h.at),
            actorName: (h.actor_name as string | null) ?? null,
          };
        }),
      coverage: {
        decisionMaker: sh.some((s) => s.roleKind === "decision_maker"),
        champion: sh.some((s) => s.roleKind === "champion"),
        economicBuyer: sh.some((s) => s.roleKind === "economic_buyer"),
        blockers: sh.filter((s) => s.roleKind === "blocker" || s.sentiment === "detractor").length,
      },
    };
  });
}

export type OpportunityCommercial = {
  id: string;
  name: string;
  customerId: string | null;
  customerName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  stageKey: string;
  status: "open" | "won" | "lost";
  pipelineId: string | null;
  forecastCategory: "pipeline" | "best_case" | "commit" | "omitted";
  kind: "new_business" | "expansion" | "renewal";
  amountKind: "one_time" | "recurring" | "mixed";
  estimatedValueMinor: number | null;
  recurringMinor: number | null;
  recurrenceMonths: number | null;
  currency: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  decisionCriteria: string | null;
  needs: string | null;
  buyingProcess: Array<{ step: string; done?: boolean; owner?: string; due?: string }>;
  quoteId: string | null;
  quoteReference: string | null;
  contractDocumentId: string | null;
  stageEnteredAt: string;
  stageAgeDays: number;
  lastActivityAt: string | null;
  rowVersion: number;
  archived: boolean;
};

/** The opportunity's H27 commercial context in one read (money redacted by privilege). */
export async function getOpportunityCommercial(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<OpportunityCommercial | null> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select o.id::text as id, o.name, o.customer_id::text as customer_id, c.name as customer_name,
             o.owner_user_id::text as owner_user_id, u.full_name as owner_name, o.stage_key, o.status,
             o.pipeline_id::text as pipeline_id, o.forecast_category, o.kind, o.amount_kind,
             o.estimated_value_minor, o.recurring_minor, o.recurrence_months, o.currency, o.probability,
             o.expected_close_date::text as expected_close_date, o.next_action, o.next_action_due::text as next_action_due,
             o.decision_criteria, o.needs, o.buying_process, o.quote_id::text as quote_id, q.reference as quote_reference,
             o.contract_document_id::text as contract_document_id, o.stage_entered_at::text as stage_entered_at,
             greatest(0, extract(day from now() - o.stage_entered_at))::int as stage_age_days,
             o.last_activity_at::text as last_activity_at, o.row_version, o.archived
      from public.opportunity o
      left join public.customer c on c.id = o.customer_id
      left join public.user_profile u on u.id = o.owner_user_id
      left join public.quote q on q.id = o.quote_id
      where o.id = ${id} and o.org_id = ${ctx.orgId}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const money = (v: unknown) => (ctx.pricePrivileged && v !== null ? Number(v) : null);
  return {
    id: String(r.id),
    name: String(r.name),
    customerId: (r.customer_id as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    stageKey: String(r.stage_key),
    status: r.status as OpportunityCommercial["status"],
    pipelineId: (r.pipeline_id as string | null) ?? null,
    forecastCategory: r.forecast_category as OpportunityCommercial["forecastCategory"],
    kind: r.kind as OpportunityCommercial["kind"],
    amountKind: r.amount_kind as OpportunityCommercial["amountKind"],
    estimatedValueMinor: money(r.estimated_value_minor),
    recurringMinor: money(r.recurring_minor),
    recurrenceMonths: r.recurrence_months === null ? null : Number(r.recurrence_months),
    currency: (r.currency as string | null) ?? null,
    probability: r.probability === null ? null : Number(r.probability),
    expectedCloseDate: (r.expected_close_date as string | null) ?? null,
    nextAction: (r.next_action as string | null) ?? null,
    nextActionDue: (r.next_action_due as string | null) ?? null,
    decisionCriteria: (r.decision_criteria as string | null) ?? null,
    needs: (r.needs as string | null) ?? null,
    buyingProcess: Array.isArray(r.buying_process)
      ? (r.buying_process as OpportunityCommercial["buyingProcess"])
      : [],
    quoteId: (r.quote_id as string | null) ?? null,
    quoteReference: (r.quote_reference as string | null) ?? null,
    contractDocumentId: (r.contract_document_id as string | null) ?? null,
    stageEnteredAt: String(r.stage_entered_at),
    stageAgeDays: Number(r.stage_age_days),
    lastActivityAt: (r.last_activity_at as string | null) ?? null,
    rowVersion: Number(r.row_version),
    archived: Boolean(r.archived),
  };
}
