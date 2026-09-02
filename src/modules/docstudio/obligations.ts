/**
 * H26H — obligations, renewals, payments, notices, reviews and risks that an
 * issued document carries. Items live under the document, are evidence-gated
 * on completion, recur when asked, remind on read (due states) and by the
 * daily sweep (notifications), and escalate to a named person. Everything
 * lands in the document's hash-chained timeline.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { appendEventIn } from "./events";
import { getDocSettingsIn } from "./library";
import { DocError } from "./types";

export const OBLIGATION_KINDS = [
  "obligation",
  "payment",
  "renewal",
  "notice",
  "review",
  "risk",
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];
export const OBLIGATION_STATUSES = ["open", "done", "waived", "cancelled"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type DueState = "overdue" | "due_soon" | "upcoming" | "closed";

export type ObligationRow = {
  id: string;
  documentId: string;
  documentReference: string;
  documentTitle: string;
  kind: ObligationKind;
  title: string;
  description: string | null;
  clauseRef: string | null;
  side: "ours" | "theirs";
  ownerUserId: string | null;
  ownerName: string | null;
  dueOn: string;
  recurrenceMonths: number | null;
  amountCents: number | null;
  currency: string | null;
  riskLevel: "low" | "medium" | "high" | null;
  requiresEvidence: boolean;
  status: ObligationStatus;
  completedAt: string | null;
  completedBy: string | null;
  evidenceNote: string | null;
  evidenceFileId: string | null;
  closedReason: string | null;
  escalatedTo: string | null;
  escalatedAt: string | null;
  source: "manual" | "issue" | "template" | "ai";
  linkedRecordType: string | null;
  linkedRecordId: string | null;
  remindersSent: string[];
  rowVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Computed on read against today and the org's reminder window. */
  dueState: DueState;
  daysLeft: number;
};

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ObligationInput = z.object({
  documentId: uuid,
  kind: z.enum(OBLIGATION_KINDS).default("obligation"),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  clauseRef: z.string().trim().max(80).optional().nullable(),
  side: z.enum(["ours", "theirs"]).default("ours"),
  ownerUserId: uuid.optional().nullable(),
  dueOn: isoDate,
  recurrenceMonths: z.number().int().min(1).max(120).optional().nullable(),
  amountCents: z.number().int().min(0).optional().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  riskLevel: z.enum(RISK_LEVELS).optional().nullable(),
  requiresEvidence: z.boolean().default(true),
  linkedRecordType: z
    .enum(["invoice", "payment", "quote", "job", "document"])
    .optional()
    .nullable(),
  linkedRecordId: uuid.optional().nullable(),
});
export type ObligationInput = z.infer<typeof ObligationInput>;

const SELECT = sql`
  select o.id::text as id, o.document_id::text as document_id, d.reference as document_reference,
         d.title as document_title, o.kind, o.title, o.description, o.clause_ref, o.side,
         o.owner_user_id::text as owner_user_id, p.full_name as owner_name,
         o.due_on::text as due_on, o.recurrence_months, o.amount_cents, o.currency, o.risk_level,
         o.requires_evidence, o.status, o.completed_at::text as completed_at,
         o.completed_by::text as completed_by, o.evidence_note, o.evidence_file_id::text as evidence_file_id,
         o.closed_reason, o.escalated_to::text as escalated_to, o.escalated_at::text as escalated_at,
         o.source, o.linked_record_type, o.linked_record_id::text as linked_record_id,
         o.reminders_sent, o.row_version, o.created_by::text as created_by,
         o.created_at::text as created_at, o.updated_at::text as updated_at,
         (o.due_on - current_date)::int as days_left
  from public.doc_obligation o
  join public.doc_document d on d.id = o.document_id and d.org_id = o.org_id
  left join public.user_profile p on p.id = o.owner_user_id
`;

type Raw = Record<string, unknown>;

/** Pure: the due state of an item given days left and the org's warning window. */
export function dueStateOf(status: string, daysLeft: number, soonDays: number): DueState {
  if (status !== "open") return "closed";
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= soonDays) return "due_soon";
  return "upcoming";
}

