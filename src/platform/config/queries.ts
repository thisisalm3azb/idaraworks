/**
 * Config read surface for pages (Bible §3.2: pages consume services/platform
 * surfaces, never raw SQL — review minor made structural).
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

export type InstalledTemplate = { key: string; version: number } | null;

export async function getInstalledTemplate(ctx: Ctx): Promise<InstalledTemplate> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.template'
    `),
  )) as unknown as Array<{ value: { key: string; version: number } | null }>;
  return rows[0]?.value ?? null;
}

export type ConfigRevisionRow = {
  id: string;
  artifactKey: string;
  summary: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

/** Latest revisions (owner/admin — config_revision RLS gates reads). */
export async function listConfigRevisions(ctx: Ctx, limit = 20): Promise<ConfigRevisionRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, artifact_key, summary, before_data, after_data,
             created_at::text as created_at
      from public.config_revision
      where org_id = ${ctx.orgId}
      order by created_at desc
      limit ${Math.min(Math.max(limit, 1), 100)}
    `),
  )) as unknown as Array<{
    id: string;
    artifact_key: string;
    summary: string | null;
    before_data: unknown;
    after_data: unknown;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    artifactKey: r.artifact_key,
    summary: r.summary,
    before: r.before_data,
    after: r.after_data,
    createdAt: r.created_at,
  }));
}

/** Current org terminology override blob (the editor reads it for prefill). */
export async function getTerminologyOverrides(ctx: Ctx): Promise<Record<string, unknown>> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'terminology.overrides'
    `),
  )) as unknown as Array<{ value: Record<string, unknown> | null }>;
  return rows[0]?.value ?? {};
}
