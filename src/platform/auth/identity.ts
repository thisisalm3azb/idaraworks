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
import { getLimit } from "@/platform/entitlements";
import { CURRENCY_CODES, type RoleArchetype } from "@/platform/registries";
import { command } from "@/platform/audit";
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
  // Only surface plpgsql RAISE text (SQLSTATE P0001). Any other DB error
  // (constraint names, syntax, etc.) is logged server-side and returned as a
  // generic message — never leak internal schema detail to the caller
  // (independent review, database).
  const cause = (err as { cause?: { message?: string; code?: string } }).cause;
  if (cause?.code === "P0001" && cause.message) {
    throw new DomainError(cause.message);
  }
  logger.warn({ code: cause?.code, err: (err as Error).message }, "unexpected db error");
  throw new DomainError("The operation could not be completed.");
}

// ── sign-in log ───────────────────────────────────────────────────────────────
// sign_in_log is the AUTH-SESSION stream only (doc 01 D-1.8). Membership events
// (invite/accept/deactivate) are compliance events → audit_log via command().
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
  | "otp_verified";

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
        {
          orgId: entry.orgId,
          userId: entry.userId,
          costPrivileged: false,
          pricePrivileged: false,
          requestId: "audit",
        },
        write,
      );
    } else if (entry.userId) {
      await withUserCtx(entry.userId, write);
    } else if (entry.orgId) {
      // Org-only, no user: not produced by any current caller, but the sign_in_log
      // with_check would reject it (org_id <> current_org_id() with no GUC). Drop
      // the org tag rather than swallow the event silently (independent review).
      await appDb().transaction((tx) =>
        tx.execute(sql`
          insert into public.sign_in_log (event, detail) values (${entry.event},
            ${JSON.stringify({ ...(entry.detail ?? {}), dropped_org_tag: entry.orgId })}::jsonb)
        `),
      );
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
  let orgId: string;
  try {
    orgId = await withUserCtx(userId, async (tx) => {
      const rows = (await tx.execute(sql`
        select app.create_org_with_owner(
          ${userId}, ${input.name}, ${input.country}, ${input.baseCurrency},
          ${input.timezone}, string_to_array(${input.languages.join(",")}, ','),
          ${input.sixDayWeek}
        ) as org_id
      `)) as unknown as Array<{ org_id: string }>;
      const id = rows[0]?.org_id;
      if (!id) throw new Error("org creation returned nothing");
      return id;
    });
  } catch (err) {
    rethrowDbMessage(err);
  }
  // The 'org.create' audit row is written INSIDE app.create_org_with_owner
  // (0007), atomic with the bootstrap mutation — no follow-up needed here.
  return orgId;
}

/** A seat limit was hit on invite. Adds are blocked — reads never are (FR-9);
 * existing members keep full visibility, the org just cannot ADD this seat class. */
export class SeatLimitError extends Error {
  constructor(
    public readonly limitKey: "limit.full_users" | "limit.viewer_users",
    public readonly limit: number,
  ) {
    super(
      `seat limit reached (${limit}) — adding members is blocked, viewing is never blocked. ` +
        `Add a seat pack or free a seat.`,
    );
    this.name = "SeatLimitError";
  }
}

/** Seat classification (product law): full seats = office archetypes; field
 * (foreman) seats are FREE and never limited; viewers have their own cap.
 * Anything unclassified counts as a full seat (fail-closed for new archetypes). */
