import { describe, expect, it } from "vitest";
import { CreateOrgInput, hashInviteToken } from "@/platform/auth/identity";

describe("CreateOrgInput validation", () => {
  it("accepts a valid GCC org and uppercases country", () => {
    const r = CreateOrgInput.parse({
      name: "Najولا Boat Works",
      country: "ae",
      baseCurrency: "AED",
    });
    expect(r.country).toBe("AE");
    expect(r.baseCurrency).toBe("AED");
    expect(r.languages).toEqual(["en"]);
    expect(r.sixDayWeek).toBe(false);
  });

  it("rejects an unsupported currency", () => {
    expect(() =>
      CreateOrgInput.parse({ name: "X Co", country: "AE", baseCurrency: "GBP" }),
    ).toThrow();
  });

  it("rejects too-short names", () => {
    expect(() => CreateOrgInput.parse({ name: "X", country: "AE", baseCurrency: "AED" })).toThrow();
  });
});

describe("invite token hashing", () => {
  it("is deterministic and hex-64 (sha256), never the raw token", () => {
    const h1 = hashInviteToken("abc123");
    const h2 = hashInviteToken("abc123");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain("abc123");
  });

  it("different tokens hash differently", () => {
    expect(hashInviteToken("a")).not.toBe(hashInviteToken("b"));
  });
});
