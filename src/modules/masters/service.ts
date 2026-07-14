/**
 * Masters module service (S1 — doc 11: employees + privileged side-tables,
 * teams, customers, suppliers, item catalog). The module's ONLY public surface
 * (Bible §3.2). Every mutation is a command() (atomic audit); ids are
 * app-generated with NO returning (the RETURNING-under-restrictive-policy trap);
 * item costs/prices are redacted SERVER-SIDE by ctx flags (F-23); salary/HR
 * walls are DB-level RLS (0020) — this layer additionally gates by can().
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { requireCapability } from "@/platform/entitlements";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

const name = (max: number) => z.string().trim().min(1).max(max);
const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

// ── employees ────────────────────────────────────────────────────────────────
export const EmployeeInput = z.object({
  name: name(120),
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  phone: opt(32),
  active: z.boolean().default(true),
});
export type EmployeeInput = z.infer<typeof EmployeeInput>;

export async function createEmployee(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const data = EmployeeInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "employee.create",
        entityType: "employee",
        entityId: id,
        summary: `Added employee ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.employee (id, org_id, name, team_id, user_id, phone, active)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.teamId ?? null},
                ${data.userId ?? null}, ${data.phone ?? null}, ${data.active})
      `),
  );
  return { id };
}

// Update input deliberately EXCLUDES userId: S1 ships no link-management UI,
// and a form that never posts user_id must not sever an existing member link
// (review fix). Linking arrives with its own surface.
export const EmployeeUpdateInput = EmployeeInput.omit({ userId: true });

export async function updateEmployee(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "employees.manage");
  const data = EmployeeUpdateInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "employee.update",
        entityType: "employee",
        entityId: id,
        summary: `Updated employee ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.employee
        set name = ${data.name}, team_id = ${data.teamId ?? null},
            phone = ${data.phone ?? null},
            active = ${data.active}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id}
      `),
  );
}

/** Salary terms ✱ — cost wall (DB RLS gate + O/A action gate). */
export const EmployeeTermsInput = z.object({
  salaryMinor: z.number().int().min(0),
  hourlyCostMinor: z.number().int().min(0).optional(), // default salary/208 (doc 01)
  otRate: z.number().min(0).max(10).default(1.25),
});

export async function setEmployeeTerms(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "employees.terms.manage");
  const data = EmployeeTermsInput.parse(input);
  const hourly = data.hourlyCostMinor ?? Math.round(data.salaryMinor / 208);
  await command(
    ctx,
    {
      audit: {
        action: "employee.terms.set",
        entityType: "employee",
        entityId: employeeId,
        // Identifiers only — never salary VALUES in the audit summary (§5.9).
        summary: "Updated employee salary terms",
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.employee_terms (employee_id, org_id, salary_minor, hourly_cost_minor, ot_rate)
        values (${employeeId}, ${ctx.orgId}, ${data.salaryMinor}, ${hourly}, ${data.otRate})
        on conflict (employee_id) do update
          set salary_minor = excluded.salary_minor,
              hourly_cost_minor = excluded.hourly_cost_minor,
              ot_rate = excluded.ot_rate,
              updated_at = now()
      `),
  );
}

export const EmployeeHrInput = z.object({
  idNumber: opt(64),
  idExpiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  passportNumber: opt(64),
  passportExpiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  visaExpiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: opt(2000),
});

export async function setEmployeeHr(
  ctx: Ctx,
  archetype: RoleArchetype,
  employeeId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "employees.hr.manage");
  const data = EmployeeHrInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "employee.hr.set",
        entityType: "employee",
        entityId: employeeId,
        summary: "Updated employee HR record", // identifiers only
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.employee_hr
          (employee_id, org_id, id_number, id_expiry, passport_number, passport_expiry, visa_expiry, notes)
        values (${employeeId}, ${ctx.orgId}, ${data.idNumber ?? null}, ${data.idExpiry ?? null},
                ${data.passportNumber ?? null}, ${data.passportExpiry ?? null},
                ${data.visaExpiry ?? null}, ${data.notes ?? null})
        on conflict (employee_id) do update
          set id_number = excluded.id_number, id_expiry = excluded.id_expiry,
              passport_number = excluded.passport_number, passport_expiry = excluded.passport_expiry,
              visa_expiry = excluded.visa_expiry, notes = excluded.notes, updated_at = now()
      `),
  );
}

export type EmployeeRow = {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  phone: string | null;
  active: boolean;
};

export async function listEmployees(ctx: Ctx, archetype: RoleArchetype): Promise<EmployeeRow[]> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select e.id::text as id, e.name, e.team_id::text as team_id, t.name as team_name,
             e.user_id::text as user_id, e.phone, e.active
      from public.employee e
      left join public.team t on t.id = e.team_id
      where e.org_id = ${ctx.orgId}
      order by e.active desc, e.name
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    team_id: string | null;
    team_name: string | null;
    user_id: string | null;
    phone: string | null;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    teamId: r.team_id,
    teamName: r.team_name,
    userId: r.user_id,
    phone: r.phone,
    active: r.active,
  }));
}

