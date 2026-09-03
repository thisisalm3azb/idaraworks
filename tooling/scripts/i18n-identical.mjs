/**
 * H29 — the one rule for "a Spanish string may legitimately equal its English
 * one". Shared by the translation batch tool and the identical-key recorder so
 * the two can never drift apart.
 *
 * Everything here is a string that carries no language: whitespace, pure
 * punctuation or digits, a bare ICU placeholder, or a proper noun / standard
 * acronym that is written the same way in both languages.
 */
export const SHARED_TOKENS =
  /^(IdaraWorks|Idara|WhatsApp|Google|Microsoft|OAuth|API|CSV|PDF|QR|IBAN|SWIFT|ZATCA|GOSI|TRN|VAT|SAR|AED|USD|EUR|SANED|Peppol|PINT AE|UBL|XML|JSON|SMS|URL|ID|OK|Excel|Tally|Nginx|Vercel|Supabase)$/;

export const LEGITIMATELY_IDENTICAL = (value) =>
  value.trim().length === 0 ||
  /^[\s\p{P}\p{S}\d]+$/u.test(value) ||
  /^\{[a-zA-Z_]+\}$/.test(value) ||
  SHARED_TOKENS.test(value.trim());