function rowToObligation(r: Raw, soonDays: number): ObligationRow {
  const daysLeft = Number(r.days_left);
  const status = String(r.status) as ObligationStatus;
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    documentReference: String(r.document_reference),
    documentTitle: String(r.document_title),
    kind: String(r.kind) as ObligationKind,
    title: String(r.title),
    description: (r.description as string | null) ?? null,
    clauseRef: (r.clause_ref as string | null) ?? null,
    side: String(r.side) as "ours" | "theirs",
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    dueOn: String(r.due_on),
    recurrenceMonths: r.recurrence_months === null ? null : Number(r.recurrence_months),
    amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
    currency: (r.currency as string | null) ?? null,
    riskLevel: (r.risk_level as ObligationRow["riskLevel"]) ?? null,
    requiresEvidence: Boolean(r.requires_evidence),
    status,
    completedAt: (r.completed_at as string | null) ?? null,
    completedBy: (r.completed_by as string | null) ?? null,
    evidenceNote: (r.evidence_note as string | null) ?? null,
    evidenceFileId: (r.evidence_file_id as string | null) ?? null,
    closedReason: (r.closed_reason as string | null) ?? null,
    escalatedTo: (r.escalated_to as string | null) ?? null,
    escalatedAt: (r.escalated_at as string | null) ?? null,
    source: String(r.source) as ObligationRow["source"],
    linkedRecordType: (r.linked_record_type as string | null) ?? null,
    linkedRecordId: (r.linked_record_id as string | null) ?? null,
    remindersSent: Array.isArray(r.reminders_sent) ? (r.reminders_sent as string[]) : [],
    rowVersion: Number(r.row_version),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    dueState: dueStateOf(status, daysLeft, soonDays),
    daysLeft,
  };
}

async function soonWindowIn(tx: TenantTx, ctx: Ctx): Promise<number> {
  const s = await getDocSettingsIn(tx, ctx);
  return Math.max(0, ...s.reminderDays);
}

async function loadObligationIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
  soonDays: number,
  lock = false,
): Promise<ObligationRow> {
  const rows = (await tx.execute(
    lock
      ? sql`${SELECT} where o.id = ${id} and o.org_id = ${ctx.orgId} for update of o`
      : sql`${SELECT} where o.id = ${id} and o.org_id = ${ctx.orgId}`,
  )) as unknown as Raw[];
  if (!rows[0]) throw new DocError("obligation not found", "not_found");
  return rowToObligation(rows[0], soonDays);
}

