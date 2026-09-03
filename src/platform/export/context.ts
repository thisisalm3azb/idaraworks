/**
 * H29 — what a downloaded file was produced UNDER.
 *
 * A CSV of amounts is meaningless without its currency, a CSV of timestamps is
 * meaningless without its timezone, and a CSV produced under one version of a
 * country's rules is not the same document as the one produced under the next.
 * A file that carries none of that becomes unreadable the moment it leaves the
 * screen it was downloaded from.
 *
 * The CSV BODY is deliberately left alone. A preamble line, a comment row or an
 * extra column would break every naive parser the file is about to meet, and a
 * data-portability export whose whole point is that other software can read it
 * must stay exactly what it claims to be. The context travels as the filename,
 * as response headers, and as a manifest anyone can download alongside.
 *
 * Pure on purpose: the platform layer may not reach into a module, so the
 * caller resolves the establishment's effective configuration and hands the
 * facts in.
 */
import type { Locale } from "@/platform/registries";

export type ExportContext = {
  producedAt: string;
  locale: Locale;
  currency: string;
  timezone: string;
  country: string;
  /** Null when the organisation has adopted no country-pack version. */
  packKey: string | null;
  /** True when the organisation's own settings were used, not an establishment's. */
  derivedFromOrganisation: boolean;
  pricePrivileged: boolean;
  costPrivileged: boolean;
};

export function buildExportContext(
  input: Omit<ExportContext, "producedAt"> & { producedAt?: string },
): ExportContext {
  return { producedAt: input.producedAt ?? new Date().toISOString(), ...input };
}

/**
 * A filename that survives being saved, mailed and found again a year later.
 * Every segment is filesystem-safe: a timezone's slash becomes a dash, so a
 * naive download folder never has to cope with anything but letters and dashes.
 */
export function exportFilename(entity: string, context: ExportContext): string {
  const day = context.producedAt.slice(0, 10);
  const zone = context.timezone.replace(/[^A-Za-z0-9]+/g, "-");
  return `${entity}_${day}_${context.locale}_${context.currency}_${zone}.csv`;
}

/**
 * The same facts as response headers, so a script that fetches an export can
 * record what it fetched without parsing a filename.
 */
export function exportHeaders(context: ExportContext): Record<string, string> {
  return {
    "X-Idaraworks-Export-Produced-At": context.producedAt,
    "X-Idaraworks-Export-Locale": context.locale,
    "X-Idaraworks-Export-Currency": context.currency,
    "X-Idaraworks-Export-Timezone": context.timezone,
    "X-Idaraworks-Export-Country": context.country,
    "X-Idaraworks-Export-Pack": context.packKey ?? "none",
    "X-Idaraworks-Export-Money-Redacted": String(
      !context.pricePrivileged || !context.costPrivileged,
    ),
  };
}

/** The manifest rows, in the order a person reads them. */
export function manifestRows(context: ExportContext): Array<Array<unknown>> {
  return [
    ["produced_at", context.producedAt],
    ["locale", context.locale],
    ["currency", context.currency],
    ["timezone", context.timezone],
    ["country", context.country],
    ["country_pack_version", context.packKey ?? "none adopted"],
    ["configuration_source", context.derivedFromOrganisation ? "organisation" : "establishment"],
    // Stated plainly: a file with blank money columns is not a file with no
    // money, and someone reading it later must be able to tell the difference.
    ["selling_prices_included", String(context.pricePrivileged)],
    ["costs_included", String(context.costPrivileged)],
  ];
}
