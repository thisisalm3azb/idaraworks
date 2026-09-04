/**
 * H31 — what an operator needs to answer "why is this company's app not
 * working" without opening a database client.
 *
 * ── The privacy line ────────────────────────────────────────────────────────
 * This reads across every organisation, so it is deliberately confined to
 * READINESS: does a name exist, is a colour valid, is a host verified. It
 * returns no customer record, no member, no count of anything a company owns,
 * and no logo. An operator can tell that a company's icon will be generated
 * rather than uploaded; they cannot see the company's data.
 *
 * The caller is checked by the page. This module refuses to be useful without
 * one: it takes the operator's user id and passes it to the same
 * `assert_platform_operator` path the rest of the platform surfaces use.
 */
import { sql, withUserCtx } from "@/platform/tenancy";
import { decideBackgroundColor, decideBrandColor } from "@/platform/tenanthost/contrast";

export type OperatorAppRow = {
  orgId: string;
  orgName: string;
  /** The name the installed app would carry. */
  appName: string;
  /** Message keys naming anything that would embarrass the customer. */
  warnings: string[];
  hostCount: number;
  activeHost: string | null;
  pendingHost: string | null;
  failedHost: string | null;
  failedReason: string | null;
  lastVerifiedAt: string | null;
  /** True when a manifest would render with a complete, valid identity. */
  manifestReady: boolean;
};

export async function operatorAppReadiness(
  operatorUserId: string,
  limit = 200,
): Promise<OperatorAppRow[]> {
  const rows = await withUserCtx(operatorUserId, async (tx) => {
    // The assertion runs first and throws for anybody who is not an operator,
    // so a missing page-level check cannot turn this into a data leak.
    await tx.execute(sql`select app.assert_platform_operator()`);
    return (await tx.execute(sql`
      select
        o.id::text as org_id,
        o.name as org_name,
        b.app_name,
        b.brand_color,
        b.background_color,
        b.icon_file_id is not null as has_icon,
        ob.display_name,
        ob.accent_color,
        (select count(*)::int from public.tenant_host th
          where th.org_id = o.id and th.status <> 'released') as host_count,
        (select th.host from public.tenant_host th
          where th.org_id = o.id and th.status = 'active' limit 1) as active_host,
        (select th.host from public.tenant_host th
          where th.org_id = o.id and th.status = 'pending' limit 1) as pending_host,
        (select th.host from public.tenant_host th
          where th.org_id = o.id and th.status = 'failed' limit 1) as failed_host,
        (select th.failed_reason from public.tenant_host th
          where th.org_id = o.id and th.status = 'failed' limit 1) as failed_reason,
        (select to_char(max(th.verified_at), 'YYYY-MM-DD HH24:MI') from public.tenant_host th
          where th.org_id = o.id) as last_verified_at
      from public.org o
      left join public.org_app_brand b on b.org_id = o.id
      left join public.org_branding ob on ob.org_id = o.id
      order by o.created_at
      limit ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
  });

  return rows.map((r) => {
    const orgName = (r.org_name as string) ?? "";
    const appName =
      ((r.app_name as string | null)?.trim() ||
        (r.display_name as string | null)?.trim() ||
        orgName) ??
      "";
    const brand = decideBrandColor(
      (r.brand_color as string | null) ?? (r.accent_color as string | null),
    );
    const background = decideBackgroundColor((r.background_color as string | null) ?? null);

    const warnings: string[] = [];
    if (brand.warningKey) warnings.push(brand.warningKey);
    if (background.warningKey) warnings.push(background.warningKey);
    if (r.has_icon !== true) warnings.push("app.brand.icon_generated");

    return {
      orgId: r.org_id as string,
      orgName,
      appName,
      warnings,
      hostCount: (r.host_count as number) ?? 0,
      activeHost: (r.active_host as string | null) ?? null,
      pendingHost: (r.pending_host as string | null) ?? null,
      failedHost: (r.failed_host as string | null) ?? null,
      failedReason: (r.failed_reason as string | null) ?? null,
      lastVerifiedAt: (r.last_verified_at as string | null) ?? null,
      /*
       * A manifest renders for every organisation — that is the fallback rule.
       * "Ready" here means it renders with a real name and valid colours, which
       * is the question an operator is actually asking.
       */
      manifestReady: appName.trim().length > 0 && brand.value.startsWith("#"),
    };
  });
}
