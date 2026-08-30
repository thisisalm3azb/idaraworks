/**
 * H20 — the sales CRM engine (leads → opportunities → quotation → won/lost).
 *
 * Leads and opportunities are potential sales, recorded BEFORE a customer,
 * a price or a quotation exists. Opportunity value is FORECAST value in
 * base-currency minor units — never invoiced revenue, cash received or
 * receivables (those stay with the invoices module). Every mutation runs
 * through command() (atomic audit); reads are org-scoped and bounded; money
 * values redact behind ctx.pricePrivileged like every commercial figure.
 *
 * The pipeline behaves like Intelligent Clay: stable stage KEYS with
 * org-editable labels and order. Defaults ship in code and materialize
 * lazily (first write) so reads never write; existing opportunities stay
 * valid across renames because only labels change. Won and lost are
 * structural terminal categories.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

// ── Pipeline defaults (stable keys; labels are presentation) ────────────────
export const DEFAULT_PIPELINE_STAGES = [
  { key: "new", label: { en: "New", ar: "جديدة" }, sort: 0, category: "open" },
  { key: "contacted", label: { en: "Contacted", ar: "تم التواصل" }, sort: 1, category: "open" },
  { key: "qualified", label: { en: "Qualified", ar: "مؤهلة" }, sort: 2, category: "open" },
  { key: "proposal", label: { en: "Proposal", ar: "عرض مقدم" }, sort: 3, category: "open" },
  { key: "negotiation", label: { en: "Negotiation", ar: "تفاوض" }, sort: 4, category: "open" },
  { key: "won", label: { en: "Won", ar: "مكسوبة" }, sort: 5, category: "won" },
  { key: "lost", label: { en: "Lost", ar: "مفقودة" }, sort: 6, category: "lost" },
] as const;

export const LOSS_REASONS = [
  "price",
  "timing",
  "competitor",
  "no_budget",
  "no_response",
  "scope",
  "other",
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const SALES_ACTIVITY_KINDS = [
  "note",
  "call",
  "meeting",
  "email",
  "follow_up",
  "stage_change",
  "quote_created",
  "won",
  "lost",
] as const;
/** The kinds a USER records directly (lifecycle marks are system-written). */
export const USER_ACTIVITY_KINDS = ["note", "call", "meeting", "email", "follow_up"] as const;

export type PipelineStage = {
  key: string;
  label: { en: string; ar: string };
  sort: number;
  category: "open" | "won" | "lost";
  active: boolean;
};

/** Materialize the default stages once per org (idempotent, in-tx). */
export async function ensurePipelineStages(tx: TenantTx, ctx: Ctx): Promise<void> {
  for (const s of DEFAULT_PIPELINE_STAGES) {
    await tx.execute(sql`
      insert into public.pipeline_stage (org_id, key, label, sort, category)
      values (${ctx.orgId}, ${s.key}, ${JSON.stringify(s.label)}::jsonb, ${s.sort}, ${s.category})
      on conflict (org_id, key) do nothing
    `);
  }
}

/** The org's pipeline: stored rows, or the code defaults when none exist
 * yet (reads never write — rows materialize on the first write path). */
