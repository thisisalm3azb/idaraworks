/**
 * The gate that keeps the integration suite off production.
 *
 * This suite creates and deletes organizations. It ran against the live database
 * for months because the config loaded `.env.local`. These tests pin every way
 * production can be recognised, and every way the refusal must not be reachable
 * by accident.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertNotProduction,
  productionReasons,
  ProductionDatabaseRefusal,
  PRODUCTION_PROJECT_REF,
  TEST_PROJECT_REF,
  targetsOnlyTestProject,
  referencedProjectRefs,
  OVERRIDE_VAR,
  OVERRIDE_VALUE,
} from "../integration/guard-env";

const REF = PRODUCTION_PROJECT_REF;

/** What `supabase start` gives you: safe. */
const LOCAL = {
  DIRECT_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

describe("integration environment guard", () => {
  it("lets the local Supabase stack through", () => {
    expect(productionReasons(LOCAL)).toEqual([]);
    expect(() => assertNotProduction(LOCAL)).not.toThrow();
  });

  it("lets a different hosted project through", () => {
    const other = {
      DIRECT_URL: `postgresql://postgres.abcdefghijklmnopqrst:pw@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`,
      DATABASE_URL: "postgresql://postgres.abcdefghijklmnopqrst:pw@host:6543/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      NEXT_PUBLIC_APP_URL: "https://staging.idaraworks.com",
    };
    expect(productionReasons(other)).toEqual([]);
  });

  it("recognises production by the Supabase project URL", () => {
    const reasons = productionReasons({
      ...LOCAL,
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("recognises production inside a pooler connection string", () => {
    // The project ref rides in the USERNAME on pooler URLs, not the host.
    const url = `postgresql://postgres.${REF}:secret@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres`;
    expect(productionReasons({ ...LOCAL, DIRECT_URL: url })[0]).toContain("DIRECT_URL");
    expect(productionReasons({ ...LOCAL, DATABASE_URL: url })[0]).toContain("DATABASE_URL");
  });

  it("recognises the production application by host", () => {
    for (const url of [
      "https://www.idaraworks.com",
      "https://idaraworks.com",
      "https://WWW.IDARAWORKS.COM/",
      "www.idaraworks.com",
    ]) {
      const reasons = productionReasons({ ...LOCAL, NEXT_PUBLIC_APP_URL: url });
      expect(reasons.length, `${url} should be recognised`).toBeGreaterThan(0);
    }
    // A staging subdomain is not production.
    expect(
      productionReasons({ ...LOCAL, NEXT_PUBLIC_APP_URL: "https://staging.idaraworks.com" }),
    ).toEqual([]);
  });

  it("reports EVERY reason, not just the first", () => {
    const reasons = productionReasons({
      DIRECT_URL: `postgresql://postgres.${REF}:x@pooler:5432/postgres`,
      DATABASE_URL: `postgresql://postgres.${REF}:x@pooler:6543/postgres`,
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
      NEXT_PUBLIC_APP_URL: "https://www.idaraworks.com",
    });
    expect(reasons).toHaveLength(4);
  });

  it("throws a refusal that says what to do instead", () => {
    let err: unknown;
    try {
      assertNotProduction({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProductionDatabaseRefusal);
    const message = (err as Error).message;
    expect(message).toContain("Refusing to run the integration suite against PRODUCTION");
    expect(message).toContain("supabase start");
    expect(message).toContain(".env.test.local");
  });

  it("cannot be bypassed by a casual or truthy value", () => {
    const prod = { ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };
    for (const attempt of ["1", "true", "yes", "YES", "please", OVERRIDE_VALUE.toUpperCase(), ""]) {
      expect(
        () => assertNotProduction({ ...prod, [OVERRIDE_VAR]: attempt }),
        `"${attempt}" must not open the gate`,
      ).toThrow(ProductionDatabaseRefusal);
    }
  });

  it("opens only for the exact phrase, which names the project it will damage", () => {
    const prod = { ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };
    expect(() => assertNotProduction({ ...prod, [OVERRIDE_VAR]: OVERRIDE_VALUE })).not.toThrow();
    expect(OVERRIDE_VALUE).toContain(REF);
    expect(OVERRIDE_VAR).toMatch(/PRODUCTION/);
  });

  it("an empty environment is not mistaken for production", () => {
    // Missing credentials are requireIntegrationEnv's job to report, with its
    // own message. The guard must not mask that with a confusing refusal.
    expect(productionReasons({})).toEqual([]);
  });
});

describe("the target project is confirmed, not merely 'not production'", () => {
  const testRef = TEST_PROJECT_REF;
  const filled = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${testRef}.supabase.co`,
    DIRECT_URL: `postgresql://postgres.${testRef}:pw@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
    DATABASE_URL: `postgresql://postgres.${testRef}:pw@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres`,
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  };

  it("accepts an environment that points only at idaraworks-test", () => {
    const r = targetsOnlyTestProject(filled);
    expect(r.ok).toBe(true);
    expect(r.refs).toEqual([testRef]);
    expect(r.problems).toEqual([]);
    expect(productionReasons(filled)).toEqual([]);
  });

  it("finds the reference in a pooler username as well as an API host", () => {
    expect(
      referencedProjectRefs({ NEXT_PUBLIC_SUPABASE_URL: `https://${testRef}.supabase.co` }),
    ).toEqual([testRef]);
    expect(
      referencedProjectRefs({ DIRECT_URL: `postgresql://postgres.${testRef}:x@h:5432/postgres` }),
    ).toEqual([testRef]);
  });

  it("rejects a half-edited file that still names production anywhere", () => {
    const mixed = { ...filled, DATABASE_URL: `postgresql://postgres.${REF}:x@h:6543/postgres` };
    const r = targetsOnlyTestProject(mixed);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("PRODUCTION"))).toBe(true);
    expect(r.problems.some((p) => p.includes("more than one project"))).toBe(true);
    // And the refusal fires independently.
    expect(() => assertNotProduction(mixed)).toThrow(ProductionDatabaseRefusal);
  });

  it("rejects a third project that is neither test nor production", () => {
    const other = {
      ...filled,
      NEXT_PUBLIC_SUPABASE_URL: "https://qrstuvwxyzabcdefghij.supabase.co",
    };
    const r = targetsOnlyTestProject(other);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("unknown project"))).toBe(true);
  });

  it("rejects an unfilled file rather than treating blank as safe", () => {
    const r = targetsOnlyTestProject({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("no Supabase project reference");
  });

  it("the test project is not the production project", () => {
    expect(TEST_PROJECT_REF).not.toBe(PRODUCTION_PROJECT_REF);
  });
});

describe("integration wiring cannot silently load production credentials", () => {
  it("the integration config loads the test env, never .env.local", () => {
    const cfg = readFileSync("vitest.integration.config.ts", "utf8");
    expect(cfg).toContain("load-env-integration");
    expect(cfg).not.toContain('"tooling/scripts/load-env.ts"');
  });

  it("the integration env loader never reads .env.local", () => {
    const loader = readFileSync("tooling/scripts/load-env-integration.ts", "utf8");
    expect(loader).toMatch(/\.env\.test\.local/);
    // The whole point: production secrets are not on this path.
    expect(loader).not.toMatch(/config\([^)]*"\.env\.local"/s);
  });

  it("global setup refuses production before it migrates or connects", () => {
    const setup = readFileSync("tests/integration/setup.global.ts", "utf8");
    const guardAt = setup.indexOf("assertNotProduction()");
    const migrateAt = setup.indexOf("runMigrations()");
    expect(guardAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(migrateAt);
  });
});
