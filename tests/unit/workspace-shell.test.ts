/**
 * H16 — the adaptive workspace shell (pure layers): blueprint-driven nav
 * filtering with the legacy null-fallback law, the effective-access
 * intersection staying with the live builder, quick-create mapping parity,
 * direct-route module states, the new Workspace-setup nav entry's
 * authorization, and the shell copy contract (en/ar parity, no em dash,
 * no internal keys).
 */
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  filterGroupsByBlueprint,
  navItemAllowedByBlueprint,
  quickCreateAllowedByBlueprint,
  QUICK_CREATE_MODULE,
  disabledModulesOf,
  moduleStateOf,
  compileBlueprint,
  WORKSPACE_MODULE_KEYS,
  NAV_ITEM_INFO,
  NAV_ITEM_KEYS,
  type AppliedWorkspaceShape,
} from "@/platform/workspace";
import { buildNavGroups, buildQuickCreate } from "@/platform/ui/nav/build";
import { FEATURE_KEYS } from "@/platform/entitlements";
import { can } from "@/platform/authz";
import {
  makeBlueprint,
  modulesWith,
  scenarioContractor,
  entitleAll,
  prov,
} from "./workspace-fixtures";

const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));

function shapeOf(blueprint: unknown): AppliedWorkspaceShape {
  return {
    revisionId: "00000000-0000-4000-8000-00000000aaaa",
    revisionNo: 1,
    appliedAt: "2026-08-29T00:00:00.000Z",
    compilerVersion: "1.0.0",
    compiled: compileBlueprint(blueprint, entitleAll()),
  };
}

/** A lean services blueprint: money/materials areas switched off (the core
 * four stay on, as every real H15 mapping guarantees). */
const leanShape = () =>
  shapeOf(
    makeBlueprint({
      capabilities: {
        modules: modulesWith([
          "cap.jobs",
          "cap.customers",
          "cap.issues",
          "cap.people",
          "cap.daily_reports",
        ]),
        provenance: prov("lean services", "خدمات بسيطة"),
      },
    }),
  );

describe("H16 — legacy organizations keep today's shell exactly", () => {
  it("a null shape returns the built nav UNCHANGED (same reference)", () => {
    const groups = buildNavGroups({ orgId: "x", archetype: "owner", features: allOn });
    expect(filterGroupsByBlueprint(groups, null)).toBe(groups);
  });

  it("a blueprint with nothing disabled also changes nothing", () => {
    const shape = shapeOf(
      makeBlueprint({
        capabilities: {
          modules: modulesWith([...WORKSPACE_MODULE_KEYS]),
          provenance: prov("everything on", "كل شيء مفعل"),
        },
      }),
    );
    const groups = buildNavGroups({ orgId: "x", archetype: "owner", features: allOn });
    const filtered = filterGroupsByBlueprint(groups, shape);
    expect(filtered.map((g) => g.items.map((i) => i.key))).toEqual(
      groups.map((g) => g.items.map((i) => i.key)),
    );
  });
});

describe("H16 — blueprint-driven navigation filtering", () => {
  it("disabled modules remove their items and empty groups disappear", () => {
    const shape = leanShape();
    const groups = filterGroupsByBlueprint(
      buildNavGroups({ orgId: "x", archetype: "owner", features: allOn }),
      shape,
    );
    const keys = groups.flatMap((g) => g.items).map((i) => i.key);
    // Money and materials areas are configured off…
    for (const gone of [
      "quotes",
      "invoices",
      "payments",
      "expenses",
      "costing",
      "ar",
      "material_requests",
      "purchase_orders",
      "items",
      "suppliers",
      "attendance",
      "customer_updates",
      "approvals",
    ]) {
      expect(keys, `${gone} should be filtered`).not.toContain(gone);
    }
    // …while the enabled core stays, with its groups intact.
    for (const kept of [
      "today",
      "jobs",
      "week",
      "report_new",
      "reports_review",
      "issues",
      "customers",
      "people",
    ]) {
      expect(keys).toContain(kept);
    }
    // No empty groups survive.
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
    // The money group itself is gone entirely.
    expect(groups.map((g) => g.key)).not.toContain("money");
  });

  it("safety-rail items are never filtered, whatever the configuration", () => {
    const shape = leanShape();
    const groups = filterGroupsByBlueprint(
      buildNavGroups({ orgId: "x", archetype: "owner", features: allOn }),
      shape,
    );
    const keys = groups.flatMap((g) => g.items).map((i) => i.key);
    for (const rail of [
      "today",
      "workspace",
      "configuration",
      "subscription",
      "onboarding",
      "members",
    ]) {
      expect(keys, `${rail} must survive`).toContain(rail);
    }
  });

  it("permission stays with can(): the blueprint never ADDS an item", () => {
    // A viewer's nav under a full blueprint is still the viewer's nav.
    const shape = shapeOf(scenarioContractor());
    const viewer = filterGroupsByBlueprint(
      buildNavGroups({ orgId: "x", archetype: "viewer", features: allOn }),
      shape,
    ).flatMap((g) => g.items.map((i) => i.key));
    expect(viewer).not.toContain("approvals");
    expect(viewer).not.toContain("configuration");
    expect(viewer).not.toContain("invoices");
    for (const key of viewer) {
      const info = NAV_ITEM_INFO[key as keyof typeof NAV_ITEM_INFO];
      expect(info.action === null || can("viewer", info.action)).toBe(true);
    }
  });

  it("unknown nav keys fail open to today's law (never crash, never hide)", () => {
    expect(navItemAllowedByBlueprint("future_item", disabledModulesOf(leanShape().compiled))).toBe(
      true,
    );
  });

  it("quick-create mapping covers every builder quick-create key", () => {
    const qc = buildQuickCreate({ orgId: "x", archetype: "owner", features: allOn });
    for (const item of qc) {
      expect(
        QUICK_CREATE_MODULE[item.key],
        `quick-create key ${item.key} must map to a module`,
      ).toBeDefined();
    }
    const disabled = disabledModulesOf(leanShape().compiled);
    expect(quickCreateAllowedByBlueprint("invoice", disabled)).toBe(false);
    expect(quickCreateAllowedByBlueprint("job", disabled)).toBe(true);
    expect(quickCreateAllowedByBlueprint("report", disabled)).toBe(true);
  });
});

