/**
 * Two-org seeder registry (S0 checklist §9; doc 10 #11 — the package's single
 * most important test's fixtures). ONE seeder per org-scoped table; the bleed
 * harness enumerates the org-scoped tables from the catalog and FAILS if any
 * lacks an entry here — so a new tenant table cannot ship without a bleed check.
 *
 * Seeders write via the OWNER connection (bypassing RLS) so both orgs get real
 * rows; the harness then proves, in each org's ctx, that the OTHER org's rows
 * are invisible.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
/**
 * `userId` fills actor/author/creator columns (org-scoped for RLS). `recipientId`
 * fills the USER-keyed columns (notification/sign_in_log/preference user_id). The
 * bleed harness passes the SAME recipient into both orgs so user-scoping alone
 * cannot hide a cross-org row — only the org_id predicate can (review CM1).
 */
export type Seeder = (
  owner: Owner,
  orgId: string,
  userId: string,
  recipientId: string,
) => Promise<void>;

/**
 * Tables whose isolation is org AND user (both must match) — seeding a SHARED
 * recipient across both orgs means only the org predicate can hide a cross-org
 * row, so a regression dropping org_id is caught (review CM1). NOTE: sign_in_log
 * is deliberately NOT here — its policy is user OR org (a user legitimately sees
 * their OWN auth events across orgs, like an account "your sessions" view), so it
 * is seeded under its own org's user and its cross-USER isolation is what the
 * sweep checks.
 */
export const ORG_AND_USER_TABLES = ["notification", "notification_preference"] as const;

/** Tables that app.create_org_with_owner already populates — seeded by org creation. */
export const CREATE_ORG_SEEDED = [
  "company",
  "membership",
  "org_plan_state",
  "role_definition",
] as const;

const noop: Seeder = async () => {};

function filePath(orgId: string): string {
  const attach = randomUUID();
  const fileId = randomUUID();
  return `${orgId}/job_media/job/${attach}/${fileId}.orig.jpg`;
}

/**
 * Registry keyed by table name. CREATE_ORG_SEEDED tables get a no-op (already
 * populated by createOrgForUser); every other org-scoped table gets a real insert.
 */
export const SEEDERS: Record<string, Seeder> = {
  // ── seeded by org creation ──
  company: noop,
  membership: noop,
  org_plan_state: noop,
  role_definition: noop,

  // ── seeded here ──
  activity: async (o, org, u) => {
    await o`insert into public.activity (org_id, actor_user_id, entity_type, entity_id, verb, summary)
            values (${org}, ${u}, 'job', ${randomUUID()}, 'created', 'bleed')`;
  },
  app_settings: async (o, org) => {
    await o`insert into public.app_settings (org_id, key, value) values (${org}, 'bleed.test', '"x"'::jsonb)`;
  },
  audit_log: async (o, org, u) => {
    await o`insert into public.audit_log (org_id, actor_user_id, action, entity_type, summary)
            values (${org}, ${u}, 'bleed.test', 'org', 'x')`;
  },
  comment: async (o, org, u) => {
    await o`insert into public.comment (org_id, entity_type, entity_id, author_user_id, body)
            values (${org}, 'job', ${randomUUID()}, ${u}, 'bleed')`;
  },
  config_revision: async (o, org, u) => {
    await o`insert into public.config_revision (org_id, artifact_key, actor_user_id, summary)
            values (${org}, 'bleed', ${u}, 'x')`;
  },
  currency_rate_default: async (o, org) => {
    await o`insert into public.currency_rate_default (org_id, currency, rate_to_base)
            values (${org}, 'USD', 3.6725)`;
  },
  domain_event: async (o, org, u) => {
    await o`insert into public.domain_event (org_id, name, payload, actor_user_id)
            values (${org}, 'demo/heartbeat', '{}'::jsonb, ${u})`;
  },
  file: async (o, org, u) => {
    await o`insert into public.file (org_id, access_class, attached_to_type, attached_to_id,
                                     bucket, object_path, original_name, mime, created_by)
            values (${org}, 'job_media', 'job', ${randomUUID()}, 'tenant-media',
                    ${filePath(org)}, 'x.jpg', 'image/jpeg', ${u})`;
  },
  membership_invite: async (o, org, u) => {
    await o`insert into public.membership_invite (org_id, email, role_key, token_hash, invited_by, expires_at)
            values (${org}, ${`bleed-${randomUUID().slice(0, 8)}@x.com`}, 'manager', ${randomUUID()},
                    ${u}, now() + interval '7 days')`;
  },
  notification: async (o, org, _u, recipient) => {
    await o`insert into public.notification (org_id, user_id, kind, title) values (${org}, ${recipient}, 'system', 'bleed')`;
  },
  notification_preference: async (o, org, _u, recipient) => {
    await o`insert into public.notification_preference (org_id, user_id, channels)
            values (${org}, ${recipient}, '{}'::jsonb) on conflict (org_id, user_id) do nothing`;
  },
  org_entitlement_override: async (o, org) => {
    await o`insert into public.org_entitlement_override (org_id, entitlement_key, reason)
            values (${org}, 'limit.full_users', 'bleed') on conflict (org_id, entitlement_key) do nothing`;
  },
  org_holiday_calendar: async (o, org) => {
    await o`insert into public.org_holiday_calendar (org_id, starts_on, label, kind)
            values (${org}, '2026-12-02', '{"en":"National Day"}'::jsonb, 'public_holiday')`;
  },
  org_storage_usage: async (o, org) => {
    await o`insert into public.org_storage_usage (org_id, bytes_used) values (${org}, 123)
            on conflict (org_id) do nothing`;
  },
  // Seeded under the org's OWN user (not the shared recipient): sign_in_log's
  // policy is user-OR-org, so a shared user would be visible cross-org by design
  // (the user's own events). Using a disjoint user tests the cross-USER isolation.
  sign_in_log: async (o, org, u) => {
    await o`insert into public.sign_in_log (org_id, user_id, event) values (${org}, ${u}, 'login_success')`;
  },
};

/**
 * Seed every org-scoped entity for one org. `userId` = the org's own actor;
 * `recipientId` = the user for USER-keyed rows (the harness passes the SAME
 * recipient into both orgs — see USER_KEYED_TABLES / review CM1).
 */
export async function seedOrg(
  owner: Owner,
  orgId: string,
  userId: string,
  recipientId: string = userId,
): Promise<void> {
  for (const seed of Object.values(SEEDERS)) {
    await seed(owner, orgId, userId, recipientId);
  }
}
