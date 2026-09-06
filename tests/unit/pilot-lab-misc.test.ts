/**
 * H33 Pilot Lab — the cross-cutting family, checked without a database.
 *
 * `misc.seed()` resolves its targets by querying the tenant, so the unit test
 * exercises the pure half instead: `miscSizes` → `expectedOf` → `buildMisc`,
 * given targets handed in directly. That is the half where the mistakes live —
 * a plan that does not match the build, a notification aimed at a record that
 * does not exist, an exception that is both open and resolved.
 *
 * The storage objects get their own attention: they are REAL bytes uploaded to
 * a real bucket, so a malformed PNG or PDF would be a file a pilot cannot open.
 * The tests below parse both formats back rather than trusting the length.
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { COMPANIES } from "../../tooling/pilot-lab/companies";
import type { Company, LabContext, PersonaKey } from "../../tooling/pilot-lab/types";
import { id as labId } from "../../tooling/pilot-lab/ids";
import { SEED_VERSION } from "../../tooling/pilot-lab/marker";
import { Rng } from "../../tooling/simulation/rng";
import { SimClock } from "../../tooling/simulation/dates";
import {
  misc,
  buildMisc,
  miscSizes,
  expectedOf,
  digestDates,
  holidayEntries,
  tinyPng,
  tinyPdf,
  MISC_RULE_KEYS,
  SIGN_IN_EVENTS,
  type MiscTargets,
  type TargetRef,
} from "../../tooling/pilot-lab/families/misc";

type Row = Record<string, unknown>;

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

function refs(company: Company, kind: string, n: number, withCustomer = false): TargetRef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: labId(company.key, kind, i),
    label: `${kind.toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
    name: `${kind} ${i + 1}`,
    customerId: withCustomer ? labId(company.key, "customer", i % 10) : null,
  }));
}

function targetsFor(company: Company): MiscTargets {
  const p = company.profile;
  return {
    jobs: refs(company, "job", Math.min(p.jobs, 300), true),
    invoices: refs(company, "invoice", Math.min(p.invoices, 300), true),
    customers: refs(company, "customer", Math.min(p.customers, 120)),
    employees: refs(company, "employee", Math.min(p.employees, 120)),
    documents: refs(company, "doc_document", Math.min(p.documents, 300), true),
    opportunities: refs(company, "opportunity", Math.min(p.opportunities, 200), true),
    leads: refs(company, "lead", Math.min(p.leads, 200)),
    approvals: refs(company, "approval", 40),
    purchaseOrders: refs(company, "purchase_order", Math.min(p.purchaseOrders, 200)),
    suppliers: refs(company, "supplier", Math.min(p.suppliers, 60)),
  };
}

function fakeCtx(company: Company) {
  const orgId = labId(company.key, "org");
  const users = Object.fromEntries(
    PERSONAS.map((p) => [p, labId(company.key, "user", p)]),
  ) as Record<PersonaKey, string>;
  const noDb = () => {
    throw new Error("the unit test has no database");
  };
  return {
    sql: noDb as unknown as LabContext["sql"],
    admin: {} as unknown as LabContext["admin"],
    company,
    orgId,
    users,
    employees: {},
    ctxFor: (persona: PersonaKey) => ({
      orgId,
      userId: users[persona],
      costPrivileged: true,
      pricePrivileged: true,
      requestId: `test-${company.key}-${persona}`,
    }),
    archetypeOf: (persona: PersonaKey) =>
      company.personas.find((p) => p.key === persona)!.archetype,
    rng: new Rng(`h33:${SEED_VERSION}:${company.key}`),
    clock: new SimClock(company.history.asOf),
    id: (family: string, ...ordinal: Array<string | number>) =>
      labId(company.key, family, ...ordinal),
    insert: async () => ({ attempted: 0, inserted: 0 }),
    // Grouped writes are one transaction live; in memory the tables are
    // simply written in the order given.
    insertGroup: async (entries: Array<{ table: string; rows: Row[]; conflict?: string }>) => {
      const out: Record<string, { attempted: number; inserted: number }> = {};
      for (const e of entries) out[e.table] = { attempted: e.rows.length, inserted: 0 };
      return out;
    },
    handoff: () => {
      throw new Error("no handoff in this unit test");
    },
    log: () => {},
    dryRun: true,
  } as unknown as LabContext;
}

const ts = (v: unknown) => Date.parse(String(v));
const asOf = (c: Company) => Date.parse(`${c.history.asOf}T23:59:59.999Z`);

describe("the misc family", () => {
  it("is declared correctly and applies everywhere", () => {
    expect(misc.key).toBe("misc");
    expect(misc.deps).toEqual(
      expect.arrayContaining(["setup", "people", "masters", "work", "sales"]),
    );
    for (const c of COMPANIES) expect(misc.appliesTo(c)).toBe(true);
  });

  it("writes a PNG a viewer can actually decode", () => {
    const png = tinyPng(
      8,
      6,
      [
        [255, 0, 0],
        [0, 128, 255],
      ],
      "Pilot Lab",
    );
    // Signature, then IHDR with the dimensions we asked for, then IEND last.
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(8);
    expect(png.readUInt32BE(20)).toBe(6);
    expect(png.subarray(png.length - 8, png.length - 4).toString("latin1")).toBe("IEND");
    // Every chunk's CRC covers its own type and data; walking the file proves
    // the lengths line up rather than merely that it starts like a PNG.
    let at = 8;
    const seen: string[] = [];
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString("latin1");
      seen.push(type);
      at += 12 + len;
    }
    expect(at).toBe(png.length);
    expect(seen[0]).toBe("IHDR");
    expect(seen[seen.length - 1]).toBe("IEND");
    expect(seen).toContain("IDAT");
    // Deterministic: the same request twice gives the same bytes.
    expect(
      tinyPng(
        8,
        6,
        [
          [255, 0, 0],
          [0, 128, 255],
        ],
        "Pilot Lab",
      ).equals(png),
    ).toBe(true);
  });

  it("writes a PDF a reader can actually open", () => {
    const pdf = tinyPdf(["Pilot Lab", "fictional document"]);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = pdf.toString("latin1");
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("trailer");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // The cross-reference offset at the end points inside the file.
    const idx = text.lastIndexOf("startxref");
    const offset = Number(
      text
        .slice(idx + 9)
        .trim()
        .split(/\s+/)[0],
    );
    expect(Number.isFinite(offset)).toBe(true);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(pdf.length);
    expect(text.slice(offset, offset + 4)).toBe("xref");
  });

  it("names only exception rules the product knows", () => {
    expect(MISC_RULE_KEYS.length).toBeGreaterThan(3);
    for (const k of MISC_RULE_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_.]*$/);
    expect(new Set(MISC_RULE_KEYS).size).toBe(MISC_RULE_KEYS.length);
    for (const e of SIGN_IN_EVENTS) expect(typeof e).toBe("string");
  });
});

for (const company of COMPANIES) {
  const clock = new SimClock(company.history.asOf);

  describe(`misc for ${company.key}`, () => {
    it("sizes itself the same way twice", () => {
      const a = miscSizes(company, clock);
      const b = miscSizes(company, clock);
      expect(a).toEqual(b);
      for (const [k, v] of Object.entries(a)) {
        expect(Number.isInteger(v), k).toBe(true);
        expect(v, k).toBeGreaterThanOrEqual(0);
      }
      // The service subsets never exceed what they draw from.
      expect(a.dismissTarget).toBeLessThanOrEqual(a.exception);
      expect(a.sendTarget).toBeLessThanOrEqual(a.customerUpdate);
      expect(a.preference).toBe(company.personas.length);
    });

    it("builds exactly the rows the plan promises", () => {
      const ctx = fakeCtx(company);
      const b = buildMisc(ctx, targetsFor(company));
      const expected = expectedOf(miscSizes(company, clock));
      expect(b.notifications.length).toBe(expected.notification);
      expect(b.preferences.length).toBe(expected.notification_preference);
      expect(b.activities.length).toBe(expected.activity);
      expect(b.comments.length).toBe(expected.comment);
      expect(b.exceptions.length).toBe(expected.exception);
      expect(b.digests.length).toBe(expected.digest);
      expect(b.importBatch.length).toBe(expected.import_batch);
      expect(b.importRows.length).toBe(expected.import_row);
      expect(b.files.length).toBe(expected.file);
      expect(b.customerUpdates.length).toBe(expected.customer_update);
      expect(b.signIns.length).toBe(expected.sign_in_log);
      expect(b.usage.length).toBe(expected.usage_event);
      expect(b.holidays.length).toBe(expected.org_holiday_calendar);
    });

    it("is deterministic", () => {
      const a = buildMisc(fakeCtx(company), targetsFor(company));
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      for (const k of ["notifications", "activities", "exceptions", "files"] as const)
        expect((a[k] as Row[]).map((r) => r.id)).toEqual((b[k] as Row[]).map((r) => r.id));
      expect(a.myBytes).toBe(b.myBytes);
    });

    it("carries org_id on every row and never repeats an id", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const orgId = labId(company.key, "org");
      const seen = new Set<string>();
      for (const [name, rows] of Object.entries(b)) {
        if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== "object") continue;
        for (const row of rows as Row[]) {
          if (!("org_id" in row)) continue;
          expect(row.org_id, name).toBe(orgId);
          if (row.id === undefined) continue;
          const id = String(row.id);
          expect(seen.has(id), `${name} ${id}`).toBe(false);
          seen.add(id);
        }
      }
    });

    it("dates everything in the past", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const limit = asOf(company);
      const futureOk = new Set(["ends_on", "snoozed_until", "expires_at"]);
      for (const [name, rows] of Object.entries(b)) {
        if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== "object") continue;
        for (const row of rows as Row[])
          for (const [k, v] of Object.entries(row)) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
            if (!/_(at|on)$/.test(k) || futureOk.has(k)) continue;
            expect(ts(v), `${name}.${k} = ${v}`).toBeLessThanOrEqual(limit);
          }
      }
    });

    it("gives every persona a notification preference and no more", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const users = b.preferences.map((p) => String(p.user_id));
      expect(new Set(users).size).toBe(users.length);
      expect(users.length).toBe(company.personas.length);
    });

    it("leaves an exception either open or resolved, never both", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      expect(b.exceptions.length).toBeGreaterThan(0);
      // The engine has no status column: an exception is open exactly while
      // it has no resolved_at, and a resolution names how it cleared.
      const resolutions = new Set<string>();
      let open = 0;
      for (const e of b.exceptions) {
        if (e.resolved_at === null) {
          open++;
          expect(e.resolution, String(e.id)).toBeNull();
        } else {
          expect(e.resolution, String(e.id)).toBeTruthy();
          resolutions.add(String(e.resolution));
          expect(ts(e.resolved_at)).toBeGreaterThanOrEqual(ts(e.raised_at));
        }
        expect(MISC_RULE_KEYS as readonly string[]).toContain(String(e.rule_key));
        expect(String(e.dedup_key).length).toBeGreaterThan(0);
      }
      // Both an open queue and a history of cleared ones, cleared both ways.
      expect(open, "the queue has something in it").toBeGreaterThan(0);
      expect(open).toBeLessThan(b.exceptions.length);
      expect(resolutions.size, "auto-cleared and actioned both appear").toBeGreaterThan(1);
      // dedup_key is what stops the engine raising the same thing twice.
      const keys = b.exceptions.map((e) => String(e.dedup_key));
      expect(new Set(keys).size).toBe(keys.length);
      // The dismissal sample only names exceptions that are still open.
      const openIds = new Set(
        b.exceptions.filter((e) => e.resolved_at === null).map((e) => String(e.id)),
      );
      for (const d of b.dismiss) expect(openIds.has(d.id), d.id).toBe(true);
    });

    it("sends only drafts through the service", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const drafts = new Set(
        b.customerUpdates.filter((u) => u.status === "draft").map((u) => String(u.id)),
      );
      for (const s of b.send) expect(drafts.has(s.id), s.id).toBe(true);
      expect(b.send.length).toBeLessThanOrEqual(drafts.size);
    });

    it("points every notification, activity and comment at a record it was given", () => {
      const t = targetsFor(company);
      const b = buildMisc(fakeCtx(company), t);
      /*
       * Only the entity types this test actually supplied targets for: misc
       * also points at records of its own making and at types resolveTargets
       * fetches that are not in this fixture.
       */
      const pools: Record<string, TargetRef[]> = {
        job: t.jobs,
        invoice: t.invoices,
        customer: t.customers,
        employee: t.employees,
        document: t.documents,
        opportunity: t.opportunities,
        lead: t.leads,
        approval: t.approvals,
        purchase_order: t.purchaseOrders,
        supplier: t.suppliers,
      };
      const known: Record<string, Set<string>> = {};
      for (const [k, v] of Object.entries(pools)) known[k] = new Set(v.map((r) => r.id));
      const orphan = (rows: Row[]) => {
        const bad: string[] = [];
        for (const r of rows) {
          const type = typeof r.entity_type === "string" ? r.entity_type : null;
          const id = r.entity_id;
          if (!type || typeof id !== "string" || !id) continue;
          const pool = known[type];
          if (pool && !pool.has(id)) bad.push(type + ":" + id);
        }
        return bad;
      };
      expect(orphan(b.notifications).slice(0, 3)).toEqual([]);
      expect(orphan(b.activities).slice(0, 3)).toEqual([]);
      expect(orphan(b.comments).slice(0, 3)).toEqual([]);
      // And the check is not vacuous: it really did inspect known types.
      const checked = b.activities.filter(
        (a) => typeof a.entity_type === "string" && known[a.entity_type],
      );
      expect(checked.length).toBeGreaterThan(0);
    });

    it("accounts for the bytes it will upload, file row by file row", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      expect(b.files.length).toBe(15);
      expect(b.objects.length).toBe(b.files.length);
      const byPath = new Map(b.objects.map((o) => [o.path, o]));
      let bytes = 0;
      for (const f of b.files) {
        const key = String(f.object_path);
        const obj = byPath.get(key);
        expect(obj, `no object for ${key}`).toBeDefined();
        // The row's size is the object's real length, not an estimate — the
        // storage meter is built from these numbers.
        expect(Number(f.bytes), key).toBe(obj!.body.length);
        // A file that is ready holds no reservation: the bytes are counted,
        // not pending.
        expect(f.status, key).toBe("ready");
        expect(Number(f.reserved_bytes), key).toBe(0);
        expect(f.voided_at, key).toBeNull();
        expect(String(f.mime), key).toBe(obj!.mime);
        bytes += obj!.body.length;
      }
      // And the usage figure is the sum, so the storage meter tells the truth.
      expect(b.myBytes).toBe(bytes);
      // Paths are unique: an overwrite would silently lose a file.
      expect(new Set(b.objects.map((o) => `${o.bucket}/${o.path}`)).size).toBe(b.objects.length);
      // Real bytes, in a format that opens: every object is a PNG or a PDF.
      for (const o of b.objects) {
        expect(o.body.length).toBeGreaterThan(0);
        const head = o.body.subarray(0, 5).toString("latin1");
        expect(head === "%PDF-" || o.body[0] === 0x89, o.path).toBe(true);
      }
    });

    it("imports a batch whose rows add up to its own totals", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const batch = b.importBatch[0]!;
      expect(b.importRows.length).toBeGreaterThan(0);
      for (const r of b.importRows) expect(r.batch_id).toBe(batch.id);
      const applied = b.importRows.filter((r) => r.status === "applied").length;
      const invalid = b.importRows.filter((r) => r.status === "invalid").length;
      const skipped = b.importRows.filter((r) => r.status === "skipped").length;
      // A clean import teaches nothing: some rows must have been rejected.
      expect(invalid + skipped, "nothing was rejected").toBeGreaterThan(0);
      expect(applied + invalid + skipped).toBe(b.importRows.length);
      expect(Number(batch.row_count)).toBe(b.importRows.length);
      expect(Number(batch.applied_count)).toBe(applied);
      expect(Number(batch.error_count)).toBe(invalid);
      // A rejected row says why; an applied one names what it created.
      for (const r of b.importRows) {
        if (r.status === "applied") expect(r.error, String(r.id)).toBeNull();
        else expect(r.error, String(r.id)).toBeTruthy();
      }
      // Row numbers are unique and gapless within the batch.
      const nos = b.importRows.map((r) => Number(r.row_number)).sort((x, y) => x - y);
      expect(new Set(nos).size).toBe(nos.length);
      expect(nos[0]).toBe(1);
      expect(nos[nos.length - 1]).toBe(nos.length);
    });

    it("closes the organisation only on dates that make sense", () => {
      const entries = holidayEntries(company);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.starts_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (e.ends_on !== null) expect(e.ends_on >= e.starts_on, e.label.en).toBe(true);
        expect(e.label.en.length).toBeGreaterThan(0);
        expect(e.label.ar.length).toBeGreaterThan(0);
      }
      // No two closures start on the same day with the same label.
      const keys = entries.map((e) => `${e.starts_on}|${e.label.en}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("posts a digest on working mornings, most recent fortnight first", () => {
      const dates = digestDates(company, clock);
      expect(dates.length).toBeGreaterThan(10);
      expect(new Set(dates).size).toBe(dates.length);
      expect([...dates].sort()).toEqual(dates);
      for (const d of dates) {
        expect(d <= company.history.asOf, d).toBe(true);
        const day = new Date(`${d}T00:00:00Z`).getUTCDay();
        // Friday is never a working morning; Saturday only where the company
        // works a six-day week.
        expect(day, `${d} is a Friday`).not.toBe(5);
        if (!company.sixDayWeek) expect(day, `${d} is a Saturday`).not.toBe(6);
      }
    });

    it("records sign-ins for real personas with plausible outcomes", () => {
      const b = buildMisc(fakeCtx(company), targetsFor(company));
      const userIds = new Set(Object.values(fakeCtx(company).users));
      expect(b.signIns.length).toBeGreaterThan(0);
      for (const s of b.signIns) {
        if (s.user_id !== null && s.user_id !== undefined)
          expect(userIds.has(String(s.user_id)), String(s.id)).toBe(true);
        expect(SIGN_IN_EVENTS as readonly string[]).toContain(String(s.event));
      }
      // A failure or two, so the security log is not uniformly clean.
      expect(new Set(b.signIns.map((s) => String(s.event))).size).toBeGreaterThan(1);
    });
  });
}
