/**
 * Watermarked customer-safe derivatives (doc 04 F-22; doc 10 item 14/38). A shared customer
 * update never exposes an ORIGINAL photo — only a re-encoded, EXIF/GPS-stripped, downsized
 * derivative with a diagonal watermark composited over it (so a forwarded screenshot still
 * carries provenance). Uses the SAME sharp binding the image pipeline uses (no new native
 * dependency, so the Vercel/Sharp trace config is untouched). Server-only.
 *
 * Deterministic + idempotent: the same input + text yields the same derivative, so a retry
 * of the send/derivative step is safe.
 */
import sharp from "sharp";

const MAX_EDGE = 1600; // customer previews never need full resolution
const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );

/**
 * Produce a watermarked JPEG derivative. sharp does NOT copy input metadata to the output
 * (EXIF/GPS dropped by construction), the image is re-encoded (defuses polyglot/again), and
 * downsized. The watermark text (org name / "preview") is drawn diagonally, semi-transparent.
 */
export async function watermarkImage(input: Buffer, text: string): Promise<Buffer> {
  const base = sharp(input, { failOn: "error" }).rotate(); // honour orientation, then strip
  const meta = await base.metadata();
  const srcW = meta.width ?? 1200;
  const srcH = meta.height ?? 900;
  // Post-resize dimensions (for placing the SVG overlay at the right size).
  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const fontSize = Math.max(16, Math.round(w / 14));
  const svg = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="50%" y="50%" font-family="sans-serif" font-size="${fontSize}" ` +
      `fill="rgba(255,255,255,0.45)" stroke="rgba(0,0,0,0.25)" stroke-width="1" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `transform="rotate(-30 ${w / 2} ${h / 2})">${escapeXml(text)}</text></svg>`,
  );
  return base
    .resize({ width: w, height: h, fit: "inside", withoutEnlargement: true })
    .composite([{ input: svg, gravity: "center" }])
    .jpeg({ quality: 80 })
    .toBuffer();
}
