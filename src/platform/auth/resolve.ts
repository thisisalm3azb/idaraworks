/**
 * Ctx resolution (S0 checklist §5 step 4; phase2/10 #2):
 * session (Supabase JWT, verified server-side) → user → membership for the
 * requested org (path-based) → role flags → immutable Ctx. org_id is NEVER
 * read from client input as data — it selects which membership to validate.
 */
import { cookies } from "next/headers";
import { sql, supabaseServer, withCtx, withUserCtx, type Ctx } from "@/platform/tenancy";
import { currentRequestId } from "@/platform/observability/requestId";
import type { RoleArchetype } from "@/platform/registries";

export type SessionUser = { id: string; email: string | null; aal: "aal1" | "aal2" };

export type ResolvedCtx = {
  ctx: Ctx;
  archetype: RoleArchetype;
  roleKey: string;
  orgName: string;
  mfaRequired: boolean;
  mfaSatisfied: boolean;
};

export type MyOrg = { orgId: string; orgName: string; roleKey: string };

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const supabase = supabaseServer(store);
  const {
    data: { user },
  } = await supabase.auth.getUser(); // verifies the JWT against Supabase
  if (!user) return null;
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return {
    id: user.id,
    email: user.email ?? null,
    aal: aalData?.currentLevel === "aal2" ? "aal2" : "aal1",
  };
}

/** Bootstrap read: the user's active memberships + org names (org switcher). */
export async function listMyOrgs(userId: string): Promise<MyOrg[]> {
  return withUserCtx(userId, async (tx) => {
    const rows = (await tx.execute(sql`
      select m.org_id::text as org_id, m.role_key, o.name as org_name
      from public.membership m
      join public.org o on o.id = m.org_id
      where m.user_id = ${userId} and m.deactivated_at is null
      order by o.name
    `)) as unknown as Array<{ org_id: string; role_key: string; org_name: string }>;
    return rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, roleKey: r.role_key }));
  });
}

export type ResolveFailure = "no_session" | "no_membership" | "mfa_required";

const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCtx(orgId: string): Promise<ResolvedCtx | ResolveFailure> {
  const user = await getSessionUser();
  if (!user) return "no_session";
  // A malformed /o/<garbage> selector must redirect cleanly, never 500 inside
  // a uuid comparison (independent review, minor).
  if (!ORG_ID_RE.test(orgId)) return "no_membership";

  // Membership check runs user-side (no org GUC yet) — deactivation enforced here.
  const membership = await withUserCtx(user.id, async (tx) => {
    const rows = (await tx.execute(sql`
      select m.role_key, o.name as org_name
      from public.membership m
      join public.org o on o.id = m.org_id
      where m.user_id = ${user.id} and m.org_id = ${orgId} and m.deactivated_at is null
    `)) as unknown as Array<{ role_key: string; org_name: string }>;
    return rows[0];
  });
  if (!membership) return "no_membership";

  const ctxBase: Ctx = {
    orgId,
    userId: user.id,
    costPrivileged: false,
    pricePrivileged: false,
    // Correlation id minted by middleware, threaded through request-scoped
    // logs, 5xx responses, and Sentry tags (Phase I; BUILD_BIBLE §15.3).
    // NOTE: it does NOT cross the outbox — domain events carry no request id
    // by design (0014 schema); workers correlate by their own Inngest run id.
    requestId: await currentRequestId(),
  };

  // Role flags + org MFA policy live inside the org ctx.
  const details = await withCtx(ctxBase, async (tx) => {
    const roles = (await tx.execute(sql`
      select archetype, cost_privileged, price_privileged
      from public.role_definition
      where org_id = ${orgId} and key = ${membership.role_key}
    `)) as unknown as Array<{
      archetype: RoleArchetype;
      cost_privileged: boolean;
      price_privileged: boolean;
    }>;
    const settings = (await tx.execute(sql`
      select value from public.app_settings
      where org_id = ${orgId} and key = 'auth.mfa_required'
    `)) as unknown as Array<{ value: unknown }>;
    return { role: roles[0], mfaRequired: settings[0]?.value === true };
  });
  if (!details.role) return "no_membership";

  return {
    ctx: {
      ...ctxBase,
      costPrivileged: details.role.cost_privileged,
      pricePrivileged: details.role.price_privileged,
    },
    archetype: details.role.archetype,
    roleKey: membership.role_key,
    orgName: membership.org_name,
    mfaRequired: details.mfaRequired,
    mfaSatisfied: !details.mfaRequired || user.aal === "aal2",
  };
}

/**
 * Resolve for a MUTATING org action — fails closed on unmet org-enforced MFA
 * (material security finding: the layout redirect does NOT protect Server
 * Actions; every privileged mutation must re-check aal2 on the server path).
 * Returns the resolved ctx or a failure reason the caller redirects on.
 */
export async function resolveCtxForAction(orgId: string): Promise<ResolvedCtx | ResolveFailure> {
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") return resolved;
  if (!resolved.mfaSatisfied) return "mfa_required";
  return resolved;
}
