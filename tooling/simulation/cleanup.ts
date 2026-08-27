/**
 * Authorized teardown of simulation orgs. This is destructive, so it is defensive:
 * it operates ONLY on organizations that carry the exact demo marker, refuses any
 * org that does not, never performs a broad reset, and requires the caller to have
 * already checked the explicit confirmation flag. It is not exposed through the web
 * app — it runs only as a tooling script over the owner/superuser connection.
 */
import type postgres from "postgres";
import { DEMO_MARKER_KEY, isDemoMarker } from "./marker";

type Sql = ReturnType<typeof postgres>;

export type DemoOrg = { orgId: string; scenario: string };

/** Every org that carries a valid demo marker (is_demo:true). */
export async function discoverDemoOrgs(owner: Sql): Promise<DemoOrg[]> {
  const rows =
    (await owner`select org_id::text as org_id, value from public.app_settings where key = ${DEMO_MARKER_KEY}`) as unknown as Array<{
      org_id: string;
      value: unknown;
    }>;
  return rows
    .filter((r) => isDemoMarker(r.value))
    .map((r) => ({ orgId: r.org_id, scenario: (r.value as { scenario: string }).scenario }));
}

/** Verify EVERY requested org carries the demo marker; throw naming any that do not. */
export async function assertAllDemo(owner: Sql, orgIds: string[]): Promise<void> {
  const demo = new Set((await discoverDemoOrgs(owner)).map((d) => d.orgId));
  const foreign = orgIds.filter((id) => !demo.has(id));
  if (foreign.length) {
    throw new Error(
      `Refusing cleanup: these orgs are NOT marked simulation data: ${foreign.join(", ")}`,
    );
  }
}

export type CleanupSummary = { orgIds: string[]; deletedUsers: string[]; tables: number };

/**
 * Delete the exact demo orgs and their dedicated owner users. Marker-guarded.
 * Uses session_replication_role=replica (superuser) to delete regardless of FK
 * order, scoped strictly to the given org ids.
 */
export async function cleanupDemoOrgs(owner: Sql, orgIds: string[]): Promise<CleanupSummary> {
  if (orgIds.length === 0) return { orgIds: [], deletedUsers: [], tables: 0 };
  await assertAllDemo(owner, orgIds); // refuses any unmarked org

  // Owners dedicated to these demo orgs (deleted only if they end up member-less).
  const ownerRows = (await owner`
    select distinct user_id::text as user_id from public.membership
    where org_id = any(${orgIds}::uuid[]) and role_key = 'owner'`) as unknown as Array<{
    user_id: string;
  }>;
  const candidateUsers = ownerRows.map((r) => r.user_id);

  const tbls = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;

  const deletedUsers: string[] = [];
  await owner.begin(async (tx) => {
    // Public org-scoped rows: bypass FK ordering (replica) since we delete whole tenants.
    await tx.unsafe("set local session_replication_role = replica");
    for (const { table_name } of tbls) {
      await tx.unsafe(`delete from public.${table_name} where org_id = any($1::uuid[])`, [orgIds]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [orgIds]);
    // Restore normal FK/cascade behaviour BEFORE touching the auth schema, so
    // deleting an auth user cascades its identities/sessions (no orphans left
    // that would block re-creating the same email).
    await tx.unsafe("set local session_replication_role = default");
    for (const uid of candidateUsers) {
      const remain = (await tx.unsafe(
        `select 1 from public.membership where user_id = $1 limit 1`,
        [uid],
      )) as unknown as unknown[];
      if (remain.length === 0) {
        await tx.unsafe(`delete from public.user_profile where id = $1`, [uid]);
        await tx.unsafe(`delete from auth.users where id = $1`, [uid]);
        deletedUsers.push(uid);
      }
    }
  });
  return { orgIds, deletedUsers, tables: tbls.length };
}
