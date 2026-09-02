/**
 * H26 — what needs a person's attention across the document estate, computed
 * on read for the command centre: overdue and due-soon obligations, documents
 * expiring inside the reminder window, steps waiting on me, signature rooms in
 * flight and form submissions waiting for review.
 */
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { listObligations, type ObligationRow } from "./obligations";
import { listMySteps } from "./workflow-runs";
import { getDocSettingsIn } from "./library";

export type ExpiringDocument = {
  id: string;
  reference: string;
  title: string;
  expiresAt: string;
  daysLeft: number;
  hasSuccessor: boolean;
};

export type AttentionFeed = {
  overdue: ObligationRow[];
  dueSoon: ObligationRow[];
  expiring: ExpiringDocument[];
  mySteps: Awaited<ReturnType<typeof listMySteps>>;
  awaitingSignature: number;
  pendingSubmissions: number;
  soonDays: number;
};

export async function attentionFeed(ctx: Ctx, archetype: RoleArchetype): Promise<AttentionFeed> {
  assertCan(archetype, "documents.view");
  const obligations = await listObligations(ctx, archetype, { status: ["open"], limit: 500 });
  const mySteps = await listMySteps(ctx, archetype);
  return withCtx(ctx, async (tx) => {
    const settings = await getDocSettingsIn(tx, ctx);
    const soonDays = Math.max(0, ...settings.reminderDays);
    const expiring = (await tx.execute(sql`
      select d.id::text as id, d.reference, d.title, d.expires_at::text as expires_at,
             (d.expires_at - current_date)::int as days_left,
             (d.superseded_by_document_id is not null) as has_successor
      from public.doc_document d
      where d.org_id = ${ctx.orgId} and d.status = 'active' and d.expires_at is not null
        and d.expires_at <= current_date + make_interval(days => ${soonDays})
      order by d.expires_at asc
      limit 100
    `)) as unknown as Array<{
      id: string;
      reference: string;
      title: string;
      expires_at: string;
      days_left: number;
      has_successor: boolean;
    }>;
    const sig = (await tx.execute(sql`
      select count(*)::int as n from public.doc_signature_request
      where org_id = ${ctx.orgId} and status in ('pending', 'in_progress')
    `)) as unknown as Array<{ n: number }>;
    const subs = can(archetype, "documents.forms.manage")
      ? ((await tx.execute(sql`
          select count(*)::int as n from public.doc_form_submission
          where org_id = ${ctx.orgId} and status = 'received'
        `)) as unknown as Array<{ n: number }>)
      : [{ n: 0 }];
    return {
      overdue: obligations.filter((o) => o.dueState === "overdue"),
      dueSoon: obligations.filter((o) => o.dueState === "due_soon"),
      expiring: expiring.map((e) => ({
        id: e.id,
        reference: e.reference,
        title: e.title,
        expiresAt: e.expires_at,
        daysLeft: Number(e.days_left),
        hasSuccessor: Boolean(e.has_successor),
      })),
      mySteps,
      awaitingSignature: Number(sig[0]?.n ?? 0),
      pendingSubmissions: Number(subs[0]?.n ?? 0),
      soonDays,
    };
  });
}
