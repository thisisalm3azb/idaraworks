/**
 * H29 — the document lifecycle through a channel.
 *
 * Preparing is safe and repeatable: the same document prepared twice takes the
 * same row, the same counter and the same identity, because the idempotency key
 * is derived from the document and the channel rather than from the attempt.
 *
 * Submitting is the only step that could reach outside, and it cannot: the
 * adapter returns `unavailable` without a credential, the document is recorded
 * as blocked with the owner action, and every attempt is written to the
 * append-only evidence table whether it succeeded or not.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";
import { adapterFor, credentialPresent } from "./registry";
import { EInvoiceError } from "./channels";
import type { SourceDocument, ValidationIssue } from "./adapters/types";

export type EInvoiceDocumentRow = {
  id: string;
  channelId: string;
  establishmentId: string;
  sourceKind: string;
  sourceId: string;
  documentUuid: string | null;
  counter: number | null;
  documentHash: string | null;
  previousHash: string | null;
  qrPayload: string | null;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  preparedAt: string;
  submittedAt: string | null;
};

export const PrepareInput = z.object({
  channelId: z.string().uuid(),
  document: z.object({
    kind: z.enum(["tax_invoice", "simplified_tax_invoice", "tax_credit_note", "tax_debit_note"]),
    id: z.string().uuid(),
    reference: z.string().trim().min(1).max(60),
    issuedAt: z.string().min(10).max(40),
    currency: z.string().length(3),
    totalMinor: z.number().int(),
    taxTotalMinor: z.number().int(),
    seller: z.object({
      name: z.string().trim().min(1).max(200),
      taxNumber: z.string().trim().max(40).nullable(),
      address: z.record(z.string(), z.string().max(200)),
    }),
    buyer: z
      .object({
        name: z.string().trim().max(200).nullable(),
        taxNumber: z.string().trim().max(40).nullable(),
        address: z.record(z.string(), z.string().max(200)),
      })
      .nullable(),
    lines: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(500),
          quantity: z.number(),
          unitPriceMinor: z.number().int(),
          taxRatePercent: z.number(),
          taxAmountMinor: z.number().int(),
          lineTotalMinor: z.number().int(),
        }),
      )
      .max(500),
    correctsReference: z.string().trim().max(60).optional(),
    correctionReason: z.string().trim().max(500).optional(),
  }),
});

function rowOf(r: Record<string, unknown>): EInvoiceDocumentRow {
  return {
    id: String(r.id),
    channelId: String(r.channel_id),
    establishmentId: String(r.establishment_id),
    sourceKind: String(r.source_kind),
    sourceId: String(r.source_id),
    documentUuid: (r.document_uuid as string | null) ?? null,
    counter: r.counter === null || r.counter === undefined ? null : Number(r.counter),
    documentHash: (r.document_hash as string | null) ?? null,
    previousHash: (r.previous_hash as string | null) ?? null,
    qrPayload: (r.qr_payload as string | null) ?? null,
    status: String(r.status),
    attempts: Number(r.attempts ?? 0),
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    preparedAt: String(r.prepared_at),
    submittedAt: (r.submitted_at as string | null) ?? null,
  };
}

const SELECT = sql`
  select id::text as id, channel_id::text as channel_id, establishment_id::text as establishment_id,
         source_kind, source_id::text as source_id, document_uuid::text as document_uuid, counter,
         document_hash, previous_hash, qr_payload, status, attempts, error_code, error_message,
         prepared_at::text as prepared_at, submitted_at::text as submitted_at
  from public.einvoice_document`;

async function channelIn(tx: TenantTx, ctx: Ctx, channelId: string) {
  const rows = (await tx.execute(sql`
    select id::text as id, establishment_id::text as establishment_id, adapter_key, environment,
           status, credential_ref, stopped
    from public.einvoice_channel where id = ${channelId} and org_id = ${ctx.orgId}`)) as unknown as Array<
    Record<string, unknown>
  >;
  if (!rows[0]) throw new EInvoiceError("channel not found", "not_found");
  return rows[0];
}

export type PrepareResult = {
  document: EInvoiceDocumentRow;
  issues: ValidationIssue[];
  /** The authority payload, for a person who wants to see exactly what was built. */
  payload: string;
};

