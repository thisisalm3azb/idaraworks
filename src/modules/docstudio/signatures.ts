/**
 * H26 — the signature room (ADR-21/23).
 *
 * A request binds an issued snapshot to ordered signers. Members sign in
 * the app; external signers get a one-time invitation (32 random bytes,
 * SHA-256 stored, expiring, revocable). Every signature records evidence
 * (identity as asserted and how it was verified, server time, IP, user
 * agent, locale, consent version, the snapshot hash) and appends to the
 * hash-chained timeline. When the last signer signs, the document becomes
 * active. Nothing here simulates a provider: only the native adapter is
 * provisioned and the receipt says exactly what was captured.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn, sendEmail } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { activatedIn, loadDocIn, loadSnapshotIn } from "./documents";
import { appendEventIn } from "./events";
import { getDocSettingsIn } from "./library";
import { CONSENT_VERSION, getSignatureProvider, NATIVE_PROVIDER } from "./providers";
import type { SignatureRender } from "./render";
import { contentHash } from "./snapshot";
import { DocError, signatureParties } from "./types";

export const INVITATION_DAYS_DEFAULT = 14;
const SYNTHETIC_USER = "00000000-0000-0000-0000-000000000000";

export function appBaseUrl(): string {
  // The same convention as membership invitations (platform/auth/identity).
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export type SignerRow = {
  id: string;
  requestId: string;
  documentId: string;
  orderIndex: number;
  party: string;
  partyKind: "member" | "external";
  userId: string | null;
  name: string;
  email: string | null;
  title: string | null;
  status: "pending" | "invited" | "viewed" | "signed" | "declined" | "revoked" | "expired";
  delivery: "email" | "link" | "in_app" | null;
  invitedAt: string | null;
  tokenExpiresAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  signatureKind: "typed" | "drawn" | null;
  signatureData: string | null;
  evidence: Record<string, unknown> | null;
  evidenceHash: string | null;
  reminderCount: number;
  lastRemindedAt: string | null;
};

export type SignatureRequestRow = {
  id: string;
  documentId: string;
  snapshotId: string;
  provider: string;
  mode: "sequential" | "parallel";
  status: "pending" | "in_progress" | "completed" | "declined" | "cancelled" | "expired";
  message: string | null;
  expiresAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  signers: SignerRow[];
};

const SIGNER_COLUMNS = sql`
  s.id::text as id, s.request_id::text as request_id, s.document_id::text as document_id, s.order_index, s.party,
  s.party_kind, s.user_id::text as user_id, s.name, s.email, s.title, s.status, s.delivery,
  s.invited_at::text as invited_at, s.token_expires_at::text as token_expires_at, s.viewed_at::text as viewed_at,
  s.signed_at::text as signed_at, s.declined_at::text as declined_at, s.decline_reason, s.signature_kind,
  s.signature_data, s.evidence, s.evidence_hash, s.reminder_count, s.last_reminded_at::text as last_reminded_at`;

function mapSigner(r: Record<string, unknown>): SignerRow {
  return {
    id: r.id as string,
    requestId: r.request_id as string,
    documentId: r.document_id as string,
    orderIndex: Number(r.order_index),
    party: r.party as string,
    partyKind: r.party_kind as SignerRow["partyKind"],
    userId: (r.user_id as string | null) ?? null,
    name: r.name as string,
    email: (r.email as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    status: r.status as SignerRow["status"],
    delivery: (r.delivery as SignerRow["delivery"]) ?? null,
    invitedAt: (r.invited_at as string | null) ?? null,
    tokenExpiresAt: (r.token_expires_at as string | null) ?? null,
    viewedAt: (r.viewed_at as string | null) ?? null,
    signedAt: (r.signed_at as string | null) ?? null,
    declinedAt: (r.declined_at as string | null) ?? null,
    declineReason: (r.decline_reason as string | null) ?? null,
    signatureKind: (r.signature_kind as SignerRow["signatureKind"]) ?? null,
    signatureData: (r.signature_data as string | null) ?? null,
    evidence: (r.evidence as Record<string, unknown> | null) ?? null,
    evidenceHash: (r.evidence_hash as string | null) ?? null,
    reminderCount: Number(r.reminder_count),
    lastRemindedAt: (r.last_reminded_at as string | null) ?? null,
  };
}

async function loadSignersIn(tx: TenantTx, ctx: Ctx, requestId: string): Promise<SignerRow[]> {
  const rows = (await tx.execute(sql`
    select ${SIGNER_COLUMNS} from public.doc_signer s
    where s.request_id = ${requestId} and s.org_id = ${ctx.orgId}
    order by s.order_index, s.created_at
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapSigner);
}

async function loadRequestIn(
  tx: TenantTx,
  ctx: Ctx,
  requestId: string,
  lock = false,
): Promise<SignatureRequestRow> {
  const q = lock
    ? sql`select r.id::text as id, r.document_id::text as document_id, r.snapshot_id::text as snapshot_id, r.provider, r.mode, r.status,
                 r.message, r.expires_at::text as expires_at, r.completed_at::text as completed_at, r.cancelled_at::text as cancelled_at,
                 r.cancel_reason, r.created_at::text as created_at
          from public.doc_signature_request r where r.id = ${requestId} and r.org_id = ${ctx.orgId} for update`
    : sql`select r.id::text as id, r.document_id::text as document_id, r.snapshot_id::text as snapshot_id, r.provider, r.mode, r.status,
                 r.message, r.expires_at::text as expires_at, r.completed_at::text as completed_at, r.cancelled_at::text as cancelled_at,
                 r.cancel_reason, r.created_at::text as created_at
          from public.doc_signature_request r where r.id = ${requestId} and r.org_id = ${ctx.orgId}`;
  const rows = (await tx.execute(q)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) throw new DocError("signature request not found", "not_found");
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    snapshotId: r.snapshot_id as string,
    provider: r.provider as string,
    mode: r.mode as SignatureRequestRow["mode"],
    status: r.status as SignatureRequestRow["status"],
    message: (r.message as string | null) ?? null,
    expiresAt: r.expires_at as string,
    completedAt: (r.completed_at as string | null) ?? null,
    cancelledAt: (r.cancelled_at as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    createdAt: r.created_at as string,
    signers: await loadSignersIn(tx, ctx, r.id as string),
  };
}

export async function latestRequestIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<SignatureRequestRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.doc_signature_request
    where document_id = ${documentId} and org_id = ${ctx.orgId}
    order by created_at desc limit 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0] ? loadRequestIn(tx, ctx, rows[0].id) : null;
}

export async function getSignatureRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<SignatureRequestRow | null> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => latestRequestIn(tx, ctx, documentId));
}

// ── create ────────────────────────────────────────────────────────────────────
const SignerInput = z
  .object({
    party: z.string().regex(/^[A-Za-z0-9_ -]{1,40}$/),
    kind: z.enum(["member", "external"]),
    userId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).optional(),
    title: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine((s) => (s.kind === "member" ? Boolean(s.userId) : Boolean(s.email)), {
    message: "a member signer needs a user; an external signer needs an email",
  });

export const CreateSignatureRequestInput = z
  .object({
    documentId: z.string().uuid(),
    mode: z.enum(["sequential", "parallel"]).default("parallel"),
    message: z.string().trim().max(2000).optional(),
    expiresInDays: z.number().int().min(1).max(90).default(INVITATION_DAYS_DEFAULT),
    signers: z.array(SignerInput).min(1).max(10),
    /** Send invitations now (default). False = create the room, invite later. */
    send: z.boolean().default(true),
  })
  .strict();

