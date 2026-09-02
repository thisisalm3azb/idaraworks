/**
 * Bleed-harness seeders for the H27 Revenue Studio tables.
 *
 * Same contract as seed-h23..h26 — ONE seeder per org-scoped table via the
 * OWNER connection; chains build their own dependencies so each stands alone.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);

async function customerRow(o: Owner, org: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.customer (id, org_id, name) values (${id}, ${org}, ${"Bleed customer " + short()})`;
  return id;
}

async function contactRow(o: Owner, org: string): Promise<{ contact: string; customer: string }> {
  const customer = await customerRow(o, org);
  const contact = randomUUID();
  await o`insert into public.customer_contact (id, org_id, customer_id, name)
          values (${contact}, ${org}, ${customer}, 'Bleed contact')`;
  return { contact, customer };
}

async function leadRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.lead (id, org_id, name, status, created_by)
          values (${id}, ${org}, 'Bleed lead', 'new', ${u})`;
  return id;
}

async function opportunityRow(o: Owner, org: string, u: string): Promise<string> {
  const stage = "bleedrev_" + short();
  await o`insert into public.pipeline_stage (org_id, key, label, sort, category)
          values (${org}, ${stage}, '{"en":"Bleed stage","ar":"مرحلة"}'::jsonb, 92, 'open')`;
  const id = randomUUID();
  await o`insert into public.opportunity (id, org_id, name, stage_key, status, created_by)
          values (${id}, ${org}, 'Bleed opportunity', ${stage}, 'open', ${u})`;
  return id;
}

async function campaignRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.crm_campaign (id, org_id, name, created_by)
          values (${id}, ${org}, 'Bleed campaign', ${u})`;
  return id;
}

async function automationRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.crm_automation (id, org_id, name, trigger, owner_user_id, created_by)
          values (${id}, ${org}, 'Bleed automation', 'lead_created', ${u}, ${u})`;
  return id;
}

export const H27_SEEDERS: Record<string, Seeder> = {
  crm_territory: async (o, org, u) => {
    await o`insert into public.crm_territory (org_id, key, name, created_by)
            values (${org}, ${"bleed_" + short()}, '{"en":"Bleed territory","ar":"منطقة"}'::jsonb, ${u})`;
  },
  crm_pipeline: async (o, org, u) => {
    await o`insert into public.crm_pipeline (org_id, key, name, created_by)
            values (${org}, ${"bleed_" + short()}, '{"en":"Bleed pipeline","ar":"خط"}'::jsonb, ${u})`;
  },
  crm_campaign: async (o, org, u) => {
    await campaignRow(o, org, u);
  },
  crm_opportunity_stakeholder: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_opportunity_stakeholder (org_id, opportunity_id, name, created_by)
            values (${org}, ${opp}, 'Bleed stakeholder', ${u})`;
  },
  crm_opportunity_product: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_opportunity_product (org_id, opportunity_id, description, qty, unit_price_minor, created_by)
            values (${org}, ${opp}, 'Bleed product', 1, 1000, ${u})`;
  },
  crm_opportunity_competitor: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_opportunity_competitor (org_id, opportunity_id, name, created_by)
            values (${org}, ${opp}, 'Bleed competitor', ${u})`;
  },
  crm_opportunity_risk: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_opportunity_risk (org_id, opportunity_id, title, created_by)
            values (${org}, ${opp}, 'Bleed risk', ${u})`;
  },
  crm_discount: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_discount
              (org_id, opportunity_id, requested_pct, list_total_minor, discounted_total_minor, currency, reason, requested_by)
            values (${org}, ${opp}, 10, 100000, 90000, 'AED', 'Bleed discount', ${u})`;
  },
  crm_deal_canvas: async (o, org, u) => {
    const opp = await opportunityRow(o, org, u);
    await o`insert into public.crm_deal_canvas (org_id, opportunity_id, updated_by)
            values (${org}, ${opp}, ${u})`;
  },
  crm_consent: async (o, org, u) => {
    const lead = await leadRow(o, org, u);
    await o`insert into public.crm_consent (org_id, lead_id, channel, status, source, actor_user_id)
            values (${org}, ${lead}, 'email', 'granted', 'form', ${u})`;
  },
  crm_suppression: async (o, org, u) => {
    await o`insert into public.crm_suppression (org_id, channel, address, reason, actor_user_id)
            values (${org}, 'email', ${"bleed-" + short() + "@example.invalid"}, 'unsubscribe', ${u})`;
  },
  crm_touch: async (o, org, u) => {
    const campaign = await campaignRow(o, org, u);
    const lead = await leadRow(o, org, u);
    await o`insert into public.crm_touch (org_id, campaign_id, lead_id, created_by)
            values (${org}, ${campaign}, ${lead}, ${u})`;
  },
  crm_forecast_snapshot: async (o, org, u) => {
    await o`insert into public.crm_forecast_snapshot (org_id, period_key, captured_by, currency, totals)
            values (${org}, '2026-09', ${u}, 'AED', '{"pipelineMinor":0}'::jsonb)`;
  },
  crm_scenario: async (o, org, u) => {
    await o`insert into public.crm_scenario (org_id, name, created_by)
            values (${org}, 'Bleed scenario', ${u})`;
  },
  crm_target: async (o, org, u) => {
    await o`insert into public.crm_target (org_id, scope_kind, metric, period_start, period_end, amount_minor, currency, created_by)
            values (${org}, 'org', 'revenue', '2026-09-01', '2026-09-30', 1000000, 'AED', ${u})`;
  },
  crm_customer_signal: async (o, org, u) => {
    const customer = await customerRow(o, org);
    await o`insert into public.crm_customer_signal (org_id, customer_id, kind, score, created_by)
            values (${org}, ${customer}, 'satisfaction', 4, ${u})`;
  },
  crm_merge: async (o, org, u) => {
    const a = await customerRow(o, org);
    const b = await customerRow(o, org);
    await o`insert into public.crm_merge
              (org_id, source_customer_id, target_customer_id, preview, source_snapshot, target_snapshot, reason, applied_by)
            values (${org}, ${a}, ${b}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Bleed merge', ${u})`;
  },
  crm_automation: async (o, org, u) => {
    await automationRow(o, org, u);
  },
  crm_automation_run: async (o, org, u) => {
    const automation = await automationRow(o, org, u);
    const lead = await leadRow(o, org, u);
    await o`insert into public.crm_automation_run
              (org_id, automation_id, subject_type, subject_id, occurrence_key, mode, status, ran_by)
            values (${org}, ${automation}, 'lead', ${lead}, ${"bleed-" + short()}, 'dry_run', 'matched', ${u})`;
  },
};

// Keeps the contact helper referenced even when a future seeder is added without it.
void contactRow;
