/**
 * H27 — commercial exceptions. A discount above the organisation's threshold
 * is a `crm_discount` row that routes through the shared approvals engine
 * (subject `crm_discount`); the engine performs the guarded status move and
 * calls `onDiscountDecidedIn` in the same transaction. Nothing here changes a
 * quote: an approved discount is evidence the quote may carry that discount,
 * and the quote remains the priced document of record.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { submitForApproval } from "@/modules/approvals/service";

export type DiscountRow = {
  id: string;
  opportunityId: string;
  quoteId: string | null;
  requestedPct: number;
  listTotalMinor: number;
  discountedTotalMinor: number;
  currency: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  approvalId: string | null;
  decidedAt: string | null;
  requestedBy: string;
  createdAt: string;
};

const SELECT = sql`
  select id::text as id, opportunity_id::text as opportunity_id, quote_id::text as quote_id,
         requested_pct, list_total_minor, discounted_total_minor, currency, reason, status,
         approval_id::text as approval_id, decided_at::text as decided_at,
         requested_by::text as requested_by, created_at::text as created_at
  from public.crm_discount
`;

function rowToDiscount(r: Record<string, unknown>): DiscountRow {
  return {
    id: String(r.id),
    opportunityId: String(r.opportunity_id),
    quoteId: (r.quote_id as string | null) ?? null,
    requestedPct: Number(r.requested_pct),
    listTotalMinor: Number(r.list_total_minor),
    discountedTotalMinor: Number(r.discounted_total_minor),
    currency: String(r.currency),
    reason: String(r.reason),
    status: String(r.status) as DiscountRow["status"],
    approvalId: (r.approval_id as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    requestedBy: String(r.requested_by),
    createdAt: String(r.created_at),
  };
}

export class DiscountStateError extends Error {}

/** The organisation's threshold: discounts at or above it need approval (default 10%). */
export async function discountThresholdPctIn(tx: TenantTx, ctx: Ctx): Promise<number> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = 'crm.discount_threshold_pct'
  `)) as unknown as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 10;
}

export const RequestDiscountInput = z.object({
  opportunityId: z.string().uuid(),
  quoteId: z.string().uuid().optional().nullable(),
  requestedPct: z.number().positive().max(100),
  listTotalMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(1).max(1000),
});

/** Route a discount for approval. One live request per opportunity. */
export async function requestDiscount(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<DiscountRow> {
  assertCan(archetype, "opportunities.manage");
  const input = RequestDiscountInput.parse(raw);
  const discounted = Math.round(input.listTotalMinor * (1 - input.requestedPct / 100));
  return command(
    ctx,
    {
      audit: (r: DiscountRow) => ({
        action: "crm.discount.request",
        entityType: "crm_discount",
        entityId: r.id,
        summary: `Requested ${input.requestedPct}% discount`,
      }),
    },
    async (tx) => {
      const opp = (await tx.execute(sql`
        select id::text as id, status from public.opportunity
        where id = ${input.opportunityId} and org_id = ${ctx.orgId} and archived = false
      `)) as unknown as Array<{ id: string; status: string }>;
      if (!opp[0]) throw new DiscountStateError("opportunity not found");
      if (opp[0].status !== "open") throw new DiscountStateError("opportunity is not open");
      const live = (await tx.execute(sql`
        select id from public.crm_discount where opportunity_id = ${input.opportunityId} and status = 'pending'
      `)) as unknown as unknown[];
      if (live.length) throw new DiscountStateError("a discount request is already pending");
      const rows = (await tx.execute(sql`
        insert into public.crm_discount
          (org_id, opportunity_id, quote_id, requested_pct, list_total_minor, discounted_total_minor, currency, reason, requested_by)
        values (${ctx.orgId}, ${input.opportunityId}, ${input.quoteId ?? null}, ${input.requestedPct},
                ${input.listTotalMinor}, ${discounted}, ${input.currency}, ${input.reason}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      const approval = await submitForApproval(tx, ctx, {
        subjectType: "crm_discount",
        subjectId: id,
        subjectSummary: {
          title: `Discount ${input.requestedPct}%`,
          amountMinor: input.listTotalMinor - discounted,
        },
        amountMinor: input.listTotalMinor - discounted,
      });
      await tx.execute(sql`
        update public.crm_discount set approval_id = ${approval.approvalId} where id = ${id} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        insert into public.sales_activity (org_id, opportunity_id, kind, title, body, actor_user_id, meta)
        values (${ctx.orgId}, ${input.opportunityId}, 'discount', 'Discount requested', ${input.reason}, ${ctx.userId},
                ${JSON.stringify({ discountId: id, pct: input.requestedPct, status: "pending" })}::jsonb)
      `);
      const out = (await tx.execute(
        sql`${SELECT} where id = ${id} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<Record<string, unknown>>;
      return rowToDiscount(out[0]!);
    },
  );
}

/** Called by the approvals engine after the guarded status move (same transaction). */
export async function onDiscountDecidedIn(
  tx: TenantTx,
  ctx: Ctx,
  discountId: string,
  outcome: "approved" | "rejected",
  note: string | null,
): Promise<void> {
  const rows = (await tx.execute(sql`
    update public.crm_discount set decided_at = now()
    where id = ${discountId} and org_id = ${ctx.orgId}
    returning opportunity_id::text as opportunity_id, requested_pct, requested_by::text as requested_by
  `)) as unknown as Array<{ opportunity_id: string; requested_pct: number; requested_by: string }>;
  const d = rows[0];
  if (!d) return;
  await tx.execute(sql`
    insert into public.sales_activity (org_id, opportunity_id, kind, title, body, actor_user_id, meta)
    values (${ctx.orgId}, ${d.opportunity_id}, 'discount', ${outcome === "approved" ? "Discount approved" : "Discount rejected"},
            ${note}, ${ctx.userId}, ${JSON.stringify({ discountId, pct: Number(d.requested_pct), status: outcome })}::jsonb)
  `);
  if (d.requested_by !== ctx.userId)
    await createNotificationIn(tx, ctx, {
      recipientUserId: d.requested_by,
      kind: "approval_decided",
      title:
        outcome === "approved"
          ? `Discount ${Number(d.requested_pct)}% approved`
          : `Discount ${Number(d.requested_pct)}% rejected`,
      entityType: "opportunity",
      entityId: d.opportunity_id,
    });
}

export async function listDiscounts(
  ctx: Ctx,
  archetype: RoleArchetype,
  opportunityId: string,
): Promise<DiscountRow[]> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`${SELECT} where opportunity_id = ${opportunityId} and org_id = ${ctx.orgId} order by created_at desc limit 50`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToDiscount);
}
