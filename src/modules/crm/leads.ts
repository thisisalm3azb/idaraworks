/**
 * H27 — lead and enquiry capture on top of the H20 lead (ADR-32):
 * every source (manual, form, import, referral, existing customer, campaign,
 * email/messaging adapters, API) enters through `captureLead`, which records
 * the source and campaign, detects possible duplicates (advisory, never
 * blocking), records consent when it was given, and QUARANTINES anything from
 * an untrusted source until a person reviews it. Conversion wraps H20's
 * idempotent `convertLead` with a duplicate preview so a second customer is
 * never created by accident.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { findPossibleDuplicates } from "@/modules/masters/service";
import { convertLead, createLead, getLead, setLeadStatus, type LeadRow } from "./sales";

const uuid = z.string().uuid();
export const LEAD_SOURCE_KINDS = [
  "manual",
  "form",
  "import",
  "referral",
  "customer",
  "campaign",
  "email",
  "messaging",
  "api",
] as const;
export const DISQUALIFY_REASONS = [
  "no_budget",
  "no_need",
  "no_authority",
  "timing",
  "competitor",
  "unresponsive",
  "spam",
  "duplicate",
  "other",
] as const;
const UNTRUSTED: ReadonlySet<string> = new Set(["form", "email", "messaging", "api"]);

export class LeadError extends Error {
  readonly code: "not_found" | "state" | "validation" | "duplicates" | "conflict";
  readonly candidates?: DuplicateCandidate[];
  constructor(message: string, code: LeadError["code"], candidates?: DuplicateCandidate[]) {
    super(message);
    this.code = code;
    this.candidates = candidates;
  }
}

export type DuplicateCandidate = {
  kind: "lead" | "customer";
  id: string;
  name: string;
  match: "email" | "phone" | "name";
  status: string | null;
};

export const CaptureLeadInput = z.object({
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
  sourceKind: z.enum(LEAD_SOURCE_KINDS).default("manual"),
  source: z.string().trim().max(80).optional().nullable(),
  campaignId: uuid.optional().nullable(),
  referrerCustomerId: uuid.optional().nullable(),
  territoryId: uuid.optional().nullable(),
  estimatedValueMinor: z.number().int().min(0).optional().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  timeframe: z.enum(["immediate", "quarter", "half_year", "year", "unknown"]).optional().nullable(),
  interest: z.string().trim().max(300).optional().nullable(),
  /** Consent given at capture (e.g. a ticked box on a form), per channel. */
  consent: z
    .array(
      z.object({
        channel: z.enum(["email", "sms", "whatsapp", "phone"]),
        evidence: z.string().max(500).optional(),
      }),
    )
    .max(4)
    .default([]),
  /** Trusted callers may skip quarantine for untrusted sources they already validated. */
  trusted: z.boolean().optional(),
});
export type CaptureLeadInput = z.infer<typeof CaptureLeadInput>;

export type CaptureResult = {
  lead: LeadRow;
  quarantined: boolean;
  duplicates: DuplicateCandidate[];
};

/** Advisory duplicate lookup across open leads and customers (same organisation only). */
export async function findLeadDuplicates(
  ctx: Ctx,
  archetype: RoleArchetype,
  probe: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
    excludeLeadId?: string | null;
  },
): Promise<DuplicateCandidate[]> {
  assertCan(archetype, "leads.view");
  const email = probe.email?.trim().toLowerCase() || null;
  const phone = probe.phone ? probe.phone.replace(/[^\d+]/g, "") : null;
  const nm = (probe.name ?? "").trim().toLowerCase();
  const out: DuplicateCandidate[] = [];
  const leads = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, status, lower(coalesce(email, '')) as email, regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') as phone
      from public.lead
      where org_id = ${ctx.orgId} and archived = false and status <> 'converted'
        and (${probe.excludeLeadId ?? null}::uuid is null or id <> ${probe.excludeLeadId ?? null}::uuid)
        and ((${email}::text is not null and lower(coalesce(email, '')) = ${email})
          or (${phone}::text is not null and ${phone} <> '' and regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') = ${phone})
          or (${nm}::text <> '' and lower(name) = ${nm}))
      limit 20
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    status: string;
    email: string;
    phone: string;
  }>;
  for (const l of leads)
    out.push({
      kind: "lead",
      id: l.id,
      name: l.name,
      match: email && l.email === email ? "email" : phone && l.phone === phone ? "phone" : "name",
      status: l.status,
    });
  try {
    const customers = await findPossibleDuplicates(
      ctx,
      archetype === "viewer" ? "manager" : archetype,
      probe,
    );
    for (const c of customers)
      out.push({
        kind: "customer",
        id: c.id,
        name: c.name,
        match:
          (("matchedOn" in c ? (c as { matchedOn?: string }).matchedOn : undefined) as
            DuplicateCandidate["match"] | undefined) ?? "name",
        status: c.active ? "active" : "archived",
      });
  } catch {
    // A caller without customers.manage sees only lead matches; nothing inaccessible is revealed.
  }
  return out;
}