// ── teams (ride employees.manage — doc 06 has no separate team row) ─────────
export const TeamInput = z.object({
  name: name(80),
  kind: z.enum(["trade", "line"]).default("trade"),
  sort: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

export async function createTeam(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "employees.manage");
  const data = TeamInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "team.create",
        entityType: "team",
        entityId: id,
        summary: `Added team ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.team (id, org_id, name, kind, sort, active)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.kind}, ${data.sort}, ${data.active})
      `),
  );
  return { id };
}

export async function listTeams(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; name: string; kind: string; active: boolean }>> {
  assertCan(archetype, "employees.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, kind, active from public.team
      where org_id = ${ctx.orgId} order by sort, name
    `),
  )) as unknown as Array<{ id: string; name: string; kind: string; active: boolean }>;
  return rows;
}

// ── customers ────────────────────────────────────────────────────────────────
export const CustomerInput = z.object({
  name: name(160),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  contactName: opt(120),
  phone: opt(32),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  taxRegNo: opt(64),
  notes: opt(2000),
  active: z.boolean().default(true),
});

export async function createCustomer(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "customers.manage");
  const data = CustomerInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "customer.create",
        entityType: "customer",
        entityId: id,
        summary: `Added customer ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.customer
          (id, org_id, name, country, contact_name, phone, email, tax_reg_no, notes, active)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.country ?? null},
                ${data.contactName ?? null}, ${data.phone ?? null}, ${data.email ?? null},
                ${data.taxRegNo ?? null}, ${data.notes ?? null}, ${data.active})
      `),
  );
  return { id };
}

export async function updateCustomer(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "customers.manage");
  const data = CustomerInput.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "customer.update",
        entityType: "customer",
        entityId: id,
        summary: `Updated customer ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.customer
        set name = ${data.name}, country = ${data.country ?? null},
            contact_name = ${data.contactName ?? null}, phone = ${data.phone ?? null},
            email = ${data.email ?? null}, tax_reg_no = ${data.taxRegNo ?? null},
            notes = ${data.notes ?? null}, active = ${data.active}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id}
      `),
  );
}

export async function listCustomers(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; name: string; country: string | null; active: boolean }>> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, country, active from public.customer
      where org_id = ${ctx.orgId} order by active desc, name
    `),
  )) as unknown as Array<{ id: string; name: string; country: string | null; active: boolean }>;
  return rows;
}

// ── suppliers ────────────────────────────────────────────────────────────────
export const SupplierInput = z.object({
  name: name(160),
  taxRegNo: opt(64),
  termsText: opt(500),
  phone: opt(32),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  active: z.boolean().default(true),
});

export async function createSupplier(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "catalog.manage");
  const data = SupplierInput.parse(input);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "supplier.create",
        entityType: "supplier",
        entityId: id,
        summary: `Added supplier ${data.name}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.supplier (id, org_id, name, tax_reg_no, terms_text, phone, email, active)
        values (${id}, ${ctx.orgId}, ${data.name}, ${data.taxRegNo ?? null},
                ${data.termsText ?? null}, ${data.phone ?? null}, ${data.email ?? null}, ${data.active})
      `),
  );
  return { id };
}

export async function listSuppliers(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ id: string; name: string; active: boolean }>> {
  assertCan(archetype, "catalog.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, active from public.supplier
      where org_id = ${ctx.orgId} order by active desc, name
    `),
  )) as unknown as Array<{ id: string; name: string; active: boolean }>;
  return rows;
}

// ── items (catalog live, stock deferred) ─────────────────────────────────────
export const ItemInput = z.object({
  sku: name(64),
  name: name(160),
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  unit: name(16),
  unitCostMinor: z.number().int().min(0).optional(),
  sellingPriceMinor: z.number().int().min(0).optional(),
  minQty: z.number().min(0).optional(),
  active: z.boolean().default(true),
});

async function assertItemCategory(ctx: Ctx, categoryKey: string): Promise<void> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.categories.item'
    `),
  )) as unknown as Array<{ value: { categories: Array<{ key: string; retired: boolean }> } }>;
  const categories = rows[0]?.value?.categories ?? [];
  const found = categories.find((c) => c.key === categoryKey);
  if (!found || found.retired) {
    throw new Error(
      `unknown or retired item category "${categoryKey}" — configure categories first`,
    );
  }
}