const FULL_SEAT_ARCHETYPES = ["owner", "admin", "manager", "procurement", "accounts"] as const;

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

  // Seat limits resolve BEFORE the tx (cached; mirrors jobs.create) — the
  // authoritative recount happens IN-TX under the advisory lock below.
  const fullLimit = await getLimit(ctx, "limit.full_users");
  const viewerLimit = await getLimit(ctx, "limit.viewer_users");

  // Insert + audit atomically through the command path (audit_log).
  const inviteId = await command(
    ctx,
    {
      audit: (id: string) => ({
        action: "membership_invite.create",
        entityType: "membership_invite",
        entityId: id,
        summary: `Invited ${input.email} as ${input.roleKey}`,
      }),
    },
    async (tx) => {
      const role = (await tx.execute(sql`
        select key, archetype from public.role_definition
        where org_id = ${ctx.orgId} and key = ${input.roleKey} and key <> 'owner'
      `)) as unknown as Array<{ key: string; archetype: RoleArchetype }>;
      if (!role[0]) throw new Error("unknown role for invite");
      // Per-org invite mutex + IN-TX seat recount (the jobs.create idiom): N
      // concurrent invites serialize here, so the seat limit cannot be raced.
      // Field (foreman) seats are NEVER limited — free by product law.
      if (role[0].archetype !== "foreman") {
        const isViewer = role[0].archetype === "viewer";
        const seatLimit = isViewer ? viewerLimit : fullLimit;
        if (seatLimit !== null) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${ctx.orgId + ":members.invite"}, 0))`,
          );
          const cls = (isViewer ? ["viewer"] : [...FULL_SEAT_ARCHETYPES]).join(",");
          // Occupied seats = active memberships + pending (unaccepted, unrevoked,
          // unexpired) invites of the same seat class.
          const counted = (await tx.execute(sql`
            select
              (select count(*) from public.membership m
                 join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
               where m.org_id = ${ctx.orgId} and m.deactivated_at is null
                 and r.archetype = any(string_to_array(${cls}, ',')))
              +
              (select count(*) from public.membership_invite i
                 join public.role_definition r on r.org_id = i.org_id and r.key = i.role_key
               where i.org_id = ${ctx.orgId} and i.accepted_at is null
                 and i.revoked_at is null and i.expires_at > now()
                 and r.archetype = any(string_to_array(${cls}, ',')))
              as n
          `)) as unknown as Array<{ n: number }>;
          if (Number(counted[0]?.n ?? 0) >= seatLimit) {
            throw new SeatLimitError(
              isViewer ? "limit.viewer_users" : "limit.full_users",
              seatLimit,
            );
          }
        }
      }
      const rows = (await tx.execute(sql`
        insert into public.membership_invite (org_id, email, role_key, token_hash, invited_by, expires_at)
        values (${ctx.orgId}, ${input.email.toLowerCase()}, ${input.roleKey}, ${tokenHash},
                ${ctx.userId}, now() + make_interval(days => ${INVITE_TTL_DAYS}))
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    },
  );

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const { delivered } = await sendEmail({
    to: input.email,
    subject: "You have been invited to IdaraWorks",
    text: `You have been invited to join a workspace on IdaraWorks.\n\nAccept: ${appUrl}/invite/${token}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
  });
  return { inviteId, token, delivered };
}

export async function acceptInvite(userId: string, token: string): Promise<string> {
  const tokenHash = hashInviteToken(token);

  // Seat recount at ACCEPT (0069): a pending invite can outlive a plan downgrade,
  // so inviteMember's creation-time count is not enough — the cap must also hold
  // when the seat is actually TAKEN. Peek the pending invite (DEFINER, read-only)
  // for its org + seat class; no row = invalid/expired/revoked/accepted → fall
  // through to app.accept_invite so its canonical error surfaces unchanged.
  let peeked: { org_id: string; archetype: RoleArchetype } | undefined;
  try {
    peeked = await withUserCtx(userId, async (tx) => {
      const rows = (await tx.execute(sql`
        select org_id::text as org_id, archetype from app.peek_invite(${tokenHash})
      `)) as unknown as Array<{ org_id: string; archetype: RoleArchetype }>;
      return rows[0];
    });
  } catch (err) {
    rethrowDbMessage(err);
  }
  const pending = peeked;

  const accept = async (tx: TenantTx): Promise<string> => {
    const rows = (await tx.execute(sql`
      select app.accept_invite(${tokenHash}, ${userId})::text as org_id
    `)) as unknown as Array<{ org_id: string }>;
    return rows[0]!.org_id;
  };

  let orgId: string;
  try {
    if (pending && pending.archetype !== "foreman") {
      // Office/viewer seat: resolve the cap in TS BEFORE the accept (add-on limit
      // deltas live in code — addons.ts — so SQL cannot resolve it). Entitlement
      // tables are org-GUC-scoped, not membership-scoped, so a ctx for the
      // not-yet-member invitee reads them fine.
      const isViewer = pending.archetype === "viewer";
      const ctx: Ctx = {
        orgId: pending.org_id,
        userId,
        costPrivileged: false,
        pricePrivileged: false,
        requestId: "accept-invite",
      };
      const seatLimit = await getLimit(ctx, isViewer ? "limit.viewer_users" : "limit.full_users");
      if (seatLimit === null) {
        // Unlimited — accept exactly as before.
        orgId = await withUserCtx(userId, accept);
      } else {
        orgId = await withCtx(ctx, async (tx) => {
          // The SAME per-org mutex as inviteMember: invites and accepts serialize
          // on one key, so the recount can never race a concurrent invite/accept.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${pending.org_id + ":members.invite"}, 0))`,
          );
          // ACTIVE MEMBERSHIPS only — at accept time other pending invites do not
          // hold seats; this accept is claiming a real one.
          const cls = (isViewer ? ["viewer"] : [...FULL_SEAT_ARCHETYPES]).join(",");
          const counted = (await tx.execute(sql`
            select count(*) as n from public.membership m
              join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
            where m.org_id = ${pending.org_id} and m.deactivated_at is null
              and r.archetype = any(string_to_array(${cls}, ','))
          `)) as unknown as Array<{ n: number }>;
          if (Number(counted[0]?.n ?? 0) >= seatLimit) {
            throw new SeatLimitError(
              isViewer ? "limit.viewer_users" : "limit.full_users",
              seatLimit,
            );
          }
          return accept(tx);
        });
      }
    } else {
      // Foreman (field seats are FREE — never limited) or no pending row
      // (app.accept_invite raises the canonical 'invite invalid or expired').
      orgId = await withUserCtx(userId, accept);
    }
  } catch (err) {
    if (err instanceof SeatLimitError) throw err;
    rethrowDbMessage(err);
  }
  // The 'membership.join' audit row is written INSIDE app.accept_invite (0007),
  // atomic with the membership insert — no follow-up needed here.
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
  // Guards + update + audit run atomically through the command path.
  await command(
    ctx,
    {
      audit: (target: { userId: string; fullName: string }) => ({
        action: "membership.deactivate",
        entityType: "membership",
        entityId: membershipId,
        summary: `Deactivated member ${target.fullName || target.userId}`,
        before: { active: true },
        after: { active: false },
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select m.user_id::text as user_id, m.role_key, p.full_name
        from public.membership m
        join public.user_profile p on p.id = m.user_id
        where m.id = ${membershipId} and m.org_id = ${ctx.orgId}
      `)) as unknown as Array<{ user_id: string; role_key: string; full_name: string }>;
      const target = rows[0];
      if (!target) throw new Error("membership not found");
      if (target.role_key === "owner") throw new Error("the owner cannot be deactivated (doc 06)");
      if (target.user_id === ctx.userId) throw new Error("you cannot deactivate yourself");
      await tx.execute(sql`
        update public.membership set deactivated_at = now()
        where id = ${membershipId} and org_id = ${ctx.orgId} and deactivated_at is null
      `);
      // S4 hook (doc 10 #22): open approvals reassignment — the approvals engine
      // registers a listener here when it lands. Stub is intentional, not missing.
      return { userId: target.user_id, fullName: target.full_name };
    },
  );
}
