/**
 * Builds a GPS-tagged JPEG entirely in-memory (no binary fixture committed):
 * sharp renders a base image, piexifjs injects a full GPS IFD (the exact PII
 * the pipeline must strip — doc 10 #38), exifr verifies the tag went in.
 * Used by the unit pipeline test, the hosted integration test and VC-4.
 */
import sharp from "sharp";
import piexif from "piexifjs";
import exifr from "exifr";

export async function buildGpsJpeg(width = 1600, height = 1200): Promise<Buffer> {
  const base = await sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 120, b: 40 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  // 25°12'34.56" N, 55°16'12.34" E — a workshop in Dubai
  const gpsIfd: Record<number, unknown> = {};
  gpsIfd[piexif.GPSIFD.GPSLatitudeRef] = "N";
  gpsIfd[piexif.GPSIFD.GPSLatitude] = [
    [25, 1],
    [12, 1],
    [3456, 100],
  ];
  gpsIfd[piexif.GPSIFD.GPSLongitudeRef] = "E";
  gpsIfd[piexif.GPSIFD.GPSLongitude] = [
    [55, 1],
    [16, 1],
    [1234, 100],
  ];
  const exifBytes = piexif.dump({ GPS: gpsIfd });
  const binary = piexif.insert(exifBytes, base.toString("binary"));
  const tagged = Buffer.from(binary, "binary");

  // Self-check: the fixture MUST carry GPS, or the strip assertion proves nothing.
  const gps = await exifr.gps(tagged);
  if (!gps || typeof gps.latitude !== "number") {
    throw new Error("fixture self-check failed: GPS tag missing from the built JPEG");
  }
  return tagged;
}

/** True when the buffer still carries any GPS coordinates. */
export async function hasGps(buffer: Buffer): Promise<boolean> {
  const gps = await exifr.gps(buffer).catch(() => null);
  return !!gps && typeof gps.latitude === "number";
}

/** True when the buffer carries ANY EXIF block at all. */
export async function hasExif(buffer: Buffer): Promise<boolean> {
  const data = await exifr.parse(buffer, { mergeOutput: false }).catch(() => null);
  return data !== null && data !== undefined && Object.keys(data).length > 0;
}
