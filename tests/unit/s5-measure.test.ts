import { describe, it, expect } from "vitest";
import { resolveQuotedMinor } from "@/modules/costing/service";
import {
  isWorkingDay,
  workingDaysBetween,
  weekdayOf,
  type Calendar,
} from "@/platform/calendar/calendar";
import { can } from "@/platform/authz";
import { CreateExpenseInput, VoidExpenseInput } from "@/modules/expenses/service";
import type { RoleArchetype } from "@/platform/registries";

// UAE (mon–fri working, sat–sun weekend) and KSA (sun–thu working) calendars.
const UAE: Calendar = { workingDays: new Set(["mon", "tue", "wed", "thu", "fri"]), holidays: [] };
const KSA: Calendar = { workingDays: new Set(["sun", "mon", "tue", "wed", "thu"]), holidays: [] };
const SIX_DAY: Calendar = {
  workingDays: new Set(["sat", "sun", "mon", "tue", "wed", "thu"]),
  holidays: [],
};

describe("calendar (F-41 working-day math)", () => {
  it("computes weekdays deterministically in UTC", () => {
    expect(weekdayOf("2026-01-01")).toBe("thu");
    expect(weekdayOf("2026-01-02")).toBe("fri");
    expect(weekdayOf("2026-01-03")).toBe("sat");
    expect(weekdayOf("2026-01-04")).toBe("sun");
  });

  it("honours the UAE working week (fri works, sat/sun off)", () => {
    expect(isWorkingDay(UAE, "2026-01-02")).toBe(true); // Fri
    expect(isWorkingDay(UAE, "2026-01-03")).toBe(false); // Sat
    expect(isWorkingDay(UAE, "2026-01-04")).toBe(false); // Sun
  });

  it("honours the KSA working week (fri off, sun works)", () => {
    expect(isWorkingDay(KSA, "2026-01-02")).toBe(false); // Fri
    expect(isWorkingDay(KSA, "2026-01-04")).toBe(true); // Sun
  });

  it("6-day workshop works Saturday", () => {
    expect(isWorkingDay(SIX_DAY, "2026-01-03")).toBe(true); // Sat
  });

  it("Eid/holiday ranges are never working days (no Eid noise storm)", () => {
    const withEid: Calendar = {
      workingDays: UAE.workingDays,
      holidays: [{ start: "2026-03-20", end: "2026-03-24" }],
    };
    // 2026-03-23 is a Monday (a working day) but inside the Eid range.
    expect(weekdayOf("2026-03-23")).toBe("mon");
    expect(isWorkingDay(UAE, "2026-03-23")).toBe(true);
    expect(isWorkingDay(withEid, "2026-03-23")).toBe(false);
  });

  it("counts working days in a gap (Thu → Tue = 3 working days for UAE)", () => {
    expect(workingDaysBetween(UAE, "2026-01-01", "2026-01-06")).toBe(3);
    expect(workingDaysBetween(UAE, "2026-01-06", "2026-01-06")).toBe(0);
    expect(workingDaysBetween(UAE, "2026-01-06", "2026-01-01")).toBe(0);
  });

  it("holidays reduce the working-day count in a gap", () => {
    const withHol: Calendar = {
      workingDays: UAE.workingDays,
      holidays: [{ start: "2026-01-05", end: "2026-01-05" }], // knock out the Monday
    };
    expect(workingDaysBetween(withHol, "2026-01-01", "2026-01-06")).toBe(2);
  });
});

describe("resolveQuotedMinor (C-10 precedence + divergence)", () => {
  it("uses selling price + audited adjustments when there is no accepted quote", () => {
    expect(
      resolveQuotedMinor({
        acceptedQuoteTotalMinor: null,
        sellingPriceMinor: 100000,
        adjustmentsMinor: 0,
      }),
    ).toEqual({ quotedMinor: 100000, divergence: false });
    expect(
      resolveQuotedMinor({
        acceptedQuoteTotalMinor: null,
        sellingPriceMinor: 100000,
        adjustmentsMinor: 5000,
      }),
    ).toEqual({ quotedMinor: 105000, divergence: false });
  });

  it("is null when neither an accepted quote nor a selling price exists", () => {
    expect(
      resolveQuotedMinor({
        acceptedQuoteTotalMinor: null,
        sellingPriceMinor: null,
        adjustmentsMinor: 0,
      }),
    ).toEqual({ quotedMinor: null, divergence: false });
  });

  it("prefers the accepted quote AND flags divergence — never silently picks (owner ruling)", () => {
    const r = resolveQuotedMinor({
      acceptedQuoteTotalMinor: 120000,
      sellingPriceMinor: 100000,
      adjustmentsMinor: 0,
    });
    expect(r.quotedMinor).toBe(120000); // precedence: the accepted quote wins
    expect(r.divergence).toBe(true); // but the conflict is raised, not hidden
  });

  it("no divergence when the accepted quote matches the composite selling price", () => {
    expect(
      resolveQuotedMinor({
        acceptedQuoteTotalMinor: 105000,
        sellingPriceMinor: 100000,
        adjustmentsMinor: 5000,
      }),
    ).toEqual({ quotedMinor: 105000, divergence: false });
  });
});

