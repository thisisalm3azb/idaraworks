/**
 * H33 — the `masters` family, pinned without a database.
 *
 * The family's rows are a pure function of (company, seed version): the same
 * company produces byte-identical rows every run, plan() promises exactly what
 * seed() writes, every row carries the organisation, and nothing is ever born
 * in a state the database's guards would refuse. All of that is checked here
 * against an in-memory `insert`, for every one of the five companies.
 */
import { describe, expect, it, vi } from "vitest";

/*
 * These build a whole company in memory — tens of thousands of rows for the
 * larger profiles — so the 5-second default is a stopwatch on the machine, not
 * on the code. Under full-suite parallel load it fired on the biggest company
 * and looked like a logic failure.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { COMPANIES } from "../../tooling/pilot-lab/companies";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import {
  itemCategoryKeys,
  layoutFor,
  masters,
  seedMasters,
  SERVICE_ACTIVATIONS,
  unitFor,
  unitsFromHandoff,
  type MastersHandoff,
} from "../../tooling/pilot-lab/families/masters";
import type { Company, FamilyReport, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARABIC = /[؀-ۿ]/;
const PERSONAS: PersonaKey[] = [
  "owner",
  "admin",
  "manager",
  "finance",
  "hr",
  "warehouse",
  "field",
  "restricted",
  "auditor",
];

/** The units the setup family creates, in the shape its handoff publishes them. */
const UNITS: Array<[code: string, dimension: string, factor: number]> = [
  ["pcs", "count", 1],
  ["pair", "count", 2],
  ["pack6", "count", 6],
  ["dz", "count", 12],
  ["box24", "count", 24],
  ["kg", "mass", 1],
  ["g", "mass", 0.001],
  ["t", "mass", 1000],
  ["m", "length", 1],
  ["cm", "length", 0.01],
  ["mm", "length", 0.001],
  ["roll50", "length", 50],
  ["l", "volume", 1],
  ["ml", "volume", 0.001],
  ["drum200", "volume", 200],
  ["m2", "area", 1],
  ["sqft", "area", 0.09290304],
  ["hr", "time", 1],
  ["day", "time", 8],
  ["wk", "time", 40],
];

function setupHandoff(company: Company): Record<string, unknown> {
  const units: Record<string, unknown> = {};
  for (const [code, dimension, factor] of UNITS) {
    units[code] = {
      id: labId(company.key, "unit_of_measure", code),
      dimension,
      factorToBase: factor,
      isBase: factor === 1,
    };
  }
  return { units, warehouses: {}, departments: {}, taxCodes: {} };
}

function peopleHandoff(company: Company): Record<string, unknown> {
  const personaEmployees = Object.fromEntries(
    (["manager", "hr", "warehouse", "field", "restricted"] as PersonaKey[]).map((p) => [
      p,
      labId(company.key, "employee", p),
    ]),
  );
  const employeeIds = Array.from({ length: company.profile.employees }, (_, i) =>
    labId(company.key, "employee", i),
  );
  return {
    personaEmployees,
    employeeIds,
    activeEmployeeIds: employeeIds,
    managers: [personaEmployees.manager],
  };
}

/**
 * A LabContext with no database behind it: `insert` keeps rows in memory and
 * enforces exactly what db.ts enforces (org_id on every row, no ragged rows).
 */
function fakeCtx(
  company: Company,
  opts: { dryRun?: boolean } = {},
): { ctx: LabContext; store: Store } {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: setupHandoff(company),
    people: peopleHandoff(company),
  };
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx: LabContext = {
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: handoffs.people!.personaEmployees as LabContext["employees"],
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: persona === "owner" || persona === "admin" || persona === "finance",
      pricePrivileged: persona === "owner" || persona === "admin" || persona === "finance",
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
      if (!columns.includes("org_id")) throw new Error(`${table}: rows must carry org_id`);
      for (const r of rows) {
        if (!r.org_id) throw new Error(`${table}: a row has no org_id`);
        for (const k of Object.keys(r))
          if (!columns.includes(k)) throw new Error(`${table}: ragged row (extra ${k})`);
      }
      store[table] = [...(store[table] ?? []), ...rows.map((r) => ({ ...r }))];
      return { attempted: rows.length, inserted: rows.length };
    },
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) out[e.table] = await ctx.insert(e.table, e.rows, e.conflict);
      return out;
    },
    handoff: <T>(family: string) => {
      const h = handoffs[family];
      if (!h) throw new Error(`no handoff from family ${family}`);
      return h as T;
    },
    log: () => {},
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, store };
}

