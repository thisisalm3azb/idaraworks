/**
 * Blueprint lifecycle (H14 Part E): draft → validated → approved → applied →
 * superseded, with rejected as a terminal branch.
 *
 * Every mutation:
 *  - runs under the caller's server-resolved Ctx and archetype (the caller
 *    resolves via resolveCtx/resolveCtxForAction — nothing here trusts
 *    client identity, law 3),
 *  - is permission-gated with the existing authz matrix (config.manage for
 *    writes, config.view for reads — the same authority as every other
 *    governed configuration surface),
 *  - is ONE command(): the row mutation + audit_log entry are atomic
 *    (law 10), serialized under the per-org config advisory lock,
 *  - protects against concurrent edits and stale approvals with the
 *    content hash (Part E: revision hashes protect against stale approval).
 *
 * Rows are append-only in spirit: content is mutable ONLY while a revision
 * is a draft; the 0075 DB trigger enforces immutability of approved,
 * applied, superseded and rejected content independently of this module.
 * Undo never rewrites history — it creates and applies a NEW revision
 * (law 11; same append-only law as config_revision undo).
 */
import { randomUUID } from "node:crypto";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { command } from "@/platform/audit";
import { resolveEntitlements } from "@/platform/entitlements";
import { lockOrgConfig } from "@/platform/config";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { blueprintHash } from "./hash";
import { validateBlueprint, type BlueprintValidation } from "./validate";
import { compileBlueprint, COMPILER_VERSION, type CompiledWorkspace } from "./compiler";
import type { ProvenanceSource } from "./registry";

export type BlueprintStatus =
  "draft" | "validated" | "approved" | "applied" | "superseded" | "rejected";

export type BlueprintRevision = {
  id: string;
  revisionNo: number;
  status: BlueprintStatus;
  schemaVersion: number;
  blueprint: unknown;
  blueprintHash: string;
  validation: BlueprintValidation | null;
  compiled: CompiledWorkspace | null;
  compilerVersion: string | null;
  proposedSource: ProvenanceSource;
  proposedReason: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export class BlueprintLifecycleError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "invalid_state"
      | "stale_revision"
      | "hash_mismatch"
      | "validation_failed"
      | "nothing_to_undo",
    message: string,
  ) {
    super(message);
    this.name = "BlueprintLifecycleError";
  }
}

type Row = {
  id: string;
  revision_no: number;
  status: BlueprintStatus;
  schema_version: number;
  blueprint: unknown;
  blueprint_hash: string;
  validation: BlueprintValidation | null;
  compiled: CompiledWorkspace | null;
  compiler_version: string | null;
  proposed_source: ProvenanceSource;
  proposed_reason: string | null;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  applied_by: string | null;
  applied_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};

const COLS = sql`
  id, revision_no, status, schema_version, blueprint, blueprint_hash, validation,
  compiled, compiler_version, proposed_source, proposed_reason, created_by,
  approved_by, approved_at, rejected_by, rejected_at, rejected_reason,
  applied_by, applied_at, superseded_by, created_at, updated_at
`;

