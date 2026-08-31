import postgres from "postgres";

/** Owner connection (DIRECT_URL) — integration-test seeding/inspection only. */
export function ownerSql() {
  const direct = process.env.DIRECT_URL;
  if (!direct) throw new Error("DIRECT_URL missing — integration tests need .env.local / CI env.");
  return postgres(direct, { max: 1, connect_timeout: 60, onnotice: () => {} });
}

export function requireIntegrationEnv(): void {
  for (const key of ["DIRECT_URL", "DATABASE_URL", "APP_DB_PASSWORD"] as const) {
    if (!process.env[key]) {
      throw new Error(
        `${key} is not set. Integration tests create and delete organizations in a real ` +
          `database, so they never read .env.local (that is production). Run \`supabase start\` ` +
          `and copy .env.test.example to .env.test.local, or point it at a throwaway project. ` +
          `See docs/TEST-ENVIRONMENTS.md.`,
      );
    }
  }
}

/**
 * H21.1: the app_settings key every integration fixture org stamps itself with.
 *
 * public.org has no metadata column, so the marker lives in app_settings — the
 * same vehicle the simulation factory uses (tooling/simulation/marker.ts). It is
 * what lets a residue sweep identify disposable data by EVIDENCE rather than by
 * guessing from a name: names are not unique and nothing stops a real tenant
 * from being called "S9 Org".
 */
export const TEST_FIXTURE_KEY = "test.fixture";

export type TestFixtureMarker = {
  is_test_fixture: true;
  /** Which suite created it, e.g. "s9-subscription". */
  suite: string;
  /** The per-run id embedded in that run's seeded emails. */
  run: string;
  created_at: string;
};

/**
 * Stamp an org as a disposable test fixture. Call it immediately after
 * createOrgForUser, inside beforeAll — before anything can fail — so even a
 * half-built fixture is identifiable afterwards.
 */
export async function markFixtureOrg(
  owner: ReturnType<typeof ownerSql>,
  orgId: string,
  suite: string,
  run: string,
): Promise<void> {
  if (!orgId) return;
  const marker: TestFixtureMarker = {
    is_test_fixture: true,
    suite,
    run,
    created_at: new Date().toISOString(),
  };
  await owner`
    insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${TEST_FIXTURE_KEY}, ${owner.json(marker as never)})
    on conflict (org_id, key) do update set value = excluded.value`;
}

/**
 * S10 test hygiene: order-independent teardown of a test's synthetic org(s) + their users, so a
 * file leaves NO residue (leaked orgs, leftover domain_event rows that feed the outbox-relay
 * backlog). Uses session_replication_role=replica (owner/superuser DIRECT_URL) to disable FK
 * triggers, then deletes every org_id-bearing row for the given orgs regardless of FK topology —
 * the same mechanism the production s7-cleanup uses. `owner` is an ownerSql() handle.
 *
 * H21.1: FK enforcement is restored BEFORE the auth deletes, so removing an auth
 * user cascades its identities and sessions. Deleting auth.users while still in
 * replica mode left orphan rows behind that then blocked re-creating the same
 * email — the simulation cleanup already ordered it this way for that reason.
 */
export async function wipeOrgs(
  owner: ReturnType<typeof ownerSql>,
  orgIds: string[],
  userIds: string[] = [],
): Promise<void> {
  const ids = orgIds.filter(Boolean);
  const users = userIds.filter(Boolean);
  if (ids.length === 0 && users.length === 0) return;
  const tbls = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    if (ids.length > 0) {
      await tx.unsafe("set local session_replication_role = replica");
      for (const t of tbls) {
        await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
      }
      await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
      await tx.unsafe("set local session_replication_role = default");
    }
    if (users.length) {
      await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [users]);
      await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [users]);
    }
  });
}
