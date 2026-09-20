/**
 * Where a person's dashboard layout lives, and the priorities the company
 * stated during onboarding. Read and written through the tenant connection,
 * so the (org AND user) policy on the table is what decides whose row this
 * is; no call site here takes a user id.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { PRIORITY_AREAS, parseLayout, type DashboardLayout, type PriorityArea } from "./board";

const PRIORITY_SETTING_KEY = "onboarding.priorities";

export async function loadDashboardPref(ctx: Ctx): Promise<DashboardLayout | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select layout from public.user_dashboard_pref
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId}
    `),
  )) as unknown as Array<{ layout: unknown }>;
  const raw = rows[0]?.layout ?? null;
  return raw === null ? null : parseLayout(raw);
}

/**
 * Not wrapped in `command()`: the audit log is the organisation's record of
 * who changed the business. "Moved Approvals above Receivables" is not that,
 * and `updated_at` already answers when. RLS keeps it the caller's own row.
 */
export async function saveDashboardPref(ctx: Ctx, layout: DashboardLayout): Promise<void> {
  await withCtx(ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.user_dashboard_pref (org_id, user_id, layout)
      values (${ctx.orgId}, ${ctx.userId}, ${JSON.stringify(layout)}::jsonb)
      on conflict (org_id, user_id) do update set
        layout = excluded.layout,
        updated_at = now()
    `);
  });
}

/** Back to the role default: the row stays, its layout becomes null. */
export async function resetDashboardPref(ctx: Ctx): Promise<void> {
  await withCtx(ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.user_dashboard_pref (org_id, user_id, layout)
      values (${ctx.orgId}, ${ctx.userId}, null)
      on conflict (org_id, user_id) do update set
        layout = null,
        updated_at = now()
    `);
  });
}

/** The priorities recorded at onboarding, or none. Only known areas count. */
export async function loadPriorities(ctx: Ctx): Promise<PriorityArea[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = ${PRIORITY_SETTING_KEY}
    `),
  )) as unknown as Array<{ value: { areas?: unknown } | null }>;
  const areas = rows[0]?.value?.areas;
  if (!Array.isArray(areas)) return [];
  return areas.filter((a): a is PriorityArea =>
    (PRIORITY_AREAS as readonly string[]).includes(String(a)),
  );
}