function toRevision(r: Row): BlueprintRevision {
  return {
    id: r.id,
    revisionNo: r.revision_no,
    status: r.status,
    schemaVersion: r.schema_version,
    blueprint: r.blueprint,
    blueprintHash: r.blueprint_hash,
    validation: r.validation,
    compiled: r.compiled,
    compilerVersion: r.compiler_version,
    proposedSource: r.proposed_source,
    proposedReason: r.proposed_reason,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at,
    rejectedReason: r.rejected_reason,
    appliedBy: r.applied_by,
    appliedAt: r.applied_at,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function readRevision(tx: TenantTx, ctx: Ctx, id: string): Promise<Row | null> {
  const rows = (await tx.execute(sql`
    select ${COLS} from public.workspace_blueprint_revision
    where org_id = ${ctx.orgId} and id = ${id}
  `)) as unknown as Row[];
  return rows[0] ?? null;
}

function requireRevision(row: Row | null): Row {
  if (!row) throw new BlueprintLifecycleError("not_found", "blueprint revision not found");
  return row;
}

// ── Draft ───────────────────────────────────────────────────────────────────
/** Draft creation does not alter the workspace: it only records intent. */
export async function createBlueprintDraft(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: { blueprint: unknown; source: ProvenanceSource; reason?: string },
): Promise<{
  id: string;
  revisionNo: number;
  blueprintHash: string;
  validation: BlueprintValidation;
}> {
  assertCan(archetype, "config.manage");
  const validation = validateBlueprint(input.blueprint);
  // Store the NORMALIZED (parsed) form when it parses, so the hash is stable;
  // an invalid draft stores the raw input plus its structured errors.
  const content = validation.blueprint ?? input.blueprint;
  const hash = blueprintHash(content);
  const reason = (input.reason ?? "").slice(0, 1000) || null;
  return command(
    ctx,
    {
      audit: (r: { id: string; revisionNo: number }) => ({
        action: "blueprint.draft",
        entityType: "workspace_blueprint",
        entityId: r.id,
        summary: `Drafted workspace blueprint revision ${r.revisionNo}`,
      }),
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const next = (await tx.execute(sql`
        select coalesce(max(revision_no), 0) + 1 as n
        from public.workspace_blueprint_revision where org_id = ${ctx.orgId}
      `)) as unknown as Array<{ n: number }>;
      const revisionNo = next[0]!.n;
      const rows = (await tx.execute(sql`
        insert into public.workspace_blueprint_revision
          (org_id, revision_no, status, schema_version, blueprint, blueprint_hash,
           validation, proposed_source, proposed_reason, created_by)
        values (${ctx.orgId}, ${revisionNo}, 'draft', ${1},
                ${JSON.stringify(content)}::jsonb, ${hash},
                ${JSON.stringify({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings })}::jsonb,
                ${input.source}, ${reason}, ${ctx.userId})
        returning id
      `)) as unknown as Array<{ id: string }>;
      return {
        id: rows[0]!.id,
        revisionNo,
        blueprintHash: hash,
        validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
      };
    },
  );
}

/** Draft edits require the caller's expected hash — concurrent edits can
 * never silently overwrite one another (Part E). Any edit returns the
 * revision to 'draft' and voids prior validation/approval eligibility. */
export async function updateBlueprintDraft(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: { blueprint: unknown; expectedHash: string },
): Promise<{ blueprintHash: string; validation: BlueprintValidation }> {
  assertCan(archetype, "config.manage");
  const validation = validateBlueprint(input.blueprint);
  const content = validation.blueprint ?? input.blueprint;
  const hash = blueprintHash(content);
  return command(
    ctx,
    {
      audit: {
        action: "blueprint.update",
        entityType: "workspace_blueprint",
        entityId: id,
        summary: "Updated workspace blueprint draft",
      },
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const row = requireRevision(await readRevision(tx, ctx, id));
      if (row.status !== "draft" && row.status !== "validated") {
        throw new BlueprintLifecycleError(
          "invalid_state",
          `revision is ${row.status} — its content is immutable; draft a new revision instead`,
        );
      }
      if (row.blueprint_hash !== input.expectedHash) {
        throw new BlueprintLifecycleError(
          "stale_revision",
          "the draft changed since you loaded it — reload and re-apply your edit",
        );
      }
      await tx.execute(sql`
        update public.workspace_blueprint_revision
        set blueprint = ${JSON.stringify(content)}::jsonb,
            blueprint_hash = ${hash},
            status = 'draft',
            validation = ${JSON.stringify({ ok: validation.ok, errors: validation.errors, warnings: validation.warnings })}::jsonb
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return {
        blueprintHash: hash,
        validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
      };
    },
  );
}

// ── Validate ────────────────────────────────────────────────────────────────
export async function validateBlueprintRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<BlueprintValidation> {
  assertCan(archetype, "config.manage");
  return command(
    ctx,
    {
      audit: {
        action: "blueprint.validate",
        entityType: "workspace_blueprint",
        entityId: id,
        summary: "Validated workspace blueprint revision",
      },
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const row = requireRevision(await readRevision(tx, ctx, id));
      if (row.status !== "draft" && row.status !== "validated") {
        throw new BlueprintLifecycleError("invalid_state", `revision is ${row.status}`);
      }
      const validation = validateBlueprint(row.blueprint);
      const stored = {
        ok: validation.ok,
        errors: validation.errors,
        warnings: validation.warnings,
      };
      await tx.execute(sql`
        update public.workspace_blueprint_revision
        set validation = ${JSON.stringify(stored)}::jsonb,
            status = ${validation.ok ? "validated" : "draft"}
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return stored;
    },
  );
}

// ── Approve / reject ────────────────────────────────────────────────────────
/** Approval binds the SERVER-resolved approver to the EXACT content hash. */
export async function approveBlueprintRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: { expectedHash: string },
): Promise<{ approvedHash: string }> {
  assertCan(archetype, "config.manage");
  return command(
    ctx,
    {
      audit: {
        action: "blueprint.approve",
        entityType: "workspace_blueprint",
        entityId: id,
        summary: "Approved workspace blueprint revision",
      },
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const row = requireRevision(await readRevision(tx, ctx, id));
      if (row.status !== "validated") {
        throw new BlueprintLifecycleError(
          "invalid_state",
          `only a validated revision can be approved (revision is ${row.status})`,
        );
      }
      if (row.blueprint_hash !== input.expectedHash) {
        throw new BlueprintLifecycleError(
          "stale_revision",
          "the revision changed after you reviewed it — review the current content and approve again",
        );
      }
      // Re-validate at the moment of approval (fail closed — law 19).
      const validation = validateBlueprint(row.blueprint);
      if (!validation.ok) {
        throw new BlueprintLifecycleError("validation_failed", "revision no longer validates");
      }
      const contentHash = blueprintHash(validation.blueprint);
      if (contentHash !== row.blueprint_hash) {
        throw new BlueprintLifecycleError(
          "hash_mismatch",
          "stored content does not match its hash",
        );
      }
      await tx.execute(sql`
        update public.workspace_blueprint_revision
        set status = 'approved', approved_by = ${ctx.userId}, approved_at = now(),
            approved_hash = ${row.blueprint_hash}
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return { approvedHash: row.blueprint_hash };
    },
  );
}

export async function rejectBlueprintRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: { reason: string },
): Promise<void> {
  assertCan(archetype, "config.manage");
  const reason = input.reason.trim().slice(0, 1000);
  if (reason.length === 0) {
    throw new BlueprintLifecycleError("invalid_state", "a rejection requires a reason");
  }
  await command(
    ctx,
    {
      audit: {
        action: "blueprint.reject",
        entityType: "workspace_blueprint",
        entityId: id,
        summary: `Rejected workspace blueprint revision: ${reason.slice(0, 120)}`,
      },
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const row = requireRevision(await readRevision(tx, ctx, id));
      if (!["draft", "validated", "approved"].includes(row.status)) {
        throw new BlueprintLifecycleError("invalid_state", `revision is ${row.status}`);
      }
      await tx.execute(sql`
        update public.workspace_blueprint_revision
        set status = 'rejected', rejected_by = ${ctx.userId}, rejected_at = now(),
            rejected_reason = ${reason}
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return undefined;
    },
  );
}

// ── Apply ───────────────────────────────────────────────────────────────────
/**
 * Application requires the EXACT approved revision: status 'approved', the
 * stored content still hashing to the approved hash. Compiles with the
 * server-resolved entitlement snapshot, supersedes the previous applied
 * revision, and records a structured before/after on the audit row.
 * Re-applying an already-applied current revision is a safe no-op (law 9).
 */
export async function applyBlueprintRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<{ applied: boolean; compiled: CompiledWorkspace }> {
  assertCan(archetype, "config.manage");
  // Server-resolved plan truth — the ONLY entitlement input (law 3/4).
  const entitlements = (await resolveEntitlements(ctx)).features;
  return command(
    ctx,
    {
      audit: (r: { applied: boolean; before: unknown; after: unknown }) => ({
        action: "blueprint.apply",
        entityType: "workspace_blueprint",
        entityId: id,
        summary: r.applied
          ? "Applied workspace blueprint revision"
          : "Workspace blueprint revision already applied (no-op)",
        before: r.before,
        after: r.after,
      }),
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const row = requireRevision(await readRevision(tx, ctx, id));
      if (row.status === "applied") {
        // Idempotent re-apply of the current applied revision (law 9).
        return {
          applied: false,
          compiled: row.compiled!,
          before: null,
          after: null,
        };
      }
      if (row.status !== "approved") {
        throw new BlueprintLifecycleError(
          "invalid_state",
          `only an approved revision can be applied (revision is ${row.status})`,
        );
      }
      const approvedHash = (
        (await tx.execute(sql`
          select approved_hash from public.workspace_blueprint_revision
          where org_id = ${ctx.orgId} and id = ${id}
        `)) as unknown as Array<{ approved_hash: string | null }>
      )[0]?.approved_hash;
      if (!approvedHash || approvedHash !== row.blueprint_hash) {
        throw new BlueprintLifecycleError(
          "hash_mismatch",
          "the approval does not bind to this content — re-approve the current revision",
        );
      }
      if (
        blueprintHash(validateBlueprint(row.blueprint).blueprint ?? row.blueprint) !== approvedHash
      ) {
        throw new BlueprintLifecycleError(
          "hash_mismatch",
          "stored content does not match the approved hash",
        );
      }
      const compiled = compileBlueprint(row.blueprint, { entitlements });

      const prev = (await tx.execute(sql`
        select id, compiled from public.workspace_blueprint_revision
        where org_id = ${ctx.orgId} and status = 'applied'
      `)) as unknown as Array<{ id: string; compiled: CompiledWorkspace | null }>;
      for (const p of prev) {
        await tx.execute(sql`
          update public.workspace_blueprint_revision
          set status = 'superseded', superseded_by = ${id}
          where org_id = ${ctx.orgId} and id = ${p.id}
        `);
      }
      await tx.execute(sql`
        update public.workspace_blueprint_revision
        set status = 'applied', applied_by = ${ctx.userId}, applied_at = now(),
            compiled = ${JSON.stringify(compiled)}::jsonb,
            compiler_version = ${COMPILER_VERSION}
        where org_id = ${ctx.orgId} and id = ${id}
      `);
      return {
        applied: true,
        compiled,
        before: prev[0]?.compiled ?? null,
        after: compiled,
      };
    },
  ).then((r) => ({ applied: r.applied, compiled: r.compiled }));
}

// ── Undo ────────────────────────────────────────────────────────────────────
/**
 * Undo never rewrites history (law 11): it creates a NEW revision from the
 * previously applied blueprint and applies it — or, when there is no
 * predecessor, retires the current applied revision so the workspace returns
 * to its unconfigured baseline. The undoing user IS the authorizing human
 * (one explicit, audited action).
 */
export async function undoBlueprintApply(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<{ undone: true; restoredRevisionId: string | null }> {
  assertCan(archetype, "config.manage");
  const entitlements = (await resolveEntitlements(ctx)).features;
  return command(
    ctx,
    {
      audit: (r: { restoredRevisionId: string | null; undoneId: string }) => ({
        action: "blueprint.undo",
        entityType: "workspace_blueprint",
        entityId: r.undoneId,
        summary: r.restoredRevisionId
          ? "Undid workspace blueprint application (previous configuration restored as a new revision)"
          : "Undid workspace blueprint application (workspace returned to unconfigured baseline)",
      }),
    },
    async (tx) => {
      await lockOrgConfig(tx, ctx);
      const applied = (await tx.execute(sql`
        select ${COLS} from public.workspace_blueprint_revision
        where org_id = ${ctx.orgId} and status = 'applied'
      `)) as unknown as Row[];
      const current = applied[0];
      if (!current) {
        throw new BlueprintLifecycleError("nothing_to_undo", "no applied blueprint to undo");
      }
      // The most recent revision this one superseded, if any.
      const prev = (await tx.execute(sql`
        select ${COLS} from public.workspace_blueprint_revision
        where org_id = ${ctx.orgId} and superseded_by = ${current.id} and status = 'superseded'
        order by revision_no desc limit 1
      `)) as unknown as Row[];
      const predecessor = prev[0] ?? null;

      let restoredRevisionId: string | null = null;
      if (predecessor) {
        const validation = validateBlueprint(predecessor.blueprint);
        if (!validation.ok || !validation.blueprint) {
          throw new BlueprintLifecycleError(
            "validation_failed",
            "the previous configuration no longer validates — it cannot be restored automatically",
          );
        }
        const content = validation.blueprint;
        const hash = blueprintHash(content);
        const compiled = compileBlueprint(content, { entitlements });
        const next = (await tx.execute(sql`
          select coalesce(max(revision_no), 0) + 1 as n
          from public.workspace_blueprint_revision where org_id = ${ctx.orgId}
        `)) as unknown as Array<{ n: number }>;
        // Supersede FIRST (one-applied-per-org index), pointing at the new
        // revision's app-generated id — the self-FK is deferred to commit.
        restoredRevisionId = randomUUID();
        await tx.execute(sql`
          update public.workspace_blueprint_revision
          set status = 'superseded', superseded_by = ${restoredRevisionId}
          where org_id = ${ctx.orgId} and id = ${current.id}
        `);
        await tx.execute(sql`
          insert into public.workspace_blueprint_revision
            (id, org_id, revision_no, status, schema_version, blueprint, blueprint_hash,
             validation, compiled, compiler_version, proposed_source, proposed_reason,
             created_by, approved_by, approved_at, approved_hash, applied_by, applied_at)
          values (${restoredRevisionId}, ${ctx.orgId}, ${next[0]!.n}, 'applied', ${1},
                  ${JSON.stringify(content)}::jsonb, ${hash},
                  ${JSON.stringify({ ok: true, errors: [], warnings: validation.warnings })}::jsonb,
                  ${JSON.stringify(compiled)}::jsonb, ${COMPILER_VERSION},
                  'undo', ${"Undo: restore previously applied configuration"},
                  ${ctx.userId}, ${ctx.userId}, now(), ${hash}, ${ctx.userId}, now())
        `);
      } else {
        await tx.execute(sql`
          update public.workspace_blueprint_revision
          set status = 'superseded'
          where org_id = ${ctx.orgId} and id = ${current.id}
        `);
      }
      return { restoredRevisionId, undoneId: current.id };
    },
  ).then((r) => ({ undone: true as const, restoredRevisionId: r.restoredRevisionId }));
}

// ── Reads ───────────────────────────────────────────────────────────────────
export async function getBlueprintRevision(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<BlueprintRevision | null> {
  assertCan(archetype, "config.view");
  const row = await withCtx(ctx, (tx) => readRevision(tx, ctx, id));
  return row ? toRevision(row) : null;
}

/** The current applied workspace, or null (consumers fail closed on null). */
export async function getAppliedWorkspace(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<BlueprintRevision | null> {
  assertCan(archetype, "config.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select ${COLS} from public.workspace_blueprint_revision
      where org_id = ${ctx.orgId} and status = 'applied'
    `),
  )) as unknown as Row[];
  return rows[0] ? toRevision(rows[0]) : null;
}

export async function listBlueprintRevisions(
  ctx: Ctx,
  archetype: RoleArchetype,
  limit = 20,
): Promise<BlueprintRevision[]> {
  assertCan(archetype, "config.view");
  const n = Math.max(1, Math.min(100, limit));
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select ${COLS} from public.workspace_blueprint_revision
      where org_id = ${ctx.orgId}
      order by revision_no desc
      limit ${n}
    `),
  )) as unknown as Row[];
  return rows.map(toRevision);
}
