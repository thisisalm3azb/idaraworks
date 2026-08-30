/**
 * H19 — the Customer 360 composition point (module public surface).
 *
 * ONE server-side place that assembles the customer relationship hub from
 * the EXISTING facts: the customer master (masters service), quotes, work,
 * invoices, payments and customer updates linked by their real customer_id
 * columns, and the shared outstanding-invoice derivation (invoices service).
 * No parallel customer or receivable model exists here — this file only
 * composes what the owning services already decided the caller may see.
 *
 * The lifecycle timeline deliberately reads the BUSINESS RECORDS, not
 * audit_log: audit_log's RLS admits only owner/admin/accounts, so a
 * timeline built on it would silently render empty for managers. Business
 * rows are tenant-readable under org RLS and each event type is gated by
 * the SAME permission that guards its module's pages. Summaries carry
 * references and statuses, never amounts.
 *
 * Partial failure (Part N): every section is individually guarded — one
 * failed source labels its own section unavailable instead of destroying
 * the page.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import {
  getCustomer,
  listCustomerContacts,
  presentPrimaryContact,
  type CustomerContactRow,
  type CustomerDetail,
} from "@/modules/masters/service";
import { customerMoney, type CustomerMoney } from "@/modules/invoices/service";
import { listOpportunities, type OpportunityRow } from "./sales";

// H20 — the sales CRM engine (module public surface).
export * from "./sales";

// ── The canonical customer presentation model (H19 Part B) ──────────────────
// Honest to the real schema: the customer table has no organization vs
// individual discriminator, no separate legal name, no reference code, no
// addresses, no language or currency preference and no internal owner —
// those render only when a future schema supports them. Country, tax
// identity and contact fields stay separate and optional (nothing assumes
// a company, an email, or any UAE-specific field).
export type CustomerPresentation = {
  id: string;
  displayName: string;
  active: boolean;
  country: string | null;
  taxRegNo: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Normalized primary (or the legacy embedded contact adapter row). */
  primaryContact: CustomerContactRow | null;
  /** Additional active normalized contacts (primary excluded). */
  otherContacts: CustomerContactRow[];
};

export function presentCustomer(
  detail: CustomerDetail,
  contacts: CustomerContactRow[],
): CustomerPresentation {
  const primary = presentPrimaryContact(detail, contacts);
  return {
    id: detail.id,
    displayName: detail.name,
    active: detail.active,
    country: detail.country,
    taxRegNo: detail.taxRegNo,
    notes: detail.notes,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    primaryContact: primary,
    otherContacts: contacts.filter((c) => c.id !== primary?.id),
  };
}

// ── Linked lifecycle records ────────────────────────────────────────────────
export type CustomerQuoteRow = {
  id: string;
  reference: string;
  status: string;
  totalMinor: number | null;
  createdAt: string;
  convertedJobId: string | null;
};

export type CustomerJobRow = {
  id: string;
  reference: string;
  name: string;
  statusCategory: string;
  currentStage: { en: string; ar: string } | null;
  dueDate: string | null;
  createdAt: string;
};

export type CustomerTimelineEvent = {
  key: string;
  kind:
    | "customer_created"
    | "quote_created"
    | "quote_accepted"
    | "quote_rejected"
    | "job_created"
    | "job_completed"
    | "invoice_issued"
    | "payment_recorded"
    | "update_sent";
  reference: string | null;
  at: string;
  href: string | null;
};

export type Customer360 = {
  customer: CustomerPresentation;
  quotes: CustomerQuoteRow[] | null;
  jobs: CustomerJobRow[] | null;
  /** H20: this customer's opportunities (opportunities.view holders). */
  opportunities: OpportunityRow[] | null;
  money: CustomerMoney | null;
  /** Distinguishes redaction from failure: 'restricted' | 'failed' | 'ok'. */
  moneyState: "ok" | "restricted" | "failed" | "hidden";
  timeline: CustomerTimelineEvent[] | null;
  /** Section keys whose source failed (honest unavailability labels). */
  failed: string[];
  attention: {
    overdueInvoices: number;
    over90: boolean;
    expiredQuotes: number;
    blockedJobs: number;
  } | null;
};