export async function listPipelineStages(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<PipelineStage[]> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select key, label, sort, category, active from public.pipeline_stage
      where org_id = ${ctx.orgId}
      order by sort, key
    `),
  )) as unknown as Array<PipelineStage>;
  if (rows.length === 0) {
    return DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s, label: { ...s.label }, active: true }));
  }
  return rows;
}

export const StagePatchInput = z.object({
  labelEn: z.string().trim().min(1).max(60).optional(),
  labelAr: z.string().trim().min(1).max(60).optional(),
  sort: z.number().int().min(0).max(99).optional(),
});

export async function updatePipelineStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  key: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "pipeline.configure");
  const data = StagePatchInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "pipeline.stage_update",
        entityType: "org",
        entityId: ctx.orgId,
        summary: `Updated pipeline stage ${key}`,
      },
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const rows = (await tx.execute(sql`
        select label from public.pipeline_stage
        where org_id = ${ctx.orgId} and key = ${key}
      `)) as unknown as Array<{ label: { en: string; ar: string } }>;
      if (!rows[0]) throw new Error("unknown stage");
      const label = {
        en: data.labelEn ?? rows[0].label.en,
        ar: data.labelAr ?? rows[0].label.ar,
      };
      await tx.execute(sql`
        update public.pipeline_stage
        set label = ${JSON.stringify(label)}::jsonb,
            sort = coalesce(${data.sort ?? null}, sort),
            updated_at = now()
        where org_id = ${ctx.orgId} and key = ${key}
      `);
    },
  );
}

/** Deactivate an OPEN stage. Refuses while open opportunities sit in it
 * unless a reassignment target is given (explicit, audited move). Terminal
 * stages can never be deactivated. */
export async function deactivatePipelineStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  key: string,
  opts: { reassignTo?: string } = {},
): Promise<void> {
  assertCan(archetype, "pipeline.configure");
  await command(
    ctx,
    {
      audit: {
        action: "pipeline.stage_deactivate",
        entityType: "org",
        entityId: ctx.orgId,
        summary: opts.reassignTo
          ? `Deactivated pipeline stage ${key} (moved open items to ${opts.reassignTo})`
          : `Deactivated pipeline stage ${key}`,
      },
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const stage = (await tx.execute(sql`
        select category from public.pipeline_stage
        where org_id = ${ctx.orgId} and key = ${key}
      `)) as unknown as Array<{ category: string }>;
      if (!stage[0]) throw new Error("unknown stage");
      if (stage[0].category !== "open") throw new Error("terminal stages cannot be removed");
      const open = (await tx.execute(sql`
        select count(*)::int as n from public.opportunity
        where org_id = ${ctx.orgId} and stage_key = ${key}
          and status = 'open' and archived = false
      `)) as unknown as Array<{ n: number }>;
      if ((open[0]?.n ?? 0) > 0) {
        if (!opts.reassignTo) throw new StageNotEmptyError(open[0]!.n);
        const target = (await tx.execute(sql`
          select 1 from public.pipeline_stage
          where org_id = ${ctx.orgId} and key = ${opts.reassignTo}
            and category = 'open' and active = true and key <> ${key}
        `)) as unknown as Array<unknown>;
        if (target.length === 0) throw new Error("invalid reassignment stage");
        await tx.execute(sql`
          update public.opportunity set stage_key = ${opts.reassignTo}, updated_at = now()
          where org_id = ${ctx.orgId} and stage_key = ${key}
            and status = 'open' and archived = false
        `);
      }
      await tx.execute(sql`
        update public.pipeline_stage set active = false, updated_at = now()
        where org_id = ${ctx.orgId} and key = ${key}
      `);
    },
  );
}

export class StageNotEmptyError extends Error {
  constructor(public readonly count: number) {
    super("stage still holds open opportunities");
    this.name = "StageNotEmptyError";
  }
}

// ── Leads ───────────────────────────────────────────────────────────────────
export const LeadInput = z.object({
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  source: z.string().trim().max(80).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  notes: z.string().trim().max(2000).optional(),
  ownerUserId: z.string().uuid().optional(),
});

export type LeadRow = {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: LeadStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  country: string | null;
  notes: string | null;
  convertedOpportunityId: string | null;
  convertedCustomerId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Earliest open follow-up due date (null = none scheduled). */
  nextFollowUpDue: string | null;
};

export async function createLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "leads.manage");
  const data = LeadInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "lead.create",
        entityType: "lead",
        entityId: id,
        summary: `Added lead ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.lead
          (id, org_id, name, contact_name, phone, email, source, country, notes,
           owner_user_id, created_by)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.contactName ?? null},
                ${data.phone ?? null}, ${data.email ?? null}, ${data.source ?? null},
                ${data.country ?? null}, ${data.notes ?? null},
                ${data.ownerUserId ?? ctx.userId}, ${ctx.userId})
      `),
  );
  return { id };
}

export async function updateLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  const data = LeadInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "lead.update",
        entityType: "lead",
        entityId: id,
        summary: `Updated lead ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.lead
        set name = ${data.name}, contact_name = ${data.contactName ?? null},
            phone = ${data.phone ?? null}, email = ${data.email ?? null},
            source = ${data.source ?? null}, country = ${data.country ?? null},
            notes = ${data.notes ?? null},
            owner_user_id = ${data.ownerUserId ?? null}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and status <> 'converted'
      `),
  );
}

/** Working-status transitions (new/contacted/qualified/disqualified).
 * 'converted' moves ONLY through convertLead. */
export async function setLeadStatus(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  status: Exclude<LeadStatus, "converted">,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  if (
    !(LEAD_STATUSES as readonly string[]).includes(status) ||
    (status as string) === "converted"
  ) {
    throw new Error("invalid status");
  }
  await command(
    ctx,
    {
      audit: {
        action: "lead.status",
        entityType: "lead",
        entityId: id,
        summary: `Lead marked ${status}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.lead set status = ${status}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and status <> 'converted'
      `),
  );
}

export async function setLeadArchived(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  archived: boolean,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  await command(
    ctx,
    {
      audit: {
        action: archived ? "lead.archive" : "lead.restore",
        entityType: "lead",
        entityId: id,
        summary: archived ? "Archived lead" : "Restored lead",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.lead set archived = ${archived}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id}
      `),
  );
}

export type LeadListOptions = {
  q?: string;
  status?: LeadStatus | "all";
  ownerUserId?: string;
  source?: string;
  archived?: boolean;
  /** Only leads with an open follow-up past due (org day). */
  overdueFollowUp?: string; // asOf date
  limit?: number;
};

