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

/**
 * A master record the caller may not touch: absent, or another organization's.
 *
 * One error for both, because RLS plus the org filter make a foreign id
 * indistinguishable from a missing one, and telling them apart would leak
 * whether an id exists somewhere else.
 */
export class MasterNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "MasterNotFoundError";
  }
}

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

export type CustomerListRow = {
  id: string;
  name: string;
  country: string | null;
  contactName: string | null;
  phone: string | null;
  active: boolean;
};

export type CustomerListOptions = {
  /** Server-side search over name/contact/phone/email/TRN. */
  q?: string;
  /** Which lifecycle slice to return. DEFAULT "active" — archived customers
   * never appear in relationship selectors unless explicitly requested. */
  status?: "active" | "archived" | "all";
  limit?: number;
};

export async function listCustomers(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: CustomerListOptions = {},
): Promise<CustomerListRow[]> {
  assertCan(archetype, "customers.view");
  const status = opts.status ?? "active";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const q = (opts.q ?? "").trim();
  // ILIKE with escaped wildcards — the pattern is data, never structure.
  const pattern = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, country, contact_name, phone, active
      from public.customer
      where org_id = ${ctx.orgId}
        and (${status}::text = 'all' or active = (${status}::text = 'active'))
        and (${pattern}::text is null
             or name ilike ${pattern}
             or coalesce(contact_name, '') ilike ${pattern}
             or coalesce(phone, '') ilike ${pattern}
             or coalesce(email, '') ilike ${pattern}
             or coalesce(tax_reg_no, '') ilike ${pattern})
      order by active desc, name
      limit ${limit}
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    country: string | null;
    contact_name: string | null;
    phone: string | null;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    contactName: r.contact_name,
    phone: r.phone,
    active: r.active,
  }));
}

export type CustomerDetail = {
  id: string;
  name: string;
  country: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  taxRegNo: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Single-customer read. Returns null for a missing OR foreign id (RLS +
 * explicit org filter) — callers render not-found, never a distinction. */
export async function getCustomer(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<CustomerDetail | null> {
  assertCan(archetype, "customers.view");
  if (!z.string().uuid().safeParse(id).success) return null;
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, country, contact_name, phone, email, tax_reg_no,
             notes, active, created_at::text as created_at, updated_at::text as updated_at
      from public.customer where org_id = ${ctx.orgId} and id = ${id}
    `),
  )) as unknown as Array<Record<string, string | boolean | null>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    name: r.name as string,
    country: (r.country as string) ?? null,
    contactName: (r.contact_name as string) ?? null,
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    taxRegNo: (r.tax_reg_no as string) ?? null,
    notes: (r.notes as string) ?? null,
    active: r.active as boolean,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * Explicit lifecycle command — archive (active=false) / reactivate
 * (active=true). Deliberately separate from updateCustomer: archiving is a
 * lifecycle decision with its own audit trail, not a form edit. Idempotent —
 * a double submission finds zero rows to change and reports {changed:false}.
 * There is no delete: history referencing the customer is never touched
 * (documents snapshot the name; rows keep the FK).
 */
export async function setCustomerActive(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  active: boolean,
): Promise<{ changed: boolean }> {
  assertCan(archetype, "customers.manage");
  if (!z.string().uuid().safeParse(id).success) {
    throw new Error("invalid customer id");
  }
  // Idempotence without audit noise: a repeat submission (already in the
  // target state) returns quietly; only a real transition writes audit.
  const current = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select active from public.customer where org_id = ${ctx.orgId} and id = ${id}`),
  )) as unknown as Array<{ active: boolean }>;
  if (!current[0]) throw new Error("customer not found");
  if (current[0].active === active) return { changed: false };
  return command(
    ctx,
    {
      audit: (r: { changed: boolean; name: string | null }) => ({
        action: active ? "customer.reactivate" : "customer.archive",
        entityType: "customer",
        entityId: id,
        summary: r.name
          ? `${active ? "Reactivated" : "Archived"} customer ${r.name}`
          : `${active ? "Reactivate" : "Archive"} customer (no change)`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.customer set active = ${active}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${id} and active <> ${active}
        returning name
      `)) as unknown as Array<{ name: string }>;
      return { changed: rows.length > 0, name: rows[0]?.name ?? null };
    },
  ).then((r) => ({ changed: r.changed }));
}

// ── customer contacts (H19 — the minimal normalized model, 0077) ─────────────
// The legacy embedded contact (customer.contact_name/phone/email) is
// PRESERVED: presentPrimaryContact() below adapts it as a virtual primary
// whenever a customer has no normalized rows, so nothing is migrated and
// imported records are never rewritten.

export const ContactInput = z.object({
  name: name(120),
  roleTitle: opt(80),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: opt(32),
  preferredMethod: z.enum(["phone", "email"]).default("phone"),
  isPrimary: z.boolean().default(false),
});

export type CustomerContactRow = {
  id: string;
  name: string;
  roleTitle: string | null;
  email: string | null;
  phone: string | null;
  preferredMethod: "phone" | "email";
  isPrimary: boolean;
  active: boolean;
  /** True only for the legacy embedded-contact adapter row (not editable). */
  legacy?: boolean;
};

export async function listCustomerContacts(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
): Promise<CustomerContactRow[]> {
  assertCan(archetype, "customers.view");
  if (!z.string().uuid().safeParse(customerId).success) return [];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, role_title, email, phone, preferred_method,
             is_primary, active
      from public.customer_contact
      where org_id = ${ctx.orgId} and customer_id = ${customerId} and active = true
      order by is_primary desc, name
    `),
  )) as unknown as Array<Record<string, string | boolean | null>>;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    roleTitle: (r.role_title as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    preferredMethod: r.preferred_method as "phone" | "email",
    isPrimary: r.is_primary as boolean,
    active: r.active as boolean,
  }));
}