export async function captureLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<CaptureResult> {
  assertCan(archetype, "leads.manage");
  const input = CaptureLeadInput.parse(raw);
  if (
    (input.estimatedValueMinor === null || input.estimatedValueMinor === undefined) !==
    (input.currency === null || input.currency === undefined)
  )
    throw new LeadError("value and currency go together", "validation");
  const duplicates = await findLeadDuplicates(ctx, archetype, input);
  const quarantined = UNTRUSTED.has(input.sourceKind) && input.trusted !== true;
  const created = await createLead(ctx, archetype, {
    name: input.name,
    contactName: input.contactName ?? undefined,
    phone: input.phone ?? undefined,
    email: input.email ?? undefined,
    source: input.source ?? input.sourceKind,
    country: input.country ?? undefined,
    notes: input.notes ?? undefined,
    ownerUserId: input.ownerUserId ?? undefined,
  });
  await command(
    ctx,
    {
      audit: {
        action: "crm.lead.capture",
        entityType: "lead",
        entityId: created.id,
        summary: `${input.sourceKind}${quarantined ? " (quarantined)" : ""}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.lead set
          source_kind = ${input.sourceKind}, campaign_id = ${input.campaignId ?? null}, referrer_customer_id = ${input.referrerCustomerId ?? null},
          territory_id = ${input.territoryId ?? null}, estimated_value_minor = ${input.estimatedValueMinor ?? null}, currency = ${input.currency ?? null},
          timeframe = ${input.timeframe ?? null}, interest = ${input.interest ?? null},
          quarantine = ${quarantined ? "quarantined" : "trusted"},
          duplicate_of_lead_id = ${duplicates.find((d) => d.kind === "lead")?.id ?? null}
        where id = ${created.id} and org_id = ${ctx.orgId}
      `);
      for (const c of input.consent)
        await tx.execute(sql`
          insert into public.crm_consent (org_id, lead_id, channel, status, source, evidence, actor_user_id)
          values (${ctx.orgId}, ${created.id}, ${c.channel}, 'granted', ${input.sourceKind === "form" ? "form" : "written"}, ${c.evidence ?? null}, ${ctx.userId})
        `);
      if (input.campaignId)
        await tx.execute(sql`
          insert into public.crm_touch (org_id, campaign_id, lead_id, kind, created_by)
          values (${ctx.orgId}, ${input.campaignId}, ${created.id}, 'referral', ${ctx.userId})
        `);
      if (input.ownerUserId && input.ownerUserId !== ctx.userId)
        await createNotificationIn(tx, ctx, {
          recipientUserId: input.ownerUserId,
          kind: "crm_lead_assigned",
          title: input.name,
          entityType: "lead",
          entityId: created.id,
        });
    },
  );
  const lead = await getLead(ctx, archetype, created.id);
  if (!lead) throw new LeadError("lead not found after capture", "not_found");
  return { lead, quarantined, duplicates };
}

export const LeadCrmPatch = z.object({
  id: uuid,
  ownerUserId: uuid.optional().nullable(),
  campaignId: uuid.optional().nullable(),
  territoryId: uuid.optional().nullable(),
  estimatedValueMinor: z.number().int().min(0).optional().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  timeframe: z.enum(["immediate", "quarter", "half_year", "year", "unknown"]).optional().nullable(),
  interest: z.string().trim().max(300).optional().nullable(),
  qualification: z
    .object({
      budget: z.boolean().optional(),
      authority: z.boolean().optional(),
      need: z.boolean().optional(),
      timing: z.boolean().optional(),
      note: z.string().max(1000).optional(),
    })
    .optional(),
});

