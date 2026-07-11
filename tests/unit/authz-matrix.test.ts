import { describe, expect, it } from "vitest";
import { can } from "@/platform/authz";
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

  it("owner-only actions exclude non-privileged archetypes", () => {
    for (const action of [
      "org.settings.update",
      "members.invite",
      "members.deactivate",
    ] as Action[]) {
      expect(can("foreman", action)).toBe(false);
      expect(can("viewer", action)).toBe(false);
      expect(can("owner", action)).toBe(true);
      expect(can("admin", action)).toBe(true);
    }
  });
});
