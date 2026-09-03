/**
 * H29 — reading the dates in an imported file.
 *
 * `01/02/2026` is 2 January in most of the world and 1 February in the United
 * States, and the file cannot tell you which. Looking at the rest of the column
 * does not settle it either: a file whose days never exceed 12 is ambiguous end
 * to end. A wrong reading moves a close date or a due date by up to eleven
 * months and nothing anywhere looks broken.
 *
 * So the format is DECLARED by the person doing the import and never inferred.
 * Kept pure and separate from the service so the rule can be tested directly
 * rather than through a database.
 */

export const SOURCE_DATE_FORMATS = ["iso", "dmy", "mdy"] as const;
export type SourceDateFormat = (typeof SOURCE_DATE_FORMATS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Four-digit year only: "01/02/26" could be 1926, 2026 or 2126. */
const SLASHED_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

export type DateReading = { date: string } | { problem: string };

/**
 * Convert one cell to an ISO date, or say why it cannot be.
 *
 * A value already in ISO passes through whatever the declared format is: it is
 * unambiguous, and rewriting it would only add a way to get it wrong.
 */
export function readSourceDate(value: string, format: SourceDateFormat | undefined): DateReading {
  const trimmed = value.trim();
  if (ISO_DATE.test(trimmed)) return { date: trimmed };
  const m = SLASHED_DATE.exec(trimmed);
  if (!m) return { problem: `"${value}" is not a date this import understands` };
  if (!format || format === "iso")
    return {
      problem:
        `"${value}" can be read two ways and the source date format was not stated. ` +
        `Say whether the file writes the day or the month first, or use YYYY-MM-DD.`,
    };
  const first = Number(m[1]);
  const second = Number(m[2]);
  const year = m[3]!;
  const day = format === "dmy" ? first : second;
  const month = format === "dmy" ? second : first;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // A real calendar check: 31 April read either way round is still not a date.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso)
    return { problem: `"${value}" is not a real calendar date read as ${format}` };
  return { date: iso };
}
