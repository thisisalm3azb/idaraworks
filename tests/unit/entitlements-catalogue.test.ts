import { describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLAN_KEYS,
  DEFAULT_PLAN,
  isFeatureKey,
  isLimitKey,
} from "@/platform/entitlements";

describe("entitlement catalogue (code source of truth)", () => {
  it("feature and limit keys are each unique", () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    expect(new Set(LIMIT_KEYS).size).toBe(LIMIT_KEYS.length);
  });

  it("feature and limit key spaces are disjoint", () => {
    const overlap = FEATURE_KEYS.filter((k) => (LIMIT_KEYS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it("feature keys are cap.* or feat.*, limit keys are limit.*", () => {
    for (const k of FEATURE_KEYS) expect(k).toMatch(/^(cap|feat)\./);
    for (const k of LIMIT_KEYS) expect(k).toMatch(/^limit\./);
  });

  it("field/viewer seats and core loop capabilities are in the catalogue", () => {
    expect(LIMIT_KEYS).toContain("limit.field_users");
    expect(LIMIT_KEYS).toContain("limit.viewer_users");
    expect(FEATURE_KEYS).toContain("cap.daily_reports");
    // week_plan was cut (F-15) — no such capability key
    expect(FEATURE_KEYS).not.toContain("cap.week_plan");
  });

  it("type guards agree with the key lists", () => {
    for (const k of FEATURE_KEYS) {
      expect(isFeatureKey(k)).toBe(true);
      expect(isLimitKey(k)).toBe(false);
    }
    for (const k of LIMIT_KEYS) {
      expect(isLimitKey(k)).toBe(true);
      expect(isFeatureKey(k)).toBe(false);
    }
    expect(isFeatureKey("nope.nope")).toBe(false);
    expect(isLimitKey("nope.nope")).toBe(false);
  });

  it("default plan is a known plan", () => {
    expect(PLAN_KEYS).toContain(DEFAULT_PLAN);
  });
});