export async function addCustomerContact(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
  input: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "customers.manage");
  const data = ContactInput.parse(input);
  if (!z.string().uuid().safeParse(customerId).success) {
    throw new Error("invalid customer id");
  }
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "customer.contact_add",
        entityType: "customer",
        entityId: customerId,
        summary: `Added contact ${data.name}`,
      },
    },
    async (tx) => {
      // The org filter re-asserts tenancy even before RLS; a foreign
      // customer id inserts nothing and the FK/exists check throws.
      const exists = (await tx.execute(sql`
        select 1 from public.customer where org_id = ${ctx.orgId} and id = ${customerId}
      `)) as unknown as Array<unknown>;
      if (exists.length === 0) throw new Error("customer not found");
      if (data.isPrimary) {
        await tx.execute(sql`
          update public.customer_contact set is_primary = false, updated_at = now()
          where org_id = ${ctx.orgId} and customer_id = ${customerId} and is_primary = true
        `);
      }
      await tx.execute(sql`
        insert into public.customer_contact
          (id, org_id, customer_id, name, role_title, email, phone, preferred_method, is_primary)
        values (${id}, ${ctx.orgId}, ${customerId}, ${data.name}, ${data.roleTitle ?? null},
                ${data.email ?? null}, ${data.phone ?? null}, ${data.preferredMethod},
                ${data.isPrimary})
      `);
    },
  );
  return { id };
}

export async function deactivateCustomerContact(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId: string,
  contactId: string,
): Promise<void> {
  assertCan(archetype, "customers.manage");
  if (
    !z.string().uuid().safeParse(customerId).success ||
    !z.string().uuid().safeParse(contactId).success
  ) {
    throw new Error("invalid id");
  }
  await command(
    ctx,
    {
      audit: {
        action: "customer.contact_remove",
        entityType: "customer",
        entityId: customerId,
        summary: "Removed a contact",
      },
    },
    (tx) =>
      tx.execute(sql`
        update public.customer_contact
        set active = false, is_primary = false, updated_at = now()
        where org_id = ${ctx.orgId} and customer_id = ${customerId} and id = ${contactId}
      `),
  );
}

