/**
 * H26 — forms (ADR-24). A form is an issued document whose body holds field
 * blocks. Members create hashed, expiring, use-capped links; outside parties
 * submit through the SECURITY DEFINER path into a quarantined row; members
 * review and convert a submission into a record (customer, lead, or a new
 * document from a template) explicitly, under their own permissions and the
 * target module's validation.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createCustomer } from "@/modules/masters/service";
import { createLead } from "@/modules/crm/service";
import { evaluateConditions } from "./conditions";
import { createDocument, loadDocIn, loadSnapshotIn, type IssuedSnapshot } from "./documents";
import { appendEventIn } from "./events";
import { DocError, fieldBlocks, type DocBody } from "./types";
import { appBaseUrl } from "./signatures";

const SYNTHETIC_USER = "00000000-0000-0000-0000-000000000000";

export type FormLinkRow = {
  id: string;
  documentId: string;
  label: string | null;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type SubmissionRow = {
  id: string;
  documentId: string;
  linkId: string | null;
  answers: Record<string, unknown>;
  submitterName: string | null;
  submitterEmail: string | null;
  submittedAt: string;
  status: "received" | "reviewed" | "converted" | "discarded";
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  convertedRecordType: string | null;
  convertedRecordId: string | null;
};

function mapLink(r: Record<string, unknown>): FormLinkRow {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    label: (r.label as string | null) ?? null,
    expiresAt: r.expires_at as string,
    maxUses: r.max_uses === null || r.max_uses === undefined ? null : Number(r.max_uses),
    useCount: Number(r.use_count),
    revokedAt: (r.revoked_at as string | null) ?? null,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapSubmission(r: Record<string, unknown>): SubmissionRow {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    linkId: (r.link_id as string | null) ?? null,
    answers: (r.answers as Record<string, unknown>) ?? {},
    submitterName: (r.submitter_name as string | null) ?? null,
    submitterEmail: (r.submitter_email as string | null) ?? null,
    submittedAt: r.submitted_at as string,
    status: r.status as SubmissionRow["status"],
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    convertedRecordType: (r.converted_record_type as string | null) ?? null,
    convertedRecordId: (r.converted_record_id as string | null) ?? null,
  };
}

// ── links ─────────────────────────────────────────────────────────────────────
export const CreateFormLinkInput = z
  .object({
    documentId: z.string().uuid(),
    label: z.string().trim().max(120).optional(),
    expiresInDays: z.number().int().min(1).max(365).default(30),
    maxUses: z.number().int().min(1).max(100000).nullable().optional(),
  })
  .strict();

/** Mint a form link. The plaintext token is returned once; only its hash is stored. */
export async function createFormLink(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; url: string }> {
  assertCan(archetype, "documents.forms.manage");
  const input = CreateFormLinkInput.parse(raw);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const id = await command(
    ctx,
    {
      audit: (r: string) => ({
        action: "documents.form.link",
        entityType: "document_form",
        entityId: r,
        summary: `Created a form link (${input.expiresInDays} days${input.maxUses ? `, ${input.maxUses} uses` : ""})`,
      }),
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId);
      if (d.category !== "form")
        throw new DocError("only a form document takes form links", "validation");
      if (!d.issuedSnapshotId || d.effectiveStatus !== "active")
        throw new DocError("issue the form first; links point at the issued snapshot", "state");
      const rows = (await tx.execute(sql`
        insert into public.doc_form_link (org_id, document_id, snapshot_id, label, token_hash, expires_at, max_uses, created_by)
        values (${ctx.orgId}, ${d.id}, ${d.issuedSnapshotId}, ${input.label ?? null}, ${hash},
                now() + make_interval(days => ${input.expiresInDays}), ${input.maxUses ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    },
  );
  return { id, url: `${appBaseUrl()}/f/${token}` };
}

export async function revokeFormLink(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.forms.manage");
  const input = z.object({ linkId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.form.link_revoke",
        entityType: "document_form",
        entityId: input.linkId,
        summary: "Revoked a form link",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_form_link set revoked_at = now(), revoked_by = ${ctx.userId}
        where id = ${input.linkId} and org_id = ${ctx.orgId} and revoked_at is null
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("link not found", "not_found");
      return { id: rows[0].id };
    },
  );
}

export async function listFormLinks(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<FormLinkRow[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, document_id::text as document_id, label, expires_at::text as expires_at, max_uses, use_count,
             revoked_at::text as revoked_at, last_used_at::text as last_used_at, created_at::text as created_at
      from public.doc_form_link where document_id = ${documentId} and org_id = ${ctx.orgId}
      order by created_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapLink);
}

// ── the public path ───────────────────────────────────────────────────────────
export type ResolvedFormLink = {
  linkId: string;
  orgId: string;
  documentId: string;
  snapshotId: string;
  label: string | null;
  expiresAt: string;
};

export async function resolveFormToken(rawToken: string): Promise<ResolvedFormLink | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(rawToken)) return null;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const { createAppDb } = await import("@/platform/tenancy");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select link_id::text as link_id, org_id::text as org_id, document_id::text as document_id,
             snapshot_id::text as snapshot_id, label, expires_at::text as expires_at
      from app.resolve_doc_form_link(${hash})
    `)) as unknown as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
      linkId: r.link_id as string,
      orgId: r.org_id as string,
      documentId: r.document_id as string,
      snapshotId: r.snapshot_id as string,
      label: (r.label as string | null) ?? null,
      expiresAt: r.expires_at as string,
    };
  } finally {
    await end();
  }
}

