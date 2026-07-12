import { describe, expect, it } from "vitest";
import { can, EXPECTED_MATRIX } from "@/platform/authz";
import { MATRIX, type Action } from "@/platform/authz/matrix";
import { MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";

/**
 * The matrix runner (doc 10 #15, BUILD_BIBLE §13.4): iterate the table as data,
 * assert allow/deny for every archetype, and prove deny-by-default.
 */
describe("authz matrix", () => {
  const actions = Object.keys(MATRIX) as Action[];

  it("every listed archetype is a valid grantable archetype", () => {
    for (const action of actions) {
      for (const arch of MATRIX[action]) {
        expect(MVP_GRANTABLE_ARCHETYPES).toContain(arch);
      }
    }
  });

  it("can() matches the table exactly for every archetype × action", () => {
    for (const action of actions) {
      const allowed = new Set<string>(MATRIX[action]);
      for (const arch of MVP_GRANTABLE_ARCHETYPES) {
        expect(can(arch, action)).toBe(allowed.has(arch));
      }
    }
  });

  it("can() agrees with the INDEPENDENT doc-06 transcription (drift guard)", () => {
    // EXPECTED_MATRIX is transcribed from doc 06 by archetype, separately from
    // MATRIX (by action). The two must agree for every cell — a typo in either
    // encoding fails here (doc 10 #15).
    for (const arch of MVP_GRANTABLE_ARCHETYPES) {
      const expected = new Set<string>(EXPECTED_MATRIX[arch]);
      for (const action of actions) {
        expect(
          can(arch, action),
          `${arch} × ${action}: can()=${can(arch, action)} vs doc-06=${expected.has(action)}`,
        ).toBe(expected.has(action));
      }
    }
  });

  it("the independent grid covers exactly the grantable archetypes", () => {
    expect(Object.keys(EXPECTED_MATRIX).sort()).toEqual([...MVP_GRANTABLE_ARCHETYPES].sort());
  });

  it("deny-by-default: unknown actions are denied for everyone", () => {
    for (const arch of MVP_GRANTABLE_ARCHETYPES) {
      // @ts-expect-error — intentionally unknown action
      expect(can(arch, "totally.unknown.action")).toBe(false);
    }
  });

  it("the reserved worker archetype is denied every action", () => {
    for (const action of actions) {
      expect(can("worker_reserved_p3", action)).toBe(false);
    }
  });

  it("owner/admin-only actions exclude non-privileged archetypes", () => {
    for (const action of ["members.invite", "members.deactivate"] as Action[]) {
      expect(can("foreman", action)).toBe(false);
      expect(can("viewer", action)).toBe(false);
      expect(can("manager", action)).toBe(false);
      expect(can("owner", action)).toBe(true);
      expect(can("admin", action)).toBe(true);
    }
  });

  it("members.view is broadly readable but not by field roles", () => {
    expect(can("viewer", "members.view")).toBe(true);
    expect(can("accounts", "members.view")).toBe(true);
    expect(can("foreman", "members.view")).toBe(false);
  });
});
