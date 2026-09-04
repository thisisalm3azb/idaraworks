/**
 * H31 — the icon fallback must actually be a PNG.
 *
 * This exists because the thing it replaces failed in production. The icon route
 * returned 500 on the day H31 shipped, because sharp's Linux libraries were not
 * traced into the function — and a failing icon is not cosmetic: Chromium
 * requires a 192px and a 512px icon to consider an app installable, so a broken
 * icon endpoint can take the whole feature down.
 *
 * The fallback therefore has to be trustworthy without a native dependency, and
 * "I wrote a PNG encoder" is exactly the claim that deserves a test rather than
 * confidence. These decode the bytes structurally rather than checking a length.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { solidPng } from "@/platform/tenanthost/png";
import { ICON_SIZES } from "@/platform/tenanthost/icon";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the chunk list the way a decoder would. */
function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    out.push({ type, data });
    off += 12 + len;
  }
  return out;
}

describe("the dependency-free icon fallback", () => {
  it("starts with the PNG signature", () => {
    expect(solidPng(64, 1, 2, 3).subarray(0, 8).equals(SIGNATURE)).toBe(true);
  });

  it("carries exactly IHDR, IDAT and IEND, in that order", () => {
    const types = chunks(solidPng(64, 1, 2, 3)).map((c) => c.type);
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares the dimensions it was asked for, as 8-bit RGBA", () => {
    const ihdr = chunks(solidPng(192, 0, 0, 0)).find((c) => c.type === "IHDR")!.data;
    expect(ihdr.readUInt32BE(0)).toBe(192);
    expect(ihdr.readUInt32BE(4)).toBe(192);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // colour type RGBA
    expect(ihdr[12]).toBe(0); // not interlaced
  });

  it("its pixel data decompresses to the right size and the right colour", () => {
    const size = 32;
    const png = solidPng(size, 0x12, 0x34, 0x56);
    const idat = chunks(png).find((c) => c.type === "IDAT")!.data;
    const raw = inflateSync(idat);

    // One filter byte per row, then size RGBA pixels.
    expect(raw.length).toBe((1 + size * 4) * size);
    for (let y = 0; y < size; y++) {
      const row = y * (1 + size * 4);
      expect(raw[row], `row ${y} filter byte`).toBe(0);
      // Spot-check the first and last pixel of every row.
      for (const x of [0, size - 1]) {
        const p = row + 1 + x * 4;
        expect([raw[p], raw[p + 1], raw[p + 2], raw[p + 3]]).toEqual([0x12, 0x34, 0x56, 255]);
      }
    }
  });

  it("every chunk's CRC is correct, so a decoder will not reject it", () => {
    // Recompute the CRC independently of the encoder's own table.
    const crc = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i]!;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const png = solidPng(16, 200, 100, 50);
    let off = 8;
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const body = png.subarray(off + 4, off + 8 + len); // type + data
      const stated = png.readUInt32BE(off + 8 + len);
      expect(crc(body), `CRC for ${png.toString("ascii", off + 4, off + 8)}`).toBe(stated);
      off += 12 + len;
    }
  });

  it("produces every size the manifest declares", () => {
    for (const size of ICON_SIZES) {
      const png = solidPng(size, 31, 111, 92);
      const ihdr = chunks(png).find((c) => c.type === "IHDR")!.data;
      expect(ihdr.readUInt32BE(0), `size ${size}`).toBe(size);
    }
  });

  it("is deterministic — the same input gives byte-identical output", () => {
    // A cache key can then be content-addressed, and a regeneration never
    // invalidates an install for no reason.
    expect(solidPng(192, 10, 20, 30).equals(solidPng(192, 10, 20, 30))).toBe(true);
  });

  it("needs nothing but node:zlib", async () => {
    // The whole point: this path must survive a missing native binding.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/platform/tenanthost/png.ts", "utf8"),
    );
    expect(src).not.toMatch(/from ["']sharp["']|import\(["']sharp["']\)/);
    expect(src).toMatch(/from "node:zlib"/);
  });
});