export async function updateLeadCrm(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  const input = LeadCrmPatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.lead.update",
        entityType: "lead",
        entityId: input.id,
        summary: "Qualification or attribution",
      },
    },
    async (tx) => {
      const prev = (await tx.execute(
        sql`select owner_user_id::text as owner from public.lead where id = ${input.id} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ owner: string | null }>;
      if (!prev[0]) throw new LeadError("lead not found", "not_found");
      await tx.execute(sql`
        update public.lead set
          owner_user_id = case when ${input.ownerUserId === undefined} then owner_user_id else ${input.ownerUserId ?? null}::uuid end,
          campaign_id = case when ${input.campaignId === undefined} then campaign_id else ${input.campaignId ?? null}::uuid end,
          territory_id = case when ${input.territoryId === undefined} then territory_id else ${input.territoryId ?? null}::uuid end,
          estimated_value_minor = case when ${input.estimatedValueMinor === undefined} then estimated_value_minor else ${input.estimatedValueMinor ?? null} end,
          currency = case when ${input.currency === undefined} then currency else ${input.currency ?? null} end,
          timeframe = case when ${input.timeframe === undefined} then timeframe else ${input.timeframe ?? null} end,
          interest = case when ${input.interest === undefined} then interest else ${input.interest ?? null} end,
          qualification = coalesce(${input.qualification ? JSON.stringify(input.qualification) : null}::jsonb, qualification),
          row_version = row_version + 1, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
      if (
        input.ownerUserId &&
        input.ownerUserId !== prev[0].owner &&
        input.ownerUserId !== ctx.userId
      )
        await createNotificationIn(tx, ctx, {
          recipientUserId: input.ownerUserId,
          kind: "crm_lead_assigned",
          title: "Lead assigned to you",
          entityType: "lead",
          entityId: input.id,
        });
    },
  );
}

export const DisqualifyInput = z.object({
  id: uuid,
  reason: z.enum(DISQUALIFY_REASONS),
  note: z.string().trim().max(1000).optional().nullable(),
  duplicateOfLeadId: uuid.optional().nullable(),
});

export async function disqualifyLead(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  const input = DisqualifyInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "lead.status",
        entityType: "lead",
        entityId: input.id,
        summary: `disqualified: ${input.reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.lead set status = 'disqualified', disqualify_reason = ${input.reason},
          duplicate_of_lead_id = coalesce(${input.duplicateOfLeadId ?? null}::uuid, duplicate_of_lead_id),
          quarantine = case when ${input.reason} = 'spam' then 'spam' else quarantine end,
          row_version = row_version + 1, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId} and status <> 'converted'
        returning id
      `)) as unknown as unknown[];
      if (!rows.length) throw new LeadError("lead not found or already converted", "state");
      await tx.execute(sql`
        insert into public.sales_activity (org_id, lead_id, kind, title, body, actor_user_id, meta)
        values (${ctx.orgId}, ${input.id}, 'note', 'Disqualified', ${input.note ?? null}, ${ctx.userId}, ${JSON.stringify({ disqualifyReason: input.reason })}::jsonb)
      `);
    },
  );
}