export async function listLeads(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: LeadListOptions = {},
): Promise<LeadRow[]> {
  assertCan(archetype, "leads.view");
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const q = (opts.q ?? "").trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const owner = opts.ownerUserId ?? null;
  const source = opts.source ?? null;
  const overdue = opts.overdueFollowUp ?? null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select l.id::text as id, l.name, l.contact_name, l.phone, l.email, l.source,
             l.status, l.owner_user_id::text as owner_user_id, u.full_name as owner_name,
             l.country, l.notes,
             l.converted_opportunity_id::text as converted_opportunity_id,
             l.converted_customer_id::text as converted_customer_id,
             l.archived, l.created_at::text as created_at, l.updated_at::text as updated_at,
             (select min(a.due_date)::text from public.sales_activity a
               where a.org_id = l.org_id and a.lead_id = l.id
                 and a.kind = 'follow_up' and a.completed_at is null) as next_follow_up_due
      from public.lead l
      left join public.user_profile u on u.id = l.owner_user_id
      where l.org_id = ${ctx.orgId}
        and l.archived = ${opts.archived === true}
        and (${status}::text is null or l.status = ${status})
        and (${owner}::uuid is null or l.owner_user_id = ${owner}::uuid)
        and (${source}::text is null or l.source = ${source})
        and (${pattern}::text is null
             or l.name ilike ${pattern}
             or coalesce(l.contact_name,'') ilike ${pattern}
             or coalesce(l.email,'') ilike ${pattern}
             or coalesce(l.phone,'') ilike ${pattern})
        and (${overdue}::date is null or exists (
              select 1 from public.sales_activity a
              where a.org_id = l.org_id and a.lead_id = l.id and a.kind = 'follow_up'
                and a.completed_at is null and a.due_date < ${overdue}::date))
      order by l.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapLead);
}

function mapLead(r: Record<string, unknown>): LeadRow {
  return {
    id: r.id as string,
    name: r.name as string,
    contactName: (r.contact_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    status: r.status as LeadStatus,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    convertedOpportunityId: (r.converted_opportunity_id as string | null) ?? null,
    convertedCustomerId: (r.converted_customer_id as string | null) ?? null,
    archived: r.archived as boolean,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    nextFollowUpDue: (r.next_follow_up_due as string | null) ?? null,
  };
}

export async function getLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<LeadRow | null> {
  assertCan(archetype, "leads.view");
  if (!z.string().uuid().safeParse(id).success) return null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select l.id::text as id, l.name, l.contact_name, l.phone, l.email, l.source,
             l.status, l.owner_user_id::text as owner_user_id, u.full_name as owner_name,
             l.country, l.notes,
             l.converted_opportunity_id::text as converted_opportunity_id,
             l.converted_customer_id::text as converted_customer_id,
             l.archived, l.created_at::text as created_at, l.updated_at::text as updated_at,
             (select min(a.due_date)::text from public.sales_activity a
               where a.org_id = l.org_id and a.lead_id = l.id
                 and a.kind = 'follow_up' and a.completed_at is null) as next_follow_up_due
      from public.lead l
      left join public.user_profile u on u.id = l.owner_user_id
      where l.org_id = ${ctx.orgId} and l.id = ${id}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapLead(rows[0]) : null;
}

// ── Opportunities ───────────────────────────────────────────────────────────
export const OpportunityInput = z.object({
  name: z.string().trim().min(1).max(160),
  customerId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  stageKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional(),
  estimatedValueMinor: z.number().int().min(0).optional(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  probability: z.number().int().min(0).max(100).optional(),
  nextAction: z.string().trim().max(300).optional(),
  nextActionDue: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type OpportunityRow = {
  id: string;
  name: string;
  customerId: string | null;
  customerName: string | null;
  leadId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  stageKey: string;
  status: "open" | "won" | "lost";
  estimatedValueMinor: number | null;
  expectedCloseDate: string | null;
  probability: number | null;
  nextAction: string | null;
  nextActionDue: string | null;
  quoteId: string | null;
  quoteReference: string | null;
  lossReason: string | null;
  lossNote: string | null;
  wonAt: string | null;
  lostAt: string | null;
  archived: boolean;
  createdAt: string;
};

function mapOpp(ctx: Ctx, r: Record<string, unknown>): OpportunityRow {
  const seesPrice = ctx.pricePrivileged;
  return {
    id: r.id as string,
    name: r.name as string,
    customerId: (r.customer_id as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    leadId: (r.lead_id as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    stageKey: r.stage_key as string,
    status: r.status as "open" | "won" | "lost",
    estimatedValueMinor:
      seesPrice && r.estimated_value_minor !== null ? Number(r.estimated_value_minor) : null,
    expectedCloseDate: (r.expected_close_date as string | null) ?? null,
    probability: r.probability === null ? null : Number(r.probability),
    nextAction: (r.next_action as string | null) ?? null,
    nextActionDue: (r.next_action_due as string | null) ?? null,
    quoteId: (r.quote_id as string | null) ?? null,
    quoteReference: (r.quote_reference as string | null) ?? null,
    lossReason: (r.loss_reason as string | null) ?? null,
    lossNote: (r.loss_note as string | null) ?? null,
    wonAt: (r.won_at as string | null) ?? null,
    lostAt: (r.lost_at as string | null) ?? null,
    archived: r.archived as boolean,
    createdAt: r.created_at as string,
  };
}

const OPP_SELECT = sql`
  select o.id::text as id, o.name, o.customer_id::text as customer_id, c.name as customer_name,
         o.lead_id::text as lead_id, o.owner_user_id::text as owner_user_id,
         u.full_name as owner_name, o.stage_key, o.status, o.estimated_value_minor,
         o.expected_close_date::text as expected_close_date, o.probability,
         o.next_action, o.next_action_due::text as next_action_due,
         o.quote_id::text as quote_id, q.reference as quote_reference,
         o.loss_reason, o.loss_note, o.won_at::text as won_at, o.lost_at::text as lost_at,
         o.archived, o.created_at::text as created_at
  from public.opportunity o
  left join public.customer c on c.id = o.customer_id
  left join public.user_profile u on u.id = o.owner_user_id
  left join public.quote q on q.id = o.quote_id
`;

export async function createOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
  opts: { leadId?: string } = {},
): Promise<{ id: string }> {
  assertCan(archetype, "opportunities.manage");
  const data = OpportunityInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "opportunity.create",
        entityType: "opportunity",
        entityId: id,
        summary: `Added opportunity ${data.name}`,
      },
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const stageKey = data.stageKey ?? "new";
      const stage = (await tx.execute(sql`
        select 1 from public.pipeline_stage
        where org_id = ${ctx.orgId} and key = ${stageKey}
          and category = 'open' and active = true
      `)) as unknown as Array<unknown>;
      if (stage.length === 0) throw new Error("invalid stage");
      if (data.customerId) {
        const cust = (await tx.execute(sql`
          select 1 from public.customer where org_id = ${ctx.orgId} and id = ${data.customerId}
        `)) as unknown as Array<unknown>;
        if (cust.length === 0) throw new Error("customer not found");
      }
      await tx.execute(sql`
        insert into public.opportunity
          (id, org_id, name, customer_id, lead_id, owner_user_id, stage_key,
           estimated_value_minor, currency, expected_close_date, probability,
           next_action, next_action_due, created_by)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.customerId ?? null},
                ${opts.leadId ?? null}, ${data.ownerUserId ?? ctx.userId}, ${stageKey},
                ${data.estimatedValueMinor ?? null}, null,
                ${data.expectedCloseDate ?? null}, ${data.probability ?? null},
                ${data.nextAction ?? null}, ${data.nextActionDue ?? null}, ${ctx.userId})
      `);
    },
  );
  return { id };
}

export async function updateOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  const data = OpportunityInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "opportunity.update",
        entityType: "opportunity",
        entityId: id,
        summary: `Updated opportunity ${data.name}`,
      },
    },
    async (tx) => {
      if (data.customerId) {
        const cust = (await tx.execute(sql`
          select 1 from public.customer where org_id = ${ctx.orgId} and id = ${data.customerId}
        `)) as unknown as Array<unknown>;
        if (cust.length === 0) throw new Error("customer not found");
      }
      await tx.execute(sql`
        update public.opportunity
        set name = ${data.name}, customer_id = ${data.customerId ?? null},
            owner_user_id = ${data.ownerUserId ?? null},
            estimated_value_minor = ${data.estimatedValueMinor ?? null},
            expected_close_date = ${data.expectedCloseDate ?? null},
            probability = ${data.probability ?? null},
            next_action = ${data.nextAction ?? null},
            next_action_due = ${data.nextActionDue ?? null},
            updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and status = 'open'
      `);
    },
  );
}

