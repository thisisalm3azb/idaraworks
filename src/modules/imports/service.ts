/**
 * S8 guided CSV imports (doc 11 S8): customers / employees / items. A batch STAGES parsed
 * rows, VALIDATES each against the same masters Zod schema the manual form uses, then APPLIES
 * the valid rows through the governed masters services (createCustomer/Employee/Item) — so
 * every imported record gets the identical validation, audit, and RLS as a hand-typed one.
 * Re-runnable: apply only touches valid+pending rows. Cost-only staging; nothing external.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan, type Action } from "@/platform/authz";
import { requireCapability } from "@/platform/entitlements";
import type { RoleArchetype } from "@/platform/registries";
import {
  addCustomerContact,
  ContactInput,
  createCustomer,
  createEmployee,
  createItem,
  CustomerInput,
  EmployeeInput,
  findPossibleDuplicates,
  ItemInput,
} from "@/modules/masters/service";
import {
  CaptureLeadInput,
  captureLead,
  createOpportunity,
  findLeadDuplicates,
  OpportunityInput,
} from "@/modules/crm/service";

export const IMPORT_KINDS = [
  "customers",
  "employees",
  "items",
  // H27 — CRM records. Documented columns only (docs/H27-TRUTH-MAP.md Part G);
  // no third-party format is claimed.
  "contacts",
  "leads",
  "opportunities",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export class ImportError extends Error {}

// Header aliases (lowercased) → canonical field. Keeps imports forgiving of real CSVs.
const HEADER_ALIASES: Record<ImportKind, Record<string, string>> = {
  customers: {
    name: "name",
    "customer name": "name",
    country: "country",
    "contact name": "contactName",
    contact: "contactName",
    phone: "phone",
    email: "email",
    "tax reg no": "taxRegNo",
    trn: "taxRegNo",
    notes: "notes",
  },
  employees: { name: "name", "employee name": "name", phone: "phone" },
  contacts: {
    customer: "customerName",
    "customer name": "customerName",
    company: "customerName",
    name: "name",
    "contact name": "name",
    title: "roleTitle",
    role: "roleTitle",
    "role title": "roleTitle",
    email: "email",
    phone: "phone",
    "preferred method": "preferredMethod",
    primary: "isPrimary",
    "is primary": "isPrimary",
  },
  leads: {
    name: "name",
    "lead name": "name",
    company: "name",
    "contact name": "contactName",
    contact: "contactName",
    email: "email",
    phone: "phone",
    country: "country",
    source: "source",
    notes: "notes",
    value: "estimatedValueMinor",
    "estimated value": "estimatedValueMinor",
    "estimated value minor": "estimatedValueMinor",
    currency: "currency",
    timeframe: "timeframe",
    interest: "interest",
  },
  opportunities: {
    name: "name",
    opportunity: "name",
    "opportunity name": "name",
    customer: "customerName",
    "customer name": "customerName",
    company: "customerName",
    stage: "stageKey",
    "stage key": "stageKey",
    value: "estimatedValueMinor",
    "estimated value": "estimatedValueMinor",
    "estimated value minor": "estimatedValueMinor",
    "close date": "expectedCloseDate",
    "expected close date": "expectedCloseDate",
    probability: "probability",
    "next action": "nextAction",
    "next action due": "nextActionDue",
  },
  items: {
    sku: "sku",
    name: "name",
    "item name": "name",
    category: "categoryKey",
    "category key": "categoryKey",
    unit: "unit",
    uom: "unit",
    "unit cost": "unitCostMinor",
    "unit cost minor": "unitCostMinor",
    "selling price": "sellingPriceMinor",
    "min qty": "minQty",
  },
};

const NUMERIC_FIELDS = new Set([
  "unitCostMinor",
  "sellingPriceMinor",
  "minQty",
  "estimatedValueMinor",
  "probability",
]);
const BOOLEAN_FIELDS = new Set(["isPrimary"]);
const TRUE_WORDS = new Set(["true", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

/** Map a raw CSV row (header→cell) to a typed masters payload (field→value). */
function mapRow(kind: ImportKind, raw: Record<string, unknown>): Record<string, unknown> {
  const aliases = HEADER_ALIASES[kind];
  const out: Record<string, unknown> = {};
  for (const [header, cell] of Object.entries(raw)) {
    const field = aliases[header.trim().toLowerCase()];
    if (!field) continue;
    const s = typeof cell === "string" ? cell.trim() : cell;
    if (s === "" || s === null || s === undefined) continue;
    if (BOOLEAN_FIELDS.has(field)) {
      const w = String(s).trim().toLowerCase();
      out[field] = TRUE_WORDS.has(w) ? true : FALSE_WORDS.has(w) ? false : s;
    } else if (NUMERIC_FIELDS.has(field)) {
      const n = Number(s);
      if (Number.isFinite(n)) out[field] = n;
      else out[field] = s; // let the schema reject it with a clear message
    } else {
      out[field] = s;
    }
  }
  return out;
}

