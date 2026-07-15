/**
 * Password-recovery pure helper (U1 follow-up — the forgot/reset flow):
 * validateNewPassword drives the /reset-password server action's validation.
 */
import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, validateNewPassword } from "@/platform/auth/password";

describe("validateNewPassword", () => {
  it("accepts a matching pair at or above the minimum length", () => {
    expect(validateNewPassword("abcdefghij", "abcdefghij")).toBeNull();
    expect(validateNewPassword("a".repeat(PASSWORD_MIN_LENGTH), "a".repeat(10))).toBeNull();
    expect(validateNewPassword("correct horse battery", "correct horse battery")).toBeNull();
  });

  it("rejects passwords under the minimum length (mirrors the signup rule)", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(validateNewPassword("short", "short")).toBe("too_short");
    expect(validateNewPassword("a".repeat(9), "a".repeat(9))).toBe("too_short");
    expect(validateNewPassword("", "")).toBe("too_short");
  });

  it("rejects a mismatching confirmation", () => {
    expect(validateNewPassword("abcdefghij", "abcdefghiJ")).toBe("mismatch");
    expect(validateNewPassword("abcdefghij", "")).toBe("mismatch");
  });

  it("length is checked before the match (an empty pair is too_short, not a match)", () => {
    expect(validateNewPassword("short", "different")).toBe("too_short");
  });
});