/** Move an OPEN opportunity between OPEN stages (board + keyboard path).
 * Records a stage_change activity (machine body "from|to", rendered with
 * live labels at display time). Idempotent: same-stage moves are no-ops. */
export async function moveOpportunityStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  stageKey: string,
): Promise<{ moved: boolean }> {
  assertCan(archetype, "opportunities.manage");
  return command(
    ctx,
    {
      audit: (r: { moved: boolean }) => ({
        action: "opportunity.stage",
        entityType: "opportunity",
        entityId: id,
        summary: r.moved ? `Moved opportunity to ${stageKey}` : "Stage unchanged",
      }),
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const target = (await tx.execute(sql`
        select 1 from public.pipeline_stage
        where org_id = ${ctx.orgId} and key = ${stageKey}
          and category = 'open' and active = true
      `)) as unknown as Array<unknown>;
      if (target.length === 0) throw new Error("invalid stage");
      const rows = (await tx.execute(sql`
        with prev as (
          select id, stage_key from public.opportunity
          where org_id = ${ctx.orgId} and id = ${id}
            and status = 'open' and archived = false and stage_key <> ${stageKey}
          for update
        )
        update public.opportunity o
        set stage_key = ${stageKey}, updated_at = now()
        from prev
        where o.id = prev.id
        returning prev.stage_key as from_key
      `)) as unknown as Array<{ from_key: string }>;
      if (rows.length > 0) {
        await tx.execute(sql`
          insert into public.sales_activity
            (org_id, opportunity_id, kind, body, actor_user_id)
          values (${ctx.orgId}, ${id}, 'stage_change',
                  ${rows[0]!.from_key + "|" + stageKey}, ${ctx.userId})
        `);
      }
      return { moved: rows.length > 0 };
    },
  );
}

export async function winOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<{ changed: boolean }> {
  assertCan(archetype, "opportunities.manage");
  return command(
    ctx,
    {
      audit: (r: { changed: boolean }) => ({
        action: "opportunity.won",
        entityType: "opportunity",
        entityId: id,
        summary: r.changed ? "Opportunity won" : "Opportunity already closed",
      }),
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const rows = (await tx.execute(sql`
        update public.opportunity
        set status = 'won', stage_key = 'won', won_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and status = 'open'
        returning id
      `)) as unknown as Array<unknown>;
      if (rows.length > 0) {
        await tx.execute(sql`
          insert into public.sales_activity (org_id, opportunity_id, kind, actor_user_id)
          values (${ctx.orgId}, ${id}, 'won', ${ctx.userId})
        `);
      }
      return { changed: rows.length > 0 };
    },
  );
}

