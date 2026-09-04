/**
 * H31 — text helpers shared by the company-app module's public and tenant reads.
 *
 * Lives in platform rather than in the module because both halves of the module
 * need it and one of them must not import the other: `public.ts` runs before a
 * session exists, `service.ts` runs inside one, and a cycle between them would
 * be a real problem rather than a lint complaint.
 */

/**
 * Truncate to at most `max` graphemes, never splitting one.
 *
 * A home screen has room for about twelve characters, and cutting at a code
 * unit puts a replacement character on somebody's phone — Arabic letters with
 * marks and emoji both occupy more than one. `Intl.Segmenter` is available in
 * every runtime this ships to; the fallback exists only so a missing ICU build
 * degrades to something readable rather than throwing.
 */
export function truncateGraphemes(value: string, max: number): string {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const out: string[] = [];
    for (const g of seg.segment(value)) {
      if (out.length >= max) break;
      out.push(g.segment as string);
    }
    return out.join("");
  } catch {
    return [...value].slice(0, max).join("");
  }
}
