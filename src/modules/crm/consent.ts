/**
 * H27 — consent, suppression and the outbound-marketing gate (ADR-36).
 *
 * Consent is an append-only record per person and channel with its source
 * and evidence. A suppression (objection, unsubscribe, bounce, complaint)
 * outranks any consent and is never overwritten. Marketing can be sent only
 * through `sendMarketingMessage`, which requires an explicit action, checks
 * every recipient at send time, carries sender identity and an unsubscribe
 * path, and FAILS CLOSED when no delivery provider is configured — nothing is
 * simulated or logged as sent.
 *
 * Sources consulted (docs/H27-TRUTH-MAP.md C1): GDPR Art. 21(2)–(3), Directive
 * 2002/58/EC Art. 13(1),(2),(4), 15 U.S.C. § 7704(a)(3)–(5), UAE Federal
 * Decree-Law 45/2021 (consent), Saudi PDPL Implementing Regulation (direct
 * marketing consent and an opt-out as easy as opting in).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { channelProviders } from "./activities";

export const CONSENT_CHANNELS = ["email", "sms", "whatsapp", "phone", "post"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
const uuid = z.string().uuid();

export class ConsentError extends Error {
  readonly code: "validation" | "not_found" | "unavailable" | "suppressed" | "no_consent";
  readonly ownerAction?: string;
  constructor(message: string, code: ConsentError["code"], ownerAction?: string) {
    super(message);
    this.code = code;
    this.ownerAction = ownerAction;
  }
}

export function normaliseAddress(channel: ConsentChannel, raw: string): string {
  const s = raw.trim();
  if (channel === "email") return s.toLowerCase();
  if (channel === "post") return s.replace(/\s+/g, " ");
  return s.replace(/[^\d+]/g, "");
}

export const ConsentInput = z
  .object({
    customerId: uuid.optional().nullable(),
    contactId: uuid.optional().nullable(),
    leadId: uuid.optional().nullable(),
    channel: z.enum(CONSENT_CHANNELS),
    status: z.enum(["granted", "withdrawn", "unknown"]),
    source: z.enum([
      "form",
      "verbal",
      "written",
      "import",
      "customer_request",
      "unsubscribe",
      "system",
    ]),
    evidence: z.string().trim().max(1000).optional().nullable(),
    /** When withdrawing by unsubscribe, the address to suppress (looked up from the subject when omitted). */
    address: z.string().trim().max(320).optional().nullable(),
  })
  .refine((v) => [v.customerId, v.contactId, v.leadId].filter(Boolean).length === 1, {
    message: "exactly one subject",
  });

async function subjectAddressIn(
  tx: TenantTx,
  ctx: Ctx,
  input: { customerId?: string | null; contactId?: string | null; leadId?: string | null },
  channel: ConsentChannel,
): Promise<string | null> {
  const col = channel === "email" ? sql`email` : channel === "post" ? sql`null::text` : sql`phone`;
  const rows = (await tx.execute(
    input.customerId
      ? sql`select ${col} as a from public.customer where id = ${input.customerId} and org_id = ${ctx.orgId}`
      : input.contactId
        ? sql`select ${col} as a from public.customer_contact where id = ${input.contactId} and org_id = ${ctx.orgId}`
        : sql`select ${col} as a from public.lead where id = ${input.leadId ?? null} and org_id = ${ctx.orgId}`,
  )) as unknown as Array<{ a: string | null }>;
  if (!rows[0]) throw new ConsentError("subject not found", "not_found");
  return rows[0].a ? normaliseAddress(channel, rows[0].a) : null;
}

