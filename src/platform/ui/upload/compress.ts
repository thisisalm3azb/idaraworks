/**
 * Client-side compress-before-upload (doc 01 Appendix A: max edge 2048px, ~q75,
 * target ≤500KB). Runs in the browser only; the pure geometry lives in
 * fitWithin() so it is unit-testable in Node.
 */

export const CLIENT_MAX_EDGE_PX = 2048;
export const CLIENT_JPEG_QUALITY = 0.75;
export const CLIENT_TARGET_BYTES = 500 * 1024;

/** Scale (w,h) to fit inside maxEdge, never enlarging. Pure. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error("invalid dimensions");
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type CompressedImage = {
  blob: Blob;
  mime: "image/jpeg";
  width: number;
  height: number;
};

/**
 * Decode → downscale → JPEG-encode in the browser. Falls back to the original
 * file when it cannot be decoded (HEIC on some browsers) — the server pipeline
 * re-encodes everything anyway; this step only saves workshop bandwidth.
 */
export async function compressImage(file: File): Promise<CompressedImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // undecodable in this browser — upload as-is
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, CLIENT_MAX_EDGE_PX);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;
    ctx2d.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", CLIENT_JPEG_QUALITY),
    );
    if (!blob) return null;
    // If compression somehow grew a tiny file, keep the smaller original bytes —
    // but only when the original is already an accepted upload mime.
    if (blob.size >= file.size && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return null;
    }
    return { blob, mime: "image/jpeg", width, height };
  } finally {
    bitmap.close();
  }
}
