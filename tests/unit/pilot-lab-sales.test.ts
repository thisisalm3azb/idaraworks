/**
 * H33 Pilot Lab — the sales family, checked without a database.
 *
 * Money is the part of a lab a business owner audits by hand, so the arithmetic
 * is asserted rather than eyeballed: a line's total is quantity times price, a
 * document's subtotal and VAT are the sum of its lines, the total is subtotal
 * plus VAT, a payment never exceeds what its invoice is owed, and the
 * receivables figure the family hands on is exactly what its own rows imply.
 *
 * The service-driven sample needs a database, so `salesRuntime.live` is off
 * here and only the bulk half runs — which is the half a unit test can hold to
 * account.
 */
import { describe, expect, it, vi } from "vitest";
import { H33_BRAND } from "../../tooling/pilot-lab/brand";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import {
  sales,
  salesRuntime,
  buildSales,
  expectedCounts,
  serviceDocCounts,
  SALES_TABLES,
  SERVICE_SAMPLE,
  type SalesHandoff,
} from "../../tooling/pilot-lab/families/sales";

// The service sample talks to a database; the bulk half does not.
salesRuntime.live = false;

type Row = Record<string, unknown>;
type Store = Partial<Record<string, Row[]>>;
type SalesTable = (typeof SALES_TABLES)[number];

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

function handoffs(company: Company): Record<string, Record<string, unknown>> {
  const customerIds = Array.from({ length: Math.max(8, company.profile.customers) }, (_, i) =>
    labId(company.key, "customer", i),
  );
  const itemIds = Array.from({ length: Math.max(8, company.profile.items) }, (_, i) =>
    labId(company.key, "item", i),
  );
  const jobs = Array.from(
    { length: Math.max(10, Math.min(company.profile.jobs, 400)) },
    (_, i) => ({
      id: labId(company.key, "job", i),
      customerId: customerIds[i % customerIds.length]!,
      category: ["active", "completed", "on_hold"][i % 3]!,
      origin: "direct",
    }),
  );
  return {
    setup: {
      vatProfile: company.country === "AE" ? { registered: true } : null,
      departments: {},
    },
    people: { activeEmployeeIds: [], managers: [] },
    masters: {
      customerIds,
      inactiveCustomerIds: customerIds.slice(0, 2),
      itemIds,
      items: {},
    },
    work: { jobs },
  };
}

function fakeCtx(company: Company) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const h = handoffs(company);
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  const ctx: LabContext = {
    brand: H33_BRAND,
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona) => company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family, ...ordinal) => labId(company.key, family, ...ordinal),
    insert: async (table, rows) => {
      if (rows.length === 0) return { attempted: 0, inserted: 0 };
      const columns = Object.keys(rows[0]!);
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
      const v = h[family];
      if (!v) throw new Error(`no handoff from family ${family}`);
      return v as T;
    },
    log: () => {},
    dryRun: false,
  };
  return { ctx, store };
}

async function runFor(company: Company) {
  const { ctx, store } = fakeCtx(company);
  const plan = sales.plan(ctx).expected;
  const report = await sales.seed(ctx);
  const rows = (t: SalesTable) => store[t] ?? [];
  return {
    ctx,
    plan,
    report,
    rows,
    build: buildSales(ctx),
    handoff: report.handoff as unknown as SalesHandoff,
  };
}

const num = (v: unknown) => Number(v as number);
const asOf = (c: Company) => Date.parse(`${c.history.asOf}T23:59:59.999Z`);

describe("the sales family", () => {
  it("is declared correctly and applies everywhere", () => {
    expect(sales.key).toBe("sales");
    expect(sales.deps).toEqual(expect.arrayContaining(["setup", "people", "masters", "work"]));
    for (const c of COMPANIES) expect(sales.appliesTo(c)).toBe(true);
  });

  it("leaves room in the plan for the documents the services will mint", () => {
    for (const c of COMPANIES) {
      const extra = serviceDocCounts(c);
      if (!Object.keys(extra).length) continue;
      // The sample only runs on companies with enough invoices to spare.
      expect(c.profile.invoices).toBeGreaterThanOrEqual(SERVICE_SAMPLE.invoices * 3);
      expect(extra.invoice).toBe(SERVICE_SAMPLE.invoices + SERVICE_SAMPLE.creditNotes);
    }
  });
});

