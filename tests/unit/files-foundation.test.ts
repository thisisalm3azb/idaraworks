/**
 * Pure Phase E foundations: path convention, class-map ⇔ matrix parity,
 * quota decision math, client-side geometry + retry schedule.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildObjectPath, parseObjectPath, extForMime } from "@/platform/files/paths";
import { CLASS_MAP, BUCKET_MAX_BYTES } from "@/platform/files/classmap";
import { canAccessFileClass } from "@/platform/files/access";
import { evaluateQuota, QUOTA_WARN_RATIO } from "@/platform/files/storage";
import { FILE_ACCESS_CLASSES, MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import { fitWithin } from "@/platform/ui/upload/compress";
import { MAX_UPLOAD_ATTEMPTS, retryDelayMs, shouldRetry } from "@/platform/ui/upload/backoff";

describe("object path convention", () => {
  const parts = {
    orgId: randomUUID(),
    accessClass: "job_media" as const,
    attachedToType: "daily_report",
    attachedToId: randomUUID(),
    fileId: randomUUID(),
    ext: "jpg",
  };

  it("round-trips build → parse for every variant", () => {
    for (const variant of [undefined, "orig", "thumb", "medium"] as const) {
      const path = buildObjectPath({ ...parts, variant });
      const parsed = parseObjectPath(path);
      expect(parsed).not.toBeNull();
      expect(parsed!.orgId).toBe(parts.orgId);
      expect(parsed!.accessClass).toBe("job_media");
      expect(parsed!.fileId).toBe(parts.fileId);
      expect(parsed!.variant).toBe(variant ?? null);
      expect(parsed!.ext).toBe("jpg");
      expect(path.startsWith(`${parts.orgId}/`)).toBe(true); // org prefix is load-bearing
    }
  });

  it("rejects non-UUID parts and traversal shapes", () => {
    expect(() => buildObjectPath({ ...parts, orgId: "../evil" })).toThrow();
    expect(() => buildObjectPath({ ...parts, fileId: "not-a-uuid" })).toThrow();
    expect(() => buildObjectPath({ ...parts, ext: "j/p" })).toThrow();
    expect(parseObjectPath("a/b/c")).toBeNull();
    expect(
      parseObjectPath(`${parts.orgId}/job_media/x/${parts.attachedToId}/evil.exe.jpg`),
    ).toBeNull();
  });

  it("maps accepted mimes to extensions and refuses the rest", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("application/pdf")).toBeNull(); // documents land S4
    expect(extForMime("image/svg+xml")).toBeNull(); // scriptable — never accepted
  });
});

describe("class map shape + access rule", () => {
  it("every class is mapped with a valid bucket", () => {
    for (const cls of FILE_ACCESS_CLASSES) {
      const spec = CLASS_MAP[cls];
      expect(spec, `class ${cls} missing from CLASS_MAP`).toBeDefined();
      expect(BUCKET_MAX_BYTES[spec.bucket]).toBeGreaterThan(0);
    }
  });

  it("customer_share has no member path (S5 mints it) — always denied", () => {
    expect(CLASS_MAP.customer_share.hasMemberPath).toBe(false);
    for (const a of MVP_GRANTABLE_ARCHETYPES) {
      expect(canAccessFileClass(a, true, "customer_share", true)).toBe(false);
      expect(canAccessFileClass(a, true, "customer_share", false)).toBe(false);
    }
  });

  it("originals are retained only for financial_doc and hr_doc (Appendix A)", () => {
    expect(CLASS_MAP.job_media.retainOriginal).toBe(false);
    expect(CLASS_MAP.customer_share.retainOriginal).toBe(false);
    expect(CLASS_MAP.financial_doc.retainOriginal).toBe(true);
    expect(CLASS_MAP.hr_doc.retainOriginal).toBe(true);
  });

  it("financial_doc READ tracks the finance.viewPrices FLAG, not the archetype (review CM1)", () => {
    // A manager with the flag toggled ON can read; the same manager with it OFF
    // cannot — the whole point of the D-6.2 rule the review caught.
    expect(canAccessFileClass("manager", true, "financial_doc", false)).toBe(true);
    expect(canAccessFileClass("manager", false, "financial_doc", false)).toBe(false);
    // …while an accounts role with the flag OFF is likewise denied (flag, not rank).
    expect(canAccessFileClass("accounts", false, "financial_doc", false)).toBe(false);
    expect(canAccessFileClass("accounts", true, "financial_doc", false)).toBe(true);
  });

  it("job_media read is any active member; write is the field/office roles", () => {
    for (const a of MVP_GRANTABLE_ARCHETYPES) {
      expect(canAccessFileClass(a, false, "job_media", false)).toBe(true);
    }
    expect(canAccessFileClass("foreman", false, "job_media", true)).toBe(true);
    expect(canAccessFileClass("viewer", false, "job_media", true)).toBe(false);
  });

  it("hr_doc is owner/admin only (both directions)", () => {
    for (const write of [true, false]) {
      expect(canAccessFileClass("owner", false, "hr_doc", write)).toBe(true);
      expect(canAccessFileClass("admin", false, "hr_doc", write)).toBe(true);
      expect(canAccessFileClass("manager", true, "hr_doc", write)).toBe(false);
    }
  });
});

describe("quota decision (doc 10 #39: warn 80, block 100, never reads)", () => {
  const limit = 100 * 1024 ** 3;

  it("unlimited plan always allows and never warns", () => {
    const q = evaluateQuota(999 * 1024 ** 3, null, 1024);
    expect(q.allowed).toBe(true);
    expect(q.warn).toBe(false);
    expect(q.limitBytes).toBeNull();
  });

  it("warns at exactly the 80% boundary", () => {
    expect(evaluateQuota(limit * QUOTA_WARN_RATIO - 1, limit, 0).warn).toBe(false);
    expect(evaluateQuota(limit * QUOTA_WARN_RATIO, limit, 0).warn).toBe(true);
  });

  it("blocks the add that would cross 100%, allows the one that exactly fills", () => {
    expect(evaluateQuota(limit - 10, limit, 10).allowed).toBe(true);
    expect(evaluateQuota(limit - 10, limit, 11).allowed).toBe(false);
    expect(evaluateQuota(limit, limit, 1).allowed).toBe(false);
  });

  it("a zero limit blocks all adds", () => {
    expect(evaluateQuota(0, 0, 1).allowed).toBe(false);
  });
});

describe("client upload pieces", () => {
  it("fitWithin scales the longest edge and never enlarges", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(() => fitWithin(0, 100, 2048)).toThrow();
  });

  it("retry schedule: 3 attempts, exponential capped backoff", () => {
    expect(MAX_UPLOAD_ATTEMPTS).toBe(3);
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(10)).toBe(8000); // cap
    expect(shouldRetry(2)).toBe(true);
    expect(shouldRetry(3)).toBe(false);
  });
});