export async function prepareDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<PrepareResult> {
  assertCan(archetype, "country.manage");
  const input = PrepareInput.parse(raw);
  const source = input.document as SourceDocument;

  return command<PrepareResult>(
    ctx,
    {
      audit: (result) => ({
        action: "einvoice.document.prepare",
        entityType: "establishment",
        entityId: result.document.establishmentId,
        summary: `Prepared ${source.kind} ${source.reference} for ${result.document.sourceKind}`,
      }),
    },
    async (tx) => {
      const channel = await channelIn(tx, ctx, input.channelId);
      const adapter = adapterFor(String(channel.adapter_key));
      if (!adapter) throw new EInvoiceError("unknown adapter", "not_found");
      if (!adapter.supports.includes(source.kind))
        throw new EInvoiceError(`${adapter.key} does not carry a ${source.kind}`, "invalid");

      // One key per document per channel: preparing twice is the same row.
      const idempotencyKey = `${source.kind}:${source.id}`;
      const existing = (await tx.execute(sql`
        ${SELECT} where org_id = ${ctx.orgId} and channel_id = ${input.channelId}
          and idempotency_key = ${idempotencyKey}`)) as unknown as Array<Record<string, unknown>>;

      const previous = (await tx.execute(sql`
        select document_hash from public.einvoice_document
        where org_id = ${ctx.orgId} and channel_id = ${input.channelId}
          and document_hash is not null
        order by counter desc nulls last limit 1`)) as unknown as Array<{ document_hash: string }>;

      const counter = existing[0]
        ? Number(existing[0].counter)
        : Number(
            (
              (await tx.execute(sql`
                select app.einvoice_next_counter(${input.channelId}::uuid) as n`)) as unknown as Array<{
                n: string;
              }>
            )[0]!.n,
          );

      const prepared = adapter.prepare(source, {
        environment: String(channel.environment) as "sandbox" | "production",
        credentialRef: (channel.credential_ref as string | null) ?? null,
        credentialPresent: credentialPresent(
          (channel.credential_ref as string | null) ?? null,
          env,
        ),
        counter,
        previousHash: existing[0]
          ? ((existing[0].previous_hash as string | null) ?? null)
          : (previous[0]?.document_hash ?? null),
      });

      const blocking = prepared.issues.some((i) => i.severity === "error");
      const status = blocking ? "prepared" : "validated";

      const rows = (await tx.execute(sql`
        insert into public.einvoice_document
          (org_id, channel_id, establishment_id, source_kind, source_id, counter, document_hash,
           previous_hash, qr_payload, status, idempotency_key, request_evidence)
        values (${ctx.orgId}, ${input.channelId}, ${String(channel.establishment_id)},
                ${source.kind}, ${source.id}, ${counter}, ${prepared.documentHash},
                ${existing[0] ? ((existing[0].previous_hash as string | null) ?? null) : (previous[0]?.document_hash ?? null)},
                ${prepared.qrPayload}, ${status}, ${idempotencyKey},
                ${JSON.stringify({ payloadKind: prepared.payloadKind, issues: prepared.issues })}::jsonb)
        on conflict (org_id, channel_id, idempotency_key) do update set
          document_hash = excluded.document_hash,
          qr_payload = excluded.qr_payload,
          status = case when public.einvoice_document.status in ('cleared','reported','submitted')
                        then public.einvoice_document.status else excluded.status end,
          request_evidence = excluded.request_evidence,
          updated_at = now()
        returning id::text as id, channel_id::text as channel_id,
                  establishment_id::text as establishment_id, source_kind,
                  source_id::text as source_id, document_uuid::text as document_uuid, counter,
                  document_hash, previous_hash, qr_payload, status, attempts, error_code,
                  error_message, prepared_at::text as prepared_at,
                  submitted_at::text as submitted_at`)) as unknown as Array<
        Record<string, unknown>
      >;

      return { document: rowOf(rows[0]!), issues: prepared.issues, payload: prepared.payload };
    },
  );
}

export type SubmitResult = {
  document: EInvoiceDocumentRow;
  state: "unavailable" | "accepted" | "rejected" | "warning" | "retry";
  /** Present when the state is `unavailable`: what would change it. */
  ownerAction?: string;
};

/**
 * Attempt to send. With no credential the adapter reports `unavailable`, the
 * document is marked `blocked_no_credential`, and the attempt is still written
 * to the evidence table: an honest record that nothing was sent.
 */