describe("H16 — direct-route module states", () => {
  it("moduleStateOf: active / disabled / no_blueprint", () => {
    const shape = leanShape();
    expect(moduleStateOf(shape, "cap.jobs")).toBe("active");
    expect(moduleStateOf(shape, "cap.invoicing")).toBe("disabled");
    expect(moduleStateOf(null, "cap.invoicing")).toBe("no_blueprint");
  });

  it("a disabled module is presentation state only — no destructive output", () => {
    const compiled = leanShape().compiled;
    const inv = compiled.capabilities.find((c) => c.key === "cap.invoicing")!;
    expect(inv.status).toBe("disabled_by_configuration");
    expect(JSON.stringify(compiled).toLowerCase()).not.toContain('"delete"');
  });
});

describe("H16 — the Workspace setup entry", () => {
  it("exists for config.view holders only, on desktop nav", () => {
    for (const archetype of ["owner", "admin"] as const) {
      const keys = buildNavGroups({ orgId: "x", archetype, features: allOn })
        .flatMap((g) => g.items)
        .map((i) => i.key);
      expect(keys).toContain("workspace");
    }
    for (const archetype of ["manager", "foreman", "accounts", "procurement", "viewer"] as const) {
      const keys = buildNavGroups({ orgId: "x", archetype, features: allOn })
        .flatMap((g) => g.items)
        .map((i) => i.key);
      expect(keys).not.toContain("workspace");
    }
  });

  it("is registered in the closed nav registry as a safety-rail item", () => {
    expect(NAV_ITEM_KEYS).toContain("workspace");
    expect(NAV_ITEM_INFO.workspace.action).toBe("config.view");
    expect(NAV_ITEM_INFO.workspace.alwaysVisible).toBe(true);
  });
});

describe("H16 — shell copy contract", () => {
  const shellKeys = Object.keys(en).filter(
    (k) =>
      k.startsWith("shell.") || k === "nav.workspace" || k === "nav.collapse" || k === "nav.expand",
  );

  it("en and ar parity with genuine Arabic, no em dash, no internal keys", () => {
    expect(shellKeys.length).toBeGreaterThanOrEqual(20);
    for (const k of shellKeys) {
      expect(k in ar, `ar missing ${k}`).toBe(true);
      const enV = String(en[k as keyof typeof en]);
      const arV = String(ar[k as keyof typeof ar]);
      expect(enV, `en.${k} em dash`).not.toContain("—");
      expect(arV, `ar.${k} em dash`).not.toContain("—");
      if (k !== "shell.role_context") {
        expect(/[؀-ۿ]/.test(arV), `ar.${k} not Arabic`).toBe(true);
      }
      expect(enV).not.toMatch(/\bcap\.|\bfeat\.|blueprint_hash|revision_id|org_id/);
      expect(arV).not.toMatch(/\bcap\.|\bfeat\./);
    }
  });

  it("module labels exist for every module the setup page can show", () => {
    for (const key of WORKSPACE_MODULE_KEYS) {
      const labelKey = `onboarding.flow.module.${key.slice("cap.".length)}`;
      expect(labelKey in en, `missing ${labelKey}`).toBe(true);
      expect(labelKey in ar).toBe(true);
    }
  });
});