/** The compatibility adapter (H19 Part I): the customer's primary contact for
 * presentation — the first normalized primary (or first active row), else the
 * legacy embedded contact as a read-only virtual row, else null. */
export function presentPrimaryContact(
  customer: Pick<CustomerDetail, "contactName" | "phone" | "email">,
  contacts: CustomerContactRow[],
): CustomerContactRow | null {
  const primary = contacts.find((c) => c.isPrimary) ?? contacts[0] ?? null;
  if (primary) return primary;
  if (customer.contactName || customer.phone || customer.email) {
    return {
      id: "legacy",
      name: customer.contactName ?? "",
      roleTitle: null,
      email: customer.email,
      phone: customer.phone,
      preferredMethod: "phone",
      isPrimary: true,
      active: true,
      legacy: true,
    };
  }
  return null;
}

// ── duplicate safety (H19 Part K) ────────────────────────────────────────────
export type DuplicateCandidate = {
  id: string;
  name: string;
  active: boolean;
  matchedOn: "email" | "phone" | "name";
};

/** Normalize ONLY for comparison — stored values are never rewritten. */
export function normalizeEmailForMatch(email: string | null | undefined): string | null {
  const v = (email ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** Calling codes for the countries this product ships country packs for,
 * used to localize an explicit country hint. Numbers outside this map still
 * compare safely through the generic E.164 rules below. */
const CALLING_CODES: Record<string, string> = {
  AE: "971",
  SA: "966",
  KW: "965",
  BH: "973",
  OM: "968",
  QA: "974",
};

export type NormalizedPhone =
  | { kind: "e164"; value: string } // full international digits, no plus
  | { kind: "national"; value: string }; // local digits with the trunk 0 removed

/** H20 Part B — the international phone comparison contract. An explicit
 * international prefix (+ or 00) yields an E.164 comparison value; a local
 * number yields its national digits (trunk 0 stripped), upgraded to E.164
 * when a country hint provides the calling code. Malformed and too-short
 * values normalize to null (never compared). */
export function normalizePhoneForMatch(
  phone: string | null | undefined,
  countryHint?: string | null,
): NormalizedPhone | null {
  const raw = (phone ?? "").trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith("+") || raw.startsWith("00");
  const digitsAll = raw.replace(/[^0-9]/g, "");
  const digits = raw.startsWith("00") ? digitsAll.slice(2) : digitsAll;
  if (hasPlus) {
    // E.164 is 8..15 digits including the calling code.
    return digits.length >= 8 && digits.length <= 15 ? { kind: "e164", value: digits } : null;
  }
  const national = digits.replace(/^0/, "");
  if (national.length < 7) return null;
  const cc = countryHint ? CALLING_CODES[countryHint.toUpperCase()] : undefined;
  if (cc) return { kind: "e164", value: cc + national };
  return { kind: "national", value: national };
}

/** Two normalized phones refer to the same line only when:
 *  - both are E.164 and exactly equal, or
 *  - both are national and exactly equal (full digits, never a suffix), or
 *  - one is E.164 and the other national, and the E.164 value is exactly a
 *    1..4 digit calling code followed by the ENTIRE national number.
 * Unrelated international numbers that merely share a suffix never match. */
export function phonesMatch(a: NormalizedPhone | null, b: NormalizedPhone | null): boolean {
  if (!a || !b) return false;
  if (a.kind === b.kind) return a.value === b.value;
  const e = a.kind === "e164" ? a : b;
  const n = a.kind === "national" ? a : b;
  if (!e.value.endsWith(n.value)) return false;
  const ccLen = e.value.length - n.value.length;
  return ccLen >= 1 && ccLen <= 4;
}

/** Conservative possible-duplicate lookup inside the acting organization
 * (same-org names are already visible to customers.manage holders — nothing
 * inaccessible is revealed). Advisory only: never blocks, never merges.
 * Email and name match in SQL; phone comparison runs the E.164 contract in
 * app code over a bounded org-scoped candidate set. */
export async function findPossibleDuplicates(
  ctx: Ctx,
  archetype: RoleArchetype,
  probe: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    country?: string | null;
  },
): Promise<DuplicateCandidate[]> {
  assertCan(archetype, "customers.manage");
  const email = normalizeEmailForMatch(probe.email);
  const phone = normalizePhoneForMatch(probe.phone, probe.country);
  const nm = (probe.name ?? "").trim().toLowerCase();
  if (!email && !phone && nm.length < 3) return [];
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, active, email, phone, country
      from public.customer
      where org_id = ${ctx.orgId}
        and ((${email}::text is not null and lower(trim(coalesce(email,''))) = ${email})
          or (${phone !== null} and phone is not null)
          or (${nm}::text <> '' and lower(name) = ${nm}))
      limit 500
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    active: boolean;
    email: string | null;
    phone: string | null;
    country: string | null;
  }>;
  const out: DuplicateCandidate[] = [];
  for (const r of rows) {
    if (email && normalizeEmailForMatch(r.email) === email) {
      out.push({ id: r.id, name: r.name, active: r.active, matchedOn: "email" });
    } else if (
      phone &&
      phonesMatch(phone, normalizePhoneForMatch(r.phone, r.country ?? probe.country))
    ) {
      out.push({ id: r.id, name: r.name, active: r.active, matchedOn: "phone" });
    } else if (nm.length >= 3 && r.name.trim().toLowerCase() === nm) {
      out.push({ id: r.id, name: r.name, active: r.active, matchedOn: "name" });
    }
    if (out.length >= 5) break;
  }
  return out;
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

export const SupplierPatch = SupplierInput.partial();

/**
 * Edit a supplier.
 *
 * Suppliers had no update path at all: they could be created and listed and
 * nothing else, so a changed phone number meant a duplicate record. Every field
 * is optional and an omitted field is left alone, so a partial form post cannot
 * blank data it never showed.
 */
export async function updateSupplier(
  ctx: Ctx,
  archetype: RoleArchetype,
  supplierId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "catalog.manage");
  const data = SupplierPatch.parse(input);
  await command(
    ctx,
    {
      audit: {
        action: "supplier.update",
        entityType: "supplier",
        entityId: supplierId,
        summary: `Updated supplier`,
        after: data as Record<string, unknown>,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.supplier set
          name = ${data.name === undefined ? sql`name` : data.name},
          tax_reg_no = ${data.taxRegNo === undefined ? sql`tax_reg_no` : (data.taxRegNo ?? null)},
          terms_text = ${data.termsText === undefined ? sql`terms_text` : (data.termsText ?? null)},
          phone = ${data.phone === undefined ? sql`phone` : (data.phone ?? null)},
          email = ${data.email === undefined ? sql`email` : (data.email ?? null)},
          active = ${data.active === undefined ? sql`active` : data.active},
          updated_at = now()
        where id = ${supplierId} and org_id = ${ctx.orgId}
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new MasterNotFoundError("supplier");
    },
  );
}

export type SupplierRow = {
  id: string;
  name: string;
  taxRegNo: string | null;
  termsText: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
};

/**
 * A page of suppliers.
 *
 * This was a bare unbounded select. Supplier lists grow for the life of the
 * tenant, so it returns a page and says whether more exist rather than
 * truncating in silence.
 */
export async function listSuppliers(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: { limit?: number; offset?: number; search?: string; includeInactive?: boolean } = {},
): Promise<{ rows: SupplierRow[]; hasMore: boolean }> {
  assertCan(archetype, "catalog.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = (opts.search ?? "").trim();
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, tax_reg_no, terms_text, phone, email, active
      from public.supplier
      where org_id = ${ctx.orgId}
        and (${opts.includeInactive === true} or active)
        and (${search === ""} or name ilike ${"%" + search + "%"})
      order by active desc, name
      limit ${limit + 1} offset ${offset}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return {
    rows: rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      taxRegNo: (r.tax_reg_no as string | null) ?? null,
      termsText: (r.terms_text as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      active: r.active as boolean,
    })),
    hasMore: rows.length > limit,
  };
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
  /** Reorder threshold. Written since 0020 and read for the first time in H22. */
  minQty: number | null;
  active: boolean;
};

