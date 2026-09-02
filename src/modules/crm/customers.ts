/**
 * H27 — the Customer 360 extension (ADR-32, ADR-44): ownership, territory,
 * tags and segment on the customer; contacts with relationship roles; the
 * consent summary; documents, obligations, issues, signals; and an
 * evidence-based health score whose every contribution is shown. Financial
 * and work facts stay with their owners (invoices, payments, jobs) and are
 * read through `gatherCustomer360`.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

const uuid = z.string().uuid();

export const CustomerCrmPatch = z.object({
  customerId: uuid,
  ownerUserId: uuid.optional().nullable(),
  territoryId: uuid.optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  segment: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .nullable(),
});

export async function updateCustomerCrm(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "customers.manage");
  const input = CustomerCrmPatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.customer.update",
        entityType: "customer",
        entityId: input.customerId,
        summary: "Ownership, territory, tags or segment",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.customer set
          owner_user_id = case when ${input.ownerUserId === undefined} then owner_user_id else ${input.ownerUserId ?? null}::uuid end,
          territory_id = case when ${input.territoryId === undefined} then territory_id else ${input.territoryId ?? null}::uuid end,
          tags = coalesce(${input.tags ? sql`array(select x from jsonb_array_elements_text(${JSON.stringify(input.tags)}::jsonb) as x)` : null}, tags),
          segment = case when ${input.segment === undefined} then segment else ${input.segment ?? null} end,
          updated_at = now()
        where id = ${input.customerId} and org_id = ${ctx.orgId}
        returning id
      `)) as unknown as unknown[];
      if (!rows.length) throw new Error("customer not found");
    },
  );
}

export const ContactRolePatch = z.object({
  contactId: uuid,
  roleKind: z
    .enum([
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
    ])
    .optional(),
  language: z.enum(["en", "ar"]).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export async function updateContactRole(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "customers.manage");
  const input = ContactRolePatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.contact.update",
        entityType: "customer_contact",
        entityId: input.contactId,
        summary: "Relationship role",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.customer_contact set
          role_kind = coalesce(${input.roleKind ?? null}, role_kind),
          language = case when ${input.language === undefined} then language else ${input.language ?? null} end,
          notes = case when ${input.notes === undefined} then notes else ${input.notes ?? null} end,
          updated_at = now()
        where id = ${input.contactId} and org_id = ${ctx.orgId}
      `);
    },
  );
}

export type HealthSignal = {
  key: string;
  label: string;
  weight: number;
  /** -1 (bad) … +1 (good); null when the fact is unavailable. */
  value: number | null;
  evidence: string;
};

export type CustomerHealth = {
  score: number | null; // 0..100 or null when nothing is known
  band: "healthy" | "watch" | "at_risk" | "unknown";
  signals: HealthSignal[];
  knownSignals: number;
};

/** Pure: weighted average of known signals, mapped to 0..100; nothing pretended. */
export function scoreHealth(signals: HealthSignal[]): CustomerHealth {
  const known = signals.filter((s) => s.value !== null);
  if (known.length === 0) return { score: null, band: "unknown", signals, knownSignals: 0 };
  const w = known.reduce((s, x) => s + x.weight, 0);
  const v = known.reduce((s, x) => s + x.weight * (x.value as number), 0) / (w || 1);
  const score = Math.round(((v + 1) / 2) * 100);
  return {
    score,
    band: score >= 70 ? "healthy" : score >= 45 ? "watch" : "at_risk",
    signals,
    knownSignals: known.length,
  };
}

export type CustomerRevenue360 = {
  crm: {
    ownerUserId: string | null;
    ownerName: string | null;
    territoryId: string | null;
    territoryName: { en?: string; ar?: string } | null;
    tags: string[];
    segment: string | null;
    sourceKind: string | null;
    mergedIntoCustomerId: string | null;
  };
  contacts: Array<{
    id: string;
    name: string;
    roleTitle: string | null;
    roleKind: string;
    email: string | null;
    phone: string | null;
    preferredMethod: string;
    isPrimary: boolean;
    active: boolean;
    language: string | null;
    consent: Record<string, "granted" | "withdrawn" | "unknown" | "suppressed">;
  }>;
  consent: Record<string, "granted" | "withdrawn" | "unknown" | "suppressed">;
  documents: Array<{
    id: string;
    reference: string;
    title: string;
    status: string;
    category: string;
    expiresAt: string | null;
  }>;
  obligations: Array<{
    id: string;
    title: string;
    kind: string;
    dueOn: string;
    status: string;
    documentReference: string;
  }>;
  issues: Array<{ id: string; title: string; status: string; createdAt: string }>;
  signals: Array<{
    id: string;
    kind: string;
    score: number | null;
    status: string | null;
    title: string | null;
    recordedAt: string;
    dueOn: string | null;
  }>;
  activities: { open: number; lastAt: string | null };
  health: CustomerHealth;
  renewals: Array<{ id: string; title: string; dueOn: string; documentReference: string }>;
};

