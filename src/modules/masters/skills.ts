/**
 * H25H — skills: a named capability people hold, at a level. Canonical people
 * data (masters module), read by the studio's capacity views through the
 * door. No pay or contract data is anywhere near this file.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

export type SkillRow = {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  active: boolean;
};

export async function listSkills(ctx: Ctx, archetype: RoleArchetype): Promise<SkillRow[]> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, key, name, name_ar, active from public.skill
      where org_id = ${ctx.orgId} order by active desc, name
    `),
  )) as unknown as Array<{
    id: string;
    key: string;
    name: string;
    name_ar: string | null;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    nameAr: r.name_ar,
    active: r.active,
  }));
}

export const CreateSkillInput = z.object({
  key: z.string().regex(/^[a-z0-9_.-]{1,40}$/),
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
});

export async function createSkill(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const input = CreateSkillInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "skill.create",
        entityType: "skill",
        entityId: r.id,
        summary: `Added skill "${input.name}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.skill (org_id, key, name, name_ar, created_by)
        values (${ctx.orgId}, ${input.key}, ${input.name}, ${input.nameAr ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type EmployeeSkillRow = {
  id: string;
  employeeId: string;
  skillId: string;
  skillKey: string;
  skillName: string;
  level: number;
};

/** Live skills for the given employees (all employees when omitted). */
export async function listEmployeeSkills(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeIds?: string[],
): Promise<EmployeeSkillRow[]> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select es.id::text as id, es.employee_id::text as employee_id, es.skill_id::text as skill_id,
             s.key as skill_key, s.name as skill_name, es.level
      from public.employee_skill es
      join public.skill s on s.id = es.skill_id and s.org_id = es.org_id
      where es.org_id = ${ctx.orgId} and es.removed_at is null
        and (${employeeIds === undefined}
             or es.employee_id = any(string_to_array(${(employeeIds ?? []).join(",")}, ',')::uuid[]))
      order by s.name
    `),
  )) as unknown as Array<{
    id: string;
    employee_id: string;
    skill_id: string;
    skill_key: string;
    skill_name: string;
    level: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    skillId: r.skill_id,
    skillKey: r.skill_key,
    skillName: r.skill_name,
    level: Number(r.level),
  }));
}

export const SetEmployeeSkillInput = z.object({
  employeeId: z.string().uuid(),
  skillId: z.string().uuid(),
  /** 1..5; null removes the skill from the person. */
  level: z.number().int().min(1).max(5).nullable(),
});

export async function setEmployeeSkill(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  const input = SetEmployeeSkillInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: input.level === null ? "employee_skill.remove" : "employee_skill.set",
        entityType: "employee_skill",
        entityId: input.employeeId,
        summary:
          input.level === null
            ? "Removed a skill from a person"
            : `Set a skill at level ${input.level}`,
      },
    },
    async (tx) => {
      if (input.level === null) {
        await tx.execute(sql`
          update public.employee_skill set removed_at = now(), updated_at = now()
          where org_id = ${ctx.orgId} and employee_id = ${input.employeeId}
            and skill_id = ${input.skillId} and removed_at is null
        `);
        return;
      }
      const updated = (await tx.execute(sql`
        update public.employee_skill set level = ${input.level}, updated_at = now()
        where org_id = ${ctx.orgId} and employee_id = ${input.employeeId}
          and skill_id = ${input.skillId} and removed_at is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (updated[0]) return;
      await tx.execute(sql`
        insert into public.employee_skill (org_id, employee_id, skill_id, level, created_by)
        values (${ctx.orgId}, ${input.employeeId}, ${input.skillId}, ${input.level}, ${ctx.userId})
      `);
    },
  );
}