describe("S5 permission matrix (doc 06 rows 58-59 + Today/exception surfaces)", () => {
  const grid: Record<RoleArchetype, Record<string, boolean>> = {
    owner: {
      "expenses.create": true,
      "expenses.void": true,
      "costing.view": true,
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": true,
    },
    admin: {
      "expenses.create": true,
      "expenses.void": true,
      "costing.view": true,
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": true,
    },
    manager: {
      "expenses.create": true,
      "expenses.void": false,
      "costing.view": true,
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": true,
    },
    foreman: {
      "expenses.create": false,
      "expenses.void": false,
      "costing.view": false,
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": false,
    },
    procurement: {
      "expenses.create": true,
      "expenses.void": false,
      "costing.view": false,
      // S6: procurement gained its own Today screen (approved MRs / open POs).
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": false,
    },
    accounts: {
      "expenses.create": true,
      "expenses.void": true,
      "costing.view": true,
      // S6: accounts gained its own Today screen (invoices to issue / AR / payments).
      "today.view": true,
      "exceptions.view": true,
      "exceptions.dismiss": false,
    },
    viewer: {
      "expenses.create": false,
      "expenses.void": false,
      "costing.view": false,
      // Adversarial-review fix: the viewer now gets a minimal READ-ONLY Today
      // (jobs/week reads it already holds — never money, never queues).
      "today.view": true,
      "exceptions.view": false,
      "exceptions.dismiss": false,
    },
    worker_reserved_p3: {
      "expenses.create": false,
      "expenses.void": false,
      "costing.view": false,
      "today.view": false,
      "exceptions.view": false,
      "exceptions.dismiss": false,
    },
  };

  for (const [archetype, actions] of Object.entries(grid)) {
    for (const [action, expected] of Object.entries(actions)) {
      it(`${archetype} ${action} = ${expected}`, () => {
        expect(can(archetype as RoleArchetype, action as never)).toBe(expected);
      });
    }
  }

  it("foreman NEVER has any money surface (F-23)", () => {
    for (const a of ["expenses.create", "expenses.view", "costing.view"] as const) {
      expect(can("foreman", a)).toBe(false);
    }
  });
});

describe("expense input validation", () => {
  it("accepts a valid job expense and defaults VAT to 0", () => {
    const parsed = CreateExpenseInput.parse({
      jobId: "11111111-1111-4111-8111-111111111111",
      categoryKey: "resin",
      description: "Epoxy resin",
      expenseDate: "2026-07-13",
      amountMinor: 50000,
    });
    expect(parsed.vatAmountMinor).toBe(0);
  });

  it("accepts an overhead expense (no job)", () => {
    const parsed = CreateExpenseInput.parse({
      categoryKey: "rent",
      description: "Workshop rent",
      expenseDate: "2026-07-13",
      amountMinor: 100000,
      vatAmountMinor: 5000,
    });
    expect(parsed.jobId).toBeUndefined();
  });

  it("rejects a negative amount", () => {
    expect(() =>
      CreateExpenseInput.parse({
        categoryKey: "x",
        description: "x",
        expenseDate: "2026-07-13",
        amountMinor: -1,
      }),
    ).toThrow();
  });

  it("void requires a reason", () => {
    expect(() =>
      VoidExpenseInput.parse({ expenseId: "11111111-1111-4111-8111-111111111111", reason: "" }),
    ).toThrow();
  });

  it("there is no poId field on an expense (F-2 disjoint channel is structural)", () => {
    const parsed = CreateExpenseInput.parse({
      categoryKey: "x",
      description: "x",
      expenseDate: "2026-07-13",
      amountMinor: 100,
      // poId is intentionally not part of the schema (F-2 structural): it is stripped.
      poId: "22222222-2222-4222-8222-222222222222",
    } as Record<string, unknown>);
    expect("poId" in parsed).toBe(false);
  });
});
