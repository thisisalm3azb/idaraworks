/**
 * H29 — pack-driven identity, address and banking checks (ADR-77, ADR-78).
 *
 * Two rules run through everything here:
 *
 *   Permissive by default. A pack validates only what its own source justifies.
 *   Where it publishes no shape, whatever was entered is accepted. A valid
 *   real-world address is never rejected for failing to match a template.
 *
 *   Scripts are preserved. Nothing transliterates, uppercases or reorders a
 *   name or an address line. Arabic entered as Arabic stays Arabic.
 */
import type { AddressSchema, CountryPack, IdentifierSpec } from "./types";

export type FieldProblem = {
  field: string;
  /** Message key — the reason is rendered in the reader's language. */
  messageKey: string;
  /** What the pack expected, for the message's variables. */
  expected?: string;
};

// ── IBAN (ISO 13616) ────────────────────────────────────────────────────────

/**
 * The mod-97 check from ISO 13616. Length comes from the pack, never from a
 * global table, so a country whose length is unpublished is checked on
 * structure alone.
 */
export function ibanProblems(raw: string, pack: CountryPack): FieldProblem[] {
  const iban = raw.replace(/[\s-]/g, "").toUpperCase();
  if (iban.length === 0) return [];
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban))
    return [{ field: "iban", messageKey: "country.validation.iban_shape" }];

  const expectedPrefix = pack.banking.ibanPrefix;
  if (expectedPrefix && !iban.startsWith(expectedPrefix))
    return [
      {
        field: "iban",
        messageKey: "country.validation.iban_country",
        expected: expectedPrefix,
      },
    ];

  const expectedLength = pack.banking.ibanLength;
  if (expectedLength !== null && iban.length !== expectedLength)
    return [
      {
        field: "iban",
        messageKey: "country.validation.iban_length",
        expected: String(expectedLength),
      },
    ];

  // Move the first four characters to the end, map letters to 10..35, mod 97.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? [] : [{ field: "iban", messageKey: "country.validation.iban_checksum" }];
}

/** Grouped in fours for display only; the stored value keeps what was entered. */
export function formatIban(raw: string): string {
  const iban = raw.replace(/[\s-]/g, "").toUpperCase();
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

// ── identifiers ─────────────────────────────────────────────────────────────

export function identifierProblems(
  spec: IdentifierSpec,
  raw: string | null | undefined,
): FieldProblem[] {
  const value = (raw ?? "").trim();
  if (value.length === 0)
    return spec.required
      ? [{ field: spec.key, messageKey: "country.validation.identifier_required" }]
      : [];
  if (spec.length !== undefined && value.replace(/\s/g, "").length !== spec.length)
    return [
      {
        field: spec.key,
        messageKey: "country.validation.identifier_length",
        expected: String(spec.length),
      },
    ];
  if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value.replace(/\s/g, "")))
    return [{ field: spec.key, messageKey: "country.validation.identifier_shape" }];
  return [];
}

// ── addresses ───────────────────────────────────────────────────────────────

export type AddressValue = Record<string, string | null | undefined>;

export function addressProblems(schema: AddressSchema, value: AddressValue): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const field of schema.fields) {
    const entered = (value[field.key] ?? "").toString().trim();
    if (entered.length === 0) {
      if (field.required)
        problems.push({ field: field.key, messageKey: "country.validation.field_required" });
      continue;
    }
    if (entered.length > field.maxLength)
      problems.push({
        field: field.key,
        messageKey: "country.validation.field_too_long",
        expected: String(field.maxLength),
      });
    // A published shape is checked; anything else is accepted as entered.
    if (field.pattern !== undefined && !new RegExp(field.pattern).test(entered))
      problems.push({
        field: field.key,
        messageKey: "country.validation.field_shape",
        expected: field.example,
      });
  }
  return problems;
}

/**
 * The address as the country writes it, one string per line, skipping empty
 * fields. The script of every value is preserved exactly.
 */
export function formatAddress(schema: AddressSchema, value: AddressValue): string[] {
  return schema.documentLayout
    .map((line) =>
      line
        .map((key) => (value[key] ?? "").toString().trim())
        .filter((v) => v.length > 0)
        .join(" "),
    )
    .filter((line) => line.length > 0);
}

// ── phone numbers ───────────────────────────────────────────────────────────

/**
 * Phone numbers are stored as entered. The only check is that what is stored
 * could be dialled: digits, with an optional leading `+` and separators. No
 * country's numbering plan is asserted, because none was researched.
 */
export function phoneProblems(raw: string | null | undefined): FieldProblem[] {
  const value = (raw ?? "").trim();
  if (value.length === 0) return [];
  const digits = value.replace(/[\s()\-.]/g, "");
  if (!/^\+?[0-9]{6,18}$/.test(digits))
    return [{ field: "phone", messageKey: "country.validation.phone_shape" }];
  return [];
}
