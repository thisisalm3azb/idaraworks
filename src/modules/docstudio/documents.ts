/**
 * H26 — the document lifecycle (ADR-20/21).
 *
 *   draft ──submit──▶ review ──approve/return──▶ draft | approval (0115)
 *   draft|review|approval ──issue──▶ signature (has signature blocks) | active
 *   signature ──all signed──▶ active
 *   active ──expires_at passed──▶ expired (derived, stamped on read paths)
 *   active|expired ──terminate──▶ terminated
 *   any issued ──successor issued──▶ superseded
 *   draft|expired|terminated|superseded ──archive──▶ archived
 *
 * Content lives in revisions; one is `working` (editable) and the rest are
 * frozen with a content hash. Issuing writes the immutable snapshot; the
 * database refuses to change it afterwards. Every transition appends a
 * hash-chained event in the same transaction.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan, can } from "@/platform/authz";
import { captureIssuerSnapshot } from "@/platform/documents/issuer";
import { requireCapability } from "@/platform/entitlements";
import { allocateReference, formatRef } from "@/platform/reference/sequence";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { getDocumentProfile } from "@/modules/branding/service";
import { resolveValues, type DocFacts } from "./bindings";
import { appendEventIn, listEventsIn, verifyEventRows, type DocEventRow } from "./events";
import { getDocSettingsIn } from "./library";
import { visibleBlocks, type ResolvedValues } from "./render";
import { contentHash } from "./snapshot";
import { templateBodyIn } from "./templates";
import { cancelRunIn, startRunIn } from "./workflow-runs";
import {
  COUNTERPARTY_KINDS,
  DEFAULT_SETTINGS,
  DOC_CATEGORIES,
  DOC_LANGUAGES,
  DOC_STATUSES,
  DocBody,
  DocError,
  DocSettings,
  DocVariables,
  LINKABLE_RECORDS,
  bodyPlainText,
  fieldBlocks,
  signatureParties,
  type Block,
  type DocStatus,
} from "./types";

// ── rows ──────────────────────────────────────────────────────────────────────
export type DocumentRow = {
  id: string;
  reference: string;
  title: string;
  category: string;
  language: string;
  status: DocStatus;
  /** `expired` when active past its expiry, otherwise the stored status. */
  effectiveStatus: DocStatus;
  folderId: string | null;
  tags: string[];
  templateId: string | null;
  workflowId: string | null;
  workingRevisionId: string | null;
  issuedSnapshotId: string | null;
  issuedAt: string | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  counterpartyKind: string | null;
  counterpartyId: string | null;
  counterpartyLabel: string | null;
  recordType: string | null;
  recordId: string | null;
  ownerUserId: string | null;
  supersedesDocumentId: string | null;
  supersededByDocumentId: string | null;
  retentionUntil: string | null;
  legalHold: boolean;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type RevisionRow = {
  id: string;
  revisionNo: number;
  state: "working" | "frozen";
  body: DocBody;
  variables: DocVariables;
  settings: DocSettings;
  contentHash: string | null;
  note: string | null;
  frozenAt: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotRow = {
  id: string;
  revisionId: string;
  snapshot: IssuedSnapshot;
  contentHash: string;
  issuedAt: string;
  issuedBy: string;
};

/** The issued document exactly as issued (ADR-20). */
export type IssuedSnapshot = {
  version: 1;
  document: DocFacts & { parties: string[] };
  issuer: ReturnType<typeof captureIssuerSnapshot>;
  branding: { logoFileId: string | null; accentColor: string | null };
  body: DocBody;
  values: ResolvedValues;
  settings: DocSettings;
  fonts: string[];
  issuedAt: string;
};

export type DocumentDetail = {
  document: DocumentRow;
  working: RevisionRow | null;
  revisions: Array<
    Pick<
      RevisionRow,
      "id" | "revisionNo" | "state" | "contentHash" | "note" | "frozenAt" | "createdAt"
    >
  >;
  snapshot: SnapshotRow | null;
  events: DocEventRow[];
  chain: ReturnType<typeof verifyEventRows>;
};

function mapDoc(r: Record<string, unknown>): DocumentRow {
  const status = r.status as DocStatus;
  const expires = (r.expires_at as string | null) ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const effectiveStatus: DocStatus =
    status === "active" && expires !== null && expires < today ? "expired" : status;
  return {
    id: r.id as string,
    reference: r.reference as string,
    title: r.title as string,
    category: r.category as string,
    language: r.language as string,
    status,
    effectiveStatus,
    folderId: (r.folder_id as string | null) ?? null,
    tags: (r.tags as string[]) ?? [],
    templateId: (r.template_id as string | null) ?? null,
    workflowId: (r.workflow_id as string | null) ?? null,
    workingRevisionId: (r.working_revision_id as string | null) ?? null,
    issuedSnapshotId: (r.issued_snapshot_id as string | null) ?? null,
    issuedAt: (r.issued_at as string | null) ?? null,
    effectiveFrom: (r.effective_from as string | null) ?? null,
    expiresAt: expires,
    counterpartyKind: (r.counterparty_kind as string | null) ?? null,
    counterpartyId: (r.counterparty_id as string | null) ?? null,
    counterpartyLabel: (r.counterparty_label as string | null) ?? null,
    recordType: (r.record_type as string | null) ?? null,
    recordId: (r.record_id as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    supersedesDocumentId: (r.supersedes_document_id as string | null) ?? null,
    supersededByDocumentId: (r.superseded_by_document_id as string | null) ?? null,
    retentionUntil: (r.retention_until as string | null) ?? null,
    legalHold: Boolean(r.legal_hold),
    rowVersion: Number(r.row_version),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const DOC_COLUMNS = sql`
  d.id::text as id, d.reference, d.title, d.category, d.language, d.status,
  d.folder_id::text as folder_id, d.tags, d.template_id::text as template_id,
  d.workflow_id::text as workflow_id, d.working_revision_id::text as working_revision_id,
  d.issued_snapshot_id::text as issued_snapshot_id, d.issued_at::text as issued_at,
  d.effective_from::text as effective_from, d.expires_at::text as expires_at,
  d.counterparty_kind, d.counterparty_id::text as counterparty_id, d.counterparty_label,
  d.record_type, d.record_id::text as record_id, d.owner_user_id::text as owner_user_id,
  d.supersedes_document_id::text as supersedes_document_id,
  d.superseded_by_document_id::text as superseded_by_document_id,
  d.retention_until::text as retention_until, d.legal_hold, d.row_version,
  d.created_at::text as created_at, d.updated_at::text as updated_at`;

/** drizzle expands a JS array into a tuple; a text[] must travel as JSON. */
const textArray = (arr: readonly string[]) =>
  sql`(select coalesce(array_agg(x), '{}'::text[]) from jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb) as x)`;

export async function loadDocIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
  lock = false,
): Promise<DocumentRow> {
  const rows = (await tx.execute(
    lock
      ? sql`select ${DOC_COLUMNS} from public.doc_document d where d.id = ${documentId} and d.org_id = ${ctx.orgId} for update`
      : sql`select ${DOC_COLUMNS} from public.doc_document d where d.id = ${documentId} and d.org_id = ${ctx.orgId}`,
  )) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new DocError("document not found", "not_found");
  return mapDoc(rows[0]);
}

function mapRevision(r: Record<string, unknown>): RevisionRow {
  return {
    id: r.id as string,
    revisionNo: Number(r.revision_no),
    state: r.state as "working" | "frozen",
    body: DocBody.safeParse(r.body).data ?? { blocks: [] },
    variables: DocVariables.safeParse(r.variables).data ?? {},
    settings: DocSettings.safeParse(r.settings).data ?? DEFAULT_SETTINGS,
    contentHash: (r.content_hash as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    frozenAt: (r.frozen_at as string | null) ?? null,
    rowVersion: Number(r.row_version),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function loadRevisionIn(
  tx: TenantTx,
  ctx: Ctx,
  revisionId: string,
): Promise<RevisionRow> {
  const rows = (await tx.execute(sql`
    select id::text as id, revision_no, state, body, variables, settings, content_hash, note,
           frozen_at::text as frozen_at, row_version, created_at::text as created_at, updated_at::text as updated_at
    from public.doc_revision where id = ${revisionId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new DocError("revision not found", "not_found");
  return mapRevision(rows[0]);
}

async function latestRevisionIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<RevisionRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id, revision_no, state, body, variables, settings, content_hash, note,
           frozen_at::text as frozen_at, row_version, created_at::text as created_at, updated_at::text as updated_at
    from public.doc_revision where document_id = ${documentId} and org_id = ${ctx.orgId}
    order by revision_no desc limit 1
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapRevision(rows[0]) : null;
}

export function factsOf(d: DocumentRow): DocFacts {
  return {
    id: d.id,
    reference: d.reference,
    title: d.title,
    category: d.category,
    language: d.language,
    issuedAt: d.issuedAt,
    effectiveFrom: d.effectiveFrom,
    expiresAt: d.expiresAt,
    counterpartyKind: d.counterpartyKind,
    counterpartyId: d.counterpartyId,
    counterpartyLabel: d.counterpartyLabel,
    recordType: d.recordType,
    recordId: d.recordId,
  };
}

async function refreshSearchIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  body?: DocBody,
): Promise<void> {
  const text = [
    d.title,
    d.reference,
    d.tags.join(" "),
    d.counterpartyLabel ?? "",
    body ? bodyPlainText(body) : "",
  ]
    .join("\n")
    .slice(0, 300_000);
  await tx.execute(sql`
    update public.doc_document set search_text = ${text}
    where id = ${d.id} and org_id = ${ctx.orgId}
  `);
}

// ── create ────────────────────────────────────────────────────────────────────
const CounterpartyInput = z
  .object({
    kind: z.enum(COUNTERPARTY_KINDS),
    id: z.string().uuid().nullable().optional(),
    label: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .nullable();
const RecordInput = z
  .object({ type: z.enum(LINKABLE_RECORDS), id: z.string().uuid() })
  .strict()
  .nullable();

export const CreateDocumentInput = z
  .object({
    title: z.string().trim().min(1).max(240),
    category: z.enum(DOC_CATEGORIES).default("other"),
    language: z.enum(DOC_LANGUAGES).default("en"),
    templateId: z.string().uuid().optional(),
    builtinKey: z
      .string()
      .regex(/^[a-z0-9_.-]{1,60}$/)
      .optional(),
    body: DocBody.optional(),
    settings: DocSettings.partial().optional(),
    folderId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    counterparty: CounterpartyInput.optional(),
    record: RecordInput.optional(),
    workflowId: z.string().uuid().nullable().optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    supersedesDocumentId: z.string().uuid().optional(),
  })
  .strict();
export type CreateDocumentInput = z.infer<typeof CreateDocumentInput>;

export async function createDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string; revisionId: string }> {
  assertCan(archetype, "documents.create");
  await requireCapability(ctx, "cap.documents");
  const input = CreateDocumentInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string; reference: string }) => ({
        action: "documents.create",
        entityType: "document",
        entityId: r.id,
        summary: `Created document ${r.reference} "${input.title}"`,
      }),
      activity: (r: { id: string; reference: string }) => ({
        entityType: "document",
        entityId: r.id,
        verb: "created",
        summary: `${r.reference} created`,
      }),
    },
    async (tx) => {
      let body: DocBody = input.body ?? { blocks: [] };
      let settings: DocSettings = DocSettings.parse({
        ...DEFAULT_SETTINGS,
        ...(input.settings ?? {}),
      });
      let templateVersionId: string | null = null;
      let templateId: string | null = null;
      if (input.templateId || input.builtinKey) {
        const t = await templateBodyIn(tx, ctx, {
          templateId: input.templateId,
          builtinKey: input.builtinKey,
        });
        body = t.body;
        settings = DocSettings.parse({ ...t.settings, ...(input.settings ?? {}) });
        templateVersionId = t.versionId;
        templateId = t.templateId;
      }
      if (input.supersedesDocumentId) {
        const prev = await loadDocIn(tx, ctx, input.supersedesDocumentId);
        if (!prev.issuedSnapshotId)
          throw new DocError("only an issued document can be superseded", "state");
        if (prev.supersededByDocumentId)
          throw new DocError("that document already has a successor", "state");
        const snap = await loadSnapshotIn(tx, ctx, prev.id);
        body = snap?.snapshot.body ?? body;
        settings = snap?.snapshot.settings ?? settings;
      }
      const seq = await allocateReference(tx, ctx, "document");
      const reference = formatRef("DOC", seq, 3);
      const cp = input.counterparty ?? null;
      const rows = (await tx.execute(sql`
        insert into public.doc_document
          (org_id, reference, title, category, language, folder_id, tags, template_id, template_version_id,
           workflow_id, effective_from, expires_at, counterparty_kind, counterparty_id, counterparty_label,
           record_type, record_id, owner_user_id, supersedes_document_id, created_by)
        values (${ctx.orgId}, ${reference}, ${input.title}, ${input.category}, ${input.language},
                ${input.folderId ?? null}, ${textArray(input.tags)}, ${templateId}, ${templateVersionId},
                ${input.workflowId ?? null}, ${input.effectiveFrom ?? null}, ${input.expiresAt ?? null},
                ${cp?.kind ?? null}, ${cp?.id ?? null}, ${cp?.label ?? null},
                ${input.record?.type ?? null}, ${input.record?.id ?? null}, ${ctx.userId},
                ${input.supersedesDocumentId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      const rev = (await tx.execute(sql`
        insert into public.doc_revision (org_id, document_id, revision_no, body, variables, settings, body_text, created_by)
        values (${ctx.orgId}, ${id}, 1, ${JSON.stringify(body)}::jsonb, '{}'::jsonb,
                ${JSON.stringify(settings)}::jsonb, ${bodyPlainText(body)}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        update public.doc_document set working_revision_id = ${rev[0]!.id}
        where id = ${id} and org_id = ${ctx.orgId}
      `);
      const d = await loadDocIn(tx, ctx, id);
      await refreshSearchIn(tx, ctx, d, body);
      await appendEventIn(tx, ctx, {
        documentId: id,
        kind: "created",
        payload: {
          reference,
          templateId,
          templateVersionId,
          supersedes: input.supersedesDocumentId ?? null,
        },
      });
      return { id, reference, revisionId: rev[0]!.id };
    },
  );
}

// ── read ──────────────────────────────────────────────────────────────────────
export async function loadSnapshotIn(
  tx: TenantTx,
  ctx: Ctx,
  documentId: string,
): Promise<SnapshotRow | null> {
  const rows = (await tx.execute(sql`
    select id::text as id, revision_id::text as revision_id, snapshot, content_hash,
           issued_at::text as issued_at, issued_by::text as issued_by
    from public.doc_snapshot where document_id = ${documentId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    revisionId: r.revision_id as string,
    snapshot: r.snapshot as IssuedSnapshot,
    contentHash: r.content_hash as string,
    issuedAt: r.issued_at as string,
    issuedBy: r.issued_by as string,
  };
}

export async function getDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<DocumentDetail> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, async (tx) => {
    const document = await loadDocIn(tx, ctx, documentId);
    const working = document.workingRevisionId
      ? await loadRevisionIn(tx, ctx, document.workingRevisionId)
      : null;
    const revRows = (await tx.execute(sql`
      select id::text as id, revision_no, state, content_hash, note, frozen_at::text as frozen_at,
             created_at::text as created_at
      from public.doc_revision where document_id = ${documentId} and org_id = ${ctx.orgId}
      order by revision_no
    `)) as unknown as Array<Record<string, unknown>>;
    const revisions = revRows.map((r) => ({
      id: r.id as string,
      revisionNo: Number(r.revision_no),
      state: r.state as "working" | "frozen",
      contentHash: (r.content_hash as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      frozenAt: (r.frozen_at as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
    const snapshot = await loadSnapshotIn(tx, ctx, documentId);
    const events = await listEventsIn(tx, ctx, documentId);
    return {
      document,
      working,
      revisions,
      snapshot,
      events,
      chain: verifyEventRows(documentId, events),
    };
  });
}

export async function getRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  revisionId: string,
): Promise<RevisionRow> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => loadRevisionIn(tx, ctx, revisionId));
}

export const ListDocumentsInput = z
  .object({
    status: z.array(z.enum(DOC_STATUSES)).max(10).optional(),
    category: z.array(z.enum(DOC_CATEGORIES)).max(10).optional(),
    folderId: z.string().uuid().nullable().optional(),
    tag: z.string().max(40).optional(),
    counterpartyKind: z.enum(COUNTERPARTY_KINDS).optional(),
    counterpartyId: z.string().uuid().optional(),
    recordType: z.enum(LINKABLE_RECORDS).optional(),
    recordId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
    sort: z.enum(["updated", "created", "title", "expires"]).default("updated"),
    limit: z.number().int().min(1).max(500).default(50),
    offset: z.number().int().min(0).default(0),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export type ListDocumentsInput = z.infer<typeof ListDocumentsInput>;

export async function listDocuments(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown = {},
): Promise<{ rows: DocumentRow[]; hasMore: boolean; total: number }> {
  assertCan(archetype, "documents.view");
  const f = ListDocumentsInput.parse(raw);
  const statuses = f.status ?? [];
  const categories = f.category ?? [];
  const search = f.search ?? "";
  const order =
    f.sort === "title"
      ? sql`d.title asc`
      : f.sort === "created"
        ? sql`d.created_at desc`
        : f.sort === "expires"
          ? sql`d.expires_at asc nulls last`
          : sql`d.updated_at desc`;
  return withCtx(ctx, async (tx) => {
    const where = sql`
      d.org_id = ${ctx.orgId}
      and (${f.includeArchived} or d.status <> 'archived')
      and (${statuses.length === 0} or d.status = any(string_to_array(${statuses.join(",")}, ',')))
      and (${categories.length === 0} or d.category = any(string_to_array(${categories.join(",")}, ',')))
      and (${f.folderId === undefined} or d.folder_id is not distinct from ${f.folderId ?? null})
      and (${!f.tag} or ${f.tag ?? ""} = any(d.tags))
      and (${!f.counterpartyKind} or d.counterparty_kind = ${f.counterpartyKind ?? null})
      and (${!f.counterpartyId} or d.counterparty_id = ${f.counterpartyId ?? null})
      and (${!f.recordType} or d.record_type = ${f.recordType ?? null})
      and (${!f.recordId} or d.record_id = ${f.recordId ?? null})
      and (${search === ""} or d.search @@ plainto_tsquery('simple', ${search})
           or d.title ilike ${"%" + search + "%"} or d.reference ilike ${"%" + search + "%"})`;
    const rows = (await tx.execute(sql`
      select ${DOC_COLUMNS} from public.doc_document d
      where ${where}
      order by ${order}
      limit ${f.limit + 1} offset ${f.offset}
    `)) as unknown as Array<Record<string, unknown>>;
    const count = (await tx.execute(sql`
      select count(*)::int as n from public.doc_document d where ${where}
    `)) as unknown as Array<{ n: number }>;
    return {
      rows: rows.slice(0, f.limit).map(mapDoc),
      hasMore: rows.length > f.limit,
      total: Number(count[0]?.n ?? 0),
    };
  });
}

// ── edit ──────────────────────────────────────────────────────────────────────
export const UpdateDocumentInput = z
  .object({
    documentId: z.string().uuid(),
    expectedRowVersion: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    category: z.enum(DOC_CATEGORIES).optional(),
    language: z.enum(DOC_LANGUAGES).optional(),
    folderId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    counterparty: CounterpartyInput.optional(),
    record: RecordInput.optional(),
    workflowId: z.string().uuid().nullable().optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** Metadata that belongs to the document (not its content). Some fields are frozen after issue. */
export async function updateDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number }> {
  assertCan(archetype, "documents.edit");
  const input = UpdateDocumentInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.update",
        entityType: "document",
        entityId: input.documentId,
        summary: "Updated document details",
        after: { ...input, documentId: undefined },
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (input.expectedRowVersion !== undefined && d.rowVersion !== input.expectedRowVersion)
        throw new DocError("document changed since you loaded it", "conflict");
      const issued = d.issuedSnapshotId !== null;
      const frozenField =
        input.title !== undefined ||
        input.category !== undefined ||
        input.language !== undefined ||
        input.counterparty !== undefined ||
        input.record !== undefined ||
        input.workflowId !== undefined ||
        input.effectiveFrom !== undefined;
      if (issued && frozenField)
        throw new DocError(
          "an issued document keeps its identity; create a successor",
          "immutable",
        );
      if (d.status === "archived") throw new DocError("archived documents are read-only", "state");
      const cp = input.counterparty;
      await tx.execute(sql`
        update public.doc_document set
          title = coalesce(${input.title ?? null}, title),
          category = coalesce(${input.category ?? null}, category),
          language = coalesce(${input.language ?? null}, language),
          folder_id = case when ${input.folderId !== undefined} then ${input.folderId ?? null} else folder_id end,
          tags = case when ${input.tags !== undefined} then ${textArray(input.tags ?? [])} else tags end,
          counterparty_kind = case when ${cp !== undefined} then ${cp?.kind ?? null} else counterparty_kind end,
          counterparty_id = case when ${cp !== undefined} then ${cp?.id ?? null} else counterparty_id end,
          counterparty_label = case when ${cp !== undefined} then ${cp?.label ?? null} else counterparty_label end,
          record_type = case when ${input.record !== undefined} then ${input.record?.type ?? null} else record_type end,
          record_id = case when ${input.record !== undefined} then ${input.record?.id ?? null} else record_id end,
          workflow_id = case when ${input.workflowId !== undefined} then ${input.workflowId ?? null} else workflow_id end,
          effective_from = case when ${input.effectiveFrom !== undefined} then ${input.effectiveFrom ?? null} else effective_from end,
          expires_at = case when ${input.expiresAt !== undefined} then ${input.expiresAt ?? null} else expires_at end,
          owner_user_id = case when ${input.ownerUserId !== undefined} then ${input.ownerUserId ?? null} else owner_user_id end,
          row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      const after = await loadDocIn(tx, ctx, d.id);
      const latest = await latestRevisionIn(tx, ctx, d.id);
      await refreshSearchIn(tx, ctx, after, latest?.body);
      return { rowVersion: after.rowVersion };
    },
  );
}

export const SaveRevisionInput = z
  .object({
    documentId: z.string().uuid(),
    revisionId: z.string().uuid(),
    expectedRowVersion: z.number().int().positive(),
    body: DocBody.optional(),
    variables: DocVariables.optional(),
    settings: DocSettings.optional(),
  })
  .strict();

/** Autosave of the working revision. Refuses silently-stale writes (ADR-31). */
export async function saveRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ rowVersion: number; savedAt: string }> {
  assertCan(archetype, "documents.edit");
  const input = SaveRevisionInput.parse(raw);
  return withCtx(ctx, async (tx) => {
    // Content saves are frequent; they are not individually audited (the
    // freeze that follows records the content hash and the author).
    const d = await loadDocIn(tx, ctx, input.documentId, true);
    if (d.workingRevisionId !== input.revisionId)
      throw new DocError("that revision is not the working revision", "state");
    if (d.status !== "draft") throw new DocError("the document is not in draft", "state");
    const rev = await loadRevisionIn(tx, ctx, input.revisionId);
    if (rev.state !== "working") throw new DocError("revision is frozen", "immutable");
    if (rev.rowVersion !== input.expectedRowVersion)
      throw new DocError("revision changed since you loaded it", "conflict");
    const body = input.body ?? rev.body;
    const rows = (await tx.execute(sql`
      update public.doc_revision set
        body = ${JSON.stringify(body)}::jsonb,
        variables = ${JSON.stringify(input.variables ?? rev.variables)}::jsonb,
        settings = ${JSON.stringify(input.settings ?? rev.settings)}::jsonb,
        body_text = ${bodyPlainText(body)},
        row_version = row_version + 1, updated_by = ${ctx.userId}
      where id = ${rev.id} and org_id = ${ctx.orgId} and state = 'working'
      returning row_version, updated_at::text as updated_at
    `)) as unknown as Array<{ row_version: number; updated_at: string }>;
    if (!rows[0]) throw new DocError("revision changed since you loaded it", "conflict");
    if (input.body) await refreshSearchIn(tx, ctx, d, body);
    return { rowVersion: Number(rows[0].row_version), savedAt: rows[0].updated_at };
  });
}

/** Freeze the working revision (content hash recorded). Returns the frozen revision. */
async function freezeWorkingIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  note: string | null,
): Promise<RevisionRow> {
  if (!d.workingRevisionId) throw new DocError("no working revision", "state");
  const rev = await loadRevisionIn(tx, ctx, d.workingRevisionId);
  if (rev.state === "frozen") return rev;
  const hash = contentHash({ body: rev.body, variables: rev.variables, settings: rev.settings });
  await tx.execute(sql`
    update public.doc_revision
    set state = 'frozen', content_hash = ${hash}, frozen_at = now(), frozen_by = ${ctx.userId},
        note = coalesce(${note}, note), row_version = row_version + 1, updated_by = ${ctx.userId}
    where id = ${rev.id} and org_id = ${ctx.orgId} and state = 'working'
  `);
  await appendEventIn(tx, ctx, {
    documentId: d.id,
    kind: "revision_frozen",
    payload: { revisionId: rev.id, revisionNo: rev.revisionNo, contentHash: hash },
  });
  return loadRevisionIn(tx, ctx, rev.id);
}

/** Open a new working revision based on the latest frozen one. */
export async function openWorkingIn(tx: TenantTx, ctx: Ctx, d: DocumentRow): Promise<RevisionRow> {
  const latest = await latestRevisionIn(tx, ctx, d.id);
  if (!latest) throw new DocError("document has no revisions", "state");
  if (latest.state === "working") return latest;
  const rows = (await tx.execute(sql`
    insert into public.doc_revision
      (org_id, document_id, revision_no, body, variables, settings, body_text, based_on_revision_id, created_by)
    values (${ctx.orgId}, ${d.id}, ${latest.revisionNo + 1}, ${JSON.stringify(latest.body)}::jsonb,
            ${JSON.stringify(latest.variables)}::jsonb, ${JSON.stringify(latest.settings)}::jsonb,
            ${bodyPlainText(latest.body)}, ${latest.id}, ${ctx.userId})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  await tx.execute(sql`
    update public.doc_document set working_revision_id = ${rows[0]!.id}, row_version = row_version + 1,
      updated_by = ${ctx.userId}
    where id = ${d.id} and org_id = ${ctx.orgId}
  `);
  await appendEventIn(tx, ctx, {
    documentId: d.id,
    kind: "revision_opened",
    payload: { revisionId: rows[0]!.id, revisionNo: latest.revisionNo + 1, basedOn: latest.id },
  });
  return loadRevisionIn(tx, ctx, rows[0]!.id);
}

async function setStatusIn(
  tx: TenantTx,
  ctx: Ctx,
  d: DocumentRow,
  status: DocStatus,
): Promise<void> {
  await tx.execute(sql`
    update public.doc_document set status = ${status}, row_version = row_version + 1, updated_by = ${ctx.userId}
    where id = ${d.id} and org_id = ${ctx.orgId}
  `);
}

// ── review ────────────────────────────────────────────────────────────────────
export async function submitForReview(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ revisionId: string }> {
  assertCan(archetype, "documents.edit");
  const input = z
    .object({ documentId: z.string().uuid(), note: z.string().trim().max(1000).optional() })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.submit_review",
        entityType: "document",
        entityId: input.documentId,
        summary: "Submitted document for review",
      },
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "submitted",
        summary: "submitted for review",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.status !== "draft")
        throw new DocError("only a draft can be submitted for review", "state");
      const rev = await freezeWorkingIn(tx, ctx, d, input.note ?? null);
      validateForIssue(rev);
      // A workflow (the document’s own, else its template’s default) starts here;
      // the first active step decides whether the document waits in review or approval.
      const started = await startRunIn(tx, ctx, d, rev);
      await setStatusIn(tx, ctx, d, started ? started.initialStatus : "review");
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "submitted_for_review",
        payload: { revisionId: rev.id },
      });
      return { revisionId: rev.id };
    },
  );
}

/** A reviewer sends the document back with a note; a new working revision opens. */
export async function returnToDraft(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ revisionId: string }> {
  assertCan(archetype, "documents.review");
  const input = z
    .object({ documentId: z.string().uuid(), note: z.string().trim().min(1).max(2000) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.review.return",
        entityType: "document",
        entityId: input.documentId,
        summary: "Returned document to draft",
        after: { note: input.note },
      },
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "returned",
        summary: "returned for changes",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.status !== "review" && d.status !== "approval")
        throw new DocError("document is not under review", "state");
      if (d.issuedSnapshotId)
        throw new DocError("an issued document cannot return to draft", "immutable");
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "review_returned",
        payload: { note: input.note },
      });
      await cancelRunIn(tx, ctx, d.id, input.note);
      await setStatusIn(tx, ctx, d, "draft");
      const rev = await openWorkingIn(tx, ctx, await loadDocIn(tx, ctx, d.id));
      return { revisionId: rev.id };
    },
  );
}

/** Reopen a draft's frozen content for editing (e.g. after a review was approved but before issue). */
export async function reopenForEditing(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ revisionId: string }> {
  assertCan(archetype, "documents.edit");
  const input = z.object({ documentId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.reopen",
        entityType: "document",
        entityId: input.documentId,
        summary: "Reopened for editing",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.status !== "draft" && d.status !== "review")
        throw new DocError("cannot reopen in this state", "state");
      if (d.issuedSnapshotId)
        throw new DocError("an issued document cannot be edited", "immutable");
      if (d.status === "review") await setStatusIn(tx, ctx, d, "draft");
      const rev = await openWorkingIn(tx, ctx, await loadDocIn(tx, ctx, d.id));
      return { revisionId: rev.id };
    },
  );
}

/** Content rules an issued document must satisfy. */
export function validateForIssue(rev: RevisionRow): void {
  const problems: string[] = [];
  for (const f of fieldBlocks(rev.body)) {
    if (f.filledBy === "author" && f.required && !f.computed) {
      const v = rev.variables[f.key];
      if (v === undefined || v === null || v === "" || v === false)
        problems.push(`field "${f.key}" is required`);
    }
  }
  if (rev.body.blocks.length === 0) problems.push("the document has no content");
  if (problems.length > 0) throw new DocError(problems.join("; "), "validation");
}

// ── issue ─────────────────────────────────────────────────────────────────────
export const IssueDocumentInput = z
  .object({
    documentId: z.string().uuid(),
    /** The frozen revision the actor reviewed; refuses if the document moved on. */
    expectedRevisionId: z.string().uuid().optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

/**
 * Issue: freeze (if needed), resolve every binding under the ISSUER's
 * permissions, write the immutable snapshot, stamp retention, and move to
 * `signature` when the body has signature blocks, else `active`.
 */
export async function issueDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ snapshotId: string; contentHash: string; status: DocStatus; parties: string[] }> {
  assertCan(archetype, "documents.issue");
  const input = IssueDocumentInput.parse(raw);
  // Bindings resolve through the doors OUTSIDE the write transaction (they
  // open their own read transactions); the snapshot is then written atomically.
  const pre = await withCtx(ctx, async (tx) => {
    const d = await loadDocIn(tx, ctx, input.documentId);
    if (d.issuedSnapshotId) throw new DocError("document is already issued", "immutable");
    if (!["draft", "review", "approval"].includes(d.status))
      throw new DocError("document cannot be issued in this state", "state");
    if (d.status === "approval" && !(await approvalCompletedIn(tx, ctx, d.id)))
      throw new DocError("approval is not complete", "state");
    const latest = await latestRevisionIn(tx, ctx, d.id);
    if (!latest) throw new DocError("document has no content", "state");
    if (input.expectedRevisionId && latest.id !== input.expectedRevisionId)
      throw new DocError("the document changed since you reviewed it", "conflict");
    return { d, latest };
  });
  validateForIssue(pre.latest);
  const profile = await getDocumentProfile(ctx);
  const facts = factsOf(pre.d);
  const effectiveFrom =
    input.effectiveFrom ?? pre.d.effectiveFrom ?? new Date().toISOString().slice(0, 10);
  const values = await resolveValues(
    ctx,
    archetype,
    { ...facts, effectiveFrom },
    pre.latest.body,
    pre.latest.variables,
    profile,
  );

  return command(
    ctx,
    {
      audit: (r: { snapshotId: string; contentHash: string }) => ({
        action: "documents.issue",
        entityType: "document",
        entityId: input.documentId,
        summary: `Issued document ${pre.d.reference} (snapshot ${r.contentHash.slice(0, 12)})`,
        after: { snapshotId: r.snapshotId, contentHash: r.contentHash },
      }),
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "issued",
        summary: `${pre.d.reference} issued`,
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.issuedSnapshotId) throw new DocError("document is already issued", "immutable");
      const rev = d.workingRevisionId
        ? await freezeWorkingIn(tx, ctx, d, "issued")
        : await latestRevisionIn(tx, ctx, d.id);
      if (!rev || rev.id !== pre.latest.id || rev.contentHash === null)
        throw new DocError("the document changed while issuing; try again", "conflict");
      const issuedAt = new Date().toISOString();
      const parties = signatureParties(rev.body);
      // Resolved bindings become literal values; hidden conditional blocks are
      // dropped, so the snapshot IS what the reader sees.
      const body = { blocks: visibleBlocks(rev.body, values) as Block[] };
      const snapshot: IssuedSnapshot = {
        version: 1,
        document: { ...facts, effectiveFrom, issuedAt, parties },
        issuer: captureIssuerSnapshot(profile.identity, issuedAt),
        branding: {
          logoFileId: profile.identity.logoFileId ?? null,
          accentColor: profile.accentColor,
        },
        body,
        values,
        settings: rev.settings,
        fonts: ["NotoSans", "NotoNaskhArabic"],
        issuedAt,
      };
      const hash = contentHash(snapshot);
      const settings = await getDocSettingsIn(tx, ctx);
      const rows = (await tx.execute(sql`
        insert into public.doc_snapshot (org_id, document_id, revision_id, snapshot, content_hash, issued_at, issued_by, created_by)
        values (${ctx.orgId}, ${d.id}, ${rev.id}, ${JSON.stringify(snapshot)}::jsonb, ${hash}, ${issuedAt}::timestamptz,
                ${ctx.userId}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const status: DocStatus = parties.length > 0 ? "signature" : "active";
      await tx.execute(sql`
        update public.doc_document
        set working_revision_id = null, issued_snapshot_id = ${rows[0]!.id}, issued_at = ${issuedAt}::timestamptz,
            issued_by = ${ctx.userId}, status = ${status}, effective_from = ${effectiveFrom},
            retention_until = (${issuedAt}::timestamptz + make_interval(years => ${settings.retentionYears}))::date,
            row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "issued",
        payload: {
          snapshotId: rows[0]!.id,
          revisionId: rev.id,
          contentHash: hash,
          parties,
          status,
        },
      });
      if (status === "active") await activatedIn(tx, ctx, d.id);
      if (d.supersedesDocumentId) await markSupersededIn(tx, ctx, d.supersedesDocumentId, d.id);
      return { snapshotId: rows[0]!.id, contentHash: hash, status, parties };
    },
  );
}

/** Whether the approval run for this document completed (0115 fills this in). */
async function approvalCompletedIn(tx: TenantTx, ctx: Ctx, documentId: string): Promise<boolean> {
  const rows = (await tx
    .execute(
      sql`
    select 1 from public.doc_workflow_run
    where document_id = ${documentId} and org_id = ${ctx.orgId} and status = 'completed'
    order by started_at desc limit 1
  `,
    )
    .catch(() => [] as unknown[])) as unknown[];
  return rows.length > 0;
}

export async function activatedIn(tx: TenantTx, ctx: Ctx, documentId: string): Promise<void> {
  await tx.execute(sql`
    update public.doc_document set status = 'active', row_version = row_version + 1
    where id = ${documentId} and org_id = ${ctx.orgId} and status in ('signature', 'active')
  `);
  await appendEventIn(tx, ctx, { documentId, kind: "activated" });
}

async function markSupersededIn(
  tx: TenantTx,
  ctx: Ctx,
  predecessorId: string,
  successorId: string,
): Promise<void> {
  const rows = (await tx.execute(sql`
    update public.doc_document
    set status = 'superseded', superseded_by_document_id = ${successorId}, row_version = row_version + 1,
        updated_by = ${ctx.userId}
    where id = ${predecessorId} and org_id = ${ctx.orgId}
      and status in ('active', 'expired', 'signature') and superseded_by_document_id is null
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  if (rows[0]) {
    await appendEventIn(tx, ctx, {
      documentId: predecessorId,
      kind: "superseded",
      payload: { successorId },
    });
  }
}

// ── successors, termination, archive ─────────────────────────────────────────
export async function createSuccessor(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; reference: string; revisionId: string }> {
  const input = z
    .object({ documentId: z.string().uuid(), title: z.string().trim().min(1).max(240).optional() })
    .parse(raw);
  const prev = await getDocument(ctx, archetype, input.documentId);
  const d = prev.document;
  return createDocument(ctx, archetype, {
    title: input.title ?? d.title,
    category: d.category,
    language: d.language,
    folderId: d.folderId,
    tags: d.tags,
    counterparty: d.counterpartyKind
      ? { kind: d.counterpartyKind, id: d.counterpartyId, label: d.counterpartyLabel }
      : null,
    record: d.recordType && d.recordId ? { type: d.recordType, id: d.recordId } : null,
    workflowId: d.workflowId,
    supersedesDocumentId: d.id,
  });
}

export async function terminateDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.terminate");
  const input = z
    .object({ documentId: z.string().uuid(), reason: z.string().trim().min(1).max(2000) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.terminate",
        entityType: "document",
        entityId: input.documentId,
        summary: "Terminated document",
        after: { reason: input.reason },
      },
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "terminated",
        summary: "terminated",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (!["active", "expired", "signature"].includes(d.effectiveStatus))
        throw new DocError("only an issued document can be terminated", "state");
      await tx.execute(sql`
        update public.doc_document
        set status = 'terminated', terminated_at = now(), terminated_by = ${ctx.userId}, termination_reason = ${input.reason},
            row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "terminated",
        payload: { reason: input.reason },
      });
      return { id: d.id };
    },
  );
}

export async function archiveDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.archive");
  const input = z
    .object({ documentId: z.string().uuid(), restore: z.boolean().default(false) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: input.restore ? "documents.restore" : "documents.archive",
        entityType: "document",
        entityId: input.documentId,
        summary: input.restore ? "Restored document from archive" : "Archived document",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (input.restore) {
        if (d.status !== "archived") throw new DocError("document is not archived", "state");
        const previous = (await tx.execute(sql`
          select payload->>'from' as f from public.doc_event
          where document_id = ${d.id} and org_id = ${ctx.orgId} and kind = 'archived'
          order by seq desc limit 1
        `)) as unknown as Array<{ f: string | null }>;
        const back =
          (previous[0]?.f as DocStatus | null) ?? (d.issuedSnapshotId ? "active" : "draft");
        await tx.execute(sql`
          update public.doc_document set status = ${back}, archived_at = null, archived_by = null,
            row_version = row_version + 1, updated_by = ${ctx.userId}
          where id = ${d.id} and org_id = ${ctx.orgId}
        `);
        await appendEventIn(tx, ctx, { documentId: d.id, kind: "restored", payload: { to: back } });
        return { id: d.id };
      }
      if (!["draft", "expired", "terminated", "superseded", "active"].includes(d.effectiveStatus))
        throw new DocError("cannot archive in this state", "state");
      if (d.legalHold) throw new DocError("document is under legal hold", "state");
      await tx.execute(sql`
        update public.doc_document set status = 'archived', archived_at = now(), archived_by = ${ctx.userId},
          row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "archived",
        payload: { from: d.status },
      });
      return { id: d.id };
    },
  );
}

/** Stamp `expired` on active documents past their expiry (idempotent; any member with documents.view may trigger). */
export async function sweepExpired(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ expired: number }> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      update public.doc_document set status = 'expired', row_version = row_version + 1
      where org_id = ${ctx.orgId} and status = 'active' and expires_at is not null and expires_at < current_date
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    for (const r of rows)
      await appendEventIn(tx, ctx, { documentId: r.id, kind: "expired", actorUserId: null });
    return { expired: rows.length };
  });
}

export async function setLegalHold(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "files.legal_hold");
  const input = z.object({ documentId: z.string().uuid(), hold: z.boolean() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.legal_hold",
        entityType: "document",
        entityId: input.documentId,
        summary: input.hold ? "Legal hold set on document" : "Legal hold lifted from document",
        after: { hold: input.hold },
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      await tx.execute(sql`
        update public.doc_document set legal_hold = ${input.hold}, row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "legal_hold_set",
        payload: { hold: input.hold },
      });
      return { id: d.id };
    },
  );
}

export async function extendRetention(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ retentionUntil: string }> {
  assertCan(archetype, "documents.archive");
  const input = z
    .object({ documentId: z.string().uuid(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.retention.extend",
        entityType: "document",
        entityId: input.documentId,
        summary: `Retention extended to ${input.until}`,
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId, true);
      if (d.retentionUntil && input.until < d.retentionUntil)
        throw new DocError("retention can only be lengthened", "validation");
      await tx.execute(sql`
        update public.doc_document set retention_until = ${input.until}, row_version = row_version + 1, updated_by = ${ctx.userId}
        where id = ${d.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "retention_extended",
        payload: { until: input.until },
      });
      return { retentionUntil: input.until };
    },
  );
}

/** Who may do what right now — computed server-side for the screens. */
export function documentCapabilities(
  archetype: RoleArchetype,
  d: DocumentRow,
): Record<string, boolean> {
  const s = d.effectiveStatus;
  const issued = d.issuedSnapshotId !== null;
  return {
    edit: can(archetype, "documents.edit") && s === "draft",
    submit: can(archetype, "documents.edit") && s === "draft",
    review: can(archetype, "documents.review") && (s === "review" || s === "approval"),
    issue:
      can(archetype, "documents.issue") && !issued && ["draft", "review", "approval"].includes(s),
    supersede:
      can(archetype, "documents.create") &&
      issued &&
      ["active", "expired", "signature"].includes(s) &&
      !d.supersededByDocumentId,
    terminate:
      can(archetype, "documents.terminate") && ["active", "expired", "signature"].includes(s),
    archive:
      can(archetype, "documents.archive") &&
      ["draft", "expired", "terminated", "superseded", "active"].includes(s) &&
      !d.legalHold,
    restore: can(archetype, "documents.archive") && s === "archived",
    sign: can(archetype, "documents.sign") && s === "signature",
    requestSignature: can(archetype, "documents.issue") && s === "signature",
    obligations: can(archetype, "documents.obligations.manage") && issued,
    share: can(archetype, "documents.share") && issued,
    forms: can(archetype, "documents.forms.manage") && d.category === "form",
  };
}
