/**
 * S7 "Improve" pure-unit coverage: the numbers-subset validator (anti-hallucination), the
 * deterministic per-org stagger, and the watermark derivative (EXIF-stripped, re-encoded).
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  normalizeNumerals,
  extractNumbers,
  validateNumbersSubset,
} from "@/platform/ai/numbers-subset";
import { computeStaggerSeconds } from "@/workers/functions/exception-engine";
import { watermarkImage } from "@/platform/media/watermark";
import { getNarrationProvider } from "@/platform/ai/adapter";
import { buildNarrationInputs, type DigestPayload } from "@/modules/digest/service";
import { clientIpFromHeaders } from "@/platform/http/clientIp";

describe("numbers-subset validator (review #AI-hallucination)", () => {
  it("normalises Arabic-Indic + extended digits to Latin", () => {
    expect(normalizeNumerals("٤٢ و ۹۹")).toBe("42 و 99");
  });

  it("extracts numbers across separators / percent / Arabic digits", () => {
    expect(extractNumbers("You have 3 overdue and 10,500 due (42%).")).toEqual([3, 10500, 42]);
    expect(extractNumbers("لديك ٣ متأخرة و ١٠٬٥٠٠")).toEqual([3, 10500]);
  });

  it("PASSES when every narration number is in the payload allow-list", () => {
    const r = validateNumbersSubset("3 items, 10,500 outstanding, 42% done", [3, 10500, 42]);
    expect(r.ok).toBe(true);
  });

  it("FAILS on an invented number (the hallucination guard)", () => {
    const r = validateNumbersSubset("You owe 99999 across 3 invoices", [3, 10500]);
    expect(r.ok).toBe(false);
    expect(r.offending).toContain(99999);
  });

  it("prose with no numbers trivially passes", () => {
    expect(validateNumbersSubset("Everything looks on track today.", []).ok).toBe(true);
  });

  // Regression — review finding #2 (fail-OPEN). The old token class [\d,.٫٬]* greedily ate a
  // trailing '.', canonicalize() then returned null, and the token was SILENTLY DROPPED — a
  // hallucinated sentence-final number was never checked. It must now be caught (fail closed).
  it("catches a hallucinated sentence-FINAL number (trailing dot no longer swallowed)", () => {
    const r = validateNumbersSubset("Progress reached 87.", [3, 10500]);
    expect(r.ok).toBe(false);
    expect(r.offending).toContain(87);
  });

  it("a legitimate sentence-final allowed number still passes (dot dropped, value kept)", () => {
    expect(validateNumbersSubset("You have 3.", [3]).ok).toBe(true);
  });

  it("a genuine decimal that is NOT in the allow-list is caught", () => {
    const r = validateNumbersSubset("Margin is 42.5% this week", [3, 10500]);
    expect(r.ok).toBe(false);
    expect(r.offending).toContain(42.5);
  });

  it("a genuine decimal that IS in the allow-list passes", () => {
    expect(validateNumbersSubset("Margin is 42.5% this week", [42.5]).ok).toBe(true);
  });
});

describe("digest narration inputs (review #1 — money must never enter narration)", () => {
  const payload: DigestPayload = {
    audience: "owner",
    computedAt: "2026-07-14T00:00:00.000Z",
    sections: [
      {
        key: "collections",
        labelKey: "digest.section.collections",
        count: 4,
        moneyMinor: 987654321, // a large AR figure — must NOT reach the model or the allow-list
        items: [],
      },
      {
        key: "at_risk",
        labelKey: "digest.section.at_risk",
        count: 12,
        moneyMinor: null,
        items: [],
      },
      { key: "crew", labelKey: "digest.section.crew", count: 0, moneyMinor: null, items: [] },
    ],
    numbers: [4, 987654321, 12],
  };

  it("request items carry section COUNTS only — no money figure crosses into the model", () => {
    const { req } = buildNarrationInputs(payload, "en", (k) => k);
    const numbersSent = req.items.flatMap((i) => i.numbers);
    expect(numbersSent).not.toContain(987654321);
    expect(numbersSent).toEqual([4, 12]); // zero-count sections dropped; money excluded
  });

  it("allow-list is counts only, so the validator would REJECT the money figure as offending", () => {
    const { allowed } = buildNarrationInputs(payload, "en", (k) => k);
    expect(allowed).not.toContain(987654321);
    // A narration that tried to state the AR money value fails numbers-subset → deterministic fallback.
    expect(validateNumbersSubset("Outstanding is 9876543.21", allowed).ok).toBe(false);
  });
});

describe("clientIpFromHeaders (review #3 — share-page rate-limit key is not spoofable)", () => {
  it("prefers the platform-trusted header over a spoofed x-forwarded-for", () => {
    const h = new Headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2", // attacker-controlled — must be ignored
    });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.7");
  });

  it("falls back through true-client-ip → xff → x-real-ip → constant", () => {
    expect(clientIpFromHeaders(new Headers({ "true-client-ip": "198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": " 9.9.9.9 , 8.8.8.8" }))).toBe(
      "9.9.9.9",
    );
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
    // No IP headers → a CONSTANT key (still throttles; never a per-request-unique value).
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("computeStaggerSeconds (nightly de-herd)", () => {
  it("is deterministic and bounded within the window", () => {
    const w = 240;
    const a = computeStaggerSeconds("11111111-1111-1111-1111-111111111111", w);
    const b = computeStaggerSeconds("11111111-1111-1111-1111-111111111111", w);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(w * 60);
  });

  it("spreads distinct orgs across the window (not all at 0)", () => {
    const offsets = Array.from({ length: 50 }, (_, i) =>
      computeStaggerSeconds(`org-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, 240),
    );
    const distinct = new Set(offsets);
    expect(distinct.size).toBeGreaterThan(20); // meaningfully spread, not herded
  });
});

describe("watermarkImage (customer-safe derivative)", () => {
  it("produces a valid re-encoded JPEG derivative without input metadata", async () => {
    // A source JPEG carrying EXIF (orientation) — sharp must NOT copy it to the output.
    const src = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 80, b: 160 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const out = await watermarkImage(src, "Alpha Marine • preview");
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI marker
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(1600); // downsized within bound
    expect(meta.exif).toBeUndefined(); // EXIF/GPS stripped by construction
  });

  it("is deterministic (idempotent derivative for the same input+text)", async () => {
    const src = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const a = await watermarkImage(src, "X");
    const b = await watermarkImage(src, "X");
    expect(a.equals(b)).toBe(true);
  });
});

describe("AI narration adapter seam (disabled-provider fallback)", () => {
  it("returns 'disabled' (no narration) when AI_NARRATION_PROVIDER=disabled", async () => {
    const prev = process.env.AI_NARRATION_PROVIDER;
    process.env.AI_NARRATION_PROVIDER = "disabled";
    try {
      const res = await getNarrationProvider().narrate({ lang: "en", title: "t", items: [] });
      expect(res.status).toBe("disabled");
      expect(res.text).toBeNull();
    } finally {
      process.env.AI_NARRATION_PROVIDER = prev;
    }
  });

  it("fake provider narrates using ONLY payload numbers (passes its own validator)", async () => {
    const prev = process.env.AI_NARRATION_PROVIDER;
    process.env.AI_NARRATION_PROVIDER = "fake";
    try {
      const req = {
        lang: "en" as const,
        title: "Digest",
        items: [{ label: "Overdue", numbers: [3, 10500] }],
      };
      const res = await getNarrationProvider().narrate(req);
      expect(res.status).toBe("generated");
      expect(validateNumbersSubset(res.text!, [3, 10500]).ok).toBe(true);
    } finally {
      process.env.AI_NARRATION_PROVIDER = prev;
    }
  });
});
