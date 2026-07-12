/**
 * Worker harness (S0 checklist §7 item 3, minimal Phase E form; doc 10 #9):
 * every org-scoped function re-resolves ctx from the payload org_id and
 * RE-VERIFIES it against the database before touching data — the event payload
 * is untrusted input (Bible §6.9). Phase G extends this wrapper with the
 * outbox/relay conventions and dead-letter wiring.
 *
 * Verification = a withCtx read of the actor's OWN membership row for the
 * payload org: it proves the (org, actor) pair is a real, non-forged membership
 * — the doc 10 #9 property. (It does NOT gate on deactivation: a photo uploaded
 * while active should still process if the uploader is deactivated seconds
 * later; deactivation-time authz is the enqueuer's concern, not the benign
 * derivative pipeline's — the earlier "active membership" wording overstated it.)
 */
import { z } from "zod";
import { inngest } from "@/platform/events";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { logger } from "@/platform/logger";

export class OrgVerificationError extends Error {
  constructor(orgId: string) {
    super(`org verification failed for ${orgId}: unknown org or inactive actor`);
    this.name = "OrgVerificationError";
  }
}

const OrgPayloadBase = z.object({
  orgId: z.string().uuid(),
  actorUserId: z.string().uuid(),
});

/**
 * Parse + verify an org-scoped event payload; returns the re-derived Ctx.
 * Never trust ctx fields from the payload beyond the two ids — everything else
 * (privileges, role) is re-resolved by the database on every query via RLS.
 */
export async function verifyOrgPayload<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  requestId: string,
): Promise<{ payload: z.infer<S>; ctx: Ctx }> {
  const payload = schema.parse(data) as z.infer<S>;
  const base = OrgPayloadBase.parse(data);
  const ctx: Ctx = {
    orgId: base.orgId,
    userId: base.actorUserId,
    costPrivileged: false, // workers never carry cost/price privilege (doc 10 #17)
    pricePrivileged: false,
    requestId,
  };
  const isMember = await withCtx(ctx, async (tx) => {
    // The membership self-select policy returns the caller's OWN membership row;
    // a forged (org, actor) pair yields zero rows.
    const rows = (await tx.execute(sql`
      select 1 as ok from public.membership
      where org_id = ${base.orgId} and user_id = ${base.actorUserId}
    `)) as unknown as Array<{ ok: number }>;
    return rows.length > 0;
  });
  if (!isMember) {
    logger.warn({ orgId: base.orgId, requestId }, "worker payload failed org re-verification");
    throw new OrgVerificationError(base.orgId);
  }
  return { payload, ctx };
}

/**
 * defineOrgFunction (S0 checklist §7.3) — the ONLY way to declare an org-scoped
 * Inngest consumer. It verifies the payload's (org, actor) against the DB and
 * hands the handler a re-derived, trusted Ctx, so re-verification is impossible
 * to forget (doc 10 #9). The handler receives verified `payload` + `ctx`.
 */
type CreateFnOptions = Parameters<typeof inngest.createFunction>[0];

export function defineOrgFunction<S extends z.ZodTypeAny>(
  opts: {
    id: string;
    /** An eventType() trigger (registry-typed); payload type comes from `schema`. */
    trigger: object;
    schema: S;
    retries?: number;
  },
  handler: (args: { payload: z.infer<S>; ctx: Ctx; runId: string }) => Promise<unknown>,
) {
  const options = {
    id: opts.id,
    retries: opts.retries ?? 3,
    triggers: [opts.trigger],
  } as unknown as CreateFnOptions;
  return inngest.createFunction(options, async ({ event, runId }) => {
    const { payload, ctx } = await verifyOrgPayload(
      opts.schema,
      (event as { data: unknown }).data,
      `inngest-${runId}`,
    );
    return handler({ payload, ctx, runId });
  });
}