export type InvitationLink = {
  signerId: string;
  name: string;
  delivery: "email" | "link" | "in_app";
  link: string | null;
};

/**
 * Open the signature room for an issued document (status `signature`).
 * Fails closed when the configured provider is not provisioned.
 */
export async function createSignatureRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; invitations: InvitationLink[] }> {
  assertCan(archetype, "documents.issue");
  const input = CreateSignatureRequestInput.parse(raw);
  const settings = await withCtx(ctx, (tx) => getDocSettingsIn(tx, ctx));
  const provider = getSignatureProvider(settings.signatureProvider ?? "native");
  const created = await command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "documents.signature.request",
        entityType: "document_signature",
        entityId: r.id,
        summary: `Requested ${input.signers.length} signature(s) (${provider.name})`,
      }),
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "requested",
        summary: "signatures requested",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.status !== "signature" || !d.issuedSnapshotId)
        throw new DocError(
          "only an issued document awaiting signature can open a signature room",
          "state",
        );
      const snap = await loadSnapshotIn(tx, ctx, d.id);
      if (!snap) throw new DocError("snapshot missing", "state");
      const parties = signatureParties(snap.snapshot.body);
      for (const s of input.signers) {
        if (!parties.includes(s.party))
          throw new DocError(`party "${s.party}" has no signature block`, "validation");
      }
      const missing = parties.filter((p) => !input.signers.some((s) => s.party === p));
      if (missing.length > 0)
        throw new DocError(`no signer for party: ${missing.join(", ")}`, "validation");
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
      const rows = (await tx.execute(sql`
        insert into public.doc_signature_request
          (org_id, document_id, snapshot_id, provider, mode, message, expires_at, created_by)
        values (${ctx.orgId}, ${d.id}, ${snap.id}, ${provider.name}, ${input.mode}, ${input.message ?? null},
                ${expiresAt}::timestamptz, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const requestId = rows[0]!.id;
      const signerIds: string[] = [];
      for (const [i, s] of input.signers.entries()) {
        const ins = (await tx.execute(sql`
          insert into public.doc_signer
            (org_id, request_id, document_id, order_index, party, party_kind, user_id, name, email, title, created_by)
          values (${ctx.orgId}, ${requestId}, ${d.id}, ${i}, ${s.party}, ${s.kind}, ${s.userId ?? null}, ${s.name},
                  ${s.email ?? null}, ${s.title ?? null}, ${ctx.userId})
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        signerIds.push(ins[0]!.id);
      }
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "signature_requested",
        payload: {
          requestId,
          provider: provider.name,
          mode: input.mode,
          signers: input.signers.length,
          expiresAt,
        },
      });
      return { id: requestId, signerIds };
    },
  );
  const invitations = input.send
    ? await inviteSigners(ctx, archetype, { requestId: created.id })
    : [];
  return { id: created.id, invitations };
}