export const LoseInput = z.object({
  reason: z.enum(LOSS_REASONS),
  note: z.string().trim().max(1000).optional(),
});

export async function loseOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: unknown,
): Promise<{ changed: boolean }> {
  assertCan(archetype, "opportunities.manage");
  const data = LoseInput.parse(input);
  return command(
    ctx,
    {
      audit: (r: { changed: boolean }) => ({
        action: "opportunity.lost",
        entityType: "opportunity",
        entityId: id,
        summary: r.changed ? `Opportunity lost: ${data.reason}` : "Opportunity already closed",
      }),
    },
    async (tx) => {
      await ensurePipelineStages(tx, ctx);
      const rows = (await tx.execute(sql`
        update public.opportunity
        set status = 'lost', stage_key = 'lost', lost_at = now(),
            loss_reason = ${data.reason}, loss_note = ${data.note ?? null}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and status = 'open'
        returning id
      `)) as unknown as Array<unknown>;
      if (rows.length > 0) {
        await tx.execute(sql`
          insert into public.sales_activity (org_id, opportunity_id, kind, body, actor_user_id)
          values (${ctx.orgId}, ${id}, 'lost', ${data.reason}, ${ctx.userId})
        `);
      }
      return { changed: rows.length > 0 };
    },
  );
}

export type OpportunityListOptions = {
  status?: "open" | "won" | "lost" | "all";
  stageKey?: string;
  ownerUserId?: string;
  customerId?: string;
  /** Only opportunities with an overdue follow-up or next action. */
  overdue?: string; // asOf
  closingWithinDays?: { asOf: string; days: number };
  archived?: boolean;
  limit?: number;
};

export async function listOpportunities(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: OpportunityListOptions = {},
): Promise<OpportunityRow[]> {
  assertCan(archetype, "opportunities.view");
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 500);
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const stage = opts.stageKey ?? null;
  const ownerU = opts.ownerUserId ?? null;
  const cust = opts.customerId ?? null;
  const overdue = opts.overdue ?? null;
  const closeAsOf = opts.closingWithinDays?.asOf ?? null;
  const closeDays = opts.closingWithinDays?.days ?? null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${OPP_SELECT}
      where o.org_id = ${ctx.orgId}
        and o.archived = ${opts.archived === true}
        and (${status}::text is null or o.status = ${status})
        and (${stage}::text is null or o.stage_key = ${stage})
        and (${ownerU}::uuid is null or o.owner_user_id = ${ownerU}::uuid)
        and (${cust}::uuid is null or o.customer_id = ${cust}::uuid)
        and (${overdue}::date is null or (
              o.status = 'open' and (
                (o.next_action_due is not null and o.next_action_due < ${overdue}::date)
                or exists (select 1 from public.sales_activity a
                           where a.org_id = o.org_id and a.opportunity_id = o.id
                             and a.kind = 'follow_up' and a.completed_at is null
                             and a.due_date < ${overdue}::date))))
        and (${closeAsOf}::date is null or (
              o.status = 'open' and o.expected_close_date is not null
              and o.expected_close_date >= ${closeAsOf}::date
              and o.expected_close_date <= (${closeAsOf}::date + ${closeDays ?? 0}::int)))
      order by o.expected_close_date asc nulls last, o.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => mapOpp(ctx, r));
}

export async function getOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<OpportunityRow | null> {
  assertCan(archetype, "opportunities.view");
  if (!z.string().uuid().safeParse(id).success) return null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${OPP_SELECT}
      where o.org_id = ${ctx.orgId} and o.id = ${id}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapOpp(ctx, rows[0]) : null;
}