async function consentMapIn(
  tx: import("@/platform/tenancy").TenantTx,
  ctx: Ctx,
  where: { customerId?: string; contactId?: string },
  addresses: { email: string | null; phone: string | null },
): Promise<Record<string, "granted" | "withdrawn" | "unknown" | "suppressed">> {
  const rows = (await tx.execute(sql`
    select distinct on (channel) channel, status from public.crm_consent
    where org_id = ${ctx.orgId}
      and (${where.customerId ?? null}::uuid is null or customer_id = ${where.customerId ?? null}::uuid)
      and (${where.contactId ?? null}::uuid is null or contact_id = ${where.contactId ?? null}::uuid)
      and (${where.customerId ? sql`customer_id is not null` : sql`contact_id is not null`})
    order by channel, effective_at desc
  `)) as unknown as Array<{ channel: string; status: string }>;
  const out: Record<string, "granted" | "withdrawn" | "unknown" | "suppressed"> = {
    email: "unknown",
    sms: "unknown",
    whatsapp: "unknown",
    phone: "unknown",
  };
  for (const r of rows) out[r.channel] = r.status as "granted" | "withdrawn" | "unknown";
  const email = addresses.email?.trim().toLowerCase() ?? null;
  const phone = addresses.phone?.replace(/[^\d+]/g, "") ?? null;
  const sup = (await tx.execute(sql`
    select channel from public.crm_suppression where org_id = ${ctx.orgId}
      and ((${email}::text is not null and channel = 'email' and address = ${email})
        or (${phone}::text is not null and channel in ('sms', 'whatsapp', 'phone') and address = ${phone}))
  `)) as unknown as Array<{ channel: string }>;
  for (const s of sup) out[s.channel] = "suppressed";
  return out;
}