type Seeded = {
  company: Company;
  ctx: LabContext;
  store: Store;
  report: FamilyReport;
  handoff: MastersHandoff;
  expected: Record<string, number>;
};

const cache = new Map<string, Promise<Seeded>>();
function seeded(company: Company): Promise<Seeded> {
  let p = cache.get(company.key);
  if (!p) {
    p = (async () => {
      const { ctx, store } = fakeCtx(company);
      const expected = masters.plan(ctx).expected;
      const report = await seedMasters(ctx, { services: false });
      return { company, ctx, store, report, handoff: report.handoff as MastersHandoff, expected };
    })();
    cache.set(company.key, p);
  }
  return p;
}

function counts(store: Store): Record<string, number> {
  return Object.fromEntries(Object.entries(store).map(([t, rows]) => [t, rows.length]));
}
function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((r) => [r.id as string, r]));
}

describe("the masters family", () => {
  it("is keyed, depends on setup and people, and applies to every company", () => {
    expect(masters.key).toBe("masters");
    expect(masters.deps).toEqual(["setup", "people"]);
    for (const c of COMPANIES) expect(masters.appliesTo(c), c.key).toBe(true);
    expect(typeof masters.verify).toBe("function");
  });

  it("reads units from the setup handoff in the shape setup publishes them", () => {
    const units = unitsFromHandoff(setupHandoff(COMPANIES[0]!));
    expect(units.map((u) => u.code)).toEqual(UNITS.map((u) => u[0]));
    expect(unitsFromHandoff(undefined)).toEqual([]);
    expect(unitsFromHandoff({ units: {} })).toEqual([]);
    // A category whose preferred codes are absent still gets a count unit.
    const only = [{ id: "u", code: "pcs" }];
    expect(unitFor(only, "inventory", "paint_finishes", 3).code).toBe("pcs");
    expect(unitFor(units, "service", "services", 0).code).toBe("hr");
    expect(unitFor(units, "service", "services", 1).code).toBe("day");
  });
});

