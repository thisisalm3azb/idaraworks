/**
 * Security review 2026-09-20 (F-25): author-supplied form field patterns are
 * checked for catastrophic backtracking before they are saved or run, and are
 * only ever tested against a bounded slice of input.
 */
import { describe, expect, it } from "vitest";
import { checkPattern, MAX_PATTERN_INPUT, testPattern } from "@/modules/docstudio/patterns";
import { FieldBlock } from "@/modules/docstudio/types";

const CATASTROPHIC = [
  "(a+)+$",
  "^(a|aa)+$",
  "(\\d*)*x",
  "^(\\w+\\s?)*$",
  "(x+x+)+y",
  "([a-z]+)*@",
  "^(a?){20}$",
  "(a)\\1",
  "(?=a)a+",
  "(?<!b)a",
  "([a-z]+|[0-9]+)+",
];

const ORDINARY = [
  "^\\d{3}-\\d{4}$",
  "^[A-Z]{2}\\d{6}$",
  "^\\+?[0-9 ]{7,15}$",
  "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$",
  "^(AE|SA|OM)-[0-9]{4}$",
  "^[^\\s]+$",
  "^(yes|no)$",
  "^\\p{L}+$",
  "",
];

describe("checkPattern", () => {
  it("refuses every known catastrophic shape", () => {
    for (const p of CATASTROPHIC) {
      expect(checkPattern(p).ok, `should refuse ${p}`).toBe(false);
    }
  });

  it("accepts the patterns a form author actually writes", () => {
    for (const p of ORDINARY) {
      expect(checkPattern(p), `should accept ${p}`).toEqual({ ok: true });
    }
  });

  it("refuses a pattern that does not compile or is too long", () => {
    expect(checkPattern("([a-z").ok).toBe(false);
    expect(checkPattern("a{2,1}").ok).toBe(false);
    expect(checkPattern("a".repeat(201)).ok).toBe(false);
  });
});

describe("testPattern", () => {
  it("evaluates an accepted pattern in bounded time on the largest input it will see", () => {
    const value = "a".repeat(MAX_PATTERN_INPUT);
    const started = performance.now();
    expect(testPattern("^[a-z]+$", value)).toBe(true);
    expect(testPattern("^\\d+$", value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("never runs a refused pattern, even against hostile input", () => {
    const hostile = "a".repeat(40) + "!";
    const started = performance.now();
    // A legacy row could still hold such a pattern; it must not be executed.
    expect(testPattern("(a+)+$", hostile)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("reports input beyond the bound as not matching rather than testing it", () => {
    expect(testPattern("^a+$", "a".repeat(MAX_PATTERN_INPUT + 1))).toBe(false);
    expect(testPattern("^a+$", "a".repeat(MAX_PATTERN_INPUT))).toBe(true);
  });
});

describe("the field schema", () => {
  const base = { id: "f1", type: "field", key: "ref", kind: "text", label: { en: "Ref" } };

  it("refuses a catastrophic pattern at save time with a clear message", () => {
    const parsed = FieldBlock.safeParse({ ...base, pattern: "(a+)+$" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /pattern is not allowed/.test(i.message))).toBe(true);
    }
  });

  it("accepts an ordinary pattern", () => {
    expect(FieldBlock.safeParse({ ...base, pattern: "^[A-Z]{2}\\d{6}$" }).success).toBe(true);
  });
});
