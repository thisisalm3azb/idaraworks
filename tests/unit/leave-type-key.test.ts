/** D2: the leave-type key is derived from the English name, in the shape the service accepts. */
import { describe, expect, it } from "vitest";
import { leaveTypeErrorCode, leaveTypeKeyFrom } from "@/modules/hr/leave";

const SHAPE = /^[a-z][a-z0-9_]{1,39}$/;

describe("leaveTypeKeyFrom", () => {
  it("turns a name into a stable key", () => {
    expect(leaveTypeKeyFrom("Annual leave")).toBe("annual_leave");
    expect(leaveTypeKeyFrom("  Sick Leave (paid) ")).toBe("sick_leave_paid");
    expect(leaveTypeKeyFrom("Hajj")).toBe("hajj");
  });

  it("always satisfies the service's key shape", () => {
    for (const name of [
      "Annual leave",
      "2 days compassionate",
      "Study-leave / exams",
      "A",
      "___",
      "إجازة",
      "x".repeat(120),
      "Maternity & paternity leave for the whole extended family",
    ])
      expect(leaveTypeKeyFrom(name), name).toMatch(SHAPE);
  });

  it("never starts with a digit and never ends with an underscore", () => {
    expect(leaveTypeKeyFrom("2 days")).toBe("leave_2_days");
    expect(leaveTypeKeyFrom("Overtime--")).toBe("overtime");
    expect(leaveTypeKeyFrom("")).toBe("leave_type");
  });
});

describe("leaveTypeErrorCode", () => {
  it("recognises the unique-key violation even when the driver error is wrapped as a cause", () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "leave_type_key_uq"'),
      { code: "23505" },
    );
    const wrapped = Object.assign(new Error("Failed query: insert into public.leave_type ..."), {
      cause: pg,
    });
    expect(leaveTypeErrorCode(wrapped)).toBe("type_exists");
    expect(leaveTypeErrorCode(pg)).toBe("type_exists");
    expect(
      leaveTypeErrorCode(Object.assign(new Error("leave type exists"), { code: "duplicate" })),
    ).toBe("type_exists");
  });

  it("maps validation failures and leaves the rest generic", () => {
    expect(leaveTypeErrorCode(Object.assign(new Error("bad input"), { name: "ZodError" }))).toBe(
      "type_invalid",
    );
    expect(leaveTypeErrorCode(new Error("connection reset"))).toBe("failed");
    expect(leaveTypeErrorCode(null)).toBe("failed");
  });
});
