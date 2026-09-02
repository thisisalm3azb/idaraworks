/**
 * H25Q — the studio's permission lanes, transcribed for every archetype so a
 * widening is a deliberate change here as well as in the matrix. Viewing is
 * wide, shaping is for managers, applying a scenario is for owners/admins,
 * and roles with no studio grant get nothing at all.
 */
import { describe, expect, it } from "vitest";
import { can } from "@/platform/authz";
import { ROLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";

const LANES = [
  "studio.view",
  "studio.manage",
  "studio.schedule",
  "scenario.manage",
  "scenario.apply",
  "kpi.manage",
  "register.manage",
] as const;

const EXPECTED: Record<RoleArchetype, readonly (typeof LANES)[number][]> = {
  owner: [...LANES],
  admin: [...LANES],
  manager: [
    "studio.view",
    "studio.manage",
    "studio.schedule",
    "scenario.manage",
    "kpi.manage",
    "register.manage",
  ],
  foreman: [],
  procurement: [],
  accounts: ["studio.view"],
  viewer: ["studio.view"],
  worker_reserved_p3: [],
};

describe("studio permission lanes", () => {
  it("every archetype holds exactly its transcribed lanes", () => {
    for (const role of ROLE_ARCHETYPES) {
      const held = LANES.filter((a) => can(role, a));
      expect({ role, held }).toEqual({ role, held: EXPECTED[role] });
    }
  });

  it("applying a scenario is the narrowest lane; viewing the widest", () => {
    const appliers = ROLE_ARCHETYPES.filter((r) => can(r, "scenario.apply"));
    expect(appliers).toEqual(["owner", "admin"]);
    const viewers = ROLE_ARCHETYPES.filter((r) => can(r, "studio.view"));
    expect(viewers).toEqual(["owner", "admin", "manager", "accounts", "viewer"]);
    // Nobody shapes without also viewing; nobody applies without managing scenarios.
    for (const r of ROLE_ARCHETYPES) {
      if (can(r, "studio.manage")) expect(can(r, "studio.view")).toBe(true);
      if (can(r, "scenario.apply")) expect(can(r, "scenario.manage")).toBe(true);
    }
  });
});
