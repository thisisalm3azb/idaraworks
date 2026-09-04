/**
 * H31 bleed seeders — one row per new tenant table, so the two-organisation
 * sweep proves their isolation alongside the rest of the schema.
 *
 * H30's lesson, applied without being taught it twice: a new org-scoped table
 * that registers no seeder ships with nothing proving it cannot leak, and the
 * bleed harness fails the build rather than letting that happen quietly.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

type Seeder = (o: Sql, org: string, userId: string) => Promise<void>;

export const H31_SEEDERS: Record<string, Seeder> = {
  org_app_brand: async (o, org) => {
    await o`
      insert into public.org_app_brand (org_id, app_name, brand_color)
      values (${org}, 'Bleed App', '#123456')
      on conflict (org_id) do nothing`;
  },
  tenant_host: async (o, org, u) => {
    // A globally unique host per row: the platform-wide unique index is the
    // point of this table, so a seeder that reused a name would fail for the
    // right reason and teach the wrong lesson.
    await o`
      insert into public.tenant_host (org_id, host, kind, status, created_by)
      values (${org}, ${`bleed-${randomUUID().slice(0, 12)}.idaraworks.com`},
              'subdomain', 'pending', ${u})`;
  },
};