const ContactImport = ContactInput.extend({ customerName: z.string().trim().min(1).max(160) });
const LeadImport = CaptureLeadInput.omit({
  sourceKind: true,
  ownerUserId: true,
  campaignId: true,
  referrerCustomerId: true,
  territoryId: true,
  consent: true,
});
const OpportunityImport = OpportunityInput.omit({ customerId: true, ownerUserId: true }).extend({
  customerName: z.string().trim().max(160).optional(),
});

function schemaFor(kind: ImportKind): z.ZodTypeAny {
  switch (kind) {
    case "customers":
      return CustomerInput;
    case "employees":
      return EmployeeInput;
    case "items":
      return ItemInput;
    case "contacts":
      return ContactImport;
    case "leads":
      return LeadImport;
    case "opportunities":
      return OpportunityImport;
  }
}

/** Resolve a customer by exact (case-insensitive) name inside the org; merged records resolve to their survivor. */
async function customerIdByName(ctx: Ctx, name: string): Promise<string | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select coalesce(merged_into_customer_id, id)::text as id from public.customer
      where org_id = ${ctx.orgId} and lower(name) = lower(${name.trim()})
      order by (merged_into_customer_id is null) desc, created_at limit 1`),
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

async function orgBaseCurrency(ctx: Ctx): Promise<string> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select base_currency from public.org where id = ${ctx.orgId}`),
  )) as unknown as Array<{ base_currency: string }>;
  return rows[0]?.base_currency ?? "AED";
}

/** Create one record through the governed service that owns it. */
async function createForKind(
  ctx: Ctx,
  archetype: RoleArchetype,
  kind: ImportKind,
  mapped: Record<string, unknown>,
): Promise<{ id: string }> {
  switch (kind) {
    case "customers":
      return createCustomer(ctx, archetype, mapped);
    case "employees":
      return createEmployee(ctx, archetype, mapped);
    case "items":
      return createItem(ctx, archetype, mapped);
    case "contacts": {
      const { customerName, ...rest } = ContactImport.parse(mapped);
      const customerId = await customerIdByName(ctx, customerName);
      if (!customerId) throw new ImportError(`customer not found: ${customerName}`);
      return addCustomerContact(ctx, archetype, customerId, rest);
    }
    case "leads": {
      const data = LeadImport.parse(mapped);
      // A value without a currency takes the organisation's base currency (the
      // same default the capture form applies); nothing is converted.
      const currency =
        data.currency ??
        (data.estimatedValueMinor !== null && data.estimatedValueMinor !== undefined
          ? await orgBaseCurrency(ctx)
          : undefined);
      const r = await captureLead(ctx, archetype, {
        ...data,
        ...(currency ? { currency } : {}),
        sourceKind: "import",
      });
      return { id: r.lead.id };
    }
    case "opportunities": {
      const { customerName, ...rest } = OpportunityImport.parse(mapped);
      let customerId: string | undefined;
      if (customerName) {
        const found = await customerIdByName(ctx, customerName);
        if (!found) throw new ImportError(`customer not found: ${customerName}`);
        customerId = found;
      }
      return createOpportunity(ctx, archetype, { ...rest, ...(customerId ? { customerId } : {}) });
    }
  }
}

export type ImportDuplicate = {
  rowNumber: number;
  /** Where the possible duplicate lives: an existing record, or another row of the same batch. */
  kind: "existing" | "in_batch";
  matchedOn: "email" | "phone" | "name";
  id: string | null;
  name: string;
  rowNumber2?: number;
};

export type ImportPreview = {
  batchId: string;
  kind: ImportKind;
  total: number;
  valid: number;
  invalid: number;
  /** Valid rows whose referenced customer does not exist (contacts / opportunities). */
  unresolved: Array<{ rowNumber: number; reason: string }>;
  duplicates: ImportDuplicate[];
  /** What an apply would do right now. Nothing is written by a preview. */
  wouldCreate: number;
};

