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

async function encode(input: Buffer, maxEdge: number): Promise<ProcessedVariant> {
  const out = await sharp(input, { failOn: "error" })
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
  const [main, medium, thumb] = await Promise.all([
    encode(input, MAX_EDGE_PX),
    encode(input, MEDIUM_EDGE_PX),
    encode(input, THUMB_EDGE_PX),
  ]);
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
  const out = await sharp(input, { failOn: "error" })
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
  const [main, thumb] = await Promise.all([
    encodeLogo(input, LOGO_MAX_EDGE_PX),
    encodeLogo(input, LOGO_THUMB_EDGE_PX),
  ]);
  return { main, thumb };
}