export async function gatherRevenue360(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
): Promise<CustomerRevenue360> {
  assertCan(archetype, "customers.view");
  return withCtx(ctx, async (tx) => {
    const c = (await tx.execute(sql`
      select c.owner_user_id::text as owner_user_id, u.full_name as owner_name, c.territory_id::text as territory_id, t.name as territory_name,
             c.tags, c.segment, c.source_kind, c.merged_into_customer_id::text as merged_into, c.email, c.phone, c.active
      from public.customer c
      left join public.user_profile u on u.id = c.owner_user_id
      left join public.crm_territory t on t.id = c.territory_id
      where c.id = ${customerId} and c.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!c[0]) throw new Error("customer not found");
    const contacts = (await tx.execute(sql`
      select id::text as id, name, role_title, role_kind, email, phone, preferred_method, is_primary, active, language
      from public.customer_contact where org_id = ${ctx.orgId} and customer_id = ${customerId}
      order by is_primary desc, active desc, name asc limit 100
    `)) as unknown as Array<Record<string, unknown>>;
    const contactRows = [] as CustomerRevenue360["contacts"];
    for (const r of contacts) {
      contactRows.push({
        id: String(r.id),
        name: String(r.name),
        roleTitle: (r.role_title as string | null) ?? null,
        roleKind: String(r.role_kind),
        email: (r.email as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        preferredMethod: String(r.preferred_method),
        isPrimary: Boolean(r.is_primary),
        active: Boolean(r.active),
        language: (r.language as string | null) ?? null,
        consent: await consentMapIn(
          tx,
          ctx,
          { contactId: String(r.id) },
          { email: (r.email as string | null) ?? null, phone: (r.phone as string | null) ?? null },
        ),
      });
    }
    const consent = await consentMapIn(
      tx,
      ctx,
      { customerId },
      {
        email: (c[0].email as string | null) ?? null,
        phone: (c[0].phone as string | null) ?? null,
      },
    );
    const documents = can(archetype, "documents.view")
      ? ((await tx.execute(sql`
          select id::text as id, reference, title, status, category, expires_at::text as expires_at
          from public.doc_document where org_id = ${ctx.orgId} and counterparty_kind = 'customer' and counterparty_id = ${customerId}
          order by created_at desc limit 50
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const obligations = can(archetype, "documents.view")
      ? ((await tx.execute(sql`
          select o.id::text as id, o.title, o.kind, o.due_on::text as due_on, o.status, d.reference
          from public.doc_obligation o join public.doc_document d on d.id = o.document_id and d.org_id = o.org_id
          where o.org_id = ${ctx.orgId} and d.counterparty_kind = 'customer' and d.counterparty_id = ${customerId}
          order by (o.status = 'open') desc, o.due_on asc limit 100
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const issues = can(archetype, "issues.raise")
      ? ((await tx.execute(sql`
          select i.id::text as id, i.title, i.status, i.created_at::text as created_at
          from public.issue i join public.job j on j.id = i.job_id and j.org_id = i.org_id
          where i.org_id = ${ctx.orgId} and j.customer_id = ${customerId}
          order by i.created_at desc limit 50
        `)) as unknown as Array<Record<string, unknown>>)
      : [];
    const signals = (await tx.execute(sql`
      select id::text as id, kind, score, status, title, recorded_at::text as recorded_at, due_on::text as due_on
      from public.crm_customer_signal where org_id = ${ctx.orgId} and customer_id = ${customerId}
      order by recorded_at desc limit 100
    `)) as unknown as Array<Record<string, unknown>>;
    const act = (await tx.execute(sql`
      select (select count(*)::int from public.sales_activity a where a.org_id = ${ctx.orgId} and a.completed_at is null and a.kind in ('follow_up','task')
                and (a.customer_id = ${customerId} or a.opportunity_id in (select id from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${customerId}))) as open_count,
             (select max(a.created_at)::text from public.sales_activity a where a.org_id = ${ctx.orgId}
                and (a.customer_id = ${customerId} or a.opportunity_id in (select id from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${customerId}))) as last_at
    `)) as unknown as Array<{ open_count: number; last_at: string | null }>;
    const money = can(archetype, "invoices.view")
      ? ((await tx.execute(sql`
          select count(*) filter (where status in ('issued','partially_paid') and due_date < current_date)::int as overdue,
                 count(*) filter (where status = 'paid')::int as paid
          from public.invoice where org_id = ${ctx.orgId} and customer_id = ${customerId}
        `)) as unknown as Array<{ overdue: number; paid: number }>)
      : [];
    const stalled = (await tx.execute(sql`
      select count(*)::int as n from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${customerId}
        and status = 'open' and archived = false and coalesce(last_activity_at, stage_entered_at) < now() - interval '30 days'
    `)) as unknown as Array<{ n: number }>;
    const openIssues = issues.filter(
      (i) => !["closed", "resolved", "done"].includes(String(i.status)),
    ).length;
    const overdueObl = obligations.filter(
      (o) => o.status === "open" && String(o.due_on) < new Date().toISOString().slice(0, 10),
    ).length;
    const lastSat = signals.find((s) => s.kind === "satisfaction");
    const churn = signals.find((s) => s.kind === "churn_risk");
    const lastAt = act[0]?.last_at ?? null;
    const daysSince = lastAt
      ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86_400_000)
      : null;
    const health = scoreHealth([
      {
        key: "invoices",
        label: "Overdue invoices",
        weight: 3,
        value: money[0] ? (money[0].overdue > 0 ? -1 : 1) : null,
        evidence: money[0] ? `${money[0].overdue} overdue` : "not visible to this role",
      },
      {
        key: "issues",
        label: "Open issues",
        weight: 2,
        value: issues.length || can(archetype, "issues.raise") ? (openIssues > 0 ? -0.5 : 1) : null,
        evidence: `${openIssues} open`,
      },
      {
        key: "stalled",
        label: "Stalled opportunities",
        weight: 1,
        value: stalled[0] ? (Number(stalled[0].n) > 0 ? -0.5 : 0.5) : null,
        evidence: `${stalled[0]?.n ?? 0} open with no activity for 30 days`,
      },
      {
        key: "obligations",
        label: "Overdue obligations",
        weight: 2,
        value: can(archetype, "documents.view") ? (overdueObl > 0 ? -1 : 1) : null,
        evidence: `${overdueObl} overdue`,
      },
      {
        key: "engagement",
        label: "Recent engagement",
        weight: 2,
        value: daysSince === null ? null : daysSince <= 30 ? 1 : daysSince <= 90 ? 0 : -1,
        evidence:
          daysSince === null ? "no activity recorded" : `${daysSince} days since the last activity`,
      },
      {
        key: "satisfaction",
        label: "Satisfaction",
        weight: 3,
        value: lastSat && lastSat.score !== null ? (Number(lastSat.score) - 3) / 2 : null,
        evidence: lastSat
          ? `${lastSat.score}/5 on ${String(lastSat.recorded_at).slice(0, 10)}`
          : "no satisfaction record",
      },
      {
        key: "churn",
        label: "Churn risk record",
        weight: 2,
        value: churn && churn.score !== null ? 1 - (Number(churn.score) / 100) * 2 : null,
        evidence: churn
          ? `${churn.score}/100 on ${String(churn.recorded_at).slice(0, 10)}`
          : "no churn-risk record",
      },
    ]);
    return {
      crm: {
        ownerUserId: (c[0].owner_user_id as string | null) ?? null,
        ownerName: (c[0].owner_name as string | null) ?? null,
        territoryId: (c[0].territory_id as string | null) ?? null,
        territoryName: (c[0].territory_name as { en?: string; ar?: string } | null) ?? null,
        tags: (c[0].tags as string[]) ?? [],
        segment: (c[0].segment as string | null) ?? null,
        sourceKind: (c[0].source_kind as string | null) ?? null,
        mergedIntoCustomerId: (c[0].merged_into as string | null) ?? null,
      },
      contacts: contactRows,
      consent,
      documents: documents.map((d) => ({
        id: String(d.id),
        reference: String(d.reference),
        title: String(d.title),
        status: String(d.status),
        category: String(d.category),
        expiresAt: (d.expires_at as string | null) ?? null,
      })),
      obligations: obligations.map((o) => ({
        id: String(o.id),
        title: String(o.title),
        kind: String(o.kind),
        dueOn: String(o.due_on),
        status: String(o.status),
        documentReference: String(o.reference),
      })),
      issues: issues.map((i) => ({
        id: String(i.id),
        title: String(i.title),
        status: String(i.status),
        createdAt: String(i.created_at),
      })),
      signals: signals.map((s) => ({
        id: String(s.id),
        kind: String(s.kind),
        score: s.score === null ? null : Number(s.score),
        status: (s.status as string | null) ?? null,
        title: (s.title as string | null) ?? null,
        recordedAt: String(s.recorded_at),
        dueOn: (s.due_on as string | null) ?? null,
      })),
      activities: { open: Number(act[0]?.open_count ?? 0), lastAt },
      health,
      renewals: obligations
        .filter((o) => o.kind === "renewal" && o.status === "open")
        .map((o) => ({
          id: String(o.id),
          title: String(o.title),
          dueOn: String(o.due_on),
          documentReference: String(o.reference),
        })),
    };
  });
}

export const SignalInput = z.object({
  customerId: uuid,
  kind: z.enum(["satisfaction", "onboarding", "adoption", "success_plan", "churn_risk", "note"]),
  score: z.number().int().min(0).max(100).optional().nullable(),
  status: z.enum(["open", "done", "at_risk", "healthy"]).optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().max(4000).optional().nullable(),
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

export async function recordSignal(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "customers.manage");
  const input = SignalInput.parse(raw);
  if (
    input.kind === "satisfaction" &&
    (input.score === null || input.score === undefined || input.score < 1 || input.score > 5)
  )
    throw new Error("satisfaction is 1 to 5");
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.signal.record",
        entityType: "customer",
        entityId: input.customerId,
        summary: `${input.kind} ${r.id.slice(0, 8)}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_customer_signal (org_id, customer_id, kind, score, status, title, body, due_on, created_by)
        values (${ctx.orgId}, ${input.customerId}, ${input.kind}, ${input.score ?? null}, ${input.status ?? null}, ${input.title ?? null}, ${input.body ?? null}, ${input.dueOn ?? null}::date, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}
