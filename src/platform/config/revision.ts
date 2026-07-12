/**
 * Config-revision recorder (doc 01 D-1.8; S0 checklist §2 "config_revision
 * pipeline skeleton"). Every config-artifact change records a detailed
 * before/after in `config_revision` AND a compliance summary in `audit_log` —
 * atomically, through the command path. The config-EDITING pipeline (which calls
 * this) is S1; this is the substrate so the audit path is complete from the
 * first config write.
 */
import { command } from "@/platform/audit";
import { sql, type Ctx } from "@/platform/tenancy";

export type ConfigRevisionInput = {
  artifactKey: string; // e.g. 'terminology.overrides', 'preset.<id>'
  before: unknown; // null on creation
  after: unknown; // null on delete
  aiFlag?: boolean; // AI-suggested/authored
  summary?: string;
};

/** Record a config change: config_revision (full diff) + audit_log (summary). */
export async function recordConfigRevision(ctx: Ctx, input: ConfigRevisionInput): Promise<string> {
  return command(
    ctx,
    {
      // audit_log is the lean compliance SUMMARY pointing at the config_revision
      // row; the full before/after diff lives in config_revision (no duplication).
      audit: (id: string) => ({
        action: "config.revise",
        entityType: "config" as const,
        entityId: id,
        summary: input.summary ?? `Updated config ${input.artifactKey}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.config_revision
          (org_id, artifact_key, before_data, after_data, actor_user_id, ai_flag, summary)
        values (${ctx.orgId}, ${input.artifactKey},
                ${input.before === undefined ? null : JSON.stringify(input.before)}::jsonb,
                ${input.after === undefined ? null : JSON.stringify(input.after)}::jsonb,
                ${ctx.userId}, ${input.aiFlag ?? false}, ${input.summary ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    },
  );
}