/**
 * Dry run: what applying the batch would create, which rows cannot resolve
 * their customer, and which rows look like duplicates of existing records or
 * of each other. Read-only — the person decides which rows to skip.
 */
export async function previewImport(
  ctx: Ctx,
  archetype: RoleArchetype,
  batchId: string,
): Promise<ImportPreview> {
  assertCan(archetype, "imports.manage" as Action);
  const kind = await withCtx(ctx, (tx) => batchKind(tx, ctx, batchId));
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select row_number, status, mapped from public.import_row
      where org_id = ${ctx.orgId} and batch_id = ${batchId}
      order by row_number`),
  )) as unknown as Array<{
    row_number: number;
    status: string;
    mapped: Record<string, unknown> | null;
  }>;
  const valid = rows.filter((r) => r.status === "valid" && r.mapped);
  const unresolved: ImportPreview["unresolved"] = [];
  const duplicates: ImportDuplicate[] = [];
  const seen = new Map<string, number>(); // in-batch key → first row number
  const nameCache = new Map<string, string | null>();
  const resolve = async (name: string) => {
    const k = name.trim().toLowerCase();
    if (!nameCache.has(k)) nameCache.set(k, await customerIdByName(ctx, name));
    return nameCache.get(k) ?? null;
  };
  for (const r of valid) {
    const m = r.mapped!;
    const email = typeof m.email === "string" ? m.email.trim().toLowerCase() : "";
    const phone = typeof m.phone === "string" ? m.phone.replace(/[^0-9+]/g, "") : "";
    const nm = typeof m.name === "string" ? m.name.trim().toLowerCase() : "";
    const customerName = typeof m.customerName === "string" ? m.customerName : "";
    // In-batch duplicates (same email / phone / name within the upload).
    const keys: Array<["email" | "phone" | "name", string]> = [];
    if (email) keys.push(["email", `email:${email}`]);
    if (phone) keys.push(["phone", `phone:${phone}`]);
    if (nm) {
      const scope =
        kind === "contacts" || kind === "opportunities" ? customerName.toLowerCase() + "/" : "";
      keys.push(["name", `name:${scope}${nm}`]);
    }
    for (const [matchedOn, key] of keys) {
      const first = seen.get(key);
      if (first !== undefined && first !== r.row_number) {
        duplicates.push({
          rowNumber: r.row_number,
          kind: "in_batch",
          matchedOn,
          id: null,
          name: String(m.name ?? ""),
          rowNumber2: first,
        });
        break;
      }
      if (first === undefined) seen.set(key, r.row_number);
    }
    // Against existing records.
    if (kind === "customers") {
      const cands = await findPossibleDuplicates(ctx, archetype, {
        name: nm || null,
        email: email || null,
        phone: phone || null,
        country: typeof m.country === "string" ? m.country : null,
      });
      for (const c of cands.slice(0, 3))
        duplicates.push({
          rowNumber: r.row_number,
          kind: "existing",
          matchedOn: c.matchedOn,
          id: c.id,
          name: c.name,
        });
    } else if (kind === "leads") {
      const cands = await findLeadDuplicates(ctx, archetype, {
        name: nm || null,
        email: email || null,
        phone: phone || null,
        country: typeof m.country === "string" ? m.country : null,
      });
      for (const c of cands.slice(0, 3))
        duplicates.push({
          rowNumber: r.row_number,
          kind: "existing",
          matchedOn: c.match,
          id: c.id,
          name: `${c.kind}: ${c.name}`,
        });
    } else if (kind === "contacts" || kind === "opportunities") {
      const customerId = customerName ? await resolve(customerName) : null;
      if (customerName && !customerId) {
        unresolved.push({ rowNumber: r.row_number, reason: `customer not found: ${customerName}` });
        continue;
      }
      if (kind === "contacts" && !customerName) {
        unresolved.push({ rowNumber: r.row_number, reason: "customer is required" });
        continue;
      }
      if (customerId) {
        const ex = (await withCtx(ctx, (tx) =>
          kind === "contacts"
            ? tx.execute(sql`
                select id::text as id, name, (lower(coalesce(email, '')) = ${email} and ${email} <> '') as by_email
                from public.customer_contact where org_id = ${ctx.orgId} and customer_id = ${customerId}
                  and (lower(name) = ${nm} or (${email} <> '' and lower(coalesce(email, '')) = ${email})) limit 3`)
            : tx.execute(sql`
                select id::text as id, name, false as by_email from public.opportunity
                where org_id = ${ctx.orgId} and customer_id = ${customerId} and status = 'open' and lower(name) = ${nm} limit 3`),
        )) as unknown as Array<{ id: string; name: string; by_email: boolean }>;
        for (const c of ex)
          duplicates.push({
            rowNumber: r.row_number,
            kind: "existing",
            matchedOn: c.by_email ? "email" : "name",
            id: c.id,
            name: c.name,
          });
      }
    }
  }
  const flagged = new Set([...unresolved.map((u) => u.rowNumber)]);
  return {
    batchId,
    kind,
    total: rows.length,
    valid: valid.length,
    invalid: rows.filter((r) => r.status === "invalid").length,
    unresolved,
    duplicates,
    wouldCreate: valid.filter((r) => !flagged.has(r.row_number)).length,
  };
}

/** Mark valid rows the person chose not to import (e.g. previewed duplicates). Re-runnable; applied rows are untouched. */
export async function skipImportRows(
  ctx: Ctx,
  archetype: RoleArchetype,
  batchId: string,
  rowNumbers: number[],
): Promise<{ skipped: number }> {
  assertCan(archetype, "imports.manage" as Action);
  const nums = z.array(z.number().int().min(1)).max(5000).parse(rowNumbers);
  if (nums.length === 0) return { skipped: 0 };
  return command(
    ctx,
    {
      audit: {
        action: "import.skip_rows",
        entityType: "import_batch",
        entityId: batchId,
        summary: `Skipped ${nums.length} rows before apply`,
      },
    },
    async (tx) => {
      const r = (await tx.execute(sql`
        update public.import_row set status = 'invalid', error = 'skipped by reviewer', updated_at = now()
        where org_id = ${ctx.orgId} and batch_id = ${batchId} and status = 'valid'
          and row_number = any(string_to_array(${nums.join(",")}, ',')::int[])
        returning 1`)) as unknown as unknown[];
      return { skipped: r.length };
    },
  );
}

const StageInput = z.object({
  kind: z.enum(IMPORT_KINDS),
  filename: z.string().max(260).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});

export type StageResult = { batchId: string; total: number; valid: number; invalid: number };

/** Stage + validate a parsed CSV. Each row is mapped, schema-validated, and marked valid/invalid. */
export async function stageImport(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<StageResult> {
  assertCan(archetype, "imports.manage" as Action);
  // Add-on gate (FR-9): STAGING only — applying an already-staged batch and
  // reading batch rows never gate (in-flight imports stay finishable).
  await requireCapability(ctx, "feat.data_import");
  const { kind, filename, rows } = StageInput.parse(raw);
  const schema = schemaFor(kind);

  return command<StageResult>(
    ctx,
    {
      audit: (r) => ({
        action: "import.stage",
        entityType: "import_batch",
        entityId: r.batchId,
        summary: `Staged ${r.total}-row ${kind} import (${r.valid} valid, ${r.invalid} invalid)`,
      }),
    },
    async (tx) => {
      const batchRows = (await tx.execute(sql`
        insert into public.import_batch (org_id, kind, status, source_filename, row_count, error_count, created_by)
        values (${ctx.orgId}, ${kind}, 'validated', ${filename ?? null}, ${rows.length}, 0, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      const batchId = batchRows[0]!.id;

      let valid = 0;
      let invalid = 0;
      for (let i = 0; i < rows.length; i++) {
        const mapped = mapRow(kind, rows[i]!);
        const parsed = schema.safeParse(mapped);
        const status = parsed.success ? "valid" : "invalid";
        const error = parsed.success
          ? null
          : parsed.error.issues
              .slice(0, 4)
              .map((e) => `${e.path.join(".")}: ${e.message}`)
              .join("; ")
              .slice(0, 500);
        if (parsed.success) valid++;
        else invalid++;
        await tx.execute(sql`
          insert into public.import_row (org_id, batch_id, row_number, raw, mapped, status, error)
          values (${ctx.orgId}, ${batchId}, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb,
                  ${JSON.stringify(mapped)}::jsonb, ${status}, ${error})`);
      }
      await tx.execute(sql`
        update public.import_batch set error_count = ${invalid}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${batchId}`);
      return { batchId, total: rows.length, valid, invalid };
    },
  );
}