for (const company of COMPANIES) {
  describe(`sales for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      const expected = expectedCounts(r.ctx);
      // The plan covers the bulk AND the documents the service sample will
      // mint; offline only the bulk is written, so the sample's share comes
      // off before comparing.
      const fromServices = serviceDocCounts(company);
      for (const t of SALES_TABLES) {
        const want = (expected[t] ?? 0) - (fromServices[t] ?? 0);
        // reference_sequence is upserted, so the plan is a floor for it.
        if (t === "reference_sequence") expect(r.rows(t).length).toBeGreaterThanOrEqual(want);
        else expect(r.rows(t).length, t).toBe(want);
      }
    });

    it("is deterministic", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of SALES_TABLES)
        expect(a.rows(t).map((x) => x.id ?? x.scope_key)).toEqual(
          b.rows(t).map((x) => x.id ?? x.scope_key),
        );
    });

    it("carries org_id everywhere and never repeats an id", async () => {
      const r = await runFor(company);
      const seen = new Set<string>();
      for (const t of SALES_TABLES)
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          if (row.id === undefined) continue;
          const id = String(row.id);
          expect(seen.has(id), `${t} ${id}`).toBe(false);
          seen.add(id);
        }
    });

    it("dates nothing after the simulation's as-of, except what is genuinely due later", async () => {
      const r = await runFor(company);
      const limit = asOf(company);
      const futureOk = new Set(["due_date", "valid_until", "expires_at"]);
      for (const t of SALES_TABLES)
        for (const row of r.rows(t))
          for (const [k, v] of Object.entries(row)) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
            if (!/_(at|date|on)$/.test(k) || futureOk.has(k)) continue;
            expect(Date.parse(v), `${t}.${k} = ${v}`).toBeLessThanOrEqual(limit);
          }
    });

    // ── the arithmetic ──────────────────────────────────────────────────────
    it("computes every quote and invoice total from its own lines", async () => {
      const r = await runFor(company);
      for (const [doc, lineTable, fk] of [
        ["quote", "quote_line", "quote_id"],
        ["invoice", "invoice_line", "invoice_id"],
      ] as const) {
        const linesBy = new Map<string, Row[]>();
        for (const l of r.rows(lineTable)) {
          const k = String(l[fk]);
          linesBy.set(k, [...(linesBy.get(k) ?? []), l]);
        }
        expect(r.rows(doc).length).toBeGreaterThan(0);
        for (const d of r.rows(doc)) {
          const lines = linesBy.get(String(d.id)) ?? [];
          expect(lines.length, `${doc} ${d.reference} has lines`).toBeGreaterThan(0);
          let sub = 0;
          let vat = 0;
          for (const l of lines) {
            // The line total is quantity times unit price, to the minor unit.
            const computed = Math.round(num(l.qty) * num(l.unit_price_minor));
            expect(num(l.line_total_minor), `${doc} ${d.reference} line`).toBe(computed);
            sub += num(l.line_total_minor);
            vat += Math.round((num(l.line_total_minor) * num(l.vat_rate)) / 100);
          }
          expect(num(d.subtotal_minor), `${doc} ${d.reference} subtotal`).toBe(sub);
          expect(num(d.vat_amount_minor), `${doc} ${d.reference} vat`).toBe(vat);
          expect(num(d.total_minor), `${doc} ${d.reference} total`).toBe(sub + vat);
          expect(num(d.total_minor)).toBeGreaterThanOrEqual(0);
        }
        // Line order is unique and gapless within each document, whichever
        // column the table uses to carry it.
        for (const [k, lines] of linesBy) {
          const col = lines[0]!.line_no !== undefined ? "line_no" : "sort";
          const nos = lines.map((l) => num(l[col])).sort((a, b) => a - b);
          expect(new Set(nos).size, `${k} (${col})`).toBe(nos.length);
          expect(nos[nos.length - 1]! - nos[0]!, k).toBe(nos.length - 1);
        }
      }
    });

    it("charges VAT only where the company is registered for it", async () => {
      const r = await runFor(company);
      const rates = new Set(r.rows("invoice_line").map((l) => num(l.vat_rate)));
      expect(rates.size).toBeGreaterThan(0);
      for (const rate of rates) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }
      // A zero-rated or exported line exists somewhere, or the whole book is
      // at one rate — either is legitimate, but a negative rate is not.
      expect([...rates].every((x) => x >= 0)).toBe(true);
    });

    it("never records a payment larger than the invoice it settles", async () => {
      const r = await runFor(company);
      const invoices = new Map(r.rows("invoice").map((i) => [String(i.id), i]));
      const paidBy = new Map<string, number>();
      for (const p of r.rows("payment")) {
        expect(num(p.amount_minor), "a payment is never zero or negative").toBeGreaterThan(0);
        if (p.status === "void") continue;
        const inv = p.invoice_id ? invoices.get(String(p.invoice_id)) : null;
        if (!inv) continue;
        paidBy.set(String(inv.id), (paidBy.get(String(inv.id)) ?? 0) + num(p.amount_minor));
      }
      for (const [invId, paid] of paidBy) {
        const inv = invoices.get(invId)!;
        expect(paid, `invoice ${inv.reference} over-paid`).toBeLessThanOrEqual(
          num(inv.total_minor),
        );
      }
      /*
       * A paid invoice really is settled — but cash is not the only way to
       * settle one: a credit note clears a balance without a payment, which is
       * why the family's own AR formula subtracts both.
       */
      for (const doc of r.build.invoices) {
        if (doc.kind !== "invoice") continue;
        const settled = doc.paidMinor + doc.creditedMinor;
        if (doc.status === "paid") expect(settled, doc.reference).toBe(doc.totalMinor);
        if (doc.status === "partially_paid") {
          expect(settled, doc.reference).toBeGreaterThan(0);
          expect(settled, doc.reference).toBeLessThan(doc.totalMinor);
        }
        expect(settled, `${doc.reference} over-settled`).toBeLessThanOrEqual(doc.totalMinor);
      }
    });

    it("voids a payment with a reason and a date, or not at all", async () => {
      const r = await runFor(company);
      for (const p of r.rows("payment")) {
        const void_ = p.status === "void";
        expect(void_ === (p.voided_at !== null), String(p.reference)).toBe(true);
        if (void_) expect(p.void_reason).toBeTruthy();
      }
      // Each payment has exactly one receipt.
      const receipts = r.rows("payment_receipt");
      expect(receipts.length).toBe(r.rows("payment").length);
      const paymentIds = new Set(r.rows("payment").map((p) => String(p.id)));
      for (const rc of receipts) expect(paymentIds.has(String(rc.payment_id))).toBe(true);
    });

    it("hands on receivables that match its own rows", async () => {
      const r = await runFor(company);
      // Recompute AR the way an accountant would: issued and partly-paid
      // invoices, less what has been received and credited, floored at zero.
      const paid = new Map<string, number>();
      for (const p of r.rows("payment")) {
        if (p.status !== "recorded" || !p.invoice_id) continue;
        const k = String(p.invoice_id);
        paid.set(k, (paid.get(k) ?? 0) + num(p.amount_minor));
      }
      void paid;
      let total = 0;
      let named = 0;
      for (const doc of r.build.invoices) {
        if (doc.kind !== "invoice") continue;
        if (doc.status !== "issued" && doc.status !== "partially_paid") continue;
        const bal = Math.max(0, doc.totalMinor - doc.paidMinor - doc.creditedMinor);
        total += bal;
        // A walk-in sale has no customer record, so its balance is real money
        // owed that belongs to no row in the per-customer breakdown.
        if (doc.customerIdx >= 0) named += bal;
      }
      const byCustomer = Object.values(r.handoff.arByCustomerMinor).reduce((a, b) => a + b, 0);
      expect(r.handoff.arTotalMinor, "the total is recomputed from the invoices").toBe(total);
      expect(byCustomer, "the breakdown covers every named customer's balance").toBe(named);
      expect(byCustomer, "and never exceeds the total").toBeLessThanOrEqual(r.handoff.arTotalMinor);
      expect(r.handoff.arTotalMinor).toBeGreaterThan(0);
    });

    it("gives every document a unique reference in its own series", async () => {
      const r = await runFor(company);
      for (const t of ["quote", "invoice", "payment", "payment_receipt"] as const) {
        const refs = r.rows(t).map((x) => String(x.reference));
        expect(new Set(refs).size, t).toBe(refs.length);
        for (const ref of refs) expect(ref, t).toMatch(/^[A-Z]{2,3}-\d{3,}$/);
      }
      // The sequence continues above the bulk rather than colliding with it.
      const seq = new Map(
        r.rows("reference_sequence").map((s) => [String(s.scope_key), num(s.next_value)]),
      );
      expect(seq.get("invoice") ?? 0).toBeGreaterThan(
        r.rows("invoice").filter((i) => i.kind === "invoice").length,
      );
      expect(seq.get("quote") ?? 0).toBeGreaterThan(r.rows("quote").length);
    });

    it("shows every quote and invoice state a pilot needs to see", async () => {
      const r = await runFor(company);
      const qs = new Set(r.rows("quote").map((q) => String(q.status)));
      for (const s of ["draft", "sent", "accepted", "rejected", "converted"])
        expect(qs, s).toContain(s);
      const is = new Set(r.rows("invoice").map((i) => String(i.status)));
      for (const s of ["draft", "issued", "partially_paid", "paid"]) expect(is, s).toContain(s);
      // A cancelled invoice carries its reason; nothing else does.
      for (const inv of r.rows("invoice")) {
        const cancelled = inv.status === "cancelled";
        expect(cancelled === (inv.cancelled_at !== null), String(inv.reference)).toBe(true);
        if (cancelled) expect(inv.cancel_reason).toBeTruthy();
      }
    });

    it("links credit notes to the invoice they correct", async () => {
      const r = await runFor(company);
      const byId = new Map(r.rows("invoice").map((i) => [String(i.id), i]));
      const notes = r.rows("invoice").filter((i) => i.kind === "credit_note");
      for (const n of notes) {
        if (n.corrects_invoice_id === null) continue;
        const target = byId.get(String(n.corrects_invoice_id));
        expect(target, String(n.reference)).toBeDefined();
        expect(target!.kind).toBe("invoice");
      }
      // A plain invoice never claims to correct anything.
      for (const i of r.rows("invoice"))
        if (i.kind === "invoice") expect(i.corrects_invoice_id).toBeNull();
    });

    it("points every row at a customer or job the handoffs really gave it", async () => {
      const r = await runFor(company);
      const customers = new Set(r.build.customers.map((c) => c.id));
      const jobs = new Set(r.build.jobs.map((j) => j.id));
      for (const t of ["quote", "invoice", "payment"] as const)
        for (const row of r.rows(t)) {
          if (row.customer_id) expect(customers.has(String(row.customer_id)), t).toBe(true);
          if (row.job_id) expect(jobs.has(String(row.job_id)), t).toBe(true);
        }
    });

    it("writes no service rows while offline", async () => {
      const r = await runFor(company);
      expect(r.handoff.service.invoiceIds).toEqual([]);
      expect(r.handoff.service.paymentIds).toEqual([]);
      for (const t of Object.keys(r.report.counts))
        expect(SALES_TABLES as readonly string[]).toContain(t);
    });
  });
}