// ── Conversions ─────────────────────────────────────────────────────────────
export const ConvertLeadInput = z.object({
  opportunityName: z.string().trim().min(1).max(160).optional(),
  /** Link an EXISTING customer (org-validated) … */
  customerId: z.string().uuid().optional(),
  /** … or create one from the lead's identity. */
  createCustomer: z.boolean().default(false),
  estimatedValueMinor: z.number().int().min(0).optional(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Lead → opportunity: transactional, idempotent, evidence-preserving.
 * The lead row survives with conversion evidence; repeated calls return the
 * existing conversion instead of duplicating it. */
export async function convertLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  leadId: string,
  input: unknown,
): Promise<{ opportunityId: string; customerId: string | null; deduped: boolean }> {
  assertCan(archetype, "leads.manage");
  assertCan(archetype, "opportunities.manage");
  const data = ConvertLeadInput.parse(input);
  const oppId = randomUUID();
  const newCustomerId = randomUUID();
  const result = await command(
    ctx,
    {
      audit: (r: { deduped: boolean; opportunityId: string }) => ({
        action: "lead.convert",
        entityType: "lead",
        entityId: leadId,
        summary: r.deduped
          ? "Lead already converted (idempotent request)"
          : "Converted lead to opportunity",
      }),
    },
    async (tx) => {
      // Serialize conversions per lead; re-check state under the lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ctx.orgId + ":lead:" + leadId}, 0))`,
      );
      const leadRows = (await tx.execute(sql`
        select name, contact_name, phone, email, country, status,
               converted_opportunity_id::text as converted_opportunity_id,
               converted_customer_id::text as converted_customer_id
        from public.lead
        where org_id = ${ctx.orgId} and id = ${leadId}
        for update
      `)) as unknown as Array<Record<string, string | null>>;
      const lead = leadRows[0];
      if (!lead) throw new Error("lead not found");
      if (lead.converted_opportunity_id) {
        return {
          opportunityId: lead.converted_opportunity_id,
          customerId: lead.converted_customer_id ?? null,
          deduped: true,
        };
      }
      if (lead.status === "disqualified") throw new Error("lead is disqualified");
      let customerId: string | null = null;
      if (data.customerId) {
        const cust = (await tx.execute(sql`
          select 1 from public.customer where org_id = ${ctx.orgId} and id = ${data.customerId}
        `)) as unknown as Array<unknown>;
        if (cust.length === 0) throw new Error("customer not found");
        customerId = data.customerId;
      } else if (data.createCustomer) {
        await tx.execute(sql`
          insert into public.customer
            (id, org_id, name, country, contact_name, phone, email, active)
          values (${newCustomerId}, ${ctx.orgId}, ${lead.name}, ${lead.country},
                  ${lead.contact_name}, ${lead.phone}, ${lead.email}, true)
        `);
        customerId = newCustomerId;
      }
      await ensurePipelineStages(tx, ctx);
      await tx.execute(sql`
        insert into public.opportunity
          (id, org_id, name, customer_id, lead_id, owner_user_id, stage_key,
           estimated_value_minor, expected_close_date, created_by)
        values (${oppId}, ${ctx.orgId}, ${data.opportunityName ?? lead.name},
                ${customerId}, ${leadId}, ${ctx.userId}, 'qualified',
                ${data.estimatedValueMinor ?? null}, ${data.expectedCloseDate ?? null},
                ${ctx.userId})
      `);
      await tx.execute(sql`
        update public.lead
        set status = 'converted', converted_opportunity_id = ${oppId},
            converted_customer_id = ${customerId}, converted_at = now(), updated_at = now()
        where org_id = ${ctx.orgId} and id = ${leadId}
      `);
      await tx.execute(sql`
        insert into public.sales_activity (org_id, lead_id, opportunity_id, kind, body, actor_user_id)
        values (${ctx.orgId}, ${leadId}, ${oppId}, 'note', 'Converted to opportunity', ${ctx.userId})
      `);
      return { opportunityId: oppId, customerId, deduped: false };
    },
  );
  return result;
}

/** Opportunity → quotation link (both directions; the quotation itself is
 * created by the EXISTING quotes service — no financial logic duplicated). */
export async function linkQuoteToOpportunity(
  ctx: Ctx,
  archetype: RoleArchetype,
  opportunityId: string,
  quoteId: string,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  await command(
    ctx,
    {
      audit: {
        action: "opportunity.quote_link",
        entityType: "opportunity",
        entityId: opportunityId,
        summary: "Linked quotation to opportunity",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.opportunity set quote_id = ${quoteId}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${opportunityId}
          and status = 'open' and archived = false
        returning id
      `)) as unknown as Array<unknown>;
      if (rows.length === 0) throw new Error("opportunity not open");
      await tx.execute(sql`
        insert into public.sales_activity (org_id, opportunity_id, kind, actor_user_id)
        values (${ctx.orgId}, ${opportunityId}, 'quote_created', ${ctx.userId})
      `);
    },
  );
}

// ── Activities and follow-ups ───────────────────────────────────────────────
export const ActivityInput = z.object({
  kind: z.enum(USER_ACTIVITY_KINDS),
  body: z.string().trim().max(2000).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  ownerUserId: z.string().uuid().optional(),
});

export async function addSalesActivity(
  ctx: Ctx,
  archetype: RoleArchetype,
  subject: { leadId?: string; opportunityId?: string },
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, subject.leadId ? "leads.manage" : "opportunities.manage");
  const data = ActivityInput.parse(input);
  if (!subject.leadId && !subject.opportunityId) throw new Error("subject required");
  if (data.kind === "follow_up" && !data.dueDate) throw new Error("follow-up needs a due date");
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "sales_activity.add",
        entityType: subject.leadId ? "lead" : "opportunity",
        entityId: (subject.leadId ?? subject.opportunityId)!,
        summary: `Recorded ${data.kind.replace("_", " ")}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.sales_activity
          (id, org_id, lead_id, opportunity_id, kind, body, due_date, owner_user_id, actor_user_id)
        values (${id}, ${ctx.orgId}, ${subject.leadId ?? null}, ${subject.opportunityId ?? null},
                ${data.kind}, ${data.body ?? null}, ${data.dueDate ?? null},
                ${data.ownerUserId ?? ctx.userId}, ${ctx.userId})
      `),
  );
  return { id };
}

export async function completeFollowUp(
  ctx: Ctx,
  archetype: RoleArchetype,
  activityId: string,
): Promise<void> {
  assertCan(archetype, "opportunities.manage");
  await command(
    ctx,
    {
      audit: {
        action: "sales_activity.complete",
        entityType: "sales_activity",
        entityId: activityId,
        summary: "Completed a follow-up",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.sales_activity set completed_at = now()
        where org_id = ${ctx.orgId} and id = ${activityId}
          and kind = 'follow_up' and completed_at is null
      `),
  );
}

export type SalesActivityRow = {
  id: string;
  leadId: string | null;
  opportunityId: string | null;
  kind: (typeof SALES_ACTIVITY_KINDS)[number];
  body: string | null;
  dueDate: string | null;
  completedAt: string | null;
  ownerName: string | null;
  actorName: string | null;
  createdAt: string;
};

export async function listSalesActivities(
  ctx: Ctx,
  archetype: RoleArchetype,
  subject: { leadId?: string; opportunityId?: string },
  opts: { limit?: number } = {},
): Promise<SalesActivityRow[]> {
  assertCan(archetype, subject.leadId ? "leads.view" : "opportunities.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const leadId = subject.leadId ?? null;
  const oppId = subject.opportunityId ?? null;
  if (!leadId && !oppId) return [];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.id::text as id, a.lead_id::text as lead_id,
             a.opportunity_id::text as opportunity_id, a.kind, a.body,
             a.due_date::text as due_date, a.completed_at::text as completed_at,
             ow.full_name as owner_name, ac.full_name as actor_name,
             a.created_at::text as created_at
      from public.sales_activity a
      left join public.user_profile ow on ow.id = a.owner_user_id
      left join public.user_profile ac on ac.id = a.actor_user_id
      where a.org_id = ${ctx.orgId}
        and ((${leadId}::uuid is not null and a.lead_id = ${leadId}::uuid)
          or (${oppId}::uuid is not null and a.opportunity_id = ${oppId}::uuid))
      order by a.created_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    leadId: (r.lead_id as string | null) ?? null,
    opportunityId: (r.opportunity_id as string | null) ?? null,
    kind: r.kind as SalesActivityRow["kind"],
    body: (r.body as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    actorName: (r.actor_name as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export type OverdueFollowUp = SalesActivityRow & {
  leadName: string | null;
  opportunityName: string | null;
};

export async function listOverdueFollowUps(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf: string,
  opts: { limit?: number } = {},
): Promise<OverdueFollowUp[]> {
  assertCan(archetype, "opportunities.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select a.id::text as id, a.lead_id::text as lead_id,
             a.opportunity_id::text as opportunity_id, a.kind, a.body,
             a.due_date::text as due_date, a.completed_at::text as completed_at,
             ow.full_name as owner_name, null as actor_name,
             a.created_at::text as created_at,
             l.name as lead_name, o.name as opportunity_name
      from public.sales_activity a
      left join public.user_profile ow on ow.id = a.owner_user_id
      left join public.lead l on l.id = a.lead_id
      left join public.opportunity o on o.id = a.opportunity_id
      where a.org_id = ${ctx.orgId} and a.kind = 'follow_up'
        and a.completed_at is null and a.due_date < ${asOf}::date
      order by a.due_date asc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    leadId: (r.lead_id as string | null) ?? null,
    opportunityId: (r.opportunity_id as string | null) ?? null,
    kind: "follow_up" as const,
    body: (r.body as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    completedAt: null,
    ownerName: (r.owner_name as string | null) ?? null,
    actorName: null,
    createdAt: r.created_at as string,
    leadName: (r.lead_name as string | null) ?? null,
    opportunityName: (r.opportunity_name as string | null) ?? null,
  }));
}

export async function countOverdueFollowUps(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf: string,
): Promise<number> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select count(*)::int as n from public.sales_activity
      where org_id = ${ctx.orgId} and kind = 'follow_up'
        and completed_at is null and due_date < ${asOf}::date
    `),
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

// ── Sales overview (Part J — labels stay distinct; forecast ≠ revenue) ──────
export type SalesOverview = {
  /** Open pipeline by stage: count always; forecast sum only when priced. */
  openByStage: Array<{ stageKey: string; count: number; forecastMinor: number | null }>;
  /** Won/lost inside the window. Values are FORECAST values of the closed
   * opportunities — never invoiced or cash figures. */
  wonCount: number;
  wonForecastMinor: number | null;
  lostCount: number;
  lostForecastMinor: number | null;
  lossReasons: Array<{ reason: string; count: number }>;
  leadsConverted: number;
  leadsCreated: number;
  overdueFollowUps: number;
  closingIn7: number;
  closingIn30: number;
};

export async function salesOverview(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; days: number },
): Promise<SalesOverview> {
  assertCan(archetype, "opportunities.view");
  const seesPrice = ctx.pricePrivileged;
  const days = Math.min(Math.max(opts.days, 1), 365);
  return withCtx(ctx, async (tx) => {
    const byStage = (await tx.execute(sql`
      select stage_key, count(*)::int as n, coalesce(sum(estimated_value_minor),0)::bigint as v
      from public.opportunity
      where org_id = ${ctx.orgId} and status = 'open' and archived = false
      group by stage_key
    `)) as unknown as Array<{ stage_key: string; n: number; v: string }>;
    const closed = (await tx.execute(sql`
      select
        count(*) filter (where status = 'won' and won_at >= (${opts.asOf}::date - ${days}::int))::int as won_n,
        coalesce(sum(estimated_value_minor) filter (where status = 'won' and won_at >= (${opts.asOf}::date - ${days}::int)),0)::bigint as won_v,
        count(*) filter (where status = 'lost' and lost_at >= (${opts.asOf}::date - ${days}::int))::int as lost_n,
        coalesce(sum(estimated_value_minor) filter (where status = 'lost' and lost_at >= (${opts.asOf}::date - ${days}::int)),0)::bigint as lost_v
      from public.opportunity where org_id = ${ctx.orgId} and archived = false
    `)) as unknown as Array<{ won_n: number; won_v: string; lost_n: number; lost_v: string }>;
    const reasons = (await tx.execute(sql`
      select loss_reason as reason, count(*)::int as n
      from public.opportunity
      where org_id = ${ctx.orgId} and status = 'lost' and archived = false
        and lost_at >= (${opts.asOf}::date - ${days}::int)
      group by 1 order by 2 desc
    `)) as unknown as Array<{ reason: string; n: number }>;
    const leads = (await tx.execute(sql`
      select
        count(*) filter (where created_at >= (${opts.asOf}::date - ${days}::int))::int as created_n,
        count(*) filter (where converted_at >= (${opts.asOf}::date - ${days}::int))::int as converted_n
      from public.lead where org_id = ${ctx.orgId} and archived = false
    `)) as unknown as Array<{ created_n: number; converted_n: number }>;
    const closing = (await tx.execute(sql`
      select
        count(*) filter (where expected_close_date <= (${opts.asOf}::date + 7))::int as c7,
        count(*) filter (where expected_close_date <= (${opts.asOf}::date + 30))::int as c30
      from public.opportunity
      where org_id = ${ctx.orgId} and status = 'open' and archived = false
        and expected_close_date >= ${opts.asOf}::date
    `)) as unknown as Array<{ c7: number; c30: number }>;
    const overdue = (await tx.execute(sql`
      select count(*)::int as n from public.sales_activity
      where org_id = ${ctx.orgId} and kind = 'follow_up'
        and completed_at is null and due_date < ${opts.asOf}::date
    `)) as unknown as Array<{ n: number }>;
    return {
      openByStage: byStage.map((r) => ({
        stageKey: r.stage_key,
        count: Number(r.n),
        forecastMinor: seesPrice ? Number(r.v) : null,
      })),
      wonCount: Number(closed[0]?.won_n ?? 0),
      wonForecastMinor: seesPrice ? Number(closed[0]?.won_v ?? 0) : null,
      lostCount: Number(closed[0]?.lost_n ?? 0),
      lostForecastMinor: seesPrice ? Number(closed[0]?.lost_v ?? 0) : null,
      lossReasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.n) })),
      leadsConverted: Number(leads[0]?.converted_n ?? 0),
      leadsCreated: Number(leads[0]?.created_n ?? 0),
      overdueFollowUps: Number(overdue[0]?.n ?? 0),
      closingIn7: Number(closing[0]?.c7 ?? 0),
      closingIn30: Number(closing[0]?.c30 ?? 0),
    };
  });
}

/** Dashboard aggregates (one bounded query each; composer-gated). */
export async function salesDashboardCounts(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { asOf: string; horizonDays: number },
): Promise<{
  overdueFollowUps: number;
  closingSoon: number;
  quotesExpiring: number;
  openPipelineMinor: number | null;
  openPipelineCount: number;
}> {
  assertCan(archetype, "opportunities.view");
  const seesPrice = ctx.pricePrivileged;
  const seeQuotes = can(archetype, "quotes.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select
        (select count(*)::int from public.sales_activity
          where org_id = ${ctx.orgId} and kind = 'follow_up'
            and completed_at is null and due_date < ${opts.asOf}::date) as overdue_fu,
        (select count(*)::int from public.opportunity
          where org_id = ${ctx.orgId} and status = 'open' and archived = false
            and expected_close_date >= ${opts.asOf}::date
            and expected_close_date <= (${opts.asOf}::date + ${opts.horizonDays}::int)) as closing,
        (select count(*)::int from public.quote
          where ${seeQuotes} and org_id = ${ctx.orgId}
            and status in ('approved','sent')
            and valid_until is not null
            and valid_until >= ${opts.asOf}::date
            and valid_until <= (${opts.asOf}::date + ${opts.horizonDays}::int)) as expiring,
        (select coalesce(sum(estimated_value_minor),0)::bigint from public.opportunity
          where org_id = ${ctx.orgId} and status = 'open' and archived = false) as pipeline_v,
        (select count(*)::int from public.opportunity
          where org_id = ${ctx.orgId} and status = 'open' and archived = false) as pipeline_n
    `)) as unknown as Array<Record<string, string | number>>;
    const r = rows[0]!;
    return {
      overdueFollowUps: Number(r.overdue_fu),
      closingSoon: Number(r.closing),
      quotesExpiring: Number(r.expiring),
      openPipelineMinor: seesPrice ? Number(r.pipeline_v) : null,
      openPipelineCount: Number(r.pipeline_n),
    };
  });
}
