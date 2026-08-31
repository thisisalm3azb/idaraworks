/**
 * The production health checker's safety properties.
 *
 * The checker reads production, so the properties worth testing are the ones
 * that decide WHETHER it reads at all, and whether it can tell a new problem
 * from a known one. Those are pure and testable without a database.
 *
 * What is deliberately not tested here: the SQL results themselves. Asserting
 * that a count query returns a count proves nothing, and the integration suite
 * already proves the schema laws this check reports on.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWN_ORPHAN_IDENTITIES,
  KNOWN_ORPHAN_SESSIONS,
  DELETE_GRANT_EXCEPTION,
  PRODUCTION_APP_URL,
} from "../../tooling/scripts/prod-health";
import {
  PRODUCTION_PROJECT_REF,
  TEST_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../integration/guard-env";

const SOURCE = readFileSync(join(process.cwd(), "tooling", "scripts", "prod-health.ts"), "utf8");

describe("the health checker refuses anything that is not clearly production", () => {
  const prod = `postgresql://postgres.${PRODUCTION_PROJECT_REF}:x@aws-0.pooler.supabase.com:5432/postgres`;
  const test = `postgresql://postgres.${TEST_PROJECT_REF}:x@aws-0.pooler.supabase.com:5432/postgres`;

  it("accepts an environment naming only production", () => {
    const v = targetsOnlyProductionProject({ DIRECT_URL: prod, DATABASE_URL: prod });
    expect(v.ok).toBe(true);
    expect(v.refs).toEqual([PRODUCTION_PROJECT_REF]);
  });

  it("refuses the test project", () => {
    const v = targetsOnlyProductionProject({ DIRECT_URL: test, DATABASE_URL: test });
    expect(v.ok).toBe(false);
  });

  it("refuses an EMPTY environment rather than reading it as production", () => {
    // The important direction: absence must never be mistaken for the target.
    const v = targetsOnlyProductionProject({});
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/no|none|empty|missing/i);
  });

  it("refuses a MIXED environment naming two projects", () => {
    const v = targetsOnlyProductionProject({ DIRECT_URL: prod, DATABASE_URL: test });
    expect(v.ok).toBe(false);
  });

  it("refuses an unknown project reference", () => {
    const other =
      "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:x@aws-0.pooler.supabase.com:5432/postgres";
    const v = targetsOnlyProductionProject({ DIRECT_URL: other, DATABASE_URL: other });
    expect(v.ok).toBe(false);
  });
});

describe("known historical residue is separated from new residue", () => {
  /** The arithmetic the report does, restated so a change to it is deliberate. */
  const above = (actual: number, known: number) => Math.max(0, actual - known);

  it("reports zero new residue at exactly the known floor", () => {
    expect(above(KNOWN_ORPHAN_IDENTITIES, KNOWN_ORPHAN_IDENTITIES)).toBe(0);
    expect(above(KNOWN_ORPHAN_SESSIONS, KNOWN_ORPHAN_SESSIONS)).toBe(0);
  });

  it("reports the excess when residue rises above the floor", () => {
    expect(above(KNOWN_ORPHAN_IDENTITIES + 4, KNOWN_ORPHAN_IDENTITIES)).toBe(4);
    expect(above(KNOWN_ORPHAN_SESSIONS + 1, KNOWN_ORPHAN_SESSIONS)).toBe(1);
  });

  it("never reports negative residue if historical rows are ever cleaned", () => {
    expect(above(0, KNOWN_ORPHAN_IDENTITIES)).toBe(0);
  });

  it("pins the known floor to the documented historical count of 116", () => {
    // 13 identities + 103 sessions. These are retained deliberately; a change
    // here should be a decision, not a drift.
    expect(KNOWN_ORPHAN_IDENTITIES + KNOWN_ORPHAN_SESSIONS).toBe(116);
  });
});

describe("the checker is read-only by construction", () => {
  /**
   * Not a style check. This file is pointed at the live database, so the
   * absence of a write path is the property that makes it safe to run at any
   * time, and it should fail loudly if someone adds one.
   */
  it("issues no statement that could write", () => {
    const body = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const verb of [
      "insert into",
      "update ",
      "delete from",
      "drop ",
      "truncate",
      "alter table",
      "create table",
      "grant ",
      "revoke ",
    ]) {
      expect(body.toLowerCase(), `health check must not contain "${verb}"`).not.toContain(verb);
    }
  });

  it("loads production credentials only from .env.local", () => {
    expect(SOURCE).toContain('config({ path: [".env.local"]');
    expect(SOURCE).not.toContain(".env.test");
  });

  it("probes the server for its database before reading anything else", () => {
    const probe = SOURCE.indexOf("current_database()");
    const firstCount = SOURCE.indexOf("count(*)");
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(firstCount);
  });

  it("names the single permitted DELETE-grant exception", () => {
    expect(DELETE_GRANT_EXCEPTION).toBe("org_holiday_calendar");
  });

  it("checks the real production host", () => {
    expect(PRODUCTION_APP_URL).toBe("https://www.idaraworks.com");
  });
});