export const ItemPatch = ItemInput.partial();

/**
 * Edit an item.
 *
 * Items had no update path: a corrected name or price meant a second SKU. The
 * category is re-validated when it changes, so an edit cannot move an item into
 * a retired or unknown category that creation would have refused.
 *
 * `min_qty` is included because it becomes load-bearing in H22: it is the
 * reorder threshold, and until now it was written and never read.
 */
export async function updateItem(
  ctx: Ctx,
  archetype: RoleArchetype,
  itemId: string,
  input: unknown,
): Promise<void> {
  assertCan(archetype, "catalog.manage");
  const data = ItemPatch.parse(input);
  if (data.categoryKey !== undefined) await assertItemCategory(ctx, data.categoryKey);
  await command(
    ctx,
    {
      audit: {
        action: "item.update",
        entityType: "item",
        entityId: itemId,
        summary: "Updated item",
        after: data as Record<string, unknown>,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.item set
          sku = ${data.sku === undefined ? sql`sku` : data.sku},
          name = ${data.name === undefined ? sql`name` : data.name},
          category_key = ${data.categoryKey === undefined ? sql`category_key` : data.categoryKey},
          unit = ${data.unit === undefined ? sql`unit` : data.unit},
          unit_cost_minor = ${data.unitCostMinor === undefined ? sql`unit_cost_minor` : (data.unitCostMinor ?? null)},
          selling_price_minor = ${data.sellingPriceMinor === undefined ? sql`selling_price_minor` : (data.sellingPriceMinor ?? null)},
          min_qty = ${data.minQty === undefined ? sql`min_qty` : (data.minQty ?? null)},
          active = ${data.active === undefined ? sql`active` : data.active},
          updated_at = now()
        where id = ${itemId} and org_id = ${ctx.orgId}
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new MasterNotFoundError("item");
    },
  );
}

/**
 * A page of items.
 *
 * This was a bare unbounded select feeding the items screen. The catalogue grows
 * for the life of the tenant, and H22's inventory screens read it constantly, so
 * it pages and reports whether more exist.
 */
export async function listItems(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: {
    limit?: number;
    offset?: number;
    search?: string;
    categoryKey?: string;
    includeInactive?: boolean;
  } = {},
): Promise<{ rows: ItemRow[]; hasMore: boolean }> {
  assertCan(archetype, "catalog.view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = (opts.search ?? "").trim();
  const category = (opts.categoryKey ?? "").trim();
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, sku, name, category_key, unit, unit_cost_minor,
             selling_price_minor, min_qty, active
      from public.item
      where org_id = ${ctx.orgId}
        and (${opts.includeInactive === true} or active)
        and (${category === ""} or category_key = ${category})
        and (${search === ""} or name ilike ${"%" + search + "%"} or sku ilike ${"%" + search + "%"})
      order by active desc, category_key, name
      limit ${limit + 1} offset ${offset}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return {
    rows: rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      sku: r.sku as string,
      name: r.name as string,
      categoryKey: r.category_key as string,
      unit: r.unit as string,
      // postgres bigint arrives as string — coerce before serializing (F-23 wall
      // stays: redacted to null for non-privileged ctx).
      unitCostMinor:
        ctx.costPrivileged && r.unit_cost_minor !== null ? Number(r.unit_cost_minor) : null,
      sellingPriceMinor:
        ctx.pricePrivileged && r.selling_price_minor !== null
          ? Number(r.selling_price_minor)
          : null,
      minQty: r.min_qty === null ? null : Number(r.min_qty),
      active: r.active as boolean,
    })),
    hasMore: rows.length > limit,
  };
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
