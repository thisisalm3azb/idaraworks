/**
 * Identity operations (Phase C): org creation (platform bootstrap), invites
 * (own token flow — no service-role anywhere), member management, sign-in log.
 * All writes inside tenant/user transactions; A-B5 respected throughout.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { appDb } from "@/platform/tenancy/db";
import { sql, withCtx, withUserCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import { CURRENCY_CODES, type RoleArchetype } from "@/platform/registries";
import { sendEmail } from "@/platform/notifications/email";
import { logger } from "@/platform/logger";

/**
 * Surface a plpgsql RAISE message cleanly (BUILD_BIBLE §8.1 — services throw
 * typed domain errors, not driver-wrapped ones). drizzle wraps DB errors in
 * DrizzleQueryError; the RAISE text lives on `.cause.message`.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
function rethrowDbMessage(err: unknown): never {
  const cause = (err as { cause?: { message?: string } }).cause;
  if (cause?.message) throw new DomainError(cause.message);
  throw err;
}

// ── sign-in log ───────────────────────────────────────────────────────────────
export type AuthEvent =
  | "login_success"
  | "login_failure"
  | "logout"
  | "signup"
  | "mfa_enrolled"
  | "mfa_challenge_success"
  | "mfa_challenge_failure"
  | "mfa_reset"
  | "otp_sent"
  | "otp_verified"
  | "invite_sent"
  | "invite_accepted"
  | "membership_deactivated";

export async function logAuthEvent(entry: {
  userId?: string;
  orgId?: string;
  event: AuthEvent;
  detail?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const write = async (tx: TenantTx) => {
    await tx.execute(sql`
      insert into public.sign_in_log (user_id, org_id, event, detail, ip, user_agent)
      values (${entry.userId ?? null}, ${entry.orgId ?? null}, ${entry.event},
              ${JSON.stringify(entry.detail ?? {})}::jsonb, ${entry.ip ?? null},
              ${entry.userAgent ?? null})
    `);
  };
  try {
    if (entry.orgId && entry.userId) {
      // Org-tagged events must write in ORG context so the policy's
      // org_id = current_org_id() with-check passes (the user is a member).
      await withCtx(
        { orgId: entry.orgId, userId: entry.userId, costPrivileged: false, requestId: "audit" },
        write,
      );
    } else if (entry.userId) {
      await withUserCtx(entry.userId, write);
    } else {
      // Anonymous events (failed logins): a plain transaction — allowed on the
      // pool per A-B5 (transactions are the pool's supported path).
      await appDb().transaction(write);
    }
  } catch (err) {
    // The log must never break auth flows; it must also never fail silently.
    logger.warn({ event: entry.event, err: (err as Error).message }, "sign_in_log write failed");
  }
}

// ── org creation (bootstrap) ─────────────────────────────────────────────────
export const CreateOrgInput = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.string().length(2).toUpperCase(),
  baseCurrency: z.enum(CURRENCY_CODES as [string, ...string[]]),
  timezone: z.string().min(1).max(64).default("Asia/Dubai"),
  languages: z
    .array(z.enum(["en", "ar"]))
    .min(1)
    .default(["en"]),
  sixDayWeek: z.boolean().default(false),
});
export type CreateOrgInput = z.infer<typeof CreateOrgInput>;

export async function createOrgForUser(userId: string, raw: unknown): Promise<string> {
  const input = CreateOrgInput.parse(raw);
  try {
    return await withUserCtx(userId, async (tx) => {
      const rows = (await tx.execute(sql`
        select app.create_org_with_owner(
          ${userId}, ${input.name}, ${input.country}, ${input.baseCurrency},
          ${input.timezone}, string_to_array(${input.languages.join(",")}, ','),
          ${input.sixDayWeek}
        ) as org_id
      `)) as unknown as Array<{ org_id: string }>;
      const orgId = rows[0]?.org_id;
      if (!orgId) throw new Error("org creation returned nothing");
      return orgId;
    });
  } catch (err) {
    rethrowDbMessage(err);
  }
}

// ── invites ───────────────────────────────────────────────────────────────────
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const InviteInput = z.object({
  email: z.string().email(),
  roleKey: z.string().min(1).max(40),
});

const INVITE_TTL_DAYS = 7;

export async function inviteMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ inviteId: string; token: string; delivered: boolean }> {
  assertCan(archetype, "members.invite");
  const input = InviteInput.parse(raw);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);

  const inviteId = await withCtx(ctx, async (tx) => {
    const role = (await tx.execute(sql`
      select key from public.role_definition
      where org_id = ${ctx.orgId} and key = ${input.roleKey} and key <> 'owner'
    `)) as unknown as Array<{ key: string }>;
    if (!role[0]) throw new Error("unknown role for invite");
    const rows = (await tx.execute(sql`
      insert into public.membership_invite (org_id, email, role_key, token_hash, invited_by, expires_at)
      values (${ctx.orgId}, ${input.email.toLowerCase()}, ${input.roleKey}, ${tokenHash},
              ${ctx.userId}, now() + make_interval(days => ${INVITE_TTL_DAYS}))
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  });

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const { delivered } = await sendEmail({
    to: input.email,
    subject: "You have been invited to IdaraWorks",
    text: `You have been invited to join a workspace on IdaraWorks.\n\nAccept: ${appUrl}/invite/${token}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
  });
  await logAuthEvent({
    userId: ctx.userId,
    orgId: ctx.orgId,
    event: "invite_sent",
    detail: { inviteId, roleKey: input.roleKey },
  });
  return { inviteId, token, delivered };
}

export async function acceptInvite(userId: string, token: string): Promise<string> {
  const tokenHash = hashInviteToken(token);
  let orgId: string;
  try {
    orgId = await withUserCtx(userId, async (tx) => {
      const rows = (await tx.execute(sql`
        select app.accept_invite(${tokenHash}, ${userId})::text as org_id
      `)) as unknown as Array<{ org_id: string }>;
      return rows[0]!.org_id;
    });
  } catch (err) {
    rethrowDbMessage(err);
  }
  await logAuthEvent({ userId, orgId, event: "invite_accepted" });
  return orgId;
}

// ── members ──────────────────────────────────────────────────────────────────
export type Member = {
  membershipId: string;
  userId: string;
  fullName: string;
  roleKey: string;
  archetype: RoleArchetype;
  deactivatedAt: string | null;
};

export async function listMembers(ctx: Ctx, archetype: RoleArchetype): Promise<Member[]> {
  assertCan(archetype, "members.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select m.id::text as membership_id, m.user_id::text as user_id,
             p.full_name, m.role_key, r.archetype, m.deactivated_at::text as deactivated_at
      from public.membership m
      join public.user_profile p on p.id = m.user_id
      join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
      where m.org_id = ${ctx.orgId}
      order by p.full_name
    `)) as unknown as Array<{
      membership_id: string;
      user_id: string;
      full_name: string;
      role_key: string;
      archetype: RoleArchetype;
      deactivated_at: string | null;
    }>;
    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      fullName: r.full_name,
      roleKey: r.role_key,
      archetype: r.archetype,
      deactivatedAt: r.deactivated_at,
    }));
  });
}

/** Assignable (non-owner) role keys for the invite form. */
export async function listAssignableRoles(ctx: Ctx, archetype: RoleArchetype): Promise<string[]> {
  assertCan(archetype, "members.invite");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select key from public.role_definition
      where org_id = ${ctx.orgId} and key <> 'owner' order by key
    `)) as unknown as Array<{ key: string }>;
    return rows.map((r) => r.key);
  });
}

export async function deactivateMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  membershipId: string,
): Promise<void> {
  assertCan(archetype, "members.deactivate");
  await withCtx(ctx, async (tx) => {
    const target = (await tx.execute(sql`
      select user_id::text as user_id, role_key from public.membership
      where id = ${membershipId} and org_id = ${ctx.orgId}
    `)) as unknown as Array<{ user_id: string; role_key: string }>;
    if (!target[0]) throw new Error("membership not found");
    if (target[0].role_key === "owner") {
      throw new Error("the owner cannot be deactivated (doc 06)");
    }
    if (target[0].user_id === ctx.userId) {
      throw new Error("you cannot deactivate yourself");
    }
    await tx.execute(sql`
      update public.membership set deactivated_at = now()
      where id = ${membershipId} and org_id = ${ctx.orgId} and deactivated_at is null
    `);
    // S4 hook (doc 10 #22): open approvals reassignment — the approvals engine
    // registers a listener here when it lands. Stub is intentional, not missing.
  });
  await logAuthEvent({
    userId: ctx.userId,
    orgId: ctx.orgId,
    event: "membership_deactivated",
    detail: { membershipId },
  });
}
