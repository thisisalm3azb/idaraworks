/**
 * S10 self-service data export (doc 10 #42). A governed, tenant-scoped CSV export of an org's core
 * operational + financial data — the data-portability + account-closure prerequisite. Every read
 * goes through withCtx (RLS second wall), is PAGED (never the silent 1,000-row cap), and every cell
 * passes the formula-injection guard (csvEscape, doc 10 #25). Gated by `data.export` — owner / admin
 * / accounts, a fully money-privileged set, so the export carries exactly what the reader already
 * sees (no extra redaction layer needed; a foreman/viewer can't export at all).
 *
 * The ENTITY set is a closed registry so a completeness test can enumerate it (doc 10 #42 "the
 * completeness test enumerates the entity catalogue").
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz/can";
import type { RoleArchetype } from "@/platform/registries";
import { toCsv } from "./csv";

const PAGE = 1000;

type EntityDef = {
  headers: string[];
  // Returns one page of rows (already projected to the header order) at the given offset.
  page: (tx: TenantTx, ctx: Ctx, limit: number, offset: number) => Promise<Array<Array<unknown>>>;
};

// A closed catalogue of exportable entities. Ordered, keyed, enumerable.
export const EXPORT_ENTITIES = {
  jobs: {
    headers: [
      "reference",
      "name",
      "status_category",
      "current_stage",
      "selling_price_minor",
      "created_at",
    ],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select reference, name, status_category, current_stage_id::text as current_stage,
               selling_price_minor::text as selling_price_minor, created_at::text as created_at
        from public.job where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.reference,
        r.name,
        r.status_category,
        r.current_stage,
        r.selling_price_minor,
        r.created_at,
      ]);
    },
  },
  customers: {
    headers: ["name", "tax_reg_no", "contact_name", "phone", "email", "created_at"],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select name, tax_reg_no, contact_name, phone, email, created_at::text as created_at
        from public.customer where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.name,
        r.tax_reg_no,
        r.contact_name,
        r.phone,
        r.email,
        r.created_at,
      ]);
    },
  },
  suppliers: {
    headers: ["name", "tax_reg_no", "phone", "email", "created_at"],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select name, tax_reg_no, phone, email, created_at::text as created_at
        from public.supplier where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [r.name, r.tax_reg_no, r.phone, r.email, r.created_at]);
    },
  },
  invoices: {
    headers: [
      "reference",
      "kind",
      "status",
      "customer_name",
      "total_minor",
      "vat_amount_minor",
      "issued_at",
    ],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select reference, kind, status, customer_name, total_minor::text as total_minor,
               vat_amount_minor::text as vat_amount_minor, issued_at::text as issued_at
        from public.invoice where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.reference,
        r.kind,
        r.status,
        r.customer_name,
        r.total_minor,
        r.vat_amount_minor,
        r.issued_at,
      ]);
    },
  },
  payments: {
    headers: [
      "reference",
      "status",
      "method",
      "customer_name",
      "amount_minor",
      "currency",
      "payment_date",
    ],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select reference, status, method, customer_name, amount_minor::text as amount_minor,
               currency, payment_date::text as payment_date
        from public.payment where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.reference,
        r.status,
        r.method,
        r.customer_name,
        r.amount_minor,
        r.currency,
        r.payment_date,
      ]);
    },
  },
  expenses: {
    headers: [
      "reference",
      "category_key",
      "description",
      "amount_minor",
      "expense_date",
      "payment_status",
    ],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select reference, category_key, description, amount_minor::text as amount_minor,
               expense_date::text as expense_date, payment_status
        from public.expense where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.reference,
        r.category_key,
        r.description,
        r.amount_minor,
        r.expense_date,
        r.payment_status,
      ]);
    },
  },
  daily_reports: {
    headers: ["job_id", "report_date", "status", "summary", "created_at"],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select job_id::text as job_id, report_date::text as report_date, status, summary, created_at::text as created_at
        from public.daily_report where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [r.job_id, r.report_date, r.status, r.summary, r.created_at]);
    },
  },
  audit_log: {
    headers: ["action", "entity_type", "entity_id", "actor_user_id", "summary", "created_at"],
    page: async (tx, ctx, limit, offset) => {
      const rows = (await tx.execute(sql`
        select action, entity_type, entity_id::text as entity_id, actor_user_id::text as actor_user_id,
               summary, created_at::text as created_at
        from public.audit_log where org_id = ${ctx.orgId}
        order by created_at, id limit ${limit} offset ${offset}`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => [
        r.action,
        r.entity_type,
        r.entity_id,
        r.actor_user_id,
        r.summary,
        r.created_at,
      ]);
    },
  },
} as const satisfies Record<string, EntityDef>;

export type ExportEntity = keyof typeof EXPORT_ENTITIES;
export const EXPORT_ENTITY_KEYS = Object.keys(EXPORT_ENTITIES) as ExportEntity[];

export function isExportEntity(x: string): x is ExportEntity {
  return x in EXPORT_ENTITIES;
}

/** Export ONE entity as a guarded CSV string. Paged read — never the 1,000-row silent cap. */
export async function exportEntityCsv(
  ctx: Ctx,
  archetype: RoleArchetype,
  entity: ExportEntity,
): Promise<string> {
  assertCan(archetype, "data.export");
  const def = EXPORT_ENTITIES[entity];
  return withCtx(ctx, async (tx) => {
    const all: Array<Array<unknown>> = [];
    for (let offset = 0; ; offset += PAGE) {
      const batch = await def.page(tx, ctx, PAGE, offset);
      all.push(...batch);
      if (batch.length < PAGE) break; // last page
    }
    return toCsv(def.headers, all);
  });
}
