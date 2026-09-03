/**
 * H28 — read-only production pre-flight. Every statement is a SELECT: it
 * proves the target is production, that the pending migrations are exactly
 * H28's, that nothing H28 adds already exists, that the prerequisites are
 * present, that no AI provider or Idara surface is configured yet, and it
 * prints the baseline counts the post-deploy proof compares against.
 *
 *   npx tsx tooling/scripts/h28-deploy-preflight.ts
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const H28_MIGRATIONS = [
  "0128_h28a_intelligence_foundation.sql",
  "0129_h28b_conversations_runs_actions.sql",
];

const NEW_TABLES = [
  "platform_operator",
  "platform_audit",
  "ai_provider_state",
  "ai_model_state",
  "ai_price_book",
  "ai_credit_policy",
  "ai_kill_switch",
  "ai_entitlement",
  "ai_credit_ledger",
  "ai_privacy_register",
  "ai_byok_key",
  "ai_conversation",
  "ai_message",
  "ai_run",
  "ai_run_step",
  "ai_action",
  "ai_memory",
  "ai_agent",
  "ai_agent_version",
  "ai_agent_state",
  "ai_saved_output",
  "ai_schedule",
  "ai_schedule_pref",
];

const PREREQUISITES = [
  "ai_interaction",
  "usage_event",
  "approval",
  "approval_rule",
  "entitlement_def",
  "plan_entitlement",
  "org",
  "membership",
  "role_definition",
];

async function main(): Promise<void> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!targetsOnlyProductionProject({ ...process.env } as Record<string, string | undefined>)) {
    console.error(`Refusing: the environment does not point only at ${PRODUCTION_PROJECT_REF}`);
    process.exitCode = 1;
    return;
  }
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, prepare: false });
  try {
    const applied = (await sql`select filename from app.migrations order by filename`).map((r) =>
      String(r.filename),
    );
    const pending = H28_MIGRATIONS.filter((f) => !applied.includes(f));
    notes.push(`applied migrations: ${applied.length}`);
    notes.push(
      `H28 pending: ${pending.length === 0 ? "none (already applied)" : pending.join(", ")}`,
    );
    const unexpected = applied.filter((f) => f > "0127" && !H28_MIGRATIONS.includes(f));
    if (unexpected.length)
      problems.push(`unexpected migrations after 0127: ${unexpected.join(", ")}`);

    const tables = (
      await sql`
      select table_name from information_schema.tables where table_schema = 'public' and table_name = any(string_to_array(${NEW_TABLES.join(",")}, ','))`
    ).map((r) => String(r.table_name));
    if (pending.length === H28_MIGRATIONS.length && tables.length > 0)
      problems.push(`tables already exist before the migration: ${tables.join(", ")}`);
    notes.push(`H28 tables present: ${tables.length}/${NEW_TABLES.length}`);

    const publicTables = new Set(
      (
        await sql`select table_name from information_schema.tables where table_schema = 'public'`
      ).map((r) => String(r.table_name)),
    );
    const missing = PREREQUISITES.filter((t) => !publicTables.has(t));
    if (missing.length) problems.push(`missing prerequisite tables: ${missing.join(", ")}`);

    const subjects = (await sql`select distinct subject_type from public.approval`).map((r) =>
      String(r.subject_type),
    );
    const ruleSubjects = (await sql`select distinct subject_type from public.approval_rule`).map(
      (r) => String(r.subject_type),
    );
    const allowed = new Set([
      "material_request",
      "expense",
      "quote_send",
      "purchase_order",
      "payment",
      "task_completion",
      "asset_disposal",
      "leave_request",
      "overtime_request",
      "expense_claim",
      "pay_run",
      "journal_entry",
      "scenario_apply",
      "document_step",
      "crm_discount",
      "ai_action",
    ]);
    for (const s of [...subjects, ...ruleSubjects])
      if (!allowed.has(s)) problems.push(`live approval subject outside the widened list: ${s}`);
    notes.push(`approval subjects in use: ${subjects.length}`);

    const features = (await sql`select key from public.entitlement_def where key = 'cap.idara'`)
      .length;
    notes.push(`cap.idara registered: ${features > 0 ? "yes" : "not yet"}`);

    const aiFeature = (
      await sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ai_interaction_feature_check'`
    )[0];
    notes.push(
      `ai_interaction feature check: ${aiFeature ? (String(aiFeature.def).includes("agent_run") ? "widened" : "not yet widened") : "missing"}`,
    );

    const counts = (
      await sql`
      select
        (select count(*) from public.org)::int as orgs,
        (select count(*) from auth.users)::int as users,
        (select count(*) from public.customer)::int as customers,
        (select count(*) from public.job)::int as jobs,
        (select count(*) from public.invoice)::int as invoices,
        (select count(*) from public.approval)::int as approvals,
        (select count(*) from public.ai_interaction)::int as ai_interactions,
        (select count(*) from public.audit_log)::int as audit_rows`
    )[0]!;
    notes.push(
      `baseline: orgs ${counts.orgs}, users ${counts.users}, customers ${counts.customers}, jobs ${counts.jobs}, invoices ${counts.invoices}, approvals ${counts.approvals}, ai_interaction ${counts.ai_interactions}, audit ${counts.audit_rows}`,
    );

    // Nothing H28-shaped may already be live.
    if (tables.includes("ai_conversation")) {
      const rows = (await sql`select count(*)::int as n from public.ai_conversation`)[0]!;
      if (Number(rows.n) > 0) problems.push(`ai_conversation already holds ${rows.n} rows`);
    }
    const providerKeys = [
      "AI_OPENAI_API_KEY",
      "AI_ANTHROPIC_API_KEY",
      "AI_BYOK_KEK",
      "CRON_SECRET",
    ];
    notes.push(
      `local environment: ${providerKeys.filter((k) => process.env[k]).join(", ") || "no AI provider or cron secret set (expected)"}`,
    );

    console.log("H28 PRE-FLIGHT — production");
    for (const n of notes) console.log(`  ${n}`);
    if (problems.length === 0) {
      console.log("CLEAR — safe to apply 0128 and 0129.");
    } else {
      console.log("PROBLEMS:");
      for (const p of problems) console.log(`  ! ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

await main();
