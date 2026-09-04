/**
 * H21.1 Part E — cleanup is a property of the suites, so it is checked the way
 * every other structural law here is checked: by reading the source.
 *
 * The residue that prompted this was not caused by a subtle race. It was caused
 * by suites that simply had no teardown, one that swallowed its teardown's
 * errors, and one that created a second organization no teardown could see. All
 * three are visible in the text of the files, and all three are pinned below.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every suite that creates its own organization and must clean it up. */
const SUITES = [
  "s7-improve",
  "s8-onboarding",
  "s9-subscription",
  "s9-impersonation",
  "s9-lifecycle-worker",
  "s9-plan-change",
  "s9-readonly-enforcement",
] as const;

const read = (suite: string) => readFileSync(`tests/integration/${suite}.test.ts`, "utf8");

describe("integration fixtures clean up after themselves", () => {
  it.each(SUITES)("%s wipes its organization in afterAll", (suite) => {
    const src = read(suite);
    expect(src).toMatch(/import \{[^}]*wipeOrgs[^}]*\} from "\.\/helpers"/);
    const afterAll = src.slice(src.indexOf("afterAll(async"), src.indexOf("describe("));
    expect(afterAll).toMatch(/wipeOrgs\(/);
  });

  it.each(SUITES)("%s never swallows a cleanup failure", (suite) => {
    const src = read(suite);
    // `.catch(() => {})` on the wipe makes a broken teardown look identical to a
    // working one — which is exactly how the leak went unnoticed for weeks.
    expect(src).not.toMatch(/wipeOrgs\([^;]*\)\s*\.catch\(/);
  });

  it.each(SUITES)("%s marks its organization as a disposable fixture", (suite) => {
    const src = read(suite);
    expect(src).toMatch(/markFixtureOrg\(/);
  });

  it.each(SUITES)("%s gives teardown its own timeout", (suite) => {
    const src = read(suite);
    const afterAll = src.slice(src.indexOf("afterAll(async"), src.indexOf("describe("));
    // Teardown deletes across every tenant table; the default hook timeout is
    // not guaranteed to cover that against a remote database.
    expect(afterAll).toMatch(/\},\s*\d[\d_]*\)/);
  });

  it("every organization a suite creates is reachable by its teardown", () => {
    // S7 built a second org inside a test body, so afterAll could not see it and
    // one row leaked per run. Any createOrgForUser result must land in a
    // module-scoped binding that teardown also names.
    for (const suite of SUITES) {
      const src = read(suite);
      const afterAll = src.slice(src.indexOf("afterAll(async"), src.indexOf("describe("));
      const wiped = /wipeOrgs\(\s*owner\s*,\s*\[([^\]]*)\]/.exec(afterAll)?.[1] ?? "";
      const created =
        src.match(/^\s*(?:const|let)?\s*([A-Za-z0-9_]+)\s*=\s*await createOrgForUser/gm) ?? [];
      // Each creation site assigns some identifier; every one of them must appear
      // in the teardown's org list.
      for (const line of created) {
        const name = /([A-Za-z0-9_]+)\s*=\s*await createOrgForUser/.exec(line)![1]!;
        expect(
          wiped.split(",").map((s) => s.trim()),
          `${suite}: "${name}" is created but not wiped`,
        ).toContain(name);
      }
    }
  });

  it("the shared wipe restores FK enforcement before deleting auth users", () => {
    const helpers = readFileSync("tests/integration/helpers.ts", "utf8");
    const body = helpers.slice(helpers.indexOf("export async function wipeOrgs"));
    const restore = body.indexOf("session_replication_role = default");
    const authDelete = body.indexOf("delete from auth.users");
    expect(restore).toBeGreaterThan(-1);
    expect(authDelete).toBeGreaterThan(-1);
    // Deleting an auth user while triggers are off leaves its identities and
    // sessions behind, which then block re-creating the same email.
    expect(restore).toBeLessThan(authDelete);
  });

  it("the residue command reports rather than deletes", () => {
    const script = readFileSync("tooling/scripts/test-residue.ts", "utf8");
    expect(script).not.toMatch(/\bdelete from\b/i);
    expect(script).not.toMatch(/\bdrop\s+table\b/i);
  });

  /*
   * H30 moved the "is this a fixture" rule out of the report and into
   * tooling/fixtures/evidence.ts, so the script that DELETES reaches the same
   * verdict as the report a human reads before authorising it. This assertion
   * followed it there. The behaviour it protects — a name alone is never
   * sufficient — is now covered directly by fixture-evidence-law.test.ts, which
   * calls the classifier instead of reading its source.
   */
  it("the deletion rule and the report share one classifier", () => {
    for (const path of ["tooling/scripts/test-residue.ts", "tooling/scripts/s7-cleanup.ts"]) {
      expect(readFileSync(path, "utf8"), `${path} must not carry its own copy of the rule`).toMatch(
        /from "\.\.\/fixtures\/evidence"/,
      );
    }
  });

  it("a name alone is never sufficient evidence to delete an organisation", () => {
    const rule = readFileSync("tooling/fixtures/evidence.ts", "utf8");
    expect(rule).toMatch(/byName && allTestEmails && noBusiness/);
  });
});