const LIMIT = 25;

async function customerQuotes(ctx: Ctx, customerId: string): Promise<CustomerQuoteRow[]> {
  const seesPrice = ctx.pricePrivileged;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, reference, status, total_minor,
             created_at::text as created_at, converted_job_id::text as converted_job_id
      from public.quote
      where org_id = ${ctx.orgId} and customer_id = ${customerId}
      order by created_at desc limit ${LIMIT}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    status: r.status as string,
    totalMinor: seesPrice ? Number(r.total_minor) : null,
    createdAt: r.created_at as string,
    convertedJobId: (r.converted_job_id as string | null) ?? null,
  }));
}

async function customerJobs(ctx: Ctx, customerId: string): Promise<CustomerJobRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select j.id::text as id, j.reference, j.name, j.status_category,
             cs.name as stage_name, j.due_date::text as due_date,
             j.created_at::text as created_at
      from public.job j
      left join public.job_stage cs on cs.id = j.current_stage_id
      where j.org_id = ${ctx.orgId} and j.customer_id = ${customerId} and j.archived = false
      order by j.created_at desc limit ${LIMIT}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    name: r.name as string,
    statusCategory: r.status_category as string,
    currentStage: (r.stage_name as { en: string; ar: string } | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

/** ONE bounded union over the real lifecycle records, permission-filtered
 * per event type server-side (H19 Part H). No amounts, no internal names. */
export async function listCustomerTimeline(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
  opts: { limit?: number } = {},
): Promise<CustomerTimelineEvent[]> {
  if (!z.string().uuid().safeParse(customerId).success) return [];
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const seeQuotes = can(archetype, "quotes.view");
  const seeInvoices = can(archetype, "invoices.view");
  const seePayments = can(archetype, "payments.view");
  const seeUpdates = can(archetype, "customer_updates.draft");
  const o = `/o/${ctx.orgId}`;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select * from (
        select 'customer_created' as kind, null::text as reference,
               c.created_at as at, null::text as rec_id
        from public.customer c
        where c.org_id = ${ctx.orgId} and c.id = ${customerId}
        union all
        select 'quote_created', q.reference, q.created_at, q.id::text
        from public.quote q
        where ${seeQuotes} and q.org_id = ${ctx.orgId} and q.customer_id = ${customerId}
        union all
        select case when q.status in ('converted') or q.converted_job_id is not null
                    then 'quote_accepted' else 'quote_rejected' end,
               q.reference, coalesce(q.accepted_at, q.updated_at), q.id::text
        from public.quote q
        where ${seeQuotes} and q.org_id = ${ctx.orgId} and q.customer_id = ${customerId}
          and (q.converted_job_id is not null or q.status = 'rejected')
        union all
        select 'job_created', j.reference, j.created_at, j.id::text
        from public.job j
        where j.org_id = ${ctx.orgId} and j.customer_id = ${customerId} and j.archived = false
        union all
        select 'job_completed', j.reference,
               (j.completed_date::timestamptz), j.id::text
        from public.job j
        where j.org_id = ${ctx.orgId} and j.customer_id = ${customerId}
          and j.archived = false and j.completed_date is not null
        union all
        select 'invoice_issued', i.reference, i.issued_at, i.id::text
        from public.invoice i
        where ${seeInvoices} and i.org_id = ${ctx.orgId} and i.customer_id = ${customerId}
          and i.kind = 'invoice' and i.issued_at is not null
        union all
        select 'payment_recorded', p.reference, p.created_at, p.id::text
        from public.payment p
        join public.invoice i on i.id = p.invoice_id
        where ${seePayments} and p.org_id = ${ctx.orgId} and i.customer_id = ${customerId}
          and p.status in ('recorded','confirmed')
        union all
        select 'update_sent', u.title, u.sent_at, u.id::text
        from public.customer_update u
        where ${seeUpdates} and u.org_id = ${ctx.orgId} and u.customer_id = ${customerId}
          and u.status = 'sent' and u.sent_at is not null
      ) ev
      where ev.at is not null
      order by ev.at desc
      limit ${limit}
    `),
  )) as unknown as Array<{
    kind: string;
    reference: string | null;
    at: string;
    rec_id: string | null;
  }>;
  const href = (kind: string, id: string | null): string | null => {
    if (!id) return null;
    switch (kind) {
      case "quote_created":
      case "quote_accepted":
      case "quote_rejected":
        return `${o}/quotes/${id}`;
      case "job_created":
      case "job_completed":
        return `${o}/jobs/${id}`;
      case "invoice_issued":
        return `${o}/invoices/${id}`;
      case "payment_recorded":
        return `${o}/payments`;
      case "update_sent":
        return `${o}/customer-updates/${id}`;
      default:
        return null;
    }
  };
  return rows.map((r, i) => ({
    key: `${r.kind}_${r.rec_id ?? i}`,
    kind: r.kind as CustomerTimelineEvent["kind"],
    reference: r.reference,
    at: r.at,
    href: href(r.kind, r.rec_id),
  }));
}

async function guarded<T>(key: string, failed: string[], fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    failed.push(key);
    return null;
  }
}

/** The Customer 360 gather: independent sections in parallel, each behind
 * its own permission and its own failure guard. Returns null only when the
 * customer itself is missing or unreadable. */
export async function gatherCustomer360(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
  opts: { asOf: string },
): Promise<Customer360 | null> {
  const detail = await getCustomer(ctx, archetype, customerId);
  if (!detail) return null;
  const failed: string[] = [];
  const seeQuotes = can(archetype, "quotes.view");
  const seeMoney = can(archetype, "ar.view");
  const [contacts, quotes, jobs, money, timeline, opportunities] = await Promise.all([
    guarded("contacts", failed, () => listCustomerContacts(ctx, archetype, customerId)),
    seeQuotes
      ? guarded("quotes", failed, () => customerQuotes(ctx, customerId))
      : Promise.resolve(null),
    can(archetype, "jobs.view")
      ? guarded("jobs", failed, () => customerJobs(ctx, customerId))
      : Promise.resolve(null),
    seeMoney
      ? guarded("money", failed, () => customerMoney(ctx, archetype, customerId, opts.asOf))
      : Promise.resolve(null),
    guarded("timeline", failed, () => listCustomerTimeline(ctx, archetype, customerId)),
    can(archetype, "opportunities.view")
      ? guarded("opportunities", failed, () =>
          listOpportunities(ctx, archetype, { customerId, status: "all", limit: 25 }),
        )
      : Promise.resolve(null),
  ]);
  const moneyState: Customer360["moneyState"] = !seeMoney
    ? "hidden"
    : failed.includes("money")
      ? "failed"
      : money === null
        ? "restricted"
        : "ok";
  // Attention facts derive from the already-fetched, already-gated data —
  // nothing is recomputed and nothing leaks past a permission.
  const attention =
    money || quotes || jobs
      ? {
          overdueInvoices: money && money.overdueMinor > 0 ? 1 : 0,
          over90: !!money && money.over90Minor > 0,
          expiredQuotes: (quotes ?? []).filter((q) => q.status === "expired").length,
          blockedJobs: (jobs ?? []).filter((j) => j.statusCategory === "on_hold").length,
        }
      : null;
  return {
    customer: presentCustomer(detail, contacts ?? []),
    quotes,
    jobs,
    opportunities,
    money,
    moneyState,
    timeline,
    failed,
    attention,
  };
}