async function documentForObligationIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<{
  id: string;
  title: string;
  status: string;
  issued: boolean;
  ownerUserId: string | null;
}> {
  const rows = (await tx.execute(sql`
    select id::text as id, title, status, (issued_snapshot_id is not null) as issued,
           owner_user_id::text as owner_user_id
    from public.doc_document where id = ${documentId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{
    id: string;
    title: string;
    status: string;
    issued: boolean;
    owner_user_id: string | null;
  }>;
  if (!rows[0]) throw new DocError("document not found", "not_found");
  return { ...rows[0], ownerUserId: rows[0].owner_user_id };
}

// ── reads ─────────────────────────────────────────────────────────────────────
export type ObligationFilter = {
  documentId?: string;
  status?: ObligationStatus[];
  kind?: ObligationKind[];
  ownerUserId?: string;
  dueState?: DueState[];
  from?: string;
  to?: string;
  limit?: number;
};

export async function listObligations(
  ctx: Ctx,
  archetype: RoleArchetype,
  filter: ObligationFilter = {},
): Promise<ObligationRow[]> {
  assertCan(archetype, "documents.view");
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  return withCtx(ctx, async (tx) => {
    const soon = await soonWindowIn(tx, ctx);
    const conds = [sql`o.org_id = ${ctx.orgId}`];
    if (filter.documentId) conds.push(sql`o.document_id = ${filter.documentId}`);
    if (filter.ownerUserId) conds.push(sql`o.owner_user_id = ${filter.ownerUserId}`);
    if (filter.status?.length)
      conds.push(
        sql`o.status in (select x from jsonb_array_elements_text(${JSON.stringify(filter.status)}::jsonb) as x)`,
      );
    if (filter.kind?.length)
      conds.push(
        sql`o.kind in (select x from jsonb_array_elements_text(${JSON.stringify(filter.kind)}::jsonb) as x)`,
      );
    if (filter.from) conds.push(sql`o.due_on >= ${filter.from}::date`);
    if (filter.to) conds.push(sql`o.due_on <= ${filter.to}::date`);
    const rows = (await tx.execute(sql`
      ${SELECT} where ${sql.join(conds, sql` and `)}
      order by (o.status = 'open') desc, o.due_on asc, o.created_at asc
      limit ${limit}
    `)) as unknown as Raw[];
    const out = rows.map((r) => rowToObligation(r, soon));
    return filter.dueState?.length ? out.filter((o) => filter.dueState!.includes(o.dueState)) : out;
  });
}

export async function getObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<ObligationRow> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, async (tx) => loadObligationIn(tx, ctx, id, await soonWindowIn(tx, ctx)));
}

// ── writes ────────────────────────────────────────────────────────────────────
function assertOpenDocument(d: { status: string; issued: boolean }): void {
  if (!d.issued) throw new DocError("obligations attach to an issued document", "state");
  if (d.status === "archived") throw new DocError("the document is archived", "state");
}

export async function createObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ObligationRow> {
  assertCan(archetype, "documents.obligations.manage");
  const input = ObligationInput.parse(raw);
  if (
    (input.amountCents === null || input.amountCents === undefined) !==
    (input.currency === null || input.currency === undefined)
  )
    throw new DocError("amount and currency go together", "validation");
  return command(
    ctx,
    {
      audit: (r: ObligationRow) => ({
        action: "documents.obligation.create",
        entityType: "document_obligation",
        entityId: r.id,
        summary: `Added ${r.kind}: ${r.title}`,
      }),
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "obligation_added",
        summary: input.title,
      },
    },
    async (tx) => {
      const d = await documentForObligationIn(tx, ctx, input.documentId);
      assertOpenDocument(d);
      const rows = (await tx.execute(sql`
        insert into public.doc_obligation
          (org_id, document_id, kind, title, description, clause_ref, side, owner_user_id, due_on,
           recurrence_months, amount_cents, currency, risk_level, requires_evidence,
           linked_record_type, linked_record_id, created_by)
        values (${ctx.orgId}, ${d.id}, ${input.kind}, ${input.title}, ${input.description ?? null},
                ${input.clauseRef ?? null}, ${input.side}, ${input.ownerUserId ?? null}, ${input.dueOn}::date,
                ${input.recurrenceMonths ?? null}, ${input.amountCents ?? null}, ${input.currency ?? null},
                ${input.riskLevel ?? null}, ${input.requiresEvidence},
                ${input.linkedRecordType ?? null}, ${input.linkedRecordId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "obligation_added",
        payload: { obligationId: id, kind: input.kind, title: input.title, dueOn: input.dueOn },
      });
      if (input.ownerUserId && input.ownerUserId !== ctx.userId)
        await createNotificationIn(tx, ctx, {
          recipientUserId: input.ownerUserId,
          kind: "document_obligation_due",
          title: `${input.title} (${input.dueOn})`,
          entityType: "document",
          entityId: d.id,
        });
      return loadObligationIn(tx, ctx, id, await soonWindowIn(tx, ctx));
    },
  );
}

const UpdateInput = ObligationInput.omit({ documentId: true })
  .partial()
  .extend({ id: uuid, rowVersion: z.number().int().min(1) });

export async function updateObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ObligationRow> {
  assertCan(archetype, "documents.obligations.manage");
  const input = UpdateInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.obligation.update",
        entityType: "document_obligation",
        entityId: input.id,
        summary: "Updated an obligation",
      },
    },
    async (tx) => {
      const soon = await soonWindowIn(tx, ctx);
      const o = await loadObligationIn(tx, ctx, input.id, soon, true);
      if (o.status !== "open") throw new DocError("only an open item can be edited", "state");
      if (o.rowVersion !== input.rowVersion)
        throw new DocError("the item changed; reload and try again", "conflict");
      const v = { ...o, ...stripUndefined(input) };
      if ((v.amountCents === null) !== (v.currency === null))
        throw new DocError("amount and currency go together", "validation");
      await tx.execute(sql`
        update public.doc_obligation set
          title = ${v.title}, description = ${v.description}, clause_ref = ${v.clauseRef}, side = ${v.side},
          owner_user_id = ${v.ownerUserId}, due_on = ${v.dueOn}::date, recurrence_months = ${v.recurrenceMonths},
          amount_cents = ${v.amountCents}, currency = ${v.currency}, risk_level = ${v.riskLevel},
          requires_evidence = ${v.requiresEvidence}, linked_record_type = ${v.linkedRecordType},
          linked_record_id = ${v.linkedRecordId}, row_version = row_version + 1
        where id = ${o.id} and org_id = ${ctx.orgId} and row_version = ${input.rowVersion}
      `);
      if (v.ownerUserId && v.ownerUserId !== o.ownerUserId && v.ownerUserId !== ctx.userId)
        await createNotificationIn(tx, ctx, {
          recipientUserId: v.ownerUserId,
          kind: "document_obligation_due",
          title: `${v.title} (${v.dueOn})`,
          entityType: "document",
          entityId: o.documentId,
        });
      return loadObligationIn(tx, ctx, o.id, soon);
    },
  );
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const CompleteInput = z.object({
  id: uuid,
  rowVersion: z.number().int().min(1),
  note: z.string().trim().max(4000).optional().nullable(),
  fileId: uuid.optional().nullable(),
});

