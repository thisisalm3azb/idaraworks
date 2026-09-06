/**
 * H33 — the laws the Pilot Lab framework must keep, pinned without a database.
 *
 * The guard is the whole safety story: every tool in tooling/pilot-lab opens a
 * connection only after it says yes. So the guard is tested the way a guard
 * should be — by trying to get past it.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertLabEnv,
  projectRefOf,
  TEST_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
} from "../../tooling/pilot-lab/guard";
import { id, ref } from "../../tooling/pilot-lab/ids";
import {
  isLabMarker,
  makeMarker,
  EMAIL_DOMAIN,
  SEED_VERSION,
} from "../../tooling/pilot-lab/marker";
import { cleanupPhrase } from "../../tooling/pilot-lab/manifest";
import { COMPANIES, personaEmail } from "../../tooling/pilot-lab/companies";
import { FAMILIES } from "../../tooling/pilot-lab/families";
import { orderedFamilies } from "../../tooling/pilot-lab/run";
import {
  taxNo,
  iban,
  phone,
  email,
  spreadDates,
  historyDays,
} from "../../tooling/pilot-lab/families/_shared";
import { Rng } from "../../tooling/simulation/rng";

const TEST_URL = `postgresql://postgres.${TEST_PROJECT_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`;
const PROD_URL = `postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres`;

function goodEnv(): Record<string, string> {
  return {
    DIRECT_URL: TEST_URL,
    DATABASE_URL: TEST_URL,
    NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_PROJECT_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test",
    APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    APP_ENV: "test",
  };
}

describe("the guard refuses everything but the test project", () => {
  it("accepts a complete test environment and names the ref", () => {
    expect(assertLabEnv(goodEnv()).ref).toBe(TEST_PROJECT_REF);
  });

  it("refuses a production DIRECT_URL even when everything else is the test project", () => {
    expect(() => assertLabEnv({ ...goodEnv(), DIRECT_URL: PROD_URL })).toThrow(/PRODUCTION/);
  });

  it("refuses a production API URL", () => {
    expect(() =>
      assertLabEnv({
        ...goodEnv(),
        NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      }),
    ).toThrow(/PRODUCTION/);
  });

  it("refuses an unknown project — not just production", () => {
    expect(() =>
      assertLabEnv({
        ...goodEnv(),
        DIRECT_URL: TEST_URL.replace(TEST_PROJECT_REF, "abcdefghijklmnopqrst"),
      }),
    ).toThrow(/does not point at the test project/);
  });

  it("refuses a production app host in either URL variable", () => {
    expect(() => assertLabEnv({ ...goodEnv(), APP_URL: "https://www.idaraworks.com" })).toThrow(
      /production host/,
    );
    expect(() =>
      assertLabEnv({ ...goodEnv(), NEXT_PUBLIC_APP_URL: "https://idaraworks.vercel.app" }),
    ).toThrow(/production host/);
  });

  it("refuses APP_ENV=prod", () => {
    expect(() => assertLabEnv({ ...goodEnv(), APP_ENV: "prod" })).toThrow(/APP_ENV is prod/);
  });

  it("refuses when any variable at all mentions the production ref", () => {
    expect(() =>
      assertLabEnv({ ...goodEnv(), SOMETHING_ELSE: `x-${PRODUCTION_PROJECT_REF}-y` }),
    ).toThrow(/mentions the production project ref/);
  });

  it("refuses a missing service-role key (the launcher needs it and must not guess)", () => {
    const e = goodEnv();
    delete (e as Record<string, string | undefined>).SUPABASE_SERVICE_ROLE_KEY;
    expect(() => assertLabEnv(e)).toThrow(/SERVICE_ROLE/);
  });

  it("reads project refs from pooler DSNs, API URLs and direct hosts", () => {
    expect(projectRefOf(TEST_URL)).toBe(TEST_PROJECT_REF);
    expect(projectRefOf(`https://${TEST_PROJECT_REF}.supabase.co`)).toBe(TEST_PROJECT_REF);
    expect(
      projectRefOf(`postgresql://postgres:pw@db.${TEST_PROJECT_REF}.supabase.co:5432/postgres`),
    ).toBe(TEST_PROJECT_REF);
    expect(projectRefOf("postgresql://localhost/x")).toBeNull();
  });
});

describe("identity is deterministic and versioned", () => {
  it("the same coordinates give the same id, every time", () => {
    expect(id("gulfbuild", "customer", 17)).toBe(id("gulfbuild", "customer", 17));
  });
  it("different companies, families or ordinals never collide", () => {
    const a = id("gulfbuild", "customer", 17);
    expect(id("tradeline", "customer", 17)).not.toBe(a);
    expect(id("gulfbuild", "supplier", 17)).not.toBe(a);
    expect(id("gulfbuild", "customer", 18)).not.toBe(a);
  });
  it("ids are valid v5 uuids", () => {
    expect(id("x", "y", 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("references pad and prefix", () => {
    expect(ref("INV", 123)).toBe("INV-000123");
  });
});

describe("the marker and the cleanup phrase", () => {
  it("recognises exactly its own marker, as object or JSON string", () => {
    const m = makeMarker("gulfbuild", "2026-09-05T00:00:00Z");
    expect(isLabMarker(m)).toBe(true);
    expect(isLabMarker(JSON.stringify(m))).toBe(true);
    expect(isLabMarker({ is_demo: true, scenario: "coffee_catering" })).toBe(false);
    expect(isLabMarker({ is_test_fixture: true })).toBe(false);
    expect(isLabMarker(null)).toBe(false);
  });
  it("the cleanup phrase names the project and the operation", () => {
    expect(cleanupPhrase(TEST_PROJECT_REF)).toBe(
      `delete-the-five-h33-companies-in-${TEST_PROJECT_REF}`,
    );
    expect(cleanupPhrase(TEST_PROJECT_REF)).not.toContain(PRODUCTION_PROJECT_REF);
  });
});

describe("the five companies", () => {
  it("are exactly five, with unique keys, and nine personas each", () => {
    expect(COMPANIES).toHaveLength(5);
    expect(new Set(COMPANIES.map((c) => c.key)).size).toBe(5);
    for (const c of COMPANIES) {
      expect(c.personas, c.key).toHaveLength(9);
      expect(new Set(c.personas.map((p) => p.key)).size).toBe(9);
      expect(c.personas.find((p) => p.key === "owner")?.roleKey).toBe("owner");
    }
  });
  it("every login is under the reserved .invalid domain", () => {
    for (const c of COMPANIES)
      for (const p of c.personas)
        expect(personaEmail(c.key, p.key)).toMatch(
          new RegExp(`@${EMAIL_DOMAIN.replace(".", "\\.")}$`),
        );
    expect(EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });
  it("names are fictional and bilingual, and no company name reuses a real customer's", () => {
    for (const c of COMPANIES) {
      expect(c.nameAr).toMatch(/[؀-ۿ]/);
      expect(c.legalNameEn).toContain("fictional");
      expect(c.nameEn.toLowerCase()).not.toContain("najolatech");
    }
  });
  it("history covers at least two years for every company", () => {
    for (const c of COMPANIES) expect(historyDays(c), c.key).toBeGreaterThanOrEqual(730);
  });
  it("at least one company crosses 1,205 on every major paginated family", () => {
    const max = (k: keyof (typeof COMPANIES)[0]["profile"]) =>
      Math.max(...COMPANIES.map((c) => c.profile[k] as number));
    for (const k of [
      "customers",
      "items",
      "jobs",
      "leads",
      "opportunities",
      "quotes",
      "invoices",
      "purchaseOrders",
    ] as const) {
      expect(max(k), k).toBeGreaterThan(1205);
    }
  });
});

describe("fake identifiers cannot be mistaken for real ones", () => {
  const ae = COMPANIES.find((c) => c.country === "AE")!;
  const sa = COMPANIES.find((c) => c.country === "SA")!;
  it("UAE tax numbers start with an impossible prefix and Saudi ones too", () => {
    expect(taxNo(ae, 1)).toMatch(/^1999\d{11}$/);
    expect(taxNo(sa, 1)).toMatch(/^399999\d{9}$/);
  });
  it("IBANs carry zero bank codes and zero check digits", () => {
    expect(iban(ae, 1)).toMatch(/^AE00 0000 /);
    expect(iban(sa, 1)).toMatch(/^SA00 0000 /);
  });
  it("phones sit in the unallocated 000 0 block; emails end in .invalid", () => {
    expect(phone(ae, 42)).toMatch(/^\+971 50 000 \d{4}$/);
    expect(phone(sa, 42)).toMatch(/^\+966 50 000 \d{4}$/);
    expect(email("Ahmed Haddad", 3)).toMatch(/@example\.invalid$/);
  });
});

describe("dates spread deterministically across the history", () => {
  it("gives the same spread for the same seed and stays inside the history", () => {
    const c = COMPANIES[0]!;
    const a = spreadDates(new Rng("s"), c, 500);
    const b = spreadDates(new Rng("s"), c, 500);
    expect(a).toEqual(b);
    expect(Math.max(...a)).toBeLessThanOrEqual(historyDays(c));
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
  });
});

describe("the family registry", () => {
  it("the registry is either empty or complete — never half-registered", () => {
    /*
     * A family with a file but no registration never runs, and its absence is
     * silent: the seed simply writes fewer rows and nothing complains. That is
     * the hazard worth catching.
     *
     * The registry is deliberately empty while the families are being built —
     * all fifteen are registered at once, only after every one is type-clean and
     * tested — so an empty registry is a legal state. A PARTIAL one is not.
     */
    const files = readdirSync("tooling/pilot-lab/families")
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    const registered = FAMILIES.map((f) => f.key).sort();
    if (registered.length === 0) {
      expect(files.length, "families exist but none is registered yet").toBeGreaterThan(0);
      return;
    }
    expect(registered).toEqual(files);
  });
  it("dependencies resolve without cycles", () => {
    expect(() => orderedFamilies(FAMILIES)).not.toThrow();
    const order = orderedFamilies(FAMILIES).map((f) => f.key);
    for (const f of FAMILIES)
      for (const d of f.deps)
        expect(order.indexOf(d), `${d} before ${f.key}`).toBeLessThan(order.indexOf(f.key));
  });
  it(`seed version is ${SEED_VERSION}`, () => {
    expect(SEED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
