/**
 * H31 — colour safety for customer-supplied branding.
 *
 * A customer picks a brand colour because it matches their logo, not because it
 * reads well behind white text. Left alone, a pale yellow theme colour produces
 * an install banner and a splash screen nobody can read, and the customer blames
 * the product rather than the colour.
 *
 * So every customer colour passes through here, and where it fails it is not
 * rejected — their brand is still shown — but the text drawn ON it is chosen to
 * be legible. That is the difference between honouring a brand and obeying it.
 *
 * Ratios follow WCAG 2.2 relative luminance. Pure functions: no DOM, no canvas.
 */

export type Rgb = { r: number; g: number; b: number };

/** Parse `#rrggbb`. Returns null for anything else — never a guessed colour. */
export function parseHex(hex: string | null | undefined): Rgb | null {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
/** Not pure black: near-black on a mid tone reads better and looks less harsh. */
const NEAR_BLACK: Rgb = { r: 17, g: 17, b: 17 };

/** WCAG AA for normal text. */
export const AA_NORMAL = 4.5;
/** WCAG AA for large text and for UI component boundaries. */
export const AA_LARGE = 3;

/**
 * The legible foreground for a background, and how good it actually is.
 *
 * Returns the better of white and near-black rather than insisting on one, and
 * reports the ratio so a settings screen can warn honestly instead of silently
 * "fixing" a customer's colour.
 */
export function readableForeground(bg: Rgb): { color: string; ratio: number; passesAA: boolean } {
  const onWhite = contrastRatio(bg, WHITE);
  const onBlack = contrastRatio(bg, NEAR_BLACK);
  const useWhite = onWhite >= onBlack;
  const ratio = useWhite ? onWhite : onBlack;
  return {
    color: useWhite ? toHex(WHITE) : toHex(NEAR_BLACK),
    ratio: Math.round(ratio * 100) / 100,
    passesAA: ratio >= AA_NORMAL,
  };
}

/** The platform's own colours, used whenever a customer's cannot be trusted. */
export const FALLBACK_BRAND_COLOR = "#1f6f5c";
export const FALLBACK_BACKGROUND_COLOR = "#ffffff";

export type ColorDecision = {
  /** The colour that will actually be used. */
  value: string;
  /** True when the customer's own colour survived. */
  customerColorUsed: boolean;
  /** A message key naming the problem, or null. Never raw prose. */
  warningKey: string | null;
  /** Contrast of the chosen foreground against this colour. */
  ratio: number;
  foreground: string;
};

/**
 * Decide the brand colour actually used for a theme or splash.
 *
 * A malformed colour falls back silently — there is nothing to warn about, the
 * value was never valid. A VALID colour with poor contrast is kept, because it
 * is the customer's brand and refusing it would be presumptuous; the warning
 * tells them, and the foreground compensates so nothing is unreadable.
 */
export function decideBrandColor(raw: string | null | undefined): ColorDecision {
  const parsed = parseHex(raw);
  if (!parsed) {
    const fg = readableForeground(parseHex(FALLBACK_BRAND_COLOR)!);
    return {
      value: FALLBACK_BRAND_COLOR,
      customerColorUsed: false,
      warningKey: raw ? "app.brand.color_invalid" : null,
      ratio: fg.ratio,
      foreground: fg.color,
    };
  }
  const fg = readableForeground(parsed);
  return {
    value: toHex(parsed),
    customerColorUsed: true,
    warningKey: fg.passesAA ? null : "app.brand.color_low_contrast",
    ratio: fg.ratio,
    foreground: fg.color,
  };
}

/**
 * The splash background.
 *
 * Stricter than the theme colour: this one fills the whole screen while the app
 * starts, and a near-white splash followed by a dark interface is a flash in the
 * eyes. An invalid value falls back to plain white, which is never wrong.
 */
export function decideBackgroundColor(raw: string | null | undefined): ColorDecision {
  const parsed = parseHex(raw);
  const chosen = parsed ?? parseHex(FALLBACK_BACKGROUND_COLOR)!;
  const fg = readableForeground(chosen);
  return {
    value: toHex(chosen),
    customerColorUsed: parsed !== null,
    warningKey: !parsed && raw ? "app.brand.color_invalid" : null,
    ratio: fg.ratio,
    foreground: fg.color,
  };
}
