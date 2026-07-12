/**
 * The image pipeline's EXIF/GPS-strip and derivative contract (doc 10 #38;
 * audit F-35; VC-4's CI half — the deployed-preview half reruns the same
 * assertions through the deployed worker).
 */
import { describe, expect, it } from "vitest";
import { processImage, MAX_EDGE_PX, MEDIUM_EDGE_PX, THUMB_EDGE_PX } from "@/platform/files/image";
import { buildGpsJpeg, hasExif, hasGps } from "../fixtures/gps-jpeg";

describe("image pipeline (sharp)", () => {
  it("strips GPS and ALL EXIF from every variant of a GPS-tagged photo", async () => {
    const tagged = await buildGpsJpeg(1600, 1200);
    expect(await hasGps(tagged)).toBe(true); // fixture is genuinely dirty

    const out = await processImage(tagged);
    for (const variant of [out.main, out.medium, out.thumb]) {
      expect(await hasGps(variant.buffer), "GPS survived re-encode").toBe(false);
      expect(await hasExif(variant.buffer), "EXIF block survived re-encode").toBe(false);
    }
  });

  it("respects the edge caps and never enlarges", async () => {
    const big = await buildGpsJpeg(4000, 3000);
    const out = await processImage(big);
    expect(Math.max(out.main.width, out.main.height)).toBeLessThanOrEqual(MAX_EDGE_PX);
    expect(Math.max(out.medium.width, out.medium.height)).toBeLessThanOrEqual(MEDIUM_EDGE_PX);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBeLessThanOrEqual(THUMB_EDGE_PX);

    const small = await buildGpsJpeg(300, 200);
    const outSmall = await processImage(small);
    expect(outSmall.main.width).toBe(300); // withoutEnlargement
    expect(outSmall.main.height).toBe(200);
  });

  it("reports accurate byte sizes and jpeg mime", async () => {
    const out = await processImage(await buildGpsJpeg(1000, 800));
    for (const v of [out.main, out.medium, out.thumb]) {
      expect(v.bytes).toBe(v.buffer.length);
      expect(v.mime).toBe("image/jpeg");
      expect(v.bytes).toBeGreaterThan(0);
    }
    expect(out.thumb.bytes).toBeLessThan(out.main.bytes);
  });

  it("throws on undecodable input (worker marks the file failed)", async () => {
    await expect(processImage(Buffer.from("not an image at all"))).rejects.toThrow();
  });
});
