/**
 * Bleed-harness seeders for the H28 Idara Intelligence org-scoped tables.
 *
 * Same contract as seed-h23..h27 — ONE seeder per org-scoped table via the
 * OWNER connection; chains build their own dependencies so each stands alone.
 * Global tables (price book, provider state, kill switches, platform audit,
 * platform operator, credit policy) carry no org_id and are outside the sweep.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);
const period = () => new Date().toISOString().slice(0, 7);

async function conversationRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.ai_conversation (id, org_id, user_id, title, agent_id)
          values (${id}, ${org}, ${u}, ${"Bleed conversation " + short()}, 'idara')`;
  return id;
}

async function runRow(
  o: Owner,
  org: string,
  u: string,
): Promise<{ run: string; conversation: string }> {
  const conversation = await conversationRow(o, org, u);
  const run = randomUUID();
  await o`insert into public.ai_run (id, org_id, conversation_id, root_run_id, agent_id, agent_version, kind, status, requested_by, input_text)
          values (${run}, ${org}, ${conversation}, ${run}, 'idara', 1, 'interactive', 'completed', ${u}, 'Bleed run')`;
  return { run, conversation };
}

async function customAgentRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.ai_agent (id, org_id, key, base_agent_id, name_en, name_ar, created_by)
          values (${id}, ${org}, ${"bleed_" + short()}, 'idara', 'Bleed agent', 'وكيل', ${u})`;
  return id;
}

export const H28_SEEDERS: Record<string, Seeder> = {
  ai_entitlement: async (o, org, u) => {
    await o`insert into public.ai_entitlement (org_id, version, mode, reason, set_by)
            values (${org}, 1, 'trial', 'bleed', ${u})`;
  },
  ai_credit_ledger: async (o, org, u) => {
    await o`insert into public.ai_credit_ledger (org_id, kind, credits, period_key, note, created_by)
            values (${org}, 'manual', 5, ${period()}, 'bleed', ${u})`;
  },
  ai_privacy_register: async (o, org, u) => {
    await o`insert into public.ai_privacy_register (org_id, provider_key, lawful_basis, processor_agreement_ref, transfer_mechanism, recorded_by)
            values (${org}, 'deterministic', 'contract', 'bleed-dpa', 'none', ${u})`;
  },
  ai_byok_key: async (o, org, u) => {
    await o`insert into public.ai_byok_key (org_id, provider_key, key_ciphertext, key_iv, key_tag, last4, created_by)
            values (${org}, 'openai', 'bleed', 'bleed', 'bleed', 'xxxx', ${u})`;
  },
  ai_conversation: async (o, org, u) => {
    await conversationRow(o, org, u);
  },
  ai_message: async (o, org, u) => {
    const conversation = await conversationRow(o, org, u);
    await o`insert into public.ai_message (org_id, conversation_id, seq, role, agent_id, blocks)
            values (${org}, ${conversation}, 1, 'user', null, '[{"kind":"text","text":"bleed"}]'::jsonb)`;
  },
  ai_run: async (o, org, u) => {
    await runRow(o, org, u);
  },
  ai_run_step: async (o, org, u) => {
    const { run } = await runRow(o, org, u);
    await o`insert into public.ai_run_step (org_id, run_id, seq, kind, status, summary)
            values (${org}, ${run}, 1, 'note', 'completed', 'bleed')`;
  },
  ai_action: async (o, org, u) => {
    const { run } = await runRow(o, org, u);
    await o`insert into public.ai_action (org_id, run_id, tool_id, risk_class, title, preview, idempotency_key, requested_by)
            values (${org}, ${run}, 'crm.note.add', 3, 'Bleed action', '{}'::jsonb, ${"bleed-" + short()}, ${u})`;
  },
  ai_memory: async (o, org, u) => {
    await o`insert into public.ai_memory (org_id, scope, user_id, kind, key, value, created_by)
            values (${org}, 'user', ${u}, 'preference', ${"bleed_" + short()}, '"x"'::jsonb, ${u})`;
  },
  ai_agent: async (o, org, u) => {
    await customAgentRow(o, org, u);
  },
  ai_agent_version: async (o, org, u) => {
    const agent = await customAgentRow(o, org, u);
    await o`insert into public.ai_agent_version (org_id, agent_id, version, snapshot, created_by)
            values (${org}, ${agent}, 1, '{}'::jsonb, ${u})`;
  },
  ai_agent_state: async (o, org, u) => {
    await o`insert into public.ai_agent_state (org_id, agent_id, enabled, set_by)
            values (${org}, 'tax', false, ${u})`;
  },
  ai_saved_output: async (o, org, u) => {
    const { run } = await runRow(o, org, u);
    await o`insert into public.ai_saved_output (org_id, run_id, kind, title, content, agent_id, agent_version, created_by)
            values (${org}, ${run}, 'analysis', 'Bleed output', '{}'::jsonb, 'idara', 1, ${u})`;
  },
  ai_schedule: async (o, org, u) => {
    await o`insert into public.ai_schedule (org_id, kind, agent_id, cadence, created_by)
            values (${org}, 'management_briefing', 'executive', 'daily', ${u})`;
  },
  ai_schedule_pref: async (o, org, u) => {
    const id = randomUUID();
    await o`insert into public.ai_schedule (id, org_id, kind, agent_id, cadence, created_by)
            values (${id}, ${org}, 'renewal_reminders', 'customer_success', 'weekly', ${u})`;
    await o`insert into public.ai_schedule_pref (org_id, schedule_id, user_id, muted)
            values (${org}, ${id}, ${u}, true)`;
  },
};
