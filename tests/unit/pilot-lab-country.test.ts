/**
 * H33 Pilot Lab — the country/e-invoicing/AI family, checked without a database.
 *
 * This family's value is entirely in what it refuses to write, so most of these
 * tests are adversarial: they read every row it produces and assert that none
 * of it claims a submission was made, a channel was configured, a registration
 * was verified with an authority, or an AI provider was ever called. A test
 * that only counted rows would miss every failure that matters here.
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
  country,
  planCountry,
  seedCountry,
  buildCountry,
  fakeHash,
  COUNTRY_TABLES,
  LOCAL_ONLY_EINVOICE_STATUSES,
  SUBMITTED_EINVOICE_STATUSES,
  FORBIDDEN_TABLES,
  type CountryTable,
} from "../../tooling/pilot-lab/families/country";

type Row = Record<string, unknown>;
type Store = Partial<Record<string, Row[]>>;

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

const INVOICE_COUNT = 12;

function setupHandoff(company: Company): Record<string, unknown> {
  if (!company.profile.enables.establishment) return { establishments: {} };
  return {
    establishments: {
      "HQ-RUH": labId(company.key, "establishment", "HQ-RUH"),
      "BR-DMM": labId(company.key, "establishment", "BR-DMM"),
    },
  };
}

function salesHandoff(company: Company, invoices = INVOICE_COUNT): Record<string, unknown> {
  return {
    invoiceIds: Array.from({ length: invoices }, (_, i) => labId(company.key, "invoice", i)),
  };
}

function fakeCtx(company: Company, handoffOverrides: Record<string, Record<string, unknown>> = {}) {
  const store: Store = {};
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const handoffs: Record<string, Record<string, unknown>> = {
    setup: setupHandoff(company),
    sales: salesHandoff(company),
    ...handoffOverrides,
  };
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
    dryRun: false,
  };
  return { ctx, store };
}

async function runFor(company: Company, overrides?: Record<string, Record<string, unknown>>) {
  const { ctx, store } = fakeCtx(company, overrides);
  const plan = planCountry(ctx).expected;
  const report = await seedCountry(ctx);
  const rows = (t: CountryTable) => store[t] ?? [];
  return { ctx, plan, report, rows, store };
}

const asOf = (c: Company) => Date.parse(`${c.history.asOf}T23:59:59.999Z`);
const ts = (v: unknown) => Date.parse(String(v));

describe("the country family", () => {
  it("is declared correctly", () => {
    expect(country.key).toBe("country");
    // Establishments come from setup; the invoices documents hang off come
    // from sales. Missing either dependency would silently empty the family.
    expect(country.deps).toEqual(expect.arrayContaining(["setup", "sales"]));
    for (const c of COMPANIES) expect(country.appliesTo(c)).toBe(true);
  });

  it("never lists a submitted state as writable", () => {
    for (const s of SUBMITTED_EINVOICE_STATUSES)
      expect(LOCAL_ONLY_EINVOICE_STATUSES as readonly string[]).not.toContain(s);
    expect(FORBIDDEN_TABLES).toContain("einvoice_submission");
    expect(FORBIDDEN_TABLES).toContain("ai_run");
  });

  it("does not write establishments or their registrations — setup owns those", () => {
    expect(COUNTRY_TABLES as readonly string[]).not.toContain("establishment");
    expect(COUNTRY_TABLES as readonly string[]).not.toContain("establishment_registration");
  });

  it("produces a stable 64-character hash", () => {
    const a = fakeHash("saudimfg:einvoice:0");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fakeHash("saudimfg:einvoice:0")).toBe(a);
    expect(fakeHash("saudimfg:einvoice:1")).not.toBe(a);
  });
});

for (const company of COMPANIES) {
  const hasEstablishment = company.profile.enables.establishment;

  describe(`country for ${company.key}`, () => {
    it("plans exactly the rows it writes", async () => {
      const r = await runFor(company);
      for (const t of COUNTRY_TABLES) expect(r.rows(t).length, t).toBe(r.plan[t]);
      for (const t of COUNTRY_TABLES) expect(r.report.counts[t], t).toBe(r.plan[t]);
    });

    it("is deterministic — the same context twice gives the same ids", async () => {
      const a = await runFor(company);
      const b = await runFor(company);
      for (const t of COUNTRY_TABLES)
        expect(a.rows(t).map((x) => x.id)).toEqual(b.rows(t).map((x) => x.id));
    });

    it("carries org_id on every row and no duplicate ids", async () => {
      const r = await runFor(company);
      const seen = new Set<string>();
      for (const t of COUNTRY_TABLES)
        for (const row of r.rows(t)) {
          expect(row.org_id, t).toBe(r.ctx.orgId);
          const id = String(row.id);
          expect(seen.has(id), `${t} ${id}`).toBe(false);
          seen.add(id);
        }
    });

    it("dates nothing after the simulation's as-of", async () => {
      const r = await runFor(company);
      const limit = asOf(company);
      for (const t of COUNTRY_TABLES)
        for (const row of r.rows(t))
          for (const [k, v] of Object.entries(row))
            if (
              typeof v === "string" &&
              /_(at|on|from|to)$/.test(k) &&
              /^\d{4}-\d{2}-\d{2}/.test(v)
            )
              expect(ts(v), `${t}.${k}`).toBeLessThanOrEqual(limit);
    });

    // ── the AI half, which every company gets ─────────────────────────────
    it("ends with AI switched off and the credit balance at zero", async () => {
      const r = await runFor(company);
      const ents = r
        .rows("ai_entitlement")
        .slice()
        .sort((a, b) => Number(a.version) - Number(b.version));
      expect(ents.length).toBeGreaterThanOrEqual(2);
      expect(ents.at(-1)!.mode).toBe("disabled");
      expect(ents.at(-1)!.ai_enabled_by_org).toBe(false);
      expect(ents.at(-1)!.effective_to).toBeNull();
      // Versions are unique and the history does not overlap itself.
      expect(new Set(ents.map((e) => e.version)).size).toBe(ents.length);
      for (let i = 0; i < ents.length - 1; i++)
        expect(ts(ents[i]!.effective_to)).toBeLessThanOrEqual(ts(ents[i + 1]!.effective_from));
      for (const e of ents)
        if (e.effective_to !== null)
          expect(ts(e.effective_to), "effective_to must be after effective_from").toBeGreaterThan(
            ts(e.effective_from),
          );

      const ledger = r.rows("ai_credit_ledger");
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.reduce((n, l) => n + Number(l.credits), 0)).toBe(0);
      for (const l of ledger) expect(String(l.period_key)).toMatch(/^\d{4}-\d{2}$/);
      // Nothing was consumed, because nothing ran.
      expect(ledger.some((l) => l.kind === "consumption")).toBe(false);
    });

    it("records that no AI provider is engaged", async () => {
      const r = await runFor(company);
      const reg = r.rows("ai_privacy_register");
      expect(reg.length).toBe(1);
      expect(String(reg[0]!.provider_key)).toMatch(/^[a-z0-9_]{1,40}$/);
      // Every not-null column on the table is populated.
      for (const k of [
        "lawful_basis",
        "processor_agreement_ref",
        "transfer_mechanism",
        "recorded_by",
      ])
        expect(reg[0]![k], k).toBeTruthy();
      expect(reg[0]!.revoked_at).toBeNull();
    });

    it("writes no row belonging to a forbidden table", async () => {
      const r = await runFor(company);
      for (const t of FORBIDDEN_TABLES) expect(r.store[t] ?? []).toEqual([]);
      expect(r.store.einvoice_submission ?? []).toEqual([]);
    });

    // ── the e-invoicing half, which only the establishment company gets ────
    if (!hasEstablishment) {
      it("writes nothing establishment-scoped, because it has no establishment", async () => {
        const r = await runFor(company);
        expect(buildCountry(fakeCtx(company).ctx).establishmentId).toBeNull();
        for (const t of [
          "establishment_privacy",
          "einvoice_channel",
          "einvoice_document",
          "einvoice_event",
        ] as const)
          expect(r.rows(t), t).toEqual([]);
      });
    } else {
      it("leaves the channel unconfigured, uncredentialed and stopped", async () => {
        const r = await runFor(company);
        const chans = r.rows("einvoice_channel");
        expect(chans.length).toBe(1);
        const c = chans[0]!;
        expect(c.status).toBe("not_configured");
        expect(c.credential_ref).toBeNull();
        expect(c.activated_at).toBeNull();
        expect(c.activated_by).toBeNull();
        expect(c.stopped).toBe(true);
        expect(String(c.stop_reason).length).toBeGreaterThan(0);
        // Sandbox only: a production channel would assert a real connection.
        expect(c.environment).toBe("sandbox");
        expect(c.country).toBe(company.country);
        expect(c.establishment_id).toBe(
          r.ctx.handoff<{ establishments: Record<string, string> }>("setup").establishments[
            "HQ-RUH"
          ],
        );
      });

      it("keeps every e-invoice document in a purely local state", async () => {
        const r = await runFor(company);
        const docs = r.rows("einvoice_document");
        expect(docs.length).toBeGreaterThan(0);
        for (const d of docs) {
          expect(LOCAL_ONLY_EINVOICE_STATUSES as readonly string[]).toContain(String(d.status));
          expect(SUBMITTED_EINVOICE_STATUSES as readonly string[]).not.toContain(String(d.status));
          expect(d.attempts).toBe(0);
          expect(d.submitted_at).toBeNull();
          expect(d.settled_at).toBeNull();
          expect(d.request_evidence).toBeNull();
          expect(d.response_evidence).toBeNull();
          expect(d.source_kind).toBe("invoice");
          expect(d.source_id, "source_id is NOT NULL in the schema").toBeTruthy();
          expect(String(d.idempotency_key).length).toBeGreaterThanOrEqual(8);
          expect(String(d.idempotency_key).length).toBeLessThanOrEqual(200);
          expect(String(d.document_hash)).toMatch(/^[0-9a-f]{64}$/);
        }
        // The states a reviewer should be able to look at are all present.
        const states = new Set(docs.map((d) => String(d.status)));
        for (const s of ["prepared", "validated", "blocked_no_credential", "cancelled"])
          expect(states, `state ${s} should be visible`).toContain(s);
      });

      it("chains document counters and hashes without a gap", async () => {
        const r = await runFor(company);
        const docs = r
          .rows("einvoice_document")
          .slice()
          .sort((a, b) => Number(a.counter) - Number(b.counter));
        expect(docs.map((d) => Number(d.counter))).toEqual(docs.map((_, i) => i + 1));
        expect(docs[0]!.previous_hash).toBeNull();
        for (let i = 1; i < docs.length; i++)
          expect(docs[i]!.previous_hash, `link ${i}`).toBe(docs[i - 1]!.document_hash);
        // Unique per (channel, counter) and per (channel, idempotency key).
        expect(new Set(docs.map((d) => `${d.channel_id}:${d.counter}`)).size).toBe(docs.length);
        expect(new Set(docs.map((d) => `${d.channel_id}:${d.idempotency_key}`)).size).toBe(
          docs.length,
        );
        // Every document hangs off a distinct invoice.
        expect(new Set(docs.map((d) => d.source_id)).size).toBe(docs.length);
      });

      it("explains a blocked document and leaves the others clean", async () => {
        const r = await runFor(company);
        for (const d of r.rows("einvoice_document")) {
          if (d.status === "blocked_no_credential") {
            expect(d.error_code).toBe("no_credential");
            expect(String(d.error_message)).toMatch(/credential/i);
          } else {
            expect(d.error_code, String(d.status)).toBeNull();
            expect(d.error_message, String(d.status)).toBeNull();
          }
        }
      });

      it("gives every document exactly one local event", async () => {
        const r = await runFor(company);
        const docs = r.rows("einvoice_document");
        const events = r.rows("einvoice_event");
        expect(events.length).toBe(docs.length);
        const byDoc = new Map(docs.map((d) => [String(d.id), d]));
        for (const e of events) {
          expect(byDoc.has(String(e.document_id))).toBe(true);
          expect(e.attempt).toBe(1);
          expect(e.latency_ms, "a latency would imply a network call").toBeNull();
          const detail = e.detail as { message: string; local: boolean };
          expect(detail.local).toBe(true);
          expect(detail.message.length).toBeGreaterThan(0);
          // The event never predates the document it describes.
          expect(ts(e.created_at)).toBeGreaterThanOrEqual(
            ts(byDoc.get(String(e.document_id))!.created_at),
          );
        }
        expect(new Set(events.map((e) => `${e.document_id}:${e.attempt}`)).size).toBe(
          events.length,
        );
      });

      it("writes a privacy register with distinct categories and a basis for every transfer", async () => {
        const r = await runFor(company);
        const rows = r.rows("establishment_privacy");
        expect(rows.length).toBeGreaterThanOrEqual(3);
        expect(new Set(rows.map((p) => p.data_category)).size).toBe(rows.length);
        for (const p of rows) {
          expect(String(p.purpose).length).toBeLessThanOrEqual(500);
          expect(String(p.retention).length).toBeLessThanOrEqual(200);
          if (p.cross_border === true)
            expect(p.transfer_basis, "a cross-border transfer needs a basis").toBeTruthy();
          else expect(p.transfer_basis).toBeNull();
          expect(p.reviewed_by).toBeTruthy();
          expect(ts(p.reviewed_at)).toBeGreaterThanOrEqual(ts(p.created_at));
        }
        // At least one row is honest about staying in-region.
        expect(rows.some((p) => p.cross_border === false)).toBe(true);
      });

      it("builds no documents at all when sales issued no invoices", async () => {
        const r = await runFor(company, { sales: { invoiceIds: [] } });
        expect(r.rows("einvoice_document")).toEqual([]);
        expect(r.rows("einvoice_event")).toEqual([]);
        // The channel and the privacy register still exist — they do not
        // depend on an invoice.
        expect(r.rows("einvoice_channel").length).toBe(1);
        expect(r.rows("establishment_privacy").length).toBeGreaterThan(0);
        expect(r.report.notes?.join(" ")).toMatch(/no e-invoice documents/i);
      });

      it("truncates the plan rather than inventing invoices when sales is short", async () => {
        const r = await runFor(company, {
          sales: {
            invoiceIds: [labId(company.key, "invoice", 0), labId(company.key, "invoice", 1)],
          },
        });
        expect(r.rows("einvoice_document").length).toBe(2);
        expect(r.rows("einvoice_event").length).toBe(2);
        expect(r.plan.einvoice_document).toBe(2);
        expect(r.report.notes?.join(" ")).toMatch(/document states were skipped/i);
      });
    }

    it("survives a missing sales handoff without throwing", async () => {
      const { ctx } = fakeCtx(company);
      // Simulate a run where sales never reported: the family must degrade,
      // not crash, because a crash here would abort the whole company.
      const stripped: LabContext = {
        ...ctx,
        handoff: <T>(family: string) => {
          if (family === "sales") throw new Error("no handoff from family sales");
          return ctx.handoff<T>(family);
        },
      };
      const plan = planCountry(stripped);
      expect(plan.expected.einvoice_document).toBe(0);
      expect(plan.expected.ai_entitlement).toBeGreaterThan(0);
    });
  });
}
