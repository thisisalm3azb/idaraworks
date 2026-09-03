/**
 * H29 — the Spanish translation workflow.
 *
 *   node tooling/scripts/i18n-es-batch.mjs dump <namespace> [out.json]
 *       writes { key: "english" } for every key in the namespace that is still
 *       untranslated (its Spanish is byte-identical to its English).
 *
 *   node tooling/scripts/i18n-es-batch.mjs merge <in.json>
 *       merges { key: "spanish" } into es.json, keeping the catalogue sorted
 *       and refusing a key the English catalogue does not have.
 *
 *   node tooling/scripts/i18n-es-batch.mjs status
 *       how much of the catalogue is still English.
 */
import fs from "node:fs";
import { LEGITIMATELY_IDENTICAL } from "./i18n-identical.mjs";

const EN = "src/platform/i18n/messages/en.json";
const ES = "src/platform/i18n/messages/es.json";
/**
 * Keys a translator looked at and deliberately left as they are, because the
 * Spanish word IS the English one ("Total", "No"). Without this the difference
 * between "translated" and "identical" would be a guess.
 */
const SAME = "src/platform/i18n/messages/es.same.json";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, obj) =>
  fs.writeFileSync(
    p,
    `${JSON.stringify(
      Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, obj[k]]),
      ),
      null,
      2,
    )}\n`,
  );

const [command, arg] = process.argv.slice(2);
const en = read(EN);
const es = read(ES);
const same = new Set(fs.existsSync(SAME) ? read(SAME) : []);

if (command === "dump") {
  const out = {};
  for (const [key, value] of Object.entries(en)) {
    if (arg && !key.startsWith(`${arg}.`)) continue;
    if (es[key] !== value) continue; // already translated
    if (same.has(key)) continue; // deliberately identical
    if (LEGITIMATELY_IDENTICAL(value)) continue;
    out[key] = value;
  }
  // A slice keeps a batch small enough to translate carefully in one pass.
  const from = Number(process.argv[4] ?? 0);
  const count = Number(process.argv[5] ?? 0);
  const keys = Object.keys(out);
  const sliced =
    count > 0 ? Object.fromEntries(keys.slice(from, from + count).map((k) => [k, out[k]])) : out;
  const target = `.h29-es-batch.json`;
  fs.writeFileSync(
    target,
    `${JSON.stringify(sliced, null, 2)}
`,
  );
  console.log(`${Object.keys(sliced).length} of ${keys.length} untranslated key(s) -> ${target}`);
  process.exit(0);
  fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${Object.keys(out).length} untranslated key(s) -> ${target}`);
} else if (command === "merge") {
  const batch = read(arg);
  let merged = 0;
  for (const [key, value] of Object.entries(batch)) {
    if (!(key in en)) throw new Error(`${key}: not in the English catalogue`);
    if (typeof value !== "string" || value.length === 0) throw new Error(`${key}: empty Spanish`);
    if (/—/.test(value)) throw new Error(`${key}: em dash in the Spanish`);
    // ICU arguments must survive translation exactly. An ARGUMENT is a LOWERCASE
    // name immediately followed by a comma or a closing brace. The lowercase rule
    // is what separates `{count}` from a one-word plural branch like
    // `{n, plural, =0 {Nowhere}}`, whose branch text is prose, not an argument.
    const placeholders = (s) =>
      [...s.matchAll(/\{\s*([a-z_][a-zA-Z0-9_]*)\s*[,}]/g)].map((m) => m[1]).sort();
    const before = placeholders(en[key]).join(",");
    const after = placeholders(value).join(",");
    if (before !== after)
      throw new Error(`${key}: placeholders changed (${before || "none"} -> ${after || "none"})`);
    if (value === en[key]) same.add(key);
    es[key] = value;
    merged++;
  }
  write(ES, es);
  fs.writeFileSync(
    SAME,
    `${JSON.stringify([...same].sort(), null, 2)}
`,
  );
  console.log(`merged ${merged} key(s)`);
} else if (command === "status") {
  let translated = 0;
  let identical = 0;
  let legitimate = 0;
  for (const [key, value] of Object.entries(en)) {
    if (es[key] !== value) translated++;
    else if (same.has(key) || LEGITIMATELY_IDENTICAL(value)) legitimate++;
    else identical++;
  }
  const total = Object.keys(en).length;
  console.log(
    `translated ${translated}/${total}, legitimately identical ${legitimate}, still English ${identical}`,
  );
} else {
  console.error("usage: i18n-es-batch.mjs dump <namespace> | merge <file> | status");
  process.exit(1);
}
