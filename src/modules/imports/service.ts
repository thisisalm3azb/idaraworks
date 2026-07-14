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
import type { RoleArchetype } from "@/platform/registries";
import {
  createCustomer,
  createEmployee,
  createItem,
  CustomerInput,
  EmployeeInput,
  ItemInput,
} from "@/modules/masters/service";

export const IMPORT_KINDS = ["customers", "employees", "items"] as const;
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

const NUMERIC_FIELDS = new Set(["unitCostMinor", "sellingPriceMinor", "minQty"]);

/** Map a raw CSV row (header→cell) to a typed masters payload (field→value). */
function mapRow(kind: ImportKind, raw: Record<string, unknown>): Record<string, unknown> {
  const aliases = HEADER_ALIASES[kind];
  const out: Record<string, unknown> = {};
  for (const [header, cell] of Object.entries(raw)) {
    const field = aliases[header.trim().toLowerCase()];
    if (!field) continue;
    const s = typeof cell === "string" ? cell.trim() : cell;
    if (s === "" || s === null || s === undefined) continue;
    if (NUMERIC_FIELDS.has(field)) {
      const n = Number(s);
      if (Number.isFinite(n)) out[field] = n;
      else out[field] = s; // let the schema reject it with a clear message
    } else {
      out[field] = s;
    }
  }
  return out;
}

function schemaFor(kind: ImportKind): z.ZodTypeAny {
  return kind === "customers" ? CustomerInput : kind === "employees" ? EmployeeInput : ItemInput;
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
      const created =
        kind === "customers"
          ? await createCustomer(ctx, archetype, row.mapped)
          : kind === "employees"
            ? await createEmployee(ctx, archetype, row.mapped)
            : await createItem(ctx, archetype, row.mapped);
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