/** Record consent or its withdrawal; an unsubscribe also suppresses the address. */
export async function recordConsent(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; suppressed: boolean }> {
  assertCan(archetype, "crm.consent.manage");
  const input = ConsentInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.consent.record",
        entityType: "crm_consent",
        entityId: r.id,
        summary: `${input.channel} ${input.status} via ${input.source}`,
      }),
    },
    async (tx) => {
      await subjectAddressIn(tx, ctx, input, input.channel); // existence check
      const rows = (await tx.execute(sql`
        insert into public.crm_consent (org_id, customer_id, contact_id, lead_id, channel, status, source, evidence, actor_user_id)
        values (${ctx.orgId}, ${input.customerId ?? null}, ${input.contactId ?? null}, ${input.leadId ?? null},
                ${input.channel}, ${input.status}, ${input.source}, ${input.evidence ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      let suppressed = false;
      if (
        input.status === "withdrawn" &&
        (input.source === "unsubscribe" || input.source === "customer_request")
      ) {
        const address = input.address
          ? normaliseAddress(input.channel, input.address)
          : await subjectAddressIn(tx, ctx, input, input.channel);
        if (address) {
          await tx.execute(sql`
            insert into public.crm_suppression (org_id, channel, address, reason, note, actor_user_id)
            values (${ctx.orgId}, ${input.channel}, ${address}, ${input.source === "unsubscribe" ? "unsubscribe" : "objection"}, ${input.evidence ?? null}, ${ctx.userId})
            on conflict (org_id, channel, address) do nothing
          `);
          suppressed = true;
        }
      }
      return { id: rows[0]!.id, suppressed };
    },
  );
}

export const SuppressInput = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  address: z.string().trim().min(3).max(320),
  reason: z.enum(["objection", "unsubscribe", "bounce", "complaint", "legal", "manual"]),
  note: z.string().trim().max(500).optional().nullable(),
});

/** Add an address to the suppression list. Never removed by the application role. */
export async function suppressAddress(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string | null; existed: boolean }> {
  assertCan(archetype, "crm.consent.manage");
  const input = SuppressInput.parse(raw);
  const address = normaliseAddress(input.channel, input.address);
  return command(
    ctx,
    {
      audit: {
        action: "crm.suppression.add",
        entityType: "crm_consent",
        summary: `${input.channel} ${input.reason}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_suppression (org_id, channel, address, reason, note, actor_user_id)
        values (${ctx.orgId}, ${input.channel}, ${address}, ${input.reason}, ${input.note ?? null}, ${ctx.userId})
        on conflict (org_id, channel, address) do nothing
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]?.id ?? null, existed: rows.length === 0 };
    },
  );
}

export type ContactDecision = {
  allowed: boolean;
  reason: "granted" | "suppressed" | "withdrawn" | "unknown" | "no_address";
  address: string | null;
  consentAt: string | null;
};

/** The decision the sender must obey, evaluated at send time. Suppression outranks consent. */
export async function canContactIn(
  tx: TenantTx,
  ctx: Ctx,
  subject: { customerId?: string | null; contactId?: string | null; leadId?: string | null },
  channel: ConsentChannel,
): Promise<ContactDecision> {
  const address = await subjectAddressIn(tx, ctx, subject, channel);
  if (!address) return { allowed: false, reason: "no_address", address: null, consentAt: null };
  const sup = (await tx.execute(sql`
    select 1 from public.crm_suppression where org_id = ${ctx.orgId} and channel = ${channel} and address = ${address}
  `)) as unknown as unknown[];
  if (sup.length) return { allowed: false, reason: "suppressed", address, consentAt: null };
  const rows = (await tx.execute(sql`
    select status, effective_at::text as at from public.crm_consent
    where org_id = ${ctx.orgId} and channel = ${channel}
      and (${subject.customerId ?? null}::uuid is null or customer_id = ${subject.customerId ?? null}::uuid)
      and (${subject.contactId ?? null}::uuid is null or contact_id = ${subject.contactId ?? null}::uuid)
      and (${subject.leadId ?? null}::uuid is null or lead_id = ${subject.leadId ?? null}::uuid)
      and (${subject.customerId ? sql`customer_id is not null` : subject.contactId ? sql`contact_id is not null` : sql`lead_id is not null`})
    order by effective_at desc limit 1
  `)) as unknown as Array<{ status: string; at: string }>;
  const latest = rows[0];
  if (!latest || latest.status === "unknown")
    return { allowed: false, reason: "unknown", address, consentAt: null };
  if (latest.status === "withdrawn")
    return { allowed: false, reason: "withdrawn", address, consentAt: latest.at };
  return { allowed: true, reason: "granted", address, consentAt: latest.at };
}

export async function canContact(
  ctx: Ctx,
  archetype: RoleArchetype,
  subject: { customerId?: string | null; contactId?: string | null; leadId?: string | null },
  channel: ConsentChannel,
): Promise<ContactDecision> {
  assertCan(archetype, "customers.view");
  return withCtx(ctx, (tx) => canContactIn(tx, ctx, subject, channel));
}

export type ConsentRow = {
  id: string;
  channel: ConsentChannel;
  status: "granted" | "withdrawn" | "unknown";
  source: string;
  evidence: string | null;
  effectiveAt: string;
  actorName: string | null;
};

export async function listConsent(
  ctx: Ctx,
  archetype: RoleArchetype,
  subject: { customerId?: string | null; contactId?: string | null; leadId?: string | null },
): Promise<ConsentRow[]> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select c.id::text as id, c.channel, c.status, c.source, c.evidence, c.effective_at::text as effective_at, u.full_name as actor_name
      from public.crm_consent c left join public.user_profile u on u.id = c.actor_user_id
      where c.org_id = ${ctx.orgId}
        and (${subject.customerId ?? null}::uuid is null or c.customer_id = ${subject.customerId ?? null}::uuid)
        and (${subject.contactId ?? null}::uuid is null or c.contact_id = ${subject.contactId ?? null}::uuid)
        and (${subject.leadId ?? null}::uuid is null or c.lead_id = ${subject.leadId ?? null}::uuid)
      order by c.effective_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    channel: String(r.channel) as ConsentChannel,
    status: String(r.status) as ConsentRow["status"],
    source: String(r.source),
    evidence: (r.evidence as string | null) ?? null,
    effectiveAt: String(r.effective_at),
    actorName: (r.actor_name as string | null) ?? null,
  }));
}

