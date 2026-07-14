import postgres from "postgres";

/** Owner connection (DIRECT_URL) — integration-test seeding/inspection only. */
export function ownerSql() {
  const direct = process.env.DIRECT_URL;
  if (!direct) throw new Error("DIRECT_URL missing — integration tests need .env.local / CI env.");
  return postgres(direct, { max: 1, onnotice: () => {} });
}

export function requireIntegrationEnv(): void {
  for (const key of ["DIRECT_URL", "DATABASE_URL", "APP_DB_PASSWORD"] as const) {
    if (!process.env[key]) {
      throw new Error(
        `${key} is not set. Integration tests run against a real database — fill .env.local (hosted) or use the CI local stack.`,
      );
    }
  }
}

/**
 * S10 test hygiene: order-independent teardown of a test's synthetic org(s) + their users, so a
 * file leaves NO residue (leaked orgs, leftover domain_event rows that feed the outbox-relay
 * backlog). Uses session_replication_role=replica (owner/superuser DIRECT_URL) to disable FK
 * triggers, then deletes every org_id-bearing row for the given orgs regardless of FK topology —
 * the same mechanism the production s7-cleanup uses. `owner` is an ownerSql() handle.
 */
export async function wipeOrgs(
  owner: ReturnType<typeof ownerSql>,
  orgIds: string[],
  userIds: string[] = [],
): Promise<void> {
  const ids = orgIds.filter(Boolean);
  if (ids.length === 0) return;
  const tbls = (await owner`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'`) as unknown as Array<{
    table_name: string;
  }>;
  await owner.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
    for (const t of tbls) {
      await tx.unsafe(`delete from public.${t.table_name} where org_id = any($1::uuid[])`, [ids]);
    }
    await tx.unsafe(`delete from public.org where id = any($1::uuid[])`, [ids]);
    const users = userIds.filter(Boolean);
    if (users.length) {
      await tx.unsafe(`delete from public.user_profile where id = any($1::uuid[])`, [users]);
      await tx.unsafe(`delete from auth.users where id = any($1::uuid[])`, [users]);
    }
    await tx.unsafe("set local session_replication_role = default");
  });
}