/** Which signers may be invited now (parallel: all; sequential: the first not yet signed). */
function nextToInvite(req: SignatureRequestRow): SignerRow[] {
  const open = req.signers.filter((s) => ["pending", "invited", "viewed"].includes(s.status));
  if (req.mode === "parallel") return open.filter((s) => s.status === "pending");
  const first = open[0];
  return first && first.status === "pending" ? [first] : [];
}

/**
 * Invite the signers whose turn it is. External signers receive a one-time
 * link by email when delivery is provisioned; otherwise the link is returned
 * ONCE to the requester (delivery = link) and the evidence says so. Members
 * get an in-app notification and sign from the document page.
 */
export async function inviteSigners(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<InvitationLink[]> {
  assertCan(archetype, "documents.issue");
  const input = z
    .object({ requestId: z.string().uuid(), signerId: z.string().uuid().optional() })
    .parse(raw);
  const prepared = await command(
    ctx,
    {
      audit: {
        action: "documents.signature.invite",
        entityType: "document_signature",
        entityId: input.requestId,
        summary: "Sent signing invitations",
      },
    },
    async (tx) => {
      const req = await loadRequestIn(tx, ctx, input.requestId, true);
      if (!["pending", "in_progress"].includes(req.status))
        throw new DocError("this signature request is closed", "state");
      const d = await loadDocIn(tx, ctx, req.documentId);
      const targets = nextToInvite(req).filter((s) => !input.signerId || s.id === input.signerId);
      const out: Array<{
        signer: SignerRow;
        token: string | null;
        link: string | null;
        delivery: "email" | "link" | "in_app";
      }> = [];
      for (const s of targets) {
        if (s.partyKind === "member" && s.userId) {
          await tx.execute(sql`
            update public.doc_signer set status = 'invited', delivery = 'in_app', invited_at = now(), row_version = row_version + 1
            where id = ${s.id} and org_id = ${ctx.orgId}
          `);
          await createNotificationIn(tx, ctx, {
            recipientUserId: s.userId,
            kind: "document_signature_requested",
            title: `${d.reference} ${d.title}`,
            entityType: "document",
            entityId: d.id,
          });
          out.push({ signer: s, token: null, link: null, delivery: "in_app" });
          continue;
        }
        const { token, hash } = newToken();
        await tx.execute(sql`
          update public.doc_signer
          set status = 'invited', token_hash = ${hash}, token_expires_at = ${req.expiresAt}::timestamptz,
              invited_at = now(), delivery = 'link', row_version = row_version + 1
          where id = ${s.id} and org_id = ${ctx.orgId}
        `);
        out.push({ signer: s, token, link: `${appBaseUrl()}/sign/${token}`, delivery: "link" });
      }
      await tx.execute(sql`
        update public.doc_signature_request set status = 'in_progress', row_version = row_version + 1
        where id = ${req.id} and org_id = ${ctx.orgId} and status = 'pending'
      `);
      return { out, d };
    },
  );
  // Email delivery happens OUTSIDE the transaction (network I/O, Bible §8.8);
  // the outcome is recorded afterwards so the evidence names the channel.
  const invitations: InvitationLink[] = [];
  for (const item of prepared.out) {
    if (item.delivery !== "link" || !item.link) {
      invitations.push({
        signerId: item.signer.id,
        name: item.signer.name,
        delivery: item.delivery,
        link: null,
      });
      continue;
    }
    let delivered = false;
    if (item.signer.email) {
      try {
        const res = await sendEmail({
          to: item.signer.email,
          subject: `${prepared.d.reference}: your signature is requested`,
          text: `${prepared.d.title}\n\nPlease review and sign: ${item.link}\n\nThis link is personal and expires on ${prepared.d.expiresAt ?? "the request expiry"}.`,
        });
        delivered = res.delivered;
      } catch {
        delivered = false;
      }
    }
    await withCtx(ctx, async (tx) => {
      await tx.execute(sql`
        update public.doc_signer set delivery = ${delivered ? "email" : "link"}, row_version = row_version + 1
        where id = ${item.signer.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: prepared.d.id,
        kind: "invitation_sent",
        payload: {
          signerId: item.signer.id,
          party: item.signer.party,
          delivery: delivered ? "email" : "link",
        },
      });
    });
    // The plaintext link travels back to the requester exactly once when email
    // delivery is not provisioned; it is never stored.
    invitations.push({
      signerId: item.signer.id,
      name: item.signer.name,
      delivery: delivered ? "email" : "link",
      link: delivered ? null : item.link,
    });
  }
  return invitations;
}

export async function revokeSigner(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.issue");
  const input = z
    .object({ signerId: z.string().uuid(), reason: z.string().trim().max(500).optional() })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.signature.revoke",
        entityType: "document_signature",
        entityId: input.signerId,
        summary: "Revoked a signing invitation",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_signer
        set status = 'revoked', revoked_at = now(), revoked_by = ${ctx.userId}, token_hash = null, row_version = row_version + 1
        where id = ${input.signerId} and org_id = ${ctx.orgId} and status in ('pending', 'invited', 'viewed')
        returning document_id::text as document_id, party
      `)) as unknown as Array<{ document_id: string; party: string }>;
      if (!rows[0]) throw new DocError("signer not found or already decided", "state");
      await appendEventIn(tx, ctx, {
        documentId: rows[0].document_id,
        kind: "invitation_revoked",
        payload: { signerId: input.signerId, party: rows[0].party, reason: input.reason ?? null },
      });
      return { id: input.signerId };
    },
  );
}

/** Re-invite: a fresh token for a revoked or expired external signer (the old one stays dead). */
export async function reinviteSigner(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<InvitationLink[]> {
  assertCan(archetype, "documents.issue");
  const input = z.object({ signerId: z.string().uuid() }).parse(raw);
  const requestId = await command(
    ctx,
    {
      audit: {
        action: "documents.signature.reinvite",
        entityType: "document_signature",
        entityId: input.signerId,
        summary: "Re-invited a signer",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_signer
        set status = 'pending', token_hash = null, revoked_at = null, revoked_by = null, reminder_count = reminder_count + 1,
            last_reminded_at = now(), row_version = row_version + 1
        where id = ${input.signerId} and org_id = ${ctx.orgId} and status in ('revoked', 'expired', 'invited', 'viewed')
        returning request_id::text as request_id
      `)) as unknown as Array<{ request_id: string }>;
      if (!rows[0]) throw new DocError("signer cannot be re-invited in this state", "state");
      return rows[0].request_id;
    },
  );
  return inviteSigners(ctx, archetype, { requestId, signerId: input.signerId });
}

export async function cancelSignatureRequest(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.issue");
  const input = z
    .object({ requestId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.signature.cancel",
        entityType: "document_signature",
        entityId: input.requestId,
        summary: "Cancelled a signature request",
        after: { reason: input.reason },
      },
    },
    async (tx) => {
      const req = await loadRequestIn(tx, ctx, input.requestId, true);
      if (!["pending", "in_progress"].includes(req.status))
        throw new DocError("request already closed", "state");
      await tx.execute(sql`
        update public.doc_signer set status = 'revoked', revoked_at = now(), revoked_by = ${ctx.userId}, token_hash = null,
          row_version = row_version + 1
        where request_id = ${req.id} and org_id = ${ctx.orgId} and status in ('pending', 'invited', 'viewed')
      `);
      await tx.execute(sql`
        update public.doc_signature_request set status = 'cancelled', cancelled_at = now(), cancel_reason = ${input.reason},
          row_version = row_version + 1
        where id = ${req.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: req.documentId,
        kind: "invitation_revoked",
        payload: { requestId: req.id, reason: input.reason },
      });
      return { id: req.id };
    },
  );
}

// ── signing ───────────────────────────────────────────────────────────────────
export const SignatureCapture = z
  .object({
    kind: z.enum(["typed", "drawn"]),
    /** Typed: the name as signed. Drawn: an SVG path (M/L/Q commands only). */
    data: z.string().min(1).max(20_000),
    name: z.string().trim().min(1).max(200),
    title: z.string().trim().max(120).optional(),
    consent: z.literal(true),
    locale: z.enum(["en", "ar"]).default("en"),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.kind === "drawn" && !/^[MLQZmlqz0-9 .,-]+$/.test(c.data))
      ctx.addIssue({
        code: "custom",
        message: "a drawn signature must be a plain SVG path",
        path: ["data"],
      });
    if (c.kind === "typed" && c.data.length > 200)
      ctx.addIssue({
        code: "custom",
        message: "a typed signature is at most 200 characters",
        path: ["data"],
      });
  });
export type SignatureCapture = z.infer<typeof SignatureCapture>;

export type SigningContext = { ip: string | null; userAgent: string | null };

function buildEvidence(
  signer: SignerRow,
  capture: SignatureCapture,
  ctxInfo: SigningContext,
  verifiedVia: "invitation_token" | "member_session",
  snapshotHash: string,
  at: string,
): Record<string, unknown> {
  return {
    version: 1,
    signerId: signer.id,
    party: signer.party,
    nameAsSigned: capture.name,
    title: capture.title ?? null,
    emailInvited: signer.email,
    verifiedVia,
    delivery: signer.delivery,
    kind: capture.kind,
    at,
    ip: ctxInfo.ip,
    userAgent: ctxInfo.userAgent ? ctxInfo.userAgent.slice(0, 300) : null,
    locale: capture.locale,
    consentVersion: CONSENT_VERSION,
    snapshotHash,
    provider: NATIVE_PROVIDER.name,
    legalLevel: NATIVE_PROVIDER.capabilities.legalLevel,
  };
}

/** Record a signature for one signer inside a transaction; completes the request when it was the last. */
async function recordSignatureIn(
  tx: TenantTx,
  ctx: Ctx,
  signer: SignerRow,
  capture: SignatureCapture,
  ctxInfo: SigningContext,
  verifiedVia: "invitation_token" | "member_session",
): Promise<{ completed: boolean; evidenceHash: string }> {
  const req = await loadRequestIn(tx, ctx, signer.requestId, true);
  if (!["pending", "in_progress"].includes(req.status))
    throw new DocError("this signature request is closed", "state");
  if (new Date(req.expiresAt).getTime() < Date.now())
    throw new DocError("this signature request has expired", "expired");
  const fresh = req.signers.find((s) => s.id === signer.id);
  if (!fresh || !["invited", "viewed"].includes(fresh.status))
    throw new DocError("this invitation is no longer valid", "state");
  if (req.mode === "sequential") {
    const earlier = req.signers.filter(
      (s) => s.orderIndex < fresh.orderIndex && s.status !== "signed",
    );
    if (earlier.length > 0) throw new DocError("an earlier signer has not signed yet", "state");
  }
  const snap = await loadSnapshotIn(tx, ctx, req.documentId);
  if (!snap || snap.id !== req.snapshotId)
    throw new DocError("the document snapshot changed", "conflict");
  const at = new Date().toISOString();
  const evidence = buildEvidence(fresh, capture, ctxInfo, verifiedVia, snap.contentHash, at);
  const evidenceHash = contentHash(evidence);
  const moved = (await tx.execute(sql`
    update public.doc_signer
    set status = 'signed', signed_at = ${at}::timestamptz, signature_kind = ${capture.kind}, signature_data = ${capture.data},
        title = coalesce(${capture.title ?? null}, title), evidence = ${JSON.stringify(evidence)}::jsonb,
        evidence_hash = ${evidenceHash}, token_hash = null, row_version = row_version + 1
    where id = ${fresh.id} and org_id = ${ctx.orgId} and status in ('invited', 'viewed')
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  if (!moved[0]) throw new DocError("this invitation was used concurrently", "conflict");
  await appendEventIn(tx, ctx, {
    documentId: req.documentId,
    kind: "signed",
    actorUserId: verifiedVia === "member_session" ? ctx.userId : null,
    actorLabel: `${capture.name}${fresh.email ? ` <${fresh.email}>` : ""}`,
    payload: {
      signerId: fresh.id,
      party: fresh.party,
      evidenceHash,
      verifiedVia,
      kind: capture.kind,
    },
  });
  const remaining = req.signers.filter((s) => s.id !== fresh.id && s.status !== "signed");
  if (remaining.length === 0) {
    await tx.execute(sql`
      update public.doc_signature_request set status = 'completed', completed_at = now(), row_version = row_version + 1
      where id = ${req.id} and org_id = ${ctx.orgId}
    `);
    await activatedIn(tx, ctx, req.documentId);
    return { completed: true, evidenceHash };
  }
  if (req.mode === "sequential") {
    // Hand the next signer their turn (member: notification; external: token minted by inviteSigners later).
    const next = req.signers.filter(
      (s) => s.orderIndex > fresh.orderIndex && s.status === "pending",
    )[0];
    if (next?.partyKind === "member" && next.userId) {
      await tx.execute(sql`
        update public.doc_signer set status = 'invited', delivery = 'in_app', invited_at = now(), row_version = row_version + 1
        where id = ${next.id} and org_id = ${ctx.orgId}
      `);
      const d = await loadDocIn(tx, ctx, req.documentId);
      await createNotificationIn(tx, ctx, {
        recipientUserId: next.userId,
        kind: "document_signature_requested",
        title: `${d.reference} ${d.title}`,
        entityType: "document",
        entityId: d.id,
      });
    }
  }
  return { completed: false, evidenceHash };
}

/** A member signs their own party from the document page. */
export async function signAsMember(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  ctxInfo: SigningContext,
): Promise<{ completed: boolean; evidenceHash: string }> {
  assertCan(archetype, "documents.sign");
  const input = z.object({ signerId: z.string().uuid(), capture: SignatureCapture }).parse(raw);
  return command(
    ctx,
    {
      audit: (r: { evidenceHash: string }) => ({
        action: "documents.signature.sign",
        entityType: "document_signature",
        entityId: input.signerId,
        summary: `Signed electronically (evidence ${r.evidenceHash.slice(0, 12)})`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select ${SIGNER_COLUMNS} from public.doc_signer s where s.id = ${input.signerId} and s.org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, unknown>>;
      if (!rows[0]) throw new DocError("signer not found", "not_found");
      const signer = mapSigner(rows[0]);
      if (signer.partyKind !== "member" || signer.userId !== ctx.userId)
        throw new DocError("you are not this signer", "forbidden");
      return recordSignatureIn(tx, ctx, signer, input.capture, ctxInfo, "member_session");
    },
  );
}

// ── the public path (token) ───────────────────────────────────────────────────
export type ResolvedSigner = {
  signerId: string;
  orgId: string;
  documentId: string;
  requestId: string;
  status: string;
  party: string;
  name: string;
  email: string | null;
  orderIndex: number;
  requestMode: "sequential" | "parallel";
  requestExpiresAt: string;
};

/** Resolve a raw invitation token through the SECURITY DEFINER resolver (no org context needed). */
export async function resolveSignerToken(rawToken: string): Promise<ResolvedSigner | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(rawToken)) return null;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  // No member context exists here: the SECURITY DEFINER resolver does the
  // authorisation, on a dedicated single-connection client (A-B5), exactly as
  // the public document share does.
  const { createAppDb } = await import("@/platform/tenancy");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select signer_id::text as signer_id, org_id::text as org_id, document_id::text as document_id,
             request_id::text as request_id, status, party, name, email, order_index, request_mode,
             request_expires_at::text as request_expires_at
      from app.resolve_doc_signer(${hash})
    `)) as unknown as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
      signerId: r.signer_id as string,
      orgId: r.org_id as string,
      documentId: r.document_id as string,
      requestId: r.request_id as string,
      status: r.status as string,
      party: r.party as string,
      name: r.name as string,
      email: (r.email as string | null) ?? null,
      orderIndex: Number(r.order_index),
      requestMode: r.request_mode as ResolvedSigner["requestMode"],
      requestExpiresAt: r.request_expires_at as string,
    };
  } finally {
    await end();
  }
}

