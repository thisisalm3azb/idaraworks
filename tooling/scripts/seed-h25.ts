/**
 * Bleed-harness seeders for the H25 Management Studio tables.
 *
 * Same contract as seed-h23/h24 — ONE seeder per org-scoped table via the
 * OWNER connection; chains build their own dependencies so each stands alone.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);

async function planRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.studio_plan (id, org_id, reference, name, created_by)
          values (${id}, ${org}, ${"BLPL-" + short()}, 'Bleed plan', ${u})`;
  return id;
}

async function nodeRow(o: Owner, org: string, u: string, plan?: string): Promise<string> {
  const p = plan ?? (await planRow(o, org, u));
  const id = randomUUID();
  await o`insert into public.studio_node (id, org_id, plan_id, node_type, title, created_by)
          values (${id}, ${org}, ${p}, 'note', 'Bleed node', ${u})`;
  return id;
}

async function scenarioRow(o: Owner, org: string, u: string): Promise<string> {
  const p = await planRow(o, org, u);
  const id = randomUUID();
  await o`insert into public.studio_scenario (id, org_id, plan_id, name, created_by)
          values (${id}, ${org}, ${p}, 'Bleed scenario', ${u})`;
  return id;
}

export const H25_SEEDERS: Record<string, Seeder> = {
  studio_plan: async (o, org, u) => {
    await planRow(o, org, u);
  },
  studio_node: async (o, org, u) => {
    await nodeRow(o, org, u);
  },
  studio_edge: async (o, org, u) => {
    const p = await planRow(o, org, u);
    const a = await nodeRow(o, org, u, p);
    const b = await nodeRow(o, org, u, p);
    await o`insert into public.studio_edge
              (org_id, plan_id, source_node_id, target_node_id, edge_type, created_by)
            values (${org}, ${p}, ${a}, ${b}, 'reference', ${u})`;
  },
  studio_view: async (o, org, u) => {
    const p = await planRow(o, org, u);
    await o`insert into public.studio_view (org_id, plan_id, name, view_kind, owner_user_id)
            values (${org}, ${p}, 'Bleed view', 'canvas', ${u})`;
  },
  studio_scenario: async (o, org, u) => {
    await scenarioRow(o, org, u);
  },
  studio_scenario_change: async (o, org, u) => {
    const s = await scenarioRow(o, org, u);
    await o`insert into public.studio_scenario_change
              (org_id, scenario_id, target_kind, target_id, field, new_value, created_by)
            values (${org}, ${s}, 'node', ${randomUUID()}, 'dueDate', '"2033-01-01"'::jsonb, ${u})`;
  },
  studio_baseline: async (o, org, u) => {
    const p = await planRow(o, org, u);
    await o`insert into public.studio_baseline (org_id, plan_id, name, captured_by)
            values (${org}, ${p}, ${"Bleed baseline " + short()}, ${u})`;
  },
  studio_version: async (o, org, u) => {
    const p = await planRow(o, org, u);
    await o`insert into public.studio_version (org_id, plan_id, name, created_by)
            values (${org}, ${p}, 'Bleed checkpoint', ${u})`;
  },
};