export function formCtx(resolved: ResolvedFormLink): Ctx {
  return {
    orgId: resolved.orgId,
    userId: SYNTHETIC_USER,
    costPrivileged: false,
    pricePrivileged: false,
    requestId: `form-${resolved.linkId}`,
  };
}

/** The snapshot an outside party fills in (read under the synthetic org context). */
export async function loadFormSnapshot(
  resolved: ResolvedFormLink,
): Promise<{ title: string; reference: string; snapshot: IssuedSnapshot } | null> {
  const ctx = formCtx(resolved);
  return withCtx(ctx, async (tx) => {
    const d = await loadDocIn(tx, ctx, resolved.documentId);
    const snap = await loadSnapshotIn(tx, ctx, d.id);
    if (!snap || snap.id !== resolved.snapshotId) return null;
    return { title: d.title, reference: d.reference, snapshot: snap.snapshot };
  });
}

/**
 * Validate answers against the snapshot's party-filled fields: kinds,
 * required, options and bounds, honouring conditional sections. Returns the
 * clean answer set or the field-level problems.
 */
export function validateAnswers(
  body: DocBody,
  raw: Record<string, unknown>,
):
  | { ok: true; answers: Record<string, string | number | boolean | null> }
  | { ok: false; problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const answers: Record<string, string | number | boolean | null> = {};
  const fields = fieldBlocks(body).filter((f) => f.filledBy === "party");
  // First pass: coerce values so conditions can read them.
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === null || v === "") {
      answers[f.key] = null;
      continue;
    }
    switch (f.kind) {
      case "number":
      case "money": {
        const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
        if (!Number.isFinite(n)) problems[f.key] = "number";
        else answers[f.key] = f.kind === "money" ? Math.round(n * 100) : n;
        break;
      }
      case "checkbox":
        answers[f.key] = v === true || v === "on" || v === "true";
        break;
      case "choice": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n >= (f.options?.length ?? 0))
          problems[f.key] = "choice";
        else answers[f.key] = n;
        break;
      }
      case "email": {
        const s = String(v).trim().slice(0, 320);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) problems[f.key] = "email";
        else answers[f.key] = s;
        break;
      }
      case "date": {
        const s = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) problems[f.key] = "date";
        else answers[f.key] = s;
        break;
      }
      default:
        answers[f.key] = String(v).slice(0, f.kind === "textarea" ? 20_000 : 2_000);
    }
  }
  // Second pass: required + bounds, only for visible fields.
  const values = { bindings: {}, variables: answers };
  const visibleSectionOf = new Map<string, boolean>();
  for (const b of body.blocks) {
    if (b.type === "section") {
      const shown = !b.condition || evaluateConditions(b.condition, values);
      for (const c of b.blocks) visibleSectionOf.set(c.id, shown);
    }
  }
  for (const f of fields) {
    const shown =
      (visibleSectionOf.get(f.id) ?? true) &&
      (!f.condition || evaluateConditions(f.condition, values));
    if (!shown) {
      delete answers[f.key];
      delete problems[f.key];
      continue;
    }
    if (problems[f.key]) continue;
    const v = answers[f.key];
    if (f.required && (v === null || v === undefined || v === "" || v === false))
      problems[f.key] = "required";
    if (typeof v === "number" && f.kind === "number") {
      if (f.min !== undefined && v < f.min) problems[f.key] = "min";
      if (f.max !== undefined && v > f.max) problems[f.key] = "max";
    }
    if (typeof v === "string" && f.pattern) {
      try {
        if (!new RegExp(f.pattern).test(v)) problems[f.key] = "pattern";
      } catch {
        /* an invalid author pattern never blocks a submission */
      }
    }
  }
  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, answers };
}