export async function createItem(
  ctx: Ctx,
  archetype: RoleArchetype,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "catalog.manage");
  // Add-on gate (FR-9): item CREATE only — the catalogue read and item lookups
  // in requests/orders/reports never gate.
  await requireCapability(ctx, "cap.items");
  const data = ItemInput.parse(input);
  await assertItemCategory(ctx, data.categoryKey);
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "item.create",
        entityType: "item",
        entityId: id,
        summary: `Added item ${data.sku}`,
      },
    },
    (tx) =>
      tx.execute(sql`
        insert into public.item
          (id, org_id, sku, name, category_key, unit, unit_cost_minor, selling_price_minor, min_qty, active)
        values (${id}, ${ctx.orgId}, ${data.sku}, ${data.name}, ${data.categoryKey}, ${data.unit},
                ${data.unitCostMinor ?? null}, ${data.sellingPriceMinor ?? null},
                ${data.minQty ?? null}, ${data.active})
      `),
  );
  return { id };
}

export type ItemRow = {
  id: string;
  sku: string;
  name: string;
  categoryKey: string;
  unit: string;
  /** REDACTED to null unless ctx.costPrivileged (F-23 — serializer-side wall). */
  unitCostMinor: number | null;
  /** REDACTED to null unless ctx.pricePrivileged. */
  sellingPriceMinor: number | null;
  active: boolean;
};

export async function listItems(ctx: Ctx, archetype: RoleArchetype): Promise<ItemRow[]> {
  assertCan(archetype, "catalog.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, sku, name, category_key, unit, unit_cost_minor, selling_price_minor, active
      from public.item where org_id = ${ctx.orgId}
      order by active desc, category_key, name
    `),
  )) as unknown as Array<{
    id: string;
    sku: string;
    name: string;
    category_key: string;
    unit: string;
    unit_cost_minor: number | null;
    selling_price_minor: number | null;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    categoryKey: r.category_key,
    unit: r.unit,
    // postgres bigint arrives as string — coerce before serializing (F-23 wall
    // stays: redacted to null for non-privileged ctx).
    unitCostMinor:
      ctx.costPrivileged && r.unit_cost_minor !== null ? Number(r.unit_cost_minor) : null,
    sellingPriceMinor:
      ctx.pricePrivileged && r.selling_price_minor !== null ? Number(r.selling_price_minor) : null,
    active: r.active,
  }));
}

// ── employee detail reads (S1 detail page) ───────────────────────────────────
export async function getEmployee(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<EmployeeRow | null> {
  const rows = await listEmployees(ctx, archetype);
  return rows.find((e) => e.id === id) ?? null;
}

/** Salary terms — the DB RLS wall (cost-priv GUC) decides visibility: a
 * non-cost-privileged ctx gets zero rows here, no app-side branching needed. */
export async function getEmployeeTerms(
  ctx: Ctx,
  employeeId: string,
): Promise<{ salaryMinor: number; hourlyCostMinor: number; otRate: number } | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select salary_minor, hourly_cost_minor, ot_rate from public.employee_terms
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
    `),
  )) as unknown as Array<{ salary_minor: number; hourly_cost_minor: number; ot_rate: number }>;
  const r = rows[0];
  return r
    ? {
        salaryMinor: Number(r.salary_minor),
        hourlyCostMinor: Number(r.hourly_cost_minor),
        otRate: Number(r.ot_rate),
      }
    : null;
}

/** HR record — owner/admin RLS wall at the DB (0020). */
export async function getEmployeeHr(
  ctx: Ctx,
  employeeId: string,
): Promise<{
  idNumber: string | null;
  idExpiry: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  visaExpiry: string | null;
  notes: string | null;
} | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id_number, id_expiry::text as id_expiry, passport_number,
             passport_expiry::text as passport_expiry, visa_expiry::text as visa_expiry, notes
      from public.employee_hr
      where org_id = ${ctx.orgId} and employee_id = ${employeeId}
    `),
  )) as unknown as Array<{
    id_number: string | null;
    id_expiry: string | null;
    passport_number: string | null;
    passport_expiry: string | null;
    visa_expiry: string | null;
    notes: string | null;
  }>;
  const r = rows[0];
  return r
    ? {
        idNumber: r.id_number,
        idExpiry: r.id_expiry,
        passportNumber: r.passport_number,
        passportExpiry: r.passport_expiry,
        visaExpiry: r.visa_expiry,
        notes: r.notes,
      }
    : null;
}

/** The org's item categories (page-facing read — Bible 3.2 service surface). */
export async function listItemCategories(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ key: string; labels: { en: string; ar: string } }>> {
  assertCan(archetype, "catalog.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.app_settings
      where org_id = ${ctx.orgId} and key = 'config.categories.item'
    `),
  )) as unknown as Array<{
    value: {
      categories: Array<{ key: string; labels: { en: string; ar: string }; retired: boolean }>;
    } | null;
  }>;
  return (rows[0]?.value?.categories ?? []).filter((c) => !c.retired);
}
