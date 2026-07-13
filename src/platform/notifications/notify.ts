/**
 * Notifications (doc 01 F-12). Phase F ships the write + read + preference
 * resolution; channel DELIVERY (email/push) is wired in S4 — createNotification
 * persists the in-app record and resolves the recipient's channel preferences,
 * returning which channels S4 should fan out to (no delivery here).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { NOTIFICATION_KINDS } from "@/platform/registries";

export type Channel = "in_app" | "email" | "push";

export const CreateNotificationInput = z.object({
  recipientUserId: z.string().uuid(),
  kind: z.enum(NOTIFICATION_KINDS as unknown as [string, ...string[]]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2000).optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
});
export type CreateNotificationInput = z.infer<typeof CreateNotificationInput>;

export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

/** Persist an in-app notification. Channel fan-out (email/push) is S4's job and
 * re-resolves the RECIPIENT's preferences in the recipient's own ctx (their prefs
 * are invisible to the actor by RLS), so nothing about delivery is returned here. */
export async function createNotification(ctx: Ctx, raw: unknown): Promise<{ id: string }> {
  const input = CreateNotificationInput.parse(raw);
  // Generate the id in app (AR-1) — NO `returning`: a notification is private to
  // its recipient, so the sender's SELECT policy would hide the row and
  // INSERT ... RETURNING would raise. The recipient reads it via listMyNotifications.
  const id = randomUUID();
  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      insert into public.notification
        (id, org_id, user_id, kind, title, body, entity_type, entity_id)
      values (${id}, ${ctx.orgId}, ${input.recipientUserId}, ${input.kind}, ${input.title},
              ${input.body ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null})
    `),
  );
  return { id };
}

/**
 * In-transaction notification insert (S4) — for callers that must persist the
 * notification ATOMICALLY with their own mutation (e.g. an approval submission
 * pushing to the assigned role in the SAME command tx). Same insert as
 * createNotification; no `returning` (recipient-private row, AR-1). Bodies must be
 * pre-REDACTED by the caller — never put cost/price in a notification (F-23).
 */
export async function createNotificationIn(
  tx: TenantTx,
  ctx: Ctx,
  raw: unknown,
): Promise<{ id: string }> {
  const input = CreateNotificationInput.parse(raw);
  const id = randomUUID();
  await tx.execute(sql`
    insert into public.notification
      (id, org_id, user_id, kind, title, body, entity_type, entity_id)
    values (${id}, ${ctx.orgId}, ${input.recipientUserId}, ${input.kind}, ${input.title},
            ${input.body ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null})
  `);
  return { id };
}

/** The caller's own notifications in the active org (RLS enforces recipient). */
export async function listMyNotifications(ctx: Ctx, unreadOnly = false): Promise<Notification[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, kind, title, body, entity_type, entity_id::text as entity_id,
             read_at::text as read_at, created_at::text as created_at
      from public.notification
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId}
        ${unreadOnly ? sql`and read_at is null` : sql``}
      order by created_at desc
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      entityType: (r.entity_type as string | null) ?? null,
      entityId: (r.entity_id as string | null) ?? null,
      readAt: (r.read_at as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  });
}

/** Mark one of the caller's own notifications read (RLS + column grant enforce). */
export async function markNotificationRead(ctx: Ctx, id: string): Promise<void> {
  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      update public.notification set read_at = now()
      where id = ${id} and org_id = ${ctx.orgId} and user_id = ${ctx.userId} and read_at is null
    `),
  );
}

// ── preferences (the caller's own) ────────────────────────────────────────────
export async function getMyNotificationPreferences(
  ctx: Ctx,
): Promise<Record<string, Partial<Record<Channel, boolean>>>> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select channels from public.notification_preference
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId}
    `)) as unknown as Array<{ channels: Record<string, Partial<Record<Channel, boolean>>> }>;
    return rows[0]?.channels ?? {};
  });
}

export const SetPreferencesInput = z.record(
  z.string(),
  z.object({
    in_app: z.boolean().optional(),
    email: z.boolean().optional(),
    push: z.boolean().optional(),
  }),
);

export async function setMyNotificationPreferences(ctx: Ctx, raw: unknown): Promise<void> {
  const channels = SetPreferencesInput.parse(raw);
  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      insert into public.notification_preference (org_id, user_id, channels)
      values (${ctx.orgId}, ${ctx.userId}, ${JSON.stringify(channels)}::jsonb)
      on conflict (org_id, user_id) do update set channels = excluded.channels
    `),
  );
}