for (const company of COMPANIES) {
  describe(`${company.key} — plan, seed and invariants`, () => {
    const tables = company.profile.enables.bom
      ? [
          "customer",
          "customer_contact",
          "crm_consent",
          "crm_suppression",
          "supplier",
          "item",
          "bom",
          "bom_line",
        ]
      : ["customer", "customer_contact", "crm_consent", "crm_suppression", "supplier", "item"];

    it("plan() promises exactly the rows seed() inserts, table by table", async () => {
      const s = await seeded(company);
      expect(Object.keys(s.expected).sort()).toEqual([...tables].sort());
      expect(counts(s.store)).toEqual(s.expected);
      expect(s.report.counts).toEqual(s.expected);
      expect(s.expected.customer).toBe(company.profile.customers);
      expect(s.expected.supplier).toBe(company.profile.suppliers);
      expect(s.expected.item).toBe(company.profile.items);
    });

    it("the Family entry point in dry-run inserts the same rows and skips the service", async () => {
      const s = await seeded(company);
      const { ctx, store } = fakeCtx(company, { dryRun: true });
      const report = await masters.seed(ctx);
      expect(counts(store)).toEqual(s.expected);
      expect(report.counts).toEqual(s.expected);
      expect(JSON.stringify(store)).toBe(JSON.stringify(s.store));
      expect(report.notes?.some((n) => /through the service/.test(n)) ?? false).toBe(false);
    });

    it("is deterministic: two independent runs produce identical rows and handoff", async () => {
      const s = await seeded(company);
      const again = fakeCtx(company);
      const report = await seedMasters(again.ctx, { services: false });
      expect(JSON.stringify(again.store)).toBe(JSON.stringify(s.store));
      expect(JSON.stringify(report.handoff)).toBe(JSON.stringify(s.report.handoff));
      // plan() is pure: it consumed no randomness before seed() ran (see seeded()).
      expect(masters.plan(again.ctx).expected).toEqual(s.expected);
    });

    it("every row carries the organisation, a v5 id unique in its table, and no undefined", async () => {
      const s = await seeded(company);
      for (const [table, rows] of Object.entries(s.store)) {
        const ids = new Set<string>();
        for (const r of rows) {
          expect(r.org_id, table).toBe(s.ctx.orgId);
          expect(r.id, table).toMatch(UUID_V5);
          expect(ids.has(r.id as string), `${table} duplicate id`).toBe(false);
          ids.add(r.id as string);
          for (const [k, v] of Object.entries(r))
            expect(v, `${table}.${k} must be a value or null`).not.toBeUndefined();
          for (const k of ["posted_at", "finalized", "issued_snapshot_id"])
            expect(k in r, `${table} must not write ${k}`).toBe(false);
        }
      }
    });

    it("customers are fictional, mixed in state and language, and each has one active primary contact", async () => {
      const s = await seeded(company);
      const customers = s.store.customer!;
      const contacts = s.store.customer_contact!;
      const customerIds = new Set(customers.map((c) => c.id as string));
      const primaries = new Map<string, number>();
      for (const c of contacts) {
        expect(customerIds.has(c.customer_id as string)).toBe(true);
        expect((c.name as string).length).toBeGreaterThan(0);
        expect((c.name as string).length).toBeLessThanOrEqual(120);
        expect(["phone", "email"]).toContain(c.preferred_method);
        expect(["en", "ar"]).toContain(c.language);
        expect([
          "decision_maker",
          "economic_buyer",
          "influencer",
          "champion",
          "user",
          "procurement",
          "finance",
          "technical",
          "blocker",
          "other",
        ]).toContain(c.role_kind);
        if (c.email !== null) expect(c.email).toMatch(/@example\.invalid$/);
        if (c.is_primary && c.active)
          primaries.set(c.customer_id as string, (primaries.get(c.customer_id as string) ?? 0) + 1);
      }
      for (const id of customerIds) expect(primaries.get(id), "one active primary").toBe(1);

      let arabic = 0;
      let inactive = 0;
      const fakePhone = company.country === "SA" ? /^\+966 50 000 \d{4}$/ : /^\+971 50 000 \d{4}$/;
      for (const c of customers) {
        const name = c.name as string;
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(160);
        expect(c.country).toMatch(/^[A-Z]{2}$/);
        expect(c.email).toMatch(/@example\.invalid$/);
        expect(c.phone).toMatch(fakePhone);
        if (c.tax_reg_no !== null) expect(c.tax_reg_no).toMatch(/^(1999|399999)\d+$/);
        expect(c.segment).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        expect([
          "manual",
          "form",
          "import",
          "referral",
          "campaign",
          "email",
          "api",
          "lead",
        ]).toContain(c.source_kind);
        expect(Array.isArray(c.tags)).toBe(true);
        expect(c.payment_terms_days as number).toBeGreaterThanOrEqual(0);
        expect(c.payment_terms_days as number).toBeLessThanOrEqual(365);
        if (c.credit_limit_minor !== null)
          expect(c.credit_limit_minor as number).toBeGreaterThan(0);
        expect(Object.values(s.ctx.users)).toContain(c.owner_user_id);
        expect(c.merged_into_customer_id).toBeNull();
        if (ARABIC.test(name)) arabic++;
        if (!c.active) inactive++;
      }
      expect(arabic).toBeGreaterThan(0);
      expect(inactive).toBeGreaterThan(0);
      expect(inactive).toBeLessThan(customers.length / 4);
      expect(new Set(s.handoff.inactiveCustomerIds)).toEqual(
        new Set(customers.filter((c) => !c.active).map((c) => c.id)),
      );
    });

    it("consent rows name exactly one existing subject; suppressions are normalised, fake and unique", async () => {
      const s = await seeded(company);
      const customerIds = new Set(s.store.customer!.map((c) => c.id as string));
      const contactIds = new Set(s.store.customer_contact!.map((c) => c.id as string));
      let forCustomers = 0;
      let forContacts = 0;
      for (const r of s.store.crm_consent!) {
        const subjects = [r.customer_id, r.contact_id, r.lead_id].filter((x) => x !== null);
        expect(subjects).toHaveLength(1);
        expect(r.lead_id).toBeNull();
        if (r.customer_id !== null) {
          expect(customerIds.has(r.customer_id as string)).toBe(true);
          forCustomers++;
        } else {
          expect(contactIds.has(r.contact_id as string)).toBe(true);
          forContacts++;
        }
        expect(["email", "sms", "whatsapp", "phone", "post"]).toContain(r.channel);
        expect(["granted", "withdrawn", "unknown"]).toContain(r.status);
        expect([
          "form",
          "verbal",
          "written",
          "import",
          "customer_request",
          "unsubscribe",
          "system",
        ]).toContain(r.source);
        expect((r.evidence as string).length).toBeLessThanOrEqual(1000);
        expect(r.actor_user_id).toBe(s.ctx.users.manager);
      }
      expect(forCustomers).toBeGreaterThan(0);
      expect(forContacts).toBeGreaterThan(0);

      const seen = new Set<string>();
      for (const r of s.store.crm_suppression!) {
        expect(["email", "sms", "whatsapp", "phone", "post"]).toContain(r.channel);
        expect(["objection", "unsubscribe", "bounce", "complaint", "legal", "manual"]).toContain(
          r.reason,
        );
        expect(r.address).toMatch(/^(\+9[0-9]{11}|[a-z0-9.]+@example\.invalid)$/);
        const key = `${r.channel}:${r.address}`;
        expect(seen.has(key), "unique per channel and address").toBe(false);
        seen.add(key);
      }
      expect(s.store.crm_suppression!.length).toBeGreaterThan(0);
    });

    it("suppliers are fictional, some inactive, and every item's preferred supplier is one of them", async () => {
      const s = await seeded(company);
      const suppliers = s.store.supplier!;
      const supplierIds = new Set(suppliers.map((x) => x.id as string));
      let inactive = 0;
      for (const x of suppliers) {
        expect((x.name as string).length).toBeLessThanOrEqual(160);
        expect(x.email).toMatch(/@example\.invalid$/);
        expect(x.phone).toMatch(/^\+9(71|66) 50 000 \d{4}$/);
        if (x.tax_reg_no !== null) expect(x.tax_reg_no).toMatch(/^(1999|399999)\d+$/);
        expect((x.terms_text as string).length).toBeLessThanOrEqual(500);
        expect(x.payment_terms_days as number).toBeLessThanOrEqual(365);
        if (!x.active) inactive++;
      }
      expect(inactive).toBeGreaterThan(0);
      expect(s.handoff.supplierIds).toEqual(suppliers.map((x) => x.id));
      expect(new Set(s.handoff.inactiveSupplierIds)).toEqual(
        new Set(suppliers.filter((x) => !x.active).map((x) => x.id)),
      );
      let linked = 0;
      for (const i of s.store.item!) {
        if (i.preferred_supplier_id === null) continue;
        expect(supplierIds.has(i.preferred_supplier_id as string)).toBe(true);
        expect(i.supplier_item_code).not.toBeNull();
        linked++;
      }
      expect(linked).toBeGreaterThan(0);
    });

    it("items reconcile: unique SKUs, template categories, real units, price ≥ cost, tracking within the profile", async () => {
      const s = await seeded(company);
      const items = s.store.item!;
      const cats = new Set(itemCategoryKeys(company));
      const unitIds = new Map(
        UNITS.map(([code]) => [code, labId(company.key, "unit_of_measure", code)]),
      );
      const skus = new Set<string>();
      const gtins = new Set<string>();
      let arabicNames = 0;
      let arabicPrimary = 0;
      let inactive = 0;
      let withMin = 0;
      let serial = 0;
      let lot = 0;
      const unitCodes = new Set<string>();
      for (const i of items) {
        const sku = i.sku as string;
        expect(sku.length).toBeLessThanOrEqual(64);
        expect(skus.has(sku), "unique sku").toBe(false);
        skus.add(sku);
        expect((i.name as string).length).toBeGreaterThan(0);
        expect((i.name as string).length).toBeLessThanOrEqual(160);
        expect(i.category_key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        expect(
          cats.has(i.category_key as string),
          `${i.category_key} in ${company.templateKey}`,
        ).toBe(true);
        expect(unitIds.get(i.unit as string), `unit ${i.unit}`).toBe(i.base_unit_id);
        expect(i.purchase_unit_id).toBe(i.base_unit_id);
        expect(i.issue_unit_id).toBe(i.base_unit_id);
        unitCodes.add(i.unit as string);
        expect(i.unit_cost_minor as number).toBeGreaterThan(0);
        expect(i.selling_price_minor as number).toBeGreaterThanOrEqual(i.unit_cost_minor as number);
        expect(["inventory", "consumable", "service", "asset", "manufactured"]).toContain(
          i.item_type,
        );
        expect(["active", "inactive", "discontinued"]).toContain(i.lifecycle);
        expect(i.lifecycle === "active").toBe(i.active);
        expect(["none", "lot", "serial"]).toContain(i.tracking);
        if (i.tracking === "serial") {
          expect(company.profile.enables.serials).toBe(true);
          expect(i.item_type).toBe("inventory");
          serial++;
        }
        if (i.tracking === "lot") {
          expect(company.profile.enables.lots).toBe(true);
          expect(i.item_type).toBe("inventory");
          lot++;
        }
        if (i.cost_method !== null) expect(i.tracking).toBe("lot");
        if (i.expiry_tracked) expect(i.tracking).toBe("lot");
        if (i.min_qty !== null) {
          expect(i.min_qty as number).toBeGreaterThan(0);
          expect(i.reorder_point).toBe(i.min_qty);
          expect(i.reorder_qty as number).toBeGreaterThan(i.min_qty as number);
          withMin++;
        } else {
          expect(i.reorder_qty).toBeNull();
        }
        if (i.gtin !== null) {
          expect(i.gtin).toMatch(/^[0-9]{14}$/);
          expect(gtins.has(i.gtin as string), "unique gtin").toBe(false);
          gtins.add(i.gtin as string);
          expect(i.gtin_raw).toBe(i.gtin);
          expect(i.code_kind).toBe("internal");
        } else {
          expect(i.code_kind).toBe("none");
        }
        expect(["standard", "zero"]).toContain(i.tax_category);
        if (i.item_type === "manufactured") expect(company.profile.enables.bom).toBe(true);
        if (i.name_ar !== null) arabicNames++;
        if (ARABIC.test(i.name as string)) arabicPrimary++;
        if (!i.active) inactive++;
      }
      expect(arabicNames * 3).toBeGreaterThanOrEqual(items.length);
      if (company.languages[0] === "ar")
        expect(arabicPrimary * 2).toBeGreaterThanOrEqual(items.length);
      else expect(arabicPrimary).toBe(0);
      expect(inactive).toBeGreaterThan(0);
      expect(withMin).toBeGreaterThan(0);
      expect(serial > 0).toBe(company.profile.enables.serials);
      expect(lot > 0).toBe(company.profile.enables.lots);
      expect(unitCodes.size).toBeGreaterThan(2);

      // The handoff mirrors the rows so later families need no query.
      expect(s.handoff.itemIds).toEqual(items.map((i) => i.id));
      const rows = byId(items);
      for (const [id, h] of Object.entries(s.handoff.items)) {
        const r = rows.get(id)!;
        expect(r).toBeDefined();
        expect(h).toEqual({
          unit: r.unit,
          unitId: r.base_unit_id,
          cost: r.unit_cost_minor,
          price: r.selling_price_minor,
          category: r.category_key,
          type: r.item_type,
          tracking: r.tracking,
        });
      }
      expect(Object.keys(s.handoff.items)).toHaveLength(items.length);
      expect(new Set(s.handoff.inactiveItemIds)).toEqual(
        new Set(items.filter((i) => !i.active).map((i) => i.id)),
      );
      for (const id of s.handoff.lowStockCandidateItemIds) {
        const r = rows.get(id)!;
        expect(r.item_type).toBe("inventory");
        expect(r.active).toBe(true);
        expect(r.min_qty as number).toBeGreaterThan(0);
      }
      for (const id of s.handoff.zeroStockItemIds) {
        const r = rows.get(id)!;
        expect(r.item_type).toBe("inventory");
        expect(r.active).toBe(true);
        expect(s.handoff.lowStockCandidateItemIds).not.toContain(id);
      }
      expect(s.handoff.lowStockCandidateItemIds.length).toBeGreaterThan(0);
      expect(s.handoff.itemCategoryKeys).toEqual(itemCategoryKeys(company));
      expect(s.handoff.customerIds).toEqual(s.store.customer!.map((c) => c.id));
    });

    it("bills of material exist only where the profile enables them, and are born legal", async () => {
      const s = await seeded(company);
      const layout = layoutFor(company);
      if (!company.profile.enables.bom) {
        expect(s.store.bom).toBeUndefined();
        expect(s.store.bom_line).toBeUndefined();
        expect(s.handoff.bomIds).toEqual([]);
        expect(s.handoff.activeBomIds).toEqual([]);
        expect(s.handoff.serviceActivatedBomIds).toEqual([]);
        expect(layout.bomParents).toBe(0);
        return;
      }
      const boms = s.store.bom!;
      const lines = s.store.bom_line!;
      const items = byId(s.store.item!);
      const ordinal = new Map(s.handoff.itemIds.map((id, i) => [id, i]));
      const unitIdSet = new Set(UNITS.map(([code]) => labId(company.key, "unit_of_measure", code)));

      const activePerItem = new Map<string, number>();
      const versions = new Set<string>();
      const states = { draft: 0, active: 0, archived: 0 };
      for (const b of boms) {
        expect(["draft", "active", "archived"]).toContain(b.status);
        states[b.status as keyof typeof states]++;
        expect(b.status === "archived").toBe(b.archived_at !== null);
        if (b.status === "draft") expect(b.effective_from).toBeNull();
        else expect(b.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(b.output_qty as number).toBeGreaterThan(0);
        expect(unitIdSet.has(b.unit_id as string)).toBe(true);
        expect(b.created_by).toBe(s.ctx.users.manager);
        const parent = items.get(b.item_id as string)!;
        expect(parent.item_type).toBe("manufactured");
        expect(parent.active).toBe(true);
        expect(b.unit_id).toBe(parent.base_unit_id);
        const vkey = `${b.item_id}:${b.version}`;
        expect(versions.has(vkey), "one row per item version").toBe(false);
        versions.add(vkey);
        if (b.status === "active")
          activePerItem.set(b.item_id as string, (activePerItem.get(b.item_id as string) ?? 0) + 1);
        if (b.archived_at !== null) expect(String(b.updated_at)).toBe(String(b.archived_at));
      }
      for (const n of activePerItem.values()) expect(n, "one active recipe per item").toBe(1);
      expect(states.draft).toBeGreaterThan(0);
      expect(states.active).toBeGreaterThan(0);
      expect(states.archived).toBeGreaterThan(0);

      const bomRows = byId(boms);
      const recipeItems = new Set(boms.map((b) => b.item_id as string));
      const linesOf = new Map<string, Row[]>();
      const once = new Set<string>();
      for (const l of lines) {
        const b = bomRows.get(l.bom_id as string)!;
        expect(b).toBeDefined();
        const component = items.get(l.component_item_id as string)!;
        expect(component).toBeDefined();
        expect(l.component_item_id).not.toBe(b.item_id);
        // Acyclic by construction: a manufactured component always has a lower
        // ordinal than its parent, and a raw material has no recipe at all.
        if (component.item_type === "manufactured")
          expect(ordinal.get(l.component_item_id as string)!).toBeLessThan(
            ordinal.get(b.item_id as string)!,
          );
        else expect(recipeItems.has(l.component_item_id as string)).toBe(false);
        const key = `${l.bom_id}:${l.component_item_id}`;
        expect(once.has(key), "a component appears once per recipe").toBe(false);
        once.add(key);
        expect(l.qty_per as number).toBeGreaterThan(0);
        expect(l.scrap_pct as number).toBeGreaterThanOrEqual(0);
        expect(l.scrap_pct as number).toBeLessThan(100);
        expect(l.unit_id).toBe(component.base_unit_id);
        expect(component.item_type === "manufactured" || component.item_type === "inventory").toBe(
          true,
        );
        expect(component.active).toBe(true);
        linesOf.set(l.bom_id as string, [...(linesOf.get(l.bom_id as string) ?? []), l]);
      }
      for (const b of boms) {
        const n = linesOf.get(b.id as string)?.length ?? 0;
        expect(n, `recipe ${b.item_id} v${b.version} has components`).toBeGreaterThanOrEqual(3);
      }
      // Three levels: a top-level recipe uses a sub-assembly that has its own active recipe.
      const activeByItem = new Map(
        boms.filter((b) => b.status === "active").map((b) => [b.item_id, b]),
      );
      const nested = lines.some((l) => {
        const parentBom = bomRows.get(l.bom_id as string)!;
        const child = activeByItem.get(l.component_item_id);
        return (
          parentBom.status === "active" &&
          child !== undefined &&
          (linesOf.get(child.id as string) ?? []).some((l2) =>
            activeByItem.has(l2.component_item_id),
          )
        );
      });
      expect(nested).toBe(true);

      // Service-driven activations are born as drafts and never pre-activated by hand.
      expect(s.handoff.serviceActivatedBomIds).toHaveLength(SERVICE_ACTIVATIONS);
      for (const id of s.handoff.serviceActivatedBomIds) {
        expect(bomRows.get(id)!.status).toBe("draft");
        expect(s.handoff.activeBomIds).not.toContain(id);
      }
      expect(s.handoff.bomIds).toEqual(boms.map((b) => b.id));
      expect(new Set(s.handoff.activeBomIds)).toEqual(
        new Set(boms.filter((b) => b.status === "active").map((b) => b.id)),
      );
      expect(s.handoff.bomParentItemIds).toHaveLength(layout.bomParents);
      expect(s.report.notes).toContain(
        `${SERVICE_ACTIVATIONS} BOM activations skipped (no service run)`,
      );
    });

    it("dates sit inside the company's history and nothing is in the future", async () => {
      const s = await seeded(company);
      const from = Date.parse(`${company.history.from}T00:00:00Z`);
      const asOf = Date.parse(`${company.history.asOf}T23:59:59Z`);
      for (const [table, rows] of Object.entries(s.store)) {
        for (const r of rows) {
          for (const k of ["created_at", "updated_at", "effective_at", "archived_at"]) {
            if (!(k in r) || r[k] === null) continue;
            const t = Date.parse(r[k] as string);
            expect(t, `${table}.${k}`).toBeGreaterThanOrEqual(from);
            expect(t, `${table}.${k}`).toBeLessThanOrEqual(asOf);
          }
        }
      }
    });
  });
}

describe("pagination thresholds the profiles promise", () => {
  const plan = (key: string) => {
    const company = COMPANIES.find((c) => c.key === key)!;
    return masters.plan(fakeCtx(company).ctx).expected;
  };
  /*
   * The law is ONE company past the boundary on each paginated surface, not
   * every company: five catalogues of three thousand items each is how the
   * lab first planned itself past 400,000 rows and half a gigabyte. tradeline
   * is the volume company; the rest stay substantial without paying for it.
   */
  it("tradeline carries the paginated catalogue and customer book", () => {
    const p = plan("tradeline");
    expect(p.customer).toBeGreaterThan(1205);
    expect(p.item).toBeGreaterThan(1205);
  });
  it("the other companies stay substantial without crossing it", () => {
    for (const key of ["gulfbuild", "saudimfg", "consult", "facilico"]) {
      const p = plan(key);
      expect(p.item, key).toBeGreaterThan(100);
      expect(p.customer, key).toBeGreaterThan(100);
    }
  });
  it("only the Saudi manufacturer carries bills of material", () => {
    for (const c of COMPANIES) {
      const p = masters.plan(fakeCtx(c).ctx).expected;
      expect("bom" in p, c.key).toBe(c.profile.enables.bom);
      expect("bom_line" in p, c.key).toBe(c.profile.enables.bom);
    }
    expect(COMPANIES.filter((c) => c.profile.enables.bom).map((c) => c.key)).toEqual(["saudimfg"]);
  });
});
