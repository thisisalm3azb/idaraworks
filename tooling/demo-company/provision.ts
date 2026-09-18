/**
 * Demo company importer — provisioning: the organisation, its logins and the
 * marker that authorises every later write.
 *
 * A brand-aware copy of the Pilot Lab's provisioning, which stays untouched.
 * The organisation is created through the product's own door
 * (`createOrgForUser` → `app.create_org_with_owner`: the org row, the seven
 * role definitions, plan state and the audit row all come from there), the
 * template is installed by the product, and the entitlement is the same
 * `internal_pilot` state the 006A simulation factory uses.
 *
 * One deliberate difference from the lab: the owner persona may be signed in
 * on an address the site owner controls (`ownerEmail`). That account gets the
 * persona's fictional name as its display name and is created exactly as the
 * other logins are — confirmed, with a random 24-byte password that is
 * discarded unread — so the owner sets their own password through the site's
 * normal "Forgot password" flow. No password is ever known, printed or
 * stored. Every other persona lives on the brand's reserved, undeliverable
 * domain.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config";
import type { Ctx } from "@/platform/tenancy";
import type { LabEnv } from "../pilot-lab/guard";
import type { Sql } from "../pilot-lab/db";
import { isMarkerOf, makeMarkerFor, personaEmailFor, type Brand } from "../pilot-lab/brand";
import type { Company, PersonaKey } from "../pilot-lab/types";

export function adminClient(env: LabEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Find-or-create a login. An existing address is reused as it is: nothing
 * about its credentials is touched — only its profile name and locale are
 * set. A new address is created confirmed, with a random password nobody
 * knows, and tagged with the brand's flag in its metadata.
 */
async function ensureUser(
  admin: SupabaseClient,
  sql: Sql,
  brand: Brand,
  email: string,
  fullName: string,
  locale: string,
): Promise<{ id: string; created: boolean }> {
  const existing = (await sql`
    select id::text as id from auth.users where lower(email) = lower(${email})
  `) as unknown as Array<{ id: string }>;
  let userId: string;
  let created = false;
  if (existing.length) {
    userId = existing[0]!.id;
  } else {
    const res = await admin.auth.admin.createUser({
      email,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
      user_metadata: { full_name: fullName, [brand.userMetaFlag]: true },
    });
    if (res.error || !res.data.user) throw res.error ?? new Error(`could not create ${email}`);
    userId = res.data.user.id;
    created = true;
  }
  await sql`
    insert into public.user_profile (id, full_name, locale) values (${userId}, ${fullName}, ${locale})
    on conflict (id) do update set full_name = excluded.full_name, locale = excluded.locale
  `;
  return { id: userId, created };
}

export type Provisioned = {
  orgId: string;
  users: Record<PersonaKey, string>;
  createdOrg: boolean;
  /** Logins this run created (as opposed to found), by persona. */
  createdUsers: PersonaKey[];
};

/** The organisation carrying this brand's marker for this company, if any. */
export async function findDemoOrg(
  sql: Sql,
  brand: Brand,
  companyKey: string,
): Promise<string | null> {
  const rows = (await sql`
    select org_id::text as org_id, value from public.app_settings where key = ${brand.markerKey}
  `) as unknown as Array<{ org_id: string; value: unknown }>;
  for (const r of rows) {
    if (
      isMarkerOf(brand, r.value) &&
      r.value.company_key === companyKey &&
      r.value.seed_version === brand.seedVersion
    )
      return r.org_id;
  }
  return null;
}

export type ProvisionOptions = {
  /** Sign the owner persona in on THIS address instead of the brand's reserved domain. */
  ownerEmail?: string;
};

export async function provisionCompany(
  env: LabEnv,
  sql: Sql,
  brand: Brand,
  company: Company,
  generatedAt: string,
  log: (m: string) => void,
  opts: ProvisionOptions = {},
): Promise<Provisioned> {
  const admin = adminClient(env);
  const createdUsers: PersonaKey[] = [];

  // 1) The owner login first: the organisation is created for them.
  const owner = company.personas.find((p) => p.key === "owner")!;
  const ownerEmail = opts.ownerEmail ?? personaEmailFor(brand, company.key, "owner");
  const o = await ensureUser(admin, sql, brand, ownerEmail, owner.fullName, owner.locale);
  if (o.created) createdUsers.push("owner");
  const ownerId = o.id;

  // 2) The organisation, found by marker or created through the product's own door.
  let orgId = await findDemoOrg(sql, brand, company.key);
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
    // The marker goes on before anything else can fail: from here on this
    // organisation is one the importer may write to and the cleanup may delete.
    await sql`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, ${brand.markerKey}, ${sql.json(makeMarkerFor(brand, company.key, generatedAt) as never)})
      on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
    `;
    log(`created organisation ${orgId}`);
  } else {
    log(`found organisation ${orgId}`);
  }

  // 3) The template, through the product, once.
  const ctx: Ctx = {
    orgId,
    userId: ownerId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: `${brand.idPrefix}-provision`,
  };
  const installed = (await sql`
    select value from public.app_settings where org_id = ${orgId} and key = 'config.template'
  `) as unknown as Array<{ value: unknown }>;
  if (!(installed.length && installed[0]!.value !== null)) {
    await installTemplate(ctx, company.templateKey);
    log(`installed template ${company.templateKey}`);
  }

  // 4) Entitlement: the internal pilot state the demo factory uses. No billing.
  await sql`
    update public.org_plan_state
    set billing_state = 'internal_pilot', plan_key = 'growth', trial_end = null, period_start = now(), updated_at = now()
    where org_id = ${orgId}
  `;

  // 5) The other eight personas, as members. Direct membership rows: no
  //    invite is created and no email is sent.
  const users = { owner: ownerId } as Record<PersonaKey, string>;
  for (const p of company.personas) {
    if (p.key === "owner") continue;
    const u = await ensureUser(
      admin,
      sql,
      brand,
      personaEmailFor(brand, company.key, p.key),
      p.fullName,
      p.locale,
    );
    if (u.created) createdUsers.push(p.key);
    users[p.key] = u.id;
    await sql`
      insert into public.membership (user_id, org_id, role_key, created_at)
      values (${u.id}, ${orgId}, ${p.roleKey}, ${company.history.from}::timestamptz + interval '30 days')
      on conflict (user_id, org_id) do nothing
    `;
  }
  await sql`
    update public.membership set created_at = ${company.history.from}::timestamptz
    where org_id = ${orgId} and user_id = ${ownerId}
  `;
  return { orgId, users, createdOrg, createdUsers };
}