/** A person reviews a quarantined lead: trust it, or mark it spam. */
export async function reviewQuarantine(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "leads.manage");
  const input = z.object({ id: uuid, decision: z.enum(["trust", "spam"]) }).parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.lead.review",
        entityType: "lead",
        entityId: input.id,
        summary: input.decision,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.lead set quarantine = ${input.decision === "trust" ? "trusted" : "spam"},
          status = case when ${input.decision} = 'spam' then 'disqualified' else status end,
          disqualify_reason = case when ${input.decision} = 'spam' then 'spam' else disqualify_reason end,
          row_version = row_version + 1, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId} and quarantine = 'quarantined'
        returning id
      `)) as unknown as unknown[];
      if (!rows.length) throw new LeadError("lead is not in quarantine", "state");
    },
  );
}

export const SafeConvertInput = z.object({
  leadId: uuid,
  opportunityName: z.string().trim().min(1).max(160).optional(),
  customerId: uuid.optional(),
  createCustomer: z.boolean().default(false),
  estimatedValueMinor: z.number().int().min(0).optional(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The person saw the duplicate candidates and still wants a new customer. */
  acknowledgeDuplicates: z.boolean().default(false),
});

/**
 * Convert without creating a duplicate customer: when a new customer would be
 * created and a possible duplicate exists, the conversion stops with the
 * candidates unless the person explicitly acknowledges them or links one.
 * Quarantined leads cannot be converted. Idempotent through H20's convertLead.
 */
export async function convertLeadSafely(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ opportunityId: string; customerId: string | null; deduped: boolean }> {
  assertCan(archetype, "leads.manage");
  const input = SafeConvertInput.parse(raw);
  const lead = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select name, email, phone, country, quarantine, status from public.lead where id = ${input.leadId} and org_id = ${ctx.orgId}`,
    ),
  )) as unknown as Array<{
    name: string;
    email: string | null;
    phone: string | null;
    country: string | null;
    quarantine: string;
    status: string;
  }>;
  if (!lead[0]) throw new LeadError("lead not found", "not_found");
  if (lead[0].quarantine !== "trusted")
    throw new LeadError("review the quarantined lead before converting it", "state");
  if (input.createCustomer && !input.customerId && !input.acknowledgeDuplicates) {
    const candidates = (
      await findLeadDuplicates(ctx, archetype, { ...lead[0], excludeLeadId: input.leadId })
    ).filter((c) => c.kind === "customer");
    if (candidates.length > 0)
      throw new LeadError(
        "possible duplicate customers exist; link one or acknowledge them",
        "duplicates",
        candidates,
      );
  }
  const { leadId, acknowledgeDuplicates: _ack, ...rest } = input;
  void _ack;
  return convertLead(ctx, archetype, leadId, rest);
}

