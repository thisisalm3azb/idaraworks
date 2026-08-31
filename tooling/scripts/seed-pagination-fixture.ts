/**
 * A fixture for verifying My Work pagination in the browser, in the TEST project
 * only. Creates one marked organization with enough assigned steps to page
 * through, and prints the login it created.
 *
 * Deliberately test-only: it refuses to run anywhere but `idaraworks-test`.
 *
 *   npx tsx tooling/scripts/seed-pagination-fixture.ts
 */
import { config } from "dotenv";

config({ path: [".env.test.local", ".env.test"], quiet: true });

import postgres from "postgres";
import { assertNotProduction, targetsOnlyTestProject } from "../../tests/integration/guard-env";

const STEPS = 130;

async function main() {
  assertNotProduction();
  const target = targetsOnlyTestProject();
  if (!target.ok) {
    console.error("Refusing to seed — not pointed only at the test project:");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const stamp = Math.random().toString(36).slice(2, 8);
  const email = `pagination-${stamp}@example.com`;
  const password = `Verify-${stamp}-Aa1!`;

  // Create the login through the auth API, not by hand: a hand-inserted
  // auth.users row is missing its identity and cannot sign in.
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Pagination Verifier" },
    }),
  });
  if (!res.ok) {
    console.error(`admin createUser failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const userId = (await res.json()).id as string;

  // The application modules are imported late so the test environment is set.
  const { createOrgForUser } = await import("@/platform/auth/identity");
  const { installTemplate } = await import("@/platform/config/install");
  const { createJobFromPreset, listActivePresets } = await import("@/modules/jobs/service");
  const { createEmployee } = await import("@/modules/masters/service");

  const orgId = await createOrgForUser(userId, {
    name: "Pagination Fixture",
    country: "AE",
    baseCurrency: "AED",
  });

  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    await sql`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, 'test.fixture',
              ${sql.json({ is_test_fixture: true, suite: "pagination-fixture", run: stamp, created_at: new Date().toISOString() } as never)})
      on conflict (org_id, key) do update set value = excluded.value`;

    const ctx = {
      orgId,
      userId,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: "pagination-fixture",
    };
    await installTemplate(ctx, "generic_operations_v1");
    const preset = (await listActivePresets(ctx, "owner"))[0]!;
    const job = await createJobFromPreset(ctx, "owner", {
      presetId: preset.id,
      name: "Paging fixture",
    });
    const emp = await createEmployee(ctx, "owner", { name: "Verifier", userId });

    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await sql`
      insert into public.task (id, org_id, job_id, title, status, due_date,
                               assignee_employee_id, created_by, archived)
      select gen_random_uuid(), ${orgId}, ${job.id}, 'Paged step ' || g, 'pending',
             ${past}::date, ${emp.id}, ${userId}, false
      from generate_series(1, ${STEPS}) g`;

    console.log(JSON.stringify({ orgId, userId, email, password, steps: STEPS }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
