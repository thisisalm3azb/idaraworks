/**
 * H33 Pilot Lab — provisioning: the organisation, its nine personas, its
 * template, its entitlement, its marker.
 *
 * Find-or-create throughout, keyed on the marker, so a second run reuses the
 * same organisation and the same logins. Users are created through the
 * Supabase Admin API (email-confirmed, no mail sent) with a random password
 * that is never stored anywhere — the launcher signs in with one-time links.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config";
import type { Ctx } from "@/platform/tenancy";
import type { LabEnv } from "./guard";
import type { Sql } from "./db";
import { MARKER_KEY, SEED_VERSION, isLabMarker, makeMarker } from "./marker";
import { personaEmail } from "./companies";
import type { Company, PersonaKey } from "./types";

export function adminClient(env: LabEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Find the auth user for a persona, or create it. Returns the user id. */
async function ensureUser(
  admin: SupabaseClient,
  sql: Sql,
  email: string,
  fullName: string,
  locale: string,
): Promise<string> {
  const existing =
    (await sql`select id::text as id from auth.users where email = ${email}`) as unknown as Array<{
      id: string;
    }>;
  let userId: string;
  if (existing.length) {
    userId = existing[0]!.id;
  } else {
    // 24 random bytes → nobody knows this password, including us. Sign-in is
    // through admin-minted one-time links only.
    const password = randomBytes(24).toString("base64url");
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, h33_pilot_lab: true },
    });
    if (created.error || !created.data.user)
      throw created.error ?? new Error(`could not create ${email}`);
    userId = created.data.user.id;
  }
  await sql`
    insert into public.user_profile (id, full_name, locale) values (${userId}, ${fullName}, ${locale})
    on conflict (id) do update set full_name = excluded.full_name, locale = excluded.locale
  `;
  return userId;
}

export type Provisioned = {
  orgId: string;
  users: Record<PersonaKey, string>;
  createdOrg: boolean;
};

/** The marked organisation for a company, if it already exists. */
export async function findLabOrg(sql: Sql, companyKey: string): Promise<string | null> {
  const rows = (await sql`
    select org_id::text as org_id, value from public.app_settings where key = ${MARKER_KEY}
  `) as unknown as Array<{ org_id: string; value: unknown }>;
  for (const r of rows) {
    if (
      isLabMarker(r.value) &&
      r.value.company_key === companyKey &&
      r.value.seed_version === SEED_VERSION
    )
      return r.org_id;
  }
  return null;
}

export async function provisionCompany(
  env: LabEnv,
  sql: Sql,
  company: Company,
  generatedAt: string,
  log: (m: string) => void,
): Promise<Provisioned> {
  const admin = adminClient(env);

  // 1) The owner login first: the organisation is created for them.
  const owner = company.personas.find((p) => p.key === "owner")!;
  const ownerId = await ensureUser(
    admin,
    sql,
    personaEmail(company.key, "owner"),
    owner.fullName,
    owner.locale,
  );

  // 2) The organisation, found by marker or created through the product's own
  //    door (roles, company row, plan state, audit row all come from there).
  let orgId = await findLabOrg(sql, company.key);
  let createdOrg = false;
  if (!orgId) {
    orgId = await createOrgForUser(ownerId, {
      name: company.nameEn,
      country: company.country,
      baseCurrency: company.currency,
      timezone: company.timezone,
      languages: company.languages,
      sixDayWeek: company.sixDayWeek,
    });
    createdOrg = true;
    // The marker goes on IMMEDIATELY, before anything else can fail, so a
    // half-provisioned organisation is still identifiable and cleanable.
    await sql`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${MARKER_KEY}, ${sql.json(makeMarker(company.key, generatedAt) as never)})
      on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
    `;
    log(`created organisation ${orgId}`);
  } else {
    log(`found organisation ${orgId}`);
  }

  const ctx: Ctx = {
    orgId,
    userId: ownerId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "h33-provision",
  };

  // 3) Industry template, once.
  const installed = (await sql`
    select value from public.app_settings where org_id = ${orgId} and key = 'config.template'
  `) as unknown as Array<{ value: unknown }>;
  if (!(installed.length && installed[0]!.value !== null)) {
    await installTemplate(ctx, company.templateKey);
    log(`installed template ${company.templateKey}`);
  }

  // 4) Legitimate entitlement — the same state the demo factory uses.
  await sql`
    update public.org_plan_state
    set billing_state = 'internal_pilot', plan_key = 'growth', trial_end = null, period_start = now(), updated_at = now()
    where org_id = ${orgId}
  `;

  // 5) The other eight personas, as members with their role.
  const users = { owner: ownerId } as Record<PersonaKey, string>;
  for (const p of company.personas) {
    if (p.key === "owner") continue;
    const uid = await ensureUser(
      admin,
      sql,
      personaEmail(company.key, p.key),
      p.fullName,
      p.locale,
    );
    users[p.key] = uid;
    await sql`
      insert into public.membership (user_id, org_id, role_key, created_at)
      values (${uid}, ${orgId}, ${p.roleKey}, ${company.history.from}::timestamptz + interval '30 days')
      on conflict (user_id, org_id) do nothing
    `;
  }
  // The owner has been here since the beginning too.
  await sql`update public.membership set created_at = ${company.history.from}::timestamptz where org_id = ${orgId} and user_id = ${ownerId}`;

  return { orgId, users, createdOrg };
}