// ── paged list with full-result aggregates ────────────────────────────────────
export const LeadQuery = z.object({
  status: z
    .enum(["new", "contacted", "qualified", "disqualified", "converted", "all"])
    .default("all"),
  quarantine: z.enum(["trusted", "quarantined", "spam", "all"]).default("all"),
  sourceKind: z.enum(LEAD_SOURCE_KINDS).optional().nullable(),
  campaignId: uuid.optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(["created", "value", "name"]).default("created"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type LeadListRow = LeadRow & {
  sourceKind: string;
  campaignId: string | null;
  campaignName: string | null;
  estimatedValueMinor: number | null;
  currency: string | null;
  timeframe: string | null;
  interest: string | null;
  qualification: Record<string, unknown>;
  quarantine: string;
  disqualifyReason: string | null;
  duplicateOfLeadId: string | null;
  rowVersion: number;
};

export async function leadPage(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{
  rows: LeadListRow[];
  total: number;
  byStatus: Record<string, number>;
  quarantined: number;
}> {
  assertCan(archetype, "leads.view");
  const q = LeadQuery.parse(raw ?? {});
  const status = q.status === "all" ? null : q.status;
  const quarantine = q.quarantine === "all" ? null : q.quarantine;
  const search = q.search ? `%${q.search}%` : null;
  const where = sql`
    l.org_id = ${ctx.orgId} and l.archived = false
    and (${status}::text is null or l.status = ${status})
    and (${quarantine}::text is null or l.quarantine = ${quarantine})
    and (${q.sourceKind ?? null}::text is null or l.source_kind = ${q.sourceKind ?? null})
    and (${q.campaignId ?? null}::uuid is null or l.campaign_id = ${q.campaignId ?? null}::uuid)
    and (${q.ownerUserId ?? null}::uuid is null or l.owner_user_id = ${q.ownerUserId ?? null}::uuid)
    and (${search}::text is null or l.name ilike ${search} or coalesce(l.contact_name, '') ilike ${search} or coalesce(l.email, '') ilike ${search})
  `;
  const order =
    q.sort === "value"
      ? sql`l.estimated_value_minor desc nulls last, l.created_at desc`
      : q.sort === "name"
        ? sql`l.name asc`
        : sql`l.created_at desc`;
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select l.id::text as id, l.name, l.contact_name, l.phone, l.email, l.source, l.status, l.owner_user_id::text as owner_user_id,
             u.full_name as owner_name, l.country, l.notes, l.converted_opportunity_id::text as converted_opportunity_id,
             l.converted_customer_id::text as converted_customer_id, l.archived,
             (select min(a.due_date)::text from public.sales_activity a where a.org_id = l.org_id and a.lead_id = l.id and a.kind = 'follow_up' and a.completed_at is null) as next_follow_up_due,
             l.created_at::text as created_at, l.updated_at::text as updated_at,
             l.source_kind, l.campaign_id::text as campaign_id, c.name as campaign_name, l.estimated_value_minor, l.currency,
             l.timeframe, l.interest, l.qualification, l.quarantine, l.disqualify_reason, l.duplicate_of_lead_id::text as duplicate_of_lead_id, l.row_version
      from public.lead l
      left join public.user_profile u on u.id = l.owner_user_id
      left join public.crm_campaign c on c.id = l.campaign_id
      where ${where}
      order by ${order}
      limit ${q.limit} offset ${q.offset}
    `)) as unknown as Array<Record<string, unknown>>;
    const agg = (await tx.execute(sql`
      select l.status, count(*)::int as n, sum(case when l.quarantine = 'quarantined' then 1 else 0 end)::int as q
      from public.lead l where ${where} group by l.status
    `)) as unknown as Array<{ status: string; n: number; q: number }>;
    const byStatus: Record<string, number> = {};
    let total = 0;
    let quarantined = 0;
    for (const a of agg) {
      byStatus[a.status] = Number(a.n);
      total += Number(a.n);
      quarantined += Number(a.q);
    }
    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        contactName: (r.contact_name as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        status: String(r.status) as LeadRow["status"],
        ownerUserId: (r.owner_user_id as string | null) ?? null,
        ownerName: (r.owner_name as string | null) ?? null,
        country: (r.country as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        convertedOpportunityId: (r.converted_opportunity_id as string | null) ?? null,
        convertedCustomerId: (r.converted_customer_id as string | null) ?? null,
        archived: Boolean(r.archived),
        nextFollowUpDue: (r.next_follow_up_due as string | null) ?? null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        sourceKind: String(r.source_kind),
        campaignId: (r.campaign_id as string | null) ?? null,
        campaignName: (r.campaign_name as string | null) ?? null,
        estimatedValueMinor:
          ctx.pricePrivileged && r.estimated_value_minor !== null
            ? Number(r.estimated_value_minor)
            : null,
        currency: (r.currency as string | null) ?? null,
        timeframe: (r.timeframe as string | null) ?? null,
        interest: (r.interest as string | null) ?? null,
        qualification: (r.qualification as Record<string, unknown>) ?? {},
        quarantine: String(r.quarantine),
        disqualifyReason: (r.disqualify_reason as string | null) ?? null,
        duplicateOfLeadId: (r.duplicate_of_lead_id as string | null) ?? null,
        rowVersion: Number(r.row_version),
      })) as LeadListRow[],
      total,
      byStatus,
      quarantined,
    };
  });
}

/** A lead adapter seam: inbound providers (email, messaging, API keys) are declared and fail closed. */
export function leadSourceAdapters(): Array<{
  kind: "email" | "messaging" | "api";
  configured: boolean;
  ownerAction: string;
}> {
  return [
    {
      kind: "email",
      configured: false,
      ownerAction:
        "Connect an inbound mailbox (IMAP or a provider webhook) and set its credentials; enquiries by email are entered manually meanwhile.",
    },
    {
      kind: "messaging",
      configured: false,
      ownerAction:
        "Contract a WhatsApp Business or SMS provider and set its inbound webhook credentials.",
    },
    {
      kind: "api",
      configured: false,
      ownerAction:
        "Issue an organisation API key for the enquiry endpoint once the public API is provisioned; public enquiry forms (Document Studio) work today.",
    },
  ];
}

// Keep the H20 status setter reachable for screens that only change status.
export { setLeadStatus };