export async function submitDocument(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SubmitResult> {
  assertCan(archetype, "country.manage");

  return command<SubmitResult>(
    ctx,
    {
      audit: (result) => ({
        action: "einvoice.document.submit",
        entityType: "establishment",
        entityId: result.document.establishmentId,
        summary:
          result.state === "unavailable"
            ? "Submission was not possible: no credential is configured, so nothing was sent"
            : `Submission attempt finished as ${result.state}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        ${SELECT} where id = ${documentId} and org_id = ${ctx.orgId}`)) as unknown as Array<
        Record<string, unknown>
      >;
      if (!rows[0]) throw new EInvoiceError("document not found", "not_found");
      const document = rowOf(rows[0]);

      const channel = await channelIn(tx, ctx, document.channelId);
      if (Boolean(channel.stopped)) throw new EInvoiceError("this channel is stopped", "state");
      const adapter = adapterFor(String(channel.adapter_key));
      if (!adapter) throw new EInvoiceError("unknown adapter", "not_found");

      const ref = (channel.credential_ref as string | null) ?? null;
      const outcome = await adapter.submit(
        {
          payload: "",
          payloadKind: "ubl_xml",
          documentHash: document.documentHash,
          qrPayload: document.qrPayload,
          issues: [],
        },
        {
          environment: String(channel.environment) as "sandbox" | "production",
          credentialRef: ref,
          credentialPresent: credentialPresent(ref, env),
          counter: document.counter ?? 1,
          previousHash: document.previousHash,
        },
      );

      const attempt = document.attempts + 1;
      const status =
        outcome.state === "unavailable"
          ? "blocked_no_credential"
          : outcome.state === "accepted"
            ? adapter.model === "clearance"
              ? "cleared"
              : "reported"
            : outcome.state === "rejected"
              ? "rejected"
              : outcome.state === "warning"
                ? "warning"
                : "retry_pending";

      await tx.execute(sql`
        insert into public.einvoice_event (org_id, document_id, attempt, outcome, detail)
        values (${ctx.orgId}, ${documentId}, ${attempt}, ${outcome.state},
                ${JSON.stringify(outcome)}::jsonb)`);

      const updated = (await tx.execute(sql`
        update public.einvoice_document set
          status = ${status},
          attempts = ${attempt},
          error_code = ${"code" in outcome ? outcome.code : null},
          error_message = ${
            outcome.state === "unavailable"
              ? outcome.ownerAction
              : "message" in outcome
                ? outcome.message
                : null
          },
          response_evidence = ${JSON.stringify(outcome)}::jsonb,
          submitted_at = case when ${outcome.state === "unavailable"} then submitted_at else now() end,
          updated_at = now()
        where id = ${documentId} and org_id = ${ctx.orgId}
        returning id::text as id, channel_id::text as channel_id,
                  establishment_id::text as establishment_id, source_kind,
                  source_id::text as source_id, document_uuid::text as document_uuid, counter,
                  document_hash, previous_hash, qr_payload, status, attempts, error_code,
                  error_message, prepared_at::text as prepared_at,
                  submitted_at::text as submitted_at`)) as unknown as Array<
        Record<string, unknown>
      >;

      return {
        document: rowOf(updated[0]!),
        state: outcome.state,
        ...(outcome.state === "unavailable" ? { ownerAction: outcome.ownerAction } : {}),
      };
    },
  );
}

export async function listDocuments(
  ctx: Ctx,
  channelId: string,
  page: { limit: number; offset: number } = { limit: 50, offset: 0 },
): Promise<{ rows: EInvoiceDocumentRow[]; total: number }> {
  const limit = Math.min(Math.max(page.limit, 1), 200);
  const offset = Math.max(page.offset, 0);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      ${SELECT} where org_id = ${ctx.orgId} and channel_id = ${channelId}
      order by counter desc nulls last limit ${limit} offset ${offset}`)) as unknown as Array<
      Record<string, unknown>
    >;
    const total = (await tx.execute(sql`
      select count(*)::int as n from public.einvoice_document
      where org_id = ${ctx.orgId} and channel_id = ${channelId}`)) as unknown as Array<{
      n: number;
    }>;
    return { rows: rows.map(rowOf), total: Number(total[0]?.n ?? 0) };
  });
}
