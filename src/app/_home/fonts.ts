import { Noto_Sans_Arabic, Space_Grotesk } from "next/font/google";

/**
 * The homepage's type: one family for everything in English (headings, body,
 * controls, numbers, the sample interfaces), with Noto Sans Arabic behind it on
 * the same stack for Arabic glyphs. next/font downloads both at build time and
 * serves them from this origin, which is what the font-src 'self' policy
 * requires; nothing is fetched from a font host at runtime.
 */
export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  // Regular for copy, medium for headings, semibold for controls: three files.
  weight: ["400", "500", "600"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const notoSansArabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600"],
  variable: "--font-noto-arabic",
  display: "swap",
  // Fetched on demand through its unicode-range (the English page shows only
  // a few Arabic glyphs), so it never competes with the Latin face for the
  // first paint on a slow connection.
  preload: false,
});
