/**
 * CSV export with a formula-injection guard (doc 10 #25, audit F-25). A spreadsheet treats a cell
 * beginning with = + - @ (or a leading tab / CR) as a FORMULA — a tenant-authored value like
 * "=cmd|'/c calc'!A1" becomes code when the export is opened in Excel/Sheets. The config-string
 * sanitiser (#24) guards config LABELS at write time, but exported OPERATIONAL data (customer names,
 * item names, notes) never passes through it, so the export layer MUST defend independently.
 *
 * Every cell is: (1) prefixed with a single quote if it leads with a formula trigger, (2) wrapped in
 * double quotes with internal quotes doubled (RFC 4180). This is the ONLY way values reach a CSV.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  // Neutralise a formula-leading cell — the guard is the leading single quote (Excel/Sheets treat
  // a leading ' as "this is text"). Applied to the RAW value before quoting.
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  // RFC 4180 quoting: always quote (safe for commas/newlines/quotes), doubling internal quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Build a CSV document from a header row + data rows. Every field is guarded via csvEscape. */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  // CRLF line endings (RFC 4180) + a trailing newline.
  return lines.join("\r\n") + "\r\n";
}
