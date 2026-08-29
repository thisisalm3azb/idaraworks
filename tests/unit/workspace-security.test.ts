/**
 * H14 Part I — security tests, pure layers. (Org isolation, RLS, the
 * immutability trigger, audit rows and undo integrity run against the real
 * database in tests/integration/workspace-blueprint.test.ts.)
 *
 * Everything here proves DENIAL: forged vocabulary never parses, unsafe
 * input is rejected, permissions cannot be escalated through configuration,
 * client-supplied authority fields have nowhere to live, and unauthorized
 * archetypes are refused before any I/O.
 */
import { describe, expect, it } from "vitest";
import {
  WorkspaceBlueprintSchema,
  validateBlueprint,
  compileBlueprint,
  createBlueprintDraft,
  applyBlueprintRevision,
  undoBlueprintApply,
  approveBlueprintRevision,
} from "@/platform/workspace";
import { ForbiddenError } from "@/platform/authz";
import type { Ctx } from "@/platform/tenancy";
import { makeBlueprint, modulesWith, entitleAll, prov, loc } from "./workspace-fixtures";

const ctx: Ctx = {
  orgId: "00000000-0000-4000-8000-000000000000",
  userId: "00000000-0000-4000-8000-000000000001",
  costPrivileged: false,
  pricePrivileged: false,
  requestId: "h14-sec-test",
};

describe("H14 security — unauthorized archetypes are refused before any I/O", () => {
  it("viewer/foreman/procurement/accounts cannot draft, approve, apply or undo", async () => {
    for (const archetype of ["viewer", "foreman", "procurement", "accounts"] as const) {
      await expect(
        createBlueprintDraft(ctx, archetype, {
          blueprint: makeBlueprint(),
          source: "user_change",
        }),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        approveBlueprintRevision(ctx, archetype, ctx.orgId, { expectedHash: "0".repeat(64) }),
      ).rejects.toThrow(ForbiddenError);
      await expect(applyBlueprintRevision(ctx, archetype, ctx.orgId)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(undoBlueprintApply(ctx, archetype)).rejects.toThrow(ForbiddenError);
    }
  });
});

describe("H14 security — client-supplied authority has nowhere to live", () => {
  it("smuggled roles/permissions/entitlements/status fields are rejected (strict schemas)", () => {
    const base = makeBlueprint() as unknown as Record<string, unknown>;
    for (const smuggle of [
      { entitlements: { "cap.quoting": true } },
      { status: "approved" },
      { approved: true },
      { permissions: ["config.manage"] },
      { orgId: "someone-elses-org" },
      { provider: { model: "gpt", apiKey: "x" } },
    ]) {
      expect(
        WorkspaceBlueprintSchema.safeParse({ ...base, ...smuggle }).success,
        `top-level ${Object.keys(smuggle)[0]} must be rejected`,
      ).toBe(false);
    }
    // Nested smuggling into an agent entry is equally dead.
    const agentSmuggle = {
      ...base,
      agents: [
        {
          agentId: "operations",
          relevantRoles: ["owner"],
          relevantModules: [],
          readDomains: [],
          classifications: ["read_explain"],
          entitlement: "feat.ai_agents",
          provenance: prov("x", "س"),
          model: "gpt-4",
        },
      ],
    };
    expect(WorkspaceBlueprintSchema.safeParse(agentSmuggle).success).toBe(false);
  });

  it("the compiler takes entitlements ONLY from the server snapshot", () => {
    // A blueprint that enables quoting cannot entitle it: the snapshot rules.
    const bp = makeBlueprint({
      capabilities: {
        modules: modulesWith(["cap.jobs", "cap.customers", "cap.quoting"]),
        provenance: prov("wants quoting", "يريد عروض الأسعار"),
      },
    });
    const compiled = compileBlueprint(bp, {
      entitlements: { "cap.jobs": true, "cap.customers": true },
    });
    const quoting = compiled.capabilities.find((c) => c.key === "cap.quoting")!;
    expect(quoting.planEntitled).toBe(false);
    expect(quoting.effective).toBe(false);
  });
});

describe("H14 security — forged vocabulary never parses", () => {
  it("unknown canonical entity in terminology is rejected", () => {
    const forged = makeBlueprint({
      terminology: {
        overrides: {
          boat: {
            en: { singular: "Boat", plural: "Boats" },
            ar: { singular: "قارب", plural: "قوارب", gender: "m" },
          },
        } as never,
        fallback: "platform_default",
        provenance: prov("x", "س"),
      },
    });
    expect(WorkspaceBlueprintSchema.safeParse(forged).success).toBe(false);
  });

  it("unknown module, nav item, dashboard card, country and locale are rejected", () => {
    const base = makeBlueprint();
    const cases: Array<Record<string, unknown>> = [
      {
        capabilities: {
          modules: [{ key: "cap.blockchain", enabled: true, reason: loc("x", "س") }],
          provenance: prov("x", "س"),
        },
      },
      {
        navigation: { ...base.navigation, hidden: ["secret_panel"] },
      },
      {
        dashboards: [
          {
            ...base.dashboards[0],
            cards: [{ key: "crypto_prices", why: loc("x", "س") }],
          },
        ],
      },
      { international: { ...base.international, countryPack: "US" } },
      { international: { ...base.international, defaultLocale: "fr" } },
    ];
    for (const override of cases) {
      expect(
        WorkspaceBlueprintSchema.safeParse({ ...base, ...override }).success,
        JSON.stringify(Object.keys(override)),
      ).toBe(false);
    }
  });

  it("unsafe terminology input is rejected (markup, formulas, control chars)", () => {
    for (const bad of ["<script>alert(1)</script>", "=SUM(A1)", "job{term}", "line\nbreak"]) {
      const forged = makeBlueprint({
        terminology: {
          overrides: {
            job: {
              en: { singular: bad, plural: "Jobs" },
              ar: { singular: "مشروع", plural: "مشاريع", gender: "m" },
            },
          },
          fallback: "platform_default",
          provenance: prov("x", "س"),
        },
      });
      expect(WorkspaceBlueprintSchema.safeParse(forged).success, bad).toBe(false);
    }
  });

  it("invalid workflow transitions and stage integrity violations are rejected", () => {
    const base = makeBlueprint();
    const wf = base.workflows[0]!;
    const badTransition = makeBlueprint({
      workflows: [{ ...wf, transitions: [{ from: "planning", to: "ghost_stage" }] }],
    });
    const v1 = validateBlueprint(badTransition);
    expect(v1.ok).toBe(false);
    expect(v1.errors.some((e) => e.code === "invalid_transition")).toBe(true);

    const badWeights = makeBlueprint({
      workflows: [{ ...wf, stages: wf.stages.map((s) => ({ ...s, weight: 10 })) }],
    });
    const v2 = validateBlueprint(badWeights);
    expect(v2.errors.some((e) => e.code === "stage_weights")).toBe(true);
  });
});

describe("H14 security — configuration cannot escalate permissions", () => {
  it("a role claiming an action its archetype lacks is rejected", () => {
    const forged = makeBlueprint({
      roles: [
        {
          archetype: "foreman",
          name: loc("Foreman", "مشرف"),
          responsibilities: loc("Field work", "عمل ميداني"),
          permissionRefs: ["config.manage"],
          navVisibility: [],
          relevantAgents: [],
          approvalAuthority: false,
          provenance: prov("x", "س"),
        },
      ],
    });
    const v = validateBlueprint(forged);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === "permission_escalation")).toBe(true);
  });

  it("approval authority cannot be granted to an archetype that cannot decide", () => {
    const forged = makeBlueprint({
      roles: [
        {
          archetype: "viewer",
          name: loc("Viewer", "مطّلع"),
          responsibilities: loc("Reads", "يطّلع"),
          permissionRefs: [],
          navVisibility: [],
          relevantAgents: [],
          approvalAuthority: true,
          provenance: prov("x", "س"),
        },
      ],
    });
    const v = validateBlueprint(forged);
    expect(v.errors.some((e) => e.code === "permission_escalation")).toBe(true);
  });

  it("safety-rail navigation items can never be hidden", () => {
    const forged = makeBlueprint({
      navigation: {
        ...makeBlueprint().navigation,
        hidden: ["today", "subscription"],
      },
    });
    const v = validateBlueprint(forged);
    expect(v.errors.filter((e) => e.code === "hidden_safety_rail").length).toBe(2);
  });

  it("an unknown permission reference is rejected outright", () => {
    const forged = makeBlueprint({
      roles: [
        {
          ...makeBlueprint().roles[0]!,
          permissionRefs: ["superuser.everything"],
        },
      ],
    });
    const v = validateBlueprint(forged);
    expect(v.errors.some((e) => e.code === "unknown_permission")).toBe(true);
  });
});