/** The synthetic context a resolved invitation carries (the H22 share-route precedent). */
export function signerCtx(resolved: ResolvedSigner): Ctx {
  return {
    orgId: resolved.orgId,
    userId: SYNTHETIC_USER,
    costPrivileged: false,
    pricePrivileged: true,
    requestId: `sign-${resolved.signerId}`,
  };
}

export async function markInvitationViewed(
  resolved: ResolvedSigner,
  ctxInfo: SigningContext,
): Promise<void> {
  const ctx = signerCtx(resolved);
  await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.doc_signer set status = 'viewed', viewed_at = coalesce(viewed_at, now()), row_version = row_version + 1
      where id = ${resolved.signerId} and org_id = ${ctx.orgId} and status = 'invited'
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    if (rows[0]) {
      await appendEventIn(tx, ctx, {
        documentId: resolved.documentId,
        kind: "invitation_viewed",
        actorUserId: null,
        actorLabel: resolved.name,
        payload: { signerId: resolved.signerId, party: resolved.party, ip: ctxInfo.ip },
      });
    }
  });
}

/** Sign through a resolved invitation. The token was already validated by the resolver. */
export async function signWithToken(
  resolved: ResolvedSigner,
  raw: unknown,
  ctxInfo: SigningContext,
): Promise<{ completed: boolean; evidenceHash: string }> {
  const capture = SignatureCapture.parse(raw);
  const ctx = signerCtx(resolved);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select ${SIGNER_COLUMNS} from public.doc_signer s where s.id = ${resolved.signerId} and s.org_id = ${ctx.orgId} for update
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) throw new DocError("invitation not found", "not_found");
    return recordSignatureIn(tx, ctx, mapSigner(rows[0]), capture, ctxInfo, "invitation_token");
  });
}

