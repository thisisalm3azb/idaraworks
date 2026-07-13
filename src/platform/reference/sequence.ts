/**
 * Org-scoped reference-number allocation (the {prefix}-{seq} pattern S1 introduced
 * for job references, generalised for S4's MR/PO/GRN serials). Row-locked per
 * (org, scope) inside the caller's transaction — two concurrent allocations get
 * consecutive numbers. The serial START is org-configurable by seeding
 * reference_sequence (the "continues from paper LPO 27" requirement).
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";

export async function allocateReference(
  tx: TenantTx,
  ctx: Ctx,
  scopeKey: string,
  start = 1,
): Promise<number> {
  await tx.execute(sql`
    insert into public.reference_sequence (org_id, scope_key, next_value)
    values (${ctx.orgId}, ${scopeKey}, ${start})
    on conflict (org_id, scope_key) do nothing
  `);
  const rows = (await tx.execute(sql`
    update public.reference_sequence
    set next_value = next_value + 1
    where org_id = ${ctx.orgId} and scope_key = ${scopeKey}
    returning next_value - 1 as allocated
  `)) as unknown as Array<{ allocated: number }>;
  return Number(rows[0]!.allocated);
}

/** {prefix}-{zero-padded seq}, e.g. formatRef("PO", 27) → "PO-027". */
export function formatRef(prefix: string, n: number, pad = 3): string {
  return `${prefix}-${String(n).padStart(pad, "0")}`;
}