/** Evidence-gated: an item that requires evidence needs a note or a file from this organisation. */
export async function completeObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; nextId: string | null }> {
  assertCan(archetype, "documents.obligations.manage");
  const input = CompleteInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.obligation.complete",
        entityType: "document_obligation",
        entityId: input.id,
        summary: "Completed an obligation",
      },
    },
    async (tx) => {
      const soon = await soonWindowIn(tx, ctx);
      const o = await loadObligationIn(tx, ctx, input.id, soon, true);
      if (o.status !== "open") throw new DocError("the item is not open", "state");
      if (o.rowVersion !== input.rowVersion)
        throw new DocError("the item changed; reload and try again", "conflict");
      const note = input.note?.trim() || null;
      if (o.requiresEvidence && !note && !input.fileId)
        throw new DocError("evidence is required: add a note or attach a file", "validation");
      if (input.fileId) {
        const f = (await tx.execute(sql`
          select id::text as id from public.file where id = ${input.fileId} and org_id = ${ctx.orgId}
        `)) as unknown as Array<{ id: string }>;
        if (!f[0]) throw new DocError("evidence file not found", "validation");
      }
      await tx.execute(sql`
        update public.doc_obligation set
          status = 'done', completed_at = now(), completed_by = ${ctx.userId},
          evidence_note = ${note}, evidence_file_id = ${input.fileId ?? null}, row_version = row_version + 1
        where id = ${o.id} and org_id = ${ctx.orgId}
      `);
      let nextId: string | null = null;
      if (o.recurrenceMonths) {
        const next = (await tx.execute(sql`
          insert into public.doc_obligation
            (org_id, document_id, kind, title, description, clause_ref, side, owner_user_id, due_on,
             recurrence_months, amount_cents, currency, risk_level, requires_evidence, source,
             linked_record_type, linked_record_id, created_by)
          values (${ctx.orgId}, ${o.documentId}, ${o.kind}, ${o.title}, ${o.description}, ${o.clauseRef}, ${o.side},
                  ${o.ownerUserId}, (${o.dueOn}::date + make_interval(months => ${o.recurrenceMonths}))::date,
                  ${o.recurrenceMonths}, ${o.amountCents}, ${o.currency}, ${o.riskLevel}, ${o.requiresEvidence},
                  ${o.source}, ${o.linkedRecordType}, ${o.linkedRecordId}, ${ctx.userId})
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        nextId = next[0]!.id;
      }
      await appendEventIn(tx, ctx, {
        documentId: o.documentId,
        kind: "obligation_completed",
        payload: {
          obligationId: o.id,
          title: o.title,
          evidence: { note: note !== null, fileId: input.fileId ?? null },
          nextId,
        },
      });
      return { id: o.id, nextId };
    },
  );
}

const CloseInput = z.object({
  id: uuid,
  rowVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(1000),
});

async function closeObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  status: "waived" | "cancelled",
): Promise<{ id: string }> {
  assertCan(archetype, "documents.obligations.manage");
  const input = CloseInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: `documents.obligation.${status === "waived" ? "waive" : "cancel"}`,
        entityType: "document_obligation",
        entityId: input.id,
        summary: `${status === "waived" ? "Waived" : "Cancelled"} an obligation: ${input.reason}`,
      },
    },
    async (tx) => {
      const soon = await soonWindowIn(tx, ctx);
      const o = await loadObligationIn(tx, ctx, input.id, soon, true);
      if (o.status !== "open") throw new DocError("the item is not open", "state");
      if (o.rowVersion !== input.rowVersion)
        throw new DocError("the item changed; reload and try again", "conflict");
      await tx.execute(sql`
        update public.doc_obligation set status = ${status}, closed_reason = ${input.reason}, row_version = row_version + 1
        where id = ${o.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: o.documentId,
        kind: status === "waived" ? "obligation_waived" : "obligation_cancelled",
        payload: { obligationId: o.id, title: o.title, reason: input.reason },
      });
      return { id: o.id };
    },
  );
}

