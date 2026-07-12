/**
 * Config-revision recorder (doc 01 D-1.8; S0 checklist §2 "config_revision
 * pipeline skeleton"). Every config-artifact change records a detailed
 * before/after in `config_revision` AND a compliance summary in `audit_log` —
 * atomically, through the command path. The config-EDITING pipeline (which calls
 * this) is S1; this is the substrate so the audit path is complete from the
 * first config write.
 */
import { randomUUID } from "node:crypto";
import { command } from "@/platform/audit";
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";

export type ConfigRevisionInput = {
  artifactKey: string; // e.g. 'terminology.overrides', 'preset.<id>'
  before: unknown; // null on creation
  after: unknown; // null on delete
  aiFlag?: boolean; // AI-suggested/authored
  summary?: string;
};

/** Record a config change: config_revision (full diff) + audit_log (summary). */
export async function recordConfigRevision(ctx: Ctx, input: ConfigRevisionInput): Promise<string> {
  // Id generated in app (AR-1); NO `returning`. config_revision reads are gated
  // to owner/admin, but any org member may INSERT — an INSERT ... RETURNING would
  // re-apply the SELECT policy and 42501 for a non-admin config editor (S1),
  // rolling back both the revision AND its audit row. Same trap notify.ts avoids.
  const id = randomUUID();
  await command(
    ctx,
    {
      // audit_log is the lean compliance SUMMARY pointing at the config_revision
      // row; the full before/after diff lives in config_revision (no duplication).
      audit: {
        action: "config.revise",
        entityType: "config" as const,
        entityId: id,
        summary: input.summary ?? `Updated config ${input.artifactKey}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.config_revision
          (id, org_id, artifact_key, before_data, after_data, actor_user_id, ai_flag, summary)
        values (${id}, ${ctx.orgId}, ${input.artifactKey},
                ${input.before === undefined ? null : JSON.stringify(input.before)}::jsonb,
                ${input.after === undefined ? null : JSON.stringify(input.after)}::jsonb,
                ${ctx.userId}, ${input.aiFlag ?? false}, ${input.summary ?? null})
      `);
    },
  );
  return id;
}

/**
 * Transaction-scoped variant for the S1 pipeline: writes the config_revision
 * row inside the CALLER'S command transaction, so the artifact write, the
 * revision, and the audit row are one atomic unit (the recordActivityIn
 * pattern from Phase F). Returns nothing — the caller supplies the id.
 */
export async function insertConfigRevisionIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
  input: ConfigRevisionInput,
): Promise<void> {
  await tx.execute(sql`
    insert into public.config_revision
      (id, org_id, artifact_key, before_data, after_data, actor_user_id, ai_flag, summary)
    values (${id}, ${ctx.orgId}, ${input.artifactKey},
            ${input.before === undefined || input.before === null ? null : JSON.stringify(input.before)}::jsonb,
            ${input.after === undefined || input.after === null ? null : JSON.stringify(input.after)}::jsonb,
            ${ctx.userId}, ${input.aiFlag ?? false}, ${input.summary ?? null})
  `);
}
