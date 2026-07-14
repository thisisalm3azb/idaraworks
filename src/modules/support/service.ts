/**
 * Support impersonation (S9; v1 §13 "support impersonation, consent-gated, banner, dual-logged").
 *
 * A platform (IdaraWorks) staff member may open a governed, time-bounded session into a tenant org
 * to help — but ONLY with the tenant's consent OR a logged break-glass override, and EVERY start/
 * end is written to the TENANT'S OWN audit log (the DoD AC) as well as the platform stream. All
 * writes go through the assert_platform_task-guarded DEFINER functions (0056): staff act without a
 * tenant context, and a tenant request can never open a session into another org.
 */
import { createAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";

export type StartImpersonationInput = {
  orgId: string;
  staffUserId: string;
  reason: string;
  /** A tenant owner/admin user id who granted access, OR omit + set breakGlass. */
  consentGrantedBy?: string;
  breakGlass?: boolean;
};

/** Open a support session (platform staff, no tenant context). Enforces staff membership +
 * consent-or-break-glass in the DB; dual-logs to the tenant audit log. Returns the session id. */
export async function startImpersonation(
  input: StartImpersonationInput,
): Promise<{ sessionId: string }> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select app.start_impersonation(
        ${input.orgId}::uuid, ${input.staffUserId}::uuid, ${input.reason},
        ${input.consentGrantedBy ?? null}, ${input.breakGlass ?? false}) as id`)) as unknown as Array<{
      id: string;
    }>;
    return { sessionId: rows[0]!.id };
  } finally {
    await end();
  }
}

/** Close a support session (dual-logged). Idempotent: ending an already-ended session is a no-op. */
export async function endImpersonation(sessionId: string): Promise<void> {
  const { db, end } = createAppDb({ max: 1 });
  try {
    await db.execute(sql`select app.end_impersonation(${sessionId}::uuid)`);
  } finally {
    await end();
  }
}

export type ImpersonationView = {
  id: string;
  staffUserId: string;
  reason: string;
  breakGlass: boolean;
  startedAt: string;
  endedAt: string | null;
};

/** The tenant's own view of support access into its org (drives the banner + a transparency list). */
export async function listImpersonations(
  ctx: Ctx,
  archetype: RoleArchetype,
  activeOnly = false,
): Promise<ImpersonationView[]> {
  assertCan(archetype, "billing.view"); // owner/admin/accounts see who accessed the org
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, staff_user_id::text as staff, reason, break_glass,
             started_at::text as started_at, ended_at::text as ended_at
      from public.impersonation_session
      where org_id = ${ctx.orgId} ${activeOnly ? sql`and ended_at is null` : sql``}
      order by started_at desc limit 50`)) as unknown as Array<{
      id: string;
      staff: string;
      reason: string;
      break_glass: boolean;
      started_at: string;
      ended_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      staffUserId: r.staff,
      reason: r.reason,
      breakGlass: r.break_glass,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  });
}

/** Is a support session currently open on this org? Drives the persistent banner in the tenant UI. */
export async function hasActiveImpersonation(ctx: Ctx): Promise<boolean> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select 1 from public.impersonation_session
      where org_id = ${ctx.orgId} and ended_at is null limit 1`)) as unknown as Array<unknown>;
    return rows.length > 0;
  });
}