// ── the outbound marketing gate ───────────────────────────────────────────────
export const MarketingSendInput = z.object({
  campaignId: uuid,
  channel: z.enum(["email", "sms", "whatsapp"]),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  recipients: z
    .array(
      z.object({
        customerId: uuid.optional().nullable(),
        contactId: uuid.optional().nullable(),
        leadId: uuid.optional().nullable(),
      }),
    )
    .min(1)
    .max(500),
  /** The person explicitly confirms this is a marketing send under their authority. */
  confirmed: z.literal(true),
});

export type MarketingSendPreview = {
  provider: { name: string; configured: boolean; ownerAction: string | null };
  allowed: number;
  blocked: Array<{ index: number; reason: ContactDecision["reason"] }>;
};

/**
 * Preview which recipients may be contacted; nothing is sent. Used by the
 * screen before the explicit send, and by the send itself.
 */
export async function previewMarketingSend(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<MarketingSendPreview> {
  assertCan(archetype, "crm.campaigns.manage");
  const input = MarketingSendInput.parse(raw);
  const provider = channelProviders().find((p) =>
    input.channel === "email" ? p.channel === "email" : p.channel === "messaging",
  )!;
  return withCtx(ctx, async (tx) => {
    const blocked: MarketingSendPreview["blocked"] = [];
    let allowed = 0;
    for (const [i, r] of input.recipients.entries()) {
      const d = await canContactIn(tx, ctx, r, input.channel);
      if (d.allowed) allowed++;
      else blocked.push({ index: i, reason: d.reason });
    }
    return {
      provider: {
        name: provider.name,
        configured: provider.configured,
        ownerAction: provider.ownerAction,
      },
      allowed,
      blocked,
    };
  });
}

/**
 * Send marketing through the configured provider. Fails closed without a
 * provider; never records a message that was not actually delivered to the
 * provider. Suppressed and non-consented recipients are skipped and reported.
 */
export async function sendMarketingMessage(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ sent: number; skipped: MarketingSendPreview["blocked"] }> {
  assertCan(archetype, "crm.campaigns.manage");
  const input = MarketingSendInput.parse(raw);
  const preview = await previewMarketingSend(ctx, archetype, input);
  if (!preview.provider.configured)
    throw new ConsentError(
      `no ${input.channel} delivery provider is configured; nothing was sent`,
      "unavailable",
      preview.provider.ownerAction ?? undefined,
    );
  // A provider IS configured only for email today (Resend). The adapter call
  // lives behind the same seam the platform uses for transactional mail.
  return command(
    ctx,
    {
      audit: {
        action: "crm.campaign.send",
        entityType: "crm_campaign",
        entityId: input.campaignId,
        summary: `${input.channel}: ${preview.allowed} allowed, ${preview.blocked.length} skipped`,
      },
    },
    async (tx) => {
      const { sendEmail } = await import("@/platform/notifications");
      let sent = 0;
      for (const [i, r] of input.recipients.entries()) {
        if (preview.blocked.some((b) => b.index === i)) continue;
        const d = await canContactIn(tx, ctx, r, input.channel);
        if (!d.allowed || !d.address) continue;
        const res = await sendEmail({
          to: d.address,
          subject: input.subject,
          text: `${input.body}\n\n—\nTo stop receiving these messages, reply STOP to this address.`,
        });
        if (!res.delivered) continue;
        sent++;
        await tx.execute(sql`
          insert into public.sales_activity (org_id, customer_id, contact_id, lead_id, kind, title, body, actor_user_id, completed_at, completed_by, meta)
          values (${ctx.orgId}, ${r.customerId ?? null}, ${r.contactId ?? null}, ${r.leadId ?? null}, 'message', ${input.subject},
                  ${input.body.slice(0, 2000)}, ${ctx.userId}, now(), ${ctx.userId},
                  ${JSON.stringify({ campaignId: input.campaignId, channel: input.channel, marketing: true, consentAt: d.consentAt })}::jsonb)
        `);
        await tx.execute(sql`
          insert into public.crm_touch (org_id, campaign_id, customer_id, lead_id, kind, created_by)
          values (${ctx.orgId}, ${input.campaignId}, ${r.customerId ?? null}, ${r.leadId ?? null}, 'exposure', ${ctx.userId})
        `);
      }
      return { sent, skipped: preview.blocked };
    },
  );
}