describe("H14 security — agent boundaries", () => {
  it("an agent cannot be configured with domains outside its allow-list", () => {
    const forged = makeBlueprint({
      agents: [
        {
          agentId: "people_payroll",
          relevantRoles: ["owner"],
          relevantModules: ["cap.people"],
          readDomains: ["read.money_overview"], // not on people_payroll's list
          classifications: ["read_explain"],
          entitlement: "feat.ai_agents",
          provenance: prov("x", "س"),
        },
      ],
    });
    const v = validateBlueprint(forged);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === "agent_domain_widening")).toBe(true);
  });

  it("the prohibited classification can never be configured as available", () => {
    const forged = makeBlueprint({
      agents: [
        {
          agentId: "operations",
          relevantRoles: ["owner"],
          relevantModules: [],
          readDomains: [],
          classifications: ["prohibited"],
          entitlement: "feat.ai_agents",
          provenance: prov("x", "س"),
        },
      ],
    });
    const v = validateBlueprint(forged);
    expect(v.errors.some((e) => e.code === "prohibited_classification")).toBe(true);
  });

  it("an agent entitlement other than the canonical gate never parses", () => {
    const forged = makeBlueprint({
      agents: [
        {
          agentId: "operations",
          relevantRoles: ["owner"],
          relevantModules: [],
          readDomains: [],
          classifications: ["read_explain"],
          entitlement: "cap.jobs" as never,
          provenance: prov("x", "س"),
        },
      ],
    });
    expect(WorkspaceBlueprintSchema.safeParse(forged).success).toBe(false);
  });

  it("agent access outside configured capabilities is inert, not authoritative", () => {
    // Agent references modules the workspace disabled → warning + relevance
    // computed from what is actually active; nothing grants access.
    const bp = makeBlueprint({
      agents: [
        {
          agentId: "accounting",
          relevantRoles: ["owner"],
          relevantModules: ["cap.invoicing"],
          readDomains: [],
          classifications: ["read_explain"],
          entitlement: "feat.ai_agents",
          provenance: prov("x", "س"),
        },
      ],
    });
    const v = validateBlueprint(bp);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.code === "agent_module_disabled")).toBe(true);
    const compiled = compileBlueprint(bp, entitleAll());
    const acc = compiled.agents.find((a) => a.agentId === "accounting")!;
    expect(acc.relevant).toBe(false);
    expect(acc.entitled).toBe(false);
  });
});
