/**
 * H26 — the evidence timeline (ADR-21).
 *
 * Every material action on a document appends ONE row inside the same
 * transaction, chained to the previous row by hash. The document row is
 * locked first so two concurrent writers cannot mint the same sequence
 * number; the unique (document_id, seq) index holds if the lock is bypassed.
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { GENESIS_HASH, eventHash, verifyChain, type ChainRow } from "./snapshot";

const SYNTHETIC_USER = "00000000-0000-0000-0000-000000000000";

export type DocEventKind =
  | "created"
  | "revision_frozen"
  | "revision_opened"
  | "submitted_for_review"
  | "review_returned"
  | "review_approved"
  | "approval_started"
  | "approval_step_decided"
  | "approval_completed"
  | "approval_rejected"
  | "issued"
  | "signature_requested"
  | "invitation_sent"
  | "invitation_viewed"
  | "invitation_revoked"
  | "signed"
  | "declined"
  | "activated"
  | "expired"
  | "terminated"
  | "superseded"
  | "archived"
  | "restored"
  | "pdf_rendered"
  | "obligation_added"
  | "obligation_completed"
  | "obligation_waived"
  | "form_submitted"
  | "form_converted"
  | "comment_added"
  | "suggestion_accepted"
  | "suggestion_rejected"
  | "retention_extended"
  | "legal_hold_set";

export type AppendEventInput = {
  documentId: string;
  kind: DocEventKind;
  payload?: Record<string, unknown>;
  /** External participant (no user row), e.g. a signer's name and email. */
  actorLabel?: string | null;
  /** Override the actor (system actions on behalf of nobody pass null). */
  actorUserId?: string | null;
};

export type DocEventRow = {
  id: string;
  seq: number;
  kind: string;
  actorUserId: string | null;
  actorLabel: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
  eventHash: string;
  at: string;
};

/** Append inside the caller's transaction. Returns the new row's seq and hash. */
export async function appendEventIn(
  tx: TenantTx,
  ctx: Ctx,
  input: AppendEventInput,
): Promise<{ seq: number; eventHash: string }> {
  // Serialise writers per document (row lock on the parent).
  const locked = (await tx.execute(sql`
    select id::text as id from public.doc_document
    where id = ${input.documentId} and org_id = ${ctx.orgId}
    for update
  `)) as unknown as Array<{ id: string }>;
  if (!locked[0]) throw new Error("document not found for event");
  const last = (await tx.execute(sql`
    select seq, event_hash from public.doc_event
    where document_id = ${input.documentId} and org_id = ${ctx.orgId}
    order by seq desc limit 1
  `)) as unknown as Array<{ seq: number; event_hash: string }>;
  const prevHash = last[0]?.event_hash ?? GENESIS_HASH;
  const seq = (last[0]?.seq ?? 0) + 1;
  const at = new Date().toISOString();
  // The public signing path runs under a synthetic org context (no member);
  // its events carry an actor label, never a user id that has no profile row.
  const actorUserId =
    input.actorUserId === undefined
      ? ctx.userId === SYNTHETIC_USER
        ? null
        : ctx.userId
      : input.actorUserId;
  const actorLabel = input.actorLabel ?? null;
  const payload = input.payload ?? {};
  const hash = eventHash(prevHash, {
    documentId: input.documentId,
    seq,
    kind: input.kind,
    actorUserId,
    actorLabel,
    payload,
    at,
  });
  await tx.execute(sql`
    insert into public.doc_event
      (org_id, document_id, seq, kind, actor_user_id, actor_label, payload, prev_hash, event_hash, at)
    values (${ctx.orgId}, ${input.documentId}, ${seq}, ${input.kind}, ${actorUserId}, ${actorLabel},
            ${JSON.stringify(payload)}::jsonb, ${prevHash}, ${hash}, ${at}::timestamptz)
  `);
  return { seq, eventHash: hash };
}

export async function listEventsIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<DocEventRow[]> {
  const rows = (await tx.execute(sql`
    select id::text as id, seq, kind, actor_user_id::text as actor_user_id, actor_label, payload,
           prev_hash, event_hash, at::text as at
    from public.doc_event
    where document_id = ${documentId} and org_id = ${ctx.orgId}
    order by seq
  `)) as unknown as Array<{
    id: string;
    seq: number;
    kind: string;
    actor_user_id: string | null;
    actor_label: string | null;
    payload: Record<string, unknown>;
    prev_hash: string;
    event_hash: string;
    at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    kind: r.kind,
    actorUserId: r.actor_user_id,
    actorLabel: r.actor_label,
    payload: r.payload ?? {},
    prevHash: r.prev_hash,
    eventHash: r.event_hash,
    at: new Date(r.at).toISOString(),
  }));
}

/** Recompute the chain from the stored rows. */
export function verifyEventRows(
  documentId: string,
  rows: readonly DocEventRow[],
): ReturnType<typeof verifyChain> {
  const chain: ChainRow[] = rows.map((r) => ({
    documentId,
    seq: r.seq,
    kind: r.kind,
    actorUserId: r.actorUserId,
    actorLabel: r.actorLabel,
    payload: r.payload,
    at: r.at,
    prevHash: r.prevHash,
    eventHash: r.eventHash,
  }));
  return verifyChain(chain);
}
