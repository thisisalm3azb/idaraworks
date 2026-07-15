/**
 * U5 navigation builder — the role × entitlement matrix as a pure function.
 * Asserts the visibility law (can() decides existence; features decide the
 * locked/hidden presentation), the documented locked-vs-hidden rule (money
 * modules show locked; everything else hides), the foreman money wall, the
 * bottom-bar composition, and active-state resolution.
 */
import { describe, expect, it } from "vitest";
import {
  activeItemKey,
  buildBottomNav,
  buildNavGroups,
  buildQuickCreate,
} from "@/platform/ui/nav/build";
import { FEATURE_KEYS } from "@/platform/entitlements";
import type { RoleArchetype } from "@/platform/registries";

const ORG = "org-1";
const allOn: Record<string, boolean> = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const allOff: Record<string, boolean> = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));

const build = (archetype: RoleArchetype, features = allOn) =>
  buildNavGroups({ orgId: ORG, archetype, features });

const flat = (archetype: RoleArchetype, features = allOn) =>
  build(archetype, features).flatMap((g) => g.items);

const MONEY_KEYS = ["quotes", "invoices", "payments", "expenses", "costing", "ar"];

describe("buildNavGroups — role matrix (all features on)", () => {
  it("owner sees every group", () => {
    expect(build("owner").map((g) => g.key)).toEqual([
      "today",
      "work",
      "materials",
      "money",
      "customers",
      "people",
      "data",
      "settings",
    ]);
  });

  it("foreman gets a field-scoped nav and NEVER a money item", () => {
    const groups = build("foreman");
    expect(groups.map((g) => g.key)).toEqual(["today", "work", "materials"]);
    const keys = flat("foreman").map((i) => i.key);
    for (const money of MONEY_KEYS) expect(keys).not.toContain(money);
    expect(keys).toEqual(
      expect.arrayContaining([
        "today",
        "jobs",
        "week",
        "report_new",
        "issues",
        "material_requests",
      ]),
    );
    // Foreman decides no approvals and reviews nothing.
    expect(keys).not.toContain("approvals");
    expect(keys).not.toContain("reports_review");
  });

  it("foreman money wall holds even with every feature on and off", () => {
    for (const features of [allOn, allOff]) {
      const keys = flat("foreman", features).map((i) => i.key);
      for (const money of MONEY_KEYS) expect(keys).not.toContain(money);
    }
  });

  it("viewer gets only read surfaces", () => {
    const keys = flat("viewer").map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining(["today", "jobs", "week", "attendance", "members"]),
    );
    for (const money of MONEY_KEYS) expect(keys).not.toContain(money);
    expect(keys).not.toContain("configuration");
  });

  it("manager money group is quotes/expenses/costing only (no invoices/payments/ar)", () => {
    const money = build("manager").find((g) => g.key === "money");
    expect(money?.items.map((i) => i.key).sort()).toEqual(["costing", "expenses", "quotes"]);
  });

  it("accounts gets the full money group", () => {
    const money = build("accounts").find((g) => g.key === "money");
    expect(money?.items.map((i) => i.key).sort()).toEqual(
      ["ar", "costing", "expenses", "invoices", "payments", "quotes"].sort(),
    );
  });

  it("procurement sees materials but no money group", () => {
    const groups = build("procurement");
    const materials = groups.find((g) => g.key === "materials");
    expect(materials?.items.map((i) => i.key)).toEqual(
      expect.arrayContaining(["material_requests", "purchase_orders", "items", "suppliers"]),
    );
    // procurement has expenses.view → the money group exists but only expenses.
    const money = groups.find((g) => g.key === "money");
    expect(money?.items.map((i) => i.key)).toEqual(["expenses"]);
  });
});

