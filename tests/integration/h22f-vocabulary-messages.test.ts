/**
 * H22F — every value the database allows can be SAID, in both languages.
 *
 * The stock and asset screens render closed vocabularies straight out of the
 * database: a movement type, an asset status, a disposal method. Each one is a
 * `t("...")` lookup keyed by the raw column value, so a value the catalogue has
 * never heard of renders the loud ⟦key⟧ marker on a real screen.
 *
 * A hand-written list of those values would drift the first time somebody adds
 * a movement type in a migration — and it would drift SILENTLY, because the
 * test would still pass against its own stale copy. So this reads the CHECK
 * constraints out of the live schema and demands a translation for every value
 * Postgres will actually accept. Add a value in SQL, and this fails until both
 * catalogues can say it.
 *
 * Read-only. Touches no data at all — only the catalog tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb } from "@/platform/tenancy";
import { ownerSql } from "./helpers";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";

const owner = ownerSql();

type Catalog = Record<string, string>;
const EN = en as Catalog;
const AR = ar as Catalog;

/**
 * The columns the UI translates, and the key prefix each one uses.
 *
 * If a screen starts rendering a new closed vocabulary, it belongs here — that
 * is the whole contract this file enforces.
 */
const TRANSLATED_COLUMNS: Array<{
  table: string;
  column: string;
  prefix: string;
  /** Values the UI legitimately never renders (a draft nobody can reach). */
  except?: string[];
}> = [
  { table: "stock_movement", column: "movement_type", prefix: "stock.movement." },
  { table: "stock_serial", column: "status", prefix: "stock.serial_status." },
  { table: "asset", column: "status", prefix: "assets.status." },
  { table: "asset", column: "condition", prefix: "assets.condition." },
  { table: "asset", column: "acquisition_source", prefix: "assets.source_kind." },
  { table: "asset_assignment", column: "event", prefix: "assets.event." },
  { table: "asset_maintenance_event", column: "kind", prefix: "assets.maintenance_kind." },
  { table: "asset_inspection", column: "kind", prefix: "assets.inspection_kind." },
  { table: "asset_downtime", column: "reason", prefix: "assets.downtime_reason." },
  { table: "asset_disposal", column: "method", prefix: "assets.disposal_method." },
  { table: "asset_disposal", column: "status", prefix: "assets.disposal_status." },
];

/**
 * Pull the allowed values out of a column's CHECK constraint.
 *
 * Matches the `column in ('a', 'b', …)` form every H22 vocabulary uses. A
 * constraint written some other way returns nothing and fails the "found any"
 * assertion below rather than passing vacuously — a vocabulary test that
 * silently checks zero values is worse than no test.
 */
function valuesFrom(clauses: string[], column: string): string[] {
  const found = new Set<string>();
  for (const clause of clauses) {
    /*
     * Postgres renders the column as `column` or `(column)::text`.
     *
     * The leading boundary is load-bearing, and was missing on the first run:
     * without it `event` matched inside `condition_at_event`, so this file
     * demanded translations for asset CONDITIONS under the assignment-EVENT
     * prefix and failed on five keys that should never have existed. The test
     * caught its own bug, which is the only reason it is worth having.
     */
    const pattern = new RegExp(
      `(?<![\\w])\\(?${column}\\)?(?:::text)?\\s*=\\s*ANY\\s*\\(\\s*\\(?ARRAY\\[([^\\]]+)\\]`,
      "i",
    );
    const m = pattern.exec(clause);
    if (!m) continue;
    for (const lit of m[1]!.matchAll(/'([^']+)'/g)) found.add(lit[1]!);
  }
  return [...found];
}

const vocabularies = new Map<string, string[]>();

beforeAll(async () => {
  const rows = await owner`
    select rel.relname as table_name,
           array_agg(pg_get_constraintdef(c.oid)) as defs
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and c.contype = 'c'
    group by rel.relname`;
  const byTable = new Map<string, string[]>(
    rows.map((r) => [r.table_name as string, r.defs as string[]]),
  );
  for (const spec of TRANSLATED_COLUMNS) {
    const defs = byTable.get(spec.table) ?? [];
    vocabularies.set(`${spec.table}.${spec.column}`, valuesFrom(defs, spec.column));
  }
});

describe("closed vocabularies are translated", () => {
  it("found a vocabulary for every translated column", () => {
    // Guards the test itself: a regex that stops matching would otherwise turn
    // every check below into a loop over an empty array.
    for (const spec of TRANSLATED_COLUMNS) {
      const values = vocabularies.get(`${spec.table}.${spec.column}`) ?? [];
      expect(
        values.length,
        `no CHECK vocabulary read for ${spec.table}.${spec.column} — has the constraint changed shape?`,
      ).toBeGreaterThan(1);
    }
  });

  it("every allowed value has an English and an Arabic message", () => {
    const missing: string[] = [];
    for (const spec of TRANSLATED_COLUMNS) {
      const values = vocabularies.get(`${spec.table}.${spec.column}`) ?? [];
      for (const v of values) {
        if (spec.except?.includes(v)) continue;
        const key = spec.prefix + v;
        if (!EN[key]) missing.push(`en:${key}`);
        if (!AR[key]) missing.push(`ar:${key}`);
      }
    }
    expect(missing, `untranslated database values would render ⟦key⟧`).toEqual([]);
  });

  it("no vocabulary value was translated by copying the English across", () => {
    const untranslated: string[] = [];
    for (const spec of TRANSLATED_COLUMNS) {
      for (const v of vocabularies.get(`${spec.table}.${spec.column}`) ?? []) {
        const key = spec.prefix + v;
        if (EN[key] && AR[key] && EN[key] === AR[key]) untranslated.push(key);
      }
    }
    expect(untranslated).toEqual([]);
  });
});

// Nothing was created, so nothing is wiped — only the pool is closed.
afterAll(async () => {
  await owner.end({ timeout: 5 });
  await closeAppDb();
});
