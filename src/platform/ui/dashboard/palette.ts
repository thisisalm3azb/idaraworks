/**
 * Chart series colours — semantic tokens only (no raw hex; BUILD_BIBLE §9.2).
 * Order matters: the first slots are the calmest so small multiples stay
 * restrained ("NO rainbow" — U5). Status-toned components (donut/stack) may
 * instead pass explicit tone vars per segment.
 */
export const SERIES_COLORS = [
  "var(--brand)",
  "var(--info)",
  "var(--warning)",
  "var(--success)",
  "var(--danger)",
  "var(--text-muted)",
] as const;

export const TONE_COLORS = {
  brand: "var(--brand)",
  accent: "var(--accent)",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  neutral: "var(--text-muted)",
} as const;

export type ToneKey = keyof typeof TONE_COLORS;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}