describe("locked-vs-hidden rule", () => {
  it("money items show LOCKED when the capability is off (owner → subscription link)", () => {
    const items = flat("owner", allOff);
    const quotes = items.find((i) => i.key === "quotes");
    expect(quotes).toBeDefined();
    expect(quotes!.locked).toBe(true);
    // Owner can billing.view → the locked item points at the unlock surface.
    expect(quotes!.href).toBe(`/o/${ORG}/settings/subscription`);
    // AR has no capability gate → never locked.
    const ar = items.find((i) => i.key === "ar");
    expect(ar!.locked).toBe(false);
  });

  it("a locked money item for a non-billing role links to its read-only list (FR-9)", () => {
    const items = flat("manager", allOff);
    const quotes = items.find((i) => i.key === "quotes");
    expect(quotes!.locked).toBe(true);
    expect(quotes!.href).toBe(`/o/${ORG}/quotes`);
  });

  it("non-money entitlement-gated items are HIDDEN when the capability is off", () => {
    const on = flat("owner", allOn).map((i) => i.key);
    const off = flat("owner", allOff).map((i) => i.key);
    for (const key of [
      "attendance",
      "material_requests",
      "purchase_orders",
      "customer_updates",
      "imports",
    ]) {
      expect(on).toContain(key);
      expect(off).not.toContain(key);
    }
  });

  it("entitled items are never marked locked", () => {
    for (const item of flat("owner", allOn)) expect(item.locked).toBe(false);
  });
});

describe("buildBottomNav", () => {
  it("always ends with More and holds ≤5 items", () => {
    const archetypes: RoleArchetype[] = [
      "owner",
      "admin",
      "manager",
      "foreman",
      "accounts",
      "procurement",
      "viewer",
    ];
    for (const a of archetypes) {
      const items = buildBottomNav({ orgId: ORG, archetype: a, features: allOn });
      expect(items.length).toBeLessThanOrEqual(5);
      expect(items[items.length - 1]!.isMore).toBe(true);
      expect(items[0]!.key).toBe("today");
    }
  });

  it("foreman bottom bar is field-first (report + issues, no approvals/money)", () => {
    const keys = buildBottomNav({ orgId: ORG, archetype: "foreman", features: allOn }).map(
      (i) => i.key,
    );
    expect(keys).toEqual(["today", "jobs", "report_new", "issues", "more"]);
  });

  it("accounts bottom bar is finance-first", () => {
    const keys = buildBottomNav({ orgId: ORG, archetype: "accounts", features: allOn }).map(
      (i) => i.key,
    );
    expect(keys).toEqual(["today", "invoices", "payments", "ar", "more"]);
  });

  it("procurement falls back past hidden capability items", () => {
    const noSupply = { ...allOn, "cap.material_requests": false, "cap.purchase_orders": false };
    const keys = buildBottomNav({ orgId: ORG, archetype: "procurement", features: noSupply }).map(
      (i) => i.key,
    );
    expect(keys).toEqual(["today", "suppliers", "jobs", "more"]);
  });
});

describe("buildQuickCreate", () => {
  it("foreman can create a report and an MR but nothing money-shaped", () => {
    const keys = buildQuickCreate({ orgId: ORG, archetype: "foreman", features: allOn }).map(
      (i) => i.key,
    );
    expect(keys).toContain("report");
    expect(keys).toContain("mr");
    for (const k of ["quote", "invoice", "payment", "expense", "job"]) {
      expect(keys).not.toContain(k);
    }
  });

  it("locked capabilities never surface as create entries", () => {
    const keys = buildQuickCreate({ orgId: ORG, archetype: "owner", features: allOff }).map(
      (i) => i.key,
    );
    expect(keys).toEqual(["job", "report"]);
  });
});

describe("activeItemKey", () => {
  const items = [
    { key: "today", href: `/o/${ORG}` },
    { key: "jobs", href: `/o/${ORG}/jobs` },
    { key: "report_new", href: `/o/${ORG}/reports/new` },
    { key: "reports_review", href: `/o/${ORG}/reports/review` },
    { key: "more", href: "#nav" },
  ];

  it("org home matches exactly, never as a prefix", () => {
    expect(activeItemKey(`/o/${ORG}`, items)).toBe("today");
    expect(activeItemKey(`/o/${ORG}/jobs`, items)).toBe("jobs");
  });

  it("longest segment-boundary prefix wins", () => {
    expect(activeItemKey(`/o/${ORG}/reports/new`, items)).toBe("report_new");
    expect(activeItemKey(`/o/${ORG}/reports/review`, items)).toBe("reports_review");
    expect(activeItemKey(`/o/${ORG}/jobs/123`, items)).toBe("jobs");
  });

  it("no false prefix matches and trailing slashes normalise", () => {
    expect(activeItemKey(`/o/${ORG}/jobsX`, items)).toBeNull();
    expect(activeItemKey(`/o/${ORG}/jobs/`, items)).toBe("jobs");
  });
});
