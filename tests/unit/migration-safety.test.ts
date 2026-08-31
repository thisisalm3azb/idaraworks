/**
 * H22.0 Part B — which database a migration command may touch.
 *
 * `db:migrate` loads `.env.local` and applies whatever it finds, so a mistyped
 * command changes production silently. These tests pin the rules that make the
 * two explicit paths safe: each must POSITIVELY identify its target, refuse a
 * mixed or unknown or empty environment, and — for production — refuse without
 * a confirmation phrase that cannot be left lying around in a shell.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  TEST_PROJECT_REF,
  productionMigrationPhrase,
  targetsOnlyProject,
  targetsOnlyProductionProject,
  targetsOnlyTestProject,
} from "../integration/guard-env";

const envFor = (ref: string) => ({
  NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  DIRECT_URL: `postgresql://postgres.${ref}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  DATABASE_URL: `postgresql://postgres.${ref}:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
});

const PROD = envFor(PRODUCTION_PROJECT_REF);
const TEST = envFor(TEST_PROJECT_REF);
const UNKNOWN = envFor("qrstuvwxyzabcdefghij");

describe("a migration path identifies its target positively", () => {
  it("production config: only the production path accepts it", () => {
    expect(targetsOnlyProductionProject(PROD).ok).toBe(true);
    expect(targetsOnlyTestProject(PROD).ok).toBe(false);
    expect(targetsOnlyTestProject(PROD).problems.join(" ")).toContain("PRODUCTION");
  });

  it("test config: only the test path accepts it", () => {
    expect(targetsOnlyTestProject(TEST).ok).toBe(true);
    expect(targetsOnlyProductionProject(TEST).ok).toBe(false);
    expect(targetsOnlyProductionProject(TEST).problems.join(" ")).toContain("TEST");
  });

  it("unknown project: BOTH paths refuse", () => {
    expect(targetsOnlyProductionProject(UNKNOWN).ok).toBe(false);
    expect(targetsOnlyTestProject(UNKNOWN).ok).toBe(false);
    for (const v of [targetsOnlyProductionProject(UNKNOWN), targetsOnlyTestProject(UNKNOWN)]) {
      expect(v.problems.join(" ")).toContain("unknown project");
    }
  });

  it("mixed config: refused by both, naming every project it saw", () => {
    const mixed = { ...PROD, DATABASE_URL: TEST.DATABASE_URL };
    for (const v of [targetsOnlyProductionProject(mixed), targetsOnlyTestProject(mixed)]) {
      expect(v.ok).toBe(false);
      expect(v.problems.some((p) => p.includes("more than one project"))).toBe(true);
      expect(v.refs).toHaveLength(2);
    }
  });

  it("empty config is never mistaken for production", () => {
    // The dangerous failure mode: an unfilled environment reading as "not a
    // test project, therefore production". It must read as nothing at all.
    const v = targetsOnlyProductionProject({});
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("no Supabase project reference");
    expect(v.refs).toEqual([]);
  });

  it("incomplete config: an API URL alone is not a migration target", () => {
    // DIRECT_URL is what migrations actually use. Recognising the project from
    // the API URL while the connection string is missing must not pass.
    const partial = { NEXT_PUBLIC_SUPABASE_URL: PROD.NEXT_PUBLIC_SUPABASE_URL };
    expect(targetsOnlyProductionProject(partial).ok).toBe(true); // the refs agree...
    // ...so the script itself must require the connection variables. Pinned below.
    const src = readFileSync("tooling/scripts/migrate-prod.ts", "utf8");
    expect(src).toMatch(/DIRECT_URL", "DATABASE_URL", "APP_DB_PASSWORD"/);
    expect(src).toMatch(/is missing from \.env\.local/);
  });

  it("targetsOnlyProject is the one rule both wrappers use", () => {
    expect(targetsOnlyProject(TEST_PROJECT_REF, TEST).ok).toBe(true);
    expect(targetsOnlyProject(PRODUCTION_PROJECT_REF, TEST).ok).toBe(false);
  });
});

describe("the production path cannot be run by accident", () => {
  const src = readFileSync("tooling/scripts/migrate-prod.ts", "utf8");

  it("demands a phrase that names the project it will change", () => {
    const phrase = productionMigrationPhrase();
    expect(phrase).toContain(PRODUCTION_PROJECT_REF);
    expect(phrase).toMatch(/^apply-migrations-to-/);
    expect(src).toMatch(/confirmArg !== phrase/);
  });

  it("takes the confirmation as an ARGUMENT, never an environment variable", () => {
    // A variable can sit exported in a shell or set once in CI and forgotten.
    // An argument has to be typed for this run, and it is visible in history.
    expect(src).toMatch(/--confirm=/);
    expect(src).not.toMatch(/process\.env\.(FORCE|CONFIRM|MIGRATE_PROD|I_KNOW)/);
    // No env var of any name may unlock it.
    const guardBlock = src.slice(
      src.indexOf("const phrase ="),
      src.indexOf('console.log("\\napplying'),
    );
    expect(guardBlock).not.toMatch(/process\.env/);
  });

  it("prints the target and the pending list before it changes anything", () => {
    const applyAt = src.indexOf("await runMigrations()");
    for (const marker of ["target project :", "PENDING (", "pendingMigrations()"]) {
      const at = src.indexOf(marker);
      expect(at, `${marker} must appear`).toBeGreaterThan(-1);
      expect(at, `${marker} must come before applying`).toBeLessThan(applyAt);
    }
  });

  it("asks the server which database it reached before applying", () => {
    const probeAt = src.indexOf("current_database()");
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(src.indexOf("await runMigrations()"));
  });

  it("offers a dry run that cannot apply anything", () => {
    expect(src).toMatch(/--dry-run/);
    const dryAt = src.indexOf("dryRun: nothing was applied");
    expect(src.indexOf("--dry-run: nothing was applied") > -1 || dryAt > -1).toBe(true);
    expect(src.indexOf("if (dryRun)")).toBeLessThan(src.indexOf("await runMigrations()"));
  });

  it("points a misdirected operator at the test path instead", () => {
    expect(src).toContain("migrate-test.ts");
  });
});

describe("the everyday commands stay pointed where they belong", () => {
  it("the test migration path loads only the test environment", () => {
    const src = readFileSync("tooling/scripts/migrate-test.ts", "utf8");
    expect(src).toMatch(/\.env\.test\.local/);
    expect(src).not.toMatch(/config\([^)]*"\.env\.local"/s);
    expect(src).toMatch(/targetsOnlyTestProject/);
  });

  it("the production migration path loads only .env.local", () => {
    const src = readFileSync("tooling/scripts/migrate-prod.ts", "utf8");
    expect(src).toMatch(/config\(\{ path: \[".env.local"\]/);
    expect(src).not.toMatch(/\.env\.test\.local/);
  });

  it("pendingMigrations reports without creating or writing anything", () => {
    const src = readFileSync("tooling/scripts/migrate.ts", "utf8");
    const fn = src.slice(
      src.indexOf("export async function pendingMigrations"),
      src.indexOf("export async function runMigrations"),
    );
    expect(fn).not.toMatch(/create table|create schema|insert into|alter role/i);
  });
});
