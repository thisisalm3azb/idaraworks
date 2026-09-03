/**
 * H29 — a TEST-project fixture the UI walk can drive: one organisation with two
 * establishments in DIFFERENT countries, one of them with an adopted pack
 * version, a registration, an electronic-invoicing channel with no credential,
 * and enough adoption history that the list must page.
 *
 *   npx tsx tooling/scripts/h29-ui-fixture.ts          (create, prints the ids)
 *   npx tsx tooling/scripts/h29-ui-fixture.ts --wipe   (remove it)
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
import { AE_PACK, SA_PACK } from "@/platform/country";
import { adoptPack, createEstablishment, setRegistration } from "@/modules/country/service";
import { createChannel } from "@/modules/einvoicing/service";

const MARKER = "fixture.h29_ui";
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
        await owner`select id::text as id from auth.users where email like 'h29-ui-%@example.invalid'`
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
      console.log(`removed ${orgs.length} fixture org(s), ${users.length} user(s)`);
      return;
    }

    const run = randomUUID().slice(0, 8);
    const email = `h29-ui-${run}@example.invalid`;
    // Through the auth admin API, not a raw insert: GoTrue fills columns of its
    // own that a hand-written row leaves null, and a null one makes every later
    // sign-in link fail with a 500.
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const created = await admin.auth.admin.createUser({
      email,
      password: `Fixture-H29-${run}!`,
      email_confirm: true,
      user_metadata: { full_name: "Country walk" },
    });
    if (created.error || !created.data.user)
      throw new Error(`createUser: ${created.error?.message ?? "no user returned"}`);
    const userId = created.data.user.id;
    await owner`
      insert into public.user_profile (id, full_name, locale) values (${userId}, 'Country walk', 'en')
      on conflict (id) do update set full_name = excluded.full_name`;
    const orgId = await createOrgForUser(userId, {
      name: `H29 Walk ${run}`,
      country: "AE",
      baseCurrency: "AED",
    });
    await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, ${MARKER}, ${JSON.stringify({ run })}::jsonb)`;
    const ctx: Ctx = {
      orgId,
      userId,
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `h29-ui-${run}`,
    };
    await installTemplate(ctx, TEMPLATE_BOATBUILDING.key);

    // Two establishments in different countries, so the walk sees two address
    // shapes, two currencies, two working weeks and two sets of identifiers.
    const dubai = await createEstablishment(ctx, "owner", {
      code: "DXB",
      legalName: `Gulf Marine Works ${run}`,
      legalNameLocal: "أعمال الخليج البحرية",
      country: "AE",
      timezone: "Asia/Dubai",
      baseCurrency: "AED",
      isPrimary: true,
      address: { line1: "Warehouse 7", area: "Al Quoz", city: "Dubai", emirate: "Dubai" },
    });
    const riyadh = await createEstablishment(ctx, "owner", {
      code: "RUH",
      legalName: `Gulf Marine Arabia ${run}`,
      legalNameLocal: "الخليج البحرية العربية",
      country: "SA",
      timezone: "Asia/Riyadh",
      baseCurrency: "SAR",
      address: {
        buildingNumber: "8228",
        street: "King Fahd",
        district: "Olaya",
        city: "Riyadh",
        postalCode: "12345",
      },
    });

    // Adoption history: several dated adoptions so the paged list has pages,
    // and so the "read as at" control has different answers to give.
    await adoptPack(ctx, "owner", {
      establishmentId: dubai.id,
      packKey: AE_PACK.packKey,
      effectiveFrom: AE_PACK.effectiveFrom,
      note: "First adoption, from the version's own start date.",
    });
    await adoptPack(ctx, "owner", {
      establishmentId: dubai.id,
      packKey: AE_PACK.packKey,
      effectiveFrom: "2026-11-01",
      note: "Re-adopted from the start of November after the branch move.",
    });
    await adoptPack(ctx, "owner", {
      establishmentId: riyadh.id,
      packKey: SA_PACK.packKey,
      effectiveFrom: SA_PACK.effectiveFrom,
      note: "Saudi pack adopted for the Riyadh branch.",
    });

    await setRegistration(ctx, "owner", {
      establishmentId: dubai.id,
      identifierKey: "trn",
      value: "100000000000003",
      issuedOn: "2026-01-15",
    });
    await setRegistration(ctx, "owner", {
      establishmentId: riyadh.id,
      identifierKey: "vat_number",
      value: "300000000000003",
      issuedOn: "2026-02-01",
    });

    // A channel with no credential, so the readiness centre and the channel
    // surface both show the fail-closed state a walk needs to see.
    const channel = await createChannel(ctx, "owner", {
      establishmentId: riyadh.id,
      adapterKey: "zatca",
      environment: "sandbox",
    });

    console.log(`org      ${orgId}`);
    console.log(`email    ${email}`);
    console.log(`dubai    ${dubai.id}`);
    console.log(`riyadh   ${riyadh.id}`);
    console.log(`channel  ${channel.id}`);
    console.log(`login:   npx tsx tooling/scripts/h25-ui-login-link.ts ${email}`);
    console.log(`walk:    npx tsx tooling/scripts/h29-ui-shots.ts ${email} ${orgId} ${riyadh.id}`);
  } finally {
    await owner.end();
    await closeAppDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
