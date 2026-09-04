/**
 * H31 — generating the icon set an installable app needs.
 *
 * Server-only: `sharp` is a native binding, and this must never reach a client
 * bundle. Imported lazily by its callers for the same reason the branding
 * module does it — the org layout imports the service barrel on every request
 * and must not pay for a native module it is not using.
 *
 * ── Two jobs ────────────────────────────────────────────────────────────────
 * 1. Turn whatever square-ish image a customer uploaded into the exact sizes
 *    browsers require, with maskable padding.
 * 2. When there is no usable image, draw a professional mark from the company's
 *    initials rather than shipping a broken-image icon or the IdaraWorks logo
 *    on somebody else's home screen.
 *
 * PNG throughout, not SVG. An SVG icon is a document with a script engine
 * attached; the mandate forbids unsanitised SVG in manifests and icons, and the
 * simplest way to honour that is never to produce one.
 */
import type { Rgb } from "./contrast";
import { parseHex, readableForeground, FALLBACK_BRAND_COLOR } from "./contrast";

/**
 * The sizes actually required, and why each one is here.
 *
 * 192 and 512 are the Chromium installability minimum (MDN, 2026-09-04). 180 is
 * the Apple touch icon iOS uses for the home screen. 32 is the favicon.
 */
export const ICON_SIZES = [32, 180, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/**
 * Maskable padding.
 *
 * Android crops an adaptive icon to whatever shape the launcher uses, and the
 * spec guarantees only the middle 80% by width. Anything drawn outside that
 * circle may be cut off, so the mark occupies the safe zone and the brand colour
 * fills the rest — which is also why a maskable icon looks "zoomed in" if you
 * generate it without padding.
 */
export const MASKABLE_SAFE_FRACTION = 0.8;

/** Initials for a company name, in whatever script it is written in. */
export function initialsFor(name: string): string {
  const cleaned = (name ?? "").trim();
  if (cleaned.length === 0) return "?";
  // Split on whitespace and common separators, ignoring bracketed suffixes and
  // legal forms that would otherwise produce "LL" for every company.
  const LEGAL =
    /^(llc|ltd|limited|inc|co|company|corp|corporation|plc|gmbh|sarl|est|fz|fze|lls)\.?$/i;
  const words = cleaned
    .split(/[\s\-_/،,]+/)
    .map((w) => w.replace(/[()[\]{}."']/g, ""))
    .filter((w) => w.length > 0 && !LEGAL.test(w));
  const source = words.length > 0 ? words : [cleaned];
  // Intl.Segmenter keeps a grapheme whole, so an Arabic letter with a mark or an
  // emoji does not become half a character.
  const firstGrapheme = (w: string): string => {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const first = seg.segment(w)[Symbol.iterator]().next();
      return first.done ? "" : (first.value.segment as string);
    } catch {
      return [...w][0] ?? "";
    }
  };
  const letters = source.slice(0, 2).map(firstGrapheme).join("");
  return (letters || "?").toUpperCase();
}

/** XML-escape text before it is placed in the SVG we rasterise ourselves. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The SVG we rasterise for a generated mark.
 *
 * This SVG is never served. It is built here from validated inputs — a hex
 * colour that matched a regex and initials that were XML-escaped — handed
 * straight to sharp, and discarded. Nothing a customer typed is served as
 * markup to a browser.
 */
function markSvg(size: number, bg: string, fg: string, initials: string): string {
  const radius = Math.round(size * 0.22);
  const fontSize = Math.round(size * (initials.length > 1 ? 0.38 : 0.5));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${bg}"/>`,
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="${fg}"`,
    ` font-family="Helvetica,Arial,sans-serif" font-weight="600" font-size="${fontSize}">`,
    escapeXml(initials),
    `</text></svg>`,
  ].join("");
}

export type GeneratedIcon = {
  size: IconSize;
  maskable: boolean;
  buffer: Buffer;
  mime: "image/png";
};

export type IconSourceKind = "uploaded" | "generated";

/**
 * Build the whole icon set.
 *
 * Deterministic: the same organisation name, colour and source bytes always
 * produce the same images, so a cache key can be a content hash and a
 * regeneration never invalidates an install for no reason.
 */
export async function generateIconSet(input: {
  /** A validated, already re-encoded raster image, or null. */
  source: Buffer | null;
  orgName: string;
  brandColor: string | null;
}): Promise<{ icons: GeneratedIcon[]; kind: IconSourceKind }> {
  const { default: sharp } = await import("sharp");

  const bgRgb: Rgb = parseHex(input.brandColor) ?? parseHex(FALLBACK_BRAND_COLOR)!;
  const bg =
    input.brandColor && parseHex(input.brandColor) ? input.brandColor : FALLBACK_BRAND_COLOR;
  const fg = readableForeground(bgRgb).color;

  let kind: IconSourceKind = "generated";
  const icons: GeneratedIcon[] = [];

  for (const size of ICON_SIZES) {
    // Every size is produced twice where it matters: `any` fills the square,
    // `maskable` insets the mark so a launcher's crop cannot clip it.
    for (const maskable of size >= 192 ? [false, true] : [false]) {
      const inner = maskable ? Math.round(size * MASKABLE_SAFE_FRACTION) : size;

      let markBuffer: Buffer;
      if (input.source) {
        try {
          markBuffer = await sharp(input.source, { failOn: "error" })
            .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
          kind = "uploaded";
        } catch {
          // A source that decodes for metadata but fails to resize must not take
          // the whole icon set down: fall back to the generated mark.
          markBuffer = Buffer.from(markSvg(inner, bg, fg, initialsFor(input.orgName)));
          markBuffer = await sharp(markBuffer).png().toBuffer();
        }
      } else {
        markBuffer = await sharp(Buffer.from(markSvg(inner, bg, fg, initialsFor(input.orgName))))
          .png()
          .toBuffer();
      }

      const pad = Math.round((size - inner) / 2);
      const composed = await sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          // A maskable icon must be opaque to the edge or the launcher shows the
          // page behind it through the corners.
          background: maskable ? { ...bgRgb, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([{ input: markBuffer, top: pad, left: pad }])
        .png({ compressionLevel: 9 })
        .toBuffer();

      icons.push({ size, maskable, buffer: composed, mime: "image/png" });
    }
  }

  return { icons, kind };
}