async function batchKind(tx: TenantTx, ctx: Ctx, batchId: string): Promise<ImportKind> {
  const rows = (await tx.execute(sql`
    select kind from public.import_batch where org_id = ${ctx.orgId} and id = ${batchId}`)) as unknown as Array<{
    kind: ImportKind;
  }>;
  if (!rows[0]) throw new ImportError("import batch not found");
  return rows[0].kind;
}

export type ApplyImportResult = { applied: number; failed: number };

/** Apply the VALID pending rows of a batch through the governed masters services. Re-runnable. */
export async function applyImport(
  ctx: Ctx,
  archetype: RoleArchetype,
  batchId: string,
): Promise<ApplyImportResult> {
  assertCan(archetype, "imports.manage" as Action);
  const kind = await withCtx(ctx, (tx) => batchKind(tx, ctx, batchId));
  // Bounded read: one batch's valid+pending rows (a single upload, ≤5000).
  const pending = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, mapped from public.import_row
      where org_id = ${ctx.orgId} and batch_id = ${batchId} and status = 'valid'
      order by row_number`),
  )) as unknown as Array<{ id: string; mapped: Record<string, unknown> }>;

  let applied = 0;
  let failed = 0;
  for (const row of pending) {
    // Atomic claim (review): flip valid→applied with a guarded UPDATE BEFORE creating, so two
    // concurrent applyImport calls on the same batch can never double-create a masters row —
    // the loser's UPDATE matches 0 rows and skips. On create failure the row is corrected to
    // 'invalid'; the brief applied-without-entity window is not re-claimable.
    const claimed = (await withCtx(ctx, (tx) =>
      tx.execute(sql`
        update public.import_row set status = 'applied', updated_at = now()
        where org_id = ${ctx.orgId} and id = ${row.id} and status = 'valid'
        returning id::text as id`),
    )) as unknown as Array<{ id: string }>;
    if (claimed.length === 0) continue; // another apply already took this row
    try {
      const created = await createForKind(ctx, archetype, kind, row.mapped);
      await withCtx(ctx, (tx) =>
        tx.execute(sql`
          update public.import_row set created_entity_id = ${created.id}, updated_at = now()
          where org_id = ${ctx.orgId} and id = ${row.id}`),
      );
      applied++;
    } catch (err) {
      failed++;
      const msg = (err as Error).message.slice(0, 500);
      await withCtx(ctx, (tx) =>
        tx.execute(sql`
          update public.import_row set status = 'invalid', error = ${msg}, updated_at = now()
          where org_id = ${ctx.orgId} and id = ${row.id}`),
      );
    }
  }
  await command(
    ctx,
    {
      audit: {
        action: "import.apply",
        entityType: "import_batch",
        entityId: batchId,
        summary: `Applied ${applied} ${kind} rows (${failed} failed)`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.import_batch
        set status = ${failed > 0 && applied === 0 ? "failed" : "applied"},
            applied_count = applied_count + ${applied}, error_count = error_count + ${failed}, updated_at = now()
        where org_id = ${ctx.orgId} and id = ${batchId}`);
    },
  );
  return { applied, failed };
}

