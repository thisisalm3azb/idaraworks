/**
 * DEFECT 2 — onboarding logo upload. Two things this proves LOCALLY:
 *
 *  1. The full supported/rejected image MATRIX the branding-step stash enforces,
 *     through the SAME pure validators the service uses (validateLogoBytes +
 *     checkLogoDimensions) — the onboarding stash (stashDraftLogo) composes
 *     exactly these. PNG / transparent PNG / JPG / WebP are accepted; SVG,
 *     wrong-MIME, mismatched-signature, corrupt, zero-byte, oversized,
 *     tiny-dims, huge-dims and renamed-non-image are each rejected with the
 *     SPECIFIC code the client maps to a message.
 *
 *  2. sharp actually runs in this Node context: processLogo on a real small PNG
 *     yields a clean PNG buffer. This is the exact native path that fails with
 *     ERR_DLOPEN_FAILED in a serverless function missing the @img libs — the
 *     next.config outputFileTracingIncludes "/onboarding" entry is what ships
 *     them there. (The deployed run is the parent's live-verify.)
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  LOGO_MAX_BYTES,
  checkLogoDimensions,
  validateLogoBytes,
} from "@/modules/branding/validation";
import { processLogo, LOGO_MAX_EDGE_PX, LOGO_THUMB_EDGE_PX } from "@/platform/files/image";

// Real bitmaps built in-memory (no committed binaries), matching the shapes a
// founder would actually upload.
function pngOpaque(w = 256, h = 256): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 12, g: 110, b: 100 } },
  })
    .png()
    .toBuffer();
}
function pngTransparent(w = 256, h = 256): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 12, g: 110, b: 100, alpha: 0.4 } },
  })
    .png()
    .toBuffer();
}
function jpeg(w = 256, h = 256): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 40, g: 40, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}
function webp(w = 256, h = 256): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .webp()
    .toBuffer();
}

/** Full validate: the two walls the stash runs — byte/MIME/signature, then the
 * decoded-dimension bounds (decode via sharp, exactly as stashDraftLogo does). */
async function fullVerdict(
  bytes: Buffer,
  declaredMime: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const v = validateLogoBytes(bytes, declaredMime);
  if (!v.ok) return { ok: false, code: v.error };
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    return { ok: false, code: "bad_image" };
  }
  const dims = checkLogoDimensions(meta.width, meta.height);
  if (dims) return { ok: false, code: dims };
  return { ok: true };
}

describe("onboarding logo — accepted formats", () => {
  it("accepts PNG, transparent PNG, JPG and WebP with agreeing magic bytes", async () => {
    expect(await fullVerdict(await pngOpaque(), "image/png")).toEqual({ ok: true });
    expect(await fullVerdict(await pngTransparent(), "image/png")).toEqual({ ok: true });
    expect(await fullVerdict(await jpeg(), "image/jpeg")).toEqual({ ok: true });
    expect(await fullVerdict(await webp(), "image/webp")).toEqual({ ok: true });
  });
});

describe("onboarding logo — rejected inputs each carry the right code", () => {
  it("SVG is rejected outright (never sniffed, never accepted): bad_type", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`);
    expect(await fullVerdict(svg, "image/svg+xml")).toEqual({ ok: false, code: "bad_type" });
  });

  it("an off-whitelist declared MIME (e.g. GIF) is rejected: bad_type", async () => {
    expect(await fullVerdict(await pngOpaque(), "image/gif")).toEqual({
      ok: false,
      code: "bad_type",
    });
  });

  it("mismatched MIME vs signature (JPEG bytes declared PNG) is rejected: bad_signature", async () => {
    expect(await fullVerdict(await jpeg(), "image/png")).toEqual({
      ok: false,
      code: "bad_signature",
    });
  });

  it("corrupt / non-image bytes declared as an image: bad_signature", async () => {
    expect(await fullVerdict(Buffer.from("not an image at all"), "image/png")).toEqual({
      ok: false,
      code: "bad_signature",
    });
  });

  it("a renamed non-image (a PDF's header sent as image/png) is rejected: bad_signature", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n");
    expect(await fullVerdict(pdf, "image/png")).toEqual({ ok: false, code: "bad_signature" });
  });

  it("zero-byte upload is rejected: bad_signature", async () => {
    expect(await fullVerdict(Buffer.alloc(0), "image/png")).toEqual({
      ok: false,
      code: "bad_signature",
    });
  });

  it("oversized (> 2 MB) is rejected before decode: too_large", async () => {
    const head = await pngOpaque(64, 64);
    const oversized = Buffer.concat([head, Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(await fullVerdict(oversized, "image/png")).toEqual({ ok: false, code: "too_large" });
  });

  it("tiny dimensions (< 32px) are rejected: too_small_dims", async () => {
    expect(await fullVerdict(await pngOpaque(16, 16), "image/png")).toEqual({
      ok: false,
      code: "too_small_dims",
    });
  });

  it("huge dimensions (> 2000px) are rejected: too_large_dims", async () => {
    expect(await fullVerdict(await pngOpaque(2400, 100), "image/png")).toEqual({
      ok: false,
      code: "too_large_dims",
    });
  });
});

describe("onboarding logo — sharp re-encode runs in this Node context (dlopen sanity)", () => {
  it("processLogo(real PNG) → clean PNG main+thumb within the edge caps", async () => {
    const out = await processLogo(await pngOpaque(900, 400));
    expect(out.main.mime).toBe("image/png");
    expect(out.thumb.mime).toBe("image/png");
    // Genuine PNG signature on the re-encoded buffer.
    expect(out.main.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(out.main.bytes).toBe(out.main.buffer.length);
    expect(out.main.bytes).toBeGreaterThan(0);
    expect(Math.max(out.main.width, out.main.height)).toBeLessThanOrEqual(LOGO_MAX_EDGE_PX);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBeLessThanOrEqual(LOGO_THUMB_EDGE_PX);
  });

  it("preserves transparency (a transparent logo is not flattened)", async () => {
    const out = await processLogo(await pngTransparent(120, 120));
    const meta = await sharp(out.main.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });
});
