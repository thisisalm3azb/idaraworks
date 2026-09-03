/**
 * Merge copy keys into EVERY shipped catalog, keeping keys sorted (the parity
 * test requires identical key sets; the catalogs are sorted by convention).
 *
 *   node tooling/scripts/i18n-add.mjs <batch.json>
 *
 * batch.json: { "some.key": { "en": "…", "ar": "…", "es": "…" }, … }
 * Existing keys are overwritten only when --overwrite is passed.
 *
 * H29: `es` is required here, not optional. A key added in two languages and
 * left English in the third is exactly the leakage the mandate forbids, and the
 * only reliable moment to catch it is the moment the key is written.
 */
import fs from "node:fs";

/** Kept in step with SUPPORTED_LOCALES in src/platform/registries.ts. */
const LOCALES = ["en", "ar", "es"];

/**
 * ICU arguments must be identical in every language. An ARGUMENT is a lowercase
 * name immediately followed by a comma or a closing brace — the lowercase rule
 * is what separates `{count}` from a one-word plural branch like
 * `{n, plural, =0 {Nowhere}}`, whose branch text is prose.
 */
const placeholders = (s) =>
  [...s.matchAll(/\{\s*([a-z_][a-zA-Z0-9_]*)\s*[,}]/g)].map((m) => m[1]).sort();

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("usage: i18n-add.mjs <batch.json> [--overwrite]");
  process.exit(1);
}
const batch = JSON.parse(fs.readFileSync(file, "utf8"));
const overwrite = flag === "--overwrite";
let added = 0;
let skipped = 0;
for (const [key, value] of Object.entries(batch)) {
  for (const locale of LOCALES) {
    const text = value[locale];
    if (typeof text !== "string" || text.length === 0) throw new Error(`${key}: missing ${locale}`);
    if (/—/.test(text)) throw new Error(`${key}: em dash in ${locale}`);
    const mine = placeholders(text).join(",");
    const theirs = placeholders(value.en).join(",");
    if (mine !== theirs)
      throw new Error(
        `${key}: ${locale} placeholders differ (${theirs || "none"} -> ${mine || "none"})`,
      );
  }
}
for (const locale of LOCALES) {
  const path = `src/platform/i18n/messages/${locale}.json`;
  const catalog = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(batch)) {
    if (key in catalog && !overwrite) {
      if (locale === "en") skipped += 1;
      continue;
    }
    catalog[key] = value[locale];
    if (locale === "en") added += 1;
  }
  const sorted = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((k) => [k, catalog[k]]),
  );
  fs.writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
}
console.log(`added ${added}, skipped ${skipped} existing`);
