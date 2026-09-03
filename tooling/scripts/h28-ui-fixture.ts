/**
 * H28 — a TEST-project fixture the UI walk can drive: one organisation with a
 * person, a customer with history, a deal, work, an AI policy with a real
 * allowance, a deterministic price book and a schedule. Also seeds a large
 * usage history (1,200 rows) so the settings surface must page in the
 * database and its totals must come from the full result.
 *
 *   npx tsx tooling/scripts/h28-ui-fixture.ts          (create, prints the ids)
 *   npx tsx tooling/scripts/h28-ui-fixture.ts --wipe   (remove it)
 *
 * Refuses the production project outright.
 */
import { config } from "dotenv";
config({ path: [".env.test.local", ".env.test"], quiet: true });
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createCustomer } from "@/modules/masters/service";
import { createOpportunity, logActivity } from "@/modules/crm/service";

const MARKER = "fixture.h28_ui";
const PRODUCTION = "anhgeeutrwftsvuzfinf";

async function main(): Promise<void> {
  if ((process.env.DIRECT_URL ?? "").includes(PRODUCTION)) {
    console.error("REFUSING: that is the production project.");
    process.exitCode = 1;
    return;
  }
  const owner = postgres(process.env.DIRECT_URL!, { max: 2, prepare: false });
  try {
    if (process.argv.includes("--wipe")) {
      const orgs = (
        await owner`select org_id::text as id from public.app_settings where key = ${MARKER}`
      ).map((r) => String(r.id));
      const users = (
        await owner`select id::text as id from auth.users where email like 'h28-ui-%@example.invalid'`
      ).map((r) => String(r.id));
      const tables = (
        await owner`
        select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' group by table_name`
      ).map((r) => String(r.table_name));
      for (const org of orgs) {
        await owner.begin(async (tx) => {
          await tx.unsafe("set local session_replication_role = replica");
          for (const t of tables)
            await tx.unsafe(`delete from public.${t} where org_id = $1`, [org]);
          await tx.unsafe(`delete from public.org where id = $1`, [org]);
        });
      }
      for (const u of users) {
        await owner`delete from public.user_profile where id = ${u}`;
        await owner`delete from auth.identities where user_id = ${u}`;
        await owner`delete from auth.sessions where user_id = ${u}`;
        await owner`delete from auth.users where id = ${u}`;
      }
      await owner`delete from public.ai_price_book where note like 'h28 ui fixture%'`;
      console.log(`removed ${orgs.length} fixture org(s), ${users.length} user(s)`);
      return;
    }

    const run = randomUUID().slice(0, 8);
    const userId = randomUUID();
    const email = `h28-ui-${run}@example.invalid`;
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
      values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(),
              ${JSON.stringify({ full_name: "Idara walk" })}::jsonb, now(), now())`;
    const orgId = await createOrgForUser(userId, {
      name: `H28 Walk ${run}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, ${MARKER}, ${JSON.stringify({ run })}::jsonb)`;
    const ctx: Ctx = {
      orgId,
      userId,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `h28-ui-${run}`,
    };
    await installTemplate(ctx, TEMPLATE_BOATBUILDING.key);

    const customer = await createCustomer(ctx, "owner", { name: `Gulf Marine ${run}` });
    await logActivity(ctx, "owner", {
      customerId: customer.id,
      kind: "note",
      title: "Site visit",
      body: "Discussed the refit schedule and the payment terms.",
    });
    await logActivity(ctx, "owner", {
      customerId: customer.id,
      kind: "follow_up",
      title: "Send the revised quote",
      dueDate: new Date().toISOString().slice(0, 10),
    });
    const deal = await createOpportunity(ctx, "owner", {
      name: `Refit programme ${run}`,
      customerId: customer.id,
      estimatedValueMinor: 45_000_00,
    });

    // A real allowance and a deterministic tariff so the dock can answer.
    await owner`insert into public.ai_entitlement (org_id, version, mode, monthly_credits, reason, set_by)
      values (${orgId}, 1, 'trial', 5000, 'h28 ui fixture', ${userId})`;
    await owner`insert into public.ai_price_book (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros, note)
      values ('deterministic', 'deterministic:fast', '2020-01-01T00:00:00Z', 'USD', 50000, 400000, 'h28 ui fixture tariff'),
             ('deterministic', 'deterministic:strong', '2020-01-01T00:00:00Z', 'USD', 3000000, 15000000, 'h28 ui fixture tariff')
      on conflict (model_key, effective_from) do nothing`;
    await owner`insert into public.ai_schedule (org_id, kind, agent_id, cadence, hour_local, recipients, enabled, created_by)
      values (${orgId}, 'management_briefing', 'executive', 'daily', 8, '["owner","admin"]'::jsonb, false, ${userId})`;

    // Usage history past the driver's 1,000-row cap.
    await owner`
      insert into public.ai_interaction (org_id, feature, provider, model, input_tokens, output_tokens, credits, status, created_by, agent_id, budget_decision, created_at)
      select ${orgId}, 'agent_run', 'deterministic', 'deterministic:fast', 120, 40, 1, 'ok', ${userId},
             (array['idara','executive','sales_crm','finance'])[1 + (g % 4)], 'allow', now() - (g || ' minutes')::interval
      from generate_series(1, 1200) g`;

    console.log(`org      ${orgId}`);
    console.log(`email    ${email}`);
    console.log(`customer ${customer.id}`);
    console.log(`deal     ${deal.id}`);
    console.log(
      `walk:    npx tsx tooling/scripts/h28-ui-shots.ts ${email} ${orgId} ${customer.id}`,
    );
  } finally {
    await owner.end();
    await closeAppDb();
  }
}

await main();
