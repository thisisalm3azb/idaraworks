/**
 * The dashboard board's laws: a layout is a preference and never a grant,
 * defaults are never blank for a role, priorities re-rank without hiding,
 * retired or foreign widget keys are dropped without comment, and the editor
 * is reachable without a pointer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";
import { can } from "@/platform/authz";
import {
  WIDGETS,
  WIDGET_KEYS,
  availableWidgets,
  defaultLayoutFor,
  parseLayout,
  resolveLayout,
  sanitiseSubmitted,
  type AvailabilityContext,
} from "@/modules/dashboard/board";

const en = JSON.parse(readFileSync("src/platform/i18n/messages/en.json", "utf8")) as Record<
  string,
  string
>;
const ar = JSON.parse(readFileSync("src/platform/i18n/messages/ar.json", "utf8")) as Record<
  string,
  string
>;
const es = JSON.parse(readFileSync("src/platform/i18n/messages/es.json", "utf8")) as Record<
  string,
  string
>;

const ALL_FEATURES: Record<string, boolean> = Object.fromEntries(
  ["cap.jobs", "cap.approvals", "cap.quoting", "cap.invoicing", "cap.items", "cap.people"].map(
    (k) => [k, true],
  ),
);

function cx(
  archetype: RoleArchetype,
  over: Partial<AvailabilityContext> = {},
): AvailabilityContext {
  return {
    archetype,
    features: ALL_FEATURES,
    disabledModules: new Set(),
    seesPrice: true,
    flags: { stock: true, hr: true },
    adaptive: true,
    ...over,
  };
}

describe("availability is permission x entitlement x blueprint x flags x price", () => {
  it("never offers a widget whose action the role lacks", () => {
    for (const a of ROLE_ARCHETYPES) {
      const archetype = a as RoleArchetype;
      for (const w of availableWidgets(cx(archetype))) {
        expect(can(archetype, w.action), `${a} offered ${w.key}`).toBe(true);
      }
    }
  });

  it("a viewer never gets approvals, receivables or team actions", () => {
    const keys = availableWidgets(cx("viewer")).map((w) => w.key);
    expect(keys).not.toContain("approvals");
    expect(keys).not.toContain("receivables");
    expect(keys).not.toContain("team_actions");
  });

  it("an un-entitled or blueprint-disabled capability removes its widget", () => {
    const withQuotes = availableWidgets(cx("owner")).map((w) => w.key);
    expect(withQuotes).toContain("quotes_awaiting");
    const noQuotes = availableWidgets(
      cx("owner", { features: { ...ALL_FEATURES, "cap.quoting": false } }),
    ).map((w) => w.key);
    expect(noQuotes).not.toContain("quotes_awaiting");
    const disabled = availableWidgets(
      cx("owner", { disabledModules: new Set(["cap.quoting"]) }),
    ).map((w) => w.key);
    expect(disabled).not.toContain("quotes_awaiting");
  });

  it("release flags gate the stock and HR widgets", () => {
    const off = availableWidgets(cx("owner", { flags: { stock: false, hr: false } })).map(
      (w) => w.key,
    );
    expect(off).not.toContain("stock_alerts");
    expect(off).not.toContain("team_actions");
  });

  it("money never appears without price privilege", () => {
    const keys = availableWidgets(cx("owner", { seesPrice: false })).map((w) => w.key);
    expect(keys).not.toContain("receivables");
  });

  it("a legacy workspace gets the classic overview and every focused widget; a blueprint one never gets classic", () => {
    const legacy = availableWidgets(cx("owner", { adaptive: false })).map((w) => w.key);
    for (const k of ["attention", "next", "pulse", "progress"]) expect(legacy).not.toContain(k);
    for (const k of [
      "classic",
      "my_tasks",
      "approvals",
      "active_work",
      "quotes_awaiting",
      "receivables",
      "stock_alerts",
      "team_actions",
      "recent_activity",
      "quick_actions",
    ]) {
      expect(legacy, k).toContain(k);
    }
    const blueprint = availableWidgets(cx("owner")).map((w) => w.key);
    expect(blueprint).not.toContain("classic");
    expect(blueprint).toContain("attention");
  });

  it("a legacy workspace's default is the classic overview first, so nothing changes until somebody edits", () => {
    for (const a of ROLE_ARCHETYPES) {
      const archetype = a as RoleArchetype;
      if (!can(archetype, "today.view")) continue;
      const available = availableWidgets(cx(archetype, { adaptive: false }));
      const entries = defaultLayoutFor(archetype, ["money", "stock"], available);
      expect(
        entries.map((e) => e.key),
        a,
      ).toEqual(["classic"]);
      expect(entries[0]?.size, a).toBe("l");
      // …and everything else stays one Add away.
      expect(available.length, a).toBeGreaterThan(1);
    }
  });
});

describe("defaults are never blank and follow the role and the stated priorities", () => {
  it("every role that has a dashboard gets a non-empty default with attention first", () => {
    for (const a of ROLE_ARCHETYPES) {
      const archetype = a as RoleArchetype;
      // The page renders nothing for a role without today.view (the reserved
      // worker role); a board that does not exist has no default to check.
      if (!can(archetype, "today.view")) continue;
      const available = availableWidgets(cx(archetype));
      const entries = defaultLayoutFor(archetype, [], available);
      expect(entries.length, a).toBeGreaterThan(0);
      expect(entries.every((e) => !e.hidden)).toBe(true);
      if (available.some((w) => w.key === "attention")) expect(entries[0]!.key).toBe("attention");
    }
  });

  it("priorities pull their widgets forward without dropping anything", () => {
    const available = availableWidgets(cx("owner"));
    const plain = defaultLayoutFor("owner", [], available).map((e) => e.key);
    const stock = defaultLayoutFor("owner", ["stock"], available).map((e) => e.key);
    expect(new Set(stock)).toEqual(new Set(plain));
    expect(stock[0]).toBe("attention");
    expect(stock.indexOf("stock_alerts")).toBeLessThan(stock.indexOf("pulse"));
    expect(plain.indexOf("stock_alerts")).toBeGreaterThan(plain.indexOf("pulse"));
  });

  it("is deterministic", () => {
    const available = availableWidgets(cx("accounts"));
    expect(defaultLayoutFor("accounts", ["money"], available)).toEqual(
      defaultLayoutFor("accounts", ["money"], available),
    );
  });
});

describe("a stored layout is a preference, never a grant", () => {
  const available = availableWidgets(cx("manager"));

  it("keeps the saved order, size and visibility", () => {
    const r = resolveLayout(
      {
        v: 1,
        widgets: [
          { key: "my_tasks", size: "s" },
          { key: "attention", size: "l", hidden: true },
        ],
      },
      "manager",
      [],
      available,
    );
    expect(r.source).toBe("saved");
    expect(r.entries).toEqual([
      { key: "my_tasks", size: "s", hidden: false },
      { key: "attention", size: "l", hidden: true },
    ]);
  });

  it("drops a widget the person may not see, a retired key and a duplicate, and says so", () => {
    const r = resolveLayout(
      {
        v: 1,
        widgets: [
          { key: "receivables", size: "s" }, // manager lacks ar.view
          { key: "old_widget_from_2025", size: "m" }, // retired
          { key: "my_tasks", size: "m" },
          { key: "my_tasks", size: "l" }, // duplicate
        ],
      },
      "manager",
      [],
      available,
    );
    expect(r.entries.map((e) => e.key)).toEqual(["my_tasks"]);
    expect(r.dropped).toEqual(["receivables", "old_widget_from_2025"]);
  });

  it("a saved layout with nothing usable left falls back to the default", () => {
    const r = resolveLayout(
      { v: 1, widgets: [{ key: "gone", size: "m" }] },
      "manager",
      [],
      available,
    );
    expect(r.source).toBe("default");
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it("a deliberately empty board is honoured", () => {
    const r = resolveLayout({ v: 1, widgets: [] }, "manager", [], available);
    expect(r.source).toBe("saved");
    expect(r.entries).toEqual([]);
  });

  it("malformed input is null, never a crash", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout("x")).toBeNull();
    expect(parseLayout({ v: 2, widgets: [] })).toBeNull();
    expect(parseLayout({ v: 1, widgets: [{ key: "a", size: "xl" }] })).toBeNull();
    expect(parseLayout({ v: 1, widgets: [{ key: "a", size: "s", extra: 1 }] })).toBeNull();
    expect(parseLayout({ v: 1, widgets: new Array(41).fill({ key: "a", size: "s" }) })).toBeNull();
  });

  it("a submitted layout is reduced to what the person may keep", () => {
    const clean = sanitiseSubmitted(
      {
        v: 1,
        widgets: [
          { key: "receivables", size: "s" },
          { key: "approvals", size: "m", hidden: true },
        ],
      },
      available,
    );
    expect(clean).toEqual({ v: 1, widgets: [{ key: "approvals", size: "m", hidden: true }] });
    expect(sanitiseSubmitted({ nope: true }, available)).toBeNull();
  });
});

describe("the registry and its copy", () => {
  it("every widget names a real permission and has a name and a hint in three languages", () => {
    for (const k of WIDGET_KEYS) {
      expect(WIDGETS[k].key).toBe(k);
      for (const cat of [en, ar, es]) {
        expect(cat, `dash.widget.${k}`).toHaveProperty(`dash.widget.${k}`);
        expect(cat, `dash.widget.${k}.hint`).toHaveProperty(`dash.widget.${k}.hint`);
      }
    }
    for (const k of Object.keys(en).filter((x) => x.startsWith("dash."))) {
      expect(en[k], k).not.toContain("—");
      expect(ar[k], `ar ${k}`).toBeTruthy();
      expect(es[k], `es ${k}`).toBeTruthy();
    }
  });

  it("the editor reorders by button, not by drag alone", () => {
    const src = readFileSync("src/app/(app)/o/[orgId]/board/DashboardBoard.tsx", "utf8");
    expect(src).toMatch(/labels\.moveUp/);
    expect(src).toMatch(/labels\.moveDown/);
    expect(src).not.toMatch(/onDragStart|draggable/);
    // Feedback for every outcome, announced.
    expect(src).toMatch(/aria-live="polite"/);
    expect(src).toMatch(/labels\.saved/);
    expect(src).toMatch(/errorFailed/);
    // A visible entry point.
    expect(src).toMatch(/data-dashboard-edit/);
  });

  it("only shown widgets are rendered, and permission is re-checked before each read", () => {
    const src = readFileSync("src/app/(app)/o/[orgId]/board/widgets.tsx", "utf8");
    expect(src).toMatch(/if \(!can\(inp\.archetype, WIDGETS\[key\]\.action\)\) return;/);
    const page = readFileSync("src/app/(app)/o/[orgId]/page.tsx", "utf8");
    expect(page).toMatch(/shownKeys\.some\(\(k\) => ADAPTIVE_WIDGETS\.has\(k\)\)/);
    expect(page).toMatch(/renderWidgets\(shownKeys/);
  });

  it("the migration scopes the table to org AND user with column-scoped update", () => {
    const sql = readFileSync("supabase/migrations/0141_user_dashboard_pref.sql", "utf8");
    expect(
      sql.match(/user_id = \(select app\.current_user_id\(\)\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
    expect(sql).toMatch(/grant update \(layout, updated_at\)/);
    expect(sql).not.toMatch(/grant delete/);
    expect(sql).toMatch(/enable row level security/);
  });
});
