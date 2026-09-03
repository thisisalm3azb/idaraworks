/**
 * Remove copy keys from EVERY shipped catalog at once.
 *
 *   node tooling/scripts/i18n-remove.mjs <key> [<key> …]
 *
 * The catalogues must stay key-identical (the parity test enforces it), so a
 * key can only ever be removed from all of them together. Refuses a key that is
 * still referenced anywhere under src/, because a removed key renders as the
 * loud ⟦key⟧ marker rather than failing the build.
 */
import fs from "node:fs";
import path from "node:path";

const LOCALES = ["en", "ar", "es"];
const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error("usage: i18n-remove.mjs <key> [<key> …]");
  process.exit(1);
}

/** Every source line under src/, so a reference cannot slip through. */
function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}
const sources = [...sourceFiles("src")].map((f) => fs.readFileSync(f, "utf8")).join("\n");
for (const key of keys) {
  if (sources.includes(key)) throw new Error(`${key}: still referenced under src/`);
}

for (const locale of LOCALES) {
  const file = `src/platform/i18n/messages/${locale}.json`;
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of keys) delete catalog[key];
  const sorted = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((k) => [k, catalog[k]]),
  );
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

// The identical-key allowlist must not keep naming a key that no longer exists.
const samePath = "src/platform/i18n/messages/es.same.json";
const same = JSON.parse(fs.readFileSync(samePath, "utf8")).filter((k) => !keys.includes(k));
fs.writeFileSync(samePath, `${JSON.stringify(same.sort(), null, 2)}\n`);

console.log(`removed ${keys.length} key(s) from ${LOCALES.join(", ")}`);
