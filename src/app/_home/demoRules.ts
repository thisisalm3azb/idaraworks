/**
 * The interactive demonstration's rules, kept pure so they are testable without
 * a browser: how a typed company name is cleaned and abbreviated, which sample
 * journey an industry shows, and how the five steps advance.
 *
 * Nothing here touches the network or storage. The demo is page state only: a
 * typed company name never leaves the visitor's tab. Every sentence the demo
 * shows is resolved on the server from the catalogue (with the industry's
 * sample values already substituted), so the client only ever indexes.
 */

export const INDUSTRIES = ["trading", "construction", "services", "manufacturing"] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const STEPS = ["quote", "work", "resources", "invoice", "paid"] as const;
export type StepKey = (typeof STEPS)[number];
export const STEP_COUNT = STEPS.length;

/** Preview brand colours: each carries white text at AA on the icon tile. */
export const SWATCHES = [
  { key: "forest", hex: "#315b4e" },
  { key: "indigo", hex: "#55509c" },
  { key: "copper", hex: "#a46032" },
  { key: "ocean", hex: "#246883" },
] as const;
export type SwatchKey = (typeof SWATCHES)[number]["key"];

export const MAX_NAME_LENGTH = 38;

/**
 * A company name as the previews show it: control and zero-width characters
 * removed, runs of whitespace collapsed, bounded in length with a grapheme-safe
 * cut so a name ending in an emoji or a combined Arabic letter is never split.
 */
/** Zero-width and line-separator characters a pasted name can carry (the joiner
 * U+200D is kept: emoji sequences need it). */
const INVISIBLE = [0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff]
  .map((c) => String.fromCodePoint(c))
  .join("");
const STRIP = new RegExp(`[\\x00-\\x1f\\x7f${INVISIBLE}]`, "g");

/** User-perceived characters: an emoji sequence or a letter with its marks is one. */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

export function cleanName(raw: string): string {
  // Whitespace first (a tab or newline becomes a space), then the invisible
  // and control characters, then the grapheme-bounded cut.
  const stripped = raw.replace(/\s+/g, " ").replace(STRIP, "").trim();
  return graphemes(stripped).slice(0, MAX_NAME_LENGTH).join("");
}

/**
 * Two initials for the icon tile: the first grapheme of the first two words,
 * upper-cased. Grapheme-aware so an Arabic or emoji-led name still yields a
 * mark rather than a broken half character.
 */
export function initialsFor(name: string): string {
  // Words made only of punctuation ("&", "-") carry no initial.
  const words = name
    .split(" ")
    .filter((w) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(w))
    .slice(0, 2);
  return words
    .map((w) => graphemes(w)[0] ?? "")
    .join("")
    .toUpperCase();
}

/** What the visitor typed, or the placeholder company when the field is empty. */
export function displayName(raw: string, fallback: string): string {
  const cleaned = cleanName(raw);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function nextStep(step: number): number {
  return (clampStep(step) + 1) % STEP_COUNT;
}

export function clampStep(step: number): number {
  if (!Number.isInteger(step)) return 0;
  return Math.min(Math.max(step, 0), STEP_COUNT - 1);
}

/** One step's copy for one industry, fully resolved. */
export type StepView = {
  label: string;
  heading: string;
  text: string;
  button: string;
  state: string;
  reference: string;
  detailLabel: string;
  detailValue: string;
  totalLabel: string;
  totalValue: string;
  trace: string;
  phoneTitle: string;
  phoneCopy: string;
};

/** One industry's sample document line, shown on every step. */
export type Scenario = { item: string; qty: string };

/** Everything the demo shows, resolved once on the server. */
export type DemoCopy = {
  scenarios: Record<Industry, Scenario>;
  /** views[industry][stepIndex] */
  views: Record<Industry, StepView[]>;
};

export function stepView(copy: DemoCopy, industry: Industry, step: number): StepView {
  return copy.views[industry][clampStep(step)]!;
}

/** True when the demo has reached the last step (the button then offers a restart). */
export function isLastStep(step: number): boolean {
  return clampStep(step) === STEP_COUNT - 1;
}