export async function declineWithToken(
  resolved: ResolvedSigner,
  raw: unknown,
  ctxInfo: SigningContext,
): Promise<void> {
  const input = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(raw);
  const ctx = signerCtx(resolved);
  await withCtx(ctx, async (tx) => {
    const moved = (await tx.execute(sql`
      update public.doc_signer
      set status = 'declined', declined_at = now(), decline_reason = ${input.reason}, token_hash = null, row_version = row_version + 1
      where id = ${resolved.signerId} and org_id = ${ctx.orgId} and status in ('invited', 'viewed')
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    if (!moved[0]) throw new DocError("this invitation is no longer valid", "state");
    await tx.execute(sql`
      update public.doc_signature_request set status = 'declined', row_version = row_version + 1
      where id = ${resolved.requestId} and org_id = ${ctx.orgId} and status in ('pending', 'in_progress')
    `);
    await appendEventIn(tx, ctx, {
      documentId: resolved.documentId,
      kind: "declined",
      actorUserId: null,
      actorLabel: resolved.name,
      payload: {
        signerId: resolved.signerId,
        party: resolved.party,
        reason: input.reason,
        ip: ctxInfo.ip,
      },
    });
  });
}

// ── render seam ───────────────────────────────────────────────────────────────
export type SignaturesForRender = { rows: SignatureRender[]; evidenceLines: string[] };

/** Signatures and evidence lines for the PDF / preview of an issued document. */
export async function listSignaturesForRender(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
  locale: "en" | "ar" = "en",
): Promise<SignaturesForRender> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => signaturesForRenderIn(tx, ctx, documentId, locale));
}

export async function signaturesForRenderIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
  locale: "en" | "ar",
): Promise<SignaturesForRender> {
  const req = await latestRequestIn(tx, ctx, documentId);
  if (!req) return { rows: [], evidenceLines: [] };
  const rows: SignatureRender[] = req.signers.map((s) => ({
    party: s.party,
    signerName: s.status === "signed" ? s.name : null,
    signedAt: s.signedAt,
    signatureKind: s.signatureKind,
    signatureData: s.status === "signed" ? s.signatureData : null,
    title: s.title,
  }));
  const provider = getSignatureProvider(req.provider);
  const lines: string[] = [...provider.evidenceLines(locale)];
  for (const s of req.signers) {
    if (s.status !== "signed" || !s.evidence) continue;
    const e = s.evidence as {
      verifiedVia?: string;
      ip?: string | null;
      at?: string;
      delivery?: string;
    };
    lines.push(
      locale === "ar"
        ? `${s.party}: ${s.name} وقّع في ${e.at ?? s.signedAt} (تحقق: ${e.verifiedVia ?? "?"}, IP ${e.ip ?? "?"}, بصمة الإثبات ${s.evidenceHash?.slice(0, 16)})`
        : `${s.party}: ${s.name} signed at ${e.at ?? s.signedAt} (verified via ${e.verifiedVia ?? "?"}, IP ${e.ip ?? "?"}, evidence ${s.evidenceHash?.slice(0, 16)})`,
    );
  }
  return { rows, evidenceLines: lines };
}
