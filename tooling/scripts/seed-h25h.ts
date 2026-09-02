/**
 * Bleed seeders for the H25H tables (skills and task allocations): one row
 * per table per organisation, with the parents each foreign key needs, so
 * the cross-tenant harness can prove none of them leak.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

async function skillRow(o: Owner, org: string, u: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.skill (id, org_id, key, name, created_by)
          values (${id}, ${org}, ${"bleed-" + randomUUID().slice(0, 8)}, 'Bleed skill', ${u})`;
  return id;
}

async function employeeRow(o: Owner, org: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.employee (id, org_id, name) values (${id}, ${org}, 'Bleed Skilled Worker')`;
  return id;
}

export const H25H_SEEDERS: Record<string, Seeder> = {
  skill: async (o, org, u) => {
    await skillRow(o, org, u);
  },
  employee_skill: async (o, org, u) => {
    const skill = await skillRow(o, org, u);
    const emp = await employeeRow(o, org);
    await o`insert into public.employee_skill (org_id, employee_id, skill_id, level, created_by)
            values (${org}, ${emp}, ${skill}, 3, ${u})`;
  },
  task_allocation: async (o, org, u) => {
    const job = randomUUID();
    const task = randomUUID();
    const emp = await employeeRow(o, org);
    await o`insert into public.job (id, org_id, reference, name, status_key, status_category, created_by)
            values (${job}, ${org}, ${"BLA-" + randomUUID().slice(0, 8)}, 'Bleed Allocation Job', 'draft', 'draft', ${u})`;
    await o`insert into public.task (id, org_id, job_id, title, created_by)
            values (${task}, ${org}, ${job}, 'bleed allocated task', ${u})`;
    await o`insert into public.task_allocation (org_id, task_id, employee_id, share_pct, created_by)
            values (${org}, ${task}, ${emp}, 50, ${u})`;
  },
};
