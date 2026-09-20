/**
 * Server-side image pipeline (doc 01 Appendix A; audit F-35; VC-4).
 * Re-encode + EXIF/GPS strip + derivatives, as one pure function so the worker,
 * tests, and the VC-4 preview check all run the identical code path.
 *
 * EXIF/GPS removal: sharp does NOT copy input metadata to output unless
 * .withMetadata()/.keepMetadata() is called — we never call it, and the test
 * suite asserts the absence on a GPS-tagged fixture rather than trusting this
 * comment (doc 10 #38).
 *
 * Output format is JPEG across the board: universally decodable (S6 PDF
 * embedding included), predictable size at q75-80.
 *
 * Server-only (sharp native binding) — never import from client components.
 */
import sharp from "sharp";

export const MAX_EDGE_PX = 2048; // Appendix A: max edge 2048px
export const MEDIUM_EDGE_PX = 1280; // medium derivative ~1280px
export const THUMB_EDGE_PX = 200; // thumbnail ~200px
export const JPEG_QUALITY = 78; // ~q75

export type ProcessedVariant = {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  mime: "image/jpeg";
};

export type ProcessedImage = {
  main: ProcessedVariant;
  medium: ProcessedVariant;
  thumb: ProcessedVariant;
};

/**
 * Decoding limits shared by every pipeline below.
 *
 * `limitInputPixels`: a PNG can declare 30,000 x 30,000 pixels in a few
 * kilobytes; sharp's default ceiling (about 268 megapixels) would let such a
 * file allocate gigabytes. Sixty megapixels covers any phone photograph.
 */
export const MAX_INPUT_PIXELS = 60_000_000;
const DECODE = { failOn: "error" as const, limitInputPixels: MAX_INPUT_PIXELS };

/** File-signature sniff for the three bitmap formats the product accepts. */
export function sniffImageMime(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * The bytes must BE one of the accepted bitmap formats, whatever the upload
 * declared. Storage validates the declared Content-Type header, not the body,
 * so this is the only place an SVG (or anything else libvips can open) is
 * kept away from the decoder.
 */
export class UnsupportedImageError extends Error {
  constructor() {
    super("unsupported image signature");
    this.name = "UnsupportedImageError";
  }
}
function assertBitmap(input: Buffer): void {
  if (sniffImageMime(input) === null) throw new UnsupportedImageError();
}

async function encode(input: Buffer, maxEdge: number): Promise<ProcessedVariant> {
  const out = await sharp(input, DECODE)
    .rotate() // apply EXIF orientation BEFORE the metadata is dropped
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    bytes: out.info.size,
    width: out.info.width,
    height: out.info.height,
    mime: "image/jpeg",
  };
}

/**
 * Re-encode an uploaded image into the three clean variants. Throws on
 * undecodable input (the worker marks the file failed).
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  assertBitmap(input);
  // One decode at a time: three concurrent decodes of a large photo tripled
  // the worker's peak memory for no gain.
  const main = await encode(input, MAX_EDGE_PX);
  const medium = await encode(input, MEDIUM_EDGE_PX);
  const thumb = await encode(input, THUMB_EDGE_PX);
  return { main, medium, thumb };
}

// ── Logo variant (U2 org branding) ───────────────────────────────────────────
// Same pipeline discipline (sharp re-encode, EXIF orientation applied then all
// metadata dropped — .withMetadata is never called), but PNG output: a logo
// with transparency must not be flattened onto a JPEG background. Small edges:
// logos are chrome, not photography.
export const LOGO_MAX_EDGE_PX = 512;
export const LOGO_THUMB_EDGE_PX = 128;

export type ProcessedLogoVariant = {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  mime: "image/png";
};

export type ProcessedLogo = {
  main: ProcessedLogoVariant;
  thumb: ProcessedLogoVariant;
};

async function encodeLogo(input: Buffer, maxEdge: number): Promise<ProcessedLogoVariant> {
  const out = await sharp(input, DECODE)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    bytes: out.info.size,
    width: out.info.width,
    height: out.info.height,
    mime: "image/png",
  };
}

/** Re-encode an uploaded logo into clean PNG main + thumb variants. Throws on
 * undecodable input (the branding service maps it to a helpful upload error). */
export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  assertBitmap(input);
  const main = await encodeLogo(input, LOGO_MAX_EDGE_PX);
  const thumb = await encodeLogo(input, LOGO_THUMB_EDGE_PX);
  return { main, thumb };
}
