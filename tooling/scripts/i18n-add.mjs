/**
 * Merge copy keys into both catalogs, keeping keys sorted (the parity test
 * requires identical key sets; the catalogs are sorted by convention).
 *
 *   node tooling/scripts/i18n-add.mjs <batch.json>
 *
 * batch.json: { "some.key": { "en": "…", "ar": "…" }, … }
 * Existing keys are overwritten only when --overwrite is passed.
 */
import fs from "node:fs";

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("usage: i18n-add.mjs <batch.json> [--overwrite]");
  process.exit(1);
}
const batch = JSON.parse(fs.readFileSync(file, "utf8"));
const overwrite = flag === "--overwrite";
let added = 0;
let skipped = 0;
for (const locale of ["en", "ar"]) {
  const path = `src/platform/i18n/messages/${locale}.json`;
  const catalog = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(batch)) {
    const text = value[locale];
    if (typeof text !== "string" || text.length === 0) throw new Error(`${key}: missing ${locale}`);
    if (/—/.test(text)) throw new Error(`${key}: em dash in ${locale}`);
    if (key in catalog && !overwrite) {
      if (locale === "en") skipped += 1;
      continue;
    }
    catalog[key] = text;
    if (locale === "en") added += 1;
  }
  const sorted = Object.fromEntries(Object.keys(catalog).sort().map((k) => [k, catalog[k]]));
  fs.writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
}
console.log(`added ${added}, skipped ${skipped} existing`);
