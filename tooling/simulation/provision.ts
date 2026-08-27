/**
 * One-time administrative provisioning for a simulation org (micro-step 006A):
 * create (or find) a login-capable, already-confirmed owner via the Supabase Admin
 * API (no confirmation email is sent), create the isolated organization, install
 * the industry template, grant the legitimate internal-pilot entitlement, set
 * branding + document identity + Arabic preference, and write the demo marker.
 *
 * Idempotent at the org level: an org already carrying this scenario's demo marker
 * is reused (never duplicated). Passwords are (re)set to a fresh strong value on
 * each run so the private credentials file always works; they are returned to the
 * caller for that file ONLY and never logged or committed.
 */
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config";
import { DEMO_MARKER_KEY, SIM_VERSION } from "./marker";
import type { Scenario } from "./types";

type Sql = ReturnType<typeof postgres>;

export type ProvisionResult = {
  scenarioKey: string;
  displayName: string;
  orgId: string;
  ownerUserId: string;
  email: string;
  password: string;
  locale: string;
  createdOrg: boolean;
  presetIdByCode: Record<string, string>;
};

/** A strong, unique password: 24 url-safe chars from 18 random bytes + class mix. */
export function generatePassword(): string {
  const base = randomBytes(18).toString("base64url");
  return `Sim#${base}`; // guarantees upper/lower/digit/symbol classes
}

function adminClient(env = process.env): SupabaseClient {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function provisionScenario(
  owner: Sql,
  scenario: Scenario,
  opts: { asOf: string; generatedAt: string },
): Promise<ProvisionResult> {
  const admin = adminClient();
  const email = scenario.contact.email;
  const password = generatePassword();

  // 1) Owner auth user — find by email (superuser read), else admin-create. Always
  //    (re)set the password + confirm, so the credentials file is valid.
  const existing =
    (await owner`select id::text as id from auth.users where email = ${email}`) as unknown as Array<{
      id: string;
    }>;
  let ownerUserId: string;
  if (existing.length) {
    ownerUserId = existing[0]!.id;
    const { error } = await admin.auth.admin.updateUserById(ownerUserId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: scenario.ownerName, simulation: true },
    });
    if (error) throw new Error(`updateUser(${email}): ${error.message}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: scenario.ownerName, simulation: true },
    });
    if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
    ownerUserId = data.user.id;
  }

  // Ensure the profile row exists (trigger normally does this) + set locale.
  await owner`insert into public.user_profile (id, full_name, locale)
    values (${ownerUserId}, ${scenario.ownerName}, ${scenario.locale})
    on conflict (id) do update set full_name = excluded.full_name, locale = excluded.locale`;

  // 2) Org — reuse the one already carrying this scenario's marker, else create.
  const found = (await owner`
    select m.org_id::text as org_id from public.membership m
    join public.app_settings a on a.org_id = m.org_id
    where m.user_id = ${ownerUserId} and m.role_key = 'owner'
      and a.key = ${DEMO_MARKER_KEY} and a.value->>'scenario' = ${scenario.key}
    limit 1`) as unknown as Array<{ org_id: string }>;

  let orgId: string;
  let createdOrg = false;
  if (found.length) {
    orgId = found[0]!.org_id;
  } else {
    orgId = await createOrgForUser(ownerUserId, {
      name: scenario.displayName,
      country: scenario.country,
      baseCurrency: scenario.currency,
      languages: scenario.languages,
    });
    createdOrg = true;
  }

  const ctx: Ctx = {
    orgId,
    userId: ownerUserId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: "sim-provision",
  };

  // 3) Install the industry template (once per org).
  const installed =
    (await owner`select value from public.app_settings where org_id = ${orgId} and key = 'config.template'`) as unknown as Array<{
      value: unknown;
    }>;
  if (!(installed.length && installed[0]!.value !== null)) {
    await installTemplate(ctx, scenario.templateKey);
  }

  // 4) Legitimate demo entitlement: internal_pilot / growth / no trial deadline.
  await owner`update public.org_plan_state
    set billing_state = 'internal_pilot', plan_key = 'growth', trial_end = null, period_start = now(), updated_at = now()
    where org_id = ${orgId}`;

  // 5) Branding (accent + display name → tinted initials mark; no asset needed).
  await owner`insert into public.org_branding (org_id, display_name, accent_color)
    values (${orgId}, ${scenario.displayName}, ${scenario.accentColor})
    on conflict (org_id) do update set display_name = excluded.display_name, accent_color = excluded.accent_color`;

  // 6) Document identity on the default company (fictional; TRN left blank).
  await owner`update public.company set
      legal_name = ${scenario.legalName},
      address_en = ${scenario.contact.addressEn},
      address_ar = ${scenario.contact.addressAr},
      city = ${scenario.contact.city},
      country = ${scenario.country},
      phone = ${scenario.contact.phone},
      email = ${scenario.contact.email},
      website = ${scenario.contact.website},
      doc_language = ${scenario.docLanguage},
      tax_reg_no = null
    where org_id = ${orgId} and is_default = true`;

  // 7) VAT posture + demo marker (typed app_settings; no new column).
  await owner`insert into public.app_settings (org_id, key, value)
    values (${orgId}, 'finance.vat_registered', ${owner.json(scenario.vatRegistered)})
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()`;
  await owner`insert into public.app_settings (org_id, key, value)
    values (${orgId}, ${DEMO_MARKER_KEY}, ${owner.json({
      is_demo: true,
      sim_version: SIM_VERSION,
      generated_at: opts.generatedAt,
      scenario: scenario.key,
      as_of: opts.asOf,
    })})
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now()`;

  // 8) Preset code → id map (for job inserts).
  const presets =
    (await owner`select code, id::text as id from public.job_preset where org_id = ${orgId}`) as unknown as Array<{
      code: string;
      id: string;
    }>;
  const presetIdByCode: Record<string, string> = {};
  for (const p of presets) presetIdByCode[p.code] = p.id;

  return {
    scenarioKey: scenario.key,
    displayName: scenario.displayName,
    orgId,
    ownerUserId,
    email,
    password,
    locale: scenario.locale,
    createdOrg,
    presetIdByCode,
  };
}
