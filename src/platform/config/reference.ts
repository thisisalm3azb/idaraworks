/**
 * Reference-pattern engine (doc 07 "Reference patterns"): renders the closed
 * token grammar — {preset_code} | {year} | {seq:n} — into a document reference
 * (hull numbers: "{preset_code}-{seq:3}" → 24C-003). Pure; sequence allocation
 * is the caller's transactional concern.
 */
export type ReferenceParts = {
  presetCode?: string;
  seq: number;
  year?: number;
};

export function renderReference(pattern: string, parts: ReferenceParts): string {
  return pattern.replace(/\{(preset_code|year|seq:(\d))\}/g, (_m, token: string, pad?: string) => {
    if (token === "preset_code") return parts.presetCode ?? "";
    if (token === "year") return String(parts.year ?? new Date().getFullYear());
    return String(parts.seq).padStart(Number(pad ?? "1"), "0");
  });
}