export type ImportRowView = {
  rowNumber: number;
  status: string;
  error: string | null;
  mapped: Record<string, unknown> | null;
};

export async function listImportRows(
  ctx: Ctx,
  archetype: RoleArchetype,
  batchId: string,
): Promise<ImportRowView[]> {
  assertCan(archetype, "imports.manage" as Action);
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select row_number, status, error, mapped from public.import_row
      where org_id = ${ctx.orgId} and batch_id = ${batchId} order by row_number limit 5000`),
  )) as unknown as Array<Record<string, unknown>>;
  // S10 F-23: staged item rows can carry unit COST (cost-walled) and SELLING price (price-walled).
  // imports.manage is held by a non-cost/-price-privileged manager, so redact those fields from the
  // mapped payload unless the caller holds the matching privilege. Reads are never blocked, only
  // the money fields are nulled.
  const redactMapped = (mapped: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!mapped) return null;
    const out = { ...mapped };
    if (!ctx.costPrivileged)
      for (const k of ["unitCostMinor", "unit_cost_minor", "costMinor"]) delete out[k];
    if (!ctx.pricePrivileged)
      for (const k of ["sellingPriceMinor", "selling_price_minor", "priceMinor"]) delete out[k];
    return out;
  };
  return rows.map((r) => ({
    rowNumber: r.row_number as number,
    status: r.status as string,
    error: (r.error as string | null) ?? null,
    mapped: redactMapped((r.mapped as Record<string, unknown> | null) ?? null),
  }));
}