/** Submit through the definer: the link is re-validated and counted atomically. */
export async function submitForm(
  resolved: ResolvedFormLink,
  rawToken: string,
  raw: Record<string, unknown>,
  info: {
    ip: string | null;
    userAgent: string | null;
    name?: string | null;
    email?: string | null;
  },
): Promise<{ id: string } | { problems: Record<string, string> }> {
  const form = await loadFormSnapshot(resolved);
  if (!form) throw new DocError("form not available", "not_found");
  const validated = validateAnswers(form.snapshot.body, raw);
  if (!validated.ok) return { problems: validated.problems };
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const ctx = formCtx(resolved);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select app.doc_form_submit(${hash}, ${JSON.stringify(validated.answers)}::jsonb, ${info.name ?? null},
                                 ${info.email ?? null}, ${info.ip}, ${info.userAgent})::text as id
    `)) as unknown as Array<{ id: string | null }>;
    const id = rows[0]?.id;
    if (!id) throw new DocError("this form link is no longer available", "expired");
    await appendEventIn(tx, ctx, {
      documentId: resolved.documentId,
      kind: "form_submitted",
      actorUserId: null,
      actorLabel: info.name ?? info.email ?? "form respondent",
      payload: { submissionId: id, linkId: resolved.linkId, ip: info.ip },
    });
    return { id };
  });
}

// ── review and conversion ─────────────────────────────────────────────────────
export async function listSubmissions(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { documentId?: string; status?: SubmissionRow["status"]; limit?: number } = {},
): Promise<SubmissionRow[]> {
  assertCan(archetype, "documents.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, document_id::text as document_id, link_id::text as link_id, answers, submitter_name, submitter_email,
             submitted_at::text as submitted_at, status, reviewed_by::text as reviewed_by, reviewed_at::text as reviewed_at,
             review_note, converted_record_type, converted_record_id::text as converted_record_id
      from public.doc_form_submission
      where org_id = ${ctx.orgId}
        and (${!opts.documentId} or document_id = ${opts.documentId ?? null})
        and (${!opts.status} or status = ${opts.status ?? null})
      order by submitted_at desc
      limit ${limit}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapSubmission);
}

export const ReviewSubmissionInput = z
  .object({
    submissionId: z.string().uuid(),
    decision: z.enum(["reviewed", "discarded"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function reviewSubmission(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.forms.manage");
  const input = ReviewSubmissionInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: `documents.form.${input.decision}`,
        entityType: "document_form",
        entityId: input.submissionId,
        summary:
          input.decision === "reviewed"
            ? "Reviewed a form submission"
            : "Discarded a form submission",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_form_submission
        set status = ${input.decision}, reviewed_by = ${ctx.userId}, reviewed_at = now(), review_note = ${input.note ?? null}
        where id = ${input.submissionId} and org_id = ${ctx.orgId} and status in ('received', 'reviewed')
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("submission not found or already converted", "state");
      return { id: rows[0].id };
    },
  );
}

/**
 * Convert a submission into a record. The mapping is explicit (submission
 * field key → target field); the target module validates and audits under
 * the reviewer's permissions. Nothing is created without this action.
 */
export const ConvertSubmissionInput = z
  .object({
    submissionId: z.string().uuid(),
    target: z.enum(["customer", "lead", "document"]),
    /** target field → submission field key (customer: name, contactName, email, phone, taxRegNo, country; lead: name, company, email, phone). */
    mapping: z
      .record(z.string().regex(/^[a-zA-Z]{1,40}$/), z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
      .default({}),
    /** document target: the template to start from, and the title. */
    templateId: z.string().uuid().optional(),
    builtinKey: z
      .string()
      .regex(/^[a-z0-9_.-]{1,60}$/)
      .optional(),
    title: z.string().trim().min(1).max(240).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function convertSubmission(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ recordType: string; recordId: string }> {
  assertCan(archetype, "documents.forms.manage");
  const input = ConvertSubmissionInput.parse(raw);
  const sub = (await listSubmissions(ctx, archetype, { limit: 500 })).find(
    (s) => s.id === input.submissionId,
  );
  if (!sub) throw new DocError("submission not found", "not_found");
  if (sub.status === "converted") throw new DocError("already converted", "state");
  const pick = (target: string): string | undefined => {
    const key = input.mapping[target];
    const v = key ? sub.answers[key] : undefined;
    return v === null || v === undefined || v === "" ? undefined : String(v);
  };
  let recordId = "";
  if (input.target === "customer") {
    const created = await createCustomer(ctx, archetype, {
      name: pick("name") ?? sub.submitterName ?? "Unnamed",
      contactName: pick("contactName"),
      email: pick("email") ?? sub.submitterEmail ?? undefined,
      phone: pick("phone"),
      taxRegNo: pick("taxRegNo"),
      country: pick("country") ?? "AE",
    });
    recordId = created.id;
  } else if (input.target === "lead") {
    const created = await createLead(ctx, archetype, {
      name: pick("name") ?? sub.submitterName ?? "Unnamed",
      company: pick("company"),
      email: pick("email") ?? sub.submitterEmail ?? undefined,
      phone: pick("phone"),
      source: "form",
    });
    recordId = created.id;
  } else {
    const created = await createDocument(ctx, archetype, {
      title: input.title ?? `From form ${sub.submittedAt.slice(0, 10)}`,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.builtinKey ? { builtinKey: input.builtinKey } : {}),
      counterparty: sub.submitterName ? { kind: "other", label: sub.submitterName } : null,
    });
    recordId = created.id;
  }
  await command(
    ctx,
    {
      audit: {
        action: "documents.form.convert",
        entityType: "document_form",
        entityId: sub.id,
        summary: `Converted a form submission into ${input.target} ${recordId}`,
        after: { target: input.target, recordId, mapping: input.mapping },
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.doc_form_submission
        set status = 'converted', reviewed_by = ${ctx.userId}, reviewed_at = now(), review_note = ${input.note ?? null},
            converted_record_type = ${input.target}, converted_record_id = ${recordId}
        where id = ${sub.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: sub.documentId,
        kind: "form_converted",
        payload: { submissionId: sub.id, target: input.target, recordId },
      });
    },
  );
  return { recordType: input.target, recordId };
}