export const waiveObligation = (ctx: Ctx, archetype: RoleArchetype, raw: unknown) =>
  closeObligation(ctx, archetype, raw, "waived");
export const cancelObligation = (ctx: Ctx, archetype: RoleArchetype, raw: unknown) =>
  closeObligation(ctx, archetype, raw, "cancelled");

const ReopenInput = z.object({ id: uuid, reason: z.string().trim().min(1).max(1000) });

/** Reopening clears the evidence explicitly; the timeline keeps the record. */
export async function reopenObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.obligations.manage");
  const input = ReopenInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.obligation.reopen",
        entityType: "document_obligation",
        entityId: input.id,
        summary: `Reopened an obligation: ${input.reason}`,
      },
    },
    async (tx) => {
      const soon = await soonWindowIn(tx, ctx);
      const o = await loadObligationIn(tx, ctx, input.id, soon, true);
      if (o.status === "open") throw new DocError("the item is already open", "state");
      await tx.execute(sql`
        update public.doc_obligation set
          status = 'open', completed_at = null, completed_by = null, evidence_note = null,
          evidence_file_id = null, closed_reason = null, row_version = row_version + 1
        where id = ${o.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: o.documentId,
        kind: "obligation_reopened",
        payload: { obligationId: o.id, title: o.title, reason: input.reason, previous: o.status },
      });
      return { id: o.id };
    },
  );
}

const EscalateInput = z.object({
  id: uuid,
  toUserId: uuid,
  note: z.string().trim().max(1000).optional().nullable(),
});

export async function escalateObligation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.obligations.manage");
  const input = EscalateInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.obligation.escalate",
        entityType: "document_obligation",
        entityId: input.id,
        summary: "Escalated an obligation",
      },
    },
    async (tx) => {
      const soon = await soonWindowIn(tx, ctx);
      const o = await loadObligationIn(tx, ctx, input.id, soon, true);
      if (o.status !== "open") throw new DocError("the item is not open", "state");
      const member = (await tx.execute(sql`
        select user_id::text as id from public.membership
        where org_id = ${ctx.orgId} and user_id = ${input.toUserId} and deactivated_at is null
      `)) as unknown as Array<{ id: string }>;
      if (!member[0]) throw new DocError("that person is not an active member", "validation");
      await tx.execute(sql`
        update public.doc_obligation set escalated_to = ${input.toUserId}, escalated_at = now(), row_version = row_version + 1
        where id = ${o.id} and org_id = ${ctx.orgId}
      `);
      await createNotificationIn(tx, ctx, {
        recipientUserId: input.toUserId,
        kind: "document_obligation_due",
        title: `Escalated: ${o.title} (${o.dueOn})`,
        body: input.note ?? null,
        entityType: "document",
        entityId: o.documentId,
      });
      await appendEventIn(tx, ctx, {
        documentId: o.documentId,
        kind: "obligation_escalated",
        payload: { obligationId: o.id, title: o.title, toUserId: input.toUserId },
      });
      return { id: o.id };
    },
  );
}

// ── issue-time seeding ────────────────────────────────────────────────────────
/**
 * Called inside the issue transaction: a document with an expiry gets a
 * renewal decision due on that date, owned by the document owner (else the
 * issuer). Evidence is not required for a renewal decision.
 */
export async function seedObligationsAtIssueIn(
  tx: TenantTx,
  ctx: Ctx,
  doc: { id: string; title: string; expiresAt: string | null; ownerUserId: string | null },
): Promise<string[]> {
  if (!doc.expiresAt) return [];
  const rows = (await tx.execute(sql`
    insert into public.doc_obligation
      (org_id, document_id, kind, title, side, owner_user_id, due_on, requires_evidence, source, created_by)
    values (${ctx.orgId}, ${doc.id}, 'renewal', ${`Renewal decision: ${doc.title}`.slice(0, 200)}, 'ours',
            ${doc.ownerUserId ?? ctx.userId}, ${doc.expiresAt}::date, false, 'issue', ${ctx.userId})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const id = rows[0]!.id;
  await appendEventIn(tx, ctx, {
    documentId: doc.id,
    kind: "obligation_added",
    payload: { obligationId: id, kind: "renewal", dueOn: doc.expiresAt, source: "issue" },
  });
  return [id];
}

// ── reminders ─────────────────────────────────────────────────────────────────
/**
 * The daily sweep for one organisation: each open item is reminded at every
 * configured offset (days before due) exactly once, and once more when it
 * turns overdue; an active document with an expiry is reminded the same way.
 * Recipients: the item owner, else the document owner, else the sweep actor.
 */
export async function sendDueReminders(ctx: Ctx): Promise<{ sent: number }> {
  return withCtx(ctx, async (tx) => {
    const settings = await getDocSettingsIn(tx, ctx);
    const offsets = settings.reminderDays;
    let sent = 0;
    const items = (await tx.execute(sql`
      select o.id::text as id, o.document_id::text as document_id, o.title, o.due_on::text as due_on,
             (o.due_on - current_date)::int as days_left, o.reminders_sent,
             coalesce(o.owner_user_id, d.owner_user_id)::text as recipient
      from public.doc_obligation o
      join public.doc_document d on d.id = o.document_id and d.org_id = o.org_id
      where o.org_id = ${ctx.orgId} and o.status = 'open'
        and o.due_on <= current_date + make_interval(days => ${Math.max(0, ...offsets)})
      order by o.due_on asc
      limit 500
    `)) as unknown as Array<{
      id: string;
      document_id: string;
      title: string;
      due_on: string;
      days_left: number;
      reminders_sent: string[];
      recipient: string | null;
    }>;
    for (const it of items) {
      const already = new Set(it.reminders_sent ?? []);
      const tag =
        it.days_left < 0 ? "overdue" : offsets.includes(it.days_left) ? String(it.days_left) : null;
      if (!tag || already.has(tag)) continue;
      await createNotificationIn(tx, ctx, {
        recipientUserId: it.recipient ?? ctx.userId,
        kind: "document_obligation_due",
        title:
          it.days_left < 0
            ? `Overdue: ${it.title} (${it.due_on})`
            : `Due in ${it.days_left} days: ${it.title}`,
        entityType: "document",
        entityId: it.document_id,
      });
      already.add(tag);
      await tx.execute(sql`
        update public.doc_obligation set reminders_sent = ${JSON.stringify([...already])}::jsonb
        where id = ${it.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: it.document_id,
        kind: "reminder_sent",
        payload: { obligationId: it.id, offset: tag },
        actorUserId: null,
      });
      sent++;
    }
    const docs = (await tx.execute(sql`
      select d.id::text as id, d.title, d.expires_at::text as expires_at,
             (d.expires_at - current_date)::int as days_left, d.owner_user_id::text as owner
      from public.doc_document d
      where d.org_id = ${ctx.orgId} and d.status = 'active' and d.expires_at is not null
        and d.expires_at <= current_date + make_interval(days => ${Math.max(0, ...offsets)})
      limit 500
    `)) as unknown as Array<{
      id: string;
      title: string;
      expires_at: string;
      days_left: number;
      owner: string | null;
    }>;
    for (const d of docs) {
      if (!offsets.includes(d.days_left)) continue;
      const tag = String(d.days_left);
      const dup = (await tx.execute(sql`
        select 1 from public.doc_event
        where org_id = ${ctx.orgId} and document_id = ${d.id} and kind = 'reminder_sent'
          and payload->>'expiry' = ${tag}
        limit 1
      `)) as unknown as unknown[];
      if (dup.length) continue;
      await createNotificationIn(tx, ctx, {
        recipientUserId: d.owner ?? ctx.userId,
        kind: "document_obligation_due",
        title: `Expires in ${d.days_left} days: ${d.title} (${d.expires_at})`,
        entityType: "document",
        entityId: d.id,
      });
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "reminder_sent",
        payload: { expiry: tag },
        actorUserId: null,
      });
      sent++;
    }
    return { sent };
  });
}
