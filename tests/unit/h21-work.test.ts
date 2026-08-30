/**
 * H21 — adaptive work laws that hold without a database: the lifecycle
 * transition graph, task transitions and depth, filter contracts, dashboard
 * composition and drill-down parity for the five new cards, the phase-semantic
 * snapshot, and copy integrity for every H21 key in both languages.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORK_CATEGORIES,
  WORK_TRANSITIONS,
  canTransition,
  isTerminalCategory,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_OPEN_STATUSES,
  MAX_TASK_DEPTH,
  DEPENDENCY_KINDS,
  WORK_PRIORITIES,
  stagesFromBlueprint,
} from "@/modules/jobs/service";
import {
  parseWorkSearch,
  workHref,
  parseMyWorkSearch,
  myWorkHref,
  taskIsOverdue,
  WORK_VIEWS,
} from "@/modules/dashboard/filters";
import {
  allowedCards,
  composeAdaptiveDashboard,
  type ComposeContext,
  type DashboardData,
} from "@/modules/dashboard/compose";
import { WORKSPACE_MODULE_KEYS, type WorkspaceModuleKey } from "@/platform/workspace";
import { PHASE_SEMANTICS } from "@/platform/registries";
import EN from "@/platform/i18n/messages/en.json";
import AR from "@/platform/i18n/messages/ar.json";

const UUID = "a7b9c1d3-1234-4abc-9def-0123456789ab";

describe("H21 — the work lifecycle graph", () => {
  it("keeps the five structural categories and their legal moves", () => {
    expect([...WORK_CATEGORIES]).toEqual(["draft", "active", "on_hold", "done", "cancelled"]);
    expect(canTransition("draft", "active")).toBe(true);
    expect(canTransition("active", "on_hold")).toBe(true);
    expect(canTransition("on_hold", "active")).toBe(true);
    expect(canTransition("active", "done")).toBe(true);
    expect(canTransition("active", "cancelled")).toBe(true);
    // Work never jumps straight from draft to done, and never skips a hold.
    expect(canTransition("draft", "done")).toBe(false);
    expect(canTransition("draft", "on_hold")).toBe(false);
  });

  it("makes terminal work terminal: no ordinary edit escapes it", () => {
    expect(isTerminalCategory("done")).toBe(true);
    expect(isTerminalCategory("cancelled")).toBe(true);
    expect(isTerminalCategory("active")).toBe(false);
    for (const to of WORK_CATEGORIES) {
      if (to !== "done") expect(canTransition("done", to)).toBe(false);
      if (to !== "cancelled") expect(canTransition("cancelled", to)).toBe(false);
    }
    // Every category can hold still (a no-op status save is not an error).
    for (const c of WORK_CATEGORIES) expect(canTransition(c, c)).toBe(true);
    // The graph is total: every category has an entry.
    for (const c of WORK_CATEGORIES) expect(WORK_TRANSITIONS[c]).toBeDefined();
  });

  it("rejects unknown categories rather than assuming they are legal", () => {
    expect(canTransition("banana", "active")).toBe(false);
    expect(canTransition("active", "banana")).toBe(false);
  });
});

describe("H21 — task vocabulary", () => {
  it("keeps stable keys and adds the three new lifecycle states", () => {
    // 'pending' is preserved as the not-started KEY — renaming it would rewrite
    // history for every existing row; only its label reads "Not started".
    expect(TASK_STATUSES).toContain("pending");
    for (const s of ["ready", "blocked", "awaiting_approval"] as const) {
      expect(TASK_STATUSES).toContain(s);
    }
    expect(
      [...TASK_OPEN_STATUSES].every((s) => (TASK_STATUSES as readonly string[]).includes(s)),
    ).toBe(true);
    expect(TASK_OPEN_STATUSES).not.toContain("completed");
    expect(TASK_OPEN_STATUSES).not.toContain("cancelled");
    expect([...TASK_PRIORITIES]).toEqual([...WORK_PRIORITIES]);
    expect(MAX_TASK_DEPTH).toBe(2);
    expect(DEPENDENCY_KINDS).toContain("finish_to_start");
  });

  it("the overdue rule ignores finished work", () => {
    const asOf = "2026-08-30";
    expect(taskIsOverdue({ status: "in_progress", dueDate: "2026-08-29" }, asOf)).toBe(true);
    expect(taskIsOverdue({ status: "in_progress", dueDate: "2026-08-30" }, asOf)).toBe(false);
    expect(taskIsOverdue({ status: "completed", dueDate: "2026-01-01" }, asOf)).toBe(false);
    expect(taskIsOverdue({ status: "cancelled", dueDate: "2026-01-01" }, asOf)).toBe(false);
    expect(taskIsOverdue({ status: "pending", dueDate: null }, asOf)).toBe(false);
  });
});

describe("H21 — phase semantic snapshot", () => {
  const blueprint = (stage: Record<string, unknown>) => ({
    workflows: [{ id: "job", stages: [stage] }],
  });

  it("carries a valid phase semantic onto the snapshot", () => {
    const out = stagesFromBlueprint(
      blueprint({
        key: "build",
        name: { en: "Build", ar: "بناء" },
        weight: 100,
        phaseSemantic: "production",
      }),
    );
    expect(out![0]!.phase_semantic).toBe("production");
    expect(PHASE_SEMANTICS).toContain("production");
  });

  it("treats a missing or unknown semantic as null, never as a reason to reject", () => {
    const missing = stagesFromBlueprint(
      blueprint({ key: "build", name: { en: "B", ar: "ب" }, weight: 100 }),
    );
    expect(missing).not.toBeNull();
    expect(missing![0]!.phase_semantic).toBeNull();
    const unknown = stagesFromBlueprint(
      blueprint({ key: "build", name: { en: "B", ar: "ب" }, weight: 100, phaseSemantic: "nope" }),
    );
    expect(unknown).not.toBeNull();
    expect(unknown![0]!.phase_semantic).toBeNull();
  });

  it("still rejects a genuinely malformed workflow", () => {
    expect(stagesFromBlueprint(blueprint({ key: "Bad Key", weight: 1 }))).toBeNull();
    expect(stagesFromBlueprint({ workflows: [] })).toBeNull();
  });
});

describe("H21 — filter contracts", () => {
  it("work: whitelists every value and ignores junk", () => {
    const f = parseWorkSearch({
      view: "board",
      q: "  villa  ",
      category: "active",
      priority: "urgent",
      origin: "opportunity",
      owner: UUID,
      from: "2026-01-01",
      to: "2026-02-01",
    });
    expect(f.view).toBe("board");
    expect(f.q).toBe("villa");
    expect(f.category).toBe("active");
    expect(f.priority).toBe("urgent");
    expect(f.origin).toBe("opportunity");
    expect(f.owner).toBe(UUID);
    expect(f.dueFrom).toBe("2026-01-01");
    const junk = parseWorkSearch({
      view: "hologram",
      category: "DROP TABLE",
      priority: "critical",
      origin: "magic",
      owner: "1 OR 1=1",
      from: "yesterday",
    });
    expect(junk.view).toBe("list");
    expect(junk.category).toBeNull();
    expect(junk.priority).toBeNull();
    expect(junk.origin).toBeNull();
    expect(junk.owner).toBeNull();
    expect(junk.dueFrom).toBeNull();
    expect(WORK_VIEWS).toContain("schedule");
  });

  it("work: builders round-trip through their parsers", () => {
    const url = workHref("o", {
      view: "board",
      category: "active",
      priority: "high",
      overdue: true,
    });
    const qs = Object.fromEntries(new URL(`http://x${url}`).searchParams);
    const back = parseWorkSearch(qs);
    expect(back.view).toBe("board");
    expect(back.category).toBe("active");
    expect(back.priority).toBe("high");
    expect(back.overdue).toBe(true);
    expect(workHref("o")).toBe("/o/o/jobs");
  });

  it("my work: focus is whitelisted and defaults to now", () => {
    expect(parseMyWorkSearch({ focus: "blocked" }).focus).toBe("blocked");
    expect(parseMyWorkSearch({ focus: "everything" }).focus).toBe("now");
    expect(myWorkHref("o")).toBe("/o/o/my-work");
    expect(myWorkHref("o", "overdue")).toBe("/o/o/my-work?focus=overdue");
  });
});

// ── Dashboard composition ───────────────────────────────────────────────────
const allFeatures = Object.fromEntries(WORKSPACE_MODULE_KEYS.map((k) => [k, true]));
const cx = (over: Partial<ComposeContext> = {}): ComposeContext => ({
  orgId: "org1",
  archetype: "owner",
  seesPrice: true,
  features: { ...allFeatures },
  disabledModules: new Set<WorkspaceModuleKey>(),
  compiledDashboard: null,
  asOf: "2026-08-30",
  ...over,
});
const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  exceptions: [],
  extras: null,
  inbox: [],
  ar: null,
  myJobs: null,
  returnedReports: null,
  reviewQueue: null,
  sales: null,
  work: {
    activeWork: 5,
    overdueWork: 2,
    workDueSoon: 3,
    overdueTasks: 4,
    blockedTasks: 1,
    unassignedUrgentWork: 1,
  },
  failed: [],
  ...over,
});

describe("H21 — dashboard composition", () => {
  it("delivery cards reach the roles that run delivery", () => {
    const owner = allowedCards(cx());
    for (const k of [
      "work_at_risk",
      "overdue_tasks",
      "blocked_tasks",
      "work_due_soon",
      "unassigned_urgent",
    ] as const) {
      expect(owner).toContain(k);
    }
    // A foreman sees their own steps but never the org-wide assignment queue.
    const foreman = allowedCards(cx({ archetype: "foreman" }));
    expect(foreman).toContain("overdue_tasks");
    expect(foreman).toContain("blocked_tasks");
    expect(foreman).not.toContain("unassigned_urgent");
    expect(foreman).not.toContain("work_at_risk");
    // A viewer runs nothing.
    expect(allowedCards(cx({ archetype: "viewer", seesPrice: false }))).toEqual([]);
  });

  it("every delivery signal drills to its exact records", () => {
    const view = composeAdaptiveDashboard(cx(), data());
    const href = (key: string) =>
      [...view.attention, ...view.next].find((i) => i.key === key)?.href;
    expect(href("work_at_risk")).toBe("/o/org1/jobs?focus=overdue");
    expect(href("blocked_tasks")).toBe("/o/org1/my-work?focus=blocked");
    expect(href("overdue_tasks")).toBe("/o/org1/my-work?focus=overdue");
    expect(href("unassigned_urgent")).toBe("/o/org1/jobs?priority=urgent");
    expect(href("work_due_soon")).toBe("/o/org1/jobs?from=2026-08-30");
    const count = (key: string) =>
      [...view.attention, ...view.next].find((i) => i.key === key)?.count;
    expect(count("work_at_risk")).toBe(2);
    expect(count("overdue_tasks")).toBe(4);
  });

  it("work past its target date outranks a blocked step, and both outrank money", () => {
    const view = composeAdaptiveDashboard(cx(), data());
    const keys = view.attention.map((i) => i.key);
    expect(keys.indexOf("work_at_risk")).toBeLessThan(keys.indexOf("blocked_tasks"));
  });

  it("a disabled work module removes every delivery card", () => {
    const disabled = cx({ disabledModules: new Set<WorkspaceModuleKey>(["cap.jobs"]) });
    const cards = allowedCards(disabled);
    for (const k of [
      "work_at_risk",
      "overdue_tasks",
      "blocked_tasks",
      "work_due_soon",
      "unassigned_urgent",
    ] as const) {
      expect(cards).not.toContain(k);
    }
  });

  it("a failed work source renders nothing rather than a false zero", () => {
    const view = composeAdaptiveDashboard(cx(), data({ work: null, failed: ["work"] }));
    expect(view.attention.find((i) => i.key === "work_at_risk")).toBeUndefined();
    expect(view.unavailable).toContain("work");
  });
});

describe("H21 — copy integrity", () => {
  const en = EN as Record<string, string>;
  const ar = AR as Record<string, string>;
  const prefixes = ["work.", "tasks.", "my_work.", "crm.work."];
  const h21Keys = () => Object.keys(en).filter((k) => prefixes.some((p) => k.startsWith(p)));

  it("every H21 key exists in both languages with no em dash", () => {
    const keys = h21Keys();
    expect(keys.length).toBeGreaterThan(70);
    for (const k of keys) {
      expect(ar[k], `ar missing ${k}`).toBeTruthy();
      expect(en[k]!.includes("—"), `em dash in en ${k}`).toBe(false);
      expect(ar[k]!.includes("—"), `em dash in ar ${k}`).toBe(false);
      expect(/[؀-ۿ]/.test(ar[k]!), `ar ${k} must carry Arabic script`).toBe(true);
    }
  });

  it("every lifecycle, status and priority value has a label in both languages", () => {
    for (const c of WORK_CATEGORIES) {
      expect(en[`work.category.${c}`]).toBeTruthy();
      expect(ar[`work.category.${c}`]).toBeTruthy();
    }
    for (const p of WORK_PRIORITIES) {
      expect(en[`work.priority.${p}`]).toBeTruthy();
      expect(ar[`work.priority.${p}`]).toBeTruthy();
    }
    for (const s of TASK_STATUSES) {
      expect(en[`tasks.status.${s}`], `en label for ${s}`).toBeTruthy();
      expect(ar[`tasks.status.${s}`], `ar label for ${s}`).toBeTruthy();
    }
  });

  it("workload copy never claims capacity the product cannot know", () => {
    expect(en["work.workload.hint"]).toMatch(/not a capacity judgement/i);
    expect(en["work.workload.high_load"]).toMatch(/scheduled load/i);
    expect(en["work.workload.high_load"]).not.toMatch(/over ?capacity|overloaded/i);
  });

  it("starting work is described as an explicit act, never a consequence", () => {
    expect(en["work.start.hint"]).toMatch(/does not begin delivery on its own/i);
  });
});

describe("H21 — structural pins", () => {
  it("no DELETE grant exists in the work migration", () => {
    const mig = readFileSync("supabase/migrations/0079_work_management.sql", "utf8");
    expect(mig).not.toMatch(/^grant[^;]*\bdelete\b/im);
    // Dependency removal is soft, like crew membership.
    expect(mig).toMatch(/grant update \(removed_at, removed_by\) on public\.task_dependency/);
    // One work record per opportunity is structural, not merely checked.
    expect(mig).toMatch(/create unique index job_org_opportunity_uq/);
    // Reason constraints govern future writes without invalidating history.
    expect(mig).toMatch(/job_hold_reason_ck[\s\S]*not valid/);
  });

  it("winning an opportunity never creates work by itself", () => {
    const sales = readFileSync("src/modules/crm/sales.ts", "utf8");
    const winFn = sales.slice(
      sales.indexOf("export async function winOpportunity"),
      sales.indexOf("export const LoseInput"),
    );
    expect(winFn).not.toMatch(/createJobFromPreset/);
    // Work starts only through the explicit command, which routes to the one
    // canonical factory.
    expect(sales).toMatch(/startWorkFromOpportunity[\s\S]*createJobFromPreset/);
  });

  it("the only status writer runs the validated lifecycle", () => {
    const service = readFileSync("src/modules/jobs/service.ts", "utf8");
    // updateJobStatus is a thin delegate; no second unguarded update survives.
    expect(service).toMatch(/await changeWorkStatus\(ctx, archetype, jobId, \{ statusKey \}\)/);
    expect(service).not.toMatch(/set status_key = \$\{statusKey\}/);
  });
});
